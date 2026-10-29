// @critical-path
// Retraction (critical invariants 1, 2, 3, 4, 5 and 8; the MVP plan,
// section 4, "Closure and retraction"; doc/product/report-lifecycle.md,
// posted to retracting to retracted; doc/guides/admin-review-runbook.md,
// section 8): a posted report whose post was wrong has its post in the
// channel replaced by a correction and its button removed, and is
// finalized. `/retract <id>` from an admin in the venue (refused under
// lockdown: the gates of src/telegram/registry.ts, and the statements bind
// the switch) or from a keyholder in their own chat (under lockdown too: a
// retraction removes harm), or the Retract button of the status card.
// 1. The prompt (startRetraction): the report must be posted, with its
//    post's message id, under its live approval (/attach, after an
//    ambiguous send, writes `posted` and the id in one statement, so a
//    report it recorded is posted too). A force-reply prompt asks the
//    retractor for the correction in the chat they acted in, the venue or
//    the keyholder's own chat, and is recorded in `admin_prompts` (kind
//    `retraction`, that chat and the retractor's own id, both deployment
//    configuration), replacing the retractor's earlier one for the report.
//    Only the retractor's own reply in that chat answers it.
// 2. The reply (answerRetraction): refused, by a fresh prompt saying why,
//    unless it is a text that passes the admin free-text policy
//    (src/review/text-policy.ts: no URL, bare domain, mention, t.me or
//    phone number) and the retracted post it makes (retractedPostText(): a
//    fixed heading and the fixed warning line in both locales, then the
//    correction as escaped text, and no link at all) fits Telegram's 4096
//    characters with no tappable link (postProblems()). Then ONE batch
//    (retractStatements): `correction_text` written first, then the
//    conditional status change to `retracting` (exactly one row changes for
//    the retraction that wins), both while the report is posted with its
//    message id under its live approval, an admin's also while the switch
//    is not set; the `edit` job enqueued, due at once
//    (src/broadcast/jobs.ts); the report's retraction prompts deleted, the
//    answered one in every case. The prompt and the reply are then deleted
//    from their chat (and the other retractors' prompts from theirs, the
//    venue's only outside lockdown), the retractor told in their chat, and,
//    unless locked down, the status card says the retraction is under way.
//    A reply whose report is no longer posted ends the prompt and says so.
// 3. The edit (retractEdit, an EDIT_HANDLERS entry, src/broadcast/edits.ts;
//    under lockdown and /halt too, RUN_WHEN_HELD): for a report retracting
//    under its live approval with its post's id, the stored correction,
//    checked again by the free-text policy and postProblems() (a text that
//    fails is never sent: the report is flagged for a human);
//    concludeEdit() (src/broadcast/concluding.ts) replaces the post's text,
//    removes the button, deletes the post too when it is younger than 48
//    hours, and on its success writes `retracted` and finalizes in one
//    batch; the keyholders' remembered notices say "retracted".
// Nothing goes to the reporter or to the members but the edit of the post.
import type { ForceReply } from 'grammy/types';
import { isLockedDown, NOT_LOCKED_DOWN } from '../auth/lockdown';
import type { Config } from '../config/schema';
import { isId } from '../db/ids';
import { concatSql, sql, type SqlStatement, type SqlText, type SqlValue } from '../db/sql';
import { AppError } from '../errors/app-error';
import { t, type Locale } from '../i18n/index';
import { loadPress } from '../review/flow';
import { retractedNoticeText } from '../review/notify';
import { createPrompt, deletePromptStatement, insertPromptStatement, promptsOf, type AdminPrompt } from '../review/prompts';
import { POST_DIVIDER, postProblems } from '../review/render-post';
import { checkAdminText, type AdminTextProblem } from '../review/text-policy';
import { checkedText, type Actor, type Pressed, type PressOutcome, type ReviewDeps } from '../review/venue';
import { safeText } from '../telegram/render';
import { concludeEdit, deleteFromChat, dropStale, flagEdit, readEditTarget, showState } from './concluding';
import type { EditHandler } from './edits';
import { enqueueEditStatement } from './jobs';
import { venueFacts, type VenueFacts } from './post';

/** The `admin_prompts.kind` of a retraction's prompt. */
export const RETRACTION_PROMPT = 'retraction';

/** Who retracts, and where they are prompted and answered. */
export interface Retractor {
  /** The update's own sender, whom the gates checked: an admin's or a keyholder's id. */
  readonly id: number;
  readonly role: 'admin' | 'keyholder';
  /** The venue's one language for an admin; the keyholder's own. */
  readonly locale: Locale;
  /** The chat the retractor acts in: the venue for an admin, their own private chat for a keyholder. */
  readonly chatId: number;
}

/** A reply to a retraction prompt: its message, and its text when it is a text. */
export interface CorrectionReply {
  readonly messageId: number;
  readonly text: string | undefined;
}

const READ = sql`SELECT r.status, r.post_message_id, r.platform, r.category, r.reporter_ref, r.card_message_id, r.status_message_id, a.approval_id FROM reports AS r LEFT JOIN approvals AS a ON a.report_id = r.id AND a.voided_at IS NULL WHERE r.id = ?`;
const WRITE_CORRECTION = sql`UPDATE reports SET correction_text = ? WHERE id = ? AND status = 'posted' AND post_message_id IS NOT NULL AND EXISTS (SELECT 1 FROM approvals WHERE report_id = reports.id AND voided_at IS NULL)`;
const RETRACT = sql`UPDATE reports SET status = 'retracting', outcome = 'retracted' WHERE id = ? AND status = 'posted' AND post_message_id IS NOT NULL AND correction_text IS NOT NULL AND EXISTS (SELECT 1 FROM approvals WHERE report_id = reports.id AND voided_at IS NULL)`;
const byAdmin = (text: SqlText): SqlText => concatSql(text, sql` AND `, NOT_LOCKED_DOWN);
const WRITE_CORRECTION_BY_ADMIN = byAdmin(WRITE_CORRECTION);
const RETRACT_BY_ADMIN = byAdmin(RETRACT);
const DROP_RETRACTION_PROMPTS = sql`DELETE FROM admin_prompts WHERE report_id = ? AND kind = 'retraction' AND EXISTS (SELECT 1 FROM reports WHERE id = ? AND status = 'retracting')`;

interface ReportRow {
  readonly status: SqlValue;
  readonly post_message_id: SqlValue;
  readonly platform: SqlValue;
  readonly category: SqlValue;
  readonly reporter_ref: SqlValue;
  readonly card_message_id: SqlValue;
  readonly status_message_id: SqlValue;
  readonly approval_id: SqlValue;
}

/** Whether the report may be retracted (see the header, step 1). */
const retractable = (row: ReportRow): boolean => row.status === 'posted' && typeof row.post_message_id === 'number' && isId(row.approval_id);

/** The retracted post (see the header, step 2): no link, the correction as escaped text. */
export function retractedPostText(correction: string): string {
  const half = (locale: Locale): string =>
    [t(locale, 'post.retracted.title'), t(locale, 'post.retracted.body'), `<i>${t(locale, 'post.warning')}</i>`].join('\n');
  const heading = `${t('fa', 'post.retracted.correction')}\n${t('en', 'post.retracted.correction')}`;
  return [half('fa'), POST_DIVIDER, half('en'), POST_DIVIDER, `${heading}\n${safeText(correction.trim())}`].join('\n\n');
}

/** Why a correction is refused. */
export type CorrectionRefusal =
  | { readonly kind: 'not_text' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'policy'; readonly problem: Exclude<AdminTextProblem, 'too_long'> }
  | { readonly kind: 'too_long'; readonly excess: number }
  | { readonly kind: 'link' };

export type CorrectionCheck = { readonly ok: true; readonly correction: string } | { readonly ok: false; readonly refusal: CorrectionRefusal };

/** Checks a correction as the header says (step 2), trimmed. */
export function checkCorrection(config: Pick<Config, 'allowedLinkHosts'>, text: string | undefined): CorrectionCheck {
  if (text === undefined) return { ok: false, refusal: { kind: 'not_text' } };
  const correction = text.trim();
  if (correction === '') return { ok: false, refusal: { kind: 'empty' } };
  // The policy bounds only the recommended comment's length; the post's own bound applies below.
  const [problem] = checkAdminText('correction_text', correction).filter((each) => each !== 'too_long');
  if (problem !== undefined) return { ok: false, refusal: { kind: 'policy', problem } };
  const problems = postProblems(retractedPostText(correction), config.allowedLinkHosts);
  if (problems.excess > 0) return { ok: false, refusal: { kind: 'too_long', excess: problems.excess } };
  if (problems.links.length > 0) return { ok: false, refusal: { kind: 'link' } };
  return { ok: true, correction };
}

/** What the retractor is told when a correction is refused. */
function refusalText(locale: Locale, refusal: CorrectionRefusal): string {
  switch (refusal.kind) {
    case 'not_text':
      return t(locale, 'review.refused.not_text');
    case 'empty':
      return t(locale, 'review.refused.empty');
    case 'too_long':
      return t(locale, 'retract.too_long', { excess: refusal.excess });
    case 'link':
      return t(locale, 'review.refused.url');
    case 'policy':
      switch (refusal.problem) {
        case 'url':
          return t(locale, 'review.refused.url');
        case 'domain':
          return t(locale, 'review.refused.domain');
        case 'mention':
          return t(locale, 'review.refused.mention');
        case 'phone':
          return t(locale, 'review.refused.phone');
      }
  }
}

/** What a retraction's batch writes. */
export interface RetractionInput {
  readonly reportId: string;
  readonly correction: string;
  readonly now: number;
  /** An admin's retraction binds the switch; a keyholder's runs under lockdown too. */
  readonly byAdmin: boolean;
  /** The prompt the reply answered. */
  readonly prompt: Pick<AdminPrompt, 'chatId' | 'promptMessageId'>;
  /** A fresh random id for the job (src/db/ids.ts); drawn when absent. */
  readonly jobId?: string;
}

/** The index, in retractStatements(), of the status change: one row changed means the retraction won. */
export const RETRACT_STATUS_STATEMENT = 1;

/** The retraction's one batch (see the header, step 2). */
export function retractStatements(input: RetractionInput): SqlStatement[] {
  const { reportId, now } = input;
  return [
    { sql: input.byAdmin ? WRITE_CORRECTION_BY_ADMIN : WRITE_CORRECTION, params: [input.correction, reportId] },
    { sql: input.byAdmin ? RETRACT_BY_ADMIN : RETRACT, params: [reportId] },
    enqueueEditStatement({ reportId, status: 'retracting', dueAt: now, now, ...(input.jobId === undefined ? {} : { jobId: input.jobId }) }),
    { sql: DROP_RETRACTION_PROMPTS, params: [reportId, reportId] },
    deletePromptStatement(input.prompt.chatId, input.prompt.promptMessageId),
  ];
}

type RetractionDeps = Pick<ReviewDeps, 'api' | 'config' | 'db' | 'clock' | 'logger'>;

/** Sends `text` to the retractor's chat, after the check every outgoing text gets. */
async function tell(deps: RetractionDeps, retractor: Retractor, text: string): Promise<void> {
  await deps.api.sendMessage(retractor.chatId, checkedText(deps.config, text));
}

/** The prompt's text and force reply, after `lead` when given. */
const promptView = (locale: Locale, reportId: string, lead?: string): { readonly text: string; readonly forceReply: ForceReply } => {
  const text = t(locale, 'retract.prompt', { id: reportId });
  return {
    text: lead === undefined ? text : `${lead}\n\n${text}`,
    forceReply: { force_reply: true, input_field_placeholder: t(locale, 'retract.placeholder') },
  };
};

/** Sends the prompt to the retractor's chat (under the status card in the venue); its message id. */
async function sendPrompt(deps: RetractionDeps, retractor: Retractor, reportId: string, venue: VenueFacts | null, lead?: string): Promise<number> {
  const { text, forceReply } = promptView(retractor.locale, reportId, lead);
  const underCard = retractor.chatId === deps.config.adminChatId && venue !== null && venue.statusMessageId !== null ? venue.statusMessageId : null;
  const sent = await deps.api.sendMessage(retractor.chatId, checkedText(deps.config, text), {
    reply_markup: forceReply,
    ...(underCard === null ? {} : { reply_parameters: { message_id: underCard, allow_sending_without_reply: true } }),
  });
  return sent.message_id;
}

/** The prompt row of a retractor's prompt for report `reportId`. */
const promptRow = (retractor: Retractor, reportId: string, promptMessageId: number, now: number): AdminPrompt => ({
  chatId: retractor.chatId,
  promptMessageId,
  adminId: retractor.id,
  reportId,
  kind: RETRACTION_PROMPT,
  category: null,
  linkMode: null,
  createdAt: now,
});

/** What a /retract or a Retract press did. */
export type RetractionStart = 'prompted' | 'not_found' | 'refused';

/**
 * The prompt of report `reportId`'s retraction, to `retractor` (see the
 * header, step 1). Throws a failed send or a storage failure.
 */
export async function startRetraction(deps: RetractionDeps, retractor: Retractor, reportId: string): Promise<RetractionStart> {
  const row = await deps.db.first<ReportRow>(READ, [reportId]);
  if (row === null || row.status === 'merged') return 'not_found';
  if (!retractable(row)) return 'refused';
  // The retractor's earlier prompts for the report go first, rows and messages.
  const earlier = (await promptsOf(deps.db, reportId)).filter(
    (prompt) => prompt.kind === RETRACTION_PROMPT && prompt.adminId === retractor.id && prompt.chatId === retractor.chatId,
  );
  if (earlier.length > 0) {
    await deps.db.batch(earlier.map((prompt) => deletePromptStatement(prompt.chatId, prompt.promptMessageId)));
    for (const prompt of earlier) await deleteFromChat(deps, prompt.chatId, prompt.promptMessageId);
  }
  const promptMessageId = await sendPrompt(deps, retractor, reportId, venueFacts(row));
  try {
    await createPrompt(deps.db, promptRow(retractor, reportId, promptMessageId, deps.clock.now()));
  } catch (error) {
    await deleteFromChat(deps, retractor.chatId, promptMessageId);
    throw error;
  }
  return 'prompted';
}

/**
 * Asks again, with `lead` saying why the reply was refused: the fresh
 * prompt recorded in place of the old in one batch, then the old prompt
 * and the reply deleted. Nothing else is written.
 */
async function askAgain(deps: RetractionDeps, retractor: Retractor, prompt: AdminPrompt, reply: CorrectionReply, venue: VenueFacts | null, lead: string): Promise<void> {
  const fresh = await sendPrompt(deps, retractor, prompt.reportId, venue, lead);
  try {
    await deps.db.batch([
      insertPromptStatement(promptRow(retractor, prompt.reportId, fresh, deps.clock.now())),
      deletePromptStatement(prompt.chatId, prompt.promptMessageId),
    ]);
  } catch (error) {
    await deleteFromChat(deps, retractor.chatId, fresh);
    throw error;
  }
  await deleteFromChat(deps, prompt.chatId, prompt.promptMessageId);
  await deleteFromChat(deps, prompt.chatId, reply.messageId);
}

/** Ends a prompt whose report can no longer be retracted: the row, the prompt and the reply go, the retractor is told. */
async function endPrompt(deps: RetractionDeps, retractor: Retractor, prompt: AdminPrompt, reply: CorrectionReply): Promise<void> {
  await deps.db.batch([deletePromptStatement(prompt.chatId, prompt.promptMessageId)]);
  await deleteFromChat(deps, prompt.chatId, prompt.promptMessageId);
  await deleteFromChat(deps, prompt.chatId, reply.messageId);
  await tell(deps, retractor, t(retractor.locale, 'retract.gone', { id: prompt.reportId }));
}

/**
 * The retractor's reply to `prompt` (see the header, step 2). False when
 * the prompt is no retraction's, or not this retractor's in this chat, for
 * another handler. Throws a failed send or a storage failure.
 */
export async function answerRetraction(deps: RetractionDeps, retractor: Retractor, prompt: AdminPrompt, reply: CorrectionReply): Promise<boolean> {
  if (prompt.kind !== RETRACTION_PROMPT || prompt.adminId !== retractor.id || prompt.chatId !== retractor.chatId) return false;
  const reportId = prompt.reportId;
  const row = await deps.db.first<ReportRow>(READ, [reportId]);
  if (row === null || !retractable(row)) {
    await endPrompt(deps, retractor, prompt, reply);
    return true;
  }
  const venue = venueFacts(row);
  const checked = checkCorrection(deps.config, reply.text);
  if (!checked.ok) {
    await askAgain(deps, retractor, prompt, reply, venue, refusalText(retractor.locale, checked.refusal));
    return true;
  }
  const others = (await promptsOf(deps.db, reportId)).filter(
    (other) => other.kind === RETRACTION_PROMPT && !(other.chatId === prompt.chatId && other.promptMessageId === prompt.promptMessageId),
  );
  const results = await deps.db.batch(
    retractStatements({ reportId, correction: checked.correction, now: deps.clock.now(), byAdmin: retractor.role === 'admin', prompt }),
  );
  if (results[RETRACT_STATUS_STATEMENT]?.changes !== 1) {
    // Locked down after the gates read the switch: the venue, compromised by assumption, gets nothing.
    if (retractor.role === 'admin' && (await isLockedDown(deps.config, deps.db))) return true;
    await endPrompt(deps, retractor, prompt, reply);
    return true;
  }
  deps.logger.log('retract.ordered', { reportId });
  await deleteFromChat(deps, prompt.chatId, prompt.promptMessageId);
  await deleteFromChat(deps, prompt.chatId, reply.messageId);
  const locked = await isLockedDown(deps.config, deps.db);
  for (const other of others) {
    if (other.chatId === deps.config.adminChatId && locked) continue;
    await deleteFromChat(deps, other.chatId, other.promptMessageId);
  }
  await tell(deps, retractor, t(retractor.locale, 'retract.done', { id: reportId }));
  await showState(deps, reportId, venue, 'retracting', 'retracting');
  return true;
}

/** The Retract button on the status card, pressed by an admin: the prompt in the venue. */
export async function retractFromCard(deps: ReviewDeps, actor: Actor, reportId: string, pressed: Pressed): Promise<PressOutcome> {
  const loaded = await loadPress(deps, actor, reportId, pressed, { pendingOnly: false, statusCard: true });
  if (!loaded.ok) return loaded.outcome;
  const retractor: Retractor = { id: actor.id, role: 'admin', locale: deps.config.venueLocale, chatId: deps.config.adminChatId };
  switch (await startRetraction(deps, retractor, reportId)) {
    case 'prompted':
      return { answer: t(actor.locale, 'review.answer.retract_prompt') };
    case 'not_found':
      return { answer: t(actor.locale, 'review.answer.gone') };
    case 'refused':
      return { answer: t(actor.locale, 'review.answer.retract_refused') };
  }
}

/** The retraction's edit job (see the header, step 3). */
export const retractEdit: EditHandler = async (deps, job) => {
  const target = await readEditTarget(deps.db, job.reportId);
  if (target === null) return;
  if (target.status !== 'retracting') {
    await dropStale(deps, job, 'retracting');
    return;
  }
  const checked = target.correctionText === null ? null : checkCorrection(deps.config, target.correctionText);
  if (target.approvalId === null || target.postMessageId === null || checked === null || !checked.ok) {
    await flagEdit(deps, target);
    throw new AppError('UNEXPECTED', 'a retraction without its approval record, its post or a correction that may be sent');
  }
  await concludeEdit(deps, target, {
    conclusion: { from: 'retracting', to: 'retracted' },
    text: retractedPostText(checked.correction),
    deleteYoung: true,
    done: 'retract.done',
    notice: retractedNoticeText(target.reportId),
  });
};

// @critical-path
// Approve (critical invariants 1, 2, 3, 4, 7 and 8; the MVP plan, section
// 4, "Review"; doc/product/report-lifecycle.md, pending to approved). A
// short conversation on the review card, each step re-checked by the gates
// (the presser's or replier's id on ADMIN_IDS, the venue, no lockdown) and
// here (the report still pending, the press on its own card):
// 1. Approve: the category confirmation, the seven categories with the
//    reporter's label marked. Suspected CSAM leads to the routing card
//    (src/review/route.ts): nothing here ever approves it (renderPost()
//    and linkModesFor() refuse it too).
// 2. When the report has no account link (the reporter answered "I don't
//    know"), a force-reply prompt for it, `account_link`; the reply passes
//    the intake's link policy (checkReportedLink(): exact host, https, no
//    redirector, Telegram's two shapes only), is an account on the report's
//    own platform, and is stored in `account_url`.
// 3. The link mode, within allowedModes() (src/review/card.ts). A press of
//    a mode the report does not allow, for a category that is posted and a
//    report whose account is known (a stale press: the report changed
//    under the open card, an affected duplicate raising its flag, say; or
//    a forged one), gets the card's modes shown again as the report allows
//    them now, by the edit that logs its failure, and is answered "not
//    allowed"; a press for a category that is never posted is only
//    answered so.
// 4. A force-reply prompt for the recommended points, `recommended_comment`,
//    recording the confirmed category and the link mode. Only the admin who
//    was asked can answer it (src/review/prompts.ts): the replier is the
//    approving admin.
// The reply is validated by the admin free-text policy (no URL, bare
// domain, mention, t.me or phone number; at most 300 characters); the post
// is rendered in both locales (src/review/render-post.ts) and, with the
// keyholders' notice that carries it, checked against Telegram's 4096
// characters and the link policy. A refusal at any of these sends a fresh
// prompt saying why, and writes nothing. Then ONE batch (approveStatements):
// - the approval row, written only while the report is pending, still holds
//   the links the post was rendered from (`url` and `account_url`) and
//   still allows the link mode, and the lockdown switch is not set, all in
//   the statement itself. The report was read, the mode checked and the
//   post rendered before the notices went out (up to ten seconds per
//   keyholder), and the report may change meanwhile: an affected
//   duplicate's submit raises its flag, or another admin's approval clears
//   it and a keyholder's Cancel returns the report to review. So the
//   statement holds allowedModes()'s rule for the flag and the links, in
//   SQL: the account link always; the post's URL only while the flag is
//   exactly 0 and the report has a URL that is not the account's (a
//   cleared flag fails closed). The category's own set needs no such
//   check: the category and the mode are the prompt row's, checked before
//   the render, and no window opens on them. NOT_LOCKED_DOWN is there
//   because the gates read the switch when the reply came, and the
//   notices, with their Lockdown button, go out between that read and this
//   batch. The row: a
//   random `approval_id`, the admin's numeric id, `approved_at`, the link
//   mode, the recommended points, `starts_at` = now +
//   APPROVAL_GRACE_MINUTES; over a voided row (a re-approval after Cancel)
//   with a new `approval_id`, never over a live one, and never when the
//   statement's own condition fails, since a SELECT that yields no row
//   attempts no insert, and so no update over the conflicting row;
// - the conditional `pending` to `approved`, bound to that approval_id
//   (exactly one row changes for the one decision that wins), with the
//   admin's category, the link mode and the rendered post
//   (`broadcast_text`); `comment` and `affected_person` nulled, on the
//   report and on every report merged into it;
// - the post job, due at `starts_at`, carrying the approval_id
//   (src/broadcast/jobs.ts);
// - the report's prompts deleted, the answered one in every case.
// The schema's trigger refuses an approved status without an un-voided
// approval, so no order of these statements can approve without its row.
// The keyholders' Cancel during the grace is the one human check outside
// the admins' reach, so the approval's notice goes to every keyholder
// (src/review/notify.ts) BEFORE the batch is written, under the approval's
// new id: when it reaches no keyholder (every send failed, an ambiguous
// timeout included) the reply is refused like any other, a fresh prompt
// saying that the keyholders must /start the bot first, and nothing is
// written, so no approval nobody outside could see ever exists. One
// delivered notice of several suffices. When the batch then loses (another
// decision won, the report changed under the approval, or a keyholder
// locked the bot down meanwhile, when it writes nothing but the answered
// prompt's deletion), the notices sent are edited to "cancelled" as Cancel
// edits them, and, unless the bot is locked down (the venue is compromised
// by assumption then, and gets nothing), the prompt is ended in the venue
// and the card shows the report as it is now, by an edit that logs its
// failure (the batch has run): at the category step while it is still
// pending, so the admin starts again on what it allows now, its outcome
// otherwise. When the batch fails, a read decides:
// the approval did not land, and the notices are edited so and the failure
// goes on; it landed (a failed batch may still have committed), and the
// failure is logged by class and the approval goes on as if the batch had
// answered, since a live approval's notice never says "cancelled"; the read
// fails too, and the notices are left as they are and the failure goes on.
// A keyholder's Cancel on a notice whose approval is not recorded writes
// nothing and says so, until the notice is five minutes old
// (src/review/cancel.ts); its Lockdown works as ever, and stops the batch.
// After the commit: the card edited to the approval with Cancel, the status
// card posted, the prompts and the reply deleted, each step logged by
// class if it fails. Every venue text is in VENUE_LOCALE. Nothing goes to
// the reporter.
import { isLockedDown, NOT_LOCKED_DOWN } from '../auth/lockdown';
import { enqueuePostStatement } from '../broadcast/jobs';
import { randomId } from '../db/ids';
import { concatSql, sql, type SqlStatement } from '../db/sql';
import { t, type Locale } from '../i18n/index';
import { checkReportedLink } from '../platforms/link-policy';
import { allowedModes, approvedCard, cardFacts, currentCard, reviewCard, routingCard } from './card';
import { isPostedCategory, type Category, type LinkMode, type PostedCategory } from './categories';
import { clearActorPrompts, deletePromptMessages, loadPress, promptView, sendPrompt, showAfterCommit, showStep } from './flow';
import { extractLink } from './intake';
import { cancelledNoticeText, editNotices, noticeText, notifyKeyholders, type NoticeFacts } from './notify';
import { deletePromptStatement, insertPromptStatement, promptsOf, type AdminPrompt } from './prompts';
import { postProblems, renderBilingualPost } from './render-post';
import { liveApproval, readApproval, readReport, setAccountUrl, setStatusMessage, type ReviewReport } from './reports';
import { statusCard, type NoticeCount } from './status-card';
import { checkAdminText, type AdminTextProblem } from './text-policy';
import { deleteInVenue, editMessage, sendToVenue, type Actor, type Pressed, type PressOutcome, type ReviewDeps } from './venue';

const UPSERT_APPROVAL = concatSql(
  sql`INSERT INTO approvals (report_id, approval_id, admin_id, approved_at, link_mode, recommended_comment, starts_at, voided_at) SELECT ?, ?, ?, ?, ?, ?, ?, NULL WHERE EXISTS (SELECT 1 FROM reports WHERE id = ? AND status = 'pending' AND url IS ? AND account_url IS ? AND (? = 'account' OR (affected_person = 0 AND url <> account_url))) AND `,
  NOT_LOCKED_DOWN,
  sql` ON CONFLICT (report_id) DO UPDATE SET approval_id = excluded.approval_id, admin_id = excluded.admin_id, approved_at = excluded.approved_at, link_mode = excluded.link_mode, recommended_comment = excluded.recommended_comment, starts_at = excluded.starts_at, voided_at = NULL WHERE approvals.voided_at IS NOT NULL`,
);
const APPROVE_REPORT = sql`UPDATE reports SET status = 'approved', category = ?, link_mode = ?, broadcast_text = ?, comment = NULL, affected_person = NULL WHERE id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM approvals WHERE report_id = reports.id AND approval_id = ? AND voided_at IS NULL)`;
const CLEAR_MERGED = sql`UPDATE reports SET comment = NULL, affected_person = NULL WHERE merged_into = ? AND EXISTS (SELECT 1 FROM approvals WHERE report_id = ? AND approval_id = ? AND voided_at IS NULL)`;
const DROP_PROMPTS = sql`DELETE FROM admin_prompts WHERE report_id = ? AND EXISTS (SELECT 1 FROM approvals WHERE report_id = ? AND approval_id = ? AND voided_at IS NULL)`;

/** What the approval's batch writes. */
export interface ApprovalInput {
  readonly reportId: string;
  /** A fresh random id (src/db/ids.ts): every approval writes its own. */
  readonly approvalId: string;
  readonly jobId: string;
  /** The approving admin, the replier: an id on ADMIN_IDS. */
  readonly adminId: number;
  readonly category: PostedCategory;
  readonly linkMode: LinkMode;
  /** The report's links as the post was rendered from them: the batch approves only a report that still holds them. */
  readonly links: { readonly url: string | null; readonly accountUrl: string };
  readonly recommendedComment: string;
  /** The bilingual post, as rendered and validated. */
  readonly broadcastText: string;
  readonly now: number;
  readonly startsAt: number;
  /** The prompt the reply answered. */
  readonly prompt: Pick<AdminPrompt, 'chatId' | 'promptMessageId'>;
}

/** The index, in approveStatements(), of the status change: one row changed means the approval won. */
export const APPROVAL_STATUS_STATEMENT = 1;

/** The approval's one batch (see the header). */
export function approveStatements(input: ApprovalInput): SqlStatement[] {
  const { reportId, approvalId } = input;
  return [
    {
      sql: UPSERT_APPROVAL,
      params: [
        reportId,
        approvalId,
        input.adminId,
        input.now,
        input.linkMode,
        input.recommendedComment,
        input.startsAt,
        reportId,
        input.links.url,
        input.links.accountUrl,
        input.linkMode,
      ],
    },
    { sql: APPROVE_REPORT, params: [input.category, input.linkMode, input.broadcastText, reportId, approvalId] },
    enqueuePostStatement({ jobId: input.jobId, reportId, approvalId, startsAt: input.startsAt, now: input.now }),
    { sql: CLEAR_MERGED, params: [reportId, reportId, approvalId] },
    { sql: DROP_PROMPTS, params: [reportId, reportId, approvalId] },
    deletePromptStatement(input.prompt.chatId, input.prompt.promptMessageId),
  ];
}

/**
 * Runs the approval's batch; true when it won: the report was still
 * pending, held the links and still allowed the mode, and the bot was not
 * locked down.
 */
export async function writeApproval(deps: Pick<ReviewDeps, 'db'>, input: ApprovalInput): Promise<boolean> {
  const results = await deps.db.batch(approveStatements(input));
  return results[APPROVAL_STATUS_STATEMENT]?.changes === 1;
}

/** Approve: the category confirmation. */
export async function startApproval(deps: ReviewDeps, actor: Actor, reportId: string, pressed: Pressed): Promise<PressOutcome> {
  const loaded = await loadPress(deps, actor, reportId, pressed, { pendingOnly: true });
  if (!loaded.ok) return loaded.outcome;
  await showStep(deps, loaded.report, { kind: 'categories' });
  return {};
}

/** The modes step of `report` under `category`, or the account-link prompt first when it has no account link. */
async function afterCategory(deps: ReviewDeps, actor: Actor, report: ReviewReport, category: PostedCategory): Promise<void> {
  if (report.accountUrl === null) {
    await sendPrompt(deps, actor, report, 'account_link', { category, linkMode: null });
    await showStep(deps, report, { kind: 'account', category });
    return;
  }
  await showStep(deps, report, { kind: 'modes', category, modes: allowedModes(report, category) });
}

/** A category confirmed: suspected CSAM goes to the routing card; any other to the next step. */
export async function chooseCategory(
  deps: ReviewDeps,
  actor: Actor,
  reportId: string,
  category: Category,
  pressed: Pressed,
): Promise<PressOutcome> {
  const loaded = await loadPress(deps, actor, reportId, pressed, { pendingOnly: true });
  if (!loaded.ok) return loaded.outcome;
  const { report } = loaded;
  if (!isPostedCategory(category)) {
    if (report.cardMessageId !== null) await editMessage(deps, report.cardMessageId, routingCard(report, deps.config.venueLocale));
    return {};
  }
  await afterCategory(deps, actor, report, category);
  return {};
}

/** A link mode chosen: the recommended-points prompt, if the mode is one the report allows; else "not allowed", the card's modes shown again as they are now (see the header, step 3). */
export async function chooseLinkMode(
  deps: ReviewDeps,
  actor: Actor,
  reportId: string,
  category: Category,
  mode: LinkMode,
  pressed: Pressed,
): Promise<PressOutcome> {
  const loaded = await loadPress(deps, actor, reportId, pressed, { pendingOnly: true });
  if (!loaded.ok) return loaded.outcome;
  const { report } = loaded;
  if (!isPostedCategory(category)) return { answer: t(actor.locale, 'review.answer.not_allowed') };
  if (report.accountUrl !== null && !allowedModes(report, category).includes(mode)) {
    // A stale press (the report changed under the open card: an affected duplicate raised its flag, say) or a forged one:
    // the card shows the modes the report allows now, by the edit that logs its failure, so a failed edit never keeps the refusal from its answer.
    const modes = reviewCard(await cardFacts(deps.db, report), deps.config.venueLocale, { kind: 'modes', category, modes: allowedModes(report, category) });
    await showAfterCommit(deps, report, modes);
    return { answer: t(actor.locale, 'review.answer.not_allowed') };
  }
  if (report.accountUrl === null) {
    await afterCategory(deps, actor, report, category);
    return {};
  }
  await sendPrompt(deps, actor, report, 'recommended_comment', { category, linkMode: mode });
  await showStep(deps, report, { kind: 'points', category, mode });
  return {};
}

/** Back: the card's review state again, the presser's open prompts for the report deleted. */
export async function goBack(deps: ReviewDeps, actor: Actor, reportId: string, pressed: Pressed): Promise<PressOutcome> {
  const loaded = await loadPress(deps, actor, reportId, pressed, { pendingOnly: true });
  if (!loaded.ok) return loaded.outcome;
  await clearActorPrompts(deps, actor, loaded.report);
  await showStep(deps, loaded.report, { kind: 'review' });
  return {};
}

/** An admin's reply to a prompt: its message, and its text when it is a text. */
export interface PromptReply {
  readonly messageId: number;
  readonly text: string | undefined;
}

/**
 * Sends `prompt` again with `lead` (why the reply was refused), records the
 * new one in place of the old in one batch, and deletes the old prompt and
 * the reply. Nothing else is written.
 */
async function refuse(deps: ReviewDeps, report: ReviewReport, prompt: AdminPrompt, reply: PromptReply, lead: string): Promise<void> {
  if (prompt.kind !== 'account_link' && prompt.kind !== 'recommended_comment') return;
  const { view, forceReply } = promptView(prompt.kind, report.id, deps.config.venueLocale, lead);
  const sent = await sendToVenue(deps, view, { forceReply, ...(report.cardMessageId === null ? {} : { replyTo: report.cardMessageId }) });
  try {
    await deps.db.batch([
      insertPromptStatement({ ...prompt, promptMessageId: sent.message_id, createdAt: deps.clock.now() }),
      deletePromptStatement(prompt.chatId, prompt.promptMessageId),
    ]);
  } catch (error) {
    await deleteInVenue(deps, sent.message_id);
    throw error;
  }
  await deleteInVenue(deps, prompt.promptMessageId);
  await deleteInVenue(deps, reply.messageId);
}

/**
 * Ends a prompt: its row, its message and the reply go. Given the report,
 * the card then shows it as it is now (a decided report's outcome), by the
 * edit that logs its failure; given null, the card is the caller's to show
 * (a report still pending that changed under the prompt starts again at the
 * category).
 */
async function endPrompt(deps: ReviewDeps, report: ReviewReport | null, prompt: AdminPrompt, reply: PromptReply): Promise<void> {
  await deps.db.batch([deletePromptStatement(prompt.chatId, prompt.promptMessageId)]);
  await deletePromptMessages(deps, [prompt]);
  await deleteInVenue(deps, reply.messageId);
  if (report !== null) {
    await showAfterCommit(deps, report, currentCard(await cardFacts(deps.db, report), await readApproval(deps.db, report.id), deps.config.venueLocale));
  }
}

/** The reply to an `account_link` prompt (see the header, step 2). */
async function captureAccountLink(deps: ReviewDeps, actor: Actor, report: ReviewReport, prompt: AdminPrompt, reply: PromptReply): Promise<void> {
  const venue = deps.config.venueLocale;
  const category = prompt.category;
  if (reply.text === undefined) return refuse(deps, report, prompt, reply, t(venue, 'review.refused.not_text'));
  const candidate = extractLink(reply.text);
  if (!candidate.ok) return refuse(deps, report, prompt, reply, t(venue, 'review.refused.account_not_link'));
  const analysis = checkReportedLink(candidate.candidate, deps.config.allowedLinkHosts);
  if (!analysis.ok) return refuse(deps, report, prompt, reply, t(venue, 'review.refused.account_policy'));
  const { link } = analysis;
  if (link.platform !== report.platform || (link.platform !== 'other' && link.kind !== 'account')) {
    return refuse(deps, report, prompt, reply, t(venue, 'review.refused.account_link'));
  }
  await setAccountUrl(deps.db, report.id, link.url);
  await deps.db.batch([deletePromptStatement(prompt.chatId, prompt.promptMessageId)]);
  await deletePromptMessages(deps, [prompt]);
  await deleteInVenue(deps, reply.messageId);
  const current = await readReport(deps.db, report.id);
  if (current === null || current.status !== 'pending') return;
  if (category === null || !isPostedCategory(category)) return showStep(deps, current, { kind: 'categories' });
  await afterCategory(deps, actor, current, category);
}

/** Why the points were refused, as the venue is told. */
function pointsRefusal(locale: Locale, problem: AdminTextProblem, length: number): string {
  switch (problem) {
    case 'url':
      return t(locale, 'review.refused.url');
    case 'domain':
      return t(locale, 'review.refused.domain');
    case 'mention':
      return t(locale, 'review.refused.mention');
    case 'phone':
      return t(locale, 'review.refused.phone');
    case 'too_long':
      return t(locale, 'review.refused.too_long', { length });
  }
}

/** The reply to a `recommended_comment` prompt: validation, the post, the batch, the notices (see the header). */
async function capturePoints(deps: ReviewDeps, actor: Actor, report: ReviewReport, prompt: AdminPrompt, reply: PromptReply): Promise<void> {
  const venue = deps.config.venueLocale;
  const { category, linkMode } = prompt;
  if (category === null || linkMode === null || !isPostedCategory(category) || report.accountUrl === null || !allowedModes(report, category).includes(linkMode)) {
    // The report changed under the prompt (or the row is not one this unit wrote): the admin starts the step again.
    await endPrompt(deps, null, prompt, reply);
    await showStep(deps, report, { kind: 'categories' });
    return;
  }
  if (reply.text === undefined) return refuse(deps, report, prompt, reply, t(venue, 'review.refused.not_text'));
  const points = reply.text.trim();
  if (points === '') return refuse(deps, report, prompt, reply, t(venue, 'review.refused.empty'));
  const [problem] = checkAdminText('recommended_comment', points);
  if (problem !== undefined) return refuse(deps, report, prompt, reply, pointsRefusal(venue, problem, [...points].length));

  const rendering = renderBilingualPost(
    { platform: report.platform, category, url: report.url, accountUrl: report.accountUrl },
    { linkMode, recommendedComment: points },
    deps.config.allowedLinkHosts,
  );
  if (!rendering.ok) return refuse(deps, report, prompt, reply, t(venue, 'review.refused.link_policy'));
  const now = deps.clock.now();
  const startsAt = now + deps.config.approvalGraceMinutes * 60_000;
  const facts: NoticeFacts = { reportId: report.id, platform: report.platform, category, startsAt };
  const checks = [postProblems(rendering.text, deps.config.allowedLinkHosts), postProblems(noticeText(facts, rendering.text), deps.config.allowedLinkHosts)];
  const excess = Math.max(...checks.map((check) => check.excess));
  if (excess > 0) return refuse(deps, report, prompt, reply, t(venue, 'review.refused.post_too_long', { excess }));
  if (checks.some((check) => check.links.length > 0)) return refuse(deps, report, prompt, reply, t(venue, 'review.refused.link_policy'));

  // The notice goes before the approval is written: no delivered notice, no approval, by construction.
  const approvalId = randomId();
  const open = await promptsOf(deps.db, report.id);
  const notified = await notify(deps, facts, approvalId, rendering.text);
  if (notified.sent === 0) {
    deps.notices.forget(approvalId);
    deps.logger.log('review.notice_unreached', { reportId: report.id, sent: 0, failed: notified.failed });
    return refuse(deps, report, prompt, reply, t(venue, 'review.refused.unnotified'));
  }
  let won: boolean;
  try {
    won = await writeApproval(deps, {
      reportId: report.id,
      approvalId,
      jobId: randomId(),
      adminId: actor.id,
      category,
      linkMode,
      links: { url: report.url, accountUrl: report.accountUrl },
      recommendedComment: points,
      broadcastText: rendering.text,
      now,
      startsAt,
      prompt,
    });
  } catch (error) {
    const state = await landed(deps, report.id, approvalId);
    if (state !== true) {
      if (state === false) await withdrawNotices(deps, report.id, approvalId);
      throw error;
    }
    // The batch failed, yet the approval stands: known, not guessed (see the header).
    deps.logger.logError('review.approval_landed', error, { reportId: report.id });
    won = true;
  }
  if (!won) {
    // Another decision won, the report changed under the approval, or the bot was locked down, after the notices went out: they say "cancelled", as Cancel leaves them.
    await withdrawNotices(deps, report.id, approvalId);
    if (await isLockedDown(deps.config, deps.db)) return;
    const current = await readReport(deps.db, report.id);
    if (current?.status === 'pending') {
      // Still in review: the admin starts again at the category, on the card as the report is now (its flag included),
      // by the edit that logs its failure, as the edit of the non-pending card below does.
      await endPrompt(deps, null, prompt, reply);
      await showAfterCommit(deps, current, reviewCard(await cardFacts(deps.db, current), deps.config.venueLocale, { kind: 'categories' }));
      return;
    }
    await endPrompt(deps, current, prompt, reply);
    return;
  }
  await afterApproval(deps, report, approvalId, { sent: notified.sent, total: deps.config.keyholderIds.length }, open, reply);
}

/**
 * The approval's notice to every keyholder, before anything is written;
 * how many got it and how many did not. Never throws: a notice that could
 * not be sent at all is logged by class and counts as reaching nobody.
 */
async function notify(deps: ReviewDeps, facts: NoticeFacts, approvalId: string, post: string): Promise<{ readonly sent: number; readonly failed: number }> {
  try {
    const outcome = await notifyKeyholders(deps, facts, approvalId, post);
    if (outcome.sent > 0 && outcome.failed > 0) {
      deps.logger.log('review.notice_incomplete', { reportId: facts.reportId, sent: outcome.sent, failed: outcome.failed });
    }
    return { sent: outcome.sent, failed: outcome.failed };
  } catch (error) {
    deps.logger.logError('review.notice_failed', error, { reportId: facts.reportId });
    return { sent: 0, failed: deps.config.keyholderIds.length };
  }
}

/**
 * Whether approval `approvalId` of the report is live, read after its batch
 * failed; null when the read fails too. Never throws.
 */
async function landed(deps: ReviewDeps, reportId: string, approvalId: string): Promise<boolean | null> {
  try {
    return (await liveApproval(deps.db, reportId))?.approvalId === approvalId;
  } catch (error) {
    deps.logger.logError('review.approval_unknown', error, { reportId });
    return null;
  }
}

/** The notices of an approval that never landed, edited to "cancelled" as Cancel edits them. Never throws. */
async function withdrawNotices(deps: ReviewDeps, reportId: string, approvalId: string): Promise<void> {
  try {
    await editNotices(deps, approvalId, cancelledNoticeText(reportId));
  } catch (error) {
    deps.logger.logError('review.notice_not_edited', error, { reportId });
  }
}

/** After the commit: the card, the status card, the prompts and the reply (see the header). */
async function afterApproval(
  deps: ReviewDeps,
  report: ReviewReport,
  approvalId: string,
  notified: NoticeCount,
  prompts: readonly AdminPrompt[],
  reply: PromptReply,
): Promise<void> {
  const venue = deps.config.venueLocale;
  try {
    const current = await readReport(deps.db, report.id);
    const live = await liveApproval(deps.db, report.id);
    if (current !== null && live !== null && live.approvalId === approvalId) {
      await showAfterCommit(deps, current, approvedCard(current, live, venue));
      const sent = await sendToVenue(deps, statusCard(current, live, venue, notified), {
        ...(current.cardMessageId === null ? {} : { replyTo: current.cardMessageId }),
      });
      await setStatusMessage(deps.db, report.id, sent.message_id);
    }
  } catch (error) {
    deps.logger.logError('review.status_card_not_sent', error, { reportId: report.id });
  }
  // Every prompt of the report, the answered one and any other admin's, went with the batch.
  await deletePromptMessages(deps, prompts);
  await deleteInVenue(deps, reply.messageId);
}

/**
 * An admin's reply to `prompt`: the account link or the recommended
 * points. False when the prompt is not one of this unit's kinds, for its
 * own handler; the gates and the caller have checked that the replier is
 * the admin who was asked.
 */
export async function answerPrompt(deps: ReviewDeps, actor: Actor, prompt: AdminPrompt, reply: PromptReply): Promise<boolean> {
  if ((prompt.kind !== 'account_link' && prompt.kind !== 'recommended_comment') || prompt.adminId !== actor.id) return false;
  const report = await readReport(deps.db, prompt.reportId);
  if (report === null || report.status !== 'pending') {
    await endPrompt(deps, report, prompt, reply);
    return true;
  }
  if (prompt.kind === 'account_link') await captureAccountLink(deps, actor, report, prompt, reply);
  else await capturePoints(deps, actor, report, prompt, reply);
  return true;
}

// @critical-path
// What the closure and the retraction edit jobs share (critical invariants
// 1, 4, 5 and 8; the MVP plan, section 4, "Closure and retraction";
// doc/product/report-lifecycle.md, "Closure outcomes"; ADR 0004): the
// handlers (src/broadcast/closure.ts, retraction.ts) read the report with
// readEditTarget(), check what is theirs to check, and hand the edit to
// concludeEdit(), so every edit of a post reaches that report's own post,
// under its approval, and nothing else does.
// - readEditTarget(): the report, its live approval and whether /halt or the
//   lockdown switch is set, in ONE query.
// - concludeEdit(): ONE editMessageText of the report's own
//   `post_message_id` in BROADCAST_CHAT_ID and nowhere else, through the one
//   transformer (previews off, HTML), without a keyboard, so the "I reported
//   it" button goes; the text has passed postProblems() before it comes
//   here. By Telegram's answer, keyed on the catalog's flags, never on a
//   class's name:
//   - a Message, "message is not modified" (an edit a cut run made already)
//     or "message to edit not found" (the post is gone): the post is
//     addressed; a post gone concludes under its own log line,
//     `edit.post_gone`, in place of the done one, and is not deleted again;
//   - a 429, or an ambiguous answer (a timeout, a network error, a 5xx, an
//     unknown failure): thrown, so the runner (src/broadcast/edits.ts)
//     records it on the job, the 429 with the global pause; an edit is
//     idempotent, so trying it again is safe;
//   - any other refusal (no right to edit, the chat not found): a retraction
//     first tries to delete a post younger than Telegram's 48 hours, and a
//     post gone is addressed after all; otherwise flagEdit() and thrown, so
//     the job is tried again after its back-off until the retention job
//     abandons it at 20 attempts. Nothing is written to the report, which
//     keeps its post id and its texts: nothing finalizes while the post is
//     unaddressed.
//   A retraction whose edit went also deletes the post when it is younger
//   than 48 hours, in addition and best effort: a 429 there sets the global
//   pause in the conclusion's batch, any other failure is logged by class
//   (the correction stands). Then ONE batch (concludeStatements(),
//   src/broadcast/finalize.ts): the terminal status, bound to the report's
//   state, its live approval and the post just edited (a closure also to no
//   /halt and no switch), and the finalization. A batch whose status change
//   changes no row (a hold or a change overtook the edit) concludes nothing
//   and fails nothing: the job stays, and its next run finds the post "not
//   modified" and concludes. After the commit, each step logged by class if
//   it fails: the keyholders' remembered notices edited (a retraction's) or
//   forgotten (a closure's); unless locked down (the venue is compromised
//   by assumption then), the status card edited to the outcome without
//   buttons; the messages of the prompts the report still had deleted from
//   their chats (the venue's not under lockdown), within the 48 hours.
// - flagEdit(): for a refusal, or for a report that holds no approval record
//   or no post, which is never edited (rule 1): `needs_attention` set, and on
//   the flag's first setting ONE alert to every keyholder in both locales and
//   to the venue unless locked down (marked alerted once a keyholder got it;
//   reconciliation sends one that reached nobody again), and the status
//   card's note, unless locked down.
// - dropStale(): a job whose report left the state of its action is dropped.
// - showState(): the status card of a closure or a retraction under way.
import { isLockedDown } from '../auth/lockdown';
import type { Config } from '../config/schema';
import { isId } from '../db/ids';
import { sql, type SqlDb, type SqlValue } from '../db/sql';
import { AppError } from '../errors/app-error';
import { ErrorCode, type CatalogEntry } from '../errors/catalog';
import { t } from '../i18n/index';
import type { Logger } from '../privacy/logger';
import { STATUS_NAME_KEYS } from '../review/names';
import { editNotices } from '../review/notify';
import { promptsOf, type AdminPrompt } from '../review/prompts';
import { isReportStatus, type ReportStatus } from '../review/reports';
import { concludedStatusCard, statusCard, type StatusNote } from '../review/status-card';
import { editAfterCommit } from '../review/venue';
import type { BotApiPort } from '../telegram/bot-api-port';
import { classifyTelegramError } from '../telegram/errors';
import type { EditJob } from './edits';
import { CONCLUDE_STATUS_STATEMENT, concludeStatements, type Conclusion } from './finalize';
import { DEFAULT_RETRY_AFTER_SECONDS, venueFacts, type VenueFacts } from './post';
import { alertEveryone, markAlerted } from './report-alerts';
import { isStorageFailure, pauseStatement } from './state';
import type { TickDeps } from './tick';

/** Telegram's window for deleting a message: 48 hours from its send, for administrator bots too. */
export const MESSAGE_DELETE_WINDOW_MS = 48 * 60 * 60_000;

/** The report an edit job edits the post of, as one query reads it. */
export interface EditTarget {
  readonly reportId: string;
  readonly status: ReportStatus;
  readonly outcome: string | null;
  readonly postMessageId: number | null;
  /** When the post was sent, as near as the row knows it: its claim, else its record. */
  readonly sentAt: number | null;
  readonly broadcastText: string | null;
  readonly correctionText: string | null;
  /** The live approval's id; null when the report holds none. */
  readonly approvalId: string | null;
  /** Whether /halt or the lockdown switch was set when the row was read. */
  readonly held: boolean;
  readonly venue: VenueFacts | null;
}

const READ = sql`SELECT r.status, r.outcome, r.post_message_id, r.posting_started_at, r.posted_at, r.broadcast_text, r.correction_text, r.platform, r.category, r.reporter_ref, r.card_message_id, r.status_message_id, a.approval_id, EXISTS (SELECT 1 FROM meta WHERE key IN ('lockdown', 'halted')) AS held FROM reports AS r LEFT JOIN approvals AS a ON a.report_id = r.id AND a.voided_at IS NULL WHERE r.id = ?`;
const FLAG = sql`UPDATE reports SET needs_attention = 1 WHERE id = ? AND status = ? AND needs_attention = 0`;
const DROP_STALE = sql`DELETE FROM jobs WHERE id = ? AND NOT EXISTS (SELECT 1 FROM reports WHERE id = ? AND status = ?)`;

interface TargetRow {
  readonly status: SqlValue;
  readonly outcome: SqlValue;
  readonly post_message_id: SqlValue;
  readonly posting_started_at: SqlValue;
  readonly posted_at: SqlValue;
  readonly broadcast_text: SqlValue;
  readonly correction_text: SqlValue;
  readonly platform: SqlValue;
  readonly category: SqlValue;
  readonly reporter_ref: SqlValue;
  readonly card_message_id: SqlValue;
  readonly status_message_id: SqlValue;
  readonly approval_id: SqlValue;
  readonly held: SqlValue;
}

const integer = (value: SqlValue): number | null => (typeof value === 'number' && Number.isSafeInteger(value) ? value : null);
const text = (value: SqlValue): string | null => (typeof value === 'string' ? value : null);

/**
 * Report `reportId` as an edit job needs it (see the header), or null when
 * there is none. Throws an AppError UNEXPECTED for a status outside the
 * schema's set, and a storage failure.
 */
export async function readEditTarget(db: SqlDb, reportId: string): Promise<EditTarget | null> {
  const row = await db.first<TargetRow>(READ, [reportId]);
  if (row === null) return null;
  if (!isReportStatus(row.status)) throw new AppError('UNEXPECTED', 'a reports row holds a value outside its type');
  return {
    reportId,
    status: row.status,
    outcome: text(row.outcome),
    postMessageId: integer(row.post_message_id),
    sentAt: integer(row.posting_started_at) ?? integer(row.posted_at),
    broadcastText: text(row.broadcast_text),
    correctionText: text(row.correction_text),
    approvalId: isId(row.approval_id) ? row.approval_id : null,
    held: row.held === 1,
    venue: venueFacts(row),
  };
}

/** What a handler hands concludeEdit(). */
export interface EditPlan {
  /** The state the report is in and the terminal status the success writes. */
  readonly conclusion: Conclusion;
  /** The post's new text, checked by postProblems() already. */
  readonly text: string;
  /** A retraction's: the post also deleted when it is younger than Telegram's 48 hours. */
  readonly deleteYoung: boolean;
  readonly done: 'close.done' | 'retract.done';
  /** The keyholders' remembered notices edited to this text; forgotten when null. */
  readonly notice: string | null;
}

/** What the status card's outcome is called: the report's own for a closure, the status for the rest. */
const outcomeOf = (conclusion: Conclusion, target: EditTarget): string =>
  conclusion.to === 'closed' ? (target.outcome ?? 'closed') : conclusion.to;

const isYoung = (target: EditTarget, at: number): boolean => target.sentAt !== null && at - target.sentAt < MESSAGE_DELETE_WINDOW_MS;

type DeleteOutcome = 'deleted' | 'gone' | 'failed' | { readonly retryAfterMs: number };

/** Deletes the post, once: deleted, gone already, a 429's wait, or failed (logged by class). Never throws. */
async function deletePost(deps: TickDeps, reportId: string, postMessageId: number): Promise<DeleteOutcome> {
  try {
    await deps.api.deleteMessage(deps.config.broadcastChatId, postMessageId);
    return 'deleted';
  } catch (error) {
    const failure = classifyTelegramError(error);
    if (failure.kind === 'message_not_found') return 'gone';
    deps.logger.logError('retract.not_deleted', error, { reportId });
    const entry: CatalogEntry = ErrorCode[failure.code];
    return entry.retryable ? { retryAfterMs: (failure.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS) * 1000 } : 'failed';
  }
}

/** Whether the venue must be left alone: locked down, or the switch unreadable (never a guess). Never throws. */
export async function lockedOrUnknown(deps: { readonly config: Config; readonly db: SqlDb; readonly logger: Logger }): Promise<boolean> {
  try {
    return await isLockedDown(deps.config, deps.db);
  } catch (error) {
    deps.logger.logError('review.message_not_edited', error);
    return true;
  }
}

/**
 * Deletes message `messageId` of `chatId`, trying twice; a message already
 * gone counts as deleted, a failure is logged by class. Never throws; true
 * when it is gone.
 */
export async function deleteFromChat(
  deps: { readonly api: Pick<BotApiPort, 'deleteMessage'>; readonly logger: Logger },
  chatId: number,
  messageId: number,
): Promise<boolean> {
  let failure: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await deps.api.deleteMessage(chatId, messageId);
      return true;
    } catch (error) {
      if (classifyTelegramError(error).kind === 'message_not_found') return true;
      failure = error;
    }
  }
  deps.logger.logError('review.message_not_deleted', failure);
  return false;
}

/** The report's prompts, for their messages after the conclusion; none when a row is unreadable. Throws only a storage failure. */
async function openPrompts(deps: TickDeps, reportId: string): Promise<AdminPrompt[]> {
  try {
    return await promptsOf(deps.db, reportId);
  } catch (error) {
    if (isStorageFailure(error)) throw error;
    deps.logger.logError('review.message_not_deleted', error, { reportId });
    return [];
  }
}

/** The deps the status card's edits take. */
export interface VenueDeps {
  readonly api: Pick<BotApiPort, 'sendMessage' | 'editMessageText' | 'deleteMessage'>;
  readonly config: Config;
  readonly db: SqlDb;
  readonly logger: Logger;
}

/**
 * The status card of report `reportId` in `status` with `note`, unless the
 * bot is locked down or the card's id is not known. Never throws.
 */
export async function showState(deps: VenueDeps, reportId: string, venue: VenueFacts | null, status: ReportStatus, note: StatusNote): Promise<void> {
  if (venue === null || venue.statusMessageId === null) return;
  if (await lockedOrUnknown(deps)) return;
  try {
    const view = statusCard(
      { id: reportId, status, platform: venue.platform, category: venue.category, reporterRef: venue.reporterRef },
      null,
      deps.config.venueLocale,
      undefined,
      note,
    );
    await editAfterCommit(deps, venue.statusMessageId, view);
  } catch (error) {
    deps.logger.logError('review.message_not_edited', error, { reportId });
  }
}

/**
 * Flags `target`'s report for a human (see the header): an edit that could
 * not be made. Throws only a storage failure.
 */
export async function flagEdit(deps: TickDeps, target: EditTarget): Promise<void> {
  const flagged = (await deps.db.run(FLAG, [target.reportId, target.status])).changes === 1;
  if (!flagged) return;
  deps.logger.log('edit.flagged', { reportId: target.reportId });
  let delivered = false;
  try {
    const outcome = await alertEveryone(
      deps,
      (locale) => t(locale, 'alert.edit_held', { id: target.reportId, state: t(locale, STATUS_NAME_KEYS[target.status]) }),
      true,
    );
    delivered = outcome.sent > 0;
  } catch (error) {
    if (isStorageFailure(error)) throw error;
    deps.logger.logError('alert.failed', error);
  }
  if (delivered) await markAlerted(deps.db, [target.reportId], deps.clock.now());
  await showState(deps, target.reportId, target.venue, target.status, 'edit_failed');
}

/** Drops `job`, whose report is no longer `status` (see the header). Throws only a storage failure. */
export async function dropStale(deps: TickDeps, job: EditJob, status: 'closing' | 'retracting'): Promise<void> {
  await deps.db.run(DROP_STALE, [job.id, job.reportId, status]);
  deps.logger.log('edit.stale', { reportId: job.reportId });
}

/** After the conclusion committed (see the header). Never throws. */
async function afterConclusion(deps: TickDeps, target: EditTarget, approvalId: string, plan: EditPlan, prompts: readonly AdminPrompt[], at: number): Promise<void> {
  const reportId = target.reportId;
  try {
    if (plan.notice === null) deps.notices.forget(approvalId);
    else await editNotices(deps, approvalId, plan.notice);
  } catch (error) {
    deps.logger.logError('review.notice_not_edited', error, { reportId });
  }
  const locked = await lockedOrUnknown(deps);
  const venue = target.venue;
  if (!locked && venue !== null && venue.statusMessageId !== null) {
    try {
      const view = concludedStatusCard({ id: reportId, platform: venue.platform, category: venue.category }, outcomeOf(plan.conclusion, target), deps.config.venueLocale);
      await editAfterCommit(deps, venue.statusMessageId, view);
    } catch (error) {
      deps.logger.logError('review.message_not_edited', error, { reportId });
    }
  }
  for (const prompt of prompts) {
    if (at - prompt.createdAt >= MESSAGE_DELETE_WINDOW_MS) continue;
    if (prompt.chatId === deps.config.adminChatId && locked) continue;
    await deleteFromChat(deps, prompt.chatId, prompt.promptMessageId);
  }
}

/**
 * Edits `target`'s post to `plan.text` and, once the post is addressed,
 * concludes and finalizes the report in one batch (see the header). True
 * when it concluded now; false when a hold or a change overtook it.
 * Throws a Bot API failure the runner records on the job, and a storage
 * failure.
 */
export async function concludeEdit(deps: TickDeps, target: EditTarget, plan: EditPlan): Promise<boolean> {
  const { postMessageId, approvalId } = target;
  if (postMessageId === null || approvalId === null) throw new AppError('UNEXPECTED', 'an edit without its post or its approval record');
  let deleted = false;
  let postGone = false;
  try {
    await deps.api.editMessageText(deps.config.broadcastChatId, postMessageId, plan.text, {});
  } catch (error) {
    const failure = classifyTelegramError(error);
    const entry: CatalogEntry = ErrorCode[failure.code];
    if (failure.kind === 'message_not_found') postGone = true;
    else if (failure.kind !== 'message_not_modified') {
      if (entry.retryable || entry.ambiguous === true || failure.kind === 'not_telegram') throw error;
      const outcome: DeleteOutcome = plan.deleteYoung && isYoung(target, deps.clock.now()) ? await deletePost(deps, target.reportId, postMessageId) : 'failed';
      if (outcome === 'deleted') deleted = true;
      else if (outcome === 'gone') postGone = true;
      else {
        await flagEdit(deps, target);
        throw error;
      }
    }
  }
  let pausedUntil: number | null = null;
  if (plan.deleteYoung && !deleted && !postGone && isYoung(target, deps.clock.now())) {
    const outcome = await deletePost(deps, target.reportId, postMessageId);
    if (typeof outcome === 'object') pausedUntil = deps.clock.now() + outcome.retryAfterMs;
  }
  const prompts = await openPrompts(deps, target.reportId);
  const at = deps.clock.now();
  const results = await deps.db.batch([
    ...concludeStatements({ ...plan.conclusion, reportId: target.reportId, postMessageId, now: at }),
    ...(pausedUntil === null ? [] : [pauseStatement(pausedUntil)]),
  ]);
  if (results[CONCLUDE_STATUS_STATEMENT]?.changes !== 1) {
    deps.logger.log('edit.unconcluded', { reportId: target.reportId });
    return false;
  }
  deps.logger.log(postGone ? 'edit.post_gone' : plan.done, { reportId: target.reportId });
  await afterConclusion(deps, target, approvalId, plan, prompts, at);
  return true;
}

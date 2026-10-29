// @critical-path
// The single post of an approved report (critical invariants 1, 2, 4 and
// 5; the MVP plan, sections 2 and 4, "The post"; ADR 0004, "The single
// post"; doc/product/report-lifecycle.md, "The claim statement" and
// "Ambiguous and unambiguous failures"). runPostJob() takes at most ONE due
// `post` job a run, and only when the run found the bot neither locked
// down (the LOCKDOWN override included, which no statement can see),
// halted nor paused (src/broadcast/tick.ts):
// 1. The due job: the oldest whose report is approved under the live
//    approval the job carries, that approval's start reached. A job no
//    claim could take is never picked, so it can hold back no other;
//    reconciliation alerts it once it is overdue.
// 2. The send-time check of the stored post, `reports.broadcast_text`, sent
//    verbatim: within Telegram's 4096 characters, every tappable link on
//    the lists (postProblems(), as at the approval). A text that fails is
//    never sent: the report stays approved, `needs_attention` is set, the
//    job is abandoned, the keyholders are alerted (an admin cancels and
//    approves again, which renders the post afresh).
// 3. The claim, CLAIM_POST, the plan's statement verbatim, exactly one row
//    changed and `posting_started_at` written in that same statement: it
//    binds the job's random approval_id to the live approval, the start,
//    the lockdown switch, /halt and the pause, so a stale run, a Cancel
//    followed by a re-approval, or a hold set after the run read the state
//    all claim nothing. Two runs racing on one job: one claims, the other
//    changes no row and sends nothing.
// 4. The send: ONE sendMessage, to BROADCAST_CHAT_ID and nowhere else, the
//    stored text with the "I reported it" button (`mark:<id>`), through the
//    one transformer (previews off, HTML). The scheduler's client gives up
//    on a request after SEND_TIMEOUT_SECONDS, so a send has ended, one way
//    or the other, well inside POSTING_WINDOW_MS; POSTING_WINDOW_MS rests on
//    that bound, which the Worker's scheduled handler applies
//    (src/worker.ts, pinned by a test) and the Node port must apply the
//    same way to the client its minute loop gives tick().
// 5. Then, by Telegram's answer, keyed on the catalog's flags, never on the
//    class's name (CLAUDE.md, "Error handling"):
//    - a Message: ONE batch writes `post_message_id`, `posted_at` and
//      status `posted`, clears the attention flags and deletes the job;
//      then the keyholders' remembered notices are edited to "posted"
//      without links (and still remembered, for a retraction to edit them
//      again), the status card to "posted", and the review card,
//      which shows the links, is deleted (edited to the outcome when it
//      cannot be). A record that fails is a storage failure, which stops
//      the run: the keyholders are first alerted with the message id, so
//      /attach can record it, and the report stays posting without an id,
//      never re-sent. A record that changes no row means the report was
//      recorded meanwhile (/attach): the message just sent is a second one,
//      and the keyholders are alerted with its id, so they can delete it;
//    - retryable, a 429: ONE batch reverts the claim (`approved`,
//      `posting_started_at` cleared), moves the job to now + retry_after
//      and the global pause there too; nothing is alerted;
//    - a refusal Telegram gave, neither retryable nor ambiguous (a 400 or a
//      403: no right to post, chat not found): ONE batch reverts the claim
//      the same way, sets `needs_attention` and abandons the job; the
//      keyholders (and the venue unless locked down) are alerted, the
//      status card says so;
//    - ambiguous, or nothing Telegram answered at all (a timeout, a network
//      error, a 5xx, an unknown failure): Telegram may have accepted it, so
//      the report stays `posting` without an id and keeps its job, which no
//      run picks again, and it is never re-sent: `needs_attention` is set,
//      the keyholders alerted, the status card says so; a human checks the
//      channel and runs /attach or /repost (src/broadcast/attach.ts,
//      repost.ts).
//    An alert that reached at least one keyholder marks `alert_sent_at`
//    (one delivered of several suffices, as for the approval notice; the
//    misses are logged by class); reconciliation sends one that reached
//    nobody again.
// Nothing here throws but a storage failure, which stops the run without
// any further write, and an AppError UNEXPECTED for a due row holding a
// value outside its type, before any claim or send; every Telegram failure
// after the claim is handled above and logged by class.
import type { InlineKeyboardMarkup, Message } from 'grammy/types';
import { isId } from '../db/ids';
import { sql, type SqlValue } from '../db/sql';
import { AppError } from '../errors/app-error';
import { ErrorCode, type CatalogEntry } from '../errors/catalog';
import { t, type Locale, type MessageKey } from '../i18n/index';
import { isPlatform, type Platform } from '../platforms/platforms';
import { outcomeCard } from '../review/card';
import { isCategory, type Category } from '../review/categories';
import { editNotices, postedNoticeText, type NoticeMemory } from '../review/notify';
import { postProblems, sendable } from '../review/render-post';
import { statusCard, type StatusNote } from '../review/status-card';
import { deleteOrEdit, editAfterCommit } from '../review/venue';
import { alertKeyholders } from '../telegram/alerts';
import { classifyTelegramError } from '../telegram/errors';
import { markData } from '../telegram/presses';
import type { MaintenanceDeps } from './maintenance';
import { alertEveryone, inBothLocales, markAlerted } from './report-alerts';
import { isStorageFailure, pauseStatement, type TickState } from './state';

/** How long the scheduler's client waits for one Bot API request, in seconds (src/worker.ts). */
export const SEND_TIMEOUT_SECONDS = 20;

/**
 * How long a `posting` report is in progress after its claim: its send has
 * ended by then (SEND_TIMEOUT_SECONDS). Past it, a report still posting
 * without an id is stuck: reconciliation alerts it, and /repost admits it.
 */
export const POSTING_WINDOW_MS = 2 * 60_000;

/** The wait a 429 without a usable retry_after is taken to ask for. */
export const DEFAULT_RETRY_AFTER_SECONDS = 60;

/** The claim (see the header): the MVP plan's statement, verbatim. */
export const CLAIM_POST = sql`UPDATE reports SET status = 'posting', posting_started_at = ? WHERE id = ? AND status = 'approved' AND EXISTS (SELECT 1 FROM approvals a WHERE a.report_id = reports.id AND a.voided_at IS NULL AND a.starts_at <= ? AND a.approval_id = ?) AND NOT EXISTS (SELECT 1 FROM meta WHERE key IN ('lockdown', 'halted')) AND NOT EXISTS (SELECT 1 FROM meta WHERE key = 'paused_until' AND value > ?)`;

const DUE_POST = sql`SELECT j.id AS job_id, j.report_id, a.approval_id, a.starts_at, r.broadcast_text, r.platform, r.category, r.reporter_ref, r.card_message_id, r.status_message_id FROM jobs AS j JOIN reports AS r ON r.id = j.report_id JOIN approvals AS a ON a.report_id = j.report_id AND a.approval_id = json_extract(j.payload, '$.approval_id') AND a.voided_at IS NULL AND a.starts_at <= ? WHERE j.kind = 'post' AND j.due_at <= ? AND r.status = 'approved' ORDER BY j.due_at, j.id LIMIT 1`;
const RECORD_POST = sql`UPDATE reports SET status = 'posted', post_message_id = ?, posted_at = max(?, posting_started_at), needs_attention = 0, alert_sent_at = NULL WHERE id = ? AND status = 'posting' AND post_message_id IS NULL`;
const DROP_POST_JOB = sql`DELETE FROM jobs WHERE kind = 'post' AND report_id = ?`;
const DROP_JOB = sql`DELETE FROM jobs WHERE id = ?`;
const REVERT_CLAIM = sql`UPDATE reports SET status = 'approved', posting_started_at = NULL WHERE id = ? AND status = 'posting' AND post_message_id IS NULL`;
const RESCHEDULE = sql`UPDATE jobs SET due_at = ?, attempts = attempts + 1 WHERE kind = 'post' AND report_id = ?`;
const REFUSED = sql`UPDATE reports SET status = 'approved', posting_started_at = NULL, needs_attention = 1 WHERE id = ? AND status = 'posting' AND post_message_id IS NULL`;
const UNCERTAIN = sql`UPDATE reports SET needs_attention = 1 WHERE id = ? AND status = 'posting' AND post_message_id IS NULL`;
const HELD = sql`UPDATE reports SET needs_attention = 1 WHERE id = ? AND status = 'approved'`;

/** What the post works with: the maintenance deps and the isolate's memory of the keyholder notices. */
export interface PostDeps extends MaintenanceDeps {
  readonly notices: NoticeMemory;
}

/** What a run's post step did. */
export type PostOutcome = 'none' | 'held' | 'claim_lost' | 'posted' | 'rate_limited' | 'refused' | 'ambiguous';

/** The "I reported it" button of report `reportId`'s post, labelled in both locales. */
export function postKeyboard(reportId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[{ text: `${t('fa', 'post.button.reported')} · ${t('en', 'post.button.reported')}`, callback_data: markData(reportId) }]],
  };
}

/** What the venue's messages of a report show: none when its row holds a value outside its type. */
export interface VenueFacts {
  readonly platform: Platform;
  readonly category: Category;
  readonly reporterRef: string | null;
  readonly cardMessageId: number | null;
  readonly statusMessageId: number | null;
}

/** A report whose post is recorded, or whose post needs a human. */
export interface PostFacts {
  readonly reportId: string;
  /** The live approval it posts under. */
  readonly approvalId: string;
  readonly startsAt: number;
  readonly venue: VenueFacts | null;
}

interface DuePost extends PostFacts {
  readonly jobId: string;
  readonly text: string | null;
}

interface DueRow {
  readonly job_id: SqlValue;
  readonly report_id: SqlValue;
  readonly approval_id: SqlValue;
  readonly starts_at: SqlValue;
  readonly broadcast_text: SqlValue;
  readonly platform: SqlValue;
  readonly category: SqlValue;
  readonly reporter_ref: SqlValue;
  readonly card_message_id: SqlValue;
  readonly status_message_id: SqlValue;
}

const messageId = (value: SqlValue): number | null => (typeof value === 'number' && Number.isSafeInteger(value) ? value : null);

/** The venue facts of a row, or null when its platform or category is outside its type. */
export function venueFacts(row: Pick<DueRow, 'platform' | 'category' | 'reporter_ref' | 'card_message_id' | 'status_message_id'>): VenueFacts | null {
  if (!isPlatform(row.platform) || !isCategory(row.category)) return null;
  return {
    platform: row.platform,
    category: row.category,
    reporterRef: typeof row.reporter_ref === 'string' ? row.reporter_ref : null,
    cardMessageId: messageId(row.card_message_id),
    statusMessageId: messageId(row.status_message_id),
  };
}

function toDue(row: DueRow): DuePost {
  const { job_id: jobId, report_id: reportId, approval_id: approvalId, starts_at: startsAt } = row;
  if (!isId(jobId) || !isId(reportId) || !isId(approvalId) || typeof startsAt !== 'number') {
    throw new AppError('UNEXPECTED', 'a due post job holds a value outside its type');
  }
  return {
    jobId,
    reportId,
    approvalId,
    startsAt,
    text: typeof row.broadcast_text === 'string' ? row.broadcast_text : null,
    venue: venueFacts(row),
  };
}

/** Whether the stored post may be sent (see the header, step 2). */
const isSendable = (deps: Pick<PostDeps, 'config'>, text: string | null): text is string =>
  text !== null && sendable(postProblems(text, deps.config.allowedLinkHosts));

/**
 * Takes the run's one due post job, if any (see the header). Throws only a
 * storage failure, or an UNEXPECTED for a corrupt row, before any send.
 */
export async function runPostJob(deps: PostDeps, now: number, state: TickState): Promise<PostOutcome> {
  const row = await deps.db.first<DueRow>(DUE_POST, [now, now]);
  if (row === null) return 'none';
  const due = toDue(row);
  if (!isSendable(deps, due.text)) return hold(deps, due, state);
  const claimedAt = deps.clock.now();
  const claim = await deps.db.run(CLAIM_POST, [claimedAt, due.reportId, claimedAt, due.approvalId, claimedAt]);
  if (claim.changes !== 1) {
    deps.logger.log('post.claim_lost', { reportId: due.reportId });
    return 'claim_lost';
  }
  let sent: Message;
  try {
    sent = await deps.api.sendMessage(deps.config.broadcastChatId, due.text, { reply_markup: postKeyboard(due.reportId) });
  } catch (error) {
    return sendFailed(deps, due, error, state);
  }
  await record(deps, due, sent.message_id);
  deps.logger.log('post.sent', { reportId: due.reportId });
  await showPosted(deps, due, state.locked);
  return 'posted';
}

/** The send's record (see the header, a Message); a failure alerts with the message id, then goes on. */
async function record(deps: PostDeps, due: DuePost, postMessageId: number): Promise<void> {
  let changed: number | undefined;
  try {
    const results = await deps.db.batch([
      { sql: RECORD_POST, params: [postMessageId, deps.clock.now(), due.reportId] },
      { sql: DROP_POST_JOB, params: [due.reportId] },
    ]);
    changed = results[0]?.changes;
  } catch (error) {
    deps.logger.logError('post.not_recorded', error, { reportId: due.reportId });
    await alertKeyholdersOf(deps, 'alert.post_unrecorded', due.reportId, postMessageId);
    throw error;
  }
  if (changed !== 1) {
    // /attach recorded the post meanwhile: this message is a second one, an orphan to delete.
    deps.logger.log('post.resolved_elsewhere', { reportId: due.reportId });
    await alertKeyholdersOf(deps, 'alert.post_orphan', due.reportId, postMessageId);
  }
}

/**
 * An alert naming a message of the channel, to the keyholders only (they own
 * the channel; for a record that failed, the store is down too). Never
 * throws.
 */
async function alertKeyholdersOf(
  deps: PostDeps,
  key: Extract<MessageKey, 'alert.post_unrecorded' | 'alert.post_orphan'>,
  reportId: string,
  postMessageId: number,
): Promise<void> {
  try {
    await alertKeyholders(deps, inBothLocales((locale) => t(locale, key, { id: reportId, message: postMessageId })));
  } catch (error) {
    deps.logger.logError('alert.failed', error);
  }
}

/** A failed send, by its class (see the header, step 5). */
async function sendFailed(deps: PostDeps, due: DuePost, error: unknown, state: TickState): Promise<PostOutcome> {
  const failure = classifyTelegramError(error);
  const entry: CatalogEntry = ErrorCode[failure.code];
  const now = deps.clock.now();
  const reportId = due.reportId;
  if (entry.retryable) {
    const waitMs = (failure.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS) * 1000;
    await deps.db.batch([
      { sql: REVERT_CLAIM, params: [reportId] },
      { sql: RESCHEDULE, params: [now + waitMs, reportId] },
      pauseStatement(now + waitMs),
    ]);
    deps.logger.logError('post.rate_limited', error, { reportId, durationMs: waitMs });
    return 'rate_limited';
  }
  if (failure.kind !== 'not_telegram' && entry.ambiguous !== true) {
    await deps.db.batch([
      { sql: REFUSED, params: [reportId] },
      { sql: DROP_POST_JOB, params: [reportId] },
    ]);
    deps.logger.logError('post.refused', error, { reportId });
    await alertAbout(deps, due, 'alert.post_refused', now, state);
    await showNote(deps, due, 'approved', 'refused', state.locked);
    return 'refused';
  }
  await deps.db.run(UNCERTAIN, [reportId]);
  deps.logger.logError('post.ambiguous', error, { reportId });
  await alertAbout(deps, due, 'alert.post_unknown', now, state);
  await showNote(deps, due, 'posting', 'unknown', state.locked);
  return 'ambiguous';
}

/** A stored post the send-time check refused (see the header, step 2). */
async function hold(deps: PostDeps, due: DuePost, state: TickState): Promise<PostOutcome> {
  await deps.db.batch([
    { sql: HELD, params: [due.reportId] },
    { sql: DROP_JOB, params: [due.jobId] },
  ]);
  deps.logger.log('post.text_refused', { reportId: due.reportId });
  await alertAbout(deps, due, 'alert.post_held', deps.clock.now(), state);
  await showNote(deps, due, 'approved', 'held', state.locked);
  return 'held';
}

type ReportAlertKey = Extract<MessageKey, 'alert.post_refused' | 'alert.post_unknown' | 'alert.post_held'>;

/**
 * Alerts the keyholders (and the venue unless locked down) about the
 * report, and marks it alerted once at least one keyholder got it. Throws
 * only a storage failure.
 */
async function alertAbout(deps: PostDeps, due: DuePost, key: ReportAlertKey, now: number, state: TickState): Promise<void> {
  let delivered = false;
  try {
    const outcome = await alertEveryone(deps, (locale: Locale) => t(locale, key, { id: due.reportId }), !state.locked);
    delivered = outcome.sent > 0;
  } catch (error) {
    if (isStorageFailure(error)) throw error;
    deps.logger.logError('alert.failed', error);
  }
  if (delivered) await markAlerted(deps.db, [due.reportId], now);
}

/** The status card's view of `facts` in `status` with `note`, unless locked down. Never throws. */
async function showNote(deps: PostDeps, facts: PostFacts, status: 'approved' | 'posting', note: StatusNote, locked: boolean): Promise<void> {
  const venue = facts.venue;
  if (locked || venue === null || venue.statusMessageId === null) return;
  try {
    const view = statusCard(
      { id: facts.reportId, status, platform: venue.platform, category: venue.category, reporterRef: venue.reporterRef },
      { approvalId: facts.approvalId, startsAt: facts.startsAt, voidedAt: null },
      deps.config.venueLocale,
      undefined,
      note,
    );
    await editAfterCommit(deps, venue.statusMessageId, view);
  } catch (error) {
    deps.logger.logError('review.message_not_edited', error, { reportId: facts.reportId });
  }
}

/**
 * After a post is recorded, by the run or by /attach: the keyholders'
 * remembered notices edited to "posted" without links, and remembered
 * still, so the post's retraction edits them again
 * (src/broadcast/concluding.ts); then, unless the bot is locked down (the
 * venue is compromised by assumption then), the status card edited to
 * "posted", with its closure and retraction buttons, and the review card,
 * which shows the links, deleted (edited to the outcome when it cannot be).
 * Never throws.
 */
export async function showPosted(deps: PostDeps, facts: PostFacts, locked: boolean): Promise<void> {
  try {
    const delivered = deps.notices.recall(facts.approvalId);
    await editNotices(deps, facts.approvalId, postedNoticeText(facts.reportId));
    if (delivered.length > 0) deps.notices.remember(facts.approvalId, delivered);
  } catch (error) {
    deps.logger.logError('review.notice_not_edited', error, { reportId: facts.reportId });
  }
  const venue = facts.venue;
  if (locked || venue === null) return;
  const locale = deps.config.venueLocale;
  try {
    if (venue.statusMessageId !== null) {
      const view = statusCard(
        { id: facts.reportId, status: 'posted', platform: venue.platform, category: venue.category, reporterRef: venue.reporterRef },
        null,
        locale,
      );
      await editAfterCommit(deps, venue.statusMessageId, view);
    }
    if (venue.cardMessageId !== null) await deleteOrEdit(deps, venue.cardMessageId, outcomeCard({ id: facts.reportId, status: 'posted' }, locale));
  } catch (error) {
    deps.logger.logError('review.message_not_edited', error, { reportId: facts.reportId });
  }
}

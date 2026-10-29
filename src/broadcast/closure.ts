// @critical-path
// Closure (critical invariants 1, 2, 4, 5 and 8; the MVP plan, section 4,
// "Closure and retraction"; doc/product/report-lifecycle.md, posted to
// closing to closed or expired; doc/guides/admin-review-runbook.md,
// section 7): a posted report is closed as "taken down" or "closed without
// result" by an admin, with `/close <id> taken_down|no_result` in the venue
// or the status card's buttons (src/telegram/closing.ts, review.ts), or
// expired by the retention job 90 days after its post
// (src/privacy/retention.ts). Admins only: never under lockdown (the gates,
// and the closure's statement binds the switch), and no keyholder command.
// 1. The order, ONE batch (closeStatements): the conditional `posted` to
//    `closing` with the outcome, while the report holds its post's message
//    id under its live approval and the switch is not set (exactly one row
//    changes for the closure that wins); the `edit` job enqueued, due at
//    once (src/broadcast/jobs.ts; written only while the report is closing,
//    ON CONFLICT DO NOTHING keeping an existing one). Then, unless locked
//    down, the status card says the closure is under way, its buttons gone.
//    The expiry (expiryStatements) is the same transition for the posted
//    reports 90 days old, with the outcome `expired`, in the retention job's
//    batch. Nothing is sent to anyone: the edited post is the outcome.
// 2. The edit (closeEdit, an EDIT_HANDLERS entry, src/broadcast/edits.ts):
//    for a report closing, under its live approval, with its post's id and
//    its outcome, and while neither /halt nor the switch holds (the runner
//    takes no closure then; a hold set after the run read the state is read
//    again here, and the conclusion's statement binds it too): the post's
//    stored text, `broadcast_text`, with the outcome line appended in both
//    locales, Persian first (closedPostText()), after the check every
//    outgoing text gets (postProblems(): within Telegram's 4096 characters,
//    every tappable link on the lists); a text that fails is never sent:
//    the post is then replaced by the outcome lines alone (outcomeOnlyText()).
//    In practice the check fails on the length alone, a post too long once
//    the outcome lines are appended: the post's targets are code text, which
//    is not tappable and so not a link the check reads, whatever the
//    configuration says now. concludeEdit() (src/broadcast/concluding.ts)
//    makes the edit, removes the button, and on its success writes `closed`
//    (or `expired`) and finalizes in one batch. A report that holds no
//    approval record, no post id or no outcome is never edited: it is
//    flagged for a human, and the job's failure recorded.
// A job whose report is no longer closing is dropped.
import { isLockedDown, NOT_LOCKED_DOWN } from '../auth/lockdown';
import type { Config } from '../config/schema';
import { concatSql, placeholders, sql, type SqlStatement, type SqlValue } from '../db/sql';
import { AppError } from '../errors/app-error';
import { t, type MessageKey } from '../i18n/index';
import { isCloseOutcome, type CloseOutcome } from '../review/callbacks';
import { loadPress } from '../review/flow';
import { POST_DIVIDER, postProblems, sendable } from '../review/render-post';
import { checkedText, type Actor, type Pressed, type PressOutcome, type ReviewDeps } from '../review/venue';
import { dropStale, flagEdit, readEditTarget, showState, concludeEdit, type EditTarget } from './concluding';
import type { EditHandler } from './edits';
import { enqueueEditStatement } from './jobs';
import { venueFacts } from './post';

/** How a closing report concludes: an admin's outcome, or the 90-day expiry. */
export type ClosingOutcome = CloseOutcome | 'expired';

export const isClosingOutcome = (value: unknown): value is ClosingOutcome => value === 'expired' || isCloseOutcome(value);

/** The most posted reports one expiry batch takes: its statement binds every id once. */
export const EXPIRY_BATCH_LIMIT = 50;

const OUTCOME_LINE_KEYS = Object.freeze({
  taken_down: 'post.outcome.taken_down',
  no_result: 'post.outcome.no_result',
  expired: 'post.outcome.expired',
} as const satisfies Record<ClosingOutcome, MessageKey>);

const READ_ORDER = sql`SELECT status, platform, category, reporter_ref, card_message_id, status_message_id FROM reports WHERE id = ?`;
const CLOSE = concatSql(
  sql`UPDATE reports SET status = 'closing', outcome = ? WHERE id = ? AND status = 'posted' AND post_message_id IS NOT NULL AND EXISTS (SELECT 1 FROM approvals WHERE report_id = reports.id AND voided_at IS NULL) AND `,
  NOT_LOCKED_DOWN,
);
const EXPIRE = sql`UPDATE reports SET status = 'closing', outcome = 'expired' WHERE id IN (`;
const EXPIRE_TAIL = sql`) AND status = 'posted' AND posted_at <= ? AND post_message_id IS NOT NULL AND EXISTS (SELECT 1 FROM approvals WHERE report_id = reports.id AND voided_at IS NULL)`;

/** The outcome lines a closed post ends with, in both locales, Persian first. */
const outcomeLines = (outcome: ClosingOutcome): string =>
  `<b>${t('fa', OUTCOME_LINE_KEYS[outcome])}</b>\n<b>${t('en', OUTCOME_LINE_KEYS[outcome])}</b>`;

/** The closed post: the stored post, the divider, the outcome lines (see the header). */
export const closedPostText = (post: string, outcome: ClosingOutcome): string => `${post}\n\n${POST_DIVIDER}\n\n${outcomeLines(outcome)}`;

/** The outcome lines alone, which carry no link: the post's text when the closed post may not be sent. */
export const outcomeOnlyText = (outcome: ClosingOutcome): string => outcomeLines(outcome);

/** The text a closure edits the post to (see the header, step 2). Throws only for a text that may not be sent. */
export function closureText(config: Pick<Config, 'allowedLinkHosts'>, post: string | null, outcome: ClosingOutcome): string {
  if (post !== null) {
    const closed = closedPostText(post, outcome);
    if (sendable(postProblems(closed, config.allowedLinkHosts))) return closed;
  }
  return checkedText(config, outcomeOnlyText(outcome));
}

/** The index, in closeStatements(), of the status change: one row changed means the closure won. */
export const CLOSE_STATUS_STATEMENT = 0;

/** The closure's one batch (see the header, step 1). */
export function closeStatements(reportId: string, outcome: CloseOutcome, now: number, jobId?: string): SqlStatement[] {
  return [
    { sql: CLOSE, params: [outcome, reportId] },
    enqueueEditStatement({ reportId, status: 'closing', dueAt: now, now, ...(jobId === undefined ? {} : { jobId }) }),
  ];
}

/**
 * The expiry of the posted reports `reportIds` whose post is at or before
 * `cutoff`, at `now` (see the header, step 1): one batch's statements, none
 * for no report. Throws an AppError UNEXPECTED for more than
 * EXPIRY_BATCH_LIMIT reports.
 */
export function expiryStatements(reportIds: readonly string[], cutoff: number, now: number): SqlStatement[] {
  if (reportIds.length === 0) return [];
  if (reportIds.length > EXPIRY_BATCH_LIMIT) throw new AppError('UNEXPECTED', 'an expiry takes at most EXPIRY_BATCH_LIMIT reports');
  return [
    { sql: concatSql(EXPIRE, placeholders(reportIds.length), EXPIRE_TAIL), params: [...reportIds, cutoff] },
    ...reportIds.map((reportId) => enqueueEditStatement({ reportId, status: 'closing', dueAt: now, now })),
  ];
}

/** What a closure order did. */
export type ClosureOrder = 'closing' | 'not_found' | 'refused' | 'locked';

type OrderDeps = Pick<ReviewDeps, 'api' | 'config' | 'db' | 'clock' | 'logger'>;

interface OrderRow {
  readonly status: SqlValue;
  readonly platform: SqlValue;
  readonly category: SqlValue;
  readonly reporter_ref: SqlValue;
  readonly card_message_id: SqlValue;
  readonly status_message_id: SqlValue;
}

/**
 * Closes posted report `reportId` with `outcome` (see the header, step 1).
 * Throws only a storage failure.
 */
export async function orderClosure(deps: OrderDeps, reportId: string, outcome: CloseOutcome): Promise<ClosureOrder> {
  const row = await deps.db.first<OrderRow>(READ_ORDER, [reportId]);
  if (row === null || row.status === 'merged') return 'not_found';
  const results = await deps.db.batch(closeStatements(reportId, outcome, deps.clock.now()));
  if (results[CLOSE_STATUS_STATEMENT]?.changes !== 1) return (await isLockedDown(deps.config, deps.db)) ? 'locked' : 'refused';
  deps.logger.log('close.ordered', { reportId });
  await showState(deps, reportId, venueFacts(row), 'closing', 'closing');
  return 'closing';
}

/** A closure button on the status card, pressed by an admin (the gates checked who and where). */
export async function closeFromCard(deps: ReviewDeps, actor: Actor, reportId: string, outcome: CloseOutcome, pressed: Pressed): Promise<PressOutcome> {
  const loaded = await loadPress(deps, actor, reportId, pressed, { pendingOnly: false, statusCard: true });
  if (!loaded.ok) return loaded.outcome;
  switch (await orderClosure(deps, reportId, outcome)) {
    case 'closing':
      return { answer: t(actor.locale, 'review.answer.closing') };
    case 'locked':
      return { answer: t(actor.locale, 'admin.refused') };
    case 'not_found':
      return { answer: t(actor.locale, 'review.answer.gone') };
    case 'refused':
      return { answer: t(actor.locale, 'review.answer.close_refused') };
  }
}

/** Whether `target` may be edited as a closure: under its approval, with its post and its outcome (rule 1). */
const closable = (target: EditTarget): target is EditTarget & { readonly outcome: ClosingOutcome } =>
  target.approvalId !== null && target.postMessageId !== null && isClosingOutcome(target.outcome);

/** The closure's edit job (see the header, step 2). */
export const closeEdit: EditHandler = async (deps, job) => {
  const target = await readEditTarget(deps.db, job.reportId);
  if (target === null) return;
  if (target.status !== 'closing') {
    await dropStale(deps, job, 'closing');
    return;
  }
  // A hold set after the run read the state: nothing is edited, and nothing failed.
  if (deps.config.lockdown || target.held) return;
  if (!closable(target)) {
    await flagEdit(deps, target);
    throw new AppError('UNEXPECTED', 'a closure without its approval record, its post or its outcome');
  }
  await concludeEdit(deps, target, {
    conclusion: target.outcome === 'expired' ? { from: 'closing', to: 'expired' } : { from: 'closing', to: 'closed' },
    text: closureText(deps.config, target.broadcastText, target.outcome),
    deleteYoung: false,
    done: 'close.done',
    notice: null,
  });
};

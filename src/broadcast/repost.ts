// @critical-path
// /repost (critical invariants 1 and 2; the MVP plan, section 4, "The
// post"; doc/product/report-lifecycle.md, "Ambiguous and unambiguous
// failures"): after an ambiguous send, an admin who found NO post in the
// channel returns the report to approved, and the next run posts it. Admins
// only, in the venue, never under lockdown (the gates, and the statement
// binds the switch). Admitted only while the report has no message id, and
// only from:
// - `posting`, once its POSTING_WINDOW_MS is over: a posting row inside its
//   window is in progress, its send not answered yet (the run's client
//   gives up after SEND_TIMEOUT_SECONDS), and a /repost then could post it
//   twice;
// - `approved` with no post job: a 400 or 403, or a stored text the send's
//   check refused, abandoned the job.
// Never from `approved` with its job (an approval in its grace, or a post
// a 429 rescheduled), from a report with a message id, or under a voided
// approval. ONE batch: the status back to approved, `posting_started_at`
// cleared, the attention flags cleared; then the post job under the live
// approval's id, due at once, only when that statement changed its row (the
// job an ambiguous send left is kept: it carries that same approval). The
// status card then says the report goes out again. There is no blind "post
// again": the alert says to check the channel first.
import { NOT_LOCKED_DOWN } from '../auth/lockdown';
import { concatSql, sql, type SqlValue } from '../db/sql';
import { isId } from '../db/ids';
import { statusCard } from '../review/status-card';
import { editAfterCommit } from '../review/venue';
import { reenqueuePostStatement } from './jobs';
import { POSTING_WINDOW_MS, venueFacts, type PostDeps } from './post';

const REPOST = concatSql(
  sql`UPDATE reports SET status = 'approved', posting_started_at = NULL, needs_attention = 0, alert_sent_at = NULL WHERE id = ? AND post_message_id IS NULL AND ((status = 'posting' AND posting_started_at <= ?) OR (status = 'approved' AND NOT EXISTS (SELECT 1 FROM jobs WHERE kind = 'post' AND report_id = reports.id))) AND EXISTS (SELECT 1 FROM approvals WHERE report_id = reports.id AND voided_at IS NULL) AND `,
  NOT_LOCKED_DOWN,
);
const EXISTS = sql`SELECT id FROM reports WHERE id = ?`;
const CARD = sql`SELECT r.platform, r.category, r.reporter_ref, r.card_message_id, r.status_message_id, a.approval_id, a.starts_at FROM reports AS r JOIN approvals AS a ON a.report_id = r.id AND a.voided_at IS NULL WHERE r.id = ? AND r.status = 'approved'`;

/** The index, in repostStatements(), of the status change: one row changed means it was admitted. */
export const REPOST_STATUS_STATEMENT = 0;

/** What a /repost did. */
export type RepostOutcome = 'done' | 'not_found' | 'refused';

/** /repost's one batch (see the header). */
export const repostStatements = (reportId: string, now: number, jobId?: string) => [
  { sql: REPOST, params: [reportId, now - POSTING_WINDOW_MS] },
  reenqueuePostStatement({ reportId, now, ...(jobId === undefined ? {} : { jobId }) }),
];

/** The status card after a /repost: approved, going out again. Never throws. */
async function showReposted(deps: PostDeps, reportId: string): Promise<void> {
  try {
    const row = await deps.db.first<Record<string, SqlValue>>(CARD, [reportId]);
    if (row === null) return;
    const venue = venueFacts({
      platform: row.platform ?? null,
      category: row.category ?? null,
      reporter_ref: row.reporter_ref ?? null,
      card_message_id: row.card_message_id ?? null,
      status_message_id: row.status_message_id ?? null,
    });
    const approvalId = row.approval_id;
    const startsAt = row.starts_at;
    if (venue === null || venue.statusMessageId === null || !isId(approvalId) || typeof startsAt !== 'number') return;
    const view = statusCard(
      { id: reportId, status: 'approved', platform: venue.platform, category: venue.category, reporterRef: venue.reporterRef },
      { approvalId, startsAt, voidedAt: null },
      deps.config.venueLocale,
      undefined,
      'reposted',
    );
    await editAfterCommit(deps, venue.statusMessageId, view);
  } catch (error) {
    deps.logger.logError('review.message_not_edited', error, { reportId });
  }
}

/** Returns report `reportId` to approved for the next run (see the header). Throws only a storage failure. */
export async function repostReport(deps: PostDeps, reportId: string): Promise<RepostOutcome> {
  const results = await deps.db.batch(repostStatements(reportId, deps.clock.now()));
  if (results[REPOST_STATUS_STATEMENT]?.changes !== 1) return (await deps.db.first(EXISTS, [reportId])) === null ? 'not_found' : 'refused';
  deps.logger.log('repost.done', { reportId });
  await showReposted(deps, reportId);
  return 'done';
}

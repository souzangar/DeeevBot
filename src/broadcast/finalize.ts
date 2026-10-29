// @critical-path
// Finalization (critical invariants 1 and 8; the MVP plan, section 4,
// "Closure and retraction" and "Retention"; ADR 0004, "Finalization and
// the cap contract"; doc/product/retention-and-minimisation.md,
// "Finalization"): a report in a terminal status leaves only its aggregate
// row behind. finalizationStatements() is ONE batch's statements for a set
// of reports, every one of them bound to the reports being in one of the
// given terminal statuses and not finalized yet (`data_deleted_at` null), so
// no statement can reach a report that is open, or closing or retracting
// (its post unaddressed), and a second run changes nothing:
// 1. the aggregate row upserted in `stats`, from the report as it stands:
//    category, platform, the day of intake, the day of the decision (a
//    rejection's or a routing's, else the live approval's), the day of the
//    finalization, the outcome (the report's own, else its status: rejected,
//    routed), the presses and the keyed link hash. A report without a hash,
//    which the intake never writes, leaves no aggregate row rather than
//    failing the batch, which would keep its data;
// 2. its approval, its prompts and its jobs deleted;
// 3. the rows merged into it deleted, their links, references and hashes
//    with them;
// 4. every personal and content field of the report nulled (`url`,
//    `account_url`, `comment`, `affected_person`, `reporter_ref`,
//    `link_hash`, `decided_by`, `rejection_reason`, `broadcast_text`,
//    `correction_text`, `link_mode` and the three message ids), its outcome
//    kept (its status when it had none), `closed_at` set when it was not,
//    and `data_deleted_at` set.
// What remains of the row, its id and its state, is deleted by the next
// retention job (src/privacy/retention.ts), after which the aggregate row is
// the only one that holds the id.
// A posted report reaches its terminal status only through its edit job's
// success: concludeStatements() puts the conditional status change first
// (from closing or retracting, under its live approval and on its own post;
// a closure also not under /halt or the switch), then the finalization of
// that one report, in the same batch, so the terminal status and the
// finalization commit together or not at all. finalizeTerminal() is
// reconciliation's slot (src/broadcast/maintenance.ts) for a closed,
// retracted or expired row whose finalization never landed. The retention
// job finalizes the expired pending reports and the rejected and routed rows
// 30 days after their decision, putting rejectionDecayStatement() first for
// each rejected one: the rejection the report counted on its reporters'
// references (src/review/reject.ts) is counted off then, so `rejections_30d`
// holds the rejections of the last 30 days, as the intake's throttle reads
// it, and never goes below 0.
import { utcDay } from '../clock';
import { concatSql, placeholders, sql, type SqlDb, type SqlStatement, type SqlText } from '../db/sql';
import { AppError } from '../errors/app-error';
import type { ReportStatus } from '../review/reports';

/** The terminal statuses a report is finalized in. */
export const FINALIZED_STATUSES = ['closed', 'retracted', 'expired', 'rejected', 'routed'] as const satisfies readonly ReportStatus[];
export type FinalizedStatus = (typeof FINALIZED_STATUSES)[number];

/** A posted report's terminal statuses, written only by its edit job's success: reconciliation finalizes these alone. */
export const CONCLUDED_STATUSES = ['closed', 'retracted', 'expired'] as const satisfies readonly FinalizedStatus[];

/** The most reports one finalization batch takes: each statement binds every id once, under D1's 100 parameters. */
export const FINALIZE_BATCH_LIMIT = 50;

/** The index, in concludeStatements(), of the status change: one row changed means the report concluded. */
export const CONCLUDE_STATUS_STATEMENT = 0;

const UPSERT_STATS = sql`INSERT INTO stats (report_id, category, platform, created_day, decided_day, closed_day, outcome, presses, link_hash) SELECT r.id, r.category, r.platform, date(r.created_at / 1000, 'unixepoch'), date(COALESCE(r.decided_at, a.approved_at) / 1000, 'unixepoch'), ?, COALESCE(r.outcome, r.status), r.presses, r.link_hash FROM reports AS r LEFT JOIN approvals AS a ON a.report_id = r.id AND a.voided_at IS NULL WHERE r.id IN (`;
const UPSERT_STATS_TAIL = sql`) AND r.data_deleted_at IS NULL AND r.link_hash IS NOT NULL ON CONFLICT (report_id) DO UPDATE SET category = excluded.category, platform = excluded.platform, created_day = excluded.created_day, decided_day = excluded.decided_day, closed_day = excluded.closed_day, outcome = excluded.outcome, presses = excluded.presses, link_hash = excluded.link_hash`;
const DELETE_APPROVALS = sql`DELETE FROM approvals WHERE report_id IN (`;
const DELETE_PROMPTS = sql`DELETE FROM admin_prompts WHERE report_id IN (`;
const DELETE_JOBS = sql`DELETE FROM jobs WHERE report_id IN (`;
const DELETE_MERGED = sql`DELETE FROM reports WHERE merged_into IN (`;
const NULL_FIELDS = sql`UPDATE reports SET url = NULL, account_url = NULL, comment = NULL, affected_person = NULL, reporter_ref = NULL, link_hash = NULL, decided_by = NULL, rejection_reason = NULL, broadcast_text = NULL, correction_text = NULL, link_mode = NULL, card_message_id = NULL, status_message_id = NULL, post_message_id = NULL, outcome = COALESCE(outcome, status), closed_at = COALESCE(closed_at, ?), data_deleted_at = ? WHERE id IN (`;
const DECAY = sql`UPDATE reporter_stats SET rejections_30d = rejections_30d - 1 WHERE rejections_30d > 0 AND reporter_ref IN (SELECT reporter_ref FROM reports WHERE (id = ? OR merged_into = ?) AND reporter_ref IS NOT NULL) AND EXISTS (SELECT 1 FROM reports WHERE id = ? AND status = 'rejected' AND data_deleted_at IS NULL)`;
const CONCLUDE_CLOSING = sql`UPDATE reports SET status = ?, closed_at = ? WHERE id = ? AND status = 'closing' AND post_message_id = ? AND EXISTS (SELECT 1 FROM approvals WHERE report_id = reports.id AND voided_at IS NULL) AND NOT EXISTS (SELECT 1 FROM meta WHERE key IN ('lockdown', 'halted'))`;
const CONCLUDE_RETRACTING = sql`UPDATE reports SET status = 'retracted', closed_at = ? WHERE id = ? AND status = 'retracting' AND post_message_id = ? AND EXISTS (SELECT 1 FROM approvals WHERE report_id = reports.id AND voided_at IS NULL)`;

/** "AND status IN (...) AND data_deleted_at IS NULL", after an id list. */
const statusTail = (statuses: number): SqlText => concatSql(sql`) AND status IN (`, placeholders(statuses), sql`) AND data_deleted_at IS NULL`);

/** The reports of `ids` in one of the statuses and not finalized yet, as a subquery. */
const targets = (ids: number, statuses: number): SqlText => concatSql(sql`SELECT id FROM reports WHERE id IN (`, placeholders(ids), statusTail(statuses));

const isFinalizedStatus = (value: string): value is FinalizedStatus => (FINALIZED_STATUSES as readonly string[]).includes(value);

/**
 * The finalization of the reports `reportIds` that are in one of
 * `statuses` and not finalized yet, at `now`, as one batch's statements (see
 * the header); none for no report. Throws an AppError UNEXPECTED for more
 * than FINALIZE_BATCH_LIMIT reports, or no status.
 */
export function finalizationStatements(reportIds: readonly string[], now: number, statuses: readonly FinalizedStatus[]): SqlStatement[] {
  if (reportIds.length === 0) return [];
  if (reportIds.length > FINALIZE_BATCH_LIMIT || statuses.length === 0 || !statuses.every(isFinalizedStatus)) {
    throw new AppError('UNEXPECTED', 'a finalization takes 1 to FINALIZE_BATCH_LIMIT reports and terminal statuses');
  }
  const ids = reportIds.length;
  const scope = [...reportIds, ...statuses];
  const within = (head: SqlText): SqlStatement => ({ sql: concatSql(head, targets(ids, statuses.length), sql`)`), params: scope });
  return [
    { sql: concatSql(UPSERT_STATS, placeholders(ids), sql`) AND r.status IN (`, placeholders(statuses.length), UPSERT_STATS_TAIL), params: [utcDay(now), ...scope] },
    within(DELETE_APPROVALS),
    within(DELETE_PROMPTS),
    within(DELETE_JOBS),
    within(DELETE_MERGED),
    { sql: concatSql(NULL_FIELDS, placeholders(ids), statusTail(statuses.length)), params: [now, now, ...scope] },
  ];
}

/**
 * The rejection report `reportId` counted on its reporters' references,
 * counted off (see the header): for a rejected report not finalized yet,
 * put before its finalization, which nulls the references it reads.
 */
export const rejectionDecayStatement = (reportId: string): SqlStatement => ({ sql: DECAY, params: [reportId, reportId, reportId] });

/** How a posted report concludes: the state its edit job left, and the terminal status its success writes. */
export type Conclusion =
  | { readonly from: 'closing'; readonly to: 'closed' | 'expired' }
  | { readonly from: 'retracting'; readonly to: 'retracted' };

/**
 * The batch of an edit job's success (see the header): the conditional
 * status change of report `reportId`, on its own post `postMessageId`, then
 * its finalization.
 */
export function concludeStatements(input: Conclusion & { readonly reportId: string; readonly postMessageId: number; readonly now: number }): SqlStatement[] {
  const change: SqlStatement =
    input.from === 'closing'
      ? { sql: CONCLUDE_CLOSING, params: [input.to, input.now, input.reportId, input.postMessageId] }
      : { sql: CONCLUDE_RETRACTING, params: [input.now, input.reportId, input.postMessageId] };
  return [change, ...finalizationStatements([input.reportId], input.now, [input.to])];
}

/**
 * Reconciliation's finalization of report `reportId`, a closed, retracted or
 * expired row whose finalization never landed (see the header). True when
 * it was finalized now; false when there was nothing to finalize (open,
 * closing, retracting, rejected, routed, or finalized already). Throws only
 * a storage failure.
 */
export async function finalizeTerminal(deps: { readonly db: SqlDb }, reportId: string, now: number): Promise<boolean> {
  const results = await deps.db.batch(finalizationStatements([reportId], now, CONCLUDED_STATUSES));
  return results.at(-1)?.changes === 1;
}

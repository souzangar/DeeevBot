// @critical-path
// Reconciliation (critical invariants 1, 5 and 8; the MVP plan, section 4,
// "Reconciliation"; ADR 0004, "Scheduling"): a Worker function the run calls
// on every 15th minute (src/broadcast/tick.ts), never on a press or an
// update, so no press triggers a scan. In order, each step bounded:
// 1. Stuck posts, flagged `needs_attention` in one batch:
//    - a report still posting without a message id once its
//      POSTING_WINDOW_MS is over: a send whose record failed, or a run cut
//      between the send and the record (a posting row inside its window,
//      its job present, is in progress, not stuck);
//    - an approved report whose post job is overdue by OVERDUE_POST_MS, two
//      reconciliation periods, unless a hold explains it (the switch, /halt
//      and the pause bound in the statement; the LOCKDOWN override checked
//      first): two periods, so a queue of approvals that start together,
//      which the run posts one a minute, is never taken for a stall.
// 2. A report closing or retracting whose edit job is missing: the job
//    re-enqueued, generically, its action following the status
//    (src/broadcast/jobs.ts), for the closure and retraction unit's
//    handler. Nothing here ever finalizes a report whose post is
//    unaddressed.
// 3. A closed, retracted or expired report whose finalization never
//    landed (`data_deleted_at` null, which only a failed finalization batch
//    leaves): finalize() (src/broadcast/maintenance.ts). Rejected and
//    routed rows keep their data for 30 days by design, so they are not
//    this step's.
// 4. The alert: the open reports flagged `needs_attention` and not yet
//    alerted, at most ALERT_LIMIT, in ONE message to every keyholder in
//    both locales and, unless locked down, to the venue in its language;
//    they are marked alerted (`alert_sent_at`) once at least one keyholder
//    got it (one delivered of several suffices, as for the approval notice;
//    the misses are logged, `reconcile.alert_incomplete` with the counts),
//    so the next run names the reports after them, and an alert that
//    reached nobody is sent again by the next run. Each report is alerted
//    once, until /attach, /repost or a recorded post clears its flags.
// There are no pending decision notices: no reporter is ever messaged.
// Under lockdown every step runs, the alert to the keyholders only. A
// storage failure stops the run (the caller's rule); a finalization or an
// alert that fails otherwise is logged by class and the next run retries.
import { sql, type SqlValue } from '../db/sql';
import { isId } from '../db/ids';
import { t, type Locale } from '../i18n/index';
import { STATUS_NAME_KEYS } from '../review/names';
import { isReportStatus, type ReportStatus } from '../review/reports';
import { EDIT_ACTION_OF, enqueueEditStatement, type EditingStatus } from './jobs';
import { finalize as finalizeReport } from './maintenance';
import { POSTING_WINDOW_MS } from './post';
import { alertEveryone, markAlerted } from './report-alerts';
import { isStorageFailure, type TickState } from './state';
import type { TickDeps } from './tick';

/** How often the run reconciles, in minutes: every 15th minute of the hour. */
export const RECONCILE_EVERY_MINUTES = 15;
/** How overdue an approved report's post job must be to be alerted: two reconciliation periods. */
export const OVERDUE_POST_MS = 2 * RECONCILE_EVERY_MINUTES * 60_000;
/** The most missing edit jobs one run re-enqueues, finalizations it calls, reports one alert names. */
export const REENQUEUE_LIMIT = 10;
export const FINALIZE_LIMIT = 5;
export const ALERT_LIMIT = 5;

const FLAG_STUCK = sql`UPDATE reports SET needs_attention = 1 WHERE status = 'posting' AND post_message_id IS NULL AND needs_attention = 0 AND posting_started_at <= ?`;
const FLAG_OVERDUE = sql`UPDATE reports SET needs_attention = 1 WHERE status = 'approved' AND needs_attention = 0 AND EXISTS (SELECT 1 FROM jobs WHERE kind = 'post' AND report_id = reports.id AND due_at <= ?) AND NOT EXISTS (SELECT 1 FROM meta WHERE key IN ('lockdown', 'halted')) AND NOT EXISTS (SELECT 1 FROM meta WHERE key = 'paused_until' AND value > ?)`;
const MISSING_EDITS = sql`SELECT id, status FROM reports WHERE status IN ('closing', 'retracting') AND NOT EXISTS (SELECT 1 FROM jobs WHERE kind = 'edit' AND report_id = reports.id) ORDER BY id LIMIT ?`;
const UNFINALIZED = sql`SELECT id FROM reports WHERE status IN ('closed', 'retracted', 'expired') AND data_deleted_at IS NULL ORDER BY id LIMIT ?`;
const TO_ALERT = sql`SELECT id, status FROM reports WHERE status IN ('approved', 'posting', 'posted', 'closing', 'retracting') AND needs_attention = 1 AND alert_sent_at IS NULL ORDER BY id LIMIT ?`;

/** What one reconciliation did. */
export interface ReconcileRun {
  readonly flagged: number;
  readonly reenqueued: number;
  readonly finalized: number;
  /** The reports the alert named, and whether at least one keyholder got it (which marks them). */
  readonly alerted: number;
  readonly delivered: boolean;
}

interface StatusRow {
  readonly id: SqlValue;
  readonly status: SqlValue;
}

const isEditingStatus = (value: unknown): value is EditingStatus => typeof value === 'string' && Object.hasOwn(EDIT_ACTION_OF, value);

/** One report's line of the alert. */
function attentionLine(locale: Locale, id: string, status: ReportStatus): string {
  switch (status) {
    case 'posting':
      return t(locale, 'alert.attention.posting', { id });
    case 'approved':
      return t(locale, 'alert.attention.approved', { id });
    case 'closing':
    case 'retracting':
      return t(locale, 'alert.attention.edit', { id, state: t(locale, STATUS_NAME_KEYS[status]) });
    default:
      return t(locale, 'alert.attention.other', { id, state: t(locale, STATUS_NAME_KEYS[status]) });
  }
}

/** The alert naming `reports` in `locale`: a heading, then one line each. */
export function attentionText(locale: Locale, reports: readonly { readonly id: string; readonly status: ReportStatus }[]): string {
  return [t(locale, 'alert.attention.title'), ...reports.map((report) => attentionLine(locale, report.id, report.status))].join('\n');
}

/** Reconciles (see the header). Throws only a storage failure. */
export async function reconcile(deps: TickDeps, now: number, state: TickState): Promise<ReconcileRun> {
  // 1. Stuck posts.
  const flags = await deps.db.batch([
    { sql: FLAG_STUCK, params: [now - POSTING_WINDOW_MS] },
    ...(deps.config.lockdown ? [] : [{ sql: FLAG_OVERDUE, params: [now - OVERDUE_POST_MS, now] }]),
  ]);
  const flagged = flags.reduce((sum, result) => sum + result.changes, 0);

  // 2. Missing edit jobs.
  const missing = (await deps.db.all<StatusRow>(MISSING_EDITS, [REENQUEUE_LIMIT])).flatMap((row) =>
    isId(row.id) && isEditingStatus(row.status) ? [{ id: row.id, status: row.status }] : [],
  );
  let reenqueued = 0;
  if (missing.length > 0) {
    const results = await deps.db.batch(missing.map((row) => enqueueEditStatement({ reportId: row.id, status: row.status, dueAt: now, now })));
    reenqueued = results.reduce((sum, result) => sum + result.changes, 0);
    if (reenqueued > 0) deps.logger.log('reconcile.reenqueued', { count: reenqueued });
  }

  // 3. Terminal rows whose finalization never landed.
  const finalize = deps.hooks?.finalize ?? finalizeReport;
  let finalized = 0;
  for (const row of await deps.db.all<{ id: SqlValue }>(UNFINALIZED, [FINALIZE_LIMIT])) {
    if (!isId(row.id)) continue;
    try {
      await finalize(deps, row.id, now);
      finalized += 1;
    } catch (error) {
      if (isStorageFailure(error)) throw error;
      deps.logger.logError('finalize.failed', error, { reportId: row.id });
    }
  }

  // 4. The alert.
  const reports = (await deps.db.all<StatusRow>(TO_ALERT, [ALERT_LIMIT])).flatMap((row) =>
    isId(row.id) && isReportStatus(row.status) ? [{ id: row.id, status: row.status }] : [],
  );
  if (reports.length === 0) return { flagged, reenqueued, finalized, alerted: 0, delivered: false };
  let delivered = false;
  try {
    const outcome = await alertEveryone(deps, (locale) => attentionText(locale, reports), !state.locked);
    delivered = outcome.sent > 0;
    deps.logger.log(outcome.failed === 0 ? 'reconcile.alerted' : 'reconcile.alert_incomplete', { count: reports.length, sent: outcome.sent, failed: outcome.failed });
  } catch (error) {
    if (isStorageFailure(error)) throw error;
    deps.logger.logError('alert.failed', error);
  }
  if (delivered) await markAlerted(deps.db, reports.map((report) => report.id), now);
  return { flagged, reenqueued, finalized, alerted: reports.length, delivered };
}

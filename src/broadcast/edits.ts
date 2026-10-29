// @critical-path
// The edit jobs a run drains after its post (critical invariants 1, 2 and
// 5; the MVP plan, section 4, "Closure and retraction"; ADR 0004): one
// `edit` job per report, its payload naming the action its handler takes,
// `{"action": "close"}` (a closure, the 90-day expiry included: the outcome
// is on the report) or `{"action": "retract"}` (the correction is on the
// report), src/broadcast/jobs.ts. The handlers are the closure and
// retraction unit's (U6), registered by action in EDIT_HANDLERS: closeEdit
// (src/broadcast/closure.ts) and retractEdit (src/broadcast/retraction.ts),
// both concluding through src/broadcast/concluding.ts; this runner owns the
// policy around them, so no handler can run where it must not:
// - at most EDIT_JOBS_PER_TICK due jobs a run, the oldest first, and only
//   of an action that has a handler (a job of another action of
//   EDIT_ACTIONS waits for its handler, and holds back none);
// - a due job whose row it cannot read (an action outside EDIT_ACTIONS, or
//   none, a value outside its type) is never run and never left silent: it
//   is logged by class (`edit.unreadable`, with the report), its report is
//   flagged `needs_attention`, which reconciliation alerts, and the failure
//   is recorded on the job like any other, so it comes back after the
//   back-off until the retention job abandons it;
// - under lockdown or /halt only a retraction runs, since it removes harm
//   (RUN_WHEN_HELD); the run calls none while the global pause lies ahead,
//   nor after its own post met a 429;
// - a handler that throws records the failure on its own job, attempts + 1
//   and due again after a back-off, and the run goes on to the next job
//   ("a job failure is recorded on its job and never aborts the tick"),
//   except for two classes: a 429 moves the job and the global pause to
//   now + retry_after and ends the run's edits; a storage failure stops
//   the run without another write.
// A handler writes its own success (the terminal status and the
// finalization, one batch), and its own permanent failure (needs
// attention, the alert, the job left for its bound); like the post's claim
// it binds the lockdown switch and /halt in its own statements, which see
// a hold set after the run read the state.
import { concatSql, placeholders, sql, type SqlValue } from '../db/sql';
import { isId } from '../db/ids';
import { AppError } from '../errors/app-error';
import { ErrorCode, type CatalogEntry } from '../errors/catalog';
import { classifyTelegramError } from '../telegram/errors';
import { closeEdit } from './closure';
import { EDIT_ACTIONS, isEditAction, type EditAction } from './jobs';
import { DEFAULT_RETRY_AFTER_SECONDS } from './post';
import { retractEdit } from './retraction';
import { isStorageFailure, pauseStatement, type TickState } from './state';
import type { TickDeps } from './tick';

/** The most edit jobs one run takes. */
export const EDIT_JOBS_PER_TICK = 3;

/** The actions that run under lockdown and under /halt: a retraction removes harm. */
export const RUN_WHEN_HELD: readonly EditAction[] = Object.freeze(['retract']);

/** The back-off after a failed edit, per attempt, and its bound. */
export const EDIT_RETRY_MS = 60_000;
export const EDIT_RETRY_MAX_MS = 15 * 60_000;

const backoff = (attempts: number): number => Math.min(EDIT_RETRY_MS * (attempts + 1), EDIT_RETRY_MAX_MS);

/** A due edit job, as its handler gets it. */
export interface EditJob {
  readonly id: string;
  readonly reportId: string;
  readonly action: EditAction;
  readonly dueAt: number;
  readonly attempts: number;
}

/**
 * An edit job's handler (see the header): it edits the post, writes the
 * outcome, and throws when the job failed.
 */
export type EditHandler = (deps: TickDeps, job: EditJob, now: number) => Promise<void>;

/** The handlers by action. */
export type EditHandlers = Readonly<Partial<Record<EditAction, EditHandler>>>;

/** The handlers by action (see the header): a closure, the 90-day expiry included, and a retraction. */
export const EDIT_HANDLERS: EditHandlers = Object.freeze({ close: closeEdit, retract: retractEdit });

const RECORD_FAILURE = sql`UPDATE jobs SET attempts = attempts + 1, due_at = ? WHERE id = ?`;
const FLAG_REPORT = sql`UPDATE reports SET needs_attention = 1 WHERE id = ?`;

/**
 * The due edit jobs a run takes: those of the runnable actions, and every one
 * whose action is none of EDIT_ACTIONS (unreadable, see the header).
 */
const dueEdits = (runnable: number) =>
  concatSql(
    sql`SELECT id, report_id, due_at, attempts, json_extract(payload, '$.action') AS action FROM jobs WHERE kind = 'edit' AND due_at <= ? AND (`,
    ...(runnable > 0 ? [sql`json_extract(payload, '$.action') IN (`, placeholders(runnable), sql`) OR `] : []),
    sql`json_extract(payload, '$.action') IS NULL OR json_extract(payload, '$.action') NOT IN (`,
    placeholders(EDIT_ACTIONS.length),
    sql`)) ORDER BY due_at, id LIMIT ?`,
  );

interface EditRow {
  readonly id: SqlValue;
  readonly report_id: SqlValue;
  readonly due_at: SqlValue;
  readonly attempts: SqlValue;
  readonly action: SqlValue;
}

/** What the run's edits did. */
export interface EditRun {
  /** The jobs whose handler ran. */
  readonly ran: number;
  /** True when a handler met a 429, which paused every job send. */
  readonly rateLimited: boolean;
}

const toJob = (row: EditRow): EditJob | null => {
  const { id, report_id: reportId, due_at: dueAt, attempts, action } = row;
  if (!isId(id) || !isId(reportId) || typeof dueAt !== 'number' || typeof attempts !== 'number' || !isEditAction(action)) return null;
  return { id, reportId, action, dueAt, attempts };
};

/** The actions the run may take: those with a handler, a retraction alone while held. */
export function runnableActions(state: Pick<TickState, 'locked' | 'halted'>, handlers: EditHandlers): EditAction[] {
  const held = state.locked || state.halted;
  return EDIT_ACTIONS.filter((action) => handlers[action] !== undefined && (!held || RUN_WHEN_HELD.includes(action)));
}

/**
 * A due job whose row cannot be read (see the header): logged by class, its
 * report flagged, the failure recorded on the job, in one batch. Throws only
 * a storage failure.
 */
async function recordUnreadable(deps: TickDeps, row: EditRow): Promise<void> {
  const reportId = isId(row.report_id) ? row.report_id : null;
  deps.logger.logError(
    'edit.unreadable',
    new AppError('UNEXPECTED', 'an edit job holds a value outside its type'),
    reportId === null ? {} : { reportId },
  );
  const attempts = typeof row.attempts === 'number' ? row.attempts : 0;
  await deps.db.batch([
    ...(reportId === null ? [] : [{ sql: FLAG_REPORT, params: [reportId] }]),
    ...(isId(row.id) ? [{ sql: RECORD_FAILURE, params: [deps.clock.now() + backoff(attempts), row.id] }] : []),
  ]);
}

/**
 * Runs the due edit jobs (see the header). Throws only a storage failure,
 * which stops the run.
 */
export async function runEditJobs(deps: TickDeps, now: number, state: TickState, handlers: EditHandlers = EDIT_HANDLERS): Promise<EditRun> {
  const actions = runnableActions(state, handlers);
  const rows = await deps.db.all<EditRow>(dueEdits(actions.length), [now, ...actions, ...EDIT_ACTIONS, EDIT_JOBS_PER_TICK]);
  let ran = 0;
  for (const row of rows) {
    const job = toJob(row);
    if (job === null) {
      await recordUnreadable(deps, row);
      continue;
    }
    const handler = handlers[job.action];
    // A job of an action not runnable now: the query takes none, but a handler may be missing.
    if (handler === undefined || !actions.includes(job.action)) continue;
    ran += 1;
    try {
      await handler(deps, job, now);
    } catch (error) {
      if (isStorageFailure(error)) throw error;
      const failure = classifyTelegramError(error);
      const entry: CatalogEntry = ErrorCode[failure.code];
      const at = deps.clock.now();
      if (entry.retryable) {
        const waitMs = (failure.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS) * 1000;
        await deps.db.batch([{ sql: RECORD_FAILURE, params: [at + waitMs, job.id] }, pauseStatement(at + waitMs)]);
        deps.logger.logError('edit.rate_limited', error, { reportId: job.reportId, durationMs: waitMs });
        return { ran, rateLimited: true };
      }
      await deps.db.run(RECORD_FAILURE, [at + backoff(job.attempts), job.id]);
      deps.logger.logError('edit.failed', error, { reportId: job.reportId, attempts: job.attempts + 1 });
    }
  }
  return { ran, rateLimited: false };
}

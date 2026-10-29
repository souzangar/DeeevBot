// @critical-path
// The post job's enqueue (critical invariants 1 and 5; the MVP plan,
// sections 3 and 4; doc/architecture/adr-0004-storage-and-delivery-ledger.md).
// An approval enqueues ONE `post` job for its report, due at the approval's
// `starts_at` and carrying the random `approval_id` it was enqueued for in
// its payload, `{"approval_id": "..."}`: the scheduling unit's claim binds
// that id (with the lockdown, halt and pause state) in the one statement
// that moves the report to `posting`, so a job of a cancelled approval never
// posts under a re-approval, and a timestamp is never the key.
//
// The insert is the plan's INSERT OR IGNORE, written as its exact form for
// this table: `ON CONFLICT (kind, report_id) DO NOTHING`. An enqueue never
// resets an existing job of its kind and report, which keeps its payload,
// attempts and due time; and only that conflict is ignored: a row the
// schema refuses (a payload that is not a JSON object, an id of another
// shape) fails the statement, and the batch it is in rolls back, where
// INSERT OR IGNORE would drop the job without a word.
//
// It inserts nothing unless the report holds the un-voided approval of
// that id at that moment: no job is ever written for an approval that does
// not exist, or was voided. The approval's batch (src/review/approve.ts)
// takes the statement itself, so the approval and its job commit together
// or not at all; enqueuePost() runs it alone.
//
// /repost (src/broadcast/repost.ts) re-enqueues with
// reenqueuePostStatement(), the statement right after the one that returned
// the report to approved, in the same batch: it inserts only when that
// statement changed its row (SQLite's changes(), as the press counter and
// the intake's submit use it), under the report's live approval id, due at
// once; the job an ambiguous send left behind is kept as it is, and carries
// that same approval (nothing can void an approval while its report is
// posting).
//
// An `edit` job (the closure and retraction unit's, src/broadcast/edits.ts)
// carries the action its handler takes, `{"action": "close"}` (a closure,
// expiry included: the outcome is on the report) or `{"action":
// "retract"}` (the correction is on the report), and is enqueued only
// while the report is in the status that action belongs to (`closing` or
// `retracting`), the same ON CONFLICT DO NOTHING keeping an existing job.
import type { Clock } from '../clock';
import { randomId } from '../db/ids';
import { sql, type SqlDb, type SqlStatement } from '../db/sql';

/** The kind of the job that posts an approved report. */
export const POST_JOB = 'post';
/** The kind of the job that edits a posted report's post: its closure or its retraction. */
export const EDIT_JOB = 'edit';

/** What an edit job does, as its payload names it (see the header). */
export const EDIT_ACTIONS = ['close', 'retract'] as const;
export type EditAction = (typeof EDIT_ACTIONS)[number];

export const isEditAction = (value: unknown): value is EditAction =>
  typeof value === 'string' && (EDIT_ACTIONS as readonly string[]).includes(value);

/** The statuses an edit job belongs to, and the action each takes. */
export const EDIT_ACTION_OF = Object.freeze({ closing: 'close', retracting: 'retract' } as const satisfies Record<string, EditAction>);
export type EditingStatus = keyof typeof EDIT_ACTION_OF;

const ENQUEUE_POST = sql`INSERT INTO jobs (id, kind, report_id, due_at, payload, attempts, created_at) SELECT ?, 'post', ?, ?, json_object('approval_id', ?), 0, ? WHERE EXISTS (SELECT 1 FROM approvals WHERE report_id = ? AND approval_id = ? AND voided_at IS NULL) ON CONFLICT (kind, report_id) DO NOTHING`;
const REENQUEUE_POST = sql`INSERT INTO jobs (id, kind, report_id, due_at, payload, attempts, created_at) SELECT ?, 'post', a.report_id, ?, json_object('approval_id', a.approval_id), 0, ? FROM approvals AS a WHERE a.report_id = ? AND a.voided_at IS NULL AND changes() = 1 ON CONFLICT (kind, report_id) DO NOTHING`;
const ENQUEUE_EDIT = sql`INSERT INTO jobs (id, kind, report_id, due_at, payload, attempts, created_at) SELECT ?, 'edit', ?, ?, json_object('action', ?), 0, ? WHERE EXISTS (SELECT 1 FROM reports WHERE id = ? AND status = ?) ON CONFLICT (kind, report_id) DO NOTHING`;

/** What a post job is enqueued with. */
export interface PostJob {
  readonly reportId: string;
  /** The approval the job posts under: its claim binds this id. */
  readonly approvalId: string;
  /** The approval's start: the job is due then, never before. */
  readonly startsAt: number;
  /** The enqueue time, `jobs.created_at`. */
  readonly now: number;
  /** A fresh random id (src/db/ids.ts); drawn when absent. */
  readonly jobId?: string;
}

/** The enqueue of the header as one statement, for a batch. */
export function enqueuePostStatement(job: PostJob): SqlStatement {
  return {
    sql: ENQUEUE_POST,
    params: [job.jobId ?? randomId(), job.reportId, job.startsAt, job.approvalId, job.now, job.reportId, job.approvalId],
  };
}

/**
 * Enqueues the post job of report `reportId` under approval `approvalId`,
 * due at `startsAt` (see the header). True when a job was written; false
 * when the report already has one, or holds no un-voided approval of that
 * id.
 */
export async function enqueuePost(
  db: SqlDb,
  clock: Clock,
  reportId: string,
  approvalId: string,
  startsAt: number,
): Promise<boolean> {
  const statement = enqueuePostStatement({ reportId, approvalId, startsAt, now: clock.now() });
  return (await db.run(statement.sql, statement.params)).changes === 1;
}

/**
 * /repost's job (see the header): the statement to put right after the one
 * that returned report `reportId` to approved, in the same batch.
 */
export function reenqueuePostStatement(input: { readonly reportId: string; readonly now: number; readonly jobId?: string }): SqlStatement {
  return { sql: REENQUEUE_POST, params: [input.jobId ?? randomId(), input.now, input.now, input.reportId] };
}

/** What an edit job is enqueued with. */
export interface EditJobInput {
  readonly reportId: string;
  /** The status the report is in: the job is written only while it still is. */
  readonly status: EditingStatus;
  readonly dueAt: number;
  readonly now: number;
  /** A fresh random id (src/db/ids.ts); drawn when absent. */
  readonly jobId?: string;
}

/** The edit job of a report in `closing` or `retracting`, as one statement (see the header). */
export function enqueueEditStatement(job: EditJobInput): SqlStatement {
  return {
    sql: ENQUEUE_EDIT,
    params: [job.jobId ?? randomId(), job.reportId, job.dueAt, EDIT_ACTION_OF[job.status], job.now, job.reportId, job.status],
  };
}

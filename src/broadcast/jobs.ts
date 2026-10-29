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
// or not at all; enqueuePost() runs it alone, for the scheduling unit's
// /repost.
import type { Clock } from '../clock';
import { randomId } from '../db/ids';
import { sql, type SqlDb, type SqlStatement } from '../db/sql';

/** The kind of the job that posts an approved report. */
export const POST_JOB = 'post';

const ENQUEUE_POST = sql`INSERT INTO jobs (id, kind, report_id, due_at, payload, attempts, created_at) SELECT ?, 'post', ?, ?, json_object('approval_id', ?), 0, ? WHERE EXISTS (SELECT 1 FROM approvals WHERE report_id = ? AND approval_id = ? AND voided_at IS NULL) ON CONFLICT (kind, report_id) DO NOTHING`;

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

// Unit tests for the job statements (src/broadcast/jobs.ts; critical
// invariant 1), on node:sqlite with the D1 migrations: one `post` job per
// report, due at the approval's start, carrying its approval id; never
// written for an approval that does not exist or was voided; an existing
// job kept as it was; a row the schema refuses failing, never dropped;
// /repost's re-enqueue only after the statement before it changed its row,
// under the live approval; and an edit job only while its report is in the
// status its action belongs to.
import { describe, expect, it } from 'vitest';
import { fakeClock } from '../../test/fakes/clock';
import { migratedDatabase } from '../../test/support/database';
import { insertApproval, insertReport } from '../../test/support/review-rows';
import { randomId } from '../db/ids';
import { sql } from '../db/sql';
import { EDIT_ACTION_OF, enqueueEditStatement, enqueuePost, enqueuePostStatement, isEditAction, POST_JOB, reenqueuePostStatement } from './jobs';

const NOW = 1_800_000_000_000;

const setup = () => {
  const clock = fakeClock(NOW);
  return { clock, ...migratedDatabase(clock) };
};

const jobs = (db: ReturnType<typeof setup>['db']) =>
  db.all(sql`SELECT kind, report_id, due_at, payload, attempts, created_at FROM jobs ORDER BY created_at`);

describe('enqueuePost', () => {
  it('writes one post job, due at the start, carrying the approval id', async () => {
    const { db, clock } = setup();
    const reportId = await insertReport(db);
    const approvalId = await insertApproval(db, reportId, { approvedAt: NOW, startsAt: NOW + 1_800_000 });
    expect(await enqueuePost(db, clock, reportId, approvalId, NOW + 1_800_000)).toBe(true);
    expect(await jobs(db)).toEqual([
      { kind: POST_JOB, report_id: reportId, due_at: NOW + 1_800_000, payload: JSON.stringify({ approval_id: approvalId }), attempts: 0, created_at: NOW },
    ]);
  });

  it('writes nothing for an approval that does not exist, is another one, or was voided', async () => {
    const { db, clock } = setup();
    const reportId = await insertReport(db);
    expect(await enqueuePost(db, clock, reportId, randomId(), NOW)).toBe(false);
    const voided = await insertApproval(db, reportId, { voidedAt: NOW - 1 });
    expect(await enqueuePost(db, clock, reportId, voided, NOW)).toBe(false);
    expect(await enqueuePost(db, clock, reportId, randomId(), NOW)).toBe(false);
    expect(await jobs(db)).toEqual([]);
  });

  it('never resets an existing job of the report: it keeps its payload, attempts and due time', async () => {
    const { db, clock } = setup();
    const reportId = await insertReport(db);
    const approvalId = await insertApproval(db, reportId);
    await enqueuePost(db, clock, reportId, approvalId, NOW + 10);
    await db.run(sql`UPDATE jobs SET attempts = 3`);
    clock.advance(5);
    expect(await enqueuePost(db, clock, reportId, approvalId, NOW + 99)).toBe(false);
    expect(await jobs(db)).toEqual([
      { kind: 'post', report_id: reportId, due_at: NOW + 10, payload: JSON.stringify({ approval_id: approvalId }), attempts: 3, created_at: NOW },
    ]);
  });

  it('fails, rather than drops, a job the schema refuses', async () => {
    const { db } = setup();
    const reportId = await insertReport(db);
    const approvalId = await insertApproval(db, reportId);
    const statement = enqueuePostStatement({ jobId: 'not-an-id', reportId, approvalId, startsAt: NOW, now: NOW });
    await expect(db.run(statement.sql, statement.params)).rejects.toMatchObject({ code: 'STORAGE_FAILURE' });
  });
});

describe('reenqueuePostStatement', () => {
  const SET_APPROVED = sql`UPDATE reports SET status = 'approved' WHERE id = ? AND status = 'pending'`;

  it('writes the job, due at once, under the live approval, only after the statement before it changed its row', async () => {
    const { db } = setup();
    const reportId = await insertReport(db);
    const approvalId = await insertApproval(db, reportId);
    await db.batch([{ sql: SET_APPROVED, params: [reportId] }, reenqueuePostStatement({ reportId, now: NOW })]);
    expect(await jobs(db)).toEqual([
      { kind: 'post', report_id: reportId, due_at: NOW, payload: JSON.stringify({ approval_id: approvalId }), attempts: 0, created_at: NOW },
    ]);
  });

  it('writes nothing when the statement before it changed no row', async () => {
    const { db } = setup();
    const reportId = await insertReport(db, { status: 'rejected' });
    await insertApproval(db, reportId);
    await db.batch([{ sql: SET_APPROVED, params: [reportId] }, reenqueuePostStatement({ reportId, now: NOW })]);
    expect(await jobs(db)).toEqual([]);
  });

  it('writes nothing under a voided approval, and keeps an existing job as it is', async () => {
    const { db, clock } = setup();
    const voided = await insertReport(db);
    await insertApproval(db, voided, { voidedAt: NOW - 1 });
    await db.batch([{ sql: sql`UPDATE reports SET comment = NULL WHERE id = ?`, params: [voided] }, reenqueuePostStatement({ reportId: voided, now: NOW })]);
    expect(await jobs(db)).toEqual([]);
    const reportId = await insertReport(db);
    const approvalId = await insertApproval(db, reportId);
    await enqueuePost(db, clock, reportId, approvalId, NOW - 5);
    await db.run(sql`UPDATE jobs SET attempts = 2`);
    await db.batch([{ sql: SET_APPROVED, params: [reportId] }, reenqueuePostStatement({ reportId, now: NOW })]);
    expect(await jobs(db)).toEqual([
      { kind: 'post', report_id: reportId, due_at: NOW - 5, payload: JSON.stringify({ approval_id: approvalId }), attempts: 2, created_at: NOW },
    ]);
  });
});

describe('enqueueEditStatement', () => {
  it('writes an edit job whose action follows the status, due when asked', async () => {
    const { db } = setup();
    for (const status of ['closing', 'retracting'] as const) {
      const reportId = await insertReport(db, { status });
      await db.run(enqueueEditStatement({ reportId, status, dueAt: NOW + 1, now: NOW }).sql, enqueueEditStatement({ reportId, status, dueAt: NOW + 1, now: NOW }).params);
      expect(await db.all(sql`SELECT kind, due_at, json_extract(payload, '$.action') AS action FROM jobs WHERE report_id = ?`, [reportId])).toEqual([
        { kind: 'edit', due_at: NOW + 1, action: EDIT_ACTION_OF[status] },
      ]);
    }
    expect(EDIT_ACTION_OF).toEqual({ closing: 'close', retracting: 'retract' });
    expect([isEditAction('close'), isEditAction('retract'), isEditAction('post'), isEditAction(undefined)]).toEqual([true, true, false, false]);
  });

  it('writes nothing once the report has left that status, and keeps an existing job', async () => {
    const { db } = setup();
    const moved = await insertReport(db, { status: 'closed' });
    const statement = enqueueEditStatement({ reportId: moved, status: 'closing', dueAt: NOW, now: NOW });
    expect((await db.run(statement.sql, statement.params)).changes).toBe(0);
    const reportId = await insertReport(db, { status: 'retracting' });
    const first = enqueueEditStatement({ reportId, status: 'retracting', dueAt: NOW, now: NOW });
    await db.run(first.sql, first.params);
    await db.run(sql`UPDATE jobs SET attempts = 4 WHERE report_id = ?`, [reportId]);
    const again = enqueueEditStatement({ reportId, status: 'retracting', dueAt: NOW + 9, now: NOW + 9 });
    expect((await db.run(again.sql, again.params)).changes).toBe(0);
    expect(await db.all(sql`SELECT due_at, attempts FROM jobs WHERE report_id = ?`, [reportId])).toEqual([{ due_at: NOW, attempts: 4 }]);
  });
});

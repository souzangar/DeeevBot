// Unit tests for the post job's enqueue (src/broadcast/jobs.ts; critical
// invariant 1), on node:sqlite with the D1 migrations: one `post` job per
// report, due at the approval's start, carrying its approval id; never
// written for an approval that does not exist or was voided; an existing
// job kept as it was; and a row the schema refuses failing, never dropped.
import { describe, expect, it } from 'vitest';
import { fakeClock } from '../../test/fakes/clock';
import { migratedDatabase } from '../../test/support/database';
import { insertApproval, insertReport } from '../../test/support/review-rows';
import { randomId } from '../db/ids';
import { sql } from '../db/sql';
import { enqueuePost, enqueuePostStatement, POST_JOB } from './jobs';

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

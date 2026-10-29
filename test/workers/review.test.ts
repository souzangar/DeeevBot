// Workers tier: the review's batches on the local D1 that miniflare runs
// (src/review/approve.ts, cancel.ts, reject.ts, route.ts and
// src/broadcast/jobs.ts over src/db/d1.ts), as the unit tier checks them on
// node:sqlite: the approval's upsert over a SELECT and the post job's
// `ON CONFLICT DO NOTHING`, the status change bound to the approval id
// under the schema's trigger, the Cancel, a re-approval under a new id, the
// rejection's counters and the routing's nulls. Ids and references are
// unique to this file, so it shares the database with the other files.
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { d1SqlDb } from '../../src/db/d1';
import { sql } from '../../src/db/sql';
import { writeApproval, type ApprovalInput } from '../../src/review/approve';
import { writeCancel } from '../../src/review/cancel';
import { rejectStatements, REJECT_STATUS_STATEMENT } from '../../src/review/reject';
import { routeStatements, ROUTE_STATUS_STATEMENT } from '../../src/review/route';

const db = d1SqlDb(env.DB);
const NOW = Date.UTC(2031, 6, 1, 12, 0, 0);
const ADMIN = 424240011;
/** A 20-letter id: `name` padded with q. */
const id = (name: string): string => name.padEnd(20, 'q');
const ref = (n: number): string => `${'b'.repeat(56)}${n.toString(16).padStart(8, '0')}`;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const report = async (reportId: string, fields: { readonly status?: string; readonly mergedInto?: string; readonly reporterRef?: string } = {}) => {
  await db.run(
    sql`INSERT INTO reports (id, status, platform, category, url, account_url, comment, affected_person, reporter_ref, merged_into, created_at) VALUES (?, ?, 'x', 'harassment', 'https://x.com/someone/status/1', 'https://x.com/someone', 'a comment', 1, ?, ?, ?)`,
    [reportId, fields.status ?? 'pending', fields.reporterRef ?? ref(1), fields.mergedInto ?? null, NOW],
  );
};

const approval = (reportId: string, approvalId: string, jobId: string): ApprovalInput => ({
  reportId,
  approvalId,
  jobId,
  adminId: ADMIN,
  category: 'harassment',
  linkMode: 'account',
  recommendedComment: 'say it',
  broadcastText: 'the post',
  now: NOW,
  startsAt: NOW + 1_800_000,
  prompt: { chatId: -1004242400041, promptMessageId: 1 },
});

describe('the review batches on D1', () => {
  it('approve, cancel and re-approve under a new approval id, the post job following each', async () => {
    const reportId = id('workersapprove');
    await report(reportId);
    await report(id('workersmerged'), { status: 'merged', mergedInto: reportId });
    expect(await writeApproval({ db }, approval(reportId, id('workersfirst'), id('workersjobone')))).toBe(true);
    expect(await db.first(sql`SELECT status, comment, affected_person, broadcast_text FROM reports WHERE id = ?`, [reportId])).toEqual({
      status: 'approved',
      comment: null,
      affected_person: null,
      broadcast_text: 'the post',
    });
    expect(await db.first(sql`SELECT comment, affected_person FROM reports WHERE id = ?`, [id('workersmerged')])).toEqual({ comment: null, affected_person: null });
    expect(await db.all(sql`SELECT kind, due_at, json_extract(payload, '$.approval_id') AS approval_id FROM jobs WHERE report_id = ?`, [reportId])).toEqual([
      { kind: 'post', due_at: NOW + 1_800_000, approval_id: id('workersfirst') },
    ]);
    // A second approval of the same report loses: it is approved already.
    expect(await writeApproval({ db }, approval(reportId, id('workerssecond'), id('workersjobtwo')))).toBe(false);
    expect(await writeCancel({ db }, reportId, id('workersfirst'), NOW + 1)).toBe(true);
    expect(await db.all(sql`SELECT * FROM jobs WHERE report_id = ?`, [reportId])).toEqual([]);
    expect(await writeApproval({ db }, approval(reportId, id('workersthird'), id('workersjobthree')))).toBe(true);
    expect(await db.all(sql`SELECT approval_id, voided_at FROM approvals WHERE report_id = ?`, [reportId])).toEqual([
      { approval_id: id('workersthird'), voided_at: null },
    ]);
    expect(await db.all(sql`SELECT json_extract(payload, '$.approval_id') AS approval_id FROM jobs WHERE report_id = ?`, [reportId])).toEqual([
      { approval_id: id('workersthird') },
    ]);
    // The stale Cancel of the first approval cancels nothing now.
    expect(await writeCancel({ db }, reportId, id('workersfirst'), NOW + 2)).toBe(false);
  });

  it('reject once, counting each reference of the target once', async () => {
    const reportId = id('workersreject');
    await report(reportId, { reporterRef: ref(7) });
    await report(id('workersrejectmerged'), { status: 'merged', mergedInto: reportId, reporterRef: ref(8) });
    for (const n of [7, 8]) {
      await db.run(sql`INSERT INTO reporter_stats (reporter_ref, last_seen) VALUES (?, '2031-07-01')`, [ref(n)]);
    }
    const first = await db.batch(rejectStatements(reportId, 'no_violation', ADMIN, NOW));
    const second = await db.batch(rejectStatements(reportId, 'other', ADMIN, NOW));
    expect([first[REJECT_STATUS_STATEMENT]?.changes, second[REJECT_STATUS_STATEMENT]?.changes]).toEqual([1, 0]);
    expect(await db.all(sql`SELECT rejections_30d FROM reporter_stats WHERE reporter_ref IN (?, ?) ORDER BY reporter_ref`, [ref(7), ref(8)])).toEqual([
      { rejections_30d: 1 },
      { rejections_30d: 1 },
    ]);
  });

  it('route, nulling the links of the report and its merged rows together', async () => {
    const reportId = id('workersroute');
    await report(reportId);
    await report(id('workersroutemerged'), { status: 'merged', mergedInto: reportId });
    const results = await db.batch(routeStatements(reportId, ADMIN, NOW));
    expect(results[ROUTE_STATUS_STATEMENT]?.changes).toBe(1);
    expect(await db.all(sql`SELECT status, url, account_url, comment, affected_person FROM reports WHERE id IN (?, ?) ORDER BY id DESC`, [reportId, id('workersroutemerged')])).toEqual([
      { status: 'routed', url: null, account_url: null, comment: null, affected_person: null },
      { status: 'merged', url: null, account_url: null, comment: null, affected_person: null },
    ]);
  });
});

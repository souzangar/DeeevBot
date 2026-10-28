// Always-run invariant spec, critical invariant 1: no message about a report
// reaches the broadcast audience without a recorded approval (the approving
// admin's numeric id, the time, the start time), and the report is never
// posted before the start time. At the schema level (migrations/0001_init.sql,
// on node:sqlite):
// - an approval row cannot exist without its report, its random approval
//   id (unique), the admin's numeric id, its time and its start;
// - an approval cannot start before it was given;
// - a report's status cannot be set to approved or posting while it has no
//   un-voided approval (the reports_need_approval trigger), and a batch that
//   writes the status before its approval rolls back whole;
// - the due query the post is gated on, "approved, not voided, starts_at
//   reached", returns neither a voided approval (Cancel within the grace)
//   nor one whose start is still ahead, nor one of a report that is no
//   longer approved;
// - a re-approval writes a new approval id, so a claim bound to the
//   cancelled approval's id claims nothing.
// The commit gate runs this file on every commit (`npm run test:invariants`).
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { randomId } from '../../src/db/ids';
import { migrate } from '../../src/db/migrate';
import { openNodeSqlite } from '../../src/db/node-sqlite';
import { sql, type SqlDb, type SqlText, type SqlValue } from '../../src/db/sql';
import { fakeClock } from '../fakes/clock';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url).href);
const NOW = 1_800_000_000_000;
const GRACE = 300_000;

const open = (): SqlDb => {
  const database = openNodeSqlite(':memory:');
  migrate(database.connection, MIGRATIONS_DIR, fakeClock(NOW));
  return database.db;
};

const DUE = sql`SELECT a.report_id FROM approvals AS a JOIN reports AS r ON r.id = a.report_id WHERE a.voided_at IS NULL AND a.starts_at <= ? AND r.status = 'approved' ORDER BY a.starts_at`;
const REPORT = sql`INSERT INTO reports (id, status, platform, category, created_at) VALUES (?, ?, 'instagram', 'harassment', ?)`;
const POSTED_REPORT = sql`INSERT INTO reports (id, status, platform, category, created_at, posting_started_at, posted_at) VALUES (?, 'posted', 'instagram', 'harassment', ?, ?, ?)`;
const APPROVAL = sql`INSERT INTO approvals (report_id, approval_id, admin_id, approved_at, link_mode, recommended_comment, starts_at, voided_at) VALUES (?, ?, ?, ?, 'account', 'say it is harassment', ?, ?)`;
const SET_STATUS = sql`UPDATE reports SET status = ? WHERE id = ?`;
const STATUS = sql`SELECT status FROM reports WHERE id = ?`;
/** A re-approval after Cancel: an upsert over the voided row, under a new approval id. */
const REAPPROVE = sql`INSERT INTO approvals (report_id, approval_id, admin_id, approved_at, link_mode, recommended_comment, starts_at, voided_at) VALUES (?, ?, ?, ?, 'account', 'say it is harassment', ?, NULL) ON CONFLICT (report_id) DO UPDATE SET approval_id = excluded.approval_id, admin_id = excluded.admin_id, approved_at = excluded.approved_at, link_mode = excluded.link_mode, recommended_comment = excluded.recommended_comment, starts_at = excluded.starts_at, voided_at = NULL`;
/**
 * The post job's claim as the MVP plan states it: one conditional update
 * bound to the approval id the job carries, the lockdown and halted keys and
 * the pause. The job's own code and tests land with the scheduling unit.
 */
const CLAIM = sql`UPDATE reports SET status = 'posting', posting_started_at = ? WHERE id = ? AND status = 'approved' AND EXISTS (SELECT 1 FROM approvals a WHERE a.report_id = reports.id AND a.voided_at IS NULL AND a.starts_at <= ? AND a.approval_id = ?) AND NOT EXISTS (SELECT 1 FROM meta WHERE key IN ('lockdown', 'halted')) AND NOT EXISTS (SELECT 1 FROM meta WHERE key = 'paused_until' AND value > ?)`;

const NEEDS_APPROVAL = /approved or posting only with an un-voided approval/;

/** Expects `attempt` to fail as a STORAGE_FAILURE whose driver error matches `failure`. */
const refused = async (attempt: Promise<unknown>, failure: RegExp, label: string): Promise<void> => {
  const caught: unknown = await attempt.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(caught, label).toMatchObject({ code: 'STORAGE_FAILURE' });
  expect(String((caught as { cause?: unknown }).cause), label).toMatch(failure);
};

const statusOf = async (db: SqlDb, reportId: string): Promise<SqlValue | undefined> =>
  (await db.first<{ status: SqlValue }>(STATUS, [reportId]))?.status;

describe('critical invariant 1: the approval record', () => {
  it('cannot exist without its report, its approval id, its admin id, its time or its start', async () => {
    const db = open();
    const refusals: [string, string | null, number | null, number | null, number | null, RegExp][] = [
      ['missingreportxxxxxxx', randomId(), 424242001, NOW, NOW + GRACE, /FOREIGN KEY constraint failed/],
      ['noapprovalidxxxxxxxx', null, 424242001, NOW, NOW + GRACE, /NOT NULL constraint failed/],
      ['shortapprovalidxxxxx', 'short', 424242001, NOW, NOW + GRACE, /CHECK constraint failed/],
      ['digitapprovalidxxxxx', `${randomId().slice(0, 19)}1`, 424242001, NOW, NOW + GRACE, /CHECK constraint failed/],
      ['anonymousapprovalxxx', randomId(), null, NOW, NOW + GRACE, /NOT NULL constraint failed/],
      ['untimedapprovalxxxxx', randomId(), 424242001, null, NOW + GRACE, /NOT NULL constraint failed/],
      ['unscheduledxxxxxxxxx', randomId(), 424242001, NOW, null, /NOT NULL constraint failed/],
    ];
    for (const [reportId] of refusals.slice(1)) await db.run(REPORT, [reportId, 'pending', NOW]);
    for (const [reportId, approvalId, adminId, approvedAt, startsAt, failure] of refusals) {
      await refused(db.run(APPROVAL, [reportId, approvalId, adminId, approvedAt, startsAt, null]), failure, reportId);
    }
    expect(await db.all(sql`SELECT count(*) AS n FROM approvals`)).toEqual([{ n: 0 }]);
  });

  it('never shares an approval id between two approvals', async () => {
    const db = open();
    const approvalId = randomId();
    await db.run(REPORT, ['firstapprovedxxxxxxx', 'pending', NOW]);
    await db.run(REPORT, ['secondapprovedxxxxxx', 'pending', NOW]);
    await db.run(APPROVAL, ['firstapprovedxxxxxxx', approvalId, 424242001, NOW, NOW + GRACE, null]);
    await refused(
      db.run(APPROVAL, ['secondapprovedxxxxxx', approvalId, 424242001, NOW, NOW + GRACE, null]),
      /UNIQUE constraint failed: approvals\.approval_id/,
      'a shared approval id',
    );
  });

  it('cannot start before it was given', async () => {
    const db = open();
    await db.run(REPORT, ['earlystartxxxxxxxxxx', 'pending', NOW]);
    await refused(
      db.run(APPROVAL, ['earlystartxxxxxxxxxx', randomId(), 424242001, NOW, NOW - 1, null]),
      /CHECK constraint failed/,
      'a start before the approval',
    );
  });

  it('gates the due query: never a voided approval, a future start, or a report no longer approved', async () => {
    const db = open();
    const add = async (reportId: string, status: string, startsAt: number, voidedAt: number | null): Promise<void> => {
      await (status === 'posted'
        ? db.run(POSTED_REPORT, [reportId, NOW - 2 * GRACE, startsAt, startsAt + 1])
        : db.run(REPORT, [reportId, status, NOW - 2 * GRACE]));
      await db.run(APPROVAL, [reportId, randomId(), 424242001, startsAt - GRACE, startsAt, voidedAt]);
    };
    await add('duereportxxxxxxxxxxx', 'approved', NOW, null);
    await add('cancelledxxxxxxxxxxx', 'pending', NOW - 10, NOW - 20);
    await add('voidedapprovedxxxxxx', 'approved', NOW - 10, NOW - 20);
    await add('stillingracexxxxxxxx', 'approved', NOW + 1, null);
    await add('rejectedafterxxxxxxx', 'rejected', NOW - 30, NOW - 40);
    await add('alreadypostedxxxxxxx', 'posted', NOW - 50, null);
    expect(await db.all(DUE, [NOW])).toEqual([{ report_id: 'duereportxxxxxxxxxxx' }]);
    expect(await db.all(DUE, [NOW - 1])).toEqual([]);
  });
});

describe('critical invariant 1: approved and posting need an un-voided approval', () => {
  const run = (db: SqlDb, text: SqlText, params: readonly SqlValue[]) => db.run(text, params);

  it('refuses either status while the report has no approval, or only a voided one', async () => {
    const db = open();
    await db.run(REPORT, ['unapprovedxxxxxxxxxx', 'pending', NOW]);
    for (const status of ['approved', 'posting']) {
      await refused(run(db, SET_STATUS, [status, 'unapprovedxxxxxxxxxx']), NEEDS_APPROVAL, `${status}, no approval`);
    }
    // Cancelled within the grace: the voided approval is no approval.
    await db.run(APPROVAL, ['unapprovedxxxxxxxxxx', randomId(), 424242001, NOW, NOW + GRACE, NOW + 1]);
    for (const status of ['approved', 'posting']) {
      await refused(run(db, SET_STATUS, [status, 'unapprovedxxxxxxxxxx']), NEEDS_APPROVAL, `${status}, voided`);
    }
    expect(await statusOf(db, 'unapprovedxxxxxxxxxx')).toBe('pending');
  });

  it('rolls back a batch that writes the status before its approval', async () => {
    const db = open();
    await db.run(REPORT, ['statusfirstxxxxxxxxx', 'pending', NOW]);
    await refused(
      db.batch([
        { sql: SET_STATUS, params: ['approved', 'statusfirstxxxxxxxxx'] },
        { sql: APPROVAL, params: ['statusfirstxxxxxxxxx', randomId(), 424242001, NOW, NOW + GRACE, null] },
      ]),
      NEEDS_APPROVAL,
      'the status first',
    );
    expect(await db.all(sql`SELECT count(*) AS n FROM approvals`)).toEqual([{ n: 0 }]);
    expect(await statusOf(db, 'statusfirstxxxxxxxxx')).toBe('pending');
  });

  it('takes approved, posting and the revert of a claim under an un-voided approval', async () => {
    const db = open();
    await db.run(REPORT, ['approvedxxxxxxxxxxxx', 'pending', NOW]);
    await db.batch([
      { sql: APPROVAL, params: ['approvedxxxxxxxxxxxx', randomId(), 424242001, NOW, NOW + GRACE, null] },
      { sql: SET_STATUS, params: ['approved', 'approvedxxxxxxxxxxxx'] },
    ]);
    await db.run(SET_STATUS, ['posting', 'approvedxxxxxxxxxxxx']);
    // A 429 reverts the claim: posting back to approved.
    await db.run(SET_STATUS, ['approved', 'approvedxxxxxxxxxxxx']);
    expect(await statusOf(db, 'approvedxxxxxxxxxxxx')).toBe('approved');
  });

  it('lets Cancel, the other decisions and the later statuses through, needing no approval', async () => {
    const db = open();
    await db.run(REPORT, ['cancelledxxxxxxxxxxx', 'pending', NOW]);
    await db.batch([
      { sql: APPROVAL, params: ['cancelledxxxxxxxxxxx', randomId(), 424242001, NOW, NOW + GRACE, null] },
      { sql: SET_STATUS, params: ['approved', 'cancelledxxxxxxxxxxx'] },
    ]);
    await db.batch([
      { sql: sql`UPDATE approvals SET voided_at = ? WHERE report_id = ?`, params: [NOW + 1, 'cancelledxxxxxxxxxxx'] },
      { sql: SET_STATUS, params: ['pending', 'cancelledxxxxxxxxxxx'] },
    ]);
    expect(await statusOf(db, 'cancelledxxxxxxxxxxx')).toBe('pending');
    for (const status of ['rejected', 'routed', 'merged', 'expired', 'closing', 'retracting', 'closed', 'retracted']) {
      const reportId = `${status}reportxxxxxxxxxxxxxxx`.slice(0, 20);
      await db.run(REPORT, [reportId, 'pending', NOW]);
      await db.run(SET_STATUS, [status, reportId]);
      expect(await statusOf(db, reportId), status).toBe(status);
    }
  });
});

describe('critical invariant 1: a re-approval is a new approval', () => {
  it('claims nothing under the cancelled approval id, and the re-approval under its own', async () => {
    const db = open();
    const reportId = 'reapprovedxxxxxxxxxx';
    const cancelled = randomId();
    const fresh = randomId();
    await db.run(REPORT, [reportId, 'pending', NOW - 2 * GRACE]);
    await db.batch([
      { sql: APPROVAL, params: [reportId, cancelled, 424242001, NOW - 2 * GRACE, NOW - GRACE, null] },
      { sql: SET_STATUS, params: ['approved', reportId] },
    ]);
    // Cancel within the grace, then a re-approval with a new start.
    await db.batch([
      { sql: sql`UPDATE approvals SET voided_at = ? WHERE report_id = ?`, params: [NOW - GRACE - 1, reportId] },
      { sql: SET_STATUS, params: ['pending', reportId] },
    ]);
    await db.batch([
      { sql: REAPPROVE, params: [reportId, fresh, 424242002, NOW - 10, NOW - 5] },
      { sql: SET_STATUS, params: ['approved', reportId] },
    ]);
    expect(fresh).not.toBe(cancelled);
    expect(await db.all(sql`SELECT approval_id, admin_id FROM approvals`)).toEqual([{ approval_id: fresh, admin_id: 424242002 }]);
    // The cancelled approval's job, its start long reached, claims nothing.
    expect(await db.run(CLAIM, [NOW, reportId, NOW, cancelled, NOW])).toEqual({ changes: 0 });
    expect(await statusOf(db, reportId)).toBe('approved');
    // Nor does the re-approval's job under a lockdown, a halt or a pause.
    for (const [key, value] of [
      ['lockdown', 1],
      ['halted', 1],
      ['paused_until', NOW + 60_000],
    ] as const) {
      await db.run(sql`INSERT INTO meta (key, value) VALUES (?, ?)`, [key, value]);
      expect(await db.run(CLAIM, [NOW, reportId, NOW, fresh, NOW]), key).toEqual({ changes: 0 });
      await db.run(sql`DELETE FROM meta WHERE key = ?`, [key]);
    }
    expect(await db.run(CLAIM, [NOW, reportId, NOW, fresh, NOW])).toEqual({ changes: 1 });
    expect(await statusOf(db, reportId)).toBe('posting');
  });
});

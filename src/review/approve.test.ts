// Unit tests for the approval's batch (src/review/approve.ts, critical
// invariants 1, 7 and 8), on node:sqlite with the D1 migrations: the
// approval row with its random id and its start, the conditional status
// change bound to that id, the post job carrying it, the review-only fields
// nulled on the report and its merged rows, the prompts gone; nothing but
// the answered prompt's row written when the report is no longer pending,
// or when the lockdown switch is set (critical invariant 2: the switch
// bound in the approval row's own statement); a re-approval over a voided
// row under a new id, never over a live one;
// and one of two decisions at the same moment, only. Then the report as it
// is when the batch runs: the link mode re-checked in the batch's own
// statement against allowedModes() of the report as read, over the 18
// cells of a known account (mode, flag 0, 1 or cleared, a post URL distinct
// from the account's, equal to it, or none), nothing written when it
// refuses; nothing approved for a report that no longer holds the links the
// post was rendered from; and no post-mode upsert over a voided approval
// once the flag is cleared, the voided row left as it was. The
// conversation itself is tested through the bot (src/telegram/review.test.ts).
import { describe, expect, it } from 'vitest';
import { fakeClock } from '../../test/fakes/clock';
import { setLockdown } from '../auth/lockdown';
import { migratedDatabase } from '../../test/support/database';
import { insertApproval, insertReport, reportRow, snapshot } from '../../test/support/review-rows';
import { IDS } from '../../test/support/variables';
import { randomId } from '../db/ids';
import { sql, type SqlDb } from '../db/sql';
import { approveStatements, APPROVAL_STATUS_STATEMENT, writeApproval, type ApprovalInput } from './approve';
import { allowedModes } from './card';
import { LINK_MODES } from './categories';
import { rejectStatements, REJECT_STATUS_STATEMENT } from './reject';
import { createPrompt } from './prompts';
import { readReport } from './reports';

const NOW = 1_800_000_000_000;
const GRACE = 30 * 60_000;
const setup = () => migratedDatabase(fakeClock(NOW));
/** insertReport()'s links: an X post and its account. */
const POST_URL = 'https://x.com/someone/status/1234567890';
const ACCOUNT_URL = 'https://x.com/someone';

const input = (reportId: string, fields: Partial<ApprovalInput> = {}): ApprovalInput => ({
  reportId,
  approvalId: randomId(),
  jobId: randomId(),
  adminId: IDS.admin,
  category: 'harassment',
  linkMode: 'post',
  links: { url: POST_URL, accountUrl: ACCOUNT_URL },
  recommendedComment: 'Say it mocks a private person.',
  broadcastText: '<b>The post</b>',
  now: NOW,
  startsAt: NOW + GRACE,
  prompt: { chatId: IDS.adminChat, promptMessageId: 31 },
  ...fields,
});

const prompt = (db: SqlDb, reportId: string, promptMessageId: number, adminId: number = IDS.admin) =>
  createPrompt(db, {
    chatId: IDS.adminChat,
    promptMessageId,
    adminId,
    reportId,
    kind: 'recommended_comment',
    category: 'harassment',
    linkMode: 'post',
    createdAt: NOW,
  });

describe('the approval batch', () => {
  it('writes the approval with its random id and its start, the approved report, its post job, and deletes its prompts', async () => {
    const { db } = setup();
    const reportId = await insertReport(db, { comment: 'the reporter wrote this', affected_person: 0, category: 'other' });
    const merged = await insertReport(db, { status: 'merged', merged_into: reportId, comment: 'another', affected_person: 1, card_message_id: null });
    await prompt(db, reportId, 31);
    await prompt(db, reportId, 32, IDS.secondAdmin);
    const approval = input(reportId);
    expect(await writeApproval({ db }, approval)).toBe(true);
    expect(await db.all(sql`SELECT * FROM approvals`)).toEqual([
      {
        report_id: reportId,
        approval_id: approval.approvalId,
        admin_id: IDS.admin,
        approved_at: NOW,
        link_mode: 'post',
        recommended_comment: 'Say it mocks a private person.',
        starts_at: NOW + GRACE,
        voided_at: null,
      },
    ]);
    expect(await reportRow(db, reportId)).toMatchObject({
      status: 'approved',
      category: 'harassment',
      link_mode: 'post',
      broadcast_text: '<b>The post</b>',
      comment: null,
      affected_person: null,
    });
    expect(await reportRow(db, merged)).toMatchObject({ status: 'merged', comment: null, affected_person: null });
    const jobs = await db.all<{ id: string; kind: string; report_id: string; due_at: number; payload: string; attempts: number }>(
      sql`SELECT id, kind, report_id, due_at, payload, attempts FROM jobs`,
    );
    expect(jobs).toEqual([{ id: approval.jobId, kind: 'post', report_id: reportId, due_at: NOW + GRACE, payload: JSON.stringify({ approval_id: approval.approvalId }), attempts: 0 }]);
    expect(await db.all(sql`SELECT * FROM admin_prompts`)).toEqual([]);
  });

  it('writes nothing but the answered prompt\'s deletion for a report no longer pending', async () => {
    const { db } = setup();
    for (const status of ['rejected', 'routed', 'approved', 'posted', 'merged']) {
      const reportId = await insertReport(db, {
        status: status === 'approved' ? 'pending' : status,
        ...(status === 'posted' ? { posting_started_at: NOW - 2, posted_at: NOW - 1 } : {}),
      });
      if (status === 'approved') {
        await insertApproval(db, reportId);
        await db.run(sql`UPDATE reports SET status = 'approved' WHERE id = ?`, [reportId]);
      }
      await prompt(db, reportId, 31);
      await prompt(db, reportId, 32, IDS.secondAdmin);
      const before = await snapshot(db);
      expect(await writeApproval({ db }, input(reportId)), status).toBe(false);
      const after = await snapshot(db);
      expect((after.admin_prompts as unknown[]).length, status).toBe((before.admin_prompts as unknown[]).length - 1);
      expect({ ...after, admin_prompts: [] }, status).toEqual({ ...before, admin_prompts: [] });
      await db.run(sql`DELETE FROM admin_prompts`);
    }
  });

  it("writes nothing but the answered prompt's deletion under lockdown, over no approval row or a voided one", async () => {
    for (const earlier of [false, true]) {
      const { db } = setup();
      const reportId = await insertReport(db);
      if (earlier) await insertApproval(db, reportId, { voidedAt: NOW - 10, approvedAt: NOW - 100, startsAt: NOW - 50 });
      await prompt(db, reportId, 31);
      await prompt(db, reportId, 32, IDS.secondAdmin);
      await setLockdown(db, fakeClock(NOW));
      const before = await snapshot(db);
      expect(await writeApproval({ db }, input(reportId)), String(earlier)).toBe(false);
      const after = await snapshot(db);
      expect(after.admin_prompts, String(earlier)).toEqual([expect.objectContaining({ prompt_message_id: 32 })]);
      expect({ ...after, admin_prompts: [] }, String(earlier)).toEqual({ ...before, admin_prompts: [] });
    }
  });

  it('upserts a re-approval over a voided approval under a new id, and never over a live one', async () => {
    const { db } = setup();
    const reportId = await insertReport(db);
    const cancelled = await insertApproval(db, reportId, { voidedAt: NOW - 10, approvedAt: NOW - 100, startsAt: NOW - 50 });
    const again = input(reportId, { adminId: IDS.secondAdmin });
    expect(await writeApproval({ db }, again)).toBe(true);
    expect(await db.all(sql`SELECT approval_id, admin_id, voided_at FROM approvals`)).toEqual([
      { approval_id: again.approvalId, admin_id: IDS.secondAdmin, voided_at: null },
    ]);
    expect(again.approvalId).not.toBe(cancelled);
    // A live approval on a pending report (no flow writes one) is never overwritten, and nothing is approved.
    const other = await insertReport(db);
    const live = await insertApproval(db, other);
    expect(await writeApproval({ db }, input(other))).toBe(false);
    expect(await db.all(sql`SELECT approval_id FROM approvals WHERE report_id = ?`, [other])).toEqual([{ approval_id: live }]);
    expect(await reportRow(db, other)).toMatchObject({ status: 'pending' });
    expect(await db.all(sql`SELECT * FROM jobs WHERE report_id = ?`, [other])).toEqual([]);
  });

  it('lets exactly one of two decisions at the same moment change the report', async () => {
    const { db } = setup();
    const reportId = await insertReport(db);
    const [approved, rejected] = await Promise.all([
      db.batch(approveStatements(input(reportId))),
      db.batch(rejectStatements(reportId, 'no_violation', IDS.secondAdmin, NOW)),
    ]);
    const changed = [approved?.[APPROVAL_STATUS_STATEMENT]?.changes, rejected?.[REJECT_STATUS_STATEMENT]?.changes];
    expect(changed.sort()).toEqual([0, 1]);
    const row = await reportRow(db, reportId);
    if (row?.status === 'approved') {
      expect(await db.all(sql`SELECT count(*) AS n FROM approvals`)).toEqual([{ n: 1 }]);
    } else {
      expect(row?.status).toBe('rejected');
      expect(await db.all(sql`SELECT count(*) AS n FROM approvals`)).toEqual([{ n: 0 }]);
      expect(await db.all(sql`SELECT count(*) AS n FROM jobs`)).toEqual([{ n: 0 }]);
    }
  });

  it('cannot be written without its approval row: the schema refuses the status alone', async () => {
    const { db } = setup();
    const reportId = await insertReport(db);
    const [, statusChange] = approveStatements(input(reportId));
    if (statusChange === undefined) throw new Error('no status statement');
    // The status change alone is bound to an approval that does not exist: it changes nothing.
    expect(await db.run(statusChange.sql, statusChange.params)).toEqual({ changes: 0 });
    await expect(db.run(sql`UPDATE reports SET status = 'approved' WHERE id = ?`, [reportId])).rejects.toMatchObject({ code: 'STORAGE_FAILURE' });
  });
});

describe('the approval batch and the report as it is when the batch runs', () => {
  /** The report's post URL in each cell: the account's own, another, or none. */
  const URLS = { distinct: POST_URL, equal: ACCOUNT_URL, none: null } as const;
  const FLAGS = [0, 1, null] as const;
  const CELLS = LINK_MODES.flatMap((mode) => FLAGS.flatMap((flag) => Object.entries(URLS).map(([shape, url]) => ({ mode, flag, shape, url }))));

  /** Runs `approval` on report `reportId` with its answered prompt (31) and another admin's (32); whether it won, and the snapshots around it. */
  const attempt = async (db: SqlDb, reportId: string, approval: ApprovalInput) => {
    await prompt(db, reportId, 31);
    await prompt(db, reportId, 32, IDS.secondAdmin);
    const before = await snapshot(db);
    const won = await writeApproval({ db }, approval);
    return { won, before, after: await snapshot(db) };
  };

  /** Nothing written but the answered prompt's deletion. */
  const expectNothingWritten = (outcome: { before: Record<string, unknown>; after: Record<string, unknown> }, label: string): void => {
    expect(outcome.after.admin_prompts, label).toEqual([expect.objectContaining({ prompt_message_id: 32 })]);
    expect({ ...outcome.after, admin_prompts: [] }, label).toEqual({ ...outcome.before, admin_prompts: [] });
  };

  it("approves exactly when allowedModes() of the report as read allows the mode, a known account's 18 cells, and writes nothing otherwise", async () => {
    expect(CELLS).toHaveLength(18);
    const won: string[] = [];
    for (const { mode, flag, shape, url } of CELLS) {
      const label = `${mode}, flag ${String(flag)}, URL ${shape}`;
      const { db } = setup();
      const reportId = await insertReport(db, { url, account_url: ACCOUNT_URL, affected_person: flag });
      const report = await readReport(db, reportId);
      if (report === null) throw new Error('the report was not written');
      const allowed = allowedModes(report, 'harassment').includes(mode);
      const approval = input(reportId, { linkMode: mode, links: { url: report.url, accountUrl: ACCOUNT_URL } });
      const outcome = await attempt(db, reportId, approval);
      expect(outcome.won, label).toBe(allowed);
      if (!allowed) {
        expectNothingWritten(outcome, label);
        continue;
      }
      won.push(label);
      expect(await reportRow(db, reportId), label).toMatchObject({ status: 'approved', link_mode: mode });
      expect(await db.all(sql`SELECT approval_id, link_mode, voided_at FROM approvals`), label).toEqual([{ approval_id: approval.approvalId, link_mode: mode, voided_at: null }]);
      expect(await db.all(sql`SELECT kind, report_id FROM jobs`), label).toEqual([{ kind: 'post', report_id: reportId }]);
    }
    // The account link on all nine; the post's URL only with the flag exactly 0 and a URL that is not the account's.
    expect(won).toEqual([...FLAGS.flatMap((flag) => Object.keys(URLS).map((shape) => `account, flag ${String(flag)}, URL ${shape}`)), 'post, flag 0, URL distinct']);
  });

  it('approves nothing when the report no longer holds the links the post was rendered from', async () => {
    const cases = [
      ['another post URL', { url: POST_URL }, { url: 'https://x.com/someone/status/9999999999', accountUrl: ACCOUNT_URL }],
      ['another account', { url: POST_URL }, { url: POST_URL, accountUrl: 'https://x.com/someone_else' }],
      ['no post URL, where the report has one', { url: POST_URL }, { url: null, accountUrl: ACCOUNT_URL }],
      ['a post URL, where the report has none', { url: null }, { url: POST_URL, accountUrl: ACCOUNT_URL }],
    ] as const;
    for (const [label, fields, links] of cases) {
      for (const mode of LINK_MODES) {
        const { db } = setup();
        const reportId = await insertReport(db, fields);
        const outcome = await attempt(db, reportId, input(reportId, { linkMode: mode, links }));
        expect(outcome.won, `${label}, ${mode}`).toBe(false);
        expectNothingWritten(outcome, `${label}, ${mode}`);
      }
    }
  });

  it('never upserts the post mode over a voided approval once the flag is cleared, and takes the account mode over it', async () => {
    const { db } = setup();
    // Another admin's approval cleared the flag, and a keyholder's Cancel returned the report to review.
    const reportId = await insertReport(db, { affected_person: null });
    const voided = await insertApproval(db, reportId, { adminId: IDS.secondAdmin, voidedAt: NOW - 10, approvedAt: NOW - 100, startsAt: NOW - 50 });
    const stale = await attempt(db, reportId, input(reportId, { linkMode: 'post' }));
    expect(stale.won).toBe(false);
    expectNothingWritten(stale, 'post');
    expect(await db.all(sql`SELECT approval_id, admin_id, link_mode, voided_at FROM approvals`)).toEqual([
      { approval_id: voided, admin_id: IDS.secondAdmin, link_mode: 'account', voided_at: NOW - 10 },
    ]);
    await db.run(sql`DELETE FROM admin_prompts`);
    const account = input(reportId, { linkMode: 'account' });
    expect((await attempt(db, reportId, account)).won).toBe(true);
    expect(await db.all(sql`SELECT approval_id, admin_id, link_mode, voided_at FROM approvals`)).toEqual([
      { approval_id: account.approvalId, admin_id: IDS.admin, link_mode: 'account', voided_at: null },
    ]);
    expect(await reportRow(db, reportId)).toMatchObject({ status: 'approved', link_mode: 'account' });
  });
});

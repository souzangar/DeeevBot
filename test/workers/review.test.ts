// Workers tier: the review's batches on the local D1 that miniflare runs
// (src/review/approve.ts, cancel.ts, reject.ts, route.ts and
// src/broadcast/jobs.ts over src/db/d1.ts), as the unit tier checks them on
// node:sqlite: the approval's upsert over a SELECT and the post job's
// `ON CONFLICT DO NOTHING`, the status change bound to the approval id
// under the schema's trigger, the Cancel, a re-approval under a new id, the
// rejection's counters and the routing's nulls. And the approval's re-check
// of the report in its own statement, on D1 as on node:sqlite: the 18 cells
// of a known account against allowedModes() of the report as read (the
// post mode's own approval, and every refusal: the URL the account's or
// none, the flag 1 or cleared); the post mode refused once a real affected
// duplicate's submit raised the pending target's flag, the account mode
// taken; no post-mode upsert over a voided approval once the flag is
// cleared; nothing approved for a report whose links moved. Ids,
// references and hashes are unique to this file, so it shares the database
// with the other files.
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Clock } from '../../src/clock';
import { d1SqlDb } from '../../src/db/d1';
import { sql } from '../../src/db/sql';
import { writeApproval, type ApprovalInput } from '../../src/review/approve';
import { writeCancel } from '../../src/review/cancel';
import { allowedModes } from '../../src/review/card';
import { LINK_MODES } from '../../src/review/categories';
import { setAffected, setCategory, startDraft, submitReport, type SubmitInput } from '../../src/review/drafts';
import { rejectStatements, REJECT_STATUS_STATEMENT } from '../../src/review/reject';
import { readReport } from '../../src/review/reports';
import { routeStatements, ROUTE_STATUS_STATEMENT } from '../../src/review/route';

const db = d1SqlDb(env.DB);
const NOW = Date.UTC(2031, 6, 1, 12, 0, 0);
const ADMIN = 424240011;
/** A 20-letter id: `name` padded with q. */
const id = (name: string): string => name.padEnd(20, 'q');
const ref = (n: number): string => `${'b'.repeat(56)}${n.toString(16).padStart(8, '0')}`;
/** A 64-hex draft key (a reporter reference) or link hash for the submits here: `fill` 56 times, then `n`. */
const hex64 = (fill: string, n: number): string => `${fill.repeat(56)}${n.toString(16).padStart(8, '0')}`;
/** report()'s links: an X post and its account. */
const POST_URL = 'https://x.com/someone/status/1';
const ACCOUNT_URL = 'https://x.com/someone';
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const clock: Clock = { now: () => NOW, sleep: () => Promise.resolve() };

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const report = async (reportId: string, fields: { readonly status?: string; readonly mergedInto?: string; readonly reporterRef?: string } = {}) => {
  await db.run(
    sql`INSERT INTO reports (id, status, platform, category, url, account_url, comment, affected_person, reporter_ref, merged_into, created_at) VALUES (?, ?, 'x', 'harassment', 'https://x.com/someone/status/1', 'https://x.com/someone', 'a comment', 1, ?, ?, ?)`,
    [reportId, fields.status ?? 'pending', fields.reporterRef ?? ref(1), fields.mergedInto ?? null, NOW],
  );
};

/** A pending X report whose account is known, with `url` (a post URL, the account's own, or none) and the flag `affected`. */
const reportWith = async (reportId: string, fields: { readonly url: string | null; readonly affected: 0 | 1 | null }) => {
  await db.run(
    sql`INSERT INTO reports (id, status, platform, category, url, account_url, comment, affected_person, reporter_ref, created_at) VALUES (?, 'pending', 'x', 'harassment', ?, ?, 'a comment', ?, ?, ?)`,
    [reportId, fields.url, ACCOUNT_URL, fields.affected, ref(1), NOW],
  );
};

/** A draft keyed `draftKey` at the comment step, as test/workers/intake.test.ts starts one. */
const draftAtComment = async (draftKey: string): Promise<void> => {
  await startDraft(db, clock, draftKey, 'category', { url: POST_URL, platform: 'x', accountUrl: ACCOUNT_URL }, 'en');
  await setCategory(db, clock, draftKey, 'harassment');
  await setAffected(db, clock, draftKey, false);
};

/** A member's submit of the draft keyed `draftKey` as report `reportId`, of the target hashed `linkHash`. */
const submission = (draftKey: string, reportId: string, linkHash: string, fields: Partial<SubmitInput> = {}): SubmitInput => ({
  reporterRef: draftKey,
  reportId,
  member: true,
  url: POST_URL,
  platform: 'x',
  accountUrl: ACCOUNT_URL,
  category: 'harassment',
  affectedPerson: false,
  comment: null,
  linkHash,
  ...fields,
});

const approval = (reportId: string, approvalId: string, jobId: string): ApprovalInput => ({
  reportId,
  approvalId,
  jobId,
  adminId: ADMIN,
  category: 'harassment',
  linkMode: 'account',
  links: { url: POST_URL, accountUrl: ACCOUNT_URL },
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

describe("the approval's re-check of the report on D1", () => {
  /** Nothing of an approval on report `reportId`: no approval row, no job, the report pending. */
  const expectUnapproved = async (reportId: string, label: string): Promise<void> => {
    expect(await db.all(sql`SELECT * FROM approvals WHERE report_id = ?`, [reportId]), label).toEqual([]);
    expect(await db.all(sql`SELECT * FROM jobs WHERE report_id = ?`, [reportId]), label).toEqual([]);
    expect(await db.first(sql`SELECT status FROM reports WHERE id = ?`, [reportId]), label).toEqual({ status: 'pending' });
  };

  it("approves exactly when allowedModes() of the report as read allows the mode, a known account's 18 cells, the post mode's own approval included", async () => {
    const urls = { distinct: POST_URL, equal: ACCOUNT_URL, none: null } as const;
    const flags = [0, 1, null] as const;
    const cells = LINK_MODES.flatMap((mode) => flags.flatMap((flag) => Object.entries(urls).map(([shape, url]) => ({ mode, flag, shape, url }))));
    expect(cells).toHaveLength(18);
    const won: string[] = [];
    for (const [n, { mode, flag, shape, url }] of cells.entries()) {
      const label = `${mode}, flag ${String(flag)}, URL ${shape}`;
      const letter = LETTERS[n] ?? '';
      const reportId = id(`workersparity${letter}`);
      await reportWith(reportId, { url, affected: flag });
      const read = await readReport(db, reportId);
      if (read === null) throw new Error('the report was not written');
      const allowed = allowedModes(read, 'harassment').includes(mode);
      const input: ApprovalInput = { ...approval(reportId, id(`parityapproval${letter}`), id(`parityjob${letter}`)), linkMode: mode, links: { url: read.url, accountUrl: ACCOUNT_URL } };
      expect(await writeApproval({ db }, input), label).toBe(allowed);
      if (!allowed) {
        await expectUnapproved(reportId, label);
        continue;
      }
      won.push(label);
      expect(await db.first(sql`SELECT status, link_mode FROM reports WHERE id = ?`, [reportId]), label).toEqual({ status: 'approved', link_mode: mode });
      expect(await db.all(sql`SELECT approval_id, link_mode, voided_at FROM approvals WHERE report_id = ?`, [reportId]), label).toEqual([
        { approval_id: input.approvalId, link_mode: mode, voided_at: null },
      ]);
      expect(await db.all(sql`SELECT kind, json_extract(payload, '$.approval_id') AS approval_id FROM jobs WHERE report_id = ?`, [reportId]), label).toEqual([
        { kind: 'post', approval_id: input.approvalId },
      ]);
    }
    // The account link on all nine; the post's URL only with the flag exactly 0 and a URL that is not the account's.
    expect(won).toEqual([...flags.flatMap((flag) => Object.keys(urls).map((shape) => `account, flag ${String(flag)}, URL ${shape}`)), 'post, flag 0, URL distinct']);
  });

  it("refuses the post mode once an affected duplicate's real submit raised the pending target's flag, and takes the account mode", async () => {
    const target = id('workersraisedtarget');
    const merged = id('workersraisedmerged');
    await draftAtComment(hex64('a', 1));
    expect(await submitReport(db, submission(hex64('a', 1), target, hex64('c', 1)), NOW)).toBe('submitted');
    // The post was rendered, and the notices sent, while the flag was 0; the duplicate lands before the batch.
    await draftAtComment(hex64('a', 2));
    expect(await submitReport(db, submission(hex64('a', 2), merged, hex64('c', 1), { affectedPerson: true, comment: 'it is my data' }), NOW + 1)).toBe('submitted');
    expect(await db.all(sql`SELECT id, status, merged_into, affected_person FROM reports WHERE link_hash = ? ORDER BY created_at`, [hex64('c', 1)])).toEqual([
      { id: target, status: 'pending', merged_into: null, affected_person: 1 },
      { id: merged, status: 'merged', merged_into: target, affected_person: null },
    ]);
    expect(await writeApproval({ db }, { ...approval(target, id('workersraisedpost'), id('workersraisedjobone')), linkMode: 'post' })).toBe(false);
    await expectUnapproved(target, 'post');
    expect(await db.first(sql`SELECT affected_person FROM reports WHERE id = ?`, [target])).toEqual({ affected_person: 1 });
    expect(await writeApproval({ db }, approval(target, id('workersraisedaccount'), id('workersraisedjobtwo')))).toBe(true);
    expect(await db.first(sql`SELECT status, link_mode FROM reports WHERE id = ?`, [target])).toEqual({ status: 'approved', link_mode: 'account' });
  });

  it('never upserts the post mode over a voided approval once the flag is cleared, and takes the account mode over it', async () => {
    const reportId = id('workersvoidedcleared');
    await reportWith(reportId, { url: POST_URL, affected: null });
    await db.run(
      sql`INSERT INTO approvals (report_id, approval_id, admin_id, approved_at, link_mode, recommended_comment, starts_at, voided_at) VALUES (?, ?, 424240012, ?, 'account', 'say it', ?, ?)`,
      [reportId, id('workersvoidedfirst'), NOW - 100, NOW - 50, NOW - 10],
    );
    expect(await writeApproval({ db }, { ...approval(reportId, id('workersvoidedpost'), id('workersvoidedjobone')), linkMode: 'post' })).toBe(false);
    expect(await db.all(sql`SELECT approval_id, admin_id, link_mode, voided_at FROM approvals WHERE report_id = ?`, [reportId])).toEqual([
      { approval_id: id('workersvoidedfirst'), admin_id: 424240012, link_mode: 'account', voided_at: NOW - 10 },
    ]);
    expect(await db.all(sql`SELECT * FROM jobs WHERE report_id = ?`, [reportId])).toEqual([]);
    expect(await writeApproval({ db }, approval(reportId, id('workersvoidedaccount'), id('workersvoidedjobtwo')))).toBe(true);
    expect(await db.all(sql`SELECT approval_id, voided_at FROM approvals WHERE report_id = ?`, [reportId])).toEqual([
      { approval_id: id('workersvoidedaccount'), voided_at: null },
    ]);
  });

  it('approves nothing for a report that no longer holds the links the post was rendered from', async () => {
    const reportId = id('workerslinksmoved');
    await reportWith(reportId, { url: POST_URL, affected: 0 });
    const moved = [
      { url: 'https://x.com/someone/status/2', accountUrl: ACCOUNT_URL },
      { url: POST_URL, accountUrl: 'https://x.com/someone_else' },
      { url: null, accountUrl: ACCOUNT_URL },
    ] as const;
    let n = 0;
    for (const links of moved) {
      for (const mode of LINK_MODES) {
        const letter = LETTERS[(n += 1)] ?? '';
        expect(await writeApproval({ db }, { ...approval(reportId, id(`linksapproval${letter}`), id(`linksjob${letter}`)), linkMode: mode, links }), `${String(links.url)} ${mode}`).toBe(false);
      }
    }
    await expectUnapproved(reportId, 'links');
  });
});

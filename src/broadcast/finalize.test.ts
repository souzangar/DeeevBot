// Unit tests for finalization (src/broadcast/finalize.ts; critical
// invariants 1 and 8), on the migrated schema under node:sqlite: the
// aggregate row upserted from the report as it stands (its days, its
// outcome, its presses, its hash), its approval, prompts, jobs and merged
// rows deleted, every personal field nulled, `data_deleted_at` set; nothing
// done to a report in any other status, or finalized already; a report
// without a hash finalized without an aggregate row; the rejection counted
// off its references, never below 0; the conclusion bound to its state, its
// approval, its own post and, for a closure, to no hold; and
// reconciliation's slot for the concluded statuses alone.
import { describe, expect, it } from 'vitest';
import { utcDay } from '../clock';
import { randomId } from '../db/ids';
import { sql, type SqlDb } from '../db/sql';
import { fakeClock } from '../../test/fakes/clock';
import { migratedDatabase } from '../../test/support/database';
import { hex, insertApproval, insertReport, insertReporterStats, reportRow } from '../../test/support/review-rows';
import { createPrompt } from '../review/prompts';
import {
  CONCLUDE_STATUS_STATEMENT,
  concludeStatements,
  FINALIZE_BATCH_LIMIT,
  finalizationStatements,
  finalizeTerminal,
  rejectionDecayStatement,
} from './finalize';
import { enqueueEditStatement } from './jobs';

const DAY = 86_400_000;
const NOW = Date.UTC(2027, 3, 20, 10, 0);
const CREATED = Date.UTC(2027, 0, 15, 9, 0);
const APPROVED = Date.UTC(2027, 0, 16, 9, 0);

/** The personal and content fields finalization nulls (the rule-8 scan's 'nulled' set). */
const NULLED = [
  'url',
  'account_url',
  'comment',
  'affected_person',
  'reporter_ref',
  'link_hash',
  'decided_by',
  'rejection_reason',
  'broadcast_text',
  'correction_text',
  'link_mode',
  'card_message_id',
  'status_message_id',
  'post_message_id',
] as const;

const open = (): SqlDb => migratedDatabase(fakeClock(NOW)).db;

let nextPost = 40;

/** A posted report in `status`, with its approval, a prompt, its edit job and a merged row. */
async function posted(db: SqlDb, status: 'closing' | 'retracting' | 'closed' | 'retracted' | 'expired' = 'closed', fields: Record<string, string | number | null> = {}) {
  const reportId = await insertReport(db, {
    status: 'posted',
    created_at: CREATED,
    card_message_id: 11,
    status_message_id: 12,
    broadcast_text: '<b>the post</b>',
    link_mode: 'account',
    posting_started_at: APPROVED + 30 * 60_000,
    posted_at: APPROVED + 30 * 60_000,
    post_message_id: (nextPost += 1),
    ...fields,
  });
  const approvalId = await insertApproval(db, reportId, { approvedAt: APPROVED, startsAt: APPROVED + 30 * 60_000 });
  await db.run(sql`UPDATE reports SET status = ?, outcome = 'taken_down', presses = 17, correction_text = 'a correction', decided_by = 424240011 WHERE id = ?`, [status, reportId]);
  await createPrompt(db, { chatId: -1004242400041, promptMessageId: (nextPost += 1), adminId: 424240011, reportId, kind: 'retraction', category: null, linkMode: null, createdAt: NOW - DAY });
  if (status === 'closing' || status === 'retracting') {
    const job = enqueueEditStatement({ reportId, status, dueAt: NOW, now: NOW });
    await db.run(job.sql, job.params);
  } else {
    // A job a failed finalization left behind: finalization deletes it too.
    await db.run(sql`INSERT INTO jobs (id, kind, report_id, due_at, payload, attempts, created_at) VALUES (?, 'edit', ?, ?, '{"action":"close"}', 3, ?)`, [randomId(), reportId, NOW, NOW]);
  }
  const merged = await insertReport(db, { status: 'merged', merged_into: reportId, comment: null, affected_person: null, reporter_ref: hex(9), created_at: CREATED + DAY });
  return { reportId, approvalId, merged };
}

const COUNTS = {
  approvals: sql`SELECT count(*) AS n FROM approvals WHERE report_id = ?`,
  admin_prompts: sql`SELECT count(*) AS n FROM admin_prompts WHERE report_id = ?`,
  jobs: sql`SELECT count(*) AS n FROM jobs WHERE report_id = ?`,
  stats: sql`SELECT count(*) AS n FROM stats WHERE report_id = ?`,
} as const;

const count = async (db: SqlDb, table: keyof typeof COUNTS, reportId: string): Promise<number> =>
  Number((await db.first<{ n: number }>(COUNTS[table], [reportId]))?.n ?? 0);

describe('finalizationStatements', () => {
  it('writes the aggregate row, deletes the approval, prompts, jobs and merged rows, and nulls every personal field', async () => {
    const db = open();
    const { reportId, merged } = await posted(db, 'closed');
    await db.batch(finalizationStatements([reportId], NOW, ['closed']));
    expect(await db.all(sql`SELECT * FROM stats`)).toEqual([
      {
        report_id: reportId,
        category: 'harassment',
        platform: 'x',
        created_day: '2027-01-15',
        decided_day: '2027-01-16',
        closed_day: utcDay(NOW),
        outcome: 'taken_down',
        presses: 17,
        link_hash: hex(1, 'c'),
      },
    ]);
    for (const table of ['approvals', 'admin_prompts', 'jobs'] as const) expect(await count(db, table, reportId), table).toBe(0);
    expect(await reportRow(db, merged)).toBeNull();
    const row = await reportRow(db, reportId);
    for (const field of NULLED) expect(row?.[field], field).toBeNull();
    expect(row).toMatchObject({ status: 'closed', outcome: 'taken_down', presses: 17, closed_at: NOW, data_deleted_at: NOW, created_at: CREATED });
  });

  it('takes the decision\'s day from decided_at, and the outcome from the status when the report has none', async () => {
    const db = open();
    const rejected = await insertReport(db, { status: 'rejected', decided_at: Date.UTC(2027, 1, 2, 23, 59), decided_by: 424240011, created_at: CREATED });
    const routed = await insertReport(db, { status: 'routed', decided_at: Date.UTC(2027, 1, 3), decided_by: 424240012, created_at: CREATED, url: null, account_url: null, link_hash: hex(2, 'c') });
    await db.batch(finalizationStatements([rejected, routed], NOW, ['rejected', 'routed']));
    expect(await db.all(sql`SELECT report_id, decided_day, outcome FROM stats ORDER BY decided_day`)).toEqual([
      { report_id: rejected, decided_day: '2027-02-02', outcome: 'rejected' },
      { report_id: routed, decided_day: '2027-02-03', outcome: 'routed' },
    ]);
    expect(await reportRow(db, rejected)).toMatchObject({ outcome: 'rejected', decided_by: null, reporter_ref: null, data_deleted_at: NOW });
  });

  it('leaves a decision\'s day empty for a pending report that expired, its cancelled approval\'s day aside', async () => {
    const db = open();
    const reportId = await insertReport(db, { created_at: CREATED });
    await insertApproval(db, reportId, { approvedAt: APPROVED, startsAt: APPROVED + 60_000, voidedAt: APPROVED + 30_000 });
    await db.run(sql`UPDATE reports SET status = 'expired', outcome = 'no_decision' WHERE id = ?`, [reportId]);
    await db.batch(finalizationStatements([reportId], NOW, ['expired']));
    expect(await db.all(sql`SELECT decided_day, outcome FROM stats`)).toEqual([{ decided_day: null, outcome: 'no_decision' }]);
    expect(await count(db, 'approvals', reportId)).toBe(0);
  });

  it('does nothing to a report in any other status, or finalized already, and a second run changes nothing', async () => {
    const db = open();
    const open1 = await insertReport(db, { status: 'pending' });
    const { reportId: closing } = await posted(db, 'closing');
    const { reportId: retracting } = await posted(db, 'retracting');
    const { reportId: closed } = await posted(db, 'closed');
    const before = await db.all(sql`SELECT * FROM reports WHERE id IN (?, ?, ?) ORDER BY id`, [open1, closing, retracting]);
    await db.batch(finalizationStatements([open1, closing, retracting, closed], NOW, ['closed', 'retracted', 'expired', 'rejected', 'routed']));
    expect(await db.all(sql`SELECT * FROM reports WHERE id IN (?, ?, ?) ORDER BY id`, [open1, closing, retracting])).toEqual(before);
    for (const id of [closing, retracting]) {
      expect(await count(db, 'approvals', id)).toBe(1);
      expect(await count(db, 'jobs', id)).toBe(1);
    }
    const once = await db.all(sql`SELECT * FROM stats`);
    const results = await db.batch(finalizationStatements([closed], NOW + DAY, ['closed']));
    expect(results.map((result) => result.changes)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(await db.all(sql`SELECT * FROM stats`)).toEqual(once);
  });

  it('binds the statuses it is given: a closed report is not finalized as a rejected one', async () => {
    const db = open();
    const { reportId } = await posted(db, 'closed');
    await db.batch(finalizationStatements([reportId], NOW, ['rejected', 'routed']));
    expect(await reportRow(db, reportId)).toMatchObject({ data_deleted_at: null, broadcast_text: '<b>the post</b>' });
  });

  it('finalizes a report without a keyed hash, which the intake never writes, leaving no aggregate row', async () => {
    const db = open();
    const reportId = await insertReport(db, { status: 'rejected', decided_at: NOW - 31 * DAY, link_hash: null });
    await db.batch(finalizationStatements([reportId], NOW, ['rejected']));
    expect(await db.all(sql`SELECT * FROM stats`)).toEqual([]);
    expect(await reportRow(db, reportId)).toMatchObject({ url: null, reporter_ref: null, data_deleted_at: NOW });
  });

  it('updates an aggregate row the report already has, never adding a second one', async () => {
    const db = open();
    const { reportId } = await posted(db, 'closed');
    await db.run(sql`INSERT INTO stats (report_id, category, platform, created_day, outcome, presses, link_hash) VALUES (?, 'other', 'instagram', '2026-01-01', 'stale', 0, ?)`, [reportId, hex(3, 'c')]);
    await db.batch(finalizationStatements([reportId], NOW, ['closed']));
    expect(await db.all(sql`SELECT report_id, category, outcome, presses FROM stats`)).toEqual([{ report_id: reportId, category: 'harassment', outcome: 'taken_down', presses: 17 }]);
  });

  it('takes none to FINALIZE_BATCH_LIMIT reports, and terminal statuses only', () => {
    expect(finalizationStatements([], NOW, ['closed'])).toEqual([]);
    const ids = Array.from({ length: FINALIZE_BATCH_LIMIT }, (_unused, n) => `${'q'.repeat(18)}${String.fromCharCode(97 + Math.floor(n / 26))}${String.fromCharCode(97 + (n % 26))}`);
    const statements = finalizationStatements(ids, NOW, ['closed', 'retracted', 'expired', 'rejected', 'routed']);
    expect(Math.max(...statements.map((statement) => statement.params.length))).toBeLessThanOrEqual(100);
    expect(() => finalizationStatements([...ids, 'abcdefghijklmnopqrst'], NOW, ['closed'])).toThrow();
    expect(() => finalizationStatements(['abcdefghijklmnopqrst'], NOW, [])).toThrow();
    expect(() => finalizationStatements(['abcdefghijklmnopqrst'], NOW, ['posted' as 'closed'])).toThrow();
  });
});

describe('rejectionDecayStatement', () => {
  it('counts the rejection off every reference of the report and its merged rows, once each, never below 0', async () => {
    const db = open();
    const reportId = await insertReport(db, { status: 'rejected', reporter_ref: hex(1), decided_at: NOW - 31 * DAY });
    await insertReport(db, { status: 'merged', merged_into: reportId, reporter_ref: hex(2), comment: null, affected_person: null });
    await insertReport(db, { status: 'merged', merged_into: reportId, reporter_ref: hex(1), comment: null, affected_person: null });
    await insertReporterStats(db, hex(1), { rejections: 3 });
    await insertReporterStats(db, hex(2), { rejections: 0 });
    await insertReporterStats(db, hex(3), { rejections: 2 });
    await db.batch([rejectionDecayStatement(reportId), ...finalizationStatements([reportId], NOW, ['rejected'])]);
    expect(await db.all(sql`SELECT reporter_ref, rejections_30d FROM reporter_stats ORDER BY reporter_ref`)).toEqual([
      { reporter_ref: hex(1), rejections_30d: 2 },
      { reporter_ref: hex(2), rejections_30d: 0 },
      { reporter_ref: hex(3), rejections_30d: 2 },
    ]);
  });

  it('counts nothing off for a report that is not rejected, or finalized already', async () => {
    const db = open();
    const routed = await insertReport(db, { status: 'routed', reporter_ref: hex(1), decided_at: NOW - 31 * DAY });
    const finalized = await insertReport(db, { status: 'rejected', reporter_ref: hex(1), decided_at: NOW - 31 * DAY });
    await db.run(sql`UPDATE reports SET data_deleted_at = ? WHERE id = ?`, [NOW - DAY, finalized]);
    await insertReporterStats(db, hex(1), { rejections: 3 });
    await db.batch([rejectionDecayStatement(routed), rejectionDecayStatement(finalized)]);
    expect(await db.all(sql`SELECT rejections_30d FROM reporter_stats`)).toEqual([{ rejections_30d: 3 }]);
  });
});

describe('concludeStatements', () => {
  it('concludes a closing report on its own post under its approval, and finalizes it in the same batch', async () => {
    const db = open();
    const { reportId } = await posted(db, 'closing');
    const postMessageId = Number((await reportRow(db, reportId))?.post_message_id);
    const results = await db.batch(concludeStatements({ from: 'closing', to: 'closed', reportId, postMessageId, now: NOW }));
    expect(results[CONCLUDE_STATUS_STATEMENT]?.changes).toBe(1);
    expect(await reportRow(db, reportId)).toMatchObject({ status: 'closed', closed_at: NOW, data_deleted_at: NOW, post_message_id: null });
    expect(await count(db, 'stats', reportId)).toBe(1);
  });

  it('concludes nothing for another post, without a live approval, not closing, or under /halt or the switch', async () => {
    for (const hold of ['other post', 'voided', 'retracting', 'halted', 'lockdown'] as const) {
      const db = open();
      const { reportId } = await posted(db, hold === 'retracting' ? 'retracting' : 'closing');
      const postMessageId = Number((await reportRow(db, reportId))?.post_message_id);
      if (hold === 'voided') await db.run(sql`UPDATE approvals SET voided_at = ? WHERE report_id = ?`, [NOW, reportId]);
      if (hold === 'halted' || hold === 'lockdown') await db.run(sql`INSERT INTO meta (key, value) VALUES (?, 1)`, [hold]);
      const before = await reportRow(db, reportId);
      const results = await db.batch(
        concludeStatements({ from: 'closing', to: 'closed', reportId, postMessageId: hold === 'other post' ? postMessageId + 1 : postMessageId, now: NOW }),
      );
      expect(results[CONCLUDE_STATUS_STATEMENT]?.changes, hold).toBe(0);
      expect(await reportRow(db, reportId), hold).toEqual(before);
      expect(await count(db, 'stats', reportId), hold).toBe(0);
    }
  });

  it('concludes a retraction under /halt and the switch, which hold closures only', async () => {
    const db = open();
    const { reportId } = await posted(db, 'retracting');
    await db.run(sql`INSERT INTO meta (key, value) VALUES ('halted', 1), ('lockdown', 1)`);
    const postMessageId = Number((await reportRow(db, reportId))?.post_message_id);
    const results = await db.batch(concludeStatements({ from: 'retracting', to: 'retracted', reportId, postMessageId, now: NOW }));
    expect(results[CONCLUDE_STATUS_STATEMENT]?.changes).toBe(1);
    expect(await reportRow(db, reportId)).toMatchObject({ status: 'retracted', correction_text: null, data_deleted_at: NOW });
  });
});

describe('finalizeTerminal', () => {
  it('finalizes a closed, retracted or expired row whose finalization never landed, and nothing else', async () => {
    const db = open();
    const done: string[] = [];
    for (const status of ['closed', 'retracted', 'expired'] as const) {
      const { reportId } = await posted(db, status);
      if (await finalizeTerminal({ db }, reportId, NOW)) done.push(status);
    }
    expect(done).toEqual(['closed', 'retracted', 'expired']);
    const rejected = await insertReport(db, { status: 'rejected', decided_at: NOW - DAY });
    const { reportId: closing } = await posted(db, 'closing');
    const { reportId: retracting } = await posted(db, 'retracting');
    for (const id of [rejected, closing, retracting]) expect(await finalizeTerminal({ db }, id, NOW), id).toBe(false);
    expect(await reportRow(db, closing)).toMatchObject({ data_deleted_at: null });
    expect(await reportRow(db, retracting)).toMatchObject({ correction_text: 'a correction', data_deleted_at: null });
  });
});

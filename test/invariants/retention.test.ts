// Always-run invariant spec, critical invariant 8: reports leave only
// counts behind, and every stored personal field has a deletion path, run
// by the code that deletes it (src/privacy/retention.ts, src/broadcast/
// finalize.ts and concluding.ts) over the fakes on node:sqlite, each path of
// the deletion schedule (doc/product/retention-and-minimisation.md) at its
// moment and not a moment before:
// - drafts after 24 hours; prompts after 24 hours; pending reports at 30
//   days (expired, no decision); rejected and routed rows 30 days after the
//   decision; posted reports set to expire at 90 days; finalized rows the
//   night after; idle reporter counters after 90 days, a blocked one kept;
//   daily counters after 90 days; jobs abandoned at 20 attempts;
// - every terminal path (closed, retracted, expired after its post,
//   expired without a decision, rejected, routed) leaves, after the night's
//   run, no row in any table that holds the report's id but its aggregate
//   row, whose columns are exactly the aggregate set; before that night the
//   report's own row holds no personal field any more, and its approval,
//   prompts, jobs and merged rows are gone;
// - at most FINALIZE_PER_RUN reports are finalized a night, the rest the
//   next; the job runs under either lockdown layer, and on a lockdown.
// The commit gate runs this file on every commit (`npm run test:invariants`).
import type { Update } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import { setLockdown } from '../../src/auth/lockdown';
import { orderClosure } from '../../src/broadcast/closure';
import { lockdownNow } from '../../src/broadcast/maintenance';
import { retractStatements } from '../../src/broadcast/retraction';
import { sql, type SqlDb, type SqlText } from '../../src/db/sql';
import { ABANDON_ATTEMPTS, FINALIZE_PER_RUN, retention } from '../../src/privacy/retention';
import { createPrompt } from '../../src/review/prompts';
import { reviewIn, type SubmittedReport } from '../support/review-driver';
import { hex, insertApproval, insertReport, reportRow } from '../support/review-rows';
import { isOwnTable } from '../support/schema-description';
import { plantPosted, TICK_AT, tickHarness, type TickHarness } from '../support/tick-harness';
import { IDS } from '../support/variables';
import { privateMessage } from '../support/updates';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;
const CORRECTION = 'The admins were wrong about this account; please do not report it.';

/** The aggregate row's columns, the one thing that remains of a report. */
const AGGREGATE_COLUMNS = ['category', 'closed_day', 'created_day', 'decided_day', 'link_hash', 'outcome', 'platform', 'presses', 'report_id'];
/** The report row's personal and content fields: null once it is finalized. */
const PERSONAL_FIELDS = [
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
];

/** The retention job of the night of `day` (2027, UTC), at 00:15. */
const night = (harness: TickHarness, month: number, day: number) => {
  const at = Date.UTC(2027, month, day, 0, 15);
  harness.clock.set(at);
  return retention(harness.deps, at);
};

/** Every (table, column) of the store that holds `value`. */
const holders = (harness: TickHarness, value: string): string[] => {
  const tables = harness.connection
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => String(row.name))
    .filter(isOwnTable);
  const found: string[] = [];
  for (const table of tables) {
    for (const row of harness.connection.prepare(`SELECT * FROM ${table}`).all()) {
      for (const [column, cell] of Object.entries(row)) if (String(cell).includes(value)) found.push(`${table}.${column}`);
    }
  }
  return [...new Set(found)].sort();
};

const count = async (db: SqlDb, text: SqlText, params: readonly (string | number)[] = []) =>
  Number((await db.first<{ n: number }>(text, params))?.n ?? 0);

/** A report submitted through the real intake and approved through the real review, then posted by the runs; a duplicate merged into it. */
const reviewedAndPosted = async (harness: TickHarness): Promise<SubmittedReport> => {
  const review = reviewIn(harness);
  const report = await review.submit({ url: 'https://x.com/someone/status/1234567890', category: 'harassment', affected: false, comment: 'a comment that names someone' });
  await review.approve(IDS.admin, report, { category: 'harassment', mode: 'account', points: 'Say it mocks a private person every day.' });
  await review.submit({ url: 'https://x.com/someone/status/1234567890', category: 'harassment', affected: true, comment: 'the same target' }, IDS.stranger);
  const start = harness.clock.now();
  for (let at = start; at <= start + 32 * MINUTE; at += MINUTE) {
    harness.clock.set(at);
    await harness.run(at);
  }
  expect((await reportRow(harness.db, report.reportId))?.status).toBe('posted');
  return report;
};

describe('critical invariant 8: every deletion path of the schedule, at its moment', () => {
  it('deletes a draft 24 hours after it was started, and not before', async () => {
    const harness = tickHarness();
    const draft = sql`INSERT INTO drafts (draft_key, step, url, platform, comment, locale, created_at, updated_at) VALUES (?, 'comment', 'https://x.com/someone', 'x', 'a comment', 'en', ?, ?)`;
    const start = Date.UTC(2027, 1, 1, 0, 15) - DAY;
    await harness.db.run(draft, [hex(1), start, start]);
    await harness.db.run(draft, [hex(2), start + 1, start + 1]);
    await night(harness, 1, 1);
    expect(await harness.db.all(sql`SELECT draft_key FROM drafts`)).toEqual([{ draft_key: hex(2) }]);
    await night(harness, 1, 2);
    expect(await harness.db.all(sql`SELECT draft_key FROM drafts`)).toEqual([]);
  });

  it('deletes a prompt 24 hours after it was sent, and not before', async () => {
    const harness = tickHarness();
    const reportId = await insertReport(harness.db, { created_at: Date.UTC(2027, 1, 1) });
    const start = Date.UTC(2027, 1, 1, 0, 15) - DAY;
    for (const [messageId, createdAt] of [[1, start], [2, start + 1]] as const) {
      await createPrompt(harness.db, { chatId: IDS.adminChat, promptMessageId: messageId, adminId: IDS.admin, reportId, kind: 'recommended_comment', category: 'harassment', linkMode: 'account', createdAt });
    }
    await night(harness, 1, 1);
    expect(await harness.db.all(sql`SELECT prompt_message_id FROM admin_prompts`)).toEqual([{ prompt_message_id: 2 }]);
  });

  it('expires a pending report 30 days after intake, without a decision, its comment, flag and links gone, and not before', async () => {
    const harness = tickHarness();
    const run = Date.UTC(2027, 2, 1, 0, 15);
    const due = await insertReport(harness.db, { created_at: run - 30 * DAY, card_message_id: null });
    const early = await insertReport(harness.db, { created_at: run - 30 * DAY + 1, card_message_id: null });
    await night(harness, 2, 1);
    expect(await reportRow(harness.db, due)).toBeNull();
    expect(await harness.db.all(sql`SELECT report_id, outcome FROM stats`)).toEqual([{ report_id: due, outcome: 'no_decision' }]);
    expect(await reportRow(harness.db, early)).toMatchObject({ status: 'pending', comment: 'a comment of the reporter', affected_person: 0 });
  });

  it.each(['rejected', 'routed'] as const)('finalizes a %s row 30 days after its decision, and not before', async (status) => {
    const harness = tickHarness();
    const run = Date.UTC(2027, 2, 1, 0, 15);
    const due = await insertReport(harness.db, { status, created_at: run - 40 * DAY, decided_at: run - 30 * DAY, decided_by: IDS.admin, card_message_id: null });
    const early = await insertReport(harness.db, { status, created_at: run - 40 * DAY, decided_at: run - 30 * DAY + 1, decided_by: IDS.admin, card_message_id: null });
    await night(harness, 2, 1);
    expect(await reportRow(harness.db, due)).toBeNull();
    expect(await harness.db.all(sql`SELECT report_id, outcome FROM stats`)).toEqual([{ report_id: due, outcome: status }]);
    expect(await reportRow(harness.db, early)).toMatchObject({ status, reporter_ref: hex(1), decided_by: IDS.admin, data_deleted_at: null });
  });

  it('sets a posted report to expire 90 days after its post, and not before', async () => {
    const harness = tickHarness();
    const run = Date.UTC(2027, 3, 15, 0, 15);
    const ids: string[] = [];
    for (const postedAt of [run - 90 * DAY, run - 90 * DAY + 1]) {
      const reportId = await insertReport(harness.db, { status: 'posted', created_at: postedAt - DAY, posting_started_at: postedAt, posted_at: postedAt, post_message_id: ids.length + 1 });
      await insertApproval(harness.db, reportId, { approvedAt: postedAt - HOUR, startsAt: postedAt - MINUTE });
      ids.push(reportId);
    }
    await night(harness, 3, 15);
    expect(await reportRow(harness.db, ids[0] ?? '')).toMatchObject({ status: 'closing', outcome: 'expired' });
    expect(await reportRow(harness.db, ids[1] ?? '')).toMatchObject({ status: 'posted', outcome: null });
  });

  it('deletes idle reporter counters after 90 days, a blocked one kept for good', async () => {
    const harness = tickHarness();
    const stats = sql`INSERT INTO reporter_stats (reporter_ref, open_count, day, day_count, rejections_30d, blocked, last_seen) VALUES (?, 0, ?, 1, 1, ?, ?)`;
    await harness.db.run(stats, [hex(1), '2027-01-01', 0, '2027-01-01']);
    await harness.db.run(stats, [hex(2), '2027-01-02', 0, '2027-01-02']);
    await harness.db.run(stats, [hex(3), '2026-01-01', 1, '2026-01-01']);
    // 2027-04-01 is 90 days after 2027-01-01.
    await night(harness, 3, 1);
    expect(await harness.db.all(sql`SELECT reporter_ref FROM reporter_stats ORDER BY reporter_ref`)).toEqual([{ reporter_ref: hex(1) }, { reporter_ref: hex(2) }, { reporter_ref: hex(3) }]);
    await night(harness, 3, 2);
    expect(await harness.db.all(sql`SELECT reporter_ref FROM reporter_stats ORDER BY reporter_ref`)).toEqual([{ reporter_ref: hex(2) }, { reporter_ref: hex(3) }]);
  });

  it('deletes a day\'s counters after 90 days', async () => {
    const harness = tickHarness();
    await harness.db.run(sql`INSERT INTO counters (day, key, count) VALUES ('2027-01-01', 'presses', 9), ('2027-01-02', 'intake_non_member', 3)`);
    await night(harness, 3, 1);
    expect(await count(harness.db, sql`SELECT count(*) AS n FROM counters`)).toBe(2);
    await night(harness, 3, 2);
    expect(await harness.db.all(sql`SELECT day FROM counters`)).toEqual([{ day: '2027-01-02' }]);
  });

  it('abandons a job at 20 failed attempts, and not at 19, finalizing nothing', async () => {
    const harness = tickHarness();
    const posted = await plantPosted(harness);
    expect(await orderClosure(harness.deps, posted.reportId, 'taken_down')).toBe('closing');
    await harness.db.run(sql`UPDATE jobs SET attempts = ? WHERE report_id = ?`, [ABANDON_ATTEMPTS - 1, posted.reportId]);
    await night(harness, 0, 16);
    expect(await count(harness.db, sql`SELECT count(*) AS n FROM jobs WHERE report_id = ?`, [posted.reportId])).toBe(1);
    await harness.db.run(sql`UPDATE jobs SET attempts = ? WHERE report_id = ?`, [ABANDON_ATTEMPTS, posted.reportId]);
    await night(harness, 0, 17);
    expect(await count(harness.db, sql`SELECT count(*) AS n FROM jobs WHERE report_id = ?`, [posted.reportId])).toBe(0);
    expect(await reportRow(harness.db, posted.reportId)).toMatchObject({ status: 'closing', post_message_id: posted.postMessageId, broadcast_text: posted.text, data_deleted_at: null });
  });
});

describe('critical invariant 8: a concluded report leaves only its aggregate row', () => {
  /** Every table and column holding `reportId` after the night after `conclude`. */
  const afterTheNight = async (harness: TickHarness, reportId: string, merged: readonly string[]) => {
    const row = await reportRow(harness.db, reportId);
    expect(row?.data_deleted_at).not.toBeNull();
    for (const field of PERSONAL_FIELDS) expect(row?.[field], field).toBeNull();
    for (const table of ['approvals', 'admin_prompts', 'jobs'] as const) {
      const statement =
        table === 'approvals'
          ? sql`SELECT count(*) AS n FROM approvals WHERE report_id = ?`
          : table === 'admin_prompts'
            ? sql`SELECT count(*) AS n FROM admin_prompts WHERE report_id = ?`
            : sql`SELECT count(*) AS n FROM jobs WHERE report_id = ?`;
      expect(await count(harness.db, statement, [reportId]), table).toBe(0);
    }
    for (const id of merged) expect(await reportRow(harness.db, id), id).toBeNull();
    // Before the night: its own row, holding its state alone, and the aggregate row.
    expect(holders(harness, reportId)).toEqual(['reports.id', 'stats.report_id']);
    const at = harness.clock.now() + DAY;
    harness.clock.set(at);
    await retention(harness.deps, at);
    expect(holders(harness, reportId)).toEqual(['stats.report_id']);
    const aggregate = await harness.db.first<Record<string, unknown>>(sql`SELECT * FROM stats WHERE report_id = ?`, [reportId]);
    expect(Object.keys(aggregate ?? {}).sort()).toEqual(AGGREGATE_COLUMNS);
  };

  const mergedOf = async (harness: TickHarness, reportId: string): Promise<string[]> =>
    (await harness.db.all<{ id: string }>(sql`SELECT id FROM reports WHERE merged_into = ?`, [reportId])).map((row) => row.id);

  it('closed: reviewed, posted, closed by an admin', async () => {
    const harness = tickHarness();
    const report = await reviewedAndPosted(harness);
    const merged = await mergedOf(harness, report.reportId);
    expect(merged).toHaveLength(1);
    expect(await orderClosure(harness.deps, report.reportId, 'taken_down')).toBe('closing');
    await harness.run(harness.clock.now() + MINUTE);
    await afterTheNight(harness, report.reportId, merged);
    expect(await harness.db.all(sql`SELECT outcome FROM stats`)).toEqual([{ outcome: 'taken_down' }]);
  });

  it("retracted: reviewed, posted, retracted by a keyholder's prompt and reply", async () => {
    const harness = tickHarness();
    const report = await reviewedAndPosted(harness);
    const merged = await mergedOf(harness, report.reportId);
    await harness.send(privateMessage(IDS.keyholder, `/retract ${report.reportId}`));
    const prompt = harness.telegram.messagesIn(IDS.keyholder).filter((message) => (message.reply_markup as { force_reply?: boolean } | undefined)?.force_reply === true).at(-1);
    const replyId = harness.telegram.receive(IDS.keyholder, { text: CORRECTION });
    const reply = privateMessage(IDS.keyholder, CORRECTION, { replyToBot: prompt?.message_id ?? 0 });
    await harness.send({ ...reply, message: { ...reply.message, message_id: replyId } } as Update);
    await harness.run(harness.clock.now() + MINUTE);
    await afterTheNight(harness, report.reportId, merged);
    expect(await harness.db.all(sql`SELECT outcome FROM stats`)).toEqual([{ outcome: 'retracted' }]);
  });

  it('expired: posted, and set to expire 90 days after its post', async () => {
    const harness = tickHarness();
    const posted = await plantPosted(harness);
    const at = TICK_AT + 90 * DAY;
    harness.clock.set(at);
    await retention(harness.deps, at);
    await harness.run(at + MINUTE);
    await afterTheNight(harness, posted.reportId, []);
    expect(await harness.db.all(sql`SELECT outcome FROM stats`)).toEqual([{ outcome: 'expired' }]);
  });

  it('expired without a decision, rejected, routed: finalized by the night, then deleted by the next', async () => {
    for (const status of ['pending', 'rejected', 'routed'] as const) {
      const harness = tickHarness();
      const at = Date.UTC(2027, 2, 1, 0, 15);
      const reportId = await insertReport(harness.db, {
        status,
        created_at: at - 40 * DAY,
        decided_at: status === 'pending' ? null : at - 31 * DAY,
        decided_by: status === 'pending' ? null : IDS.admin,
        card_message_id: null,
      });
      const merged = await insertReport(harness.db, { status: 'merged', merged_into: reportId, reporter_ref: hex(5), comment: null, affected_person: null, created_at: at - 39 * DAY });
      await createPrompt(harness.db, { chatId: IDS.adminChat, promptMessageId: 7, adminId: IDS.admin, reportId, kind: 'recommended_comment', category: 'harassment', linkMode: 'account', createdAt: at - HOUR });
      // The night's own deletion would leave nothing to look at: finalize it as the night does, then look.
      const stub = harness.deps;
      harness.clock.set(at);
      await retention({ ...stub, db: { ...stub.db, run: (text, params) => (String(text).startsWith('DELETE FROM reports WHERE data_deleted_at') ? Promise.resolve({ changes: 0 }) : stub.db.run(text, params)) } }, at);
      await afterTheNight(harness, reportId, [merged]);
    }
  });
});

describe('critical invariant 8: the bound and the holds', () => {
  it('finalizes at most FINALIZE_PER_RUN reports a night, the rest the next', async () => {
    const harness = tickHarness();
    const run = Date.UTC(2027, 2, 1, 0, 15);
    for (let n = 0; n < FINALIZE_PER_RUN + 7; n += 1) await insertReport(harness.db, { created_at: run - 31 * DAY - n, card_message_id: null });
    expect((await night(harness, 2, 1)).finalized).toBe(FINALIZE_PER_RUN);
    expect(await count(harness.db, sql`SELECT count(*) AS n FROM reports`)).toBe(7);
    expect((await night(harness, 2, 2)).finalized).toBe(7);
    expect(await count(harness.db, sql`SELECT count(*) AS n FROM reports`)).toBe(0);
  });

  it('runs under either lockdown layer, and at once on a lockdown', async () => {
    for (const layer of ['switch', 'override', 'lockdownNow'] as const) {
      const harness = tickHarness(layer === 'override' ? { variables: { LOCKDOWN: '1' } } : {});
      const at = Date.UTC(2027, 2, 1, 0, 15);
      harness.clock.set(at);
      await insertReport(harness.db, { created_at: at - 31 * DAY, card_message_id: null });
      await harness.db.run(sql`INSERT INTO drafts (draft_key, step, locale, created_at, updated_at) VALUES (?, 'url', 'en', ?, ?)`, [hex(1), at - 2 * DAY, at - 2 * DAY]);
      if (layer === 'switch') await setLockdown(harness.db, harness.clock);
      if (layer === 'lockdownNow') await lockdownNow(harness.deps);
      else await harness.run(at);
      expect(await count(harness.db, sql`SELECT count(*) AS n FROM reports`), layer).toBe(0);
      expect(await count(harness.db, sql`SELECT count(*) AS n FROM drafts`), layer).toBe(0);
    }
  });

  it('a retraction under lockdown concludes and finalizes like any other', async () => {
    const harness = tickHarness();
    const posted = await plantPosted(harness);
    await setLockdown(harness.db, harness.clock);
    await harness.db.batch(retractStatements({ reportId: posted.reportId, correction: CORRECTION, now: TICK_AT, byAdmin: false, prompt: { chatId: IDS.keyholder, promptMessageId: 1 } }));
    await harness.run(TICK_AT + MINUTE);
    expect(await reportRow(harness.db, posted.reportId)).toMatchObject({ status: 'retracted', correction_text: null, post_message_id: null });
  });
});

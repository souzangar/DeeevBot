// Unit tests for the D1 schema (migrations/0001_init.sql) on node:sqlite,
// where the invariants tier runs too: the tables equal what D1 builds from
// the same file (test/support/expected-schema.ts, also checked on D1 by
// test/workers/d1.test.ts), CHECK constraints and the trigger included; a
// full row in every table; the approval due query and the cron's job due
// query; the query plans the indexes exist for (every index row costs a D1
// row written, so each must earn it); and the constraints that refuse a
// malformed row. The approval trigger's behaviour is critical invariant 1's
// own spec (test/invariants/approval-record.test.ts).
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeClock } from '../../test/fakes/clock';
import { D1_SCHEMA } from '../../test/support/expected-schema';
import { checksOf, describeSchema } from '../../test/support/schema-description';
import { randomId } from './ids';
import { migrate } from './migrate';
import { openNodeSqlite, type NodeSqlite } from './node-sqlite';
import { sql, type SqlText, type SqlValue } from './sql';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url).href);
const NOW = 1_800_000_000_000;
const DAY = '2027-01-15';
const HEX = 'ab'.repeat(32);
const OTHER_HEX = 'cd'.repeat(32);
const id = (name: string): string => name.padEnd(20, 'x');

let database: NodeSqlite;

beforeEach(() => {
  database = openNodeSqlite(':memory:');
  migrate(database.connection, MIGRATIONS_DIR, fakeClock(NOW));
});

const run = async (text: SqlText, params: readonly SqlValue[] = []): Promise<void> => {
  await database.db.run(text, params);
};

const rows = (text: SqlText, params: readonly SqlValue[] = []) => database.db.all(text, params);

/** The query plan's details, one line per step. */
const planOf = (text: SqlText, params: readonly SqlValue[]): string =>
  database.connection
    .prepare(`EXPLAIN QUERY PLAN ${text}`)
    .all(...params)
    .map((row) => String(row.detail))
    .join('\n');

const insertReport = (reportId: string, status: string, extra: Record<string, SqlValue> = {}): void => {
  const columns = ['id', 'status', 'platform', 'category', 'created_at', ...Object.keys(extra)];
  const values = [reportId, status, 'instagram', 'private_data', NOW, ...Object.values(extra)];
  database.connection
    .prepare(`INSERT INTO reports (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .run(...values);
};

/** An approval given a 5-minute grace before `startsAt`, under a fresh approval id, which it returns. */
const approve = async (reportId: string, startsAt: number, voidedAt: number | null = null): Promise<string> => {
  const approvalId = randomId();
  await run(
    sql`INSERT INTO approvals (report_id, approval_id, admin_id, approved_at, link_mode, recommended_comment, starts_at, voided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [reportId, approvalId, 424242001, startsAt - 300_000, 'account', 'report it as private information', startsAt, voidedAt],
  );
  return approvalId;
};

/** The columns a posted report carries: the mark that the post started, and its time. */
const POSTED = { posting_started_at: NOW - 2_000, posted_at: NOW - 1_000 };

const enqueue = (jobId: string, kind: string, reportId: string, dueAt: number): Promise<void> =>
  run(sql`INSERT INTO jobs (id, kind, report_id, due_at, created_at) VALUES (?, ?, ?, ?, ?)`, [
    jobId,
    kind,
    reportId,
    dueAt,
    NOW,
  ]);

describe('the D1 schema on node:sqlite', () => {
  it('builds exactly the tables D1 builds from the same file', async () => {
    const raw = (text: string) => Promise.resolve(database.connection.prepare(text).all().map((row) => ({ ...row })));
    expect(await describeSchema(raw)).toEqual(D1_SCHEMA);
  });

  it('states its schema version in meta', async () => {
    expect(await rows(sql`SELECT key, value FROM meta`)).toEqual([{ key: 'schema_version', value: 2 }]);
  });

  it('holds a full row in every table', async () => {
    await run(
      sql`INSERT INTO drafts (draft_key, step, url, platform, account_url, category, affected_person, comment, locale, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [HEX, 'comment', 'https://example.org/p/1', 'instagram', 'https://example.org/a', 'harassment', 0, 'a note', 'fa', NOW, NOW],
    );
    insertReport(id('fullreport'), 'posted', {
      url: 'https://example.org/p/1',
      account_url: 'https://example.org/a',
      comment: 'a note',
      affected_person: 1,
      reporter_ref: HEX,
      link_hash: OTHER_HEX,
      decided_at: NOW,
      decided_by: 424242001,
      rejection_reason: null,
      broadcast_text: 'the post',
      correction_text: 'the correction',
      link_mode: 'account_and_post',
      card_message_id: 10,
      status_message_id: 11,
      post_message_id: 12,
      posting_started_at: NOW + 300_000,
      posted_at: NOW + 301_000,
      presses: 42,
      alert_sent_at: null,
      needs_attention: 0,
      data_deleted_at: null,
      closed_at: null,
      outcome: null,
    });
    insertReport(id('mergedreport'), 'merged', { merged_into: id('fullreport'), link_hash: OTHER_HEX });
    await approve(id('fullreport'), NOW + 300_000);
    await run(
      sql`INSERT INTO admin_prompts (chat_id, prompt_message_id, admin_id, report_id, kind, link_mode, created_at, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [-1001424242, 99, 424242001, id('fullreport'), 'recommended_comment', 'account', NOW, 'private_data'],
    );
    await run(
      sql`INSERT INTO reporter_stats (reporter_ref, open_count, day, day_count, rejections_30d, blocked, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [HEX, 1, DAY, 1, 0, 0, DAY],
    );
    await run(sql`INSERT INTO counters (day, key, count) VALUES (?, ?, ?)`, [DAY, 'presses', 3]);
    await run(
      sql`INSERT INTO stats (report_id, category, platform, created_day, decided_day, closed_day, outcome, presses, link_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id('fullreport'), 'private_data', 'instagram', DAY, DAY, DAY, 'taken_down', 42, OTHER_HEX],
    );
    await run(
      sql`INSERT INTO jobs (id, kind, report_id, due_at, payload, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id('editjob'), 'edit', id('fullreport'), NOW, '{"text":"correction"}', 1, NOW],
    );
    await run(sql`INSERT INTO meta (key, value) VALUES (?, ?)`, ['halted', 1]);
    expect(
      await rows(
        sql`SELECT (SELECT count(*) FROM drafts) + (SELECT count(*) FROM reports) + (SELECT count(*) FROM approvals) + (SELECT count(*) FROM admin_prompts) + (SELECT count(*) FROM reporter_stats) + (SELECT count(*) FROM counters) + (SELECT count(*) FROM stats) + (SELECT count(*) FROM jobs) + (SELECT count(*) FROM meta) AS n`,
      ),
    ).toEqual([{ n: 11 }]);
  });

  it('defaults a new report to pending, no presses, no attention flag', async () => {
    await run(sql`INSERT INTO reports (id, platform, category, created_at) VALUES (?, ?, ?, ?)`, [id('bare'), 'x', 'other', NOW]);
    expect(await rows(sql`SELECT status, presses, needs_attention FROM reports WHERE id = ?`, [id('bare')])).toEqual([
      { status: 'pending', presses: 0, needs_attention: 0 },
    ]);
  });
});

describe('the approval due query: approved, un-voided, starts_at reached', () => {
  const DUE = sql`SELECT a.report_id FROM approvals AS a JOIN reports AS r ON r.id = a.report_id WHERE a.voided_at IS NULL AND a.starts_at <= ? AND r.status = 'approved' ORDER BY a.starts_at LIMIT ?`;

  it('returns only the approved, un-voided approvals whose start has come, earliest first', async () => {
    insertReport(id('duelater'), 'approved');
    await approve(id('duelater'), NOW - 10);
    insertReport(id('dueearlier'), 'approved');
    await approve(id('dueearlier'), NOW - 20);
    insertReport(id('future'), 'approved');
    await approve(id('future'), NOW + 1);
    insertReport(id('voided'), 'approved');
    await approve(id('voided'), NOW - 30, NOW - 5);
    // Cancelled within the grace: back to pending, its approval voided
    insertReport(id('cancelled'), 'pending');
    await approve(id('cancelled'), NOW - 40, NOW - 35);
    // posted already
    insertReport(id('posted'), 'posted', POSTED);
    await approve(id('posted'), NOW - 50);
    expect(await rows(DUE, [NOW, 10])).toEqual([{ report_id: id('dueearlier') }, { report_id: id('duelater') }]);
    expect(await rows(DUE, [NOW, 1])).toEqual([{ report_id: id('dueearlier') }]);
  });

  it('is index-driven: from the few approved reports to their approval rows, no table scan', () => {
    const plan = planOf(DUE, [NOW, 1]);
    expect(plan).toContain('SEARCH r USING INDEX reports_by_status (status=?)');
    expect(plan).toContain('SEARCH a USING PRIMARY KEY (report_id=?)');
    expect(plan).not.toMatch(/\bSCAN\b/);
  });

  it('serves an approvals-side read of the un-voided starts from the partial index', () => {
    const earliest = sql`SELECT report_id, starts_at FROM approvals WHERE voided_at IS NULL AND starts_at <= ? ORDER BY starts_at LIMIT ?`;
    expect(planOf(earliest, [NOW, 1])).toContain('SEARCH approvals USING INDEX approvals_due (starts_at<?)');
  });

  it('takes a re-approval after Cancel as an upsert over the voided row, under a new approval id', async () => {
    insertReport(id('reapproved'), 'pending');
    const cancelled = await approve(id('reapproved'), NOW - 100, NOW - 90);
    const fresh = randomId();
    await database.db.batch([
      {
        sql: sql`INSERT INTO approvals (report_id, approval_id, admin_id, approved_at, link_mode, recommended_comment, starts_at, voided_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT (report_id) DO UPDATE SET approval_id = excluded.approval_id, admin_id = excluded.admin_id, approved_at = excluded.approved_at, link_mode = excluded.link_mode, recommended_comment = excluded.recommended_comment, starts_at = excluded.starts_at, voided_at = NULL`,
        params: [id('reapproved'), fresh, 424242002, NOW - 5, 'account', 'again', NOW - 1],
      },
      { sql: sql`UPDATE reports SET status = 'approved' WHERE id = ? AND status = 'pending'`, params: [id('reapproved')] },
    ]);
    expect(await rows(DUE, [NOW, 10])).toEqual([{ report_id: id('reapproved') }]);
    expect(await rows(sql`SELECT approval_id, admin_id FROM approvals`)).toEqual([{ approval_id: fresh, admin_id: 424242002 }]);
    expect(fresh).not.toBe(cancelled);
  });
});

describe("the cron's job queue", () => {
  const DUE_JOBS = sql`SELECT id, kind, report_id FROM jobs WHERE due_at <= ? ORDER BY due_at LIMIT ?`;
  const ENQUEUE = sql`INSERT INTO jobs (id, kind, report_id, due_at, payload, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (kind, report_id) DO NOTHING`;

  it('returns the due jobs, earliest first, from the due index', async () => {
    insertReport(id('first'), 'approved');
    insertReport(id('second'), 'retracted');
    await enqueue(id('postjob'), 'post', id('first'), NOW - 5);
    await enqueue(id('editjob'), 'edit', id('second'), NOW - 10);
    await enqueue(id('laterjob'), 'edit', id('first'), NOW + 60_000);
    expect(await rows(DUE_JOBS, [NOW, 10])).toEqual([
      { id: id('editjob'), kind: 'edit', report_id: id('second') },
      { id: id('postjob'), kind: 'post', report_id: id('first') },
    ]);
    expect(planOf(DUE_JOBS, [NOW, 10])).toContain('SEARCH jobs USING INDEX jobs_due (due_at<?)');
  });

  it('keeps one job per kind and report: an enqueue never resets an existing one', async () => {
    insertReport(id('editing'), 'retracted');
    await run(ENQUEUE, [id('editjob'), 'edit', id('editing'), NOW, '{"text":"first"}', NOW]);
    await run(sql`UPDATE jobs SET attempts = 3, due_at = ? WHERE kind = 'edit' AND report_id = ?`, [NOW + 900, id('editing')]);
    await run(ENQUEUE, [id('freshjob'), 'edit', id('editing'), NOW + 1, '{"text":"second"}', NOW + 1]);
    expect(await rows(sql`SELECT id, due_at, attempts, payload FROM jobs`)).toEqual([
      { id: id('editjob'), due_at: NOW + 900, attempts: 3, payload: '{"text":"first"}' },
    ]);
    await expect(run(ENQUEUE, [id('editjob'), 'post', id('editing'), NOW, '{}', NOW])).rejects.toMatchObject({
      code: 'STORAGE_FAILURE',
    });
  });
});

describe('the indexes serve the queries they exist for', () => {
  it.each([
    ['a by-status scan', sql`SELECT id FROM reports WHERE status = ? AND data_deleted_at IS NULL`, ['closed'], 'reports_by_status'],
    ['the duplicate check', sql`SELECT id FROM reports WHERE link_hash = ? AND status = ?`, [HEX, 'pending'], 'reports_by_link_hash'],
    ["a reference's reports", sql`SELECT id FROM reports WHERE reporter_ref = ?`, [HEX], 'reports_by_reporter_ref'],
    ['the rows merged into a primary', sql`SELECT id FROM reports WHERE merged_into = ?`, [id('primary')], 'reports_by_merged_into'],
    [
      'a primary and its merged rows',
      sql`UPDATE reports SET url = NULL WHERE id = ? OR merged_into = ?`,
      [id('primary'), id('primary')],
      'reports_by_merged_into',
    ],
    ["a report's prompts", sql`DELETE FROM admin_prompts WHERE report_id = ?`, [id('primary')], 'admin_prompts_by_report'],
    ["a post's report", sql`SELECT id FROM reports WHERE post_message_id = ?`, [12], 'reports_by_post_message_id'],
    ['the previously-reported lookup', sql`SELECT outcome FROM stats WHERE link_hash = ?`, [HEX], 'stats_by_link_hash'],
  ])('%s', (_label, text, params, index) => {
    expect(planOf(text, params)).toContain(`INDEX ${index}`);
  });

  it('serves the 90-day counter deletion from the primary key', () => {
    expect(planOf(sql`DELETE FROM counters WHERE day < ?`, [DAY])).toMatch(/SEARCH counters USING PRIMARY KEY/);
  });
});

describe('the constraints', () => {
  const refused = async (text: SqlText, params: readonly SqlValue[], failure: RegExp): Promise<void> => {
    const caught: unknown = await database.db.run(text, params).catch((error: unknown) => error);
    expect(caught, `expected ${failure.source}`).toMatchObject({ code: 'STORAGE_FAILURE' });
    expect(String((caught as { cause?: unknown }).cause)).toMatch(failure);
  };
  const report = sql`INSERT INTO reports (id, status, platform, category, created_at) VALUES (?, ?, ?, ?, ?)`;

  it('refuses a report id that is not 20 lowercase letters, and a self-merge', async () => {
    for (const bad of ['short', `${'a'.repeat(19)}1`, 'A'.repeat(20), `${'a'.repeat(19)}_`]) {
      await refused(report, [bad, 'pending', 'x', 'other', NOW], /CHECK constraint failed/);
    }
    await refused(
      sql`INSERT INTO reports (id, platform, category, created_at, merged_into) VALUES (?, ?, ?, ?, ?)`,
      [id('self'), 'x', 'other', NOW, id('self')],
      /CHECK constraint failed|FOREIGN KEY constraint failed/,
    );
  });

  it('takes every status of the lifecycle, closing and retracting included', async () => {
    const statuses = ['pending', 'approved', 'posting', 'posted', 'closing', 'retracting', 'closed', 'retracted', 'expired', 'rejected', 'routed', 'merged'];
    for (const [index, status] of statuses.entries()) {
      insertReport(id(`status${'abcdefghijkl'.charAt(index)}`), status, status === 'posted' ? POSTED : {});
    }
    expect(await rows(sql`SELECT status FROM reports ORDER BY id`)).toEqual(statuses.map((status) => ({ status })));
  });

  it('refuses a status outside the lifecycle and a job kind other than post or edit', async () => {
    await refused(report, [id('status'), 'finalizing', 'x', 'other', NOW], /CHECK constraint failed/);
    insertReport(id('jobkind'), 'approved');
    for (const kind of ['batch', 'closure', 'retraction', 'cap_retry']) {
      await refused(
        sql`INSERT INTO jobs (id, kind, report_id, due_at, created_at) VALUES (?, ?, ?, ?, ?)`,
        [id(`job${kind.replace('_', '')}`), kind, id('jobkind'), NOW, NOW],
        /CHECK constraint failed/,
      );
    }
  });

  it('refuses a post recorded as made without the mark that it started', async () => {
    insertReport(id('postmark'), 'posting');
    await refused(
      sql`UPDATE reports SET post_message_id = ?, posted_at = ? WHERE id = ?`,
      [12, NOW, id('postmark')],
      /CHECK constraint failed/,
    );
    await run(sql`UPDATE reports SET posting_started_at = ? WHERE id = ?`, [NOW, id('postmark')]);
    await refused(sql`UPDATE reports SET posted_at = ? WHERE id = ?`, [NOW - 1, id('postmark')], /CHECK constraint failed/);
    await run(sql`UPDATE reports SET post_message_id = ?, posted_at = ? WHERE id = ?`, [12, NOW + 900, id('postmark')]);
  });

  it('refuses a posted report without its posted time', async () => {
    await refused(report, [id('postedbare'), 'posted', 'x', 'other', NOW], /CHECK constraint failed/);
    insertReport(id('stillposting'), 'posting', { posting_started_at: NOW });
    await refused(sql`UPDATE reports SET status = 'posted' WHERE id = ?`, [id('stillposting')], /CHECK constraint failed/);
    await run(sql`UPDATE reports SET status = 'posted', post_message_id = ?, posted_at = ? WHERE id = ?`, [12, NOW + 1, id('stillposting')]);
  });

  it('refuses two reports holding the same post, and takes any number without one', async () => {
    insertReport(id('firstpost'), 'posted', { ...POSTED, post_message_id: 12 });
    insertReport(id('secondpost'), 'posting', { posting_started_at: NOW });
    await refused(
      sql`UPDATE reports SET status = 'posted', post_message_id = ?, posted_at = ? WHERE id = ?`,
      [12, NOW + 1, id('secondpost')],
      /UNIQUE constraint failed: reports\.post_message_id/,
    );
    insertReport(id('nopostone'), 'pending');
    insertReport(id('noposttwo'), 'pending');
    expect(await rows(sql`SELECT count(*) AS n FROM reports WHERE post_message_id IS NULL`)).toEqual([{ n: 3 }]);
  });

  it('refuses an approval id that is not 20 lowercase letters, or one used twice', async () => {
    const approval = sql`INSERT INTO approvals (report_id, approval_id, admin_id, approved_at, link_mode, recommended_comment, starts_at) VALUES (?, ?, ?, ?, ?, ?, ?)`;
    insertReport(id('approvalid'), 'pending');
    for (const bad of ['short', `${'a'.repeat(19)}1`, 'A'.repeat(20), `${'a'.repeat(19)}_`]) {
      await refused(approval, [id('approvalid'), bad, 424242001, NOW, 'account', 'c', NOW], /CHECK constraint failed/);
    }
    await refused(approval, [id('approvalid'), null, 424242001, NOW, 'account', 'c', NOW], /NOT NULL constraint failed/);
    const shared = await approve(id('approvalid'), NOW + 300_000);
    insertReport(id('otherapproval'), 'pending');
    await refused(
      approval,
      [id('otherapproval'), shared, 424242001, NOW, 'account', 'c', NOW],
      /UNIQUE constraint failed: approvals\.approval_id/,
    );
  });

  it('keeps a meta value an integer or a short text, storing a whole JavaScript number as an integer', async () => {
    const write = sql`INSERT INTO meta (key, value) VALUES (?, ?)`;
    // node:sqlite binds every JavaScript number as a REAL; the INTEGER affinity stores a whole one as an integer.
    await run(write, ['paused_until', NOW]);
    await run(write, ['halted', 1]);
    await run(write, ['short_text', 'x'.repeat(64)]);
    expect(await rows(sql`SELECT key, typeof(value) AS type FROM meta WHERE key <> 'schema_version' ORDER BY key`)).toEqual([
      { key: 'halted', type: 'integer' },
      { key: 'paused_until', type: 'integer' },
      { key: 'short_text', type: 'text' },
    ]);
    await refused(write, ['fraction', 1.5], /CHECK constraint failed/);
    await refused(write, ['missing', null], /CHECK constraint failed/);
    await refused(write, ['long_text', 'x'.repeat(65)], /CHECK constraint failed/);
    expect(() => database.connection.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('blob', new Uint8Array([1]))).toThrow(
      /CHECK constraint failed/,
    );
  });

  it('refuses a raw Telegram id or URL where a keyed reference, draft key or link hash belongs', async () => {
    insertReport(id('keyed'), 'pending');
    await refused(sql`UPDATE reports SET reporter_ref = ? WHERE id = ?`, ['424242010', id('keyed')], /CHECK constraint failed/);
    await refused(sql`UPDATE reports SET link_hash = ? WHERE id = ?`, ['https://example.org/p/1', id('keyed')], /CHECK constraint failed/);
    await refused(
      sql`INSERT INTO drafts (draft_key, step, locale, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      ['424242010', 'url', 'fa', NOW, NOW],
      /CHECK constraint failed/,
    );
    await refused(
      sql`INSERT INTO drafts (draft_key, step, locale, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      [null, 'url', 'fa', NOW, NOW],
      /NOT NULL constraint failed/,
    );
    await refused(sql`INSERT INTO reporter_stats (reporter_ref, last_seen) VALUES (?, ?)`, ['424242010', DAY], /CHECK constraint failed/);
    await refused(
      sql`INSERT INTO stats (report_id, category, platform, created_day, link_hash) VALUES (?, ?, ?, ?, ?)`,
      [id('keyed'), 'other', 'x', DAY, 'https://example.org/p/1'],
      /CHECK constraint failed/,
    );
  });

  it('refuses a day that is not YYYY-MM-DD, a flag that is not 0 or 1, a negative count, a payload that is not an object', async () => {
    await refused(sql`INSERT INTO counters (day, key, count) VALUES (?, ?, ?)`, [String(NOW), 'k', 1], /CHECK constraint failed/);
    await refused(sql`INSERT INTO counters (day, key, count) VALUES (?, ?, ?)`, [DAY, 'k', -1], /CHECK constraint failed/);
    await refused(sql`INSERT INTO reporter_stats (reporter_ref, blocked, last_seen) VALUES (?, ?, ?)`, [HEX, 2, DAY], /CHECK constraint failed/);
    insertReport(id('presses'), 'posted', POSTED);
    await refused(sql`UPDATE reports SET presses = ? WHERE id = ?`, [-1, id('presses')], /CHECK constraint failed/);
    await refused(
      sql`INSERT INTO jobs (id, kind, report_id, due_at, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [id('arrayjob'), 'edit', id('presses'), NOW, '[1]', NOW],
      /CHECK constraint failed/,
    );
  });

  it('refuses an approval or a job of a missing report, and an approval that starts before it was given', async () => {
    const approval = sql`INSERT INTO approvals (report_id, approval_id, admin_id, approved_at, link_mode, recommended_comment, starts_at) VALUES (?, ?, ?, ?, ?, ?, ?)`;
    await refused(approval, [id('missing'), randomId(), 424242001, NOW, 'account', 'c', NOW], /FOREIGN KEY constraint failed/);
    await refused(
      sql`INSERT INTO jobs (id, kind, report_id, due_at, created_at) VALUES (?, ?, ?, ?, ?)`,
      [id('orphanjob'), 'post', id('missing'), NOW, NOW],
      /FOREIGN KEY constraint failed/,
    );
    insertReport(id('early'), 'pending');
    await refused(approval, [id('early'), randomId(), 424242001, NOW, 'account', 'c', NOW - 1], /CHECK constraint failed/);
  });

  it('deletes the approval, the prompts, the jobs and the merged rows with their report', async () => {
    insertReport(id('primary'), 'approved');
    insertReport(id('duplicate'), 'merged', { merged_into: id('primary') });
    await approve(id('primary'), NOW + 300_000);
    await run(
      sql`INSERT INTO admin_prompts (chat_id, prompt_message_id, admin_id, report_id, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [-1001424242, 5, 424242001, id('primary'), 'comment', NOW],
    );
    await enqueue(id('primaryjob'), 'post', id('primary'), NOW + 300_000);
    await run(sql`DELETE FROM reports WHERE id = ?`, [id('primary')]);
    expect(await rows(sql`SELECT id FROM reports`)).toEqual([]);
    expect(await rows(sql`SELECT report_id FROM approvals`)).toEqual([]);
    expect(await rows(sql`SELECT report_id FROM admin_prompts`)).toEqual([]);
    expect(await rows(sql`SELECT report_id FROM jobs`)).toEqual([]);
  });
});

describe('the schema description (test/support/schema-description.ts)', () => {
  it('reads every CHECK of a CREATE TABLE, nested parentheses, quotes and comments respected', () => {
    const createTable = [
      "CREATE TABLE t (a TEXT CHECK (a <> ')' AND a NOT GLOB '*(*'),",
      '  b INTEGER CHECK(b IN (0, 1)),',
      "  c TEXT DEFAULT 'CHECK (c)',",
      '  d INTEGER DEFAULT (xcheck(1)), -- CHECK (a comment)',
      '  "CHECK (e)" INTEGER,',
      '  CHECK ((a) IS NOT NULL\n    AND b >= 0)',
      ')',
    ].join('\n');
    expect(checksOf(createTable)).toEqual(["a <> ')' AND a NOT GLOB '*(*'", 'b IN (0, 1)', '(a) IS NOT NULL AND b >= 0']);
  });
});

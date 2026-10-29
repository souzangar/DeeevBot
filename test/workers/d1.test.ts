// Workers tier: the D1 schema and the D1 adapter (src/db/d1.ts) on the
// local D1 that miniflare runs, the runtime they ship on. migrations/ is
// applied with applyD1Migrations() (the files vitest.config.ts reads), and
// the resulting tables must equal what node:sqlite builds from the same
// files (test/support/expected-schema.ts, also checked by
// src/db/d1-schema.test.ts), CHECK constraints and the trigger included,
// and refuse what node:sqlite refuses: that is the D1 parity of
// 0001_init.sql and 0002_prompt_category.sql.
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { d1SqlDb } from '../../src/db/d1';
import { sql } from '../../src/db/sql';
import { AppError } from '../../src/errors/app-error';
import { D1_SCHEMA } from '../support/expected-schema';
import { describeSchema } from '../support/schema-description';

const raw = async (text: string): Promise<Record<string, unknown>[]> =>
  (await env.DB.prepare(text).all<Record<string, unknown>>()).results;

const db = d1SqlDb(env.DB);

/** A 20-letter id: `name` padded with x. */
const id = (name: string): string => name.padEnd(20, 'x');

const NOW = 1_800_000_000_000;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe('migrations/ on D1', () => {
  it('builds exactly the tables node:sqlite builds from the same files', async () => {
    expect(await describeSchema(raw)).toEqual(D1_SCHEMA);
  });

  it('applies each file once: a second run applies nothing', async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const names = (await raw('SELECT name FROM d1_migrations ORDER BY id')).map((row) => row.name);
    expect(names).toEqual(env.TEST_MIGRATIONS.map((migration) => migration.name));
    expect(names).toContain('0001_init.sql');
    expect(await raw("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual([{ value: 2 }]);
  });

  it('enforces the CHECK, NOT NULL and foreign-key constraints, as node:sqlite does', async () => {
    const report = id('constraints');
    await env.DB.prepare('INSERT INTO reports (id, platform, category, created_at) VALUES (?, ?, ?, ?)')
      .bind(report, 'instagram', 'other', NOW)
      .run();
    const approval =
      'INSERT INTO approvals (report_id, approval_id, admin_id, approved_at, link_mode, recommended_comment, starts_at) VALUES (?, ?, ?, ?, ?, ?, ?)';
    const meta = 'INSERT INTO meta (key, value) VALUES (?, ?)';
    const draft = 'INSERT INTO drafts (draft_key, step, locale, created_at, updated_at) VALUES (?, ?, ?, ?, ?)';
    const refused: [string, D1PreparedStatement, RegExp][] = [
      [
        'a report id with a digit',
        env.DB.prepare('INSERT INTO reports (id, platform, category, created_at) VALUES (?, ?, ?, ?)').bind(
          'badid1xxxxxxxxxxxxxx',
          'x',
          'other',
          NOW,
        ),
        /CHECK constraint failed/,
      ],
      [
        'a raw Telegram id where a reporter reference belongs',
        env.DB.prepare('UPDATE reports SET reporter_ref = ? WHERE id = ?').bind('424242001', report),
        /CHECK constraint failed/,
      ],
      ['a raw chat id as a draft key', env.DB.prepare(draft).bind('424242001', 'url', 'fa', NOW, NOW), /CHECK constraint failed/],
      ['a NULL draft key', env.DB.prepare(draft).bind(null, 'url', 'fa', NOW, NOW), /NOT NULL constraint failed/],
      [
        'a job payload that is not a JSON object',
        env.DB.prepare('INSERT INTO jobs (id, kind, report_id, due_at, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(
          id('arrayjob'),
          'edit',
          report,
          NOW,
          '[1]',
          NOW,
        ),
        /CHECK constraint failed/,
      ],
      [
        'a job kind other than post or edit',
        env.DB.prepare('INSERT INTO jobs (id, kind, report_id, due_at, created_at) VALUES (?, ?, ?, ?, ?)').bind(
          id('batchjob'),
          'batch',
          report,
          NOW,
          NOW,
        ),
        /CHECK constraint failed/,
      ],
      [
        'a post recorded as made without the mark that it started',
        env.DB.prepare('UPDATE reports SET post_message_id = ?, posted_at = ? WHERE id = ?').bind(12, NOW, report),
        /CHECK constraint failed/,
      ],
      [
        'a posted report without its posted time',
        env.DB.prepare("INSERT INTO reports (id, status, platform, category, created_at) VALUES (?, 'posted', ?, ?, ?)").bind(
          id('postedbare'),
          'x',
          'other',
          NOW,
        ),
        /CHECK constraint failed/,
      ],
      [
        'an approval of a report that does not exist',
        env.DB.prepare(approval).bind(id('noreport'), id('noreportapproval'), 1, NOW, 'account', 'c', NOW),
        /FOREIGN KEY constraint failed/,
      ],
      [
        'an approval that starts before it was given',
        env.DB.prepare(approval).bind(report, id('earlyapproval'), 1, NOW, 'account', 'c', NOW - 1),
        /CHECK constraint failed/,
      ],
      [
        'an approval id that is not 20 lowercase letters',
        env.DB.prepare(approval).bind(report, 'short', 1, NOW, 'account', 'c', NOW),
        /CHECK constraint failed/,
      ],
      ['an approval without an approval id', env.DB.prepare(approval).bind(report, null, 1, NOW, 'account', 'c', NOW), /NOT NULL constraint failed/],
      ['a meta value that is a fraction', env.DB.prepare(meta).bind('fraction', 1.5), /CHECK constraint failed/],
      ['a meta value that is NULL', env.DB.prepare(meta).bind('missing', null), /CHECK constraint failed/],
      ['a meta value longer than 64 characters', env.DB.prepare(meta).bind('long_text', 'x'.repeat(65)), /CHECK constraint failed/],
    ];
    for (const [label, statement, error] of refused) {
      await expect(statement.run(), label).rejects.toThrow(error);
    }
    await env.DB.prepare('DELETE FROM reports WHERE id = ?').bind(report).run();
    expect(await raw('SELECT count(*) AS n FROM reports')).toEqual([{ n: 0 }]);
    expect(await raw('SELECT count(*) AS n FROM drafts')).toEqual([{ n: 0 }]);
    // A whole number is stored as an integer, however D1 binds it.
    await env.DB.prepare(meta).bind('paused_until', NOW).run();
    expect(await raw("SELECT typeof(value) AS type, value FROM meta WHERE key = 'paused_until'")).toEqual([
      { type: 'integer', value: NOW },
    ]);
    await env.DB.prepare("DELETE FROM meta WHERE key = 'paused_until'").run();
  });

  it('refuses approved or posting without an un-voided approval, a shared approval id and a shared post', async () => {
    const report = id('trigger');
    const other = id('triggerother');
    const posting = id('triggerposting');
    const approvalId = id('triggerapproval');
    const insert = 'INSERT INTO reports (id, platform, category, created_at) VALUES (?, ?, ?, ?)';
    const approval =
      'INSERT INTO approvals (report_id, approval_id, admin_id, approved_at, link_mode, recommended_comment, starts_at) VALUES (?, ?, 1, ?, ?, ?, ?)';
    const setStatus = (status: string, reportId: string): D1PreparedStatement =>
      env.DB.prepare('UPDATE reports SET status = ? WHERE id = ?').bind(status, reportId);
    const statusOf = async (reportId: string): Promise<unknown> =>
      (await env.DB.prepare('SELECT status FROM reports WHERE id = ?').bind(reportId).first<{ status: string }>())?.status;
    await env.DB.batch([
      env.DB.prepare(insert).bind(report, 'x', 'other', NOW),
      env.DB.prepare(insert).bind(other, 'x', 'other', NOW),
      env.DB.prepare("INSERT INTO reports (id, status, platform, category, created_at, posting_started_at) VALUES (?, 'posting', ?, ?, ?, ?)").bind(
        posting,
        'x',
        'other',
        NOW,
        NOW,
      ),
    ]);
    for (const status of ['approved', 'posting']) {
      await expect(setStatus(status, report).run(), status).rejects.toThrow(/approved or posting only with an un-voided approval/);
    }
    // The status before its approval: the whole batch rolls back.
    await expect(
      env.DB.batch([setStatus('approved', report), env.DB.prepare(approval).bind(report, approvalId, NOW, 'account', 'c', NOW)]),
    ).rejects.toThrow(/approved or posting only with an un-voided approval/);
    expect(await raw('SELECT count(*) AS n FROM approvals')).toEqual([{ n: 0 }]);
    // The approval first: taken. A voided one is no approval.
    await env.DB.batch([env.DB.prepare(approval).bind(report, approvalId, NOW, 'account', 'c', NOW), setStatus('approved', report)]);
    expect(await statusOf(report)).toBe('approved');
    await env.DB.batch([
      env.DB.prepare('UPDATE approvals SET voided_at = ? WHERE report_id = ?').bind(NOW + 1, report),
      setStatus('pending', report),
    ]);
    await expect(setStatus('approved', report).run()).rejects.toThrow(/approved or posting only with an un-voided approval/);
    expect(await statusOf(report)).toBe('pending');
    await expect(env.DB.prepare(approval).bind(other, approvalId, NOW, 'account', 'c', NOW).run()).rejects.toThrow(
      /UNIQUE constraint failed: approvals\.approval_id/,
    );
    // Two reports never hold the same post.
    const markPosted = (reportId: string): D1PreparedStatement =>
      env.DB.prepare("UPDATE reports SET status = 'posted', post_message_id = 12, posted_at = ? WHERE id = ?").bind(NOW + 1, reportId);
    await env.DB.prepare('UPDATE reports SET posting_started_at = ? WHERE id = ?').bind(NOW, other).run();
    await markPosted(other).run();
    await expect(markPosted(posting).run()).rejects.toThrow(/UNIQUE constraint failed: reports\.post_message_id/);
    expect(await statusOf(posting)).toBe('posting');
    await env.DB.prepare('DELETE FROM reports WHERE id IN (?, ?, ?)').bind(report, other, posting).run();
    expect(await raw('SELECT count(*) AS n FROM approvals')).toEqual([{ n: 0 }]);
  });

  it('cascades a report deletion to its approval, its prompts, its jobs and its merged rows', async () => {
    const primary = id('cascadeprimary');
    const merged = id('cascademerged');
    await env.DB.batch([
      env.DB.prepare('INSERT INTO reports (id, platform, category, created_at) VALUES (?, ?, ?, ?)').bind(primary, 'x', 'other', NOW),
      env.DB.prepare(
        "INSERT INTO reports (id, status, platform, category, created_at, merged_into) VALUES (?, 'merged', ?, ?, ?, ?)",
      ).bind(merged, 'x', 'other', NOW, primary),
      env.DB.prepare(
        'INSERT INTO approvals (report_id, approval_id, admin_id, approved_at, link_mode, recommended_comment, starts_at) VALUES (?, ?, 1, ?, ?, ?, ?)',
      ).bind(primary, id('cascadeapproval'), NOW, 'account', 'comment', NOW + 300_000),
      env.DB.prepare(
        'INSERT INTO admin_prompts (chat_id, prompt_message_id, admin_id, report_id, kind, created_at) VALUES (?, ?, 1, ?, ?, ?)',
      ).bind(-1001, 77, primary, 'comment', NOW),
      env.DB.prepare("INSERT INTO jobs (id, kind, report_id, due_at, created_at) VALUES (?, 'post', ?, ?, ?)").bind(
        id('cascadejob'),
        primary,
        NOW + 300_000,
        NOW,
      ),
    ]);
    await env.DB.prepare('DELETE FROM reports WHERE id = ?').bind(primary).run();
    for (const table of ['reports', 'approvals', 'admin_prompts', 'jobs']) {
      expect(await raw(`SELECT count(*) AS n FROM ${table}`), table).toEqual([{ n: 0 }]);
    }
  });
});

describe('the D1 adapter', () => {
  it('runs, reads and counts changes through bound parameters', async () => {
    const insert = sql`INSERT INTO counters (day, key, count) VALUES (?, ?, ?)`;
    expect(await db.run(insert, ['2026-10-27', 'presses', 3])).toEqual({ changes: 1 });
    expect(await db.run(insert, ['2026-10-27', 'nonmember_reports', 1])).toEqual({ changes: 1 });
    const select = sql`SELECT key, count FROM counters WHERE day = ? ORDER BY key`;
    expect(await db.all(select, ['2026-10-27'])).toEqual([
      { key: 'nonmember_reports', count: 1 },
      { key: 'presses', count: 3 },
    ]);
    const one = sql`SELECT count FROM counters WHERE day = ? AND key = ?`;
    expect(await db.first(one, ['2026-10-27', 'presses'])).toEqual({ count: 3 });
    expect(await db.first(one, ['2026-10-27', 'missing'])).toBeNull();
    expect(await db.run(sql`DELETE FROM counters WHERE day = ?`, ['2026-10-27'])).toEqual({ changes: 2 });
  });

  it('stores a value that looks like SQL as text, never as SQL', async () => {
    const hostile = "x'); DROP TABLE reports; --";
    await db.run(sql`INSERT INTO counters (day, key, count) VALUES (?, ?, ?)`, ['2026-10-28', hostile, 1]);
    expect(await db.first(sql`SELECT key FROM counters WHERE day = ?`, ['2026-10-28'])).toEqual({ key: hostile });
    expect(await raw("SELECT name FROM sqlite_master WHERE name = 'reports'")).toHaveLength(1);
    await db.run(sql`DELETE FROM counters WHERE day = ?`, ['2026-10-28']);
  });

  it('applies a batch as one transaction: one failing statement rolls back the others', async () => {
    const insert = sql`INSERT INTO counters (day, key, count) VALUES (?, ?, ?)`;
    const failing = db.batch([
      { sql: insert, params: ['2026-10-29', 'kept', 1] },
      { sql: insert, params: ['not-a-day', 'refused', 1] },
    ]);
    await expect(failing).rejects.toMatchObject({ code: 'STORAGE_FAILURE' });
    await expect(failing).rejects.toBeInstanceOf(AppError);
    expect(await db.all(sql`SELECT key FROM counters`)).toEqual([]);
    expect(
      await db.batch([
        { sql: insert, params: ['2026-10-29', 'a', 1] },
        { sql: sql`UPDATE counters SET count = count + 1 WHERE day = ?`, params: ['2026-10-29'] },
      ]),
    ).toEqual([{ changes: 1 }, { changes: 1 }]);
    expect(await db.batch([])).toEqual([]);
    await db.run(sql`DELETE FROM counters`);
  });

  it('refuses a parameter count the statement does not take, before D1 sees it', async () => {
    await expect(db.run(sql`DELETE FROM counters WHERE day = ?`, [])).rejects.toMatchObject({ code: 'UNEXPECTED' });
    await expect(db.all(sql`SELECT 1 AS one`, ['extra'])).rejects.toMatchObject({ code: 'UNEXPECTED' });
  });
});

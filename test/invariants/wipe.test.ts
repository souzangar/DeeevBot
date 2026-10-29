// Always-run invariant spec, critical invariant 8: "the emergency wipe
// leaves only the aggregate rows in the live database". The wipe is
// scripts/wipe.sh, a wrangler invocation the keyholder runs outside the
// Worker (doc/guides/operations-and-security.md, section 7); this spec
// reads the script, never runs it (it would call Cloudflare), and pins:
// - its statement list is one DELETE without a condition for every table of
//   the schema but `stats` and `meta`, each once (a table a later migration
//   adds fails here until the script deletes it too);
// - it runs that list against the bot's own D1 database (wrangler.jsonc's
//   `database_name`), the deployed one unless `--local` is asked for, and
//   only once the database's name is typed;
// - its statements, run on a store that went through a report's whole life
//   and holds a row in every table, leave the aggregate rows and `meta` as
//   they were (the lockdown switch set) and nothing else;
// - it says what the runbook says: a minute after lockdown, D1's 30-day
//   Time Travel history, and `wrangler d1 delete` as the second step.
// The commit gate runs this file on every commit (`npm run test:invariants`).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { setLockdown } from '../../src/auth/lockdown';
import { orderClosure } from '../../src/broadcast/closure';
import { sql } from '../../src/db/sql';
import { createPrompt } from '../../src/review/prompts';
import { hex, insertApproval, insertReport, insertReporterStats } from '../support/review-rows';
import { isOwnTable } from '../support/schema-description';
import { plantPosted, TICK_AT, tickHarness } from '../support/tick-harness';
import { IDS } from '../support/variables';

// `.href`: the Workers and Node type packages both declare URL.
const SCRIPT = readFileSync(fileURLToPath(new URL('../../scripts/wipe.sh', import.meta.url).href), 'utf8');
const WRANGLER = readFileSync(fileURLToPath(new URL('../../wrangler.jsonc', import.meta.url).href), 'utf8');

/** The script's WIPE_SQL, as it assigns it. */
const wipeSql = (script: string): string => {
  const match = /^WIPE_SQL='([^']*)'$/m.exec(script);
  if (match === null) throw new Error('scripts/wipe.sh assigns no WIPE_SQL');
  return match[1] ?? '';
};

/** The tables `text`'s statements delete every row of; a statement of any other form is reported as such. */
const deletedTables = (text: string): string[] =>
  text
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '')
    .map((statement) => /^DELETE FROM ([a-z_]+)$/.exec(statement)?.[1] ?? `not a plain delete: ${statement}`);

const tablesOf = (harness: ReturnType<typeof tickHarness>): string[] =>
  harness.connection
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => String(row.name))
    .filter(isOwnTable);

describe('critical invariant 8: the emergency wipe leaves only the aggregate rows', () => {
  it('deletes every row of every table but stats and meta, each table once, without a condition', () => {
    const tables = deletedTables(wipeSql(SCRIPT));
    expect(new Set(tables).size).toBe(tables.length);
    expect([...tables].sort()).toEqual(tablesOf(tickHarness()).filter((table) => table !== 'stats' && table !== 'meta'));
  });

  it('fails on a statement list that leaves a table, adds a condition or touches stats or meta, so the check is not vacuous', () => {
    const all = tablesOf(tickHarness()).filter((table) => table !== 'stats' && table !== 'meta');
    const listed = (text: string) => [...deletedTables(text)].sort();
    expect(listed('DELETE FROM drafts; DELETE FROM reports;')).not.toEqual(all);
    expect(listed(`${all.map((table) => `DELETE FROM ${table}`).join('; ')}; DELETE FROM stats;`)).not.toEqual(all);
    expect(deletedTables("DELETE FROM reports WHERE status = 'closed'")).toEqual(["not a plain delete: DELETE FROM reports WHERE status = 'closed'"]);
    expect(() => wipeSql('WIPE="DELETE FROM drafts"')).toThrow();
  });

  it('runs against the bot\'s own D1 database, the deployed one unless --local is asked for, once its name is typed', () => {
    const database = /"database_name":\s*"([^"]+)"/.exec(WRANGLER)?.[1];
    expect(database).toBe('div-report');
    expect(SCRIPT).toContain(`DATABASE='${database ?? ''}'`);
    expect(SCRIPT).toMatch(/^npx wrangler d1 execute "\$\{DATABASE\}" "\$\{target\}" --command "\$\{WIPE_SQL\}"$/m);
    expect(SCRIPT).toMatch(/^target='--remote'$/m);
    expect(SCRIPT).toMatch(/--local\) target='--local' ;;/);
    // The confirmation comes before the one command, and a wrong answer exits without it.
    const confirm = SCRIPT.indexOf('read -r answer');
    const refuse = SCRIPT.indexOf('if [ "${answer}" != "${DATABASE}" ]; then');
    const execute = SCRIPT.indexOf('npx wrangler d1 execute');
    expect(confirm).toBeGreaterThan(0);
    expect(refuse).toBeGreaterThan(confirm);
    expect(execute).toBeGreaterThan(refuse);
    expect(SCRIPT.match(/wrangler d1 execute/g)).toHaveLength(1);
    expect(SCRIPT).toMatch(/^set -euo pipefail$/m);
  });

  it('says what the runbook says: a minute after lockdown, Time Travel, and wrangler d1 delete as the second step', () => {
    expect(SCRIPT).toContain('AT\n# LEAST ONE MINUTE AFTER setting lockdown');
    expect(SCRIPT).toContain('Time\n# Travel');
    expect(SCRIPT).toContain('`wrangler d1 delete div-report`');
    expect(SCRIPT).toContain("follow with\n  'wrangler d1 delete ${DATABASE}'");
  });

  it('leaves, on a store holding a row in every table, the aggregate rows and meta as they were, and nothing else', async () => {
    const harness = tickHarness();
    // A concluded report's aggregate row, an open one, a closing one with its edit job, and every other table filled.
    const concluded = await plantPosted(harness);
    expect(await orderClosure(harness.deps, concluded.reportId, 'taken_down')).toBe('closing');
    await harness.run(TICK_AT + 60_000);
    const closing = await plantPosted(harness);
    expect(await orderClosure(harness.deps, closing.reportId, 'no_result')).toBe('closing');
    const pending = await insertReport(harness.db, { created_at: TICK_AT });
    await insertReport(harness.db, { status: 'merged', merged_into: pending, reporter_ref: hex(4), comment: null, affected_person: null });
    const approved = await insertReport(harness.db, {});
    await insertApproval(harness.db, approved);
    await harness.db.run(sql`UPDATE reports SET status = 'approved' WHERE id = ?`, [approved]);
    await createPrompt(harness.db, { chatId: IDS.adminChat, promptMessageId: 33, adminId: IDS.admin, reportId: pending, kind: 'recommended_comment', category: 'harassment', linkMode: 'account', createdAt: TICK_AT });
    await harness.db.run(sql`INSERT INTO drafts (draft_key, step, url, locale, created_at, updated_at) VALUES (?, 'comment', 'https://x.com/someone', 'en', ?, ?)`, [hex(8), TICK_AT, TICK_AT]);
    await insertReporterStats(harness.db, hex(1), { blocked: 1 });
    await harness.db.run(sql`INSERT INTO counters (day, key, count) VALUES ('2027-01-15', 'presses', 3)`);
    await setLockdown(harness.db, harness.clock);
    for (const table of tablesOf(harness)) {
      expect(Number(harness.connection.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n), table).toBeGreaterThan(0);
    }
    const stats = harness.connection.prepare('SELECT * FROM stats ORDER BY report_id').all();
    const meta = harness.connection.prepare('SELECT * FROM meta ORDER BY key').all();
    // The script's statements, as wrangler hands them to D1.
    harness.connection.exec(wipeSql(SCRIPT));
    for (const table of tablesOf(harness)) {
      const rows = harness.connection.prepare(`SELECT * FROM ${table}`).all();
      if (table === 'stats') expect(rows, table).toEqual(stats);
      else if (table === 'meta') expect(rows, table).toEqual(meta);
      else expect(rows, table).toEqual([]);
    }
    expect(meta.map((row) => row.key)).toContain('lockdown');
    expect(stats).toHaveLength(1);
  });
});

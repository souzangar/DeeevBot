// Always-run invariant spec, critical invariant 8: reports leave only counts
// behind, and every stored personal field has a deletion path; with the
// owner's rule that the bot stores no member or reporter identity. At the
// storage level (migrations/0001_init.sql on node:sqlite):
// - the schema holds no member or reporter identity: no subscriber, ledger
//   or per-presser table, no column that holds or could hold a Telegram id
//   beyond the allowlisted admins' and keyholders' own, a draft keyed by
//   the keyed reference only, and the presses a count;
// - every column of every table is classified below; a column added
//   without a classification fails here, so a new field cannot arrive
//   without its deletion path;
// - every table and every personal column is named in the deletion
//   schedule (doc/product/retention-and-minimisation.md), the schedule's
//   table names no column the schema lacks, each under its own table, and
//   a field the schedule nulls (rather than deleting its row) is nullable,
//   so finalization can null it;
// - a raw Telegram id or URL cannot be stored as is where a keyed
//   reference, a draft key or a link hash belongs (that the value is the
//   keyed one is tested where it is written);
// - deleting a report takes its approval, its prompts, its jobs and its
//   merged rows with it.
// The commit gate runs this file on every commit (`npm run test:invariants`).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate';
import { openNodeSqlite, type NodeSqlite } from '../../src/db/node-sqlite';
import { sql } from '../../src/db/sql';
import { fakeClock } from '../fakes/clock';
import { isOwnTable } from '../support/schema-description';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url).href);
const SCHEDULE = fileURLToPath(new URL('../../doc/product/retention-and-minimisation.md', import.meta.url).href);
const NOW = 1_800_000_000_000;

/**
 * How a column leaves the store:
 * - 'nulled': personal; the schedule nulls it at a named moment, the row
 *   staying (so the column is nullable);
 * - 'row': personal; deleted with its row on the table's deletion paths;
 * - 'state': not personal (ids, statuses, times, counters, flags); goes
 *   with its row;
 * - 'aggregate': the aggregate row's columns, the one thing that remains.
 */
type Fate = 'nulled' | 'row' | 'state' | 'aggregate';

const COLUMNS: Readonly<Record<string, Readonly<Record<string, Fate>>>> = {
  drafts: {
    draft_key: 'row',
    step: 'state',
    url: 'row',
    platform: 'state',
    account_url: 'row',
    category: 'state',
    affected_person: 'row',
    comment: 'row',
    locale: 'row',
    created_at: 'state',
    updated_at: 'state',
  },
  reports: {
    id: 'state',
    status: 'state',
    platform: 'state',
    category: 'state',
    url: 'nulled',
    account_url: 'nulled',
    comment: 'nulled',
    affected_person: 'nulled',
    reporter_ref: 'nulled',
    merged_into: 'state',
    link_hash: 'nulled',
    created_at: 'state',
    decided_at: 'state',
    decided_by: 'nulled',
    rejection_reason: 'nulled',
    broadcast_text: 'nulled',
    correction_text: 'nulled',
    link_mode: 'nulled',
    card_message_id: 'nulled',
    status_message_id: 'nulled',
    post_message_id: 'nulled',
    posting_started_at: 'state',
    posted_at: 'state',
    presses: 'state',
    alert_sent_at: 'state',
    needs_attention: 'state',
    data_deleted_at: 'state',
    closed_at: 'state',
    outcome: 'state',
  },
  approvals: {
    report_id: 'state',
    approval_id: 'state',
    admin_id: 'row',
    approved_at: 'state',
    link_mode: 'state',
    recommended_comment: 'row',
    starts_at: 'state',
    voided_at: 'state',
  },
  admin_prompts: {
    chat_id: 'row',
    prompt_message_id: 'state',
    admin_id: 'row',
    report_id: 'state',
    kind: 'state',
    link_mode: 'state',
    created_at: 'state',
    category: 'state',
  },
  reporter_stats: {
    reporter_ref: 'row',
    open_count: 'row',
    day: 'row',
    day_count: 'row',
    rejections_30d: 'row',
    blocked: 'row',
    last_seen: 'row',
  },
  counters: { day: 'state', key: 'state', count: 'state' },
  stats: {
    report_id: 'aggregate',
    category: 'aggregate',
    platform: 'aggregate',
    created_day: 'aggregate',
    decided_day: 'aggregate',
    closed_day: 'aggregate',
    outcome: 'aggregate',
    presses: 'aggregate',
    link_hash: 'aggregate',
  },
  jobs: {
    id: 'state',
    kind: 'state',
    report_id: 'state',
    due_at: 'state',
    payload: 'row',
    attempts: 'state',
    created_at: 'state',
  },
  meta: { key: 'state', value: 'state' },
};

interface Column {
  readonly table: string;
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
}

/**
 * The only columns that may hold a plaintext Telegram id: the allowlisted
 * admins' and keyholders' own ids (both deployment configuration):
 * `admin_id`, `decided_by`, and `admin_prompts.chat_id`, the admin venue
 * or the replier's own chat (a keyholder's `/retract` prompt stores the
 * keyholder's). No member's or reporter's id is ever stored.
 */
const TELEGRAM_ID_COLUMNS = ['admin_prompts.admin_id', 'admin_prompts.chat_id', 'approvals.admin_id', 'reports.decided_by'];

/**
 * The columns without text affinity that hold no id: counts, flags and the
 * meta values (a version, flags and a time). Times end in `_at` and message
 * ids in `_message_id`.
 */
const NON_TEXT_WITHOUT_ID = new Set([
  'counters.count',
  'drafts.affected_person',
  'jobs.attempts',
  'meta.value',
  'reporter_stats.blocked',
  'reporter_stats.day_count',
  'reporter_stats.open_count',
  'reporter_stats.rejections_30d',
  'reports.affected_person',
  'reports.needs_attention',
  'reports.presses',
  'stats.presses',
]);

/** A name that says the column holds a person, a chat or someone's id. */
const IDENTITY_NAMED =
  /chat|user|member|subscriber|presser|telegram|(^|_)tg(_|$)|_id$|_by$|_from$|_to$|^(sender|recipient|actor|author|owner|peer|uid|from|to)$/;

/**
 * The record ids, which are no person's: a report's, an approval's and a
 * job's (20 random letters, TEXT) and the links to them. Exempt from the
 * name rule only, so one of them declared without text affinity is still
 * caught; message ids (`*_message_id`) are exempt from both rules.
 */
const RECORD_ID_COLUMNS = new Set(['id', 'report_id', 'merged_into', 'approval_id']);

/** SQLite's affinity rule: a declared type has text affinity if it holds CHAR, CLOB or TEXT and no INT. */
const hasTextAffinity = (type: string): boolean => !/INT/i.test(type) && /CHAR|CLOB|TEXT/i.test(type);

/**
 * The columns that hold, or could hold, a Telegram user or chat id: every
 * column without text affinity (INTEGER, BIGINT, NUMERIC, REAL, untyped:
 * a Telegram id is a number) that is not a time, a message id, a count, a
 * flag or a meta value, and every column of any type whose name says a
 * person, a chat or an id, record ids aside. A message id is not a
 * person's id.
 */
const telegramIdColumns = (columns: readonly Column[]): string[] =>
  columns
    .filter((column) => {
      const key = `${column.table}.${column.name}`;
      if (column.name.endsWith('_message_id')) return false;
      const numeric = !hasTextAffinity(column.type) && !column.name.endsWith('_at') && !NON_TEXT_WITHOUT_ID.has(key);
      const named = IDENTITY_NAMED.test(column.name) && !RECORD_ID_COLUMNS.has(column.name);
      return numeric || named;
    })
    .map((column) => `${column.table}.${column.name}`)
    .sort();

const open = (): NodeSqlite => {
  const database = openNodeSqlite(':memory:');
  migrate(database.connection, MIGRATIONS_DIR, fakeClock(NOW));
  return database;
};

const columnsOf = (database: NodeSqlite): Column[] =>
  database.connection
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => String(row.name))
    .filter(isOwnTable)
    .flatMap((table) =>
      database.connection
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => ({
          table,
          name: String(row.name),
          type: String(row.type),
          nullable: Number(row.notnull) === 0 && Number(row.pk) === 0,
        })),
    );

const columns = columnsOf(open());
const schedule = readFileSync(SCHEDULE, 'utf8');
/** Whether the schedule names `name` as code, `name` or `table.name`. */
const named = (name: string): boolean => schedule.includes(`\`${name}\``) || new RegExp(`\`[a-z_]+\\.${name}\``).test(schedule);

/** The rows of the schedule's deletion table ("What | Where | Deleted"), as cells. */
const scheduleRows = (markdown: string): string[][] => {
  const lines = markdown.split('\n');
  const header = lines.findIndex((line) => /^\|\s*What\s*\|\s*Where\s*\|\s*Deleted\s*\|$/.test(line.trim()));
  if (header === -1) throw new Error('the deletion schedule has no "What | Where | Deleted" table');
  const rows: string[][] = [];
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith('|')) break;
    rows.push(line.split('|').slice(1, -1).map((cell) => cell.trim()));
  }
  return rows;
};

/** The code spans of a cell, backticks removed. */
const codeIn = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '');

const COLUMN_NAME = /^[a-z][a-z0-9_]*$/;
const QUALIFIED_NAME = /^([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)$/;

/**
 * The names the schedule's deletion table gives that the schema lacks: a
 * code span in a Where cell must be a table, and every lowercase code span
 * of the row's other cells a column of one of the row's tables (`table.name`
 * a column of that table). Commands and settings (`/cancel`,
 * `MARKS_PER_DAY`) are not names.
 */
const unknownScheduleNames = (markdown: string, schema: readonly Column[]): string[] => {
  const has = (table: string, name: string): boolean =>
    schema.some((column) => column.table === table && column.name === name);
  const tables = new Set(schema.map((column) => column.table));
  const unknown: string[] = [];
  for (const [what = '', where = '', deleted = ''] of scheduleRows(markdown)) {
    const rowTables = codeIn(where);
    for (const table of rowTables) if (!tables.has(table)) unknown.push(`no table ${table}`);
    for (const name of [...codeIn(what), ...codeIn(deleted)]) {
      const qualified = QUALIFIED_NAME.exec(name);
      if (qualified) {
        if (!has(qualified[1] ?? '', qualified[2] ?? '')) unknown.push(`no column ${name}`);
      } else if (COLUMN_NAME.test(name) && !rowTables.some((table) => has(table, name))) {
        unknown.push(`no column ${name} in ${rowTables.join(', ') || 'a row without a table'}`);
      }
    }
  }
  return unknown;
};

describe('critical invariant 8: the store holds no member or reporter identity', () => {
  const tables = [...new Set(columns.map((column) => column.table))];

  it('has no subscriber, ledger or per-presser table', () => {
    for (const table of ['subscribers', 'deliveries', 'mark_buckets', 'marks', 'broadcast']) {
      expect(tables, table).not.toContain(table);
    }
  });

  it('lets exactly admin_id, decided_by and admin_prompts.chat_id hold a Telegram id', () => {
    expect(telegramIdColumns(columns)).toEqual(TELEGRAM_ID_COLUMNS);
  });

  it('fails on any other column that holds or could hold one, so the scan is not vacuous', () => {
    const column = (table: string, name: string, type: string): Column => ({ table, name, type, nullable: true });
    const planted: Column[] = [
      // Named for a person, a chat or an id, whatever the type.
      column('reports', 'reporter_chat_id', 'INTEGER'),
      column('reports', 'reporter_id', 'TEXT'),
      column('stats', 'pressed_by', 'TEXT'),
      column('stats', 'last_presser', 'INTEGER'),
      column('drafts', 'chat', 'TEXT'),
      column('drafts', 'forwarded_from', 'TEXT'),
      column('jobs', 'reply_to', 'TEXT'),
      column('jobs', 'subscriber_list', 'TEXT'),
      column('reports', 'owner', 'TEXT'),
      column('reports', 'tg', ''),
      column('reports', 'sender', ''),
      // Without text affinity, so it could hold a Telegram id, whatever the name.
      column('counters', 'origin', 'BIGINT'),
      column('drafts', 'origin', 'INT'),
      column('jobs', 'origin', 'NUMERIC'),
      column('stats', 'origin', 'REAL'),
      column('reports', 'origin', ''),
      column('reports', 'origin_code', 'TEXT INT'),
      column('reports', 'retries', 'INTEGER'),
      // A record id's name does not exempt a number.
      column('members', 'id', 'INTEGER'),
      column('members', 'report_id', 'INTEGER'),
    ];
    for (const extra of planted) {
      const key = `${extra.table}.${extra.name}`;
      expect(telegramIdColumns([...columns, extra]), key).toEqual([...TELEGRAM_ID_COLUMNS, key].sort());
    }
    const harmless: Column[] = [
      column('reports', 'edited_at', 'INTEGER'),
      column('reports', 'edit_message_id', 'INTEGER'),
      column('reports', 'note', 'TEXT'),
      column('reports', 'label', 'VARCHAR(64)'),
      column('jobs', 'approval_id', 'TEXT'),
      column('stats', 'merged_into', 'TEXT'),
    ];
    expect(telegramIdColumns([...columns, ...harmless])).toEqual(TELEGRAM_ID_COLUMNS);
  });

  it('keys a draft by the keyed reference, refusing a raw chat id, and counts presses instead of listing pressers', async () => {
    const database = open();
    // A raw Telegram id where the draft key (an HMAC reference) belongs.
    await expect(
      database.db.run(sql`INSERT INTO drafts (draft_key, step, locale, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, [
        '424242010',
        'url',
        'fa',
        NOW,
        NOW,
      ]),
    ).rejects.toMatchObject({ code: 'STORAGE_FAILURE' });
    expect(columns.find((column) => column.table === 'reports' && column.name === 'presses')).toBeDefined();
    expect(columns.some((column) => column.name === 'reporter_chat_id')).toBe(false);
  });
});

describe('critical invariant 8: every column has a classified fate', () => {
  it('classifies every column, and only existing ones', () => {
    const actual = columns.map((column) => `${column.table}.${column.name}`).sort();
    const expected = Object.entries(COLUMNS)
      .flatMap(([table, fates]) => Object.keys(fates).map((name) => `${table}.${name}`))
      .sort();
    expect(actual).toEqual(expected);
  });

  it('keeps every field the schedule nulls nullable, so finalization can null it', () => {
    const notNullable = columns
      .filter((column) => COLUMNS[column.table]?.[column.name] === 'nulled' && !column.nullable)
      .map((column) => `${column.table}.${column.name}`);
    expect(notNullable).toEqual([]);
  });

  it('names in its deletion table only columns the schema has, each under its own table', () => {
    expect(unknownScheduleNames(schedule, columns)).toEqual([]);
  });

  it('fails on a deletion table that names a missing column or table, so the check is not vacuous', () => {
    const table = (row: string): string => `| What | Where | Deleted |\n|---|---|---|\n${row}\n`;
    expect(unknownScheduleNames(table('| `reporter_chat_id` | D1 `reports` | never |'), columns)).toEqual([
      'no column reporter_chat_id in reports',
    ]);
    expect(unknownScheduleNames(table('| `payload` | D1 `reports` | at closure |'), columns)).toEqual([
      'no column payload in reports',
    ]);
    expect(unknownScheduleNames(table('| `chat_id` | D1 `subscribers` | never |'), columns)).toEqual([
      'no table subscribers',
      'no column chat_id in subscribers',
    ]);
    expect(unknownScheduleNames(table('| `comment` | the review venue | `reports.reporter_id` |'), columns)).toEqual([
      'no column comment in a row without a table',
      'no column reports.reporter_id',
    ]);
    expect(unknownScheduleNames(table('| `comment`, `MARKS_PER_DAY` | D1 `reports` | on `/cancel` |'), columns)).toEqual([]);
    expect(() => unknownScheduleNames('no table here', columns)).toThrow(/no "What \| Where \| Deleted" table/);
  });

  it('names every table and every personal column in the deletion schedule', () => {
    const tables = [...new Set(columns.map((column) => column.table))].filter((table) => table !== 'meta');
    expect(tables.filter((table) => !named(table))).toEqual([]);
    const personal = columns.filter((column) => {
      const fate = COLUMNS[column.table]?.[column.name];
      return fate === 'nulled' || fate === 'row';
    });
    expect(personal.length).toBeGreaterThan(0);
    expect(personal.filter((column) => !named(column.name)).map((column) => `${column.table}.${column.name}`)).toEqual(
      [],
    );
  });
});

describe('critical invariant 8: finalization can null every personal field of a report', () => {
  it('nulls them all in one statement on a report holding every one', () => {
    const database = open();
    const nulled = Object.entries(COLUMNS.reports ?? {})
      .filter(([, fate]) => fate === 'nulled')
      .map(([name]) => name);
    const integers = new Set(['affected_person', 'decided_by', 'card_message_id', 'status_message_id', 'post_message_id']);
    database.connection
      .prepare(
        `INSERT INTO reports (id, status, platform, category, created_at, ${nulled.join(', ')}) VALUES ('finalizedreportxxxxx', 'closed', 'x', 'other', ?, ${nulled.map(() => '?').join(', ')})`,
      )
      .run(
        NOW,
        ...nulled.map((name) =>
          integers.has(name) ? 1 : name === 'reporter_ref' || name === 'link_hash' ? 'ab'.repeat(32) : 'value',
        ),
      );
    database.connection
      .prepare(`UPDATE reports SET ${nulled.map((name) => `${name} = NULL`).join(', ')} WHERE id = 'finalizedreportxxxxx'`)
      .run();
    const [row] = database.connection.prepare('SELECT * FROM reports').all();
    for (const name of nulled) expect(row?.[name], name).toBeNull();
  });
});

describe('critical invariant 8: no raw Telegram id or URL where a keyed value belongs', () => {
  const database = open();
  const refused = (statement: string, ...values: (string | number)[]): void => {
    expect(() => database.connection.prepare(statement).run(...values)).toThrow(/CHECK constraint failed/);
  };

  it('refuses a raw id or URL in the reporter reference, the draft key and the link hash', () => {
    database.connection
      .prepare("INSERT INTO reports (id, platform, category, created_at) VALUES ('keyedreportxxxxxxxxx', 'x', 'other', ?)")
      .run(NOW);
    refused("UPDATE reports SET reporter_ref = ? WHERE id = 'keyedreportxxxxxxxxx'", '424242001');
    refused("UPDATE reports SET link_hash = ? WHERE id = 'keyedreportxxxxxxxxx'", 'https://www.instagram.com/invariant.account/');
    refused("INSERT INTO drafts (draft_key, step, locale, created_at, updated_at) VALUES (?, 'url', 'fa', 1, 1)", '424242001');
    refused("INSERT INTO reporter_stats (reporter_ref, last_seen) VALUES (?, '2027-01-15')", '424242001');
    refused(
      "INSERT INTO stats (report_id, category, platform, created_day, link_hash) VALUES ('keyedreportxxxxxxxxx', 'other', 'x', '2027-01-15', ?)",
      'https://www.instagram.com/invariant.account/',
    );
  });
});

describe('critical invariant 8: a report takes its records with it', () => {
  it('deleting a report deletes its approval, its prompts, its jobs and the rows merged into it', () => {
    const database = open();
    const run = (statement: string, ...values: (string | number)[]) => database.connection.prepare(statement).run(...values);
    run("INSERT INTO reports (id, status, platform, category, created_at) VALUES ('primaryreportxxxxxxx', 'approved', 'x', 'other', ?)", NOW);
    run(
      "INSERT INTO reports (id, status, platform, category, created_at, merged_into) VALUES ('mergedreportxxxxxxxx', 'merged', 'x', 'other', ?, 'primaryreportxxxxxxx')",
      NOW,
    );
    run(
      "INSERT INTO approvals (report_id, approval_id, admin_id, approved_at, link_mode, recommended_comment, starts_at) VALUES ('primaryreportxxxxxxx', 'primaryapprovalxxxxx', 424242001, ?, 'account', 'comment', ?)",
      NOW,
      NOW + 300_000,
    );
    run(
      "INSERT INTO admin_prompts (chat_id, prompt_message_id, admin_id, report_id, kind, created_at) VALUES (-1001424242, 9, 424242001, 'primaryreportxxxxxxx', 'comment', ?)",
      NOW,
    );
    run(
      "INSERT INTO jobs (id, kind, report_id, due_at, payload, created_at) VALUES ('primaryjobxxxxxxxxxx', 'post', 'primaryreportxxxxxxx', ?, '{}', ?)",
      NOW + 300_000,
      NOW,
    );
    run("DELETE FROM reports WHERE id = 'primaryreportxxxxxxx'");
    for (const table of ['reports', 'approvals', 'admin_prompts', 'jobs']) {
      expect({ ...database.connection.prepare(`SELECT count(*) AS n FROM ${table}`).get() }, table).toEqual({ n: 0 });
    }
  });
});

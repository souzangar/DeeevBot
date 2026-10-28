// Unit tests for the Node migrations runner (src/db/migrate.ts): wrangler's
// file order and naming, each file applied once inside one transaction with
// its record, idempotence, and a failing file rolled back whole. The real
// migrations/ directory is applied too; what it builds is checked table by
// table in src/db/d1-schema.test.ts.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeClock } from '../../test/fakes/clock';
import { applyMigrations, migrate, readMigrations, type Migration } from './migrate';
import { openNodeSqlite } from './node-sqlite';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url).href);

const tables = (database: ReturnType<typeof openNodeSqlite>): string[] =>
  database.connection
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => String(row.name));

const records = (database: ReturnType<typeof openNodeSqlite>) =>
  database.connection
    .prepare('SELECT name, applied_at FROM schema_migrations ORDER BY name')
    .all()
    .map((row) => ({ ...row }));

describe('readMigrations', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const dirWith = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'div-report-migrations-'));
    dirs.push(dir);
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    return dir;
  };

  it('reads the .sql files in number order and ignores the rest', () => {
    const dir = dirWith({
      '0002_more.sql': 'CREATE TABLE b (x);',
      '0001_init.sql': 'CREATE TABLE a (x);',
      '.gitkeep': '',
      'README.md': 'not a migration',
    });
    expect(readMigrations(dir)).toEqual([
      { name: '0001_init.sql', sql: 'CREATE TABLE a (x);' },
      { name: '0002_more.sql', sql: 'CREATE TABLE b (x);' },
    ]);
  });

  it.each([
    ['a name without the number', { 'init.sql': 'CREATE TABLE a (x);' }],
    ['a name with capitals', { '0001_Init.sql': 'CREATE TABLE a (x);' }],
    ['a number used twice', { '0001_a.sql': 'CREATE TABLE a (x);', '0001_b.sql': 'CREATE TABLE b (x);' }],
  ])('refuses %s', (_label, files) => {
    expect(() => readMigrations(dirWith(files))).toThrow(expect.objectContaining({ code: 'UNEXPECTED' }));
  });

  it('reads the repository migrations, 0001_init.sql first', () => {
    const migrations = readMigrations(MIGRATIONS_DIR);
    expect(migrations[0]?.name).toBe('0001_init.sql');
    expect(migrations[0]?.sql.startsWith('-- @critical-path')).toBe(true);
  });
});

describe('applyMigrations', () => {
  const first: Migration = { name: '0001_a.sql', sql: 'CREATE TABLE a (x INTEGER); CREATE INDEX a_x ON a (x);' };
  const second: Migration = { name: '0002_b.sql', sql: 'CREATE TABLE b (y INTEGER);' };

  it('applies each migration once, in order, recording its name and time', () => {
    const database = openNodeSqlite(':memory:');
    const clock = fakeClock(1_800_000_000_000);
    expect(applyMigrations(database.connection, [first, second], clock)).toEqual(['0001_a.sql', '0002_b.sql']);
    expect(tables(database)).toEqual(['a', 'b', 'schema_migrations']);
    expect(records(database)).toEqual([
      { name: '0001_a.sql', applied_at: 1_800_000_000_000 },
      { name: '0002_b.sql', applied_at: 1_800_000_000_000 },
    ]);
  });

  it('is idempotent: a second run applies nothing, a new file alone is applied', () => {
    const database = openNodeSqlite(':memory:');
    const clock = fakeClock(1_000);
    expect(applyMigrations(database.connection, [first], clock)).toEqual(['0001_a.sql']);
    clock.set(2_000);
    expect(applyMigrations(database.connection, [first], clock)).toEqual([]);
    expect(applyMigrations(database.connection, [first, second], clock)).toEqual(['0002_b.sql']);
    expect(records(database)).toEqual([
      { name: '0001_a.sql', applied_at: 1_000 },
      { name: '0002_b.sql', applied_at: 2_000 },
    ]);
  });

  it('rolls a failing migration back whole, keeps the ones before it, and retries it next time', () => {
    const database = openNodeSqlite(':memory:');
    const broken: Migration = { name: '0002_broken.sql', sql: 'CREATE TABLE c (z INTEGER); CREATE TABLE a (x);' };
    expect(() => applyMigrations(database.connection, [first, broken], fakeClock(1))).toThrow(
      expect.objectContaining({ code: 'STORAGE_FAILURE' }),
    );
    expect(database.connection.isTransaction).toBe(false);
    expect(tables(database)).toEqual(['a', 'schema_migrations']);
    expect(records(database).map((row) => row.name)).toEqual(['0001_a.sql']);
    const fixed: Migration = { name: '0002_broken.sql', sql: 'CREATE TABLE c (z INTEGER);' };
    expect(applyMigrations(database.connection, [first, fixed], fakeClock(2))).toEqual(['0002_broken.sql']);
  });

  it('applies the repository migrations on an empty database, once', () => {
    const database = openNodeSqlite(':memory:');
    const clock = fakeClock(1_800_000_000_000);
    expect(migrate(database.connection, MIGRATIONS_DIR, clock)).toEqual(['0001_init.sql']);
    expect(migrate(database.connection, MIGRATIONS_DIR, clock)).toEqual([]);
    expect(tables(database)).toEqual([
      'admin_prompts',
      'approvals',
      'counters',
      'drafts',
      'jobs',
      'meta',
      'reporter_stats',
      'reports',
      'schema_migrations',
      'stats',
    ]);
  });
});

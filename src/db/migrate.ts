// @critical-path
// The D1 migrations runner of the Node port (the MVP plan, section 2, "Node
// port"; critical invariant 8): it applies the same files as wrangler does
// on Cloudflare (`migrations/*.sql`, wrangler's `migrations_dir`), in name
// order, each exactly once, each inside one transaction together with its
// record in `schema_migrations(name, applied_at)`, so a failed file leaves
// neither a partial schema nor a record behind and the next start retries
// it. It and the node:sqlite adapter (src/db/node-sqlite.ts) are the only
// files under src/db/ that the eslint override lets read the file system;
// the Worker bundle never imports either.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Clock } from '../clock';
import { AppError } from '../errors/app-error';
import { sql } from './sql';

/** One migration file. */
export interface Migration {
  /** The file name, e.g. `0001_init.sql`: the record's key. */
  readonly name: string;
  /** The file's SQL, any number of statements. */
  readonly sql: string;
}

/** Wrangler's file shape: a four-digit number, an underscore, a name. */
const MIGRATION_FILE = /^([0-9]{4})_[a-z0-9_]+\.sql$/;

const CREATE_RECORDS = sql`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT NOT NULL PRIMARY KEY, applied_at INTEGER NOT NULL) WITHOUT ROWID`;
const APPLIED = sql`SELECT name FROM schema_migrations`;
const RECORD = sql`INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`;
const BEGIN = sql`BEGIN IMMEDIATE`;
const COMMIT = sql`COMMIT`;
const ROLLBACK = sql`ROLLBACK`;

/**
 * The `.sql` files of `dir`, in name order (the number first, as wrangler
 * orders them). Other files are ignored; a `.sql` file whose name has not
 * wrangler's shape, or a number used twice, is an AppError UNEXPECTED.
 */
export function readMigrations(dir: string): Migration[] {
  const names = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const numbers = new Set<string>();
  return names.map((name) => {
    const number = MIGRATION_FILE.exec(name)?.[1];
    if (number === undefined) {
      throw new AppError('UNEXPECTED', 'a migration file is named NNNN_name.sql');
    }
    if (numbers.has(number)) throw new AppError('UNEXPECTED', 'two migration files share a number');
    numbers.add(number);
    return { name, sql: readFileSync(join(dir, name), 'utf8') };
  });
}

const storageFailure = (operation: string, cause: unknown): AppError =>
  new AppError('STORAGE_FAILURE', `migration ${operation} failed`, { cause });

/**
 * Rolls back the open transaction after `failure`, and returns what the
 * error reports as its cause: `failure`, or both failures when the rollback
 * fails too.
 */
const rolledBack = (connection: DatabaseSync, failure: unknown): unknown => {
  if (!connection.isTransaction) return failure;
  try {
    connection.exec(ROLLBACK);
    return failure;
  } catch (rollbackFailure) {
    return new AggregateError([failure, rollbackFailure], 'the rollback failed too');
  }
};

/**
 * Applies every migration of `migrations` that `schema_migrations` does not
 * record yet, in the given order, each in its own transaction with its
 * record (applied_at from `clock`). Returns the names it applied, in order;
 * nothing when every one is recorded. A failure rolls that migration back,
 * keeps the ones before it, and throws an AppError STORAGE_FAILURE.
 */
export function applyMigrations(
  connection: DatabaseSync,
  migrations: readonly Migration[],
  clock: Clock,
): string[] {
  let applied: Set<string>;
  try {
    connection.exec(CREATE_RECORDS);
    applied = new Set(
      connection
        .prepare(APPLIED)
        .all()
        .map((row) => String(row.name)),
    );
  } catch (cause) {
    throw storageFailure('bookkeeping', cause);
  }

  const done: string[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    try {
      connection.exec(BEGIN);
      connection.exec(migration.sql);
      connection.prepare(RECORD).run(migration.name, clock.now());
      connection.exec(COMMIT);
    } catch (cause) {
      throw storageFailure('apply', rolledBack(connection, cause));
    }
    done.push(migration.name);
  }
  return done;
}

/** Reads `dir` and applies what is new: the Node port runs this at start. */
export const migrate = (connection: DatabaseSync, dir: string, clock: Clock): string[] =>
  applyMigrations(connection, readMigrations(dir), clock);

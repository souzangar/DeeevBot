// @critical-path
// The node:sqlite adapter of the SqlDb port (src/db/sql.ts) over one
// DatabaseSync connection, for the Node port
// (doc/architecture/adr-0001-runtime-and-hosting.md; the driver decision is
// in doc/architecture/adr-0002-language-and-framework.md) and for every
// SQL-level test, the invariants tier's included. Node 22 prints an
// ExperimentalWarning the first time node:sqlite loads; that is accepted
// (the test runner silences it, vitest.config.ts).
//
// - Every value is bound as a parameter, after checkStatement().
// - batch() is one transaction (BEGIN IMMEDIATE ... COMMIT): a failing
//   statement rolls back every earlier one.
// - Foreign keys are enforced, as on D1.
// - Every driver failure leaves as an AppError STORAGE_FAILURE whose message
//   names the operation only; the driver's error is its `cause`, which the
//   redacting logger never reads.
// - Rows are returned as plain objects, as D1 returns them.
//
// The database file's path comes from the Node port's configuration; no
// credential is involved (critical invariant 6).
import { DatabaseSync } from 'node:sqlite';
import { AppError } from '../errors/app-error';
import { checkStatement, sql, type SqlDb, type SqlRow, type SqlRunResult, type SqlText, type SqlValue } from './sql';

/** One node:sqlite connection behind the SqlDb port. */
export interface NodeSqlite {
  readonly db: SqlDb;
  /** The connection itself: the migrations runner executes whole files on it. */
  readonly connection: DatabaseSync;
  close(): void;
}

const storageFailure = (operation: string, cause: unknown): AppError =>
  new AppError('STORAGE_FAILURE', `node:sqlite ${operation} failed`, { cause });

const BEGIN = sql`BEGIN IMMEDIATE`;
const COMMIT = sql`COMMIT`;
const ROLLBACK = sql`ROLLBACK`;

/** A promise of `compute()`'s result: a throw becomes a rejection. */
const promised = <T>(compute: () => T): Promise<T> =>
  new Promise<T>((resolve) => {
    resolve(compute());
  });

/** The SqlDb port over an open connection. */
export function nodeSqlDb(connection: DatabaseSync): SqlDb {
  const rows = <T extends object>(text: SqlText, params: readonly SqlValue[]): T[] => {
    checkStatement(text, params);
    try {
      return connection
        .prepare(text)
        .all(...params)
        .map((row) => ({ ...row }) as T);
    } catch (cause) {
      throw storageFailure('statement', cause);
    }
  };

  const run = (text: SqlText, params: readonly SqlValue[]): SqlRunResult => {
    checkStatement(text, params);
    try {
      return { changes: Number(connection.prepare(text).run(...params).changes) };
    } catch (cause) {
      throw storageFailure('statement', cause);
    }
  };

  const firstRow = <T extends object>(text: SqlText, params: readonly SqlValue[]): T | null => {
    checkStatement(text, params);
    try {
      const row = connection.prepare(text).get(...params);
      return row === undefined ? null : ({ ...row } as T);
    } catch (cause) {
      throw storageFailure('statement', cause);
    }
  };

  /**
   * Rolls back the open transaction after `failure` and returns the error to
   * throw: `failure` itself, or a STORAGE_FAILURE carrying both errors when
   * the rollback fails too. SQLite may have rolled back by itself already.
   */
  const rolledBack = (failure: unknown): unknown => {
    if (!connection.isTransaction) return failure;
    try {
      connection.exec(ROLLBACK);
      return failure;
    } catch (rollbackFailure) {
      return storageFailure('rollback', new AggregateError([failure, rollbackFailure], 'the rollback failed too'));
    }
  };

  const inTransaction = (statements: readonly { sql: SqlText; params: readonly SqlValue[] }[]): SqlRunResult[] => {
    try {
      connection.exec(BEGIN);
    } catch (cause) {
      throw storageFailure('transaction begin', cause);
    }
    let results: SqlRunResult[];
    try {
      results = statements.map((statement) => run(statement.sql, statement.params));
    } catch (error) {
      throw rolledBack(error);
    }
    try {
      connection.exec(COMMIT);
    } catch (cause) {
      throw rolledBack(storageFailure('commit', cause));
    }
    return results;
  };

  return {
    run: (text, params = []) => promised(() => run(text, params)),
    all: <T extends object = SqlRow>(text: SqlText, params: readonly SqlValue[] = []) =>
      promised(() => rows<T>(text, params)),
    first: <T extends object = SqlRow>(text: SqlText, params: readonly SqlValue[] = []) =>
      promised(() => firstRow<T>(text, params)),
    batch: (statements) =>
      promised(() => {
        // Every statement is checked before the transaction opens.
        for (const statement of statements) checkStatement(statement.sql, statement.params);
        return statements.length === 0 ? [] : inTransaction(statements);
      }),
  };
}

/**
 * Opens the database at `path` (a file, or ':memory:') with foreign keys
 * enforced and double-quoted string literals refused, as SQLite recommends.
 */
export function openNodeSqlite(path: string): NodeSqlite {
  let connection: DatabaseSync;
  try {
    connection = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
    });
  } catch (cause) {
    throw storageFailure('open', cause);
  }
  return {
    db: nodeSqlDb(connection),
    connection,
    close: () => {
      try {
        connection.close();
      } catch (cause) {
        throw storageFailure('close', cause);
      }
    },
  };
}

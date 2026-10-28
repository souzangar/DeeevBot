// @critical-path
// The D1 adapter of the SqlDb port (src/db/sql.ts;
// doc/architecture/adr-0004-storage-and-delivery-ledger.md). Every value is
// bound with D1PreparedStatement.bind after checkStatement(); batch() is
// D1Database.batch, which runs the statements in order as one transaction
// and rolls every one back when one fails. Every D1 failure leaves as an
// AppError STORAGE_FAILURE whose message names the operation only; D1's
// error is its `cause`, which the redacting logger never reads. D1 is a
// binding, so no credential is involved (critical invariant 6).
//
// A Free-plan daily-cap error is not told apart from other failures here:
// its text is not established offline, and the step's contract for both is
// the same (stop without writing, resume after the reset; the MVP plan,
// section 4).
import { AppError } from '../errors/app-error';
import { checkStatement, type SqlDb, type SqlRow, type SqlText, type SqlValue } from './sql';

const storageFailure = (operation: string, cause: unknown): AppError =>
  new AppError('STORAGE_FAILURE', `D1 ${operation} failed`, { cause });

/** The SqlDb port over the D1 binding. */
export function d1SqlDb(d1: D1Database): SqlDb {
  const prepare = (text: SqlText, params: readonly SqlValue[]): D1PreparedStatement => {
    const statement = d1.prepare(text);
    return params.length === 0 ? statement : statement.bind(...params);
  };

  return {
    run: async (text, params = []) => {
      checkStatement(text, params);
      try {
        const result = await prepare(text, params).run();
        return { changes: result.meta.changes };
      } catch (cause) {
        throw storageFailure('run', cause);
      }
    },
    all: async <T extends object = SqlRow>(text: SqlText, params: readonly SqlValue[] = []) => {
      checkStatement(text, params);
      try {
        const result = await prepare(text, params).all<T>();
        return result.results;
      } catch (cause) {
        throw storageFailure('all', cause);
      }
    },
    first: async <T extends object = SqlRow>(text: SqlText, params: readonly SqlValue[] = []) => {
      checkStatement(text, params);
      try {
        return await prepare(text, params).first<T>();
      } catch (cause) {
        throw storageFailure('first', cause);
      }
    },
    batch: async (statements) => {
      // Every statement is checked before anything reaches D1.
      for (const statement of statements) checkStatement(statement.sql, statement.params);
      if (statements.length === 0) return [];
      try {
        const results = await d1.batch(statements.map((statement) => prepare(statement.sql, statement.params)));
        return results.map((result) => ({ changes: result.meta.changes }));
      } catch (cause) {
        throw storageFailure('batch', cause);
      }
    },
  };
}

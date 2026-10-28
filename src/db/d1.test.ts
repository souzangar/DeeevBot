// Unit tests for the D1 adapter's mapping (src/db/d1.ts), on a recording
// stand-in for the D1 binding: what reaches D1 (the text, the bound values,
// the batch), what comes back (changes, rows, null), and the error shape.
// The adapter on the real local D1 is tested in test/workers/d1.test.ts.
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors/app-error';
import { d1SqlDb } from './d1';
import { sql } from './sql';

interface Recorded {
  readonly text: string;
  readonly values: readonly unknown[];
}

/** A D1Database that records each prepared statement and answers from `answer`. */
const standIn = (answer: {
  rows?: Record<string, unknown>[];
  changes?: number;
  failure?: Error;
}) => {
  const executed: Recorded[] = [];
  const batches: Recorded[][] = [];
  const statement = (text: string, values: readonly unknown[] = []) => {
    const recorded = { text, values };
    const settle = <T>(value: T): Promise<T> => {
      executed.push(recorded);
      return answer.failure === undefined ? Promise.resolve(value) : Promise.reject(answer.failure);
    };
    return {
      recorded,
      bind: (...bound: unknown[]) => statement(text, bound),
      run: () => settle({ success: true, meta: { changes: answer.changes ?? 0 }, results: [] }),
      all: () => settle({ success: true, meta: { changes: 0 }, results: answer.rows ?? [] }),
      first: () => settle(answer.rows?.[0] ?? null),
    };
  };
  const d1 = {
    prepare: (text: string) => statement(text),
    batch: (statements: { recorded: Recorded }[]) => {
      batches.push(statements.map((each) => each.recorded));
      if (answer.failure !== undefined) return Promise.reject(answer.failure);
      return Promise.resolve(statements.map(() => ({ success: true, meta: { changes: answer.changes ?? 0 }, results: [] })));
    },
  };
  return { db: d1SqlDb(d1 as unknown as D1Database), executed, batches };
};

describe('the D1 adapter', () => {
  it('binds the values and reports the changes of a run', async () => {
    const { db, executed } = standIn({ changes: 3 });
    expect(await db.run(sql`UPDATE t SET a = ? WHERE b = ?`, ['x', 2])).toEqual({ changes: 3 });
    expect(executed).toEqual([{ text: 'UPDATE t SET a = ? WHERE b = ?', values: ['x', 2] }]);
  });

  it('returns the rows of all() and the first row, or null, of first()', async () => {
    const rows = [{ id: 1 }, { id: 2 }];
    expect(await standIn({ rows }).db.all(sql`SELECT id FROM t`)).toEqual(rows);
    expect(await standIn({ rows }).db.first(sql`SELECT id FROM t WHERE id = ?`, [1])).toEqual({ id: 1 });
    expect(await standIn({ rows: [] }).db.first(sql`SELECT id FROM t WHERE id = ?`, [9])).toBeNull();
  });

  it('sends a batch as one D1 batch, in order, and an empty batch as none', async () => {
    const { db, batches } = standIn({ changes: 1 });
    expect(
      await db.batch([
        { sql: sql`INSERT INTO t (a) VALUES (?)`, params: [1] },
        { sql: sql`DELETE FROM t WHERE a = ?`, params: [2] },
      ]),
    ).toEqual([{ changes: 1 }, { changes: 1 }]);
    expect(await db.batch([])).toEqual([]);
    expect(batches).toEqual([
      [
        { text: 'INSERT INTO t (a) VALUES (?)', values: [1] },
        { text: 'DELETE FROM t WHERE a = ?', values: [2] },
      ],
    ]);
  });

  it('refuses a statement D1 must not see, before sending anything', async () => {
    const { db, executed, batches } = standIn({});
    await expect(db.run(sql`DELETE FROM t WHERE a = ?`)).rejects.toMatchObject({ code: 'UNEXPECTED' });
    await expect(
      db.batch([
        { sql: sql`DELETE FROM t WHERE a = ?`, params: [1] },
        { sql: sql`DELETE FROM t; DELETE FROM u`, params: [] },
      ]),
    ).rejects.toMatchObject({ code: 'UNEXPECTED' });
    expect(executed).toEqual([]);
    expect(batches).toEqual([]);
  });

  it('turns every D1 failure into a STORAGE_FAILURE naming the operation, with the cause', async () => {
    const failure = new Error('D1_ERROR: UNIQUE constraint failed: t.a');
    const { db } = standIn({ failure });
    const operations = [
      ['run', db.run(sql`INSERT INTO t (a) VALUES (?)`, ['a value'])],
      ['all', db.all(sql`SELECT a FROM t`)],
      ['first', db.first(sql`SELECT a FROM t`)],
      ['batch', db.batch([{ sql: sql`INSERT INTO t (a) VALUES (?)`, params: ['a value'] }])],
    ] as const;
    for (const [operation, pending] of operations) {
      const error: unknown = await pending.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ code: 'STORAGE_FAILURE', message: `D1 ${operation} failed`, cause: failure });
    }
  });
});

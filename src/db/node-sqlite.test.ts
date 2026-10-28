// Unit tests for the node:sqlite adapter (src/db/node-sqlite.ts): the SqlDb
// port over one connection, the batch as one transaction, the statement
// checks applied before the driver, and the error shape (an AppError
// STORAGE_FAILURE whose message carries no value).
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors/app-error';
import { openNodeSqlite } from './node-sqlite';
import { sql } from './sql';

const CREATE = sql`CREATE TABLE notes (id INTEGER NOT NULL PRIMARY KEY, body TEXT NOT NULL CHECK (body <> 'refused'), flag INTEGER) WITHOUT ROWID`;
const INSERT = sql`INSERT INTO notes (id, body, flag) VALUES (?, ?, ?)`;
const ALL = sql`SELECT id, body, flag FROM notes ORDER BY id`;
const ONE = sql`SELECT body FROM notes WHERE id = ?`;

const fresh = async () => {
  const database = openNodeSqlite(':memory:');
  await database.db.run(CREATE);
  return database;
};

describe('the node:sqlite SqlDb', () => {
  it('runs, reads all and reads the first row through bound parameters', async () => {
    const { db } = await fresh();
    expect(await db.run(INSERT, [1, 'one', null])).toEqual({ changes: 1 });
    expect(await db.run(INSERT, [2, 'two', 1])).toEqual({ changes: 1 });
    expect(await db.all(ALL)).toEqual([
      { id: 1, body: 'one', flag: null },
      { id: 2, body: 'two', flag: 1 },
    ]);
    expect(await db.first(ONE, [2])).toEqual({ body: 'two' });
    expect(await db.first(ONE, [3])).toBeNull();
    expect(await db.run(sql`DELETE FROM notes WHERE id > ?`, [0])).toEqual({ changes: 2 });
  });

  it('returns plain objects, as D1 does', async () => {
    const { db } = await fresh();
    await db.run(INSERT, [1, 'one', null]);
    const [row] = await db.all(ALL);
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(await db.first(ONE, [1]))).toBe(Object.prototype);
  });

  it('stores a value that looks like SQL as text, never as SQL', async () => {
    const { db } = await fresh();
    const hostile = "x'); DROP TABLE notes; --";
    await db.run(INSERT, [1, hostile, null]);
    expect(await db.first(ONE, [1])).toEqual({ body: hostile });
    expect(await db.all(ALL)).toHaveLength(1);
  });

  it('applies a batch in one transaction: a failing statement rolls back the earlier ones', async () => {
    const { db, connection } = await fresh();
    const failing = db.batch([
      { sql: INSERT, params: [1, 'kept?', null] },
      { sql: INSERT, params: [2, 'refused', null] },
    ]);
    await expect(failing).rejects.toBeInstanceOf(AppError);
    await expect(failing).rejects.toMatchObject({ code: 'STORAGE_FAILURE' });
    expect(connection.isTransaction).toBe(false);
    expect(await db.all(ALL)).toEqual([]);
    expect(
      await db.batch([
        { sql: INSERT, params: [1, 'one', null] },
        { sql: sql`UPDATE notes SET flag = ? WHERE id = ?`, params: [1, 1] },
        { sql: sql`UPDATE notes SET flag = ? WHERE id = ?`, params: [1, 99] },
      ]),
    ).toEqual([{ changes: 1 }, { changes: 1 }, { changes: 0 }]);
    expect(await db.batch([])).toEqual([]);
  });

  it('checks every statement of a batch before it opens a transaction', async () => {
    const { db, connection } = await fresh();
    await expect(
      db.batch([
        { sql: INSERT, params: [1, 'one', null] },
        { sql: INSERT, params: [2, 'two'] },
      ]),
    ).rejects.toMatchObject({ code: 'UNEXPECTED' });
    expect(connection.isTransaction).toBe(false);
    expect(await db.all(ALL)).toEqual([]);
  });

  it('refuses a batch while another transaction holds the connection, changing nothing', async () => {
    const { db, connection } = await fresh();
    connection.exec('BEGIN');
    await expect(db.batch([{ sql: INSERT, params: [1, 'one', null] }])).rejects.toMatchObject({
      code: 'STORAGE_FAILURE',
    });
    connection.exec('ROLLBACK');
    expect(await db.all(ALL)).toEqual([]);
  });

  it('refuses a missing parameter instead of binding NULL, and a second statement instead of ignoring it', async () => {
    const { db } = await fresh();
    await expect(db.run(INSERT, [1, 'one'])).rejects.toMatchObject({ code: 'UNEXPECTED' });
    await expect(db.all(sql`SELECT 1; DELETE FROM notes`)).rejects.toMatchObject({ code: 'UNEXPECTED' });
  });

  it('reports a driver failure as STORAGE_FAILURE, cause attached, no value in the message', async () => {
    const { db } = await fresh();
    await db.run(INSERT, [1, 'secret-ish body', null]);
    const error: unknown = await db.run(INSERT, [1, 'secret-ish body', null]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'STORAGE_FAILURE', message: 'node:sqlite statement failed' });
    expect((error as AppError).cause).toBeInstanceOf(Error);
    await expect(db.run(sql`SELEC 1`)).rejects.toMatchObject({ code: 'STORAGE_FAILURE' });
  });
});

describe('openNodeSqlite', () => {
  it('enforces foreign keys and refuses double-quoted string literals', async () => {
    const { db } = openNodeSqlite(':memory:');
    await db.run(sql`CREATE TABLE parent (id INTEGER NOT NULL PRIMARY KEY) WITHOUT ROWID`);
    await db.run(sql`CREATE TABLE child (parent_id INTEGER NOT NULL REFERENCES parent (id))`);
    await expect(db.run(sql`INSERT INTO child (parent_id) VALUES (?)`, [1])).rejects.toMatchObject({
      code: 'STORAGE_FAILURE',
    });
    await expect(db.all(sql`SELECT "not a column"`)).rejects.toMatchObject({ code: 'STORAGE_FAILURE' });
  });

  it('reports an unopenable path and a double close as STORAGE_FAILURE', () => {
    expect(() => openNodeSqlite('/nonexistent-dir-div-report/x.sqlite')).toThrow(
      expect.objectContaining({ code: 'STORAGE_FAILURE' }),
    );
    const database = openNodeSqlite(':memory:');
    database.close();
    expect(() => database.close()).toThrow(expect.objectContaining({ code: 'STORAGE_FAILURE' }));
  });
});

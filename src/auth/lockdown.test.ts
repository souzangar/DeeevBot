// Unit tests for the two-layer lockdown (src/auth/lockdown.ts) on the D1
// schema under node:sqlite: the override needs no query, the switch is a
// meta row with its time, set once and cleared with the alert marker, and a
// failed read is an error, never "not locked". Who may set and clear it is
// test/invariants/lockdown.test.ts.
import { describe, expect, it } from 'vitest';
import { fakeClock } from '../../test/fakes/clock';
import { testConfig } from '../../test/support/config';
import { migratedDatabase } from '../../test/support/database';
import { concatSql, sql, type SqlDb } from '../db/sql';
import { AppError } from '../errors/app-error';
import {
  clearLockdown,
  isLockedDown,
  LOCKDOWN_ALERTED_KEY,
  LOCKDOWN_KEY,
  lockdownSwitchSet,
  NOT_LOCKED_DOWN,
  setLockdown,
} from './lockdown';

const NOW = 1_850_000_000_000;
const META = sql`SELECT key, value FROM meta WHERE key IN ('lockdown', 'lockdown_alerted_at') ORDER BY key`;

const setup = () => {
  const clock = fakeClock(NOW);
  return { clock, db: migratedDatabase(clock).db };
};

/** A database that fails every call, to prove the override needs none. */
const failingDb: SqlDb = {
  run: () => Promise.reject(new AppError('STORAGE_CAP_HIT', 'D1 run failed')),
  all: () => Promise.reject(new AppError('STORAGE_CAP_HIT', 'D1 all failed')),
  first: () => Promise.reject(new AppError('STORAGE_CAP_HIT', 'D1 first failed')),
  batch: () => Promise.reject(new AppError('STORAGE_CAP_HIT', 'D1 batch failed')),
};

describe('isLockedDown', () => {
  it('is false with neither layer set', async () => {
    const { db } = setup();
    expect(await isLockedDown(testConfig(), db)).toBe(false);
  });

  it('is true under the LOCKDOWN override without any query, even when D1 refuses every one', async () => {
    expect(await isLockedDown(testConfig({ LOCKDOWN: '1' }), failingDb)).toBe(true);
  });

  it('is true while the switch is set', async () => {
    const { db, clock } = setup();
    await setLockdown(db, clock);
    expect(await isLockedDown(testConfig(), db)).toBe(true);
  });

  it('throws, never answers "not locked", when the switch cannot be read', async () => {
    await expect(isLockedDown(testConfig(), failingDb)).rejects.toMatchObject({ code: 'STORAGE_CAP_HIT' });
  });
});

describe('setLockdown and clearLockdown', () => {
  it('writes the switch with the time it was set, and keeps the first time when set again', async () => {
    const { db, clock } = setup();
    expect(await setLockdown(db, clock)).toBe(true);
    clock.advance(60_000);
    expect(await setLockdown(db, clock)).toBe(false);
    expect(await db.all(META)).toEqual([{ key: LOCKDOWN_KEY, value: NOW }]);
  });

  it('clears the switch and the once-only alert marker together', async () => {
    const { db, clock } = setup();
    await setLockdown(db, clock);
    await db.run(sql`INSERT INTO meta (key, value) VALUES ('lockdown_alerted_at', ?)`, [NOW + 1]);
    expect(await clearLockdown(db)).toBe(true);
    expect(await db.all(META)).toEqual([]);
    expect(await lockdownSwitchSet(db)).toBe(false);
  });

  it('reports that there was nothing to clear, and still clears a stray alert marker', async () => {
    const { db } = setup();
    await db.run(sql`INSERT INTO meta (key, value) VALUES ('lockdown_alerted_at', ?)`, [NOW]);
    expect(await clearLockdown(db)).toBe(false);
    expect(await db.all(META)).toEqual([]);
  });

  it('leaves the other meta rows alone', async () => {
    const { db, clock } = setup();
    await setLockdown(db, clock);
    await db.run(sql`INSERT INTO meta (key, value) VALUES ('halted', 1)`);
    await clearLockdown(db);
    expect(await db.all(sql`SELECT key FROM meta ORDER BY key`)).toEqual([{ key: 'halted' }, { key: 'schema_version' }]);
  });

  it('names the keys the schema documents', () => {
    expect([LOCKDOWN_KEY, LOCKDOWN_ALERTED_KEY]).toEqual(['lockdown', 'lockdown_alerted_at']);
  });
});

describe('NOT_LOCKED_DOWN', () => {
  it('lets a statement bind the switch in its own WHERE clause', async () => {
    const { db, clock } = setup();
    const statement = concatSql(sql`SELECT 1 AS open WHERE `, NOT_LOCKED_DOWN);
    expect(await db.first(statement)).toEqual({ open: 1 });
    await setLockdown(db, clock);
    expect(await db.first(statement)).toBeNull();
  });
});

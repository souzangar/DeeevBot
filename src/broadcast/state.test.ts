// Unit tests for the scheduler's view of `meta` (src/broadcast/state.ts), on
// node:sqlite with the D1 migrations: the state read in one query, with the
// LOCKDOWN override; /halt set once and cleared, never under lockdown; the
// global pause only ever moved later; the storage-failure class.
import { describe, expect, it } from 'vitest';
import { setLockdown } from '../auth/lockdown';
import { sql } from '../db/sql';
import { AppError } from '../errors/app-error';
import { fakeClock } from '../../test/fakes/clock';
import { migratedDatabase } from '../../test/support/database';
import { testConfig } from '../../test/support/config';
import { clearHalt, isPaused, isStorageFailure, pauseStatement, readTickState, setHalt } from './state';

const NOW = 1_800_000_000_000;

const setup = () => {
  const clock = fakeClock(NOW);
  return { clock, ...migratedDatabase(clock) };
};

describe('readTickState', () => {
  it('reads an empty meta as nothing held', async () => {
    const { db } = setup();
    expect(await readTickState(testConfig(), db)).toEqual({ locked: false, lockdownSetAt: null, lockdownAlerted: false, halted: false, pausedUntil: null });
  });

  it('reads the switch with its time, the alert marker, /halt and the pause, in one query', async () => {
    const { db, clock } = setup();
    await setLockdown(db, clock);
    await db.run(sql`INSERT INTO meta (key, value) VALUES ('lockdown_alerted_at', ?), ('halted', ?), ('paused_until', ?)`, [NOW + 1, NOW + 2, NOW + 60_000]);
    expect(await readTickState(testConfig(), db)).toEqual({ locked: true, lockdownSetAt: NOW, lockdownAlerted: true, halted: true, pausedUntil: NOW + 60_000 });
  });

  it('is locked under the LOCKDOWN override with no switch', async () => {
    const { db } = setup();
    expect(await readTickState(testConfig({ LOCKDOWN: '1' }), db)).toMatchObject({ locked: true, lockdownSetAt: null });
  });

  it('lets a failed read through as a storage failure', async () => {
    const { db, connection } = setup();
    connection.close();
    await expect(readTickState(testConfig(), db)).rejects.toMatchObject({ code: 'STORAGE_FAILURE' });
  });
});

describe('/halt and /resume in meta', () => {
  it('sets /halt once, keeping its first time, and clears it', async () => {
    const { db, clock } = setup();
    expect(await setHalt(db, clock)).toBe(true);
    clock.advance(5_000);
    expect(await setHalt(db, clock)).toBe(false);
    expect(await db.all(sql`SELECT value FROM meta WHERE key = 'halted'`)).toEqual([{ value: NOW }]);
    expect(await clearHalt(db)).toBe(true);
    expect(await clearHalt(db)).toBe(false);
  });

  it('never clears /halt under the lockdown switch', async () => {
    const { db, clock } = setup();
    await setHalt(db, clock);
    await setLockdown(db, clock);
    expect(await clearHalt(db)).toBe(false);
    expect(await db.all(sql`SELECT key FROM meta WHERE key = 'halted'`)).toEqual([{ key: 'halted' }]);
  });
});

describe('the global pause', () => {
  it('lies ahead until its time, and only ever moves later', async () => {
    const { db } = setup();
    expect(isPaused({ pausedUntil: null }, NOW)).toBe(false);
    expect(isPaused({ pausedUntil: NOW + 1 }, NOW)).toBe(true);
    expect(isPaused({ pausedUntil: NOW }, NOW)).toBe(false);
    const pause = pauseStatement(NOW + 60_000);
    await db.batch([pause]);
    await db.batch([pauseStatement(NOW + 1_000)]);
    expect(await db.all(sql`SELECT value FROM meta WHERE key = 'paused_until'`)).toEqual([{ value: NOW + 60_000 }]);
    await db.batch([pauseStatement(NOW + 90_000)]);
    expect(await db.all(sql`SELECT value FROM meta WHERE key = 'paused_until'`)).toEqual([{ value: NOW + 90_000 }]);
  });
});

describe('isStorageFailure', () => {
  it('is a failure of the store, a daily cap included, and nothing else', () => {
    expect(isStorageFailure(new AppError('STORAGE_FAILURE', 'down'))).toBe(true);
    expect(isStorageFailure(new AppError('STORAGE_CAP_HIT', 'capped'))).toBe(true);
    expect(isStorageFailure(new AppError('TELEGRAM_TRANSIENT', 'timed out'))).toBe(false);
    expect(isStorageFailure(new Error('STORAGE_FAILURE'))).toBe(false);
  });
});

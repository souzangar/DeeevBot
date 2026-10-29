// Unit tests for the maintenance slots and the one lockdown entry
// (src/broadcast/maintenance.ts; critical invariants 2 and 8): the slots
// are no-ops until the closure and retention unit fills them; lockdownNow()
// sets the switch with its log line, then runs the immediate retention
// pass, also when the switch was set already, and a pass that fails is
// logged by class and leaves the switch set.
import { describe, expect, it } from 'vitest';
import { isLockedDown } from '../auth/lockdown';
import { sql } from '../db/sql';
import { createBotApi } from '../telegram/api';
import { fakeBotApi } from '../../test/fakes/bot-api';
import { fakeClock } from '../../test/fakes/clock';
import { recordingLogger } from '../../test/fakes/logger';
import { testConfig } from '../../test/support/config';
import { migratedDatabase } from '../../test/support/database';
import { finalize, lockdownNow, runRetention, runRetentionNow, runSnapshot, type MaintenanceDeps } from './maintenance';

const NOW = 1_800_000_000_000;

const setup = () => {
  const clock = fakeClock(NOW);
  const telegram = fakeBotApi();
  const log = recordingLogger();
  const config = testConfig();
  const database = migratedDatabase(clock);
  const deps: MaintenanceDeps = { api: createBotApi(config, telegram.fetch), config, db: database.db, clock, logger: log.logger };
  return { deps, telegram, log, db: database.db };
};

describe('the slots of the closure and retention unit', () => {
  it('are no-ops until it fills them: no call, no write', async () => {
    const { deps, telegram, log, db } = setup();
    await runRetention(deps, NOW);
    await runRetentionNow(deps);
    await runSnapshot(deps, NOW);
    await finalize(deps, 'abcdefghijklmnopqrst', NOW);
    expect(telegram.calls).toEqual([]);
    expect(log.lines).toEqual([]);
    expect(await db.all(sql`SELECT key FROM meta WHERE key <> 'schema_version'`)).toEqual([]);
  });
});

describe('lockdownNow', () => {
  it('sets the switch, logs it, then runs the retention pass', async () => {
    const { deps, log, db } = setup();
    const order: string[] = [];
    const set = await lockdownNow({
      ...deps,
      retentionNow: async (passDeps) => {
        order.push((await isLockedDown(passDeps.config, passDeps.db)) ? 'pass after the switch' : 'pass before the switch');
      },
    });
    expect(set).toBe(true);
    expect(order).toEqual(['pass after the switch']);
    expect(await db.all(sql`SELECT value FROM meta WHERE key = 'lockdown'`)).toEqual([{ value: NOW }]);
    expect(log.records()).toEqual([{ level: 'info', event: 'lockdown.set' }]);
  });

  it('runs the pass again when the switch was set already, without a second log line', async () => {
    const { deps, log } = setup();
    let passes = 0;
    const retentionNow = () => {
      passes += 1;
      return Promise.resolve();
    };
    expect(await lockdownNow({ ...deps, retentionNow })).toBe(true);
    expect(await lockdownNow({ ...deps, retentionNow })).toBe(false);
    expect(passes).toBe(2);
    expect(log.records()).toEqual([{ level: 'info', event: 'lockdown.set' }]);
  });

  it('runs the real pass, a no-op until U6, when given none', async () => {
    const { deps } = setup();
    expect(await lockdownNow(deps)).toBe(true);
  });

  it('logs a failing pass by class and leaves the switch set', async () => {
    const { deps, log } = setup();
    const set = await lockdownNow({ ...deps, retentionNow: () => Promise.reject(new TypeError('https://x.com/someone was in the way')) });
    expect(set).toBe(true);
    expect(await isLockedDown(deps.config, deps.db)).toBe(true);
    expect(log.records()).toEqual([
      { level: 'info', event: 'lockdown.set' },
      { level: 'error', event: 'retention.failed', errorClass: 'TypeError' },
    ]);
    expect(log.text()).not.toContain('x.com');
  });

  it('throws, running no pass, when the switch cannot be written', async () => {
    const { deps } = setup();
    let passes = 0;
    const broken = { ...deps, db: { ...deps.db, run: () => Promise.reject(new Error('down')) } };
    await expect(
      lockdownNow({
        ...broken,
        retentionNow: () => {
          passes += 1;
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow('down');
    expect(passes).toBe(0);
  });
});

// Unit tests for the maintenance slots and the one lockdown entry
// (src/broadcast/maintenance.ts; critical invariants 2 and 8): the slots run
// the closure and retention unit's jobs (the retention job, at the run's
// time or at the clock's, the monthly snapshot, a terminal report's
// finalization, whose own tests are beside them); lockdownNow() sets the
// switch with its log line, then runs the immediate retention pass, also
// when the switch was set already, and a pass that fails is logged by
// class and leaves the switch set.
import { describe, expect, it } from 'vitest';
import { isLockedDown } from '../auth/lockdown';
import { sql } from '../db/sql';
import { createBotApi } from '../telegram/api';
import { fakeBotApi } from '../../test/fakes/bot-api';
import { fakeClock } from '../../test/fakes/clock';
import { recordingLogger } from '../../test/fakes/logger';
import { IDS, testConfig } from '../../test/support/config';
import { migratedDatabase } from '../../test/support/database';
import { hex, insertReport, reportRow } from '../../test/support/review-rows';
import { finalize, lockdownNow, runRetention, runRetentionNow, runSnapshot, type MaintenanceDeps } from './maintenance';

const NOW = 1_800_000_000_000;

const setup = () => {
  const clock = fakeClock(NOW);
  const telegram = fakeBotApi();
  const log = recordingLogger();
  const config = testConfig();
  const database = migratedDatabase(clock);
  const deps: MaintenanceDeps = { api: createBotApi(config, telegram.fetch), config, db: database.db, clock, logger: log.logger };
  return { deps, telegram, log, db: database.db, clock };
};

const DAY = 86_400_000;

describe('the slots of the closure and retention unit', () => {
  it('runRetention runs the retention job at the run\'s time, and runRetentionNow at the clock\'s', async () => {
    const { deps, db, log, clock, telegram } = setup();
    const draft = sql`INSERT INTO drafts (draft_key, step, locale, created_at, updated_at) VALUES (?, 'url', 'en', ?, ?)`;
    await db.run(draft, [hex(1), NOW - 2 * DAY, NOW - 2 * DAY]);
    await db.run(draft, [hex(2), NOW - DAY / 2, NOW - DAY / 2]);
    await runRetention(deps, NOW);
    expect(await db.all(sql`SELECT draft_key FROM drafts`)).toEqual([{ draft_key: hex(2) }]);
    clock.set(NOW + DAY);
    await runRetentionNow(deps);
    expect(await db.all(sql`SELECT draft_key FROM drafts`)).toEqual([]);
    expect(log.records().map((record) => [record.event, record.drafts])).toEqual([
      ['retention.done', 1],
      ['retention.done', 1],
    ]);
    expect(telegram.calls).toEqual([]);
  });

  it('runSnapshot sends the previous month\'s counts to every keyholder and to the venue', async () => {
    const { deps, telegram } = setup();
    // NOW is 2027-01-15: the snapshot of 2027-02-01 is January's.
    await runSnapshot(deps, Date.UTC(2027, 1, 1, 6, 0));
    expect(telegram.callsOf('sendMessage').map((call) => call.chatId)).toEqual([...deps.config.keyholderIds, IDS.adminChat]);
    expect(String(telegram.callsOf('sendMessage')[0]?.payload.text)).toContain('2027-01');
  });

  it('finalize finalizes a closed row whose finalization never landed, and nothing open, closing or retracting', async () => {
    const { deps, db } = setup();
    const closed = await insertReport(db, { status: 'closed', posting_started_at: NOW - 3 * DAY, posted_at: NOW - 3 * DAY, post_message_id: 70 });
    const closing = await insertReport(db, { status: 'closing', posting_started_at: NOW - 3 * DAY, posted_at: NOW - 3 * DAY, post_message_id: 71 });
    await finalize(deps, closed, NOW);
    await finalize(deps, closing, NOW);
    expect(await reportRow(db, closed)).toMatchObject({ status: 'closed', url: null, reporter_ref: null, data_deleted_at: NOW });
    expect(await reportRow(db, closing)).toMatchObject({ status: 'closing', post_message_id: 71, data_deleted_at: null });
    expect(await db.all(sql`SELECT report_id FROM stats`)).toEqual([{ report_id: closed }]);
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

  it('runs the real pass, the retention job at the clock\'s now, when given none', async () => {
    const { deps, log } = setup();
    expect(await lockdownNow(deps)).toBe(true);
    expect(log.records().map((record) => record.event)).toEqual(['lockdown.set', 'retention.done']);
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

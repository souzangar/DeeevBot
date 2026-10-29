// Unit tests for the one-minute run (src/broadcast/tick.ts; critical
// invariants 1, 2, 5 and 8), over the fakes on node:sqlite: the passes by
// the UTC minute; the lockdown alert, once, to the keyholders only; a
// storage failure that stops the run without writing and alerts at most
// once a day; any other failure logged by class, the run ending normally;
// the cron dispatch; the step budget of a run, counted on the fakes.
import { describe, expect, it } from 'vitest';
import { setLockdown } from '../auth/lockdown';
import { sql, type SqlDb, type SqlText, type SqlValue } from '../db/sql';
import { AppError } from '../errors/app-error';
import { t } from '../i18n/index';
import { FAILURES } from '../../test/fakes/bot-api';
import { plantApproved, TICK_AT, tickHarness } from '../../test/support/tick-harness';
import { IDS } from '../../test/support/variables';
import { handleScheduled, LOCKDOWN_ALERT_FRESH_MS, TICK_CRON, tick, type TickHooks } from './tick';

const MINUTE = 60_000;
const at = (hour: number, minute: number, day = 15, month = 0): number => Date.UTC(2027, month, day, hour, minute);

/** Hooks that record which pass ran at which time. */
const spies = () => {
  const ran: string[] = [];
  const record =
    (name: string) =>
    (...args: unknown[]): Promise<void> => {
      ran.push(`${name}@${String(args[1])}`);
      return Promise.resolve();
    };
  const hooks: Partial<TickHooks> = { reconcile: record('reconcile'), retention: record('retention'), snapshot: record('snapshot') };
  return { ran, hooks };
};

const lockdownAlert = `${t('fa', 'alert.lockdown')}\n\n${t('en', 'alert.lockdown')}`;
const storageAlert = `${t('fa', 'alert.storage')}\n\n${t('en', 'alert.storage')}`;
const marker = (db: SqlDb) => db.first(sql`SELECT value FROM meta WHERE key = 'lockdown_alerted_at'`);

describe('the passes by the minute', () => {
  it('reconciles on every 15th minute, and at no other', async () => {
    const { ran, hooks } = spies();
    const harness = tickHarness({ hooks });
    for (const minute of [0, 1, 14, 15, 29, 30, 44, 45, 59]) await harness.run(at(12, minute));
    expect(ran).toEqual([at(12, 0), at(12, 15), at(12, 30), at(12, 45)].map((time) => `reconcile@${time}`));
  });

  it('runs the retention job at 00:15 UTC and the snapshot on the first day at 06:00 UTC, and never else', async () => {
    const { ran, hooks } = spies();
    const harness = tickHarness({ hooks });
    for (const time of [at(0, 14), at(0, 15), at(0, 16), at(12, 15), at(6, 0, 1, 1), at(6, 0, 2, 1), at(6, 1, 1, 1)]) await harness.run(time);
    expect(ran.filter((entry) => !entry.startsWith('reconcile'))).toEqual([`retention@${at(0, 15)}`, `snapshot@${at(6, 0, 1, 1)}`]);
  });

  it('runs them under lockdown too, and posts nothing', async () => {
    const { ran, hooks } = spies();
    const harness = tickHarness({ hooks });
    await plantApproved(harness);
    await setLockdown(harness.db, harness.clock);
    const outcome = await harness.run(at(0, 15, 16));
    expect(outcome).toMatchObject({ post: 'skipped', ran: ['reconcile', 'retention'] });
    expect(ran).toEqual([`reconcile@${at(0, 15, 16)}`, `retention@${at(0, 15, 16)}`]);
    expect(harness.telegram.callsOf('sendMessage').filter((call) => call.chatId === IDS.broadcastChannel)).toEqual([]);
  });

  it('runs the post before the edits, and both before the passes', async () => {
    const order: string[] = [];
    const harness = tickHarness({
      hooks: {
        reconcile: () => {
          order.push('reconcile');
          return Promise.resolve();
        },
      },
      edits: {
        close: () => {
          order.push('edit');
          return Promise.resolve();
        },
      },
    });
    await plantApproved(harness);
    await harness.db.run(sql`INSERT INTO reports (id, status, platform, category, created_at) VALUES ('closingreportxxxxxxx', 'closing', 'x', 'harassment', 1)`);
    await harness.db.run(sql`INSERT INTO jobs (id, kind, report_id, due_at, payload, created_at) VALUES ('closingjobxxxxxxxxxx', 'edit', 'closingreportxxxxxxx', 1, '{"action":"close"}', 1)`);
    const original = harness.deps.api.sendMessage.bind(harness.deps.api);
    const deps = {
      ...harness.deps,
      api: Object.assign(Object.create(harness.deps.api) as typeof harness.deps.api, {
        sendMessage: (...args: Parameters<typeof original>) => {
          order.push('post');
          return original(...args);
        },
      }),
    };
    await tick(deps, at(12, 30));
    expect(order).toEqual(['post', 'edit', 'reconcile']);
  });
});

describe('the lockdown alert', () => {
  it('goes to every keyholder, never the venue, on the run after the switch was set, and once', async () => {
    const harness = tickHarness();
    harness.clock.set(TICK_AT - 30_000);
    await setLockdown(harness.db, harness.clock);
    harness.clock.set(TICK_AT);
    await harness.run();
    expect(harness.textsTo(IDS.keyholder)).toEqual([lockdownAlert]);
    expect(harness.textsTo(IDS.secondKeyholder)).toEqual([lockdownAlert]);
    expect(harness.textsTo(IDS.adminChat)).toEqual([]);
    expect(await marker(harness.db)).toEqual({ value: TICK_AT });
    for (let minute = 1; minute <= 20; minute += 1) await harness.run(TICK_AT + minute * MINUTE);
    expect(harness.textsTo(IDS.keyholder)).toEqual([lockdownAlert]);
  });

  it('waits for a 15th minute when the switch is older than a fresh run, and under the override alone', async () => {
    for (const variables of [{}, { LOCKDOWN: '1' }]) {
      const harness = tickHarness({ variables });
      if (Object.keys(variables).length === 0) {
        harness.clock.set(TICK_AT - LOCKDOWN_ALERT_FRESH_MS);
        await setLockdown(harness.db, harness.clock);
      }
      await harness.run(at(12, 2));
      expect(harness.textsTo(IDS.keyholder), JSON.stringify(variables)).toEqual([]);
      await harness.run(at(12, 15));
      expect(harness.textsTo(IDS.keyholder), JSON.stringify(variables)).toEqual([lockdownAlert]);
    }
  });

  it('is marked once one keyholder got it: a keyholder unreachable on every call never makes it repeat', async () => {
    const harness = tickHarness({ variables: { LOCKDOWN: '1' } });
    harness.telegram.fail({ chatId: IDS.secondKeyholder }, FAILURES.botBlocked);
    await harness.run(at(12, 15));
    expect(await marker(harness.db)).toEqual({ value: at(12, 15) });
    for (const minute of [16, 30, 45]) await harness.run(at(12, minute));
    expect(harness.telegram.messagesIn(IDS.keyholder)).toEqual([expect.objectContaining({ text: lockdownAlert })]);
    expect(harness.log.records().map((record) => record.event)).toEqual(['alert.failed', 'lockdown.alert_incomplete']);
  });

  it('is sent again on the 15th minutes while it reached no keyholder', async () => {
    const harness = tickHarness({ variables: { LOCKDOWN: '1' } });
    for (const keyholder of [IDS.keyholder, IDS.secondKeyholder]) harness.telegram.fail({ chatId: keyholder }, FAILURES.cantInitiateConversation, 1);
    await harness.run(at(12, 15));
    expect(await marker(harness.db)).toBeNull();
    await harness.run(at(12, 16));
    expect(harness.telegram.callsOf('sendMessage')).toHaveLength(2);
    await harness.run(at(12, 30));
    expect(await marker(harness.db)).toEqual({ value: at(12, 30) });
    expect(harness.telegram.messagesIn(IDS.secondKeyholder)).toHaveLength(1);
    expect(harness.log.records().map((record) => record.event)).toEqual(['alert.failed', 'alert.failed', 'lockdown.alert_incomplete', 'lockdown.alerted']);
  });

  it('is forgotten once neither layer holds the bot, so the next lockdown alerts again', async () => {
    const harness = tickHarness();
    await harness.db.run(sql`INSERT INTO meta (key, value) VALUES ('lockdown_alerted_at', 1)`);
    await harness.run();
    expect(await marker(harness.db)).toBeNull();
    await setLockdown(harness.db, harness.clock);
    await harness.run();
    expect(harness.textsTo(IDS.keyholder)).toEqual([lockdownAlert]);
  });
});

describe('a storage failure', () => {
  /** A store whose every call fails once `failing` says so. */
  const failingStore = (state: { failing: boolean }) => (db: SqlDb): SqlDb => {
    const refuse = () => Promise.reject(new AppError('STORAGE_FAILURE', 'D1 refused'));
    return {
      run: (text: SqlText, params?: readonly SqlValue[]) => (state.failing ? refuse() : db.run(text, params)),
      all: <T extends object>(text: SqlText, params?: readonly SqlValue[]) => (state.failing ? refuse() : db.all<T>(text, params)),
      first: <T extends object>(text: SqlText, params?: readonly SqlValue[]) => (state.failing ? refuse() : db.first<T>(text, params)),
      batch: (statements) => (state.failing ? refuse() : db.batch(statements)),
    };
  };

  it('stops the run without a write, and alerts the keyholders once a day, on a 15th minute, never the venue', async () => {
    const store = { failing: true };
    const harness = tickHarness({ store: failingStore(store) });
    await plantApproved(harness);
    const before = await harness.db.all(sql`SELECT * FROM reports`);
    expect(await harness.run(at(12, 1))).toMatchObject({ post: 'skipped', stopped: 'storage' });
    expect(harness.telegram.calls).toEqual([]);
    await harness.run(at(12, 15));
    await harness.run(at(12, 30));
    expect(harness.textsTo(IDS.keyholder)).toEqual([storageAlert]);
    expect(harness.textsTo(IDS.adminChat)).toEqual([]);
    expect(await harness.db.all(sql`SELECT * FROM reports`)).toEqual(before);
    // The next UTC day it alerts again; once the store answers, the run resumes from what was committed.
    await harness.run(at(0, 15, 16));
    expect(harness.textsTo(IDS.keyholder)).toEqual([storageAlert, storageAlert]);
    store.failing = false;
    harness.clock.set(at(0, 16, 16));
    expect((await harness.run(at(0, 16, 16))).post).toBe('posted');
  });
});

describe('any other failure', () => {
  it('is logged by class, and the run ends normally', async () => {
    const harness = tickHarness({
      store: (db) => ({ ...db, all: () => Promise.reject(new TypeError('a bug about https://x.com/someone')) }),
    });
    expect(await harness.run()).toMatchObject({ stopped: 'failure' });
    expect(harness.log.records()).toEqual([{ level: 'error', event: 'tick.failed', errorClass: 'TypeError' }]);
  });
});

describe('handleScheduled', () => {
  it('runs the one cron under waitUntil, at its scheduled time', async () => {
    const harness = tickHarness();
    const planted = await plantApproved(harness);
    const waited: Promise<unknown>[] = [];
    handleScheduled({ cron: TICK_CRON, scheduledTime: TICK_AT }, { waitUntil: (promise) => void waited.push(promise) }, harness.deps);
    expect(waited).toHaveLength(1);
    expect(await waited[0]).toMatchObject({ post: 'posted' });
    expect(harness.telegram.messagesIn(IDS.broadcastChannel).map((message) => message.text)).toEqual([planted.text]);
  });

  it('runs nothing for any other cron expression, and says so', () => {
    const harness = tickHarness();
    const waited: Promise<unknown>[] = [];
    handleScheduled({ cron: '5 0 * * *', scheduledTime: TICK_AT }, { waitUntil: (promise) => void waited.push(promise) }, harness.deps);
    expect(waited).toEqual([]);
    expect(harness.log.records()).toEqual([{ level: 'info', event: 'cron.unknown' }]);
  });
});

describe('the step budget (counted on the fakes)', () => {
  it('a quiet run: three statements (the state, the due post, the due edit jobs), no call', async () => {
    const harness = tickHarness();
    harness.reset();
    await harness.run();
    expect(harness.tally.queries).toBe(3);
    expect(harness.telegram.calls).toEqual([]);
  });

  it('a run that posts: one send and its follow-ups, five statements', async () => {
    const harness = tickHarness();
    await plantApproved(harness);
    harness.reset();
    await harness.run();
    expect(harness.tally.queries).toBe(5);
    expect(harness.telegram.calls.map((call) => call.method)).toEqual(['sendMessage', 'editMessageText', 'deleteMessage']);
    expect(harness.telegram.callsOf('sendMessage')).toHaveLength(1);
  });

  it('a reconciliation run at its bounds stays far inside the 50 subrequests of an invocation', async () => {
    const harness = tickHarness({ edits: { close: () => Promise.resolve(), retract: () => Promise.resolve() } });
    await plantApproved(harness, { startsAt: at(11, 0) });
    for (let n = 0; n < 12; n += 1) {
      const id = `${'w'.repeat(18)}${String.fromCharCode(97 + Math.floor(n / 26))}${String.fromCharCode(97 + (n % 26))}`;
      await harness.db.run(sql`INSERT INTO reports (id, status, platform, category, created_at, needs_attention) VALUES (?, ?, 'x', 'harassment', 1, 1)`, [
        id,
        n % 2 === 0 ? 'closing' : 'expired',
      ]);
    }
    harness.reset();
    await harness.run(at(12, 15));
    const calls = harness.telegram.calls.length;
    expect(harness.tally.queries + calls).toBeLessThanOrEqual(30);
  });
});

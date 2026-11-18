// Unit tests for the Node port's entry (src/node.ts; critical invariants 1,
// 2, 6 and 8), over the fake Bot API's long polling, a fake clock, manual
// timers for the minute loop and an in-memory node:sqlite database:
// - startPort(): an empty database migrated with every file of
//   migrations/, the webhook deleted before the first getUpdates, a /start
//   fetched by long polling answered by the Worker's own bot; a refused
//   start, nothing polled and nothing sent, for a configuration that does
//   not load, a database that does not open, a migration that fails and a
//   deleteWebhook that fails; a due post sent once by the minute loop's
//   run, over a client bounded at SEND_TIMEOUT_SECONDS as on the Worker;
//   reconciliation, retention and the snapshot run by tick() at their
//   minutes and not at the minute before; stop() ending polling and
//   closing the database, once;
// - openDatabaseFile(): the directory and the file owner-only; a file that
//   cannot be made owner-only closes the database and fails, naming the
//   close's failure too when there is one;
// - runPort(): SIGTERM or SIGINT stops polling and closes the database,
//   exit code 0; a webhook set meanwhile (its 409) makes the port yield,
//   the keyholders alerted, exit code 0; polling that fails by itself
//   (another poller's 409, a 401) stops the port, exit code 1; a refused
//   start exits 1; a stop past its deadline exits 1;
// - onCrash(): an uncaught error logged by class, exit code 1;
// - isEntry(), and the entry itself in a child process, run as the
//   Dockerfile runs it: without a token it fails fast, exit code 1, with
//   one class-only line and nothing else of its own.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GrammyError } from 'grammy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FAILURES, fakeBotApi, type FakeBotApi } from '../test/fakes/bot-api';
import { fakeClock, type FakeClock } from '../test/fakes/clock';
import { recordingLogger, type RecordingLogger } from '../test/fakes/logger';
import { manualTimers, type ManualTimers } from '../test/fakes/timers';
import { MIGRATIONS_DIR as TEST_MIGRATIONS_DIR } from '../test/support/database';
import { insertApproval, insertReport } from '../test/support/review-rows';
import { privateMessage } from '../test/support/updates';
import { IDS, TEST_VARIABLES } from '../test/support/variables';
import { enqueuePost } from './broadcast/jobs';
import { SEND_TIMEOUT_SECONDS } from './broadcast/post';
import { openNodeSqlite, type NodeSqlite } from './db/node-sqlite';
import { sql } from './db/sql';
import { AppError } from './errors/app-error';
import { t } from './i18n/index';
import {
  isEntry,
  MIGRATIONS_DIR,
  NODE_FILE_SYSTEM,
  onCrash,
  openDatabaseFile,
  runPort,
  startPort,
  STOP_DEADLINE_MS,
  type PortEnd,
  type PortOptions,
  type RunningPort,
} from './node';

const ENTRY = fileURLToPath(new URL('./node.ts', import.meta.url).href);
const HOOKS = fileURLToPath(new URL('./node-hooks.ts', import.meta.url).href);
const REPORTED_URL = 'https://www.instagram.com/reported.account/';

/** A time in February 2027, UTC. */
const at = (day: number, hour: number, minute: number, second = 0): number => Date.UTC(2027, 1, day, hour, minute, second);

/** Temporary directories, removed after each test. */
const scratch: string[] = [];
const scratchDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'div-report-port-'));
  scratch.push(dir);
  return dir;
};

/** Ports a test started, stopped after it whatever happened. */
const running: RunningPort[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((port) => port.stop()));
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Rig {
  readonly telegram: FakeBotApi;
  readonly log: RecordingLogger;
  readonly clock: FakeClock;
  readonly timers: ManualTimers;
  readonly options: PortOptions;
  /** The database the port opened, once it did. */
  database(): NodeSqlite;
}

/** The port's options over fresh fakes, starting at `start`; its database in memory. */
const rig = (start: number, variables: Readonly<Record<string, string | undefined>> = {}, overrides: Partial<PortOptions> = {}): Rig => {
  const telegram = fakeBotApi({ channelIds: [IDS.broadcastChannel] });
  const log = recordingLogger();
  const clock = fakeClock(start);
  const timers = manualTimers(clock);
  let opened: NodeSqlite | undefined;
  const options: PortOptions = {
    env: { ...TEST_VARIABLES, ...variables },
    fetch: telegram.fetch,
    logger: log.logger,
    clock,
    timers,
    migrationsDir: MIGRATIONS_DIR,
    openDatabase: () => (opened = openNodeSqlite(':memory:')),
    ...overrides,
  };
  return {
    telegram,
    log,
    clock,
    timers,
    options,
    database: () => {
      if (opened === undefined) throw new Error('the port opened no database');
      return opened;
    },
  };
};

/** Starts the port of `setup`; fails the test when it refuses. */
const started = async (setup: Rig): Promise<RunningPort> => {
  const port = await startPort(setup.options);
  if (port === null) throw new Error(`the port refused to start: ${setup.log.text()}`);
  running.push(port);
  return port;
};

const events = (log: RecordingLogger): unknown[] => log.records().map((record) => record.event);

/** An approved report whose post job is due now, as the Worker's own test plants it; its id. */
const plantDuePost = async (setup: Rig): Promise<string> => {
  const { db } = setup.database();
  const now = setup.clock.now();
  const reportId = await insertReport(db, { comment: null, affected_person: null });
  const approvalId = await insertApproval(db, reportId, { approvedAt: now - 3_600_000, startsAt: now - 60_000 });
  await db.run(sql`UPDATE reports SET status = 'approved', broadcast_text = '<b>The post</b>', link_mode = 'account' WHERE id = ?`, [reportId]);
  await enqueuePost(db, setup.clock, reportId, approvalId, now - 60_000);
  return reportId;
};

const channelSends = (telegram: FakeBotApi) => telegram.callsOf('sendMessage').filter((call) => call.chatId === IDS.broadcastChannel);

/** Lets real macrotasks run, for code under fake setTimeout. */
const drain = async (rounds = 20): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

describe('startPort', () => {
  it('starts on an empty database: every migration applied, the webhook deleted before the first getUpdates, a /start fetched by long polling answered', async () => {
    const setup = rig(at(15, 12, 0, 30));
    const port = await started(setup);
    const { db, connection } = setup.database();
    const applied = await db.all<{ name: string }>(sql`SELECT name FROM schema_migrations ORDER BY name`);
    expect(applied.map((row) => row.name)).toEqual(readdirSync(TEST_MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort());
    expect(await db.first(sql`SELECT (SELECT count(*) FROM reports) AS reports, (SELECT count(*) FROM drafts) AS drafts`)).toEqual({ reports: 0, drafts: 0 });
    expect(await db.all(sql`SELECT key, value FROM meta`)).toEqual([{ key: 'schema_version', value: 2 }]);
    expect(await db.first(sql`PRAGMA secure_delete`)).toEqual({ secure_delete: 1 });

    await vi.waitFor(() => expect(setup.telegram.waitingForUpdates()).toBe(1));
    expect(setup.telegram.calls.map((call) => call.method)).toEqual(['deleteWebhook', 'getUpdates']);
    expect(setup.telegram.calls[0]?.payload).toEqual({});
    expect(setup.telegram.calls[1]?.payload).toMatchObject({ allowed_updates: ['message', 'callback_query'], timeout: 30 });

    setup.telegram.queueUpdates(privateMessage(IDS.reporter, '/start'));
    await vi.waitFor(() =>
      expect(setup.telegram.callsOf('sendMessage').map((call) => [call.chatId, call.payload.text])).toEqual([[IDS.reporter, t('en', 'start.intro')]]),
    );
    expect(setup.telegram.callsOf('sendMessage')[0]?.payload).toMatchObject({ link_preview_options: { is_disabled: true }, parse_mode: 'HTML' });

    await port.stop();
    expect(connection.isOpen).toBe(false);
    expect(setup.telegram.waitingForUpdates()).toBe(0);
    expect(setup.log.records()).toEqual([
      { level: 'info', event: 'port.migrated', count: 2 },
      { level: 'info', event: 'port.started' },
      { level: 'info', event: 'port.stopped' },
    ]);
  });

  it('applies nothing again on a database that has every migration: the same file, started twice', async () => {
    const dir = scratchDir();
    const path = join(dir, 'data', 'div-report.sqlite');
    const first = rig(at(15, 12, 0, 30), { SQLITE_PATH: path }, { openDatabase: openDatabaseFile });
    await (await started(first)).stop();
    const second = rig(at(15, 12, 5, 30), { SQLITE_PATH: path }, { openDatabase: openDatabaseFile });
    await (await started(second)).stop();
    expect(first.log.records()[0]).toEqual({ level: 'info', event: 'port.migrated', count: 2 });
    expect(second.log.records()[0]).toEqual({ level: 'info', event: 'port.migrated', count: 0 });
  });

  it('refuses to start on a configuration that does not load, NODE_DEBUG and a venue that is the channel included: no database, no Bot API call, a class-only line', async () => {
    for (const variables of [
      { BOT_TOKEN: undefined },
      { DEBUG: '' },
      { NODE_DEBUG: 'fetch' },
      { NODE_DEBUG_NATIVE: '' },
      { ADMIN_IDS: '@someadmin' },
      { ADMIN_CHAT_ID: TEST_VARIABLES.BROADCAST_CHAT_ID },
    ]) {
      const setup = rig(at(15, 12, 0, 30), variables);
      const openDatabase = vi.fn(setup.options.openDatabase);
      expect(await startPort({ ...setup.options, openDatabase })).toBeNull();
      expect(openDatabase).not.toHaveBeenCalled();
      expect(setup.telegram.calls).toEqual([]);
      expect(setup.log.records()).toEqual([{ level: 'error', event: 'config.invalid', errorClass: 'AppError', errorCode: 'CONFIG_INVALID' }]);
    }
  });

  it('refuses to start when the database does not open: no Bot API call', async () => {
    const setup = rig(at(15, 12, 0, 30), {}, {
      openDatabase: () => {
        throw new AppError('STORAGE_FAILURE', 'node:sqlite open failed');
      },
    });
    expect(await startPort(setup.options)).toBeNull();
    expect(setup.telegram.calls).toEqual([]);
    expect(setup.log.records()).toEqual([{ level: 'error', event: 'port.database_failed', errorClass: 'AppError', errorCode: 'STORAGE_FAILURE' }]);
  });

  it('refuses to start when secure_delete cannot be set: no Bot API call, the database closed', async () => {
    const real = openNodeSqlite(':memory:');
    let closed = false;
    const failing: NodeSqlite = {
      db: real.db,
      connection: {
        exec: () => {
          throw new Error('disk I/O error');
        },
      } as unknown as NodeSqlite['connection'],
      close: () => {
        closed = true;
        real.close();
      },
    };
    const setup = rig(at(15, 12, 0, 30), {}, { openDatabase: () => failing });
    expect(await startPort(setup.options)).toBeNull();
    expect(setup.telegram.calls).toEqual([]);
    expect(setup.log.records()).toEqual([{ level: 'error', event: 'port.database_failed', errorClass: 'AppError', errorCode: 'STORAGE_FAILURE' }]);
    expect(closed).toBe(true);
  });

  it('refuses to run on a failed migration: the earlier ones kept, nothing polled or sent, the database closed', async () => {
    const dir = scratchDir();
    for (const name of readdirSync(MIGRATIONS_DIR)) copyFileSync(join(MIGRATIONS_DIR, name), join(dir, name));
    writeFileSync(join(dir, '0099_broken.sql'), 'CREATE TABLE broken (;');
    const setup = rig(at(15, 12, 0, 30), {}, { migrationsDir: dir });
    expect(await startPort(setup.options)).toBeNull();
    expect(setup.telegram.calls).toEqual([]);
    expect(setup.log.records()).toEqual([{ level: 'error', event: 'port.migration_failed', errorClass: 'AppError', errorCode: 'STORAGE_FAILURE' }]);
    expect(setup.database().connection.isOpen).toBe(false);
  });

  it('refuses to start when deleteWebhook fails: no getUpdates, the database closed', async () => {
    const setup = rig(at(15, 12, 0, 30));
    setup.telegram.fail({ method: 'deleteWebhook' }, FAILURES.unauthorized);
    expect(await startPort(setup.options)).toBeNull();
    expect(setup.telegram.calls.map((call) => call.method)).toEqual(['deleteWebhook']);
    expect(setup.log.records()).toEqual([
      { level: 'info', event: 'port.migrated', count: 2 },
      { level: 'error', event: 'port.webhook_not_deleted', errorClass: 'GrammyError', telegramErrorCode: 401, apiMethod: 'deleteWebhook' },
    ]);
    expect(setup.database().connection.isOpen).toBe(false);
  });

  it("posts a due report once, from the minute loop's run at the next minute's start, to the channel and nowhere else", async () => {
    const setup = rig(at(15, 12, 0, 30));
    const port = await started(setup);
    const reportId = await plantDuePost(setup);
    expect(setup.timers.pending()).toEqual([at(15, 12, 1)]);
    setup.timers.fireNext();
    await vi.waitFor(async () =>
      expect(await setup.database().db.first(sql`SELECT status FROM reports WHERE id = ?`, [reportId])).toEqual({ status: 'posted' }),
    );
    setup.timers.fireNext();
    await port.stop();
    expect(channelSends(setup.telegram).map((call) => call.payload.text)).toEqual(['<b>The post</b>']);
    expect(channelSends(setup.telegram)[0]?.payload).toMatchObject({ link_preview_options: { is_disabled: true }, parse_mode: 'HTML' });
  });

  it("bounds the run's Bot API client at SEND_TIMEOUT_SECONDS, as the Worker does: a send that hangs ends as ambiguous then, never later", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const setup = rig(at(15, 12, 0, 30));
      const port = await started(setup);
      const reportId = await plantDuePost(setup);
      setup.telegram.fail({ method: 'sendMessage', chatId: IDS.broadcastChannel }, FAILURES.hang);
      setup.timers.fireNext();
      for (let i = 0; i < 50 && setup.telegram.hanging() === 0; i += 1) await drain(1);
      expect(setup.telegram.hanging()).toBe(1);
      await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_SECONDS * 1000 - 1);
      expect(setup.telegram.hanging()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(setup.telegram.hanging()).toBe(0);
      const row = () => setup.database().db.first(sql`SELECT status, post_message_id, needs_attention FROM reports WHERE id = ?`, [reportId]);
      for (let i = 0; i < 50 && (await row())?.needs_attention !== 1; i += 1) await drain(1);
      expect(await row()).toEqual({ status: 'posting', post_message_id: null, needs_attention: 1 });
      await port.stop();
      expect(channelSends(setup.telegram)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('the scheduled passes, by the minute tick() is handed', () => {
    /** A draft a day and more old, which the retention job deletes. */
    const plantStaleDraft = async (setup: Rig): Promise<void> => {
      const old = setup.clock.now() - 2 * 86_400_000;
      await setup.database().db.run(
        sql`INSERT INTO drafts (draft_key, step, locale, created_at, updated_at) VALUES (?, 'url', 'en', ?, ?)`,
        ['b'.repeat(64), old, old],
      );
    };
    /** A report still posting without a message id long past its window, which reconciliation flags and alerts. */
    const plantStuckPost = async (setup: Rig): Promise<string> =>
      insertReport(setup.database().db, { status: 'posting', comment: null, affected_person: null, posting_started_at: setup.clock.now() - 600_000 });

    /** Starts the port at `start`, plants, fires the loop's first minute and stops, which waits for that run. */
    const oneMinute = async (start: number, plant: (setup: Rig) => Promise<unknown>) => {
      const setup = rig(start);
      const port = await started(setup);
      await plant(setup);
      setup.timers.fireNext();
      await port.stop();
      return setup;
    };

    const keyholderTexts = (telegram: FakeBotApi) =>
      telegram.callsOf('sendMessage').filter((call) => call.chatId === IDS.keyholder).map((call) => String(call.payload.text));

    it('reconciliation and retention at 00:15 UTC, each once; neither at 00:14', async () => {
      let stuck = '';
      const before = await oneMinute(at(15, 0, 13, 30), async (setup) => {
        await plantStaleDraft(setup);
        stuck = await plantStuckPost(setup);
      });
      expect(events(before.log)).not.toContain('retention.done');
      expect(events(before.log)).not.toContain('reconcile.alerted');
      expect(keyholderTexts(before.telegram)).toEqual([]);

      const due = await oneMinute(at(15, 0, 14, 30), async (setup) => {
        await plantStaleDraft(setup);
        stuck = await plantStuckPost(setup);
      });
      expect(due.log.records().filter((record) => record.event === 'retention.done')).toEqual([
        expect.objectContaining({ level: 'info', event: 'retention.done', drafts: 1 }),
      ]);
      expect(due.log.records().filter((record) => record.event === 'reconcile.alerted')).toEqual([
        expect.objectContaining({ level: 'info', event: 'reconcile.alerted', count: 1 }),
      ]);
      expect(keyholderTexts(due.telegram)).toHaveLength(1);
      expect(keyholderTexts(due.telegram)[0]).toContain(stuck);
    });

    it('the monthly snapshot on the first day at 06:00 UTC, once, to the keyholders; not at 05:59, nor on the second day', async () => {
      const quiet = (): Promise<void> => Promise.resolve();
      for (const start of [at(1, 5, 58, 30), at(2, 5, 59, 30)]) {
        const setup = await oneMinute(start, quiet);
        expect(events(setup.log)).not.toContain('snapshot.sent');
        expect(keyholderTexts(setup.telegram)).toEqual([]);
      }
      const due = await oneMinute(at(1, 5, 59, 30), quiet);
      expect(due.log.records().filter((record) => record.event === 'snapshot.sent')).toEqual([
        expect.objectContaining({ level: 'info', event: 'snapshot.sent', count: 0 }),
      ]);
      expect(keyholderTexts(due.telegram)).toHaveLength(1);
      expect(due.telegram.callsOf('sendMessage').filter((call) => call.chatId === IDS.secondKeyholder)).toHaveLength(1);
    });
  });

  it('logs a database that fails to close by class, and stops all the same', async () => {
    let real: NodeSqlite | undefined;
    const setup = rig(at(15, 12, 0, 30), {}, {
      openDatabase: () => {
        const opened = openNodeSqlite(':memory:');
        real = opened;
        return {
          ...opened,
          close: () => {
            opened.close();
            throw new AppError('STORAGE_FAILURE', 'node:sqlite close failed');
          },
        };
      },
    });
    const port = await started(setup);
    await port.stop();
    expect(real?.connection.isOpen).toBe(false);
    expect(setup.log.records().slice(-2)).toEqual([
      { level: 'error', event: 'port.database_failed', errorClass: 'AppError', errorCode: 'STORAGE_FAILURE' },
      { level: 'info', event: 'port.stopped' },
    ]);
  });

  it('stop() ends polling and closes the database once, however often it is called', async () => {
    const setup = rig(at(15, 12, 0, 30));
    const port = await started(setup);
    await vi.waitFor(() => expect(setup.telegram.waitingForUpdates()).toBe(1));
    await Promise.all([port.stop(), port.stop()]);
    await port.stop();
    expect(setup.database().connection.isOpen).toBe(false);
    expect(setup.timers.pending()).toEqual([]);
    expect(events(setup.log).filter((event) => event === 'port.stopped')).toHaveLength(1);
  });
});

describe('openDatabaseFile', () => {
  it('creates the missing directory owner-only and makes the file owner-only', () => {
    const dir = scratchDir();
    const path = join(dir, 'data', 'div-report.sqlite');
    const database = openDatabaseFile(path);
    database.close();
    expect(statSync(join(dir, 'data')).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('opens an in-memory database with no file at all', () => {
    const database = openDatabaseFile(':memory:');
    expect(database.connection.isOpen).toBe(true);
    database.close();
  });

  it('closes the database and fails as a STORAGE_FAILURE, its cause the chmod failure, when the file cannot be made owner-only', () => {
    const chmodFailure = new Error('EPERM: operation not permitted');
    let opened: NodeSqlite | undefined;
    const fs = {
      ...NODE_FILE_SYSTEM,
      mkdirSync: () => undefined,
      chmodSync: () => {
        throw chmodFailure;
      },
      openNodeSqlite: () => (opened = openNodeSqlite(':memory:')),
    };
    let caught: unknown;
    try {
      openDatabaseFile('/no-such-directory/div-report.sqlite', fs);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect(caught).toMatchObject({ code: 'STORAGE_FAILURE', message: 'the database file could not be made owner-only' });
    expect((caught as AppError).cause).toBe(chmodFailure);
    expect(opened?.connection.isOpen).toBe(false);
  });

  it('names both failures, an AggregateError as its cause, when the close fails too', () => {
    const chmodFailure = new Error('EPERM: operation not permitted');
    const closeFailure = new AppError('STORAGE_FAILURE', 'node:sqlite close failed');
    const fs = {
      ...NODE_FILE_SYSTEM,
      mkdirSync: () => undefined,
      chmodSync: () => {
        throw chmodFailure;
      },
      openNodeSqlite: (): NodeSqlite => {
        const real = openNodeSqlite(':memory:');
        return {
          ...real,
          close: () => {
            real.close();
            throw closeFailure;
          },
        };
      },
    };
    let caught: unknown;
    try {
      openDatabaseFile('/no-such-directory/div-report.sqlite', fs);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'STORAGE_FAILURE', message: 'the database file could not be made owner-only, nor closed' });
    const cause = (caught as AppError).cause;
    expect(cause).toBeInstanceOf(AggregateError);
    expect((cause as AggregateError).errors).toEqual([chmodFailure, closeFailure]);
  });

  it('fails as a STORAGE_FAILURE when the directory cannot be made', () => {
    const dir = scratchDir();
    writeFileSync(join(dir, 'a-file'), '');
    expect(() => openDatabaseFile(join(dir, 'a-file', 'div-report.sqlite'))).toThrow(expect.objectContaining({ code: 'STORAGE_FAILURE' }));
  });
});

/** A process for runPort(): its signal listeners, and the exit codes asked for. */
const fakeProcess = () => {
  const listeners = new Map<string, () => void>();
  const exits: number[] = [];
  return {
    process: {
      once: (signal: 'SIGTERM' | 'SIGINT', listener: () => void) => {
        listeners.set(signal, listener);
      },
      exit: (code: number) => {
        exits.push(code);
      },
    },
    signal: (name: 'SIGTERM' | 'SIGINT') => {
      const listener = listeners.get(name);
      listeners.delete(name);
      listener?.();
    },
    exits,
  };
};

describe('runPort', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)('%s stops polling and closes the database, then exits 0', async (signal) => {
    const setup = rig(at(15, 12, 0, 30));
    const proc = fakeProcess();
    const run = runPort(() => startPort(setup.options), { process: proc.process, logger: setup.log.logger, timers: setup.timers });
    await vi.waitFor(() => expect(setup.telegram.waitingForUpdates()).toBe(1));
    proc.signal(signal);
    expect(await run).toBe(0);
    expect(proc.exits).toEqual([0]);
    expect(setup.telegram.waitingForUpdates()).toBe(0);
    expect(setup.database().connection.isOpen).toBe(false);
    const asked = setup.telegram.count('getUpdates');
    setup.telegram.queueUpdates(privateMessage(IDS.reporter, '/start'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(setup.telegram.count('getUpdates')).toBe(asked);
    expect(setup.telegram.callsOf('sendMessage')).toEqual([]);
    expect(events(setup.log)).toEqual(['port.migrated', 'port.started', 'port.stopping', 'port.stopped']);
  });

  it.each([
    ['another poller on the token (a 409)', FAILURES.conflict],
    ['a refused token (a 401)', FAILURES.unauthorized],
  ])('stops the port when polling fails by itself, %s, and exits 1, alerting nobody', async (_label, outcome) => {
    const setup = rig(at(15, 12, 0, 30));
    setup.telegram.fail({ method: 'getUpdates' }, outcome, 1);
    const proc = fakeProcess();
    expect(await runPort(() => startPort(setup.options), { process: proc.process, logger: setup.log.logger, timers: setup.timers })).toBe(1);
    expect(proc.exits).toEqual([1]);
    expect(setup.database().connection.isOpen).toBe(false);
    expect(setup.telegram.callsOf('sendMessage')).toEqual([]);
    expect(events(setup.log)).toEqual(['port.migrated', 'port.started', 'polling.failed', 'polling.stopped', 'port.stopping', 'port.stopped']);
  });

  it('yields to a webhook set meanwhile (its 409): the keyholders alerted, the port stopped, exit 0, so on-failure leaves it stopped', async () => {
    const setup = rig(at(15, 12, 0, 30));
    setup.telegram.fail({ method: 'getUpdates' }, FAILURES.webhookActive, 1);
    const proc = fakeProcess();
    expect(await runPort(() => startPort(setup.options), { process: proc.process, logger: setup.log.logger, timers: setup.timers })).toBe(0);
    expect(proc.exits).toEqual([0]);
    expect(setup.database().connection.isOpen).toBe(false);
    const alert = `${t('fa', 'alert.port_yielded')}\n\n${t('en', 'alert.port_yielded')}`;
    expect(setup.telegram.callsOf('sendMessage').map((call) => [call.chatId, call.payload.text])).toEqual([
      [IDS.keyholder, alert],
      [IDS.secondKeyholder, alert],
    ]);
    expect(setup.telegram.calls.map((call) => call.method).filter((method) => method === 'deleteWebhook')).toHaveLength(1);
    expect(events(setup.log)).toEqual([
      'port.migrated',
      'port.started',
      'polling.failed',
      'polling.webhook_set',
      'polling.webhook_alerted',
      'port.stopping',
      'port.stopped',
    ]);
  });

  it('exits 1 at once when the start is refused', async () => {
    const proc = fakeProcess();
    const log = recordingLogger();
    expect(await runPort(() => Promise.resolve(null), { process: proc.process, logger: log.logger, timers: manualTimers(fakeClock(0)) })).toBe(1);
    expect(proc.exits).toEqual([1]);
    expect(log.lines).toEqual([]);
  });

  it('stops right after the start when a signal came during it', async () => {
    const setup = rig(at(15, 12, 0, 30));
    const proc = fakeProcess();
    const start = async () => {
      proc.signal('SIGTERM');
      return startPort(setup.options);
    };
    expect(await runPort(start, { process: proc.process, logger: setup.log.logger, timers: setup.timers })).toBe(0);
    expect(proc.exits).toEqual([0]);
    expect(setup.database().connection.isOpen).toBe(false);
  });

  it('ends the process, exit 1, when the stop outlasts STOP_DEADLINE_MS', async () => {
    const proc = fakeProcess();
    const log = recordingLogger();
    const clock = fakeClock(0);
    const timers = manualTimers(clock);
    const stuck: RunningPort = { ended: new Promise<PortEnd>(() => undefined), stop: () => new Promise<void>(() => undefined) };
    void runPort(() => Promise.resolve(stuck), { process: proc.process, logger: log.logger, timers });
    await vi.waitFor(() => expect(proc.exits).toEqual([]));
    proc.signal('SIGTERM');
    await vi.waitFor(() => expect(timers.pending()).toEqual([STOP_DEADLINE_MS]));
    timers.fireNext();
    expect(proc.exits).toEqual([1]);
    expect(events(log)).toEqual(['port.stopping', 'port.stop_timeout']);
  });
});

describe('onCrash', () => {
  it('logs an uncaught error by class, never its payload, and exits 1', () => {
    const log = recordingLogger();
    const exits: number[] = [];
    onCrash(log.logger, (code) => exits.push(code))(
      new GrammyError("Call to 'sendMessage' failed!", { ok: false, error_code: 400, description: 'Bad Request: chat not found' }, 'sendMessage', {
        chat_id: IDS.reporter,
        text: `Report ${REPORTED_URL}`,
      }),
    );
    expect(exits).toEqual([1]);
    expect(log.records()).toEqual([{ level: 'error', event: 'port.crashed', errorClass: 'GrammyError', telegramErrorCode: 400, apiMethod: 'sendMessage' }]);
    expect(log.text()).not.toContain('instagram');
    expect(log.text()).not.toContain(String(IDS.reporter));
  });
});

describe('the entry', () => {
  it('is this module when the process runs this file, and not otherwise', () => {
    const url = pathToFileURL(ENTRY).href;
    expect(isEntry(ENTRY, url)).toBe(true);
    expect(isEntry(process.argv[1], url)).toBe(false);
    expect(isEntry(undefined, url)).toBe(false);
    expect(isEntry(join(scratchDir(), 'no-such-file.ts'), url)).toBe(false);
  });

  it('runs as the Dockerfile runs it and, without a token, fails fast: exit code 1, one class-only line, no value echoed, no file made', () => {
    const cwd = scratchDir();
    const result = spawnSync(process.execPath, ['--import', HOOKS, ENTRY], {
      cwd,
      encoding: 'utf8',
      timeout: 60_000,
      env: { PATH: process.env.PATH ?? '', REPORTER_REF_KEY: 'unit-test-reporter-ref-key', ADMIN_IDS: '424240011' },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    const lines = result.stderr.split('\n').filter((line) => line !== '');
    expect(lines.filter((line) => line.startsWith('{'))).toEqual(['{"level":"error","event":"config.invalid","errorClass":"AppError","errorCode":"CONFIG_INVALID"}']);
    // Anything else is Node's own notice that node:sqlite is experimental (Node 22).
    for (const line of lines.filter((entry) => !entry.startsWith('{'))) expect(line).toMatch(/ExperimentalWarning: SQLite|--trace-warnings/);
    expect(result.stderr).not.toContain('unit-test-reporter-ref-key');
    expect(result.stderr).not.toContain('424240011');
    expect(readdirSync(cwd)).toEqual([]);
  });
});

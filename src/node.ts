// @critical-path
// The Node port's entry (doc/architecture/adr-0001-runtime-and-hosting.md,
// the fallback; doc/guides/fallback-drill.md): the Worker's bot and the
// Worker's run (src/worker.ts) on a plain Node 22 process, with long polling
// in place of the webhook, a minute loop in place of the cron and
// node:sqlite in place of D1. It runs from its TypeScript source through
// Node's type stripping, with the module hook that resolves the sources'
// extensionless imports:
//   node --import ./src/node-hooks.ts src/node.ts
// (doc/guides/developer-setup.md says why). startPort(), in this order, a
// failing step refusing the start (logged by class, exit code 1):
// 1. the configuration, configFor(process.env), before anything else, as
//    on the Worker; one that does not load (a DEBUG, NODE_DEBUG or
//    NODE_DEBUG_NATIVE variable included: each would print debug lines past
//    the redacting logger) starts nothing, before any request;
// 2. the database: the SQLite file at SQLITE_PATH (default
//    ./data/div-report.sqlite, src/config/schema.ts), its directory created
//    owner-only when missing, the file made owner-only, and secure_delete
//    on, so a deleted row's content is overwritten in the file instead of
//    lingering in its free pages (critical invariant 8: the database file
//    itself keeps no deleted report; the rollback journal's blocks left on
//    the disk are the drill runbook's matter, doc/guides/fallback-drill.md,
//    section 7);
// 3. the migrations: migrate() applies migrations/*.sql, the very files
//    wrangler applies to D1, each once, each in its own transaction
//    (src/db/migrate.ts), so the file holds the same schema; a migration
//    that fails refuses the start, nothing else having happened;
// 4. deleteWebhook, without dropping the pending updates: the two
//    transports are exclusive (Telegram refuses getUpdates while a webhook
//    is set), and the updates Telegram kept while the Worker was down are
//    authentic ones, handled like any other;
// 5. long polling (src/telegram/polling.ts), the port's authentic source of
//    updates (critical invariant 2), into createBot(deps,
//    defaultFeatures(deps)): the Worker's very composition, every gate
//    included; this file registers no handler of its own;
// 6. the minute loop (src/broadcast/minute-loop.ts) calling tick() at each
//    minute's start, with that start as `now`, over a Bot API client bounded
//    at SEND_TIMEOUT_SECONDS exactly as the Worker's scheduled handler
//    bounds it: /repost's two-minute window rests on that bound
//    (src/broadcast/post.ts), and so does "never two runs at once" with the
//    loop's own skip. tick() dispatches reconciliation, retention and the
//    snapshot by the minute itself: nothing else is scheduled here.
// stop() stops polling (the updates being handled awaited) and the loop
// (the running tick awaited), then closes the database.
//
// Lockdown reads the same `meta` row as on the Worker. The LOCKDOWN
// variable is read with the configuration, once, at start: setting or
// clearing it takes a restart here, where on Workers a secret change is a
// new deployment of its own.
// Per-process memories: the keyholder notices (isolateNotices,
// src/review/notify.ts), the storage alert's day (isolateStorageAlerts,
// src/broadcast/tick.ts) and the membership cache are per isolate on
// Workers and per process here; nothing changes but their scope, which on
// one process covers every notice it sent. There is no probe and no HTTP
// server.
//
// main(), when this file is the process's entry: the umask set to 077, so
// the database file and its journal are created owner-only; an uncaught
// exception or an unhandled rejection logged by class (`port.crashed`) and
// the process ended, exit code 1, instead of Node's own report, which
// would print the error's fields (a GrammyError's payload holds the
// outgoing text and a chat id); then runPort(): SIGTERM or SIGINT stops
// the port, exit code 0, and a second signal of the same kind ends the
// process at once (the listeners are `once`); polling ended by a webhook set
// meanwhile stops it with exit code 0, the keyholders alerted: the port
// yields, and docker-compose.yml's `restart: on-failure` leaves it stopped,
// so its start, which deletes the webhook, never takes the bot back from
// the Worker in a loop; polling that ends by itself otherwise (a revoked
// token, another poller on the token, retries exhausted) stops it with exit
// code 1; a stop that outlasts STOP_DEADLINE_MS is logged and ends the
// process, exit code 1. Every line
// goes through the redacting logger (src/privacy/logger.ts). The process
// listeners are added with `once` and `addListener`: the lockdown spec's
// source scan reads `.on('` anywhere in src/ as a handler registration of
// the bot (test/invariants/lockdown.test.ts).
// The Bot API's transport is Node's own fetch, handed to grammY's clients
// only, which call api.telegram.org: a reported URL is never fetched.
import { chmodSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startMinuteLoop, systemTimers, type Timers } from './broadcast/minute-loop';
import { SEND_TIMEOUT_SECONDS } from './broadcast/post';
import { tick, type TickDeps } from './broadcast/tick';
import { systemClock, type Clock } from './clock';
import { configFor } from './config/memo';
import type { Config } from './config/schema';
import { migrate } from './db/migrate';
import { openNodeSqlite, type NodeSqlite } from './db/node-sqlite';
import { sql } from './db/sql';
import { AppError } from './errors/app-error';
import { consoleLogger, type Logger } from './privacy/logger';
import { isolateNotices } from './review/notify';
import { createBotApi } from './telegram/api';
import { createBot, defaultFeatures, type BotDeps } from './telegram/bot';
import { POLL_TIMEOUT_SECONDS, startPolling } from './telegram/polling';

/** The migrations wrangler applies to D1: migrations/ at the repository root. `.href`: both type packages declare URL. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url).href);

/** How long a stop may take before the process ends anyway: inside docker-compose.yml's stop_grace_period. */
export const STOP_DEADLINE_MS = 50_000;

/** The path that keeps the database in memory, with no file. */
const IN_MEMORY = ':memory:';

const SECURE_DELETE = sql`PRAGMA secure_delete = ON`;

/** What openDatabaseFile() uses of node:fs and of the node:sqlite adapter: the real ones unless a test gives its own. */
export interface DatabaseFileSystem {
  readonly mkdirSync: (path: string, options: { readonly recursive: true; readonly mode: number }) => unknown;
  readonly chmodSync: (path: string, mode: number) => void;
  readonly openNodeSqlite: (path: string) => NodeSqlite;
}

/** node:fs and the node:sqlite adapter. */
export const NODE_FILE_SYSTEM: DatabaseFileSystem = { mkdirSync, chmodSync, openNodeSqlite };

/**
 * Opens the port's SQLite file at `path`: its directory created
 * owner-only when missing, the file made owner-only once open. Throws an
 * AppError STORAGE_FAILURE, the database closed again; when the close
 * fails too, its cause is an AggregateError of both failures.
 */
export function openDatabaseFile(path: string, fs: DatabaseFileSystem = NODE_FILE_SYSTEM): NodeSqlite {
  if (path !== IN_MEMORY) {
    try {
      fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    } catch (cause) {
      throw new AppError('STORAGE_FAILURE', 'the database directory could not be created', { cause });
    }
  }
  const database = fs.openNodeSqlite(path);
  if (path === IN_MEMORY) return database;
  try {
    fs.chmodSync(path, 0o600);
  } catch (cause) {
    try {
      database.close();
    } catch (closeFailure) {
      throw new AppError('STORAGE_FAILURE', 'the database file could not be made owner-only, nor closed', {
        cause: new AggregateError([cause, closeFailure], 'the close failed too'),
      });
    }
    throw new AppError('STORAGE_FAILURE', 'the database file could not be made owner-only', { cause });
  }
  return database;
}

/** Turns secure_delete on for the connection (see the header). Throws an AppError STORAGE_FAILURE. */
function secureDelete(database: NodeSqlite): void {
  try {
    database.connection.exec(SECURE_DELETE);
  } catch (cause) {
    throw new AppError('STORAGE_FAILURE', 'secure_delete could not be set', { cause });
  }
}

/** Closes `database`; a failure is logged by class and ends nothing. */
function closeDatabase(database: NodeSqlite, logger: Logger): void {
  try {
    database.close();
  } catch (error) {
    logger.logError('port.database_failed', error);
  }
}

export interface PortOptions {
  /** The deployment's variables: process.env. */
  readonly env: object;
  /** The Bot API's transport: Node's fetch, or the fake Bot API's in tests. */
  readonly fetch: typeof fetch;
  readonly logger: Logger;
  readonly clock: Clock;
  /** The minute loop's timers: the runtime's, or manual ones in tests. */
  readonly timers: Timers;
  /** Where the migrations are: MIGRATIONS_DIR. */
  readonly migrationsDir: string;
  /** Opens the database at SQLITE_PATH: openDatabaseFile unless given (tests keep theirs in memory). */
  readonly openDatabase?: (path: string) => NodeSqlite;
}

/** How a started port's polling ended by itself: it yielded to a webhook set meanwhile, or it failed. */
export type PortEnd = 'yielded' | 'failed';

/** A started port. */
export interface RunningPort {
  /**
   * Resolves when polling ended by itself, and the port must stop:
   * 'yielded' for a webhook set meanwhile (the keyholders alerted), 'failed'
   * for a 401, another poller's 409 or retries exhausted.
   */
  readonly ended: Promise<PortEnd>;
  /** Stops polling and the loop, waiting for what they run, then closes the database; once, however often called. */
  stop(): Promise<void>;
}

/** Starts the port (see the header, steps 1 to 6); null when a step refused the start, which it logged. */
export async function startPort(options: PortOptions): Promise<RunningPort | null> {
  const { logger, clock } = options;

  let config: Config;
  try {
    config = configFor(options.env);
  } catch (error) {
    logger.logError('config.invalid', error);
    return null;
  }

  let database: NodeSqlite;
  try {
    database = (options.openDatabase ?? openDatabaseFile)(config.sqlitePath);
  } catch (error) {
    logger.logError('port.database_failed', error);
    return null;
  }
  try {
    secureDelete(database);
  } catch (error) {
    logger.logError('port.database_failed', error);
    closeDatabase(database, logger);
    return null;
  }

  try {
    const applied = migrate(database.connection, options.migrationsDir, clock);
    logger.log('port.migrated', { count: applied.length });
  } catch (error) {
    logger.logError('port.migration_failed', error);
    closeDatabase(database, logger);
    return null;
  }

  const deps: BotDeps = { config, db: database.db, clock, logger, fetch: options.fetch };
  const bot = createBot(deps, defaultFeatures(deps));
  try {
    await bot.api.deleteWebhook();
  } catch (error) {
    logger.logError('port.webhook_not_deleted', error);
    closeDatabase(database, logger);
    return null;
  }

  const polling = startPolling({
    api: createBotApi(config, options.fetch, { timeoutSeconds: POLL_TIMEOUT_SECONDS }),
    bot,
    logger,
    alerts: { api: bot.api, config },
  });
  const tickDeps: TickDeps = {
    api: createBotApi(config, options.fetch, { timeoutSeconds: SEND_TIMEOUT_SECONDS }),
    config,
    db: database.db,
    clock,
    logger,
    notices: isolateNotices,
  };
  const loop = startMinuteLoop({ clock, timers: options.timers, logger, run: (minute) => tick(tickDeps, minute) });
  logger.log('port.started');

  const ended = new Promise<PortEnd>((resolve) => {
    void polling.ended.then((end) => {
      if (end === 'webhook') resolve('yielded');
      if (end === 'failed') resolve('failed');
    });
  });
  let stopping: Promise<void> | undefined;
  return {
    ended,
    stop: () => {
      stopping ??= (async () => {
        await Promise.all([polling.stop(), loop.stop()]);
        closeDatabase(database, logger);
        logger.log('port.stopped');
      })();
      return stopping;
    },
  };
}

/** What runPort() needs of the process: the stop signals and the exit. */
export interface PortProcess {
  once(signal: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
  exit(code: number): void;
}

export interface RunDeps {
  readonly process: PortProcess;
  readonly logger: Logger;
  readonly timers: Timers;
}

/**
 * Starts the port with `start` and runs it until SIGTERM or SIGINT (exit
 * code 0) or polling's own end (exit code 0 when the port yielded to a
 * webhook, 1 when polling failed), then stops it and exits; a refused start
 * exits 1 at once; a stop past STOP_DEADLINE_MS is logged and exits 1 (see
 * the header). Resolves with the exit code.
 */
export async function runPort(start: () => Promise<RunningPort | null>, deps: RunDeps): Promise<number> {
  const signalled = new Promise<void>((resolve) => {
    deps.process.once('SIGTERM', () => resolve());
    deps.process.once('SIGINT', () => resolve());
  });
  const port = await start();
  if (port === null) {
    deps.process.exit(1);
    return 1;
  }
  const code = await Promise.race([signalled.then(() => 0), port.ended.then((end) => (end === 'yielded' ? 0 : 1))]);
  deps.logger.log('port.stopping');
  let late = false;
  const deadline = deps.timers.setTimeout(() => {
    late = true;
    deps.logger.log('port.stop_timeout');
    deps.process.exit(1);
  }, STOP_DEADLINE_MS);
  await port.stop();
  deps.timers.clearTimeout(deadline);
  if (late) return 1;
  deps.process.exit(code);
  return code;
}

/** Whether `entry`, the process's argv[1], is the module at `moduleUrl`: whether this file was run, not imported. */
export function isEntry(entry: string | undefined, moduleUrl: string): boolean {
  if (entry === undefined) return false;
  let path: string;
  try {
    path = realpathSync(entry);
  } catch {
    // An entry that is no file (node -e, the REPL) is not this module.
    return false;
  }
  return pathToFileURL(path).href === moduleUrl;
}

/**
 * The listener for an uncaught exception or an unhandled rejection: the
 * error logged by class (`port.crashed`), never printed whole, and the
 * process ended with exit code 1 (see the header).
 */
export const onCrash =
  (logger: Logger, exit: (code: number) => void) =>
  (error: unknown): void => {
    logger.logError('port.crashed', error);
    exit(1);
  };

/** The process (see the header). */
async function main(): Promise<void> {
  process.umask(0o077);
  const crash = onCrash(consoleLogger, (code) => process.exit(code));
  process.addListener('uncaughtException', crash);
  process.addListener('unhandledRejection', crash);
  await runPort(
    () =>
      startPort({
        env: process.env,
        fetch,
        logger: consoleLogger,
        clock: systemClock,
        timers: systemTimers,
        migrationsDir: MIGRATIONS_DIR,
      }),
    { process, logger: consoleLogger, timers: systemTimers },
  );
}

if (isEntry(process.argv[1], import.meta.url)) void main();

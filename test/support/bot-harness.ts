// The bot under test, wired as the Worker wires it (src/telegram/bot.ts),
// over the fakes: the fake Bot API (test/fakes/bot-api.ts) behind grammY's
// real client and the one transformer, a migrated node:sqlite database, a
// fake clock and the real redacting logger over a recorder. send() hands an
// update to bot.handleUpdate as the webhook does.
import type { DatabaseSync } from 'node:sqlite';
import type { Bot, Context, Middleware } from 'grammy';
import type { Update } from 'grammy/types';
import type { Config } from '../../src/config/schema';
import type { SqlDb } from '../../src/db/sql';
import { botInfoFor, createBot } from '../../src/telegram/bot';
import { fakeBotApi, type FakeBotApi } from '../fakes/bot-api';
import { fakeClock, type FakeClock } from '../fakes/clock';
import { recordingLogger, type RecordingLogger } from '../fakes/logger';
import { IDS, testConfig } from './config';
import { migratedDatabase } from './database';

/** The harness's start time: 2027-01-15 12:00 UTC. */
export const NOW = Date.UTC(2027, 0, 15, 12, 0, 0);

export interface BotHarness {
  readonly config: Config;
  readonly telegram: FakeBotApi;
  readonly db: SqlDb;
  readonly connection: DatabaseSync;
  readonly clock: FakeClock;
  readonly log: RecordingLogger;
  readonly bot: Bot;
  /** Handles one update as the webhook does. */
  send(update: Update): Promise<void>;
  /** The texts of the messages sent to `chatId`, in order. */
  textsTo(chatId: number): string[];
}

export interface HarnessOptions {
  /** Configuration variables to override (LOCKDOWN: '1', say). */
  readonly variables?: Readonly<Record<string, string | undefined>>;
  /** Composers for createBot()'s slot of the later units' features, built with the harness's own deps. */
  readonly features?: (deps: { readonly config: Config; readonly db: SqlDb }) => readonly Middleware<Context>[];
}

export function botHarness(options: HarnessOptions = {}): BotHarness {
  const config = testConfig(options.variables);
  const clock = fakeClock(NOW);
  const telegram = fakeBotApi({ botInfo: botInfoFor(config), now: () => clock.now(), channelIds: [IDS.broadcastChannel] });
  const database = migratedDatabase(clock);
  const log = recordingLogger();
  const features = options.features?.({ config, db: database.db }) ?? [];
  const bot = createBot({ config, db: database.db, clock, logger: log.logger, fetch: telegram.fetch }, features);
  return {
    config,
    telegram,
    db: database.db,
    connection: database.connection,
    clock,
    log,
    bot,
    send: (update) => bot.handleUpdate(update),
    textsTo: (chatId) =>
      telegram
        .callsOf('sendMessage')
        .filter((call) => call.chatId === chatId)
        .map((call) => String(call.payload.text)),
  };
}

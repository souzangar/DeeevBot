// The bot under test, wired as the Worker wires it (src/telegram/bot.ts,
// with defaultFeatures(), the review, in the slot of the later units'
// features unless a test passes its own), over the fakes: the fake Bot API
// (test/fakes/bot-api.ts) behind grammY's real client and the one
// transformer, a migrated node:sqlite database, a fake clock (its sleep()
// moves time on at once) and the real redacting logger over a recorder,
// with a fresh membership cache and a fresh memory of keyholder notices
// per harness, so no getChatMember answer and no notice is shared between
// tests. send() hands an update to bot.handleUpdate as the webhook does.
import type { DatabaseSync } from 'node:sqlite';
import type { Bot, Context, Middleware } from 'grammy';
import type { Update } from 'grammy/types';
import { createMembershipCache } from '../../src/auth/membership';
import type { Clock } from '../../src/clock';
import type { Config } from '../../src/config/schema';
import type { SqlDb } from '../../src/db/sql';
import type { Logger } from '../../src/privacy/logger';
import { createNoticeMemory, type NoticeMemory } from '../../src/review/notify';
import { botInfoFor, createBot, defaultFeatures, type BotDeps } from '../../src/telegram/bot';
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
  /** The harness's memory of the keyholder notices it sent. */
  readonly notices: NoticeMemory;
  readonly bot: Bot;
  /** Handles one update as the webhook does. */
  send(update: Update): Promise<void>;
  /** The texts of the messages sent to `chatId`, in order. */
  textsTo(chatId: number): string[];
}

export interface HarnessOptions {
  /** Configuration variables to override (LOCKDOWN: '1', say). */
  readonly variables?: Readonly<Record<string, string | undefined>>;
  /**
   * Composers for createBot()'s slot of the later units' features, built
   * with the harness's own deps, in place of defaultFeatures().
   */
  readonly features?: (deps: {
    readonly config: Config;
    readonly db: SqlDb;
    readonly clock: Clock;
    readonly logger: Logger;
    readonly notices: NoticeMemory;
  }) => readonly Middleware<Context>[];
}

export function botHarness(options: HarnessOptions = {}): BotHarness {
  const config = testConfig(options.variables);
  const clock = fakeClock(NOW);
  const telegram = fakeBotApi({ botInfo: botInfoFor(config), now: () => clock.now(), channelIds: [IDS.broadcastChannel] });
  const database = migratedDatabase(clock);
  const log = recordingLogger();
  const notices = createNoticeMemory();
  const deps: BotDeps = {
    config,
    db: database.db,
    clock,
    logger: log.logger,
    fetch: telegram.fetch,
    membershipCache: createMembershipCache(),
    notices,
  };
  const features = options.features?.({ config, db: database.db, clock, logger: log.logger, notices }) ?? defaultFeatures(deps);
  const bot = createBot(deps, features);
  return {
    config,
    telegram,
    db: database.db,
    connection: database.connection,
    clock,
    log,
    notices,
    bot,
    send: (update) => bot.handleUpdate(update),
    textsTo: (chatId) =>
      telegram
        .callsOf('sendMessage')
        .filter((call) => call.chatId === chatId)
        .map((call) => String(call.payload.text)),
  };
}

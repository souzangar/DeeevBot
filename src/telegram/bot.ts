// @critical-path
// The bot (ADR 0002, ADR 0003, ADR 0005; the MVP plan, sections 2 and 8):
// grammY's Bot composed from one Composer per feature, in this order:
// 1. the error boundary: an AppError with a parameter-free userMessageKey
//    becomes that localised answer, anything else `error.unexpected`; the
//    failure is logged by class only, never with the update or a
//    GrammyError's payload; the answer goes where respond() allows
//    (src/telegram/respond.ts), so never into the channel;
// 2. the update filter: a button press or a message in a private chat or
//    in the admin review venue goes on; every other update (an edited
//    message, a channel post, a message in the membership group or any
//    other chat) is dropped unanswered, so a /start typed in a group is
//    ignored;
// 3. the keyholder commands, then /start and /language (private chats
//    only; src/telegram/commands.ts);
// 4. the "I reported it" presses (src/telegram/presses.ts);
// 5. the later units' composers (`features`: the admin commands and
//    buttons, behind the gates of src/telegram/guards.ts), in order;
// 6. the intake entry, lockdown-gated (src/telegram/intake-entry.ts), which
//    takes every private message nothing before it took;
// 7. every other button press, answered empty so its spinner stops.
//
// The bot's error handler (`bot.catch`), which grammY calls on the long
// polling path of the Node port for a failure that escapes the middleware,
// logs the class of the error inside grammY's BotError and nothing else:
// grammY's default handler would console.error it, a GrammyError's payload
// (the outgoing text, the chat id) included.
//
// The bot knows itself from the configuration (`botInfo`), so no update
// costs a getMe call, and its Api carries the one transformer
// (src/telegram/api.ts): every handler's ctx.api inherits it, since grammY
// copies bot.api's transformers onto each update's Api. No webhookCallback:
// the Worker's own boundary hands updates to handleUpdate
// (src/telegram/webhook.ts).
import { Bot, Composer, type Context, type Middleware, type MiddlewareFn } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type { Clock } from '../clock';
import type { Config } from '../config/schema';
import type { SqlDb } from '../db/sql';
import { isAppError } from '../errors/app-error';
import { isPlainKey, type PlainMessageKey } from '../i18n/index';
import type { Logger } from '../privacy/logger';
import { clientOptions, installTransformer } from './api';
import { keyholderCommands, publicCommands } from './commands';
import { intakeEntry } from './intake-entry';
import { presses } from './presses';
import { answerPress, answersIn, respondWith } from './respond';

export interface BotDeps {
  readonly config: Config;
  readonly db: SqlDb;
  readonly clock: Clock;
  readonly logger: Logger;
  /** The Bot API's transport: the runtime's fetch, or the fake Bot API's in tests. */
  readonly fetch: typeof fetch;
}

/** The bot's own identity, from BOT_ID and BOT_USERNAME: grammY never calls getMe. */
export const botInfoFor = (config: Pick<Config, 'botId' | 'botUsername'>): UserFromGetMe => ({
  id: config.botId,
  is_bot: true,
  first_name: '',
  username: config.botUsername,
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
});

/** The answer for a failure: its AppError's key when it takes no parameters, else the generic one. */
export const failureKey = (error: unknown): PlainMessageKey =>
  isAppError(error) && error.userMessageKey !== undefined && isPlainKey(error.userMessageKey)
    ? error.userMessageKey
    : 'error.unexpected';

/** The error boundary, the first middleware (see the header). It never rethrows. */
export const errorBoundary =
  (deps: Pick<BotDeps, 'config' | 'logger'>): MiddlewareFn<Context> =>
  async (ctx, next) => {
    try {
      await next();
    } catch (error) {
      deps.logger.logError('update.failed', error);
      try {
        await respondWith(ctx, deps.config, failureKey(error));
      } catch (answerError) {
        deps.logger.logError('reply.failed', answerError);
      }
    }
  };

/** The update filter (see the header). */
export const acceptedUpdates =
  (config: Pick<Config, 'adminChatId'>): MiddlewareFn<Context> =>
  (ctx, next) => {
    if (ctx.callbackQuery !== undefined) return next();
    const chat = ctx.message?.chat;
    if (chat !== undefined && answersIn(config, chat)) return next();
    return undefined;
  };

/** The last middleware: a press no handler took is answered empty. */
const unansweredButtons = (): Composer<Context> => {
  const composer = new Composer<Context>();
  composer.on('callback_query', async (ctx) => {
    await answerPress(ctx);
  });
  return composer;
};

/**
 * The bot of the header, over `deps.fetch`, with `features` in their slot;
 * its updates come from the webhook or long polling.
 */
export function createBot(deps: BotDeps, features: readonly Middleware<Context>[] = []): Bot {
  const bot = new Bot(deps.config.botToken, {
    botInfo: botInfoFor(deps.config),
    client: clientOptions(deps.fetch),
  });
  installTransformer(bot.api);
  bot.catch((err) => deps.logger.logError('update.failed', err.error));
  bot.use(errorBoundary(deps));
  bot.use(acceptedUpdates(deps.config));
  bot.use(keyholderCommands(deps));
  bot.use(publicCommands(deps));
  bot.use(presses(deps));
  for (const feature of features) bot.use(feature);
  bot.use(intakeEntry(deps));
  bot.use(unansweredButtons());
  return bot;
}

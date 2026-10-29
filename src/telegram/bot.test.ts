// Unit tests for the bot's composition (src/telegram/bot.ts): its identity
// from the configuration (no getMe), the one transformer on bot.api and on
// every update's api, the update filter (private chats, the venue and
// presses only), the error boundary (the localised answer, the class-only
// log line, never a message into the channel) and the empty answer for an
// unknown press; and the bound on its client, BOT_TIMEOUT_SECONDS, which
// bot.api and every update's api share.
import { Bot, BotError, Composer, GrammyError, HttpError, type Context } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { FAILURES, fakeBotApi } from '../../test/fakes/bot-api';
import { recordingLogger } from '../../test/fakes/logger';
import { botHarness } from '../../test/support/bot-harness';
import { IDS, testConfig } from '../../test/support/config';
import {
  buttonPress,
  channelPost,
  editedPrivateMessage,
  groupMessage,
  privateMessage,
} from '../../test/support/updates';
import type { SqlDb } from '../db/sql';
import { AppError } from '../errors/app-error';
import { t } from '../i18n/index';
import { BOT_TIMEOUT_SECONDS, clientOptions, htmlWithoutPreviews, installTransformer } from './api';
import { acceptedUpdates, botInfoFor, createBot, errorBoundary, failureKey } from './bot';

const config = testConfig();

describe('botInfoFor', () => {
  it("is the bot's identity from BOT_ID and BOT_USERNAME, with no inline mode and no Mini App", () => {
    expect(botInfoFor(config)).toEqual({
      id: IDS.bot,
      is_bot: true,
      first_name: '',
      username: 'div_report_test_bot',
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
  });
});

describe('createBot', () => {
  it('never calls getMe, and calls nothing but the Bot API', async () => {
    const harness = botHarness();
    await harness.send(privateMessage(IDS.reporter, '/start'));
    await harness.send(buttonPress(IDS.reporter, 'card:x', { chatId: IDS.adminChat, messageId: 1, chatType: 'supergroup' }));
    expect(harness.telegram.count('getMe')).toBe(0);
    expect(harness.telegram.foreignRequests).toEqual([]);
  });

  it('carries the one transformer on bot.api, and every handler inherits it', async () => {
    const harness = botHarness();
    expect(harness.bot.api.config.installedTransformers()).toEqual([htmlWithoutPreviews]);
    await harness.send(privateMessage(IDS.reporter, '/start'));
    expect(harness.telegram.callsOf('sendMessage')[0]?.payload).toMatchObject({
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  });

  it('answers an unknown press empty, so its spinner stops, and does nothing else', async () => {
    const harness = botHarness();
    await harness.send(buttonPress(IDS.admin, 'card:approve:abcdefghijklmnopqrst', { chatId: IDS.adminChat, messageId: 3, chatType: 'supergroup' }));
    expect(harness.telegram.calls).toEqual([
      { method: 'answerCallbackQuery', chatId: undefined, payload: { callback_query_id: expect.any(String) as string } },
    ]);
  });
});

describe("the later units' slot", () => {
  it('runs after the keyholder commands and the presses, and before the intake entry', async () => {
    const seen: string[] = [];
    const harness = botHarness({
      features: () => {
        const composer = new Composer<Context>();
        composer.command('probe', async (ctx) => {
          seen.push('probe');
          await ctx.reply('probed');
        });
        composer.on('message', async (_ctx, next) => {
          seen.push('message');
          await next();
        });
        return [composer];
      },
    });
    await harness.send(privateMessage(IDS.reporter, '/probe'));
    await harness.send(privateMessage(IDS.reporter, 'any text'));
    await harness.send(privateMessage(IDS.keyholder, '/lockdown'));
    expect(seen).toEqual(['probe', 'message']);
    // 'any text' went on to the intake entry, which took it as a link that is none.
    expect(harness.textsTo(IDS.reporter)).toEqual(['probed', `${t('en', 'intake.refused.not_a_link')}\n\n${t('en', 'intake.ask_url')}`]);
    expect(harness.textsTo(IDS.keyholder)).toEqual([t('en', 'lockdown.on')]);
  });
});

describe('the update filter', () => {
  it.each([
    ['an edited message', editedPrivateMessage(IDS.reporter, '/start')],
    ['a channel post', channelPost(IDS.broadcastChannel, '/start')],
    ['a message in the membership group', groupMessage(IDS.membershipChat, IDS.reporter, 'hello')],
    ['a command in the membership group', groupMessage(IDS.membershipChat, IDS.keyholder, '/lockdown')],
    ["a message in a stranger's group", groupMessage(IDS.strangerGroup, IDS.reporter, '/start@div_report_test_bot')],
    ['a message in the venue no handler takes', groupMessage(IDS.adminChat, IDS.admin, 'hello')],
    ['an update with nothing in it', { update_id: 999_001 }],
  ])('drops %s unanswered', async (_label, update) => {
    const harness = botHarness();
    await harness.send(update);
    expect(harness.telegram.calls).toEqual([]);
    expect(harness.log.lines).toEqual([]);
  });

  it('passes a press, a private message and a venue message on', async () => {
    const passed: string[] = [];
    const telegram = fakeBotApi();
    const bot = new Bot(config.botToken, { botInfo: botInfoFor(config), client: clientOptions(telegram.fetch) });
    bot.use(acceptedUpdates(config));
    bot.use((ctx: Context) => {
      passed.push(ctx.callbackQuery !== undefined ? 'press' : String(ctx.chat?.id));
    });
    await bot.handleUpdate(buttonPress(IDS.reporter, 'x', { chatId: IDS.broadcastChannel, messageId: 1 }));
    await bot.handleUpdate(privateMessage(IDS.reporter, 'x'));
    await bot.handleUpdate(groupMessage(IDS.adminChat, IDS.admin, 'x'));
    await bot.handleUpdate(groupMessage(IDS.membershipChat, IDS.admin, 'x'));
    expect(passed).toEqual(['press', String(IDS.reporter), String(IDS.adminChat)]);
  });
});

describe('the error boundary', () => {
  /** A bot whose handler throws `error`, behind the boundary. */
  const throwing = (error: unknown) => {
    const telegram = fakeBotApi({ channelIds: [IDS.broadcastChannel] });
    const log = recordingLogger();
    const bot = new Bot(config.botToken, { botInfo: botInfoFor(config), client: clientOptions(telegram.fetch) });
    installTransformer(bot.api);
    bot.use(errorBoundary({ config, logger: log.logger }));
    bot.use(() => {
      throw error;
    });
    return { telegram, log, bot };
  };

  it("answers an AppError with its key, in the sender's locale, and logs its class and code", async () => {
    const { telegram, log, bot } = throwing(new AppError('RATE_LIMITED', 'the daily limit'));
    await bot.handleUpdate(privateMessage(IDS.reporter, 'x', { languageCode: 'fa' }));
    expect(telegram.callsOf('sendMessage').map((call) => [call.chatId, call.payload.text])).toEqual([
      [IDS.reporter, t('fa', 'error.rate_limited')],
    ]);
    expect(log.records()).toEqual([
      { level: 'error', event: 'update.failed', errorClass: 'AppError', errorCode: 'RATE_LIMITED' },
    ]);
  });

  it('answers anything else with the generic text and logs the class only', async () => {
    const { telegram, log, bot } = throwing(new TypeError(`no such report https://www.instagram.com/x/ for ${IDS.reporter}`));
    await bot.handleUpdate(privateMessage(IDS.reporter, 'x'));
    expect(telegram.callsOf('sendMessage').map((call) => call.payload.text)).toEqual([t('en', 'error.unexpected')]);
    expect(log.records()).toEqual([{ level: 'error', event: 'update.failed', errorClass: 'TypeError' }]);
  });

  it('answers a failed press by its callback answer and never sends a message into the channel', async () => {
    const { telegram, bot } = throwing(new Error('boom'));
    await bot.handleUpdate(buttonPress(IDS.reporter, 'mark:abcdefghijklmnopqrst', { chatId: IDS.broadcastChannel, messageId: 5 }));
    expect(telegram.count('sendMessage')).toBe(0);
    expect(telegram.callsOf('answerCallbackQuery').map((call) => call.payload.text)).toEqual([t('en', 'error.unexpected')]);
  });

  it('says nothing in a chat the bot does not answer in, and still logs', async () => {
    const { telegram, log, bot } = throwing(new Error('boom'));
    await bot.handleUpdate(groupMessage(IDS.membershipChat, IDS.reporter, 'x'));
    expect(telegram.calls).toEqual([]);
    expect(log.records()).toEqual([{ level: 'error', event: 'update.failed', errorClass: 'Error' }]);
  });

  it('logs a failed answer by class too, and never rethrows', async () => {
    const { telegram, log, bot } = throwing(new Error('boom'));
    telegram.fail({ chatId: IDS.reporter }, FAILURES.botBlocked);
    await expect(bot.handleUpdate(privateMessage(IDS.reporter, 'x'))).resolves.toBeUndefined();
    expect(log.records()).toEqual([
      { level: 'error', event: 'update.failed', errorClass: 'Error' },
      { level: 'error', event: 'reply.failed', errorClass: 'GrammyError', telegramErrorCode: 403, apiMethod: 'sendMessage' },
    ]);
  });

  it('catches a storage failure inside a real handler', async () => {
    const failing: SqlDb = {
      run: () => Promise.reject(new AppError('STORAGE_FAILURE', 'D1 run failed')),
      all: () => Promise.reject(new AppError('STORAGE_FAILURE', 'D1 all failed')),
      first: () => Promise.reject(new AppError('STORAGE_FAILURE', 'D1 first failed')),
      batch: () => Promise.reject(new AppError('STORAGE_FAILURE', 'D1 batch failed')),
    };
    const telegram = fakeBotApi();
    const log = recordingLogger();
    const bot = createBot({ config, db: failing, clock: { now: () => 0, sleep: () => Promise.resolve() }, logger: log.logger, fetch: telegram.fetch });
    await bot.handleUpdate(privateMessage(IDS.reporter, '/start'));
    expect(telegram.callsOf('sendMessage').map((call) => call.payload.text)).toEqual([t('en', 'error.unexpected')]);
    expect(log.records()).toEqual([
      { level: 'error', event: 'update.failed', errorClass: 'AppError', errorCode: 'STORAGE_FAILURE' },
    ]);
  });
});

describe("the bot's error handler (bot.catch, the long-polling path)", () => {
  const CONSOLE_METHODS = ['log', 'error', 'warn', 'info', 'debug'] as const;
  /** A BotError around a real GrammyError whose payload carries a reported URL and a chat id. */
  const botError = () =>
    new BotError(
      new GrammyError(
        "Call to 'sendMessage' failed!",
        { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
        'sendMessage',
        { chat_id: IDS.reporter, text: 'Report https://www.instagram.com/reported.account/ now' },
      ),
      {} as Context,
    );

  it('logs the class of the error inside the BotError, never its payload, and writes nothing to the console', async () => {
    const harness = botHarness();
    const spies = CONSOLE_METHODS.map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    try {
      await harness.bot.errorHandler(botError());
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(harness.log.lines).toEqual([
      {
        level: 'error',
        line: '{"level":"error","event":"update.failed","errorClass":"GrammyError","telegramErrorCode":403,"apiMethod":"sendMessage"}',
      },
    ]);
    expect(harness.log.text()).not.toContain('instagram');
    expect(harness.log.text()).not.toContain(String(IDS.reporter));
  });

  it("replaces grammY's default, which would write the error to the console", async () => {
    const plain = new Bot(config.botToken, { botInfo: botInfoFor(config), client: clientOptions(fakeBotApi().fetch) });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(Promise.resolve(plain.errorHandler(botError()))).rejects.toBeInstanceOf(BotError);
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});

describe('failureKey', () => {
  it("takes an AppError's key that has no parameters, and the generic one otherwise", () => {
    expect(failureKey(new AppError('UNAUTHORIZED', 'x'))).toBe('error.unauthorized');
    expect(failureKey(new AppError('CONFIG_INVALID', 'x', { variables: ['BOT_ID'] }))).toBe('error.unexpected');
    expect(failureKey(new AppError('STORAGE_FAILURE', 'x'))).toBe('error.unexpected');
    expect(failureKey(new Error('x'))).toBe('error.unexpected');
    expect(failureKey('thrown string')).toBe('error.unexpected');
  });
});

describe("the bot's client bound", () => {
  it('gives up on a request after BOT_TIMEOUT_SECONDS, ten, on bot.api and on an update\'s api alike', async () => {
    expect(BOT_TIMEOUT_SECONDS).toBe(10);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const harness = botHarness();
      harness.telegram.fail({ method: 'sendMessage' }, FAILURES.hang);
      const direct = harness.bot.api.sendMessage(IDS.reporter, 'x').then(
        () => null,
        (error: unknown) => error,
      );
      // A handler's own call: /start's reply, on the update's api, hangs too.
      const handled = harness.send(privateMessage(IDS.keyholder, '/start'));
      await vi.advanceTimersByTimeAsync(BOT_TIMEOUT_SECONDS * 1000 - 1);
      expect(harness.telegram.hanging()).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(await direct).toBeInstanceOf(HttpError);
      // The handler's reply gave up too; the error boundary's own answer hangs as well, and is bounded the same way.
      expect(harness.telegram.hanging()).toBe(1);
      await vi.advanceTimersByTimeAsync(BOT_TIMEOUT_SECONDS * 1000);
      await handled;
      expect(harness.telegram.hanging()).toBe(0);
      expect(harness.log.records()).toEqual([
        { level: 'error', event: 'update.failed', errorClass: 'HttpError' },
        { level: 'error', event: 'reply.failed', errorClass: 'HttpError' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

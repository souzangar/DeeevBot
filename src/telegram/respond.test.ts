// Unit tests for where the bot may answer (src/telegram/respond.ts;
// critical invariant 5): a button by its callback answer, never a message
// (a channel post's button included); a private chat and the venue by a
// reply in that chat; any other chat not at all.
import { Bot, type Context } from 'grammy';
import { describe, expect, it } from 'vitest';
import { FAILURES, fakeBotApi } from '../../test/fakes/bot-api';
import { IDS, testConfig } from '../../test/support/config';
import { buttonPress, groupMessage, privateMessage } from '../../test/support/updates';
import { clientOptions, installTransformer } from './api';
import { botInfoFor } from './bot';
import { answerPress, answersIn, pressAnswered, respond, respondWith, type RespondOutcome } from './respond';

const config = testConfig();

/** A bot whose only middleware responds with `text` and records how. */
const setup = () => {
  const telegram = fakeBotApi({ channelIds: [IDS.broadcastChannel] });
  const outcomes: RespondOutcome[] = [];
  const bot = new Bot(config.botToken, { botInfo: botInfoFor(config), client: clientOptions(telegram.fetch) });
  installTransformer(bot.api);
  bot.use(async (ctx: Context) => {
    outcomes.push(await respond(ctx, config, 'the answer'));
  });
  return { telegram, outcomes, bot };
};

describe('answersIn', () => {
  it('admits a private chat and the venue only', () => {
    expect(answersIn(config, { id: IDS.reporter, type: 'private' })).toBe(true);
    expect(answersIn(config, { id: IDS.adminChat, type: 'supergroup' })).toBe(true);
    expect(answersIn(config, { id: IDS.membershipChat, type: 'supergroup' })).toBe(false);
    expect(answersIn(config, { id: IDS.broadcastChannel, type: 'channel' })).toBe(false);
    expect(answersIn(config, { id: IDS.strangerGroup, type: 'group' })).toBe(false);
  });
});

describe('respond', () => {
  it('replies in a private chat, to that chat', async () => {
    const { telegram, outcomes, bot } = setup();
    await bot.handleUpdate(privateMessage(IDS.reporter, 'hello'));
    expect(outcomes).toEqual(['replied']);
    expect(telegram.callsOf('sendMessage').map((call) => [call.chatId, call.payload.text])).toEqual([
      [IDS.reporter, 'the answer'],
    ]);
  });

  it('replies in the venue', async () => {
    const { telegram, outcomes, bot } = setup();
    await bot.handleUpdate(groupMessage(IDS.adminChat, IDS.admin, 'hello'));
    expect(outcomes).toEqual(['replied']);
    expect(telegram.callsOf('sendMessage').map((call) => call.chatId)).toEqual([IDS.adminChat]);
  });

  it('answers a press on a channel post by its callback answer, and sends nothing to the channel', async () => {
    const { telegram, outcomes, bot } = setup();
    await bot.handleUpdate(buttonPress(IDS.reporter, 'mark:abcdefghijklmnopqrst', { chatId: IDS.broadcastChannel, messageId: 9 }));
    expect(outcomes).toEqual(['answered']);
    expect(telegram.count('sendMessage')).toBe(0);
    expect(telegram.callsOf('answerCallbackQuery')).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ text: 'the answer' }) as unknown }),
    ]);
  });

  it('says nothing in the membership group or any other group', async () => {
    const { telegram, outcomes, bot } = setup();
    await bot.handleUpdate(groupMessage(IDS.membershipChat, IDS.reporter, 'hello'));
    await bot.handleUpdate(groupMessage(IDS.strangerGroup, IDS.reporter, 'hello'));
    expect(outcomes).toEqual(['silent', 'silent']);
    expect(telegram.count()).toBe(0);
  });
});

describe('answerPress', () => {
  const press = buttonPress(IDS.reporter, 'mark:abcdefghijklmnopqrst', { chatId: IDS.broadcastChannel, messageId: 9 });

  it('answers a press once: a second answer, and respond() after it, send nothing', async () => {
    const telegram = fakeBotApi();
    const seen: unknown[] = [];
    const bot = new Bot(config.botToken, { botInfo: botInfoFor(config), client: clientOptions(telegram.fetch) });
    bot.use(async (ctx: Context) => {
      seen.push(pressAnswered(ctx), await answerPress(ctx, { text: 'first' }), pressAnswered(ctx));
      seen.push(await answerPress(ctx, { text: 'second' }), await respond(ctx, config, 'third'));
    });
    await bot.handleUpdate(press);
    expect(seen).toEqual([false, true, true, false, 'silent']);
    expect(telegram.callsOf('answerCallbackQuery').map((call) => call.payload.text)).toEqual(['first']);
  });

  it('leaves a press whose answer failed unmarked, so it can be answered again', async () => {
    const telegram = fakeBotApi();
    telegram.fail({ method: 'answerCallbackQuery' }, FAILURES.serverError, 1);
    const seen: unknown[] = [];
    const bot = new Bot(config.botToken, { botInfo: botInfoFor(config), client: clientOptions(telegram.fetch) });
    bot.use(async (ctx: Context) => {
      seen.push(await answerPress(ctx, { text: 'first' }).catch(() => 'failed'), pressAnswered(ctx));
      seen.push(await respond(ctx, config, 'again'));
    });
    await bot.handleUpdate(press);
    expect(seen).toEqual(['failed', false, 'answered']);
    expect(telegram.callsOf('answerCallbackQuery').map((call) => call.payload.text)).toEqual(['first', 'again']);
  });
});

describe('respondWith', () => {
  it("answers with the catalog string in the sender's locale", async () => {
    const telegram = fakeBotApi();
    const bot = new Bot(config.botToken, { botInfo: botInfoFor(config), client: clientOptions(telegram.fetch) });
    bot.use(async (ctx: Context) => {
      await respondWith(ctx, config, 'admin.refused');
    });
    await bot.handleUpdate(privateMessage(IDS.admin, 'x', { languageCode: 'fa' }));
    await bot.handleUpdate(privateMessage(IDS.admin, 'x', { languageCode: 'en-GB' }));
    expect(telegram.callsOf('sendMessage').map((call) => call.payload.text)).toEqual([
      'این کار اکنون پذیرفته نمی‌شود.',
      'This action is refused right now.',
    ]);
  });
});

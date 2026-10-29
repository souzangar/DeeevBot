// Unit tests for the authority gates (src/telegram/guards.ts; critical
// invariant 2), with stub admin and keyholder handlers registered behind
// them as the later units register theirs: the command contexts (who,
// where, typed and not forwarded), the fall-through that hints nothing, the
// lockdown refusal of admin actions, and the button gates.
import { Bot, type Context } from 'grammy';
import { describe, expect, it } from 'vitest';
import { fakeBotApi } from '../../test/fakes/bot-api';
import { fakeClock } from '../../test/fakes/clock';
import { IDS, testConfig } from '../../test/support/config';
import { migratedDatabase } from '../../test/support/database';
import { buttonPress, groupMessage, privateMessage } from '../../test/support/updates';
import { setLockdown } from '../auth/lockdown';
import { t } from '../i18n/index';
import { clientOptions, installTransformer } from './api';
import { botInfoFor } from './bot';
import {
  adminButton,
  isAdminCommand,
  isKeyholderCommand,
  isVenueAdminCommand,
  isVenueAdminReply,
  keyholderButton,
  pressedInVenue,
  refuseUnderLockdown,
  typedInOwnChat,
  typedInVenue,
} from './guards';

const setup = (variables: Readonly<Record<string, string | undefined>> = {}) => {
  const config = testConfig(variables);
  const telegram = fakeBotApi({ channelIds: [IDS.broadcastChannel] });
  const clock = fakeClock(1_850_000_000_000);
  const { db } = migratedDatabase(clock);
  const ran: string[] = [];
  const bot = new Bot(config.botToken, { botInfo: botInfoFor(config), client: clientOptions(telegram.fetch) });
  installTransformer(bot.api);
  const deps = { config, db };
  bot.filter(isAdminCommand(config)).command('probe', refuseUnderLockdown(deps), () => {
    ran.push('admin probe');
  });
  bot.filter(isKeyholderCommand(config)).command('keyprobe', () => {
    ran.push('keyholder probe');
  });
  bot.callbackQuery(/^card:/, adminButton(deps), async (ctx) => {
    ran.push('card button');
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery(/^notice:/, keyholderButton(config), async (ctx) => {
    ran.push('notice button');
    await ctx.answerCallbackQuery();
  });
  bot.on('message', async (ctx: Context) => {
    ran.push('fell through');
    await ctx.reply('unknown');
  });
  const answers = () => telegram.callsOf('answerCallbackQuery').map((call) => call.payload.text);
  const replies = () => telegram.callsOf('sendMessage').map((call) => [call.chatId, call.payload.text]);
  return { config, telegram, clock, db, ran, bot, answers, replies };
};

/** The predicate's answer for one update. */
const holds = async (predicate: (ctx: Context) => boolean, update: Parameters<Bot['handleUpdate']>[0]) => {
  const config = testConfig();
  const telegram = fakeBotApi();
  const bot = new Bot(config.botToken, { botInfo: botInfoFor(config), client: clientOptions(telegram.fetch) });
  let result: boolean | undefined;
  bot.use((ctx) => {
    result = predicate(ctx);
  });
  await bot.handleUpdate(update);
  return result;
};

describe('typedInOwnChat and typedInVenue', () => {
  const config = testConfig();

  it("a message typed in its sender's own private chat", async () => {
    expect(await holds(typedInOwnChat, privateMessage(IDS.reporter, '/start'))).toBe(true);
    expect(await holds(typedInOwnChat, privateMessage(IDS.reporter, '/start', { forwarded: true }))).toBe(false);
    expect(await holds(typedInOwnChat, groupMessage(IDS.adminChat, IDS.admin, '/start'))).toBe(false);
    expect(await holds(typedInOwnChat, buttonPress(IDS.reporter, 'x', { chatId: IDS.reporter, messageId: 1 }))).toBe(false);
  });

  it('a message typed in the venue, and in no other group', async () => {
    const inVenue = (ctx: Context) => typedInVenue(config, ctx);
    expect(await holds(inVenue, groupMessage(IDS.adminChat, IDS.admin, '/open'))).toBe(true);
    expect(await holds(inVenue, groupMessage(IDS.adminChat, IDS.admin, '/open', { forwarded: true }))).toBe(false);
    expect(await holds(inVenue, groupMessage(IDS.membershipChat, IDS.admin, '/open'))).toBe(false);
    expect(await holds(inVenue, privateMessage(IDS.admin, '/open'))).toBe(false);
  });
});

describe('keyholder commands', () => {
  it('run for a keyholder in their own private chat', async () => {
    const { ran, bot } = setup();
    await bot.handleUpdate(privateMessage(IDS.keyholder, '/keyprobe'));
    await bot.handleUpdate(privateMessage(IDS.secondKeyholder, '/keyprobe'));
    expect(ran).toEqual(['keyholder probe', 'keyholder probe']);
  });

  it.each([
    ['in the venue', groupMessage(IDS.adminChat, IDS.keyholder, '/keyprobe')],
    ['in the membership group', groupMessage(IDS.membershipChat, IDS.keyholder, '/keyprobe')],
    ['addressed to the bot in a group', groupMessage(IDS.strangerGroup, IDS.keyholder, '/keyprobe@div_report_test_bot')],
    ['forwarded by the keyholder', privateMessage(IDS.keyholder, '/keyprobe', { forwarded: true })],
  ])('never run for a keyholder %s', async (_label, update) => {
    const { ran, bot } = setup();
    await bot.handleUpdate(update);
    expect(ran).not.toContain('keyholder probe');
  });

  it('fall through for an admin, a reporter or anyone else, exactly as an unknown command does', async () => {
    const { ran, bot, replies } = setup();
    for (const id of [IDS.admin, IDS.reporter, IDS.stranger]) {
      await bot.handleUpdate(privateMessage(id, '/keyprobe'));
      await bot.handleUpdate(privateMessage(id, '/nosuchcommand'));
    }
    expect(ran).toEqual(Array.from({ length: 6 }, () => 'fell through'));
    expect(replies()).toEqual([
      [IDS.admin, 'unknown'],
      [IDS.admin, 'unknown'],
      [IDS.reporter, 'unknown'],
      [IDS.reporter, 'unknown'],
      [IDS.stranger, 'unknown'],
      [IDS.stranger, 'unknown'],
    ]);
  });

  it('are re-checked on every update: an id dropped from the configuration loses them', async () => {
    const before = setup();
    await before.bot.handleUpdate(privateMessage(IDS.secondKeyholder, '/keyprobe'));
    const after = setup({ KEYHOLDER_IDS: String(IDS.keyholder) });
    await after.bot.handleUpdate(privateMessage(IDS.secondKeyholder, '/keyprobe'));
    expect(before.ran).toEqual(['keyholder probe']);
    expect(after.ran).toEqual(['fell through']);
  });
});

describe('admin commands', () => {
  it('run for an admin in their own private chat and in the venue', async () => {
    const { ran, bot } = setup();
    await bot.handleUpdate(privateMessage(IDS.admin, '/probe'));
    await bot.handleUpdate(groupMessage(IDS.adminChat, IDS.secondAdmin, '/probe'));
    expect(ran).toEqual(['admin probe', 'admin probe']);
  });

  it.each([
    ['an admin in the membership group', groupMessage(IDS.membershipChat, IDS.admin, '/probe')],
    ['an admin forwarding', privateMessage(IDS.admin, '/probe', { forwarded: true })],
    ['a non-admin in the venue', groupMessage(IDS.adminChat, IDS.reporter, '/probe')],
    ['a keyholder in their own chat', privateMessage(IDS.keyholder, '/probe')],
  ])('never run for %s', async (_label, update) => {
    const { ran, bot } = setup();
    await bot.handleUpdate(update);
    expect(ran).not.toContain('admin probe');
  });

  it('are refused under the lockdown switch, with the refusal and nothing else', async () => {
    const { ran, bot, db, clock, replies } = setup();
    await setLockdown(db, clock);
    await bot.handleUpdate(privateMessage(IDS.admin, '/probe'));
    await bot.handleUpdate(groupMessage(IDS.adminChat, IDS.admin, '/probe'));
    expect(ran).toEqual([]);
    expect(replies()).toEqual([
      [IDS.admin, t('en', 'admin.refused')],
      [IDS.adminChat, t('en', 'admin.refused')],
    ]);
  });

  it('are refused under the LOCKDOWN override', async () => {
    const { ran, bot, replies } = setup({ LOCKDOWN: '1' });
    await bot.handleUpdate(privateMessage(IDS.admin, '/probe', { languageCode: 'fa' }));
    expect(ran).toEqual([]);
    expect(replies()).toEqual([[IDS.admin, t('fa', 'admin.refused')]]);
  });
});

describe('admin buttons', () => {
  const card = { chatId: IDS.adminChat, messageId: 12, chatType: 'supergroup' as const };

  it('run for an admin', async () => {
    const { ran, bot } = setup();
    await bot.handleUpdate(buttonPress(IDS.admin, 'card:approve', card));
    expect(ran).toEqual(['card button']);
  });

  it("refuse a press by an id outside ADMIN_IDS, a keyholder's included", async () => {
    const { ran, bot, answers } = setup();
    await bot.handleUpdate(buttonPress(IDS.reporter, 'card:approve', card));
    await bot.handleUpdate(buttonPress(IDS.keyholder, 'card:approve', card));
    expect(ran).toEqual([]);
    expect(answers()).toEqual([t('en', 'error.unauthorized'), t('en', 'error.unauthorized')]);
  });

  it('refuse every press under lockdown, by the callback answer alone', async () => {
    const { ran, bot, db, clock, answers, telegram } = setup();
    await setLockdown(db, clock);
    await bot.handleUpdate(buttonPress(IDS.admin, 'card:approve', card));
    expect(ran).toEqual([]);
    expect(answers()).toEqual([t('en', 'admin.refused')]);
    expect(telegram.count('sendMessage')).toBe(0);
  });
});

describe('keyholder buttons', () => {
  const notice = (keyholder: number) => ({ chatId: keyholder, messageId: 4, chatType: 'private' as const });

  it('run for a keyholder on a notice in their own chat, under lockdown too', async () => {
    const { ran, bot, db, clock } = setup();
    await bot.handleUpdate(buttonPress(IDS.keyholder, 'notice:cancel', notice(IDS.keyholder)));
    await setLockdown(db, clock);
    await bot.handleUpdate(buttonPress(IDS.keyholder, 'notice:cancel', notice(IDS.keyholder)));
    const overridden = setup({ LOCKDOWN: '1' });
    await overridden.bot.handleUpdate(buttonPress(IDS.secondKeyholder, 'notice:lockdown', notice(IDS.secondKeyholder)));
    expect([...ran, ...overridden.ran]).toEqual(['notice button', 'notice button', 'notice button']);
  });

  it("refuse anyone else, and a keyholder's press on a message in another chat", async () => {
    const { ran, bot, answers } = setup();
    await bot.handleUpdate(buttonPress(IDS.admin, 'notice:cancel', notice(IDS.admin)));
    await bot.handleUpdate(buttonPress(IDS.keyholder, 'notice:cancel', notice(IDS.secondKeyholder)));
    await bot.handleUpdate(buttonPress(IDS.keyholder, 'notice:cancel', { chatId: IDS.adminChat, messageId: 4, chatType: 'supergroup' }));
    expect(ran).toEqual([]);
    expect(answers()).toEqual(Array.from({ length: 3 }, () => t('en', 'error.unauthorized')));
  });
});

describe('the venue gates of the review', () => {
  const config = testConfig();

  it('isVenueAdminCommand: an admin typing in the venue, and nobody, nowhere else', async () => {
    const venue = isVenueAdminCommand(config);
    expect(await holds(venue, groupMessage(IDS.adminChat, IDS.admin, '/open'))).toBe(true);
    expect(await holds(venue, groupMessage(IDS.adminChat, IDS.secondAdmin, '/open'))).toBe(true);
    expect(await holds(venue, privateMessage(IDS.admin, '/open'))).toBe(false);
    expect(await holds(venue, groupMessage(IDS.adminChat, IDS.keyholder, '/open'))).toBe(false);
    expect(await holds(venue, groupMessage(IDS.adminChat, IDS.admin, '/open', { forwarded: true }))).toBe(false);
    expect(await holds(venue, groupMessage(IDS.membershipChat, IDS.admin, '/open'))).toBe(false);
  });

  it("isVenueAdminReply: an admin's typed reply in the venue to the bot's own message there", async () => {
    const reply = isVenueAdminReply(config);
    expect(await holds(reply, groupMessage(IDS.adminChat, IDS.admin, 'points', { replyToBot: 4 }))).toBe(true);
    expect(await holds(reply, groupMessage(IDS.adminChat, IDS.admin, 'points'))).toBe(false);
    expect(await holds(reply, groupMessage(IDS.adminChat, IDS.reporter, 'points', { replyToBot: 4 }))).toBe(false);
    expect(await holds(reply, groupMessage(IDS.adminChat, IDS.admin, 'points', { replyToBot: 4, forwarded: true }))).toBe(false);
    expect(await holds(reply, groupMessage(IDS.strangerGroup, IDS.admin, 'points', { replyToBot: 4 }))).toBe(false);
    const toSomeoneElse = groupMessage(IDS.adminChat, IDS.admin, 'points', { replyToBot: 4 });
    const replied = toSomeoneElse.message?.reply_to_message;
    if (replied === undefined) throw new Error('no reply');
    const notTheBot = { ...toSomeoneElse, message: { ...toSomeoneElse.message, reply_to_message: { ...replied, from: { id: IDS.secondAdmin, is_bot: false, first_name: 'Admin' } } } };
    expect(await holds(reply, notTheBot as typeof toSomeoneElse)).toBe(false);
  });

  it('pressedInVenue: refuses a press on a message outside the venue', async () => {
    const telegram = fakeBotApi();
    const ran: string[] = [];
    const bot = new Bot(config.botToken, { botInfo: botInfoFor(config), client: clientOptions(telegram.fetch) });
    bot.callbackQuery(/^card:/, pressedInVenue(config), async (ctx) => {
      ran.push('ran');
      await ctx.answerCallbackQuery();
    });
    await bot.handleUpdate(buttonPress(IDS.admin, 'card:x', { chatId: IDS.adminChat, messageId: 1, chatType: 'supergroup' }));
    await bot.handleUpdate(buttonPress(IDS.admin, 'card:x', { chatId: IDS.admin, messageId: 1, chatType: 'private' }));
    expect(ran).toEqual(['ran']);
    expect(telegram.callsOf('answerCallbackQuery').map((call) => call.payload.text)).toEqual([undefined, t('en', 'error.unauthorized')]);
  });
});

// Unit tests for the admin surface (src/telegram/registry.ts; critical
// invariant 2): each kind of registration behind its gates, with stub
// handlers, over a real grammY Bot and the fake Bot API: an admin command
// in the venue only and refused under lockdown; an admin button refused to
// anyone but an admin, under lockdown and outside the venue; an admin's
// reply to the bot in the venue; a keyholder's command and button in their
// own chat, under lockdown too; what was registered, listed; and a
// registration that could reach two handlers, refused.
import { Bot, type Context } from 'grammy';
import { describe, expect, it } from 'vitest';
import { fakeBotApi } from '../../test/fakes/bot-api';
import { fakeClock } from '../../test/fakes/clock';
import { IDS, testConfig } from '../../test/support/config';
import { migratedDatabase } from '../../test/support/database';
import { buttonPress, groupMessage, privateMessage } from '../../test/support/updates';
import { setLockdown } from '../auth/lockdown';
import { AppError } from '../errors/app-error';
import { t } from '../i18n/index';
import { clientOptions, installTransformer } from './api';
import { botInfoFor } from './bot';
import { adminSurface } from './registry';

const setup = (variables: Readonly<Record<string, string | undefined>> = {}) => {
  const config = testConfig(variables);
  const telegram = fakeBotApi();
  const clock = fakeClock(1_850_000_000_000);
  const { db } = migratedDatabase(clock);
  const ran: string[] = [];
  const surface = adminSurface({ config, db });
  const record = (name: string) => async (ctx: Context) => {
    ran.push(name);
    if (ctx.callbackQuery !== undefined) await ctx.answerCallbackQuery();
  };
  surface.adminCommand('probe', record('admin command'));
  surface.adminButton('rv:pr:', record('admin button'));
  surface.adminReply(record('admin reply'));
  surface.keyholderCommand('keyprobe', record('keyholder command'));
  surface.keyholderButton('kh:pr:', record('keyholder button'));
  const bot = new Bot(config.botToken, { botInfo: botInfoFor(config), client: clientOptions(telegram.fetch) });
  installTransformer(bot.api);
  bot.use(surface.composer);
  bot.on('message', () => {
    ran.push('fell through');
  });
  const answers = () => telegram.callsOf('answerCallbackQuery').map((call) => call.payload.text);
  const replies = () => telegram.callsOf('sendMessage').map((call) => [call.chatId, call.payload.text]);
  return { config, telegram, clock, db, ran, surface, bot, answers, replies };
};

const venuePress = (userId: number, data: string) => buttonPress(userId, data, { chatId: IDS.adminChat, messageId: 3, chatType: 'supergroup' });

describe('adminCommand', () => {
  it('runs for an admin typing it in the venue, and is no command anywhere else or from anyone else', async () => {
    const { bot, ran } = setup();
    await bot.handleUpdate(groupMessage(IDS.adminChat, IDS.admin, '/probe'));
    await bot.handleUpdate(groupMessage(IDS.adminChat, IDS.secondAdmin, '/probe@div_report_test_bot'));
    await bot.handleUpdate(privateMessage(IDS.admin, '/probe'));
    await bot.handleUpdate(groupMessage(IDS.adminChat, IDS.reporter, '/probe'));
    await bot.handleUpdate(groupMessage(IDS.adminChat, IDS.keyholder, '/probe'));
    await bot.handleUpdate(groupMessage(IDS.adminChat, IDS.admin, '/probe', { forwarded: true }));
    await bot.handleUpdate(groupMessage(IDS.membershipChat, IDS.admin, '/probe'));
    expect(ran).toEqual(['admin command', 'admin command', 'fell through', 'fell through', 'fell through', 'fell through', 'fell through']);
  });

  it("is refused under the lockdown switch and the override, with the refusal alone, in the venue's language", async () => {
    const switched = setup();
    await setLockdown(switched.db, switched.clock);
    await switched.bot.handleUpdate(groupMessage(IDS.adminChat, IDS.admin, '/probe', { languageCode: 'en' }));
    const overridden = setup({ LOCKDOWN: '1', VENUE_LOCALE: 'en' });
    await overridden.bot.handleUpdate(groupMessage(IDS.adminChat, IDS.admin, '/probe', { languageCode: 'fa' }));
    expect([...switched.ran, ...overridden.ran]).toEqual([]);
    expect([...switched.replies(), ...overridden.replies()]).toEqual([
      [IDS.adminChat, t('fa', 'admin.refused')],
      [IDS.adminChat, t('en', 'admin.refused')],
    ]);
  });
});

describe('adminButton', () => {
  it('runs for an admin in the venue', async () => {
    const { bot, ran } = setup();
    await bot.handleUpdate(venuePress(IDS.admin, 'rv:pr:x'));
    expect(ran).toEqual(['admin button']);
  });

  it("refuses anyone but an admin and every press under lockdown in the venue's language, a press outside the venue in the presser's", async () => {
    const { bot, ran, answers, db, clock } = setup();
    await bot.handleUpdate(venuePress(IDS.reporter, 'rv:pr:x'));
    await bot.handleUpdate(venuePress(IDS.keyholder, 'rv:pr:x'));
    await bot.handleUpdate(buttonPress(IDS.admin, 'rv:pr:x', { chatId: IDS.admin, messageId: 3, chatType: 'private' }));
    await bot.handleUpdate(buttonPress(IDS.admin, 'rv:pr:x', { chatId: IDS.broadcastChannel, messageId: 3 }));
    await setLockdown(db, clock);
    await bot.handleUpdate(venuePress(IDS.admin, 'rv:pr:x'));
    expect(ran).toEqual([]);
    expect(answers()).toEqual([
      t('fa', 'error.unauthorized'),
      t('fa', 'error.unauthorized'),
      t('en', 'error.unauthorized'),
      t('en', 'error.unauthorized'),
      t('fa', 'admin.refused'),
    ]);
  });
});

describe('adminReply', () => {
  it("runs for an admin's typed reply to the bot in the venue, and for nothing else", async () => {
    const { bot, ran } = setup();
    await bot.handleUpdate(groupMessage(IDS.adminChat, IDS.admin, 'points', { replyToBot: 5 }));
    await bot.handleUpdate(groupMessage(IDS.adminChat, IDS.admin, 'points'));
    await bot.handleUpdate(groupMessage(IDS.adminChat, IDS.reporter, 'points', { replyToBot: 5 }));
    await bot.handleUpdate(groupMessage(IDS.adminChat, IDS.admin, 'points', { replyToBot: 5, forwarded: true }));
    await bot.handleUpdate(groupMessage(IDS.membershipChat, IDS.admin, 'points', { replyToBot: 5 }));
    await bot.handleUpdate(privateMessage(IDS.admin, 'points', { replyToBot: 5 }));
    expect(ran).toEqual(['admin reply', 'fell through', 'fell through', 'fell through', 'fell through', 'fell through']);
  });

  it("is refused under lockdown, in the venue's language", async () => {
    const { bot, ran, replies } = setup({ LOCKDOWN: '1' });
    await bot.handleUpdate(groupMessage(IDS.adminChat, IDS.admin, 'points', { replyToBot: 5, languageCode: 'en' }));
    expect(ran).toEqual([]);
    expect(replies()).toEqual([[IDS.adminChat, t('fa', 'admin.refused')]]);
  });
});

describe('keyholderCommand and keyholderButton', () => {
  it("run for a keyholder in their own chat, under lockdown too", async () => {
    const { bot, ran, db, clock } = setup();
    await setLockdown(db, clock);
    await bot.handleUpdate(privateMessage(IDS.keyholder, '/keyprobe'));
    await bot.handleUpdate(buttonPress(IDS.secondKeyholder, 'kh:pr:x', { chatId: IDS.secondKeyholder, messageId: 2, chatType: 'private' }));
    expect(ran).toEqual(['keyholder command', 'keyholder button']);
  });

  it('are no command for anyone else, and the button is refused to anyone else or on another chat', async () => {
    const { bot, ran, answers } = setup();
    await bot.handleUpdate(privateMessage(IDS.admin, '/keyprobe'));
    await bot.handleUpdate(groupMessage(IDS.adminChat, IDS.keyholder, '/keyprobe'));
    await bot.handleUpdate(privateMessage(IDS.keyholder, '/keyprobe', { forwarded: true }));
    await bot.handleUpdate(buttonPress(IDS.admin, 'kh:pr:x', { chatId: IDS.admin, messageId: 2, chatType: 'private' }));
    await bot.handleUpdate(buttonPress(IDS.keyholder, 'kh:pr:x', { chatId: IDS.secondKeyholder, messageId: 2, chatType: 'private' }));
    expect(ran).toEqual(['fell through', 'fell through', 'fell through']);
    expect(answers()).toEqual([t('en', 'error.unauthorized'), t('en', 'error.unauthorized')]);
  });
});

describe('registrations', () => {
  it('lists what was registered, by kind', () => {
    const { surface } = setup();
    expect(surface.registrations()).toEqual({
      adminCommands: ['probe'],
      adminButtons: ['rv:pr:'],
      adminReplies: 1,
      keyholderCommands: ['keyprobe'],
      keyholderButtons: ['kh:pr:'],
    });
  });

  it('refuses a command twice, a name that is not plain, and a prefix that could reach two handlers', () => {
    const { surface } = setup();
    const handler = () => undefined;
    expect(() => surface.adminCommand('probe', handler)).toThrow(AppError);
    expect(() => surface.adminCommand('Probe', handler)).toThrow(AppError);
    expect(() => surface.keyholderCommand('key probe', handler)).toThrow(AppError);
    expect(() => surface.adminButton('rv:pr:', handler)).toThrow(AppError);
    expect(() => surface.adminButton('rv:pr', handler)).toThrow(AppError);
    expect(() => surface.keyholderButton('rv:pr:x', handler)).toThrow(AppError);
    expect(() => surface.adminButton('anything', handler)).toThrow(AppError);
    expect(surface.registrations().adminButtons).toEqual(['rv:pr:']);
  });
});

// Unit tests for the intake entry (src/telegram/intake-entry.ts): the
// lockdown gate first, for a message and for an intake press alike, the
// neutral answer and nothing stored or deleted under either layer; the
// intake conversation otherwise; private chats only.
import { Bot } from 'grammy';
import { describe, expect, it } from 'vitest';
import { fakeBotApi } from '../../test/fakes/bot-api';
import { fakeClock } from '../../test/fakes/clock';
import { recordingLogger } from '../../test/fakes/logger';
import { IDS, testConfig } from '../../test/support/config';
import { migratedDatabase } from '../../test/support/database';
import { buttonPress, groupMessage, privateMessage, privatePhoto } from '../../test/support/updates';
import { createMembershipCache } from '../auth/membership';
import { setLockdown } from '../auth/lockdown';
import { sql } from '../db/sql';
import { t } from '../i18n/index';
import { pressData } from '../review/intake';
import { clientOptions, installTransformer } from './api';
import { botInfoFor } from './bot';
import { intakeEntry } from './intake-entry';

const URL = 'https://www.instagram.com/reported.account/';

const setup = (variables: Readonly<Record<string, string | undefined>> = {}) => {
  const config = testConfig(variables);
  const telegram = fakeBotApi();
  const clock = fakeClock(1_850_000_000_000);
  const { db } = migratedDatabase(clock);
  const bot = new Bot(config.botToken, { botInfo: botInfoFor(config), client: clientOptions(telegram.fetch) });
  installTransformer(bot.api);
  bot.use(intakeEntry({ config, db, clock, logger: recordingLogger().logger, membershipCache: createMembershipCache() }));
  const texts = () => telegram.callsOf('sendMessage').map((call) => [call.chatId, call.payload.text]);
  return { telegram, clock, db, bot, texts };
};

const storedRows = async (db: ReturnType<typeof setup>['db']) =>
  db.first(
    sql`SELECT (SELECT count(*) FROM drafts) + (SELECT count(*) FROM reports) + (SELECT count(*) FROM reporter_stats) + (SELECT count(*) FROM counters) AS rows`,
  );

const CATEGORY_PRESS = buttonPress(IDS.reporter, pressData({ kind: 'category', category: 'other' }), {
  chatId: IDS.reporter,
  messageId: 3,
  chatType: 'private',
});

describe('the intake entry', () => {
  it('hands a private message to the intake conversation', async () => {
    const { bot, texts, db } = setup();
    await bot.handleUpdate(privateMessage(IDS.reporter, URL));
    await bot.handleUpdate(privatePhoto(IDS.stranger, URL));
    expect(texts()).toEqual([
      [IDS.reporter, t('en', 'intake.ask_category')],
      [IDS.stranger, `${t('en', 'intake.refused.media')}\n\n${t('en', 'intake.ask_url')}`],
    ]);
    expect(await db.first(sql`SELECT count(*) AS drafts FROM drafts`)).toEqual({ drafts: 1 });
  });

  it('hands an intake press to the intake conversation, and leaves every other press alone', async () => {
    const { bot, telegram } = setup();
    await bot.handleUpdate(CATEGORY_PRESS);
    await bot.handleUpdate(buttonPress(IDS.reporter, 'mark:abcdefghijklmnopqrst', { chatId: IDS.reporter, messageId: 4, chatType: 'private' }));
    expect(telegram.callsOf('answerCallbackQuery').map((call) => call.payload.text)).toEqual([t('en', 'intake.already_answered')]);
  });

  it('answers the neutral text and stores nothing under the lockdown switch', async () => {
    const { bot, db, clock, texts, telegram } = setup();
    await setLockdown(db, clock);
    await bot.handleUpdate(privateMessage(IDS.reporter, URL));
    await bot.handleUpdate(privateMessage(IDS.stranger, URL, { languageCode: 'fa' }));
    await bot.handleUpdate(CATEGORY_PRESS);
    expect(texts()).toEqual([
      [IDS.reporter, t('en', 'lockdown.unavailable')],
      [IDS.stranger, t('fa', 'lockdown.unavailable')],
    ]);
    expect(telegram.callsOf('answerCallbackQuery').map((call) => call.payload.text)).toEqual([t('en', 'lockdown.unavailable')]);
    expect(telegram.count('deleteMessage')).toBe(0);
    expect(await storedRows(db)).toEqual({ rows: 0 });
  });

  it('answers the neutral text and stores nothing under the LOCKDOWN override', async () => {
    const { bot, db, texts, telegram } = setup({ LOCKDOWN: '1' });
    await bot.handleUpdate(privateMessage(IDS.reporter, URL));
    await bot.handleUpdate(CATEGORY_PRESS);
    expect(texts()).toEqual([[IDS.reporter, t('en', 'lockdown.unavailable')]]);
    expect(telegram.callsOf('answerCallbackQuery').map((call) => call.payload.text)).toEqual([t('en', 'lockdown.unavailable')]);
    expect(await storedRows(db)).toEqual({ rows: 0 });
  });

  it('says nothing of the lockdown: the neutral text names no reason', () => {
    for (const locale of ['en', 'fa'] as const) {
      expect(t(locale, 'lockdown.unavailable')).not.toMatch(/lock|قفل/i);
    }
  });

  it('takes private messages and private presses only', async () => {
    const { telegram, bot } = setup();
    await bot.handleUpdate(groupMessage(IDS.adminChat, IDS.admin, URL));
    await bot.handleUpdate(groupMessage(IDS.membershipChat, IDS.reporter, URL));
    await bot.handleUpdate(
      buttonPress(IDS.reporter, pressData({ kind: 'category', category: 'other' }), { chatId: IDS.adminChat, messageId: 1, chatType: 'supergroup' }),
    );
    expect(telegram.calls).toEqual([]);
  });
});

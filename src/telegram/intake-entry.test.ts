// Unit tests for the intake entry (src/telegram/intake-entry.ts): the
// lockdown gate first, the neutral answer and nothing stored under either
// layer, the fallback answer otherwise, private chats only.
import { Bot } from 'grammy';
import { describe, expect, it } from 'vitest';
import { fakeBotApi } from '../../test/fakes/bot-api';
import { fakeClock } from '../../test/fakes/clock';
import { IDS, testConfig } from '../../test/support/config';
import { migratedDatabase } from '../../test/support/database';
import { groupMessage, privateMessage, privatePhoto } from '../../test/support/updates';
import { setLockdown } from '../auth/lockdown';
import { sql } from '../db/sql';
import { t } from '../i18n/index';
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
  bot.use(intakeEntry({ config, db }));
  const texts = () => telegram.callsOf('sendMessage').map((call) => [call.chatId, call.payload.text]);
  return { telegram, clock, db, bot, texts };
};

const storedRows = async (db: ReturnType<typeof setup>['db']) =>
  db.first(
    sql`SELECT (SELECT count(*) FROM drafts) + (SELECT count(*) FROM reports) + (SELECT count(*) FROM reporter_stats) + (SELECT count(*) FROM counters) AS rows`,
  );

describe('the intake entry', () => {
  it('answers a private message with the fallback text while intake is not there yet', async () => {
    const { bot, texts } = setup();
    await bot.handleUpdate(privateMessage(IDS.reporter, URL));
    await bot.handleUpdate(privateMessage(IDS.reporter, '/nosuchcommand', { languageCode: 'fa' }));
    await bot.handleUpdate(privatePhoto(IDS.reporter, URL));
    expect(texts()).toEqual([
      [IDS.reporter, t('en', 'fallback.help')],
      [IDS.reporter, t('fa', 'fallback.help')],
      [IDS.reporter, t('en', 'fallback.help')],
    ]);
  });

  it('answers the neutral text and stores nothing under the lockdown switch', async () => {
    const { bot, db, clock, texts } = setup();
    await setLockdown(db, clock);
    await bot.handleUpdate(privateMessage(IDS.reporter, URL));
    await bot.handleUpdate(privateMessage(IDS.stranger, URL, { languageCode: 'fa' }));
    expect(texts()).toEqual([
      [IDS.reporter, t('en', 'lockdown.unavailable')],
      [IDS.stranger, t('fa', 'lockdown.unavailable')],
    ]);
    expect(await storedRows(db)).toEqual({ rows: 0 });
  });

  it('answers the neutral text and stores nothing under the LOCKDOWN override', async () => {
    const { bot, db, texts } = setup({ LOCKDOWN: '1' });
    await bot.handleUpdate(privateMessage(IDS.reporter, URL));
    expect(texts()).toEqual([[IDS.reporter, t('en', 'lockdown.unavailable')]]);
    expect(await storedRows(db)).toEqual({ rows: 0 });
  });

  it('says nothing of the lockdown: the neutral text names no reason', () => {
    for (const locale of ['en', 'fa'] as const) {
      expect(t(locale, 'lockdown.unavailable')).not.toMatch(/lock|قفل/i);
    }
  });

  it('takes private messages only', async () => {
    const { telegram, bot } = setup();
    await bot.handleUpdate(groupMessage(IDS.adminChat, IDS.admin, URL));
    await bot.handleUpdate(groupMessage(IDS.membershipChat, IDS.reporter, URL));
    expect(telegram.calls).toEqual([]);
  });
});

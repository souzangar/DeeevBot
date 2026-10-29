// Unit tests for the commands of this unit (src/telegram/commands.ts),
// through the bot as the Worker composes it (test/support/bot-harness.ts):
// /start and /language in private chats only and in the reader's locale,
// both deleted on receipt outside lockdown (a keyholder's own commands
// kept), /language's choice kept in the draft by reference, the keyholder's
// confirmation, /lockdown and /unlock for keyholders in
// their own chat only, and the neutral answer under lockdown. The
// lockdown's catastrophic cases (who may clear it, what nothing clears) are
// test/invariants/lockdown.test.ts.
import type { Update } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import { FAILURES, fakeBotApi } from '../../test/fakes/bot-api';
import { fakeClock } from '../../test/fakes/clock';
import { recordingLogger } from '../../test/fakes/logger';
import { botHarness, NOW } from '../../test/support/bot-harness';
import { IDS, testConfig } from '../../test/support/config';
import { migratedDatabase } from '../../test/support/database';
import { reporterIn } from '../../test/support/intake-driver';
import { groupMessage, privateMessage } from '../../test/support/updates';
import { createMembershipCache } from '../auth/membership';
import { isLockedDown, setLockdown } from '../auth/lockdown';
import { sql } from '../db/sql';
import { t } from '../i18n/index';
import { reporterRef } from '../privacy/reporter-ref';
import { botInfoFor, createBot } from './bot';

const LOCKDOWN_ROW = sql`SELECT value FROM meta WHERE key = 'lockdown'`;
/** The line of the immediate retention pass a lockdown runs, over a store with nothing to delete. */
const RETENTION_DONE = { level: 'info', event: 'retention.done', drafts: 0, prompts: 0, abandoned: 0, expiring: 0, finalized: 0, removed: 0, reporterRows: 0, counterRows: 0 };

describe('/start', () => {
  it("explains the bot in the reader's locale", async () => {
    const harness = botHarness();
    await harness.send(privateMessage(IDS.reporter, '/start', { languageCode: 'fa-IR' }));
    await harness.send(privateMessage(IDS.stranger, '/start', { languageCode: 'de' }));
    expect(harness.textsTo(IDS.reporter)).toEqual([t('fa', 'start.intro')]);
    expect(harness.textsTo(IDS.stranger)).toEqual([t('en', 'start.intro')]);
  });

  it('says every message sent here is deleted once read, and that outcomes appear in the channel', () => {
    const intro = t('en', 'start.intro');
    expect(intro).toMatch(/Every message you send here is deleted from this chat as soon as I have read it\.$/);
    expect(intro).toMatch(/outcomes appear in the channel/);
    expect(intro).toMatch(/posted in the channel/);
    expect(intro).toMatch(/no message about the decision/);
    const persian = t('fa', 'start.intro');
    for (const part of ['هر پیامی که اینجا می‌فرستید', 'پس از خواندن', 'پاک می‌شود', 'نتیجه‌ها در کانال دیده می‌شوند']) {
      expect(persian, part).toContain(part);
    }
  });

  it('deletes the message, a payload with a link included, then explains the bot', async () => {
    const harness = botHarness();
    const update = await reporterIn(harness, IDS.reporter).say('/start https://www.instagram.com/p/x/');
    expect(harness.telegram.calls.map((call) => call.method)).toEqual(['deleteMessage', 'sendMessage']);
    expect(harness.telegram.messageIn(IDS.reporter, update.message?.message_id ?? 0)).toBeUndefined();
    expect(harness.textsTo(IDS.reporter)).toEqual([t('en', 'start.intro')]);
  });

  it('asks the reader to delete a /start it could not delete, the failure logged by class', async () => {
    const harness = botHarness();
    harness.telegram.fail({ method: 'deleteMessage' }, FAILURES.messageCantBeDeleted, 2);
    await reporterIn(harness, IDS.reporter).say('/start');
    expect(harness.textsTo(IDS.reporter)).toEqual([`${t('en', 'start.intro')}\n\n${t('en', 'intake.delete_yourself')}`]);
    expect(harness.log.records()).toEqual([
      { level: 'error', event: 'intake.message_not_deleted', errorClass: 'GrammyError', telegramErrorCode: 400, apiMethod: 'deleteMessage' },
    ]);
  });

  it("keeps a keyholder's /start, /lockdown and /unlock: that chat is the keyholder's operations log", async () => {
    const harness = botHarness();
    const keyholder = reporterIn(harness, IDS.keyholder);
    const sent = [await keyholder.say('/start'), await keyholder.say('/lockdown'), await keyholder.say('/unlock')];
    expect(harness.telegram.count('deleteMessage')).toBe(0);
    for (const update of sent) expect(harness.telegram.messageIn(IDS.keyholder, update.message?.message_id ?? 0)).toBeDefined();
  });

  it('deletes nothing under lockdown', async () => {
    const harness = botHarness({ variables: { LOCKDOWN: '1' } });
    const reporter = reporterIn(harness, IDS.reporter);
    await reporter.say('/start');
    await reporter.say('/language fa');
    expect(harness.telegram.count('deleteMessage')).toBe(0);
    expect(harness.textsTo(IDS.reporter)).toEqual([t('en', 'lockdown.unavailable'), t('en', 'lockdown.unavailable')]);
  });

  it('ignores a deep-link payload, which is never echoed', async () => {
    const harness = botHarness();
    await harness.send(privateMessage(IDS.reporter, '/start https-www-instagram-com-x'));
    expect(harness.textsTo(IDS.reporter)).toEqual([t('en', 'start.intro')]);
  });

  it('tells a keyholder that alerts will come here, under lockdown with its state', async () => {
    const harness = botHarness();
    await harness.send(privateMessage(IDS.keyholder, '/start'));
    await setLockdown(harness.db, harness.clock);
    await harness.send(privateMessage(IDS.secondKeyholder, '/start', { languageCode: 'fa' }));
    expect(harness.textsTo(IDS.keyholder)).toEqual([t('en', 'start.keyholder')]);
    expect(harness.textsTo(IDS.secondKeyholder)).toEqual([
      `${t('fa', 'start.keyholder')}\n\n${t('fa', 'keyholder.lockdown_is_on')}`,
    ]);
  });

  it('answers the neutral text to everyone else under lockdown', async () => {
    const harness = botHarness({ variables: { LOCKDOWN: '1' } });
    await harness.send(privateMessage(IDS.reporter, '/start'));
    await harness.send(privateMessage(IDS.admin, '/start', { languageCode: 'fa' }));
    expect(harness.textsTo(IDS.reporter)).toEqual([t('en', 'lockdown.unavailable')]);
    expect(harness.textsTo(IDS.admin)).toEqual([t('fa', 'lockdown.unavailable')]);
  });

  it.each([
    ['typed in the membership group', groupMessage(IDS.membershipChat, IDS.reporter, '/start')],
    ['addressed to the bot in the membership group', groupMessage(IDS.membershipChat, IDS.reporter, '/start@div_report_test_bot')],
    ['typed in the venue', groupMessage(IDS.adminChat, IDS.admin, '/start')],
    ["typed in a stranger's group", groupMessage(IDS.strangerGroup, IDS.reporter, '/start')],
  ])('is ignored when %s: no call at all', async (_label, update) => {
    const harness = botHarness();
    await harness.send(update);
    expect(harness.telegram.calls).toEqual([]);
  });
});

describe('/language', () => {
  it('answers in the chosen locale, whatever the case or spacing', async () => {
    const harness = botHarness();
    await harness.send(privateMessage(IDS.reporter, '/language fa'));
    await harness.send(privateMessage(IDS.reporter, '/language  EN '));
    expect(harness.textsTo(IDS.reporter)).toEqual([t('fa', 'language.set'), t('en', 'language.set')]);
  });

  it("explains the choice, in the reader's locale, for anything else", async () => {
    const harness = botHarness();
    await harness.send(privateMessage(IDS.reporter, '/language de', { languageCode: 'fa' }));
    await harness.send(privateMessage(IDS.reporter, '/language'));
    expect(harness.textsTo(IDS.reporter)).toEqual([t('fa', 'language.usage'), t('en', 'language.usage')]);
  });

  it('answers the neutral text under lockdown, and keeps nothing', async () => {
    const harness = botHarness({ variables: { LOCKDOWN: '1' } });
    await harness.send(privateMessage(IDS.reporter, '/language fa'));
    expect(harness.textsTo(IDS.reporter)).toEqual([t('en', 'lockdown.unavailable')]);
    expect(await harness.db.first(sql`SELECT count(*) AS drafts FROM drafts`)).toEqual({ drafts: 0 });
  });

  it('keeps the choice in the draft, keyed by the reference of the chat, never the id', async () => {
    const harness = botHarness();
    await harness.send(privateMessage(IDS.reporter, '/language fa'));
    const key = await reporterRef(IDS.reporter, harness.config.reporterRefKey);
    expect(await harness.db.all(sql`SELECT draft_key, step, locale, url FROM drafts`)).toEqual([
      { draft_key: key, step: 'url', locale: 'fa', url: null },
    ]);
    await harness.send(privateMessage(IDS.reporter, '/language en'));
    expect(await harness.db.all(sql`SELECT locale FROM drafts`)).toEqual([{ locale: 'en' }]);
  });

  it('keeps nothing for a choice that is no locale, and deletes the message before the answer', async () => {
    const harness = botHarness();
    const update = await reporterIn(harness, IDS.reporter).say('/language de https://www.instagram.com/p/x/');
    expect(await harness.db.first(sql`SELECT count(*) AS drafts FROM drafts`)).toEqual({ drafts: 0 });
    expect(harness.telegram.calls.map((call) => call.method)).toEqual(['deleteMessage', 'sendMessage']);
    expect(harness.telegram.messageIn(IDS.reporter, update.message?.message_id ?? 0)).toBeUndefined();
    expect(harness.textsTo(IDS.reporter)).toEqual([t('en', 'language.usage')]);
  });

  it('writes the choice, then deletes the message, then answers', async () => {
    const config = testConfig();
    const clock = fakeClock(NOW);
    const telegram = fakeBotApi({ botInfo: botInfoFor(config), now: () => clock.now() });
    const { db, connection } = migratedDatabase(clock);
    const seen: string[] = [];
    const watching: typeof fetch = (input, init) => {
      const method = String(input instanceof Request ? input.url : input).split('/').at(-1) ?? '';
      const locale = connection.prepare('SELECT locale FROM drafts').all()[0]?.locale;
      seen.push(`${method}:${String(locale ?? 'none')}`);
      return telegram.fetch(input, init);
    };
    const bot = createBot({ config, db, clock, logger: recordingLogger().logger, fetch: watching, membershipCache: createMembershipCache() });
    const update = await reporterIn({ telegram, send: (sent: Update) => bot.handleUpdate(sent) }, IDS.reporter).say('/language fa');
    expect(seen).toEqual(['deleteMessage:fa', 'sendMessage:fa']);
    expect(telegram.messageIn(IDS.reporter, update.message?.message_id ?? 0)).toBeUndefined();
  });

  it('deletes the message even when the write fails, before the error boundary answers', async () => {
    const harness = botHarness();
    harness.connection.exec("CREATE TRIGGER refuse_drafts BEFORE INSERT ON drafts BEGIN SELECT RAISE(ABORT, 'refused'); END");
    const update = await reporterIn(harness, IDS.reporter).say('/language fa');
    expect(harness.telegram.calls.map((call) => call.method)).toEqual(['deleteMessage', 'sendMessage']);
    expect(harness.telegram.messageIn(IDS.reporter, update.message?.message_id ?? 0)).toBeUndefined();
    expect(harness.textsTo(IDS.reporter)).toEqual([t('en', 'error.unexpected')]);
  });
});

describe('/lockdown and /unlock from a keyholder', () => {
  it('/lockdown sets the switch with the time, once, and says so', async () => {
    const harness = botHarness();
    await harness.send(privateMessage(IDS.keyholder, '/lockdown'));
    harness.clock.advance(5_000);
    await harness.send(privateMessage(IDS.secondKeyholder, '/lockdown'));
    expect(await harness.db.first(LOCKDOWN_ROW)).toEqual({ value: NOW });
    expect(await isLockedDown(harness.config, harness.db)).toBe(true);
    expect(harness.textsTo(IDS.keyholder)).toEqual([t('en', 'lockdown.on')]);
    expect(harness.textsTo(IDS.secondKeyholder)).toEqual([t('en', 'lockdown.already_on')]);
    // The immediate retention pass runs at each, the switch set already or not (src/privacy/retention.ts).
    expect(harness.log.records()).toEqual([{ level: 'info', event: 'lockdown.set' }, RETENTION_DONE, RETENTION_DONE]);
  });

  it('/unlock clears the switch and says so; again, that it was off', async () => {
    const harness = botHarness();
    await harness.send(privateMessage(IDS.keyholder, '/lockdown'));
    await harness.send(privateMessage(IDS.keyholder, '/unlock', { languageCode: 'fa' }));
    await harness.send(privateMessage(IDS.keyholder, '/unlock'));
    expect(await harness.db.first(LOCKDOWN_ROW)).toBeNull();
    expect(await isLockedDown(harness.config, harness.db)).toBe(false);
    expect(harness.textsTo(IDS.keyholder)).toEqual([
      t('en', 'lockdown.on'),
      t('fa', 'lockdown.off'),
      t('en', 'lockdown.was_off'),
    ]);
    expect(harness.log.records()).toEqual([
      { level: 'info', event: 'lockdown.set' },
      RETENTION_DONE,
      { level: 'info', event: 'lockdown.cleared' },
    ]);
  });

  it('/unlock says the LOCKDOWN override still holds the bot locked', async () => {
    const harness = botHarness({ variables: { LOCKDOWN: '1' } });
    await harness.send(privateMessage(IDS.keyholder, '/unlock'));
    expect(harness.textsTo(IDS.keyholder)).toEqual([`${t('en', 'lockdown.was_off')}\n\n${t('en', 'lockdown.override_on')}`]);
    expect(await isLockedDown(harness.config, harness.db)).toBe(true);
  });

  it('work under lockdown, the override included', async () => {
    const harness = botHarness({ variables: { LOCKDOWN: '1' } });
    await harness.send(privateMessage(IDS.keyholder, '/lockdown'));
    expect(harness.textsTo(IDS.keyholder)).toEqual([t('en', 'lockdown.on')]);
  });
});

describe('the commands store nothing about the sender but the /language choice', () => {
  it('leave every table but meta and the drafts as empty as it was, and a draft holds the locale only, by reference', async () => {
    const harness = botHarness();
    for (const text of ['/start', '/language fa', '/lockdown', '/unlock', '/nosuchcommand']) {
      await harness.send(privateMessage(IDS.reporter, text));
      await harness.send(privateMessage(IDS.keyholder, text));
    }
    const keys = await Promise.all([IDS.reporter, IDS.keyholder].map((id) => reporterRef(id, harness.config.reporterRefKey)));
    expect(await harness.db.all(sql`SELECT draft_key, step, url, platform, account_url, category, affected_person, comment, locale FROM drafts ORDER BY draft_key`)).toEqual(
      keys.sort().map((draft_key) => ({
        draft_key,
        step: 'url',
        url: null,
        platform: null,
        account_url: null,
        category: null,
        affected_person: null,
        comment: null,
        locale: 'fa',
      })),
    );
    const rows = await harness.db.first(
      sql`SELECT (SELECT count(*) FROM reports) AS reports, (SELECT count(*) FROM approvals) AS approvals, (SELECT count(*) FROM admin_prompts) AS admin_prompts, (SELECT count(*) FROM reporter_stats) AS reporter_stats, (SELECT count(*) FROM counters) AS counters, (SELECT count(*) FROM stats) AS stats, (SELECT count(*) FROM jobs) AS jobs`,
    );
    expect(rows).toEqual({
      reports: 0,
      approvals: 0,
      admin_prompts: 0,
      reporter_stats: 0,
      counters: 0,
      stats: 0,
      jobs: 0,
    });
    expect(await harness.db.all(sql`SELECT key FROM meta ORDER BY key`)).toEqual([{ key: 'schema_version' }]);
  });
});

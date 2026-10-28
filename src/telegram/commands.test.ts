// Unit tests for the commands of this unit (src/telegram/commands.ts),
// through the bot as the Worker composes it (test/support/bot-harness.ts):
// /start and /language in private chats only and in the reader's locale,
// the keyholder's confirmation, /lockdown and /unlock for keyholders in
// their own chat only, and the neutral answer under lockdown. The
// lockdown's catastrophic cases (who may clear it, what nothing clears) are
// test/invariants/lockdown.test.ts.
import { describe, expect, it } from 'vitest';
import { botHarness, NOW } from '../../test/support/bot-harness';
import { IDS } from '../../test/support/config';
import { groupMessage, privateMessage } from '../../test/support/updates';
import { isLockedDown, setLockdown } from '../auth/lockdown';
import { sql } from '../db/sql';
import { t } from '../i18n/index';

const LOCKDOWN_ROW = sql`SELECT value FROM meta WHERE key = 'lockdown'`;

describe('/start', () => {
  it("explains the bot in the reader's locale", async () => {
    const harness = botHarness();
    await harness.send(privateMessage(IDS.reporter, '/start', { languageCode: 'fa-IR' }));
    await harness.send(privateMessage(IDS.stranger, '/start', { languageCode: 'de' }));
    expect(harness.textsTo(IDS.reporter)).toEqual([t('fa', 'start.intro')]);
    expect(harness.textsTo(IDS.stranger)).toEqual([t('en', 'start.intro')]);
  });

  it("says the reporter's messages are deleted and outcomes appear in the channel", () => {
    expect(t('en', 'start.intro')).toMatch(/delete your messages/);
    expect(t('en', 'start.intro')).toMatch(/posted in the channel/);
    expect(t('en', 'start.intro')).toMatch(/no message about the decision/);
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

  it('answers the neutral text under lockdown', async () => {
    const harness = botHarness({ variables: { LOCKDOWN: '1' } });
    await harness.send(privateMessage(IDS.reporter, '/language fa'));
    expect(harness.textsTo(IDS.reporter)).toEqual([t('en', 'lockdown.unavailable')]);
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
    expect(harness.log.records()).toEqual([{ level: 'info', event: 'lockdown.set' }]);
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

describe('the commands store nothing about the sender', () => {
  it('leaves every table but meta as empty as it was', async () => {
    const harness = botHarness();
    for (const text of ['/start', '/language fa', '/lockdown', '/unlock', '/nosuchcommand']) {
      await harness.send(privateMessage(IDS.reporter, text));
      await harness.send(privateMessage(IDS.keyholder, text));
    }
    const rows = await harness.db.first(
      sql`SELECT (SELECT count(*) FROM drafts) AS drafts, (SELECT count(*) FROM reports) AS reports, (SELECT count(*) FROM approvals) AS approvals, (SELECT count(*) FROM admin_prompts) AS admin_prompts, (SELECT count(*) FROM reporter_stats) AS reporter_stats, (SELECT count(*) FROM counters) AS counters, (SELECT count(*) FROM stats) AS stats, (SELECT count(*) FROM jobs) AS jobs`,
    );
    expect(rows).toEqual({
      drafts: 0,
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

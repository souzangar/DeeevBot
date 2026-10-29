// Always-run invariant spec, critical invariant 2: while the lockdown
// switch is set, by a keyholder's command (`meta.lockdown`) or by the
// deployment's override (the LOCKDOWN secret), no admin action, intake,
// press or post is performed and alerts go to the keyholders; and nobody
// but a keyholder can lift it.
// - Under either layer: an admin command, registered behind the gates the
//   later units register theirs behind, is refused and does not run; an
//   admin button is refused; a press writes nothing; the intake entry
//   stores nothing and answers the neutral text, for a message and for an
//   intake button press alike, and deletes nothing; the venue gets no alert.
// - Only a keyholder's /unlock, typed in their own private chat, clears
//   `meta.lockdown`: from an admin, a reporter, anyone, from the venue, a
//   group, or forwarded, it clears nothing; and in the source, clearLockdown
//   has one caller (the /unlock handler) and one file writes the switch's
//   row (src/auth/lockdown.ts).
// - Nothing clears the override: /unlock under LOCKDOWN leaves the bot
//   locked, and the configuration that holds it is frozen.
// - /lockdown from anyone but a keyholder is not a command: the answer is
//   byte-for-byte the answer to a command that does not exist, locked or
//   not (outside lockdown each is deleted on receipt alike, only the
//   deleted message's own id differing), so nothing hints that it exists.
// - Under lockdown nothing is deleted either: no message, /start or
//   /language, nor an intake press, which answers the neutral text.
// The commit gate runs this file on every commit (`npm run test:invariants`).
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Composer, type Context } from 'grammy';
import type { Update } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import { isLockedDown, setLockdown } from '../../src/auth/lockdown';
import type { Config } from '../../src/config/schema';
import { sql, type SqlDb } from '../../src/db/sql';
import { t } from '../../src/i18n/index';
import { alertVenue } from '../../src/telegram/alerts';
import { createBotApi } from '../../src/telegram/api';
import { adminButton, isAdminCommand, refuseUnderLockdown } from '../../src/telegram/guards';
import { reporterRef } from '../../src/privacy/reporter-ref';
import { pressData } from '../../src/review/intake';
import { markData } from '../../src/telegram/presses';
import { botHarness, NOW, type BotHarness } from '../support/bot-harness';
import { IDS } from '../support/variables';
import { buttonPress, groupMessage, privateMessage } from '../support/updates';

const REPORTED_URL = 'https://www.instagram.com/reported.account/';
const REPORT_ID = 'qwertyuiopasdfghjklz';
const LOCKDOWN_ROW = sql`SELECT count(*) AS rows FROM meta WHERE key = 'lockdown'`;
const STORED = sql`SELECT (SELECT count(*) FROM drafts) AS drafts, (SELECT count(*) FROM reporter_stats) AS reporter_stats, (SELECT count(*) FROM counters) AS counters, (SELECT presses FROM reports WHERE id = 'qwertyuiopasdfghjklz') AS presses`;

/** The bot, with an admin command and an admin button in createBot()'s slot for the later units' composers. */
const lockedHarness = async (layer: 'switch' | 'override'): Promise<{ harness: BotHarness; ran: string[] }> => {
  const ran: string[] = [];
  const adminFeatures = (deps: { readonly config: Config; readonly db: SqlDb }) => {
    const composer = new Composer<Context>();
    composer.filter(isAdminCommand(deps.config)).command('halt', refuseUnderLockdown(deps), () => {
      ran.push('admin command');
    });
    composer.callbackQuery(/^card:/, adminButton(deps), () => {
      ran.push('admin button');
    });
    return [composer];
  };
  const harness = botHarness({ ...(layer === 'override' ? { variables: { LOCKDOWN: '1' } } : {}), features: adminFeatures });
  await harness.db.run(
    sql`INSERT INTO reports (id, status, platform, category, created_at, posting_started_at, posted_at, post_message_id) VALUES (?, 'posted', 'instagram', 'harassment', ?, ?, ?, 5)`,
    [REPORT_ID, NOW - 3_000, NOW - 2_000, NOW - 1_000],
  );
  if (layer === 'switch') await setLockdown(harness.db, harness.clock);
  return { harness, ran };
};

describe.each(['switch', 'override'] as const)('critical invariant 2: under the lockdown %s', (layer) => {
  it('an admin command is refused and does not run', async () => {
    const { harness, ran } = await lockedHarness(layer);
    await harness.send(privateMessage(IDS.admin, '/halt'));
    await harness.send(groupMessage(IDS.adminChat, IDS.secondAdmin, '/halt'));
    expect(ran).toEqual([]);
    expect(harness.textsTo(IDS.admin)).toEqual([t('en', 'admin.refused')]);
    expect(harness.textsTo(IDS.adminChat)).toEqual([t('en', 'admin.refused')]);
  });

  it('an admin button is refused and does not run', async () => {
    const { harness, ran } = await lockedHarness(layer);
    await harness.send(buttonPress(IDS.admin, 'card:approve', { chatId: IDS.adminChat, messageId: 7, chatType: 'supergroup' }));
    expect(ran).toEqual([]);
    expect(harness.telegram.callsOf('answerCallbackQuery').map((call) => call.payload.text)).toEqual([t('en', 'admin.refused')]);
  });

  it('a press writes nothing', async () => {
    const { harness } = await lockedHarness(layer);
    await harness.send(buttonPress(IDS.reporter, markData(REPORT_ID), { chatId: IDS.broadcastChannel, messageId: 5 }));
    expect(await harness.db.first(STORED)).toEqual({ drafts: 0, reporter_stats: 0, counters: 0, presses: 0 });
  });

  it('the intake entry stores nothing and answers the neutral text', async () => {
    const { harness } = await lockedHarness(layer);
    await harness.send(privateMessage(IDS.reporter, REPORTED_URL));
    await harness.send(privateMessage(IDS.stranger, REPORTED_URL, { languageCode: 'fa' }));
    expect(harness.textsTo(IDS.reporter)).toEqual([t('en', 'lockdown.unavailable')]);
    expect(harness.textsTo(IDS.stranger)).toEqual([t('fa', 'lockdown.unavailable')]);
    expect(harness.telegram.count('deleteMessage')).toBe(0);
    expect(await harness.db.first(STORED)).toEqual({ drafts: 0, reporter_stats: 0, counters: 0, presses: 0 });
  });

  it('an intake press stores nothing, deletes nothing and answers the neutral text', async () => {
    const { harness } = await lockedHarness(layer);
    const key = await reporterRef(IDS.reporter, harness.config.reporterRefKey);
    await harness.db.run(
      sql`INSERT INTO drafts (draft_key, step, url, platform, account_url, locale, created_at, updated_at) VALUES (?, 'category', 'https://x.com/someone/status/1', 'x', 'https://x.com/someone', 'en', 1, 1)`,
      [key],
    );
    await harness.send(buttonPress(IDS.reporter, pressData({ kind: 'category', category: 'other' }), { chatId: IDS.reporter, messageId: 4, chatType: 'private' }));
    expect(harness.telegram.calls.map((call) => [call.method, call.payload.text])).toEqual([['answerCallbackQuery', t('en', 'lockdown.unavailable')]]);
    expect(await harness.db.all(sql`SELECT step, category, updated_at FROM drafts`)).toEqual([{ step: 'category', category: null, updated_at: 1 }]);
  });

  it('deletes nothing: no message, /start or /language', async () => {
    const { harness } = await lockedHarness(layer);
    for (const text of [REPORTED_URL, '/start', '/language fa', '/nosuchcommand', '/cancel']) {
      await harness.send(privateMessage(IDS.reporter, text));
    }
    expect(harness.telegram.count('deleteMessage')).toBe(0);
    expect(harness.textsTo(IDS.reporter)).toEqual(Array.from({ length: 5 }, () => t('en', 'lockdown.unavailable')));
    expect(await harness.db.first(STORED)).toEqual({ drafts: 0, reporter_stats: 0, counters: 0, presses: 0 });
  });

  it('the venue gets no alert', async () => {
    const { harness } = await lockedHarness(layer);
    const deps = { api: createBotApi(harness.config, harness.telegram.fetch), config: harness.config, logger: harness.log.logger, db: harness.db };
    expect((await alertVenue(deps, 'an alert')).suppressed).toBe(true);
    expect(harness.telegram.count('sendMessage')).toBe(0);
  });
});

describe('critical invariant 2: only a keyholder lifts the lockdown switch', () => {
  const NOT_A_KEYHOLDERS_UNLOCK: readonly (readonly [string, Update])[] = [
    ['an admin, in their own chat', privateMessage(IDS.admin, '/unlock')],
    ['the other admin, in the venue', groupMessage(IDS.adminChat, IDS.secondAdmin, '/unlock')],
    ['a reporter', privateMessage(IDS.reporter, '/unlock')],
    ['a stranger', privateMessage(IDS.stranger, '/unlock')],
    ['a keyholder, in the venue', groupMessage(IDS.adminChat, IDS.keyholder, '/unlock')],
    ['a keyholder, in the membership group', groupMessage(IDS.membershipChat, IDS.keyholder, '/unlock@div_report_test_bot')],
    ['a keyholder, forwarding it', privateMessage(IDS.keyholder, '/unlock', { forwarded: true })],
    ['an admin, with /resume', privateMessage(IDS.admin, '/resume')],
  ];

  it.each(NOT_A_KEYHOLDERS_UNLOCK)('%s: the switch stays set', async (_label, update) => {
    const harness = botHarness();
    await setLockdown(harness.db, harness.clock);
    await harness.send(update);
    expect(await harness.db.first(LOCKDOWN_ROW)).toEqual({ rows: 1 });
    expect(await isLockedDown(harness.config, harness.db)).toBe(true);
  });

  it("a keyholder's /unlock in their own chat clears it", async () => {
    const harness = botHarness();
    await setLockdown(harness.db, harness.clock);
    await harness.send(privateMessage(IDS.secondKeyholder, '/unlock'));
    expect(await harness.db.first(LOCKDOWN_ROW)).toEqual({ rows: 0 });
  });

  // `.href`: the Workers and Node type packages both declare URL.
  const SRC = fileURLToPath(new URL('../../src', import.meta.url).href);
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sources(path);
      return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
    });
  const code = (path: string): string =>
    readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('has one caller of clearLockdown in the source, the /unlock handler', () => {
    const callers = sources(SRC)
      .filter((path) => /\bclearLockdown\(/.test(code(path).replace(/export async function clearLockdown\(/, '')))
      .map((path) => relative(SRC, path));
    expect(callers).toEqual(['telegram/commands.ts']);
    expect(code(join(SRC, 'telegram/commands.ts'))).toMatch(/keyholder\.command\('unlock'[\s\S]*clearLockdown\(/);
  });

  it("has one file that writes the switch's row", () => {
    const META_WRITE = /\b(?:DELETE\s+FROM|UPDATE|INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO)\s+meta\b[^`]*'lockdown'/i;
    const writers = sources(SRC)
      .filter((path) => META_WRITE.test(code(path)))
      .map((path) => relative(SRC, path));
    expect(writers).toEqual(['auth/lockdown.ts']);
  });
});

describe('critical invariant 2: nothing clears the LOCKDOWN override', () => {
  it("a keyholder's /unlock leaves the bot locked, and says so", async () => {
    const harness = botHarness({ variables: { LOCKDOWN: '1' } });
    await harness.send(privateMessage(IDS.keyholder, '/lockdown'));
    await harness.send(privateMessage(IDS.keyholder, '/unlock'));
    expect(await isLockedDown(harness.config, harness.db)).toBe(true);
    expect(harness.textsTo(IDS.keyholder).at(-1)).toContain(t('en', 'lockdown.override_on'));
  });

  it('the configuration holding it is frozen', () => {
    const { config } = botHarness({ variables: { LOCKDOWN: '1' } });
    expect(Object.isFrozen(config)).toBe(true);
    expect(() => {
      (config as { lockdown: boolean }).lockdown = false;
    }).toThrow(TypeError);
    expect(config.lockdown).toBe(true);
  });
});

describe('critical invariant 2: /lockdown hints nothing to anyone but a keyholder', () => {
  it.each([
    ['with the lockdown off', false],
    ['under the lockdown', true],
  ])('%s, /lockdown and /unlock get the answer a command that does not exist gets', async (_label, locked) => {
    const harness = botHarness();
    if (locked) await setLockdown(harness.db, harness.clock);
    for (const id of [IDS.admin, IDS.reporter, IDS.stranger]) {
      const answers: string[] = [];
      for (const text of ['/lockdown', '/unlock', '/nosuchcommand']) {
        const update = privateMessage(id, text);
        const before = harness.telegram.calls.length;
        await harness.send(update);
        // Outside lockdown each is deleted on receipt, as every message is: the
        // deletion names the message's own id, the one thing that may differ.
        const calls = harness.telegram.calls.slice(before).map((call) => {
          if (call.method !== 'deleteMessage') return [call.method, call.chatId, call.payload];
          expect(call.payload.message_id).toBe(update.message?.message_id);
          return [call.method, call.chatId, { ...call.payload, message_id: 'its own' }];
        });
        answers.push(JSON.stringify(calls));
      }
      expect(new Set(answers).size).toBe(1);
      expect((JSON.parse(answers[0] ?? '[]') as unknown[]).length).toBe(locked ? 1 : 2);
    }
    expect(await harness.db.first(LOCKDOWN_ROW)).toEqual({ rows: locked ? 1 : 0 });
  });
});

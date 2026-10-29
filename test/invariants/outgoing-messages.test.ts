// Always-run invariant spec, critical invariants 4 and 5, for every handler
// the bot has. The composed bot (src/telegram/bot.ts) is driven with a
// battery of updates (every role, every chat, commands, texts carrying a
// reported URL, presses), with the lockdown off, switched on and overridden,
// and with every reply failing; each call the fake Bot API records is then
// checked:
// - rule 4: every sendMessage and editMessageText leaves with
//   `link_preview_options` exactly `{ is_disabled: true }` and `parse_mode`
//   'HTML'; nothing is forwarded, copied, downloaded or looked up
//   (forwardMessage, copyMessage, getFile, getChat), and no request goes to
//   any host but the Bot API's, so a reported URL is never fetched; the bot
//   has no inline-mode or Mini App handler (a source scan);
// - rule 5: a message goes only to the chat of the update being handled
//   (the sender's own private chat, or the venue for a venue message), and
//   nothing at all is sent for a press, a group or the channel; an alert
//   goes only to the keyholders, and to the venue when not locked down;
//   there is no subscription command.
// The commit gate runs this file on every commit (`npm run test:invariants`).
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Update } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import { setLockdown } from '../../src/auth/lockdown';
import { sql } from '../../src/db/sql';
import { alertKeyholders, alertVenue } from '../../src/telegram/alerts';
import { createBotApi } from '../../src/telegram/api';
import { markData } from '../../src/telegram/presses';
import { FAILURES, type RecordedCall } from '../fakes/bot-api';
import { botHarness, NOW, type BotHarness } from '../support/bot-harness';
import { IDS } from '../support/variables';
import {
  buttonPress,
  channelPost,
  editedPrivateMessage,
  groupMessage,
  privateMessage,
  privatePhoto,
} from '../support/updates';

const REPORTED_URL = 'https://www.instagram.com/reported.account/';
const PEOPLE = [IDS.reporter, IDS.stranger, IDS.admin, IDS.keyholder] as const;
const TEXTS = ['/start', '/language fa', '/lockdown', '/unlock', '/subscribe', '/nosuchcommand', REPORTED_URL, `see ${REPORTED_URL} now`];
const REPORT_ID = 'abcdefghijklmnopqrst';

/** Where an update may be answered by a message: its own private chat, the venue, or nowhere. */
const replyChatOf = (update: Update): number | undefined => {
  const chat = update.message?.chat;
  if (chat === undefined) return undefined;
  if (chat.type === 'private') return chat.id;
  return chat.id === IDS.adminChat ? IDS.adminChat : undefined;
};

/** Every update of the battery. */
const battery = (): Update[] => [
  ...PEOPLE.flatMap((id) => [
    ...TEXTS.map((text) => privateMessage(id, text, { languageCode: id === IDS.stranger ? 'fa' : 'en' })),
    privateMessage(id, '/lockdown', { forwarded: true }),
    privatePhoto(id, REPORTED_URL),
    groupMessage(IDS.adminChat, id, '/start'),
    groupMessage(IDS.adminChat, id, REPORTED_URL),
    groupMessage(IDS.membershipChat, id, '/start@div_report_test_bot'),
    groupMessage(IDS.membershipChat, id, REPORTED_URL),
    groupMessage(IDS.strangerGroup, id, '/lockdown'),
    editedPrivateMessage(id, REPORTED_URL),
    buttonPress(id, markData(REPORT_ID), { chatId: IDS.broadcastChannel, messageId: 1 }),
    buttonPress(id, 'mark:forged', { chatId: IDS.broadcastChannel, messageId: 1 }),
    buttonPress(id, 'card:approve', { chatId: IDS.adminChat, messageId: 2, chatType: 'supergroup' }),
    buttonPress(id, 'notice:cancel', { chatId: id, messageId: 3, chatType: 'private' }),
  ]),
  channelPost(IDS.broadcastChannel, REPORTED_URL),
];

/** Runs the battery through `harness`, keeping each update's own calls. */
const drive = async (harness: BotHarness): Promise<{ update: Update; calls: RecordedCall[] }[]> => {
  await harness.db.run(
    // A posted report, so the presses are counted too.
    sql`INSERT INTO reports (id, status, platform, category, created_at, posting_started_at, posted_at, post_message_id) VALUES (?, 'posted', 'instagram', 'harassment', ?, ?, ?, 1)`,
    [REPORT_ID, NOW - 3_000, NOW - 2_000, NOW - 1_000],
  );
  const results: { update: Update; calls: RecordedCall[] }[] = [];
  for (const update of battery()) {
    const before = harness.telegram.calls.length;
    await harness.send(update);
    results.push({ update, calls: harness.telegram.calls.slice(before) });
  }
  return results;
};

const SCENARIOS: readonly (readonly [string, () => Promise<BotHarness>])[] = [
  ['with the lockdown off', () => Promise.resolve(botHarness())],
  [
    'under the lockdown switch',
    async () => {
      const harness = botHarness();
      await setLockdown(harness.db, harness.clock);
      return harness;
    },
  ],
  ['under the LOCKDOWN override', () => Promise.resolve(botHarness({ variables: { LOCKDOWN: '1' } }))],
  [
    'with every reply failing',
    () => {
      const harness = botHarness();
      harness.telegram.fail({ method: 'sendMessage' }, FAILURES.botBlocked);
      return Promise.resolve(harness);
    },
  ],
];

const FORBIDDEN_METHODS = ['forwardMessage', 'forwardMessages', 'copyMessage', 'copyMessages', 'getFile', 'getChat'];

describe.each(SCENARIOS)('critical invariants 4 and 5, %s', (_label, make) => {
  it('every send and edit has previews off and HTML parse mode', async () => {
    const harness = await make();
    const results = await drive(harness);
    const texts = harness.telegram.calls.filter((call) => ['sendMessage', 'editMessageText'].includes(call.method));
    expect(texts.length).toBeGreaterThan(0);
    for (const call of texts) {
      expect(call.payload.link_preview_options).toEqual({ is_disabled: true });
      expect(call.payload.parse_mode).toBe('HTML');
    }
    expect(results.length).toBe(battery().length);
  });

  it('a message goes only to the chat of the update being handled, and none for a press or a group', async () => {
    const harness = await make();
    for (const { update, calls } of await drive(harness)) {
      const allowed = replyChatOf(update);
      for (const call of calls.filter((recorded) => recorded.method !== 'answerCallbackQuery')) {
        expect(allowed, JSON.stringify(Object.keys(update))).toBeDefined();
        expect(call.chatId).toBe(allowed);
      }
      if (update.callback_query !== undefined) {
        expect(calls.map((call) => call.method)).toEqual(['answerCallbackQuery']);
      }
    }
    expect(harness.telegram.calls.filter((call) => call.chatId === IDS.broadcastChannel)).toEqual([]);
    expect(harness.telegram.calls.filter((call) => call.chatId === IDS.membershipChat)).toEqual([]);
  });

  it('nothing is forwarded, copied, downloaded or looked up, and no other host is called', async () => {
    const harness = await make();
    await drive(harness);
    for (const method of FORBIDDEN_METHODS) expect(harness.telegram.count(method), method).toBe(0);
    expect(harness.telegram.foreignRequests).toEqual([]);
  });
});

describe('critical invariant 5: alerts reach the keyholders, and the venue only when not locked down', () => {
  const deliver = async (harness: BotHarness) => {
    const deps = { api: createBotApi(harness.config, harness.telegram.fetch), config: harness.config, logger: harness.log.logger, db: harness.db };
    await alertKeyholders(deps, `An alert about <code>${REPORTED_URL}</code>`);
    await alertVenue(deps, `An alert about <code>${REPORTED_URL}</code>`);
    return harness.telegram.callsOf('sendMessage').map((call) => call.chatId);
  };

  it('never with a tappable link off the lists, to anyone: the alerts are the choke point (critical invariant 4)', async () => {
    const harness = botHarness();
    const deps = { api: createBotApi(harness.config, harness.telegram.fetch), config: harness.config, logger: harness.log.logger, db: harness.db };
    for (const text of [`An alert about ${REPORTED_URL}`, 'See <a href="https://evil.example/">this</a>', 'Mail someone@example.org now']) {
      await expect(alertKeyholders(deps, text), text).rejects.toMatchObject({ code: 'UNEXPECTED' });
      await expect(alertVenue(deps, text), text).rejects.toMatchObject({ code: 'UNEXPECTED' });
    }
    await expect(alertKeyholders(deps, 'An alert', { links: ['https://evil.example/path'] })).rejects.toMatchObject({ code: 'UNEXPECTED' });
    expect(harness.telegram.count('sendMessage')).toBe(0);
  });

  it('to every keyholder and the venue, with the lockdown off', async () => {
    expect(await deliver(botHarness())).toEqual([IDS.keyholder, IDS.secondKeyholder, IDS.adminChat]);
  });

  it('to the keyholders only under the switch or the override', async () => {
    const switched = botHarness();
    await setLockdown(switched.db, switched.clock);
    expect(await deliver(switched)).toEqual([IDS.keyholder, IDS.secondKeyholder]);
    expect(await deliver(botHarness({ variables: { LOCKDOWN: '1' } }))).toEqual([IDS.keyholder, IDS.secondKeyholder]);
  });
});

describe('critical invariants 4 and 5: the source holds no inline mode, no Mini App and no subscription', () => {
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
  const offenders = (pattern: RegExp): string[] =>
    sources(SRC)
      .filter((path) => pattern.test(code(path)))
      .map((path) => relative(SRC, path));

  it('registers no inline-query, chosen-result or Mini App handler, and opens no Mini App', () => {
    // The update kinds and button fields as written in code; the bot's own
    // identity, `supports_inline_queries: false` and `has_main_web_app:
    // false`, declares their absence and is not a match.
    const INLINE_OR_MINI_APP =
      /(?<![A-Za-z_])(?:inline_query|chosen_inline_result|web_app)(?![A-Za-z])|\b(?:inlineQuery|chosenInlineResult|answerInlineQuery|answerWebAppQuery|webApp)\b/;
    expect(offenders(INLINE_OR_MINI_APP)).toEqual([]);
    expect(INLINE_OR_MINI_APP.test("bot.on('inline_query', handler)")).toBe(true);
    expect(INLINE_OR_MINI_APP.test("{ text: 'Open', web_app: { url } }")).toBe(true);
    expect(INLINE_OR_MINI_APP.test('has_main_web_app: false, supports_inline_queries: false')).toBe(false);
  });

  it('registers no subscription command', () => {
    expect(offenders(/['"`/]subscribe\b|['"`/]unsubscribe\b/)).toEqual([]);
  });

  it('scans a source tree that is there', () => {
    expect(sources(SRC).map((path) => relative(SRC, path))).toContain('telegram/bot.ts');
  });
});

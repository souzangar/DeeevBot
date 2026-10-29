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
// - The REAL admin surface (src/telegram/review.ts through
//   src/telegram/registry.ts): under either layer every registered admin
//   command, every registered admin button prefix and the admin reply are
//   refused, in the venue's one language, and write nothing, while the keyholder's registered buttons
//   (Cancel and Lockdown on an approval notice) and commands (/open) keep
//   working; outside lockdown a press of every admin prefix by anyone but
//   an admin is refused and writes nothing; and the admin and keyholder
//   command names hint nothing in a private chat either. A source scan pins
//   that no command or button registration in src/review/ or src/telegram/
//   bypasses the surface, and that nothing anywhere in src/ registers a
//   handler (a command, a button, a hears, a chat filter, a middleware, a
//   Composer or a Bot) but the five registrars of src/telegram/: the scan
//   is probed with planted bypasses, which it must catch.
// - A keyholder's Lockdown, tapped on an approval's notice after the reply
//   passed the gates and before the approval's batch, leaves nothing
//   approved: the approval row binds the switch in its own statement, so
//   the batch writes nothing but the answered prompt's deletion, the
//   notices are edited to "cancelled", and the venue gets nothing more.
// - Both lockdown entry points, a keyholder's /lockdown and the notice's
//   Lockdown button, run the immediate retention pass, through the one
//   lockdownNow() (src/broadcast/maintenance.ts); in the source, setLockdown
//   has that one caller, so no other entry point can leave the pass unrun.
// - The scheduler's commands are on the real surface: under either layer an
//   admin's /attach, /repost, /halt and /resume are refused like every admin
//   command, while a keyholder's /attach and /halt keep working.
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
import { NOTICE_PREFIXES, noticeData, REVIEW_PREFIXES, reviewData, type ReviewAction, type ReviewActionKind } from '../../src/review/callbacks';
import { cancelledNoticeText } from '../../src/review/notify';
import { createPrompt } from '../../src/review/prompts';
import { markData } from '../../src/telegram/presses';
import { ADMIN_COMMANDS, KEYHOLDER_COMMANDS, reviewSurface } from '../../src/telegram/review';
import { botHarness, NOW, type BotHarness } from '../support/bot-harness';
import { reviewIn } from '../support/review-driver';
import { harnessOver, storeWith } from '../support/review-store';
import { insertApproval, insertReport, snapshot } from '../support/review-rows';
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

  it('has one caller of setLockdown in the source, lockdownNow, which both entry points call', () => {
    const callers = sources(SRC)
      .filter((path) => /\bsetLockdown\(/.test(code(path).replace(/export async function setLockdown\(/, '')))
      .map((path) => relative(SRC, path));
    expect(callers).toEqual(['broadcast/maintenance.ts']);
    expect(code(join(SRC, 'broadcast/maintenance.ts'))).toMatch(/export async function lockdownNow\([\s\S]*setLockdown\([\s\S]*retentionNow/);
    expect(code(join(SRC, 'telegram/commands.ts'))).toMatch(/keyholder\.command\('lockdown'[\s\S]*lockdownNow\(/);
    expect(code(join(SRC, 'telegram/review.ts'))).toMatch(/NOTICE_PREFIXES\.lockdown[\s\S]*lockdownNow\(/);
  });

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

/** The real surface's registrations, as the bot registers them (defaultFeatures(): the review). */
const registrationsOf = (harness: BotHarness) =>
  reviewSurface({ config: harness.config, db: harness.db, clock: harness.clock, logger: harness.log.logger }).registrations();

/** One press of every review action, on `reportId`'s card, its approval being `approvalId`. */
const everyAction = (reportId: string, approvalId: string): Record<ReviewActionKind, ReviewAction> => ({
  approve: { kind: 'approve', reportId },
  category: { kind: 'category', reportId, category: 'harassment' },
  mode: { kind: 'mode', reportId, category: 'harassment', mode: 'account' },
  reject: { kind: 'reject', reportId },
  reason: { kind: 'reason', reportId, reason: 'no_violation' },
  route: { kind: 'route', reportId },
  confirm_route: { kind: 'confirm_route', reportId },
  cancel: { kind: 'cancel', reportId, approvalId },
  block: { kind: 'block', reportId },
  back: { kind: 'back', reportId },
});

/** A pending report with its card (message 7) and an approved one with its card (8), its status card (9) and a notice. */
const seeded = async (harness: BotHarness) => {
  const pending = await insertReport(harness.db, { card_message_id: 7 });
  const approved = await insertReport(harness.db, { card_message_id: 8, status_message_id: 9 });
  const approvalId = await insertApproval(harness.db, approved, { approvedAt: NOW, startsAt: NOW + 60_000 });
  await harness.db.run(sql`UPDATE reports SET status = 'approved' WHERE id = ?`, [approved]);
  await createPrompt(harness.db, { chatId: IDS.adminChat, promptMessageId: 10, adminId: IDS.admin, reportId: pending, kind: 'recommended_comment', category: 'harassment', linkMode: 'account', createdAt: NOW });
  for (const id of [7, 8, 9, 10]) harness.telegram.seedMessage(IDS.adminChat, { message_id: id, text: 'a card' });
  harness.telegram.seedMessage(IDS.keyholder, { message_id: 1, text: 'a notice' });
  return { pending, approved, approvalId };
};

describe.each(['switch', 'override'] as const)('critical invariant 2: under the lockdown %s, the real admin surface', (layer) => {
  const locked = async () => {
    const harness = botHarness(layer === 'override' ? { variables: { LOCKDOWN: '1' } } : {});
    const rows = await seeded(harness);
    if (layer === 'switch') await setLockdown(harness.db, harness.clock);
    return { harness, ...rows };
  };

  it('refuses every registered admin command in the venue, and writes nothing', async () => {
    const { harness } = await locked();
    const { adminCommands } = registrationsOf(harness);
    expect(adminCommands).toEqual([...ADMIN_COMMANDS]);
    expect(adminCommands).toEqual(expect.arrayContaining(['attach', 'repost', 'halt', 'resume']));
    const before = await snapshot(harness.db);
    for (const name of adminCommands) {
      const from = harness.telegram.calls.length;
      await harness.send(groupMessage(IDS.adminChat, IDS.admin, `/${name} ${'ab'.repeat(32)}`));
      expect(harness.telegram.calls.slice(from).map((call) => [call.method, call.chatId, call.payload.text]), name).toEqual([
        ['sendMessage', IDS.adminChat, t(harness.config.venueLocale, 'admin.refused')],
      ]);
    }
    expect(await snapshot(harness.db)).toEqual(before);
  });

  it('refuses a press of every registered admin button prefix, and writes nothing', async () => {
    const { harness, pending, approved, approvalId } = await locked();
    const { adminButtons } = registrationsOf(harness);
    expect([...adminButtons].sort()).toEqual(Object.values(REVIEW_PREFIXES).sort());
    const before = await snapshot(harness.db);
    for (const [kind, action] of Object.entries({ ...everyAction(pending, approvalId), cancel: everyAction(approved, approvalId).cancel })) {
      const from = harness.telegram.calls.length;
      const card = action.reportId === approved ? 8 : 7;
      await harness.send(buttonPress(IDS.admin, reviewData(action), { chatId: IDS.adminChat, messageId: card, chatType: 'supergroup' }));
      expect(harness.telegram.calls.slice(from).map((call) => [call.method, call.payload.text]), kind).toEqual([['answerCallbackQuery', t(harness.config.venueLocale, 'admin.refused')]]);
    }
    expect(await snapshot(harness.db)).toEqual(before);
  });

  it("refuses an admin's reply to a prompt, and writes nothing", async () => {
    const { harness } = await locked();
    expect(registrationsOf(harness).adminReplies).toBe(1);
    const before = await snapshot(harness.db);
    await harness.send(groupMessage(IDS.adminChat, IDS.admin, 'Say it is harassment.', { replyToBot: 10 }));
    expect(harness.telegram.calls.map((call) => [call.method, call.chatId, call.payload.text])).toEqual([['sendMessage', IDS.adminChat, t(harness.config.venueLocale, 'admin.refused')]]);
    expect(await snapshot(harness.db)).toEqual(before);
  });

  it("keeps a keyholder's Cancel working: the approval voided, the job gone, nothing sent to the venue", async () => {
    const { harness, approved, approvalId } = await locked();
    const { keyholderButtons } = registrationsOf(harness);
    expect([...keyholderButtons].sort()).toEqual(Object.values(NOTICE_PREFIXES).sort());
    await harness.send(buttonPress(IDS.keyholder, noticeData({ kind: 'cancel', reportId: approved, approvalId }), { chatId: IDS.keyholder, messageId: 1, chatType: 'private' }));
    expect(await harness.db.first(sql`SELECT status FROM reports WHERE id = ?`, [approved])).toEqual({ status: 'pending' });
    expect(await harness.db.all(sql`SELECT voided_at FROM approvals`)).toEqual([{ voided_at: NOW }]);
    expect(harness.telegram.calls.filter((call) => call.chatId === IDS.adminChat)).toEqual([]);
    expect(harness.telegram.callsOf('answerCallbackQuery').map((call) => call.payload.text)).toEqual([t('en', 'review.answer.cancelled')]);
  });

  it("keeps a keyholder's Lockdown button and /open working", async () => {
    const { harness, pending } = await locked();
    const { keyholderCommands } = registrationsOf(harness);
    expect(keyholderCommands).toEqual([...KEYHOLDER_COMMANDS]);
    await harness.send(buttonPress(IDS.keyholder, noticeData({ kind: 'lockdown' }), { chatId: IDS.keyholder, messageId: 1, chatType: 'private' }));
    expect(await isLockedDown(harness.config, harness.db)).toBe(true);
    await harness.send(privateMessage(IDS.keyholder, '/open'));
    expect(harness.textsTo(IDS.keyholder).at(-1)).toContain(`<code>${pending}</code>`);
  });
});

describe('critical invariant 2: each lockdown entry point runs the immediate retention pass', () => {
  const spied = (variables: Readonly<Record<string, string>> = {}) => {
    const passes: number[] = [];
    const harness = botHarness({
      variables,
      retentionNow: (deps) => {
        passes.push(deps.clock.now());
        return Promise.resolve();
      },
    });
    return { harness, passes };
  };

  it("a keyholder's /lockdown: the switch set, then the pass, and again when it was set already", async () => {
    const { harness, passes } = spied();
    await harness.send(privateMessage(IDS.keyholder, '/lockdown'));
    expect(await isLockedDown(harness.config, harness.db)).toBe(true);
    expect(passes).toEqual([NOW]);
    await harness.send(privateMessage(IDS.secondKeyholder, '/lockdown'));
    expect(passes).toEqual([NOW, NOW]);
  });

  it("the Lockdown button of an approval notice, under the override too", async () => {
    for (const variables of [{}, { LOCKDOWN: '1' }]) {
      const { harness, passes } = spied(variables);
      harness.telegram.seedMessage(IDS.keyholder, { message_id: 1, text: 'a notice' });
      await harness.send(buttonPress(IDS.keyholder, noticeData({ kind: 'lockdown' }), { chatId: IDS.keyholder, messageId: 1, chatType: 'private' }));
      expect(await harness.db.first(LOCKDOWN_ROW)).toEqual({ rows: 1 });
      expect(passes).toEqual([NOW]);
    }
  });

  it('a pass that fails leaves the switch set, the failure logged by class', async () => {
    const harness = botHarness({ retentionNow: () => Promise.reject(new Error(`a pass over ${REPORTED_URL}`)) });
    await harness.send(privateMessage(IDS.keyholder, '/lockdown'));
    expect(await isLockedDown(harness.config, harness.db)).toBe(true);
    expect(harness.textsTo(IDS.keyholder)).toEqual([t('en', 'lockdown.on')]);
    expect(harness.log.records()).toEqual([
      { level: 'info', event: 'lockdown.set' },
      { level: 'error', event: 'retention.failed', errorClass: 'Error' },
    ]);
  });

  it("runs no pass for anyone else's /lockdown or Lockdown press", async () => {
    const { harness, passes } = spied();
    await harness.send(privateMessage(IDS.admin, '/lockdown'));
    await harness.send(groupMessage(IDS.adminChat, IDS.keyholder, '/lockdown'));
    await harness.send(buttonPress(IDS.admin, noticeData({ kind: 'lockdown' }), { chatId: IDS.admin, messageId: 1, chatType: 'private' }));
    expect(passes).toEqual([]);
    expect(await isLockedDown(harness.config, harness.db)).toBe(false);
  });
});

describe.each(['switch', 'override'] as const)("critical invariant 2: under the lockdown %s, the scheduler's keyholder commands", (layer) => {
  it("keep a keyholder's /halt and /attach working, in the keyholder's own chat", async () => {
    const harness = botHarness(layer === 'override' ? { variables: { LOCKDOWN: '1' } } : {});
    if (layer === 'switch') await setLockdown(harness.db, harness.clock);
    await harness.send(privateMessage(IDS.keyholder, '/halt'));
    expect(await harness.db.first(sql`SELECT count(*) AS n FROM meta WHERE key = 'halted'`)).toEqual({ n: 1 });
    await harness.send(privateMessage(IDS.secondKeyholder, `/attach ${REPORT_ID} 5`));
    expect(harness.textsTo(IDS.keyholder)).toEqual([t('en', 'halt.on')]);
    expect(harness.textsTo(IDS.secondKeyholder)).toEqual([t('en', 'attach.not_found')]);
    // Kept, as every keyholder command: the keyholder's chat is their operations log.
    expect(harness.telegram.count('deleteMessage')).toBe(0);
  });
});

describe("critical invariant 2: a Lockdown pressed while an approval's notices go out", () => {
  it('leaves nothing approved: no approval row, no job, the report pending, the notices cancelled, the venue untouched', async () => {
    const venueCalls: { from?: number } = {};
    const harness = harnessOver((db, self) =>
      storeWith(db, {
        batch: async (statements) => {
          // The notices are out, the approval not yet written: a keyholder taps the notice's Lockdown now.
          const [notice] = self().telegram.messagesIn(IDS.keyholder);
          await self().send(
            buttonPress(IDS.keyholder, noticeData({ kind: 'lockdown' }), { chatId: IDS.keyholder, messageId: notice?.message_id ?? 0, chatType: 'private' }),
          );
          venueCalls.from = self().telegram.calls.length;
          return db.batch(statements);
        },
      }),
    );
    const review = reviewIn(harness);
    const report = await review.submit({ url: 'https://x.com/someone/status/1234567890', category: 'harassment', affected: false, comment: 'a comment' });
    await review.press(IDS.admin, { kind: 'approve', reportId: report.reportId }, report.cardId);
    await review.press(IDS.admin, { kind: 'category', reportId: report.reportId, category: 'harassment' }, report.cardId);
    await review.press(IDS.admin, { kind: 'mode', reportId: report.reportId, category: 'harassment', mode: 'account' }, report.cardId);
    const before = await snapshot(harness.db);
    await review.reply(IDS.admin, review.lastPrompt()?.message_id ?? 0, 'Say it mocks a private person every day.');
    expect(venueCalls.from).toBeGreaterThan(0);
    expect(await isLockedDown(harness.config, harness.db)).toBe(true);
    expect(await harness.db.all(sql`SELECT * FROM approvals`)).toEqual([]);
    expect(await harness.db.all(sql`SELECT * FROM jobs`)).toEqual([]);
    expect(await harness.db.first(sql`SELECT status, broadcast_text, link_mode FROM reports WHERE id = ?`, [report.reportId])).toEqual({
      status: 'pending',
      broadcast_text: null,
      link_mode: null,
    });
    for (const keyholder of harness.config.keyholderIds) {
      const [notice] = harness.telegram.messagesIn(keyholder);
      expect(notice?.text, String(keyholder)).toBe(cancelledNoticeText(report.reportId));
      expect(notice?.reply_markup, String(keyholder)).toBeUndefined();
    }
    // The batch wrote nothing but the answered prompt's deletion; the switch is the Lockdown's own row.
    const after = await snapshot(harness.db);
    expect(after.admin_prompts).toEqual([]);
    expect({ ...after, admin_prompts: [], meta: [] }).toEqual({ ...before, admin_prompts: [], meta: [] });
    // The venue, compromised by assumption under lockdown, gets nothing after the Lockdown.
    expect(harness.telegram.calls.slice(venueCalls.from).filter((call) => call.chatId === IDS.adminChat)).toEqual([]);
  });
});

describe('critical invariant 2: the real admin buttons, pressed by anyone but an admin', () => {
  it('are refused, and write nothing', async () => {
    const harness = botHarness();
    const { pending, approved, approvalId } = await seeded(harness);
    const before = await snapshot(harness.db);
    for (const id of [IDS.reporter, IDS.stranger, IDS.keyholder, IDS.secondKeyholder]) {
      for (const action of [...Object.values(everyAction(pending, approvalId)), everyAction(approved, approvalId).cancel]) {
        const from = harness.telegram.calls.length;
        await harness.send(buttonPress(id, reviewData(action), { chatId: IDS.adminChat, messageId: 7, chatType: 'supergroup' }));
        expect(harness.telegram.calls.slice(from).map((call) => [call.method, call.payload.text])).toEqual([['answerCallbackQuery', t(harness.config.venueLocale, 'error.unauthorized')]]);
      }
    }
    // And an admin's press of a keyholder button is refused the same way.
    await harness.send(buttonPress(IDS.admin, noticeData({ kind: 'lockdown' }), { chatId: IDS.admin, messageId: 1, chatType: 'private' }));
    expect(await isLockedDown(harness.config, harness.db)).toBe(false);
    expect(await snapshot(harness.db)).toEqual(before);
  });
});

describe('critical invariant 2: the review commands hint nothing in a private chat', () => {
  it('answer an admin, a reporter and a stranger as a command that does not exist', async () => {
    const harness = botHarness();
    const names = [...new Set([...registrationsOf(harness).adminCommands, ...registrationsOf(harness).keyholderCommands])];
    for (const id of [IDS.admin, IDS.reporter, IDS.stranger]) {
      const answers = new Set<string>();
      for (const text of [...names.map((name) => `/${name}`), '/nosuchcommand']) {
        const update = privateMessage(id, text);
        const before = harness.telegram.calls.length;
        await harness.send(update);
        answers.add(
          JSON.stringify(
            harness.telegram.calls.slice(before).map((call) =>
              call.method === 'deleteMessage' ? [call.method, call.chatId, 'its own'] : [call.method, call.chatId, call.payload],
            ),
          ),
        );
      }
      expect(answers.size).toBe(1);
    }
  });
});

describe('critical invariant 2: no command or button registration bypasses the admin surface', () => {
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
  const scanned = [...sources(join(SRC, 'review')), ...sources(join(SRC, 'telegram'))];
  const using = (pattern: RegExp): string[] =>
    scanned.filter((path) => pattern.test(code(path))).map((path) => relative(SRC, path)).sort();

  it('registers commands only in the surface and in the keyholder and public commands of commands.ts', () => {
    expect(using(/\.command\(/)).toEqual(['telegram/commands.ts', 'telegram/registry.ts']);
    const names = [...code(join(SRC, 'telegram/commands.ts')).matchAll(/\.command\('([a-z_]+)'/g)].map((match) => match[1]).sort();
    expect(names).toEqual(['language', 'lockdown', 'start', 'unlock']);
  });

  it('registers buttons only in the surface, the intake, the presses and the fallback', () => {
    expect(using(/\.callbackQuery\(/)).toEqual(['telegram/registry.ts']);
    expect(using(/\.on\(\s*'callback_query/)).toEqual(['telegram/bot.ts', 'telegram/intake-entry.ts', 'telegram/presses.ts']);
    // The intake and the presses take their own prefixes only, and the fallback answers empty.
    expect(code(join(SRC, 'telegram/presses.ts'))).toMatch(/startsWith\(MARK_PREFIX\)/);
    expect(code(join(SRC, 'telegram/intake-entry.ts'))).toMatch(/startsWith\(INTAKE_PREFIX\)/);
  });

  it('registers no handler in src/review/: the flows run from the surface only', () => {
    const REGISTRATION = /\.(?:command|callbackQuery|hears|chatType|use)\(|\.on\(\s*['"]|new\s+(?:Composer|Bot)\b/;
    expect(scanned.filter((path) => relative(SRC, path).startsWith('review/') && REGISTRATION.test(code(path)))).toEqual([]);
    expect(REGISTRATION.test("composer.on('callback_query:data', handler)")).toBe(true);
    expect(REGISTRATION.test('const composer = new Composer<Context>();')).toBe(true);
    expect(REGISTRATION.test('rows.filter((row) => row.ok)')).toBe(false);
  });

  it('scans the trees that hold the handlers', () => {
    expect(scanned.map((path) => relative(SRC, path))).toEqual(expect.arrayContaining(['telegram/review.ts', 'telegram/registry.ts', 'review/approve.ts']));
  });

  // The only files that may register a handler: the bot's own chain, the
  // keyholder and public commands, the intake entry, the presses and the
  // admin surface. The one transformer's `api.config.use(` in api.ts
  // installs no handler and is the only registration-shaped call it may hold.
  const REGISTRARS: readonly string[] = ['telegram/bot.ts', 'telegram/commands.ts', 'telegram/intake-entry.ts', 'telegram/presses.ts', 'telegram/registry.ts'];
  const REGISTRATION = /\.(?:command|callbackQuery|hears|chatType|use)\(|\.on\(\s*['"]|new\s+(?:Composer|Bot)\b/;
  const bypasses = (files: readonly { readonly path: string; readonly code: string }[]): string[] =>
    files
      .filter(({ path, code: text }) => !REGISTRARS.includes(path) && REGISTRATION.test(path === 'telegram/api.ts' ? text.replace(/\bapi\.config\.use\(/g, '') : text))
      .map(({ path }) => path);
  const tree = (): { path: string; code: string }[] => sources(SRC).map((path) => ({ path: relative(SRC, path), code: code(path) }));

  it('registers handlers nowhere in src/ but the bot, the commands, the intake entry, the presses and the surface', () => {
    expect(bypasses(tree())).toEqual([]);
    // Every registrar registers something, so the list stays exact.
    for (const registrar of REGISTRARS) expect(REGISTRATION.test(code(join(SRC, registrar))), registrar).toBe(true);
  });

  it('fails the scan for a planted bypass, in a new file or beside the transformer', () => {
    const planted = tree()
      .map((file) => (file.path === 'telegram/api.ts' ? { ...file, code: `${file.code}\nbot.command('approve', approveEverything);` } : file))
      .concat([
        { path: 'telegram/shortcut.ts', code: "export const shortcut = (bot) => bot.on('message:text', approveEverything);" },
        { path: 'review/composer.ts', code: 'export const flows = new Composer();' },
        { path: 'worker-extra.ts', code: "bot.callbackQuery(/^rv:/, approveEverything);" },
      ]);
    expect(bypasses(planted).sort()).toEqual(['review/composer.ts', 'telegram/api.ts', 'telegram/shortcut.ts', 'worker-extra.ts']);
  });
});

// Unit tests for the intake conversation (src/telegram/intake.ts), driven
// through the composed bot over the fakes (test/support/bot-harness.ts,
// test/support/intake-driver.ts): the steps one by one (the URL, the
// account link or "I don't know", the category, the affected-person flag,
// the comment or /skip), the presses that edit their own prompt, the
// unexpected-step repeat, text-only intake with every reporter message
// deleted after the draft write and before the reply, the refusal of each
// link class, /cancel, the submit with its limits through the membership
// fake and its duplicate merge, the one acknowledgement that deletes itself
// at min(handlerStart + 25 s, ackSent + 20 s), and the hotline message.
import type { Update } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import { FAILURES, fakeBotApi } from '../../test/fakes/bot-api';
import { fakeClock } from '../../test/fakes/clock';
import { recordingLogger } from '../../test/fakes/logger';
import { botHarness, NOW, type BotHarness } from '../../test/support/bot-harness';
import { testConfig } from '../../test/support/config';
import { migratedDatabase } from '../../test/support/database';
import { report, reporterIn } from '../../test/support/intake-driver';
import { buttonPress, MEDIA_KINDS, privateMedia } from '../../test/support/updates';
import { IDS } from '../../test/support/variables';
import { createMembershipCache } from '../auth/membership';
import { setLockdown } from '../auth/lockdown';
import { sql } from '../db/sql';
import { t, type Locale, type PlainMessageKey } from '../i18n/index';
import { outgoingLinkProblems } from '../platforms/link-policy';
import { linkHash } from '../privacy/link-hash';
import { reporterRef } from '../privacy/reporter-ref';
import { readDraft } from '../review/drafts';
import { pressData, type IntakeStep } from '../review/intake';
import { botInfoFor, createBot } from './bot';

const X_POST = 'https://x.com/someone/status/1234567890?s=20';
const X_POST_NORMAL = 'https://x.com/someone/status/1234567890';
const X_ACCOUNT = 'https://x.com/someone';
const IG_POST = 'https://www.instagram.com/p/AbC123xyz/?igsh=tracking';
const IG_POST_NORMAL = 'https://www.instagram.com/p/AbC123xyz';
const COMMENT = 'they post threats about her every day';
const TODAY = '2027-01-15';

const PROMPT_KEYS = {
  url: 'intake.ask_url',
  account: 'intake.ask_account',
  category: 'intake.ask_category',
  affected: 'intake.ask_affected',
  comment: 'intake.ask_comment',
} as const;
const promptText = (step: IntakeStep, locale: Locale = 'en'): string => t(locale, PROMPT_KEYS[step]);
const after = (locale: Locale, lead: PlainMessageKey, step: IntakeStep): string => `${t(locale, lead)}\n\n${promptText(step, locale)}`;

const keyOf = (harness: BotHarness, id: number) => reporterRef(id, harness.config.reporterRefKey);
const draftOf = async (harness: BotHarness, id: number = IDS.reporter) => readDraft(harness.db, await keyOf(harness, id));
const reportRows = (harness: BotHarness) =>
  harness.db.all<Record<string, unknown>>(
    sql`SELECT id, status, platform, category, url, account_url, comment, affected_person, reporter_ref, merged_into, link_hash, created_at FROM reports ORDER BY created_at, status DESC`,
  );
const buttonsOf = (harness: BotHarness, chatId: number, messageId: number): string[] => {
  const markup = harness.telegram.messageIn(chatId, messageId)?.reply_markup as { inline_keyboard?: { callback_data: string }[][] } | undefined;
  return (markup?.inline_keyboard ?? []).flat().map((button) => button.callback_data);
};
const member = (harness: BotHarness, id: number = IDS.reporter): void => {
  harness.telegram.setMember(IDS.membershipChat, id, { status: 'member' });
};
const ackText = (platform: string, locale: Locale = 'en') => t(locale, 'intake.ack', { platform, date: TODAY });

describe('the intake conversation', () => {
  it('takes a post whose URL names its account straight to the category, then to one acknowledgement', async () => {
    const harness = botHarness();
    member(harness);
    const reporter = reporterIn(harness, IDS.reporter);
    await reporter.say(X_POST);
    expect(harness.textsTo(IDS.reporter)).toEqual([promptText('category')]);
    expect(await draftOf(harness)).toMatchObject({ step: 'category', url: X_POST_NORMAL, platform: 'x', accountUrl: X_ACCOUNT, locale: 'en' });
    const categoryPrompt = reporter.lastPrompt();
    expect(buttonsOf(harness, IDS.reporter, categoryPrompt?.message_id ?? 0)).toEqual([
      'intake:category:private_data',
      'intake:category:child_safety',
      'intake:category:csam',
      'intake:category:harassment',
      'intake:category:intimate_images',
      'intake:category:impersonation',
      'intake:category:other',
    ]);

    await reporter.press(pressData({ kind: 'category', category: 'harassment' }));
    expect(harness.telegram.messageIn(IDS.reporter, categoryPrompt?.message_id ?? 0)?.text).toBe(promptText('affected'));
    expect(buttonsOf(harness, IDS.reporter, categoryPrompt?.message_id ?? 0)).toEqual(['intake:affected:yes', 'intake:affected:no']);
    await reporter.press(pressData({ kind: 'affected', affected: false }));
    expect(harness.telegram.messageIn(IDS.reporter, categoryPrompt?.message_id ?? 0)?.text).toBe(promptText('comment'));
    expect(buttonsOf(harness, IDS.reporter, categoryPrompt?.message_id ?? 0)).toEqual([]);

    await reporter.say(COMMENT);
    expect(harness.textsTo(IDS.reporter)).toEqual([promptText('category'), ackText('X')]);
    const key = await keyOf(harness, IDS.reporter);
    const [row] = await reportRows(harness);
    expect(row).toMatchObject({
      status: 'pending',
      platform: 'x',
      category: 'harassment',
      url: X_POST_NORMAL,
      account_url: X_ACCOUNT,
      comment: COMMENT,
      affected_person: 0,
      reporter_ref: key,
      merged_into: null,
      link_hash: await linkHash(X_POST_NORMAL, harness.config.reporterRefKey),
      created_at: NOW,
    });
    expect(String(row?.id)).toMatch(/^[a-z]{20}$/);
    expect(await draftOf(harness)).toBeNull();
    for (const id of reporter.sent) expect(harness.telegram.messageIn(IDS.reporter, id), `message ${id}`).toBeUndefined();
    // The acknowledgement deleted itself: only the edited prompt is left in the chat.
    expect(harness.telegram.messagesIn(IDS.reporter).map((message) => message.message_id)).toEqual([categoryPrompt?.message_id]);
  });

  it('asks for the account link of a post that does not name it, and takes it on the same platform', async () => {
    const harness = botHarness();
    member(harness);
    const reporter = reporterIn(harness, IDS.reporter);
    await reporter.say(IG_POST);
    expect(harness.textsTo(IDS.reporter)).toEqual([promptText('account')]);
    expect(buttonsOf(harness, IDS.reporter, reporter.lastPrompt()?.message_id ?? 0)).toEqual(['intake:account:unknown']);
    await reporter.say('https://instagram.com/someone/?hl=en');
    expect(harness.textsTo(IDS.reporter).at(-1)).toBe(promptText('category'));
    expect(await draftOf(harness)).toMatchObject({ step: 'category', url: IG_POST_NORMAL, accountUrl: 'https://www.instagram.com/someone' });
  });

  it('refuses an account link of another platform, a post, or a refused link, and asks again', async () => {
    const harness = botHarness();
    const reporter = reporterIn(harness, IDS.reporter);
    await reporter.say(IG_POST);
    await reporter.say(X_ACCOUNT);
    await reporter.say('https://www.instagram.com/p/OtherPost123/');
    await reporter.say('https://bit.ly/abc');
    await reporter.say('not a link');
    expect(harness.textsTo(IDS.reporter).slice(1)).toEqual([
      after('en', 'intake.refused.account_link', 'account'),
      after('en', 'intake.refused.account_link', 'account'),
      after('en', 'intake.refused.redirector', 'account'),
      after('en', 'intake.refused.not_a_link', 'account'),
    ]);
    expect(await draftOf(harness)).toMatchObject({ step: 'account', accountUrl: null });
    for (const id of reporter.sent) expect(harness.telegram.messageIn(IDS.reporter, id)).toBeUndefined();
  });

  it('lets the reporter skip the account link with "I don\'t know", the prompt edited into the next', async () => {
    const harness = botHarness();
    member(harness);
    const reporter = reporterIn(harness, IDS.reporter);
    await report(reporter, { url: IG_POST, account: 'unknown', category: 'private_data', affected: true });
    const [row] = await reportRows(harness);
    expect(row).toMatchObject({ status: 'pending', url: IG_POST_NORMAL, account_url: null, category: 'private_data', affected_person: 1, comment: null });
    expect(harness.telegram.callsOf('editMessageText').map((call) => call.payload.text)).toEqual([
      promptText('category'),
      promptText('affected'),
      promptText('comment'),
    ]);
  });

  it('answers every press with answerCallbackQuery and an edit of the pressed prompt, never a new message', async () => {
    const harness = botHarness();
    const reporter = reporterIn(harness, IDS.reporter);
    await reporter.say(IG_POST);
    const prompt = reporter.lastPrompt()?.message_id;
    for (const data of [pressData({ kind: 'account_unknown' }), pressData({ kind: 'category', category: 'other' }), pressData({ kind: 'affected', affected: false })]) {
      const before = harness.telegram.calls.length;
      await reporter.press(data);
      const calls = harness.telegram.calls.slice(before);
      expect(calls.map((call) => call.method), data).toEqual(['answerCallbackQuery', 'editMessageText']);
      expect(calls[1]?.chatId).toBe(IDS.reporter);
      expect(calls[1]?.payload.message_id).toBe(prompt);
    }
  });

  it('submits without a comment on /skip', async () => {
    const harness = botHarness();
    member(harness);
    await report(reporterIn(harness, IDS.reporter), { url: X_POST, category: 'impersonation', affected: false });
    expect(await reportRows(harness)).toEqual([expect.objectContaining({ comment: null, category: 'impersonation' })]);
  });

  it('refuses a comment over 500 characters, deleting it, and takes a shorter one', async () => {
    const harness = botHarness();
    member(harness);
    const reporter = reporterIn(harness, IDS.reporter);
    await reporter.say(X_POST);
    await reporter.press(pressData({ kind: 'category', category: 'harassment' }));
    await reporter.press(pressData({ kind: 'affected', affected: false }));
    await reporter.say('x'.repeat(501));
    expect(harness.textsTo(IDS.reporter).at(-1)).toBe(after('en', 'intake.refused.comment_too_long', 'comment'));
    expect(await reportRows(harness)).toEqual([]);
    await reporter.say('y'.repeat(500));
    expect(await reportRows(harness)).toEqual([expect.objectContaining({ comment: 'y'.repeat(500) })]);
    for (const id of reporter.sent) expect(harness.telegram.messageIn(IDS.reporter, id)).toBeUndefined();
  });

  it('keeps the conversation in the reporter\'s resolved locale', async () => {
    const harness = botHarness();
    member(harness);
    const reporter = reporterIn(harness, IDS.reporter, { languageCode: 'fa-IR' });
    await report(reporter, { url: X_POST, category: 'other', affected: false, comment: 'یادداشت' });
    expect(harness.textsTo(IDS.reporter)).toEqual([promptText('category', 'fa'), ackText(t('fa', 'platform.x'), 'fa')]);
    expect(harness.telegram.callsOf('editMessageText').map((call) => call.payload.text)).toEqual([promptText('affected', 'fa'), promptText('comment', 'fa')]);
  });

  it('keeps the /language choice in the draft for the rest of the conversation', async () => {
    const harness = botHarness();
    const reporter = reporterIn(harness, IDS.reporter, { languageCode: 'en' });
    await reporter.say('/language fa');
    expect(await draftOf(harness)).toMatchObject({ step: 'url', locale: 'fa', url: null });
    await reporter.say(X_POST);
    expect(harness.textsTo(IDS.reporter)).toEqual([t('fa', 'language.set'), promptText('category', 'fa')]);
    expect(await draftOf(harness)).toMatchObject({ step: 'category', locale: 'fa' });
  });
});

describe('the acknowledgement', () => {
  it('names the report by platform and date, says outcomes appear in the channel, and echoes nothing', async () => {
    const harness = botHarness();
    member(harness);
    await report(reporterIn(harness, IDS.reporter, { username: 'reporter_handle', firstName: 'Reporter Name' }), {
      url: 'https://www.tiktok.com/@target.account/video/7234567890123456789',
      category: 'private_data',
      affected: false,
      comment: COMMENT,
    });
    const ack = harness.textsTo(IDS.reporter).at(-1) ?? '';
    expect(ack).toBe(ackText('TikTok'));
    expect(ack).toContain('TikTok');
    expect(ack).toContain(TODAY);
    expect(ack).toMatch(/outcomes appear in the channel/);
    const key = await keyOf(harness, IDS.reporter);
    for (const fragment of ['tiktok.com', 'target.account', '7234567890123456789', COMMENT, 'reporter_handle', 'Reporter Name', String(IDS.reporter), key, '://']) {
      expect(ack, fragment).not.toContain(fragment);
    }
  });

  it('is byte for byte the same for a new and a merged report of the same target', async () => {
    const harness = botHarness();
    member(harness, IDS.reporter);
    member(harness, IDS.stranger);
    await report(reporterIn(harness, IDS.reporter), { url: IG_POST, account: 'unknown', category: 'harassment', affected: false });
    await report(reporterIn(harness, IDS.stranger), {
      url: 'https://instagram.com/p/AbC123xyz?utm_source=ig_web',
      account: 'unknown',
      category: 'other',
      affected: true,
      comment: 'another view',
    });
    const rows = await reportRows(harness);
    expect(rows.map((row) => row.status)).toEqual(['pending', 'merged']);
    expect(rows[1]?.merged_into).toBe(rows[0]?.id);
    expect(harness.textsTo(IDS.reporter).at(-1)).toBe(harness.textsTo(IDS.stranger).at(-1));
  });

  it('deletes itself 20 seconds after it was sent, from inside the same handling', async () => {
    const harness = botHarness();
    member(harness);
    await report(reporterIn(harness, IDS.reporter), { url: X_POST, category: 'other', affected: false });
    expect(harness.clock.sleeps).toEqual([20_000]);
    const [lastDelete] = harness.telegram.callsOf('deleteMessage').slice(-1);
    expect(harness.telegram.calls.at(-1)).toBe(lastDelete);
    expect(harness.telegram.messagesIn(IDS.reporter).some((message) => message.text === ackText('X'))).toBe(false);
  });

  /** The conversation over a Bot API whose sends take 12 seconds each, to `slowChats` only when given. */
  const slowReport = async (slowChats?: readonly number[]) => {
    const config = testConfig();
    const clock = fakeClock(NOW);
    const telegram = fakeBotApi({ botInfo: botInfoFor(config), now: () => clock.now() });
    const { db } = migratedDatabase(clock);
    const slow: typeof fetch = async (input, init) => {
      const response = await telegram.fetch(input, init);
      const chatId = (JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { chat_id?: number }).chat_id;
      const isSend = String(input instanceof Request ? input.url : input).endsWith('/sendMessage');
      if (isSend && (slowChats === undefined || (chatId !== undefined && slowChats.includes(chatId)))) clock.advance(12_000);
      return response;
    };
    const bot = createBot({ config, db, clock, logger: recordingLogger().logger, fetch: slow, membershipCache: createMembershipCache() });
    telegram.setMember(IDS.membershipChat, IDS.reporter, { status: 'member' });
    await report(reporterIn({ telegram, send: (update: Update) => bot.handleUpdate(update) }, IDS.reporter), {
      url: X_POST,
      category: 'other',
      affected: false,
    });
    return { clock, telegram };
  };

  it('deletes itself 25 seconds after the handler started when the send itself was slow', async () => {
    // The handler started, the acknowledgement took 12 s: 25 s from the start is the earlier bound.
    const { clock } = await slowReport([IDS.reporter]);
    expect(clock.sleeps).toEqual([13_000]);
  });

  it('still deletes itself 25 seconds after the handler started when the review card was slow too', async () => {
    // The acknowledgement took 12 s, the card to the venue 12 s more: 1 s is left of the 25.
    const { clock, telegram } = await slowReport();
    expect(clock.sleeps).toEqual([1_000]);
    expect(telegram.callsOf('sendMessage').map((call) => call.chatId)).toEqual([IDS.reporter, IDS.reporter, IDS.adminChat]);
  });

  it('is followed, for a "sexual content involving a minor" label, by a persistent message with the hotline links and nothing else', async () => {
    const harness = botHarness();
    member(harness);
    const reporter = reporterIn(harness, IDS.reporter);
    await report(reporter, { url: X_POST, category: 'csam', affected: false });
    const texts = harness.textsTo(IDS.reporter);
    expect(texts.slice(-2)).toEqual([ackText('X'), t('en', 'intake.hotlines')]);
    const left = harness.telegram.messagesIn(IDS.reporter).map((message) => message.text);
    expect(left).toContain(t('en', 'intake.hotlines'));
    expect(left).not.toContain(ackText('X'));
    const hotlines = t('en', 'intake.hotlines');
    expect(outgoingLinkProblems(hotlines, [])).toEqual([]);
    expect(hotlines).not.toContain('x.com');
    expect(await reportRows(harness)).toEqual([expect.objectContaining({ category: 'csam', status: 'pending' })]);
  });

  it('is sent once, and a failed send of it is logged by class and stops nothing', async () => {
    const harness = botHarness();
    member(harness);
    const reporter = reporterIn(harness, IDS.reporter);
    await reporter.say(X_POST);
    await reporter.press(pressData({ kind: 'category', category: 'csam' }));
    await reporter.press(pressData({ kind: 'affected', affected: false }));
    harness.telegram.fail({ method: 'sendMessage' }, FAILURES.botBlocked, 1);
    await reporter.say('/skip');
    expect(await reportRows(harness)).toHaveLength(1);
    expect(harness.log.records()).toEqual([
      { level: 'error', event: 'reply.failed', errorClass: 'GrammyError', telegramErrorCode: 403, apiMethod: 'sendMessage' },
    ]);
    // The hotline message still went out; no acknowledgement was left to delete.
    expect(harness.textsTo(IDS.reporter).at(-1)).toBe(t('en', 'intake.hotlines'));
    expect(harness.clock.sleeps).toEqual([]);
  });

  it('logs a failed self-deletion by class, and takes a message already gone as deleted', async () => {
    const harness = botHarness();
    member(harness);
    const reporter = reporterIn(harness, IDS.reporter);
    await reporter.say(X_POST);
    await reporter.press(pressData({ kind: 'category', category: 'other' }));
    await reporter.press(pressData({ kind: 'affected', affected: false }));
    harness.telegram.fail({ method: 'deleteMessage' }, FAILURES.messageToDeleteNotFound, 1);
    harness.telegram.fail({ method: 'deleteMessage' }, FAILURES.serverError);
    const before = harness.telegram.count('deleteMessage');
    await reporter.say('/skip');
    // The reporter's /skip was already gone (no retry, no log); the acknowledgement's deletion failed.
    expect(harness.telegram.count('deleteMessage') - before).toBe(2);
    expect(harness.log.records()).toEqual([
      { level: 'error', event: 'intake.ack_not_deleted', errorClass: 'GrammyError', telegramErrorCode: 502, apiMethod: 'deleteMessage' },
    ]);
  });
});

describe('text-only intake', () => {
  it.each(MEDIA_KINDS)('refuses and deletes a %s at the URL step, and stores nothing', async (kind) => {
    const harness = botHarness();
    const reporter = reporterIn(harness, IDS.reporter);
    const update = await reporter.send(privateMedia(IDS.reporter, kind, X_POST));
    expect(harness.textsTo(IDS.reporter)).toEqual([after('en', 'intake.refused.media', 'url')]);
    expect(harness.telegram.messageIn(IDS.reporter, update.message?.message_id ?? 0)).toBeUndefined();
    expect(await draftOf(harness)).toBeNull();
  });

  it.each([
    ['a forward', { forwarded: true }],
    ['a message sent through an inline bot', { viaBot: true }],
    ['a reply quoting another chat', { externalReply: true }],
  ] as const)('refuses and deletes %s', async (_label, options) => {
    const harness = botHarness();
    const reporter = reporterIn(harness, IDS.reporter);
    await reporter.say(X_POST, options);
    expect(harness.textsTo(IDS.reporter)).toEqual([after('en', 'intake.refused.media', 'url')]);
    expect(harness.telegram.messagesIn(IDS.reporter)).toEqual([expect.objectContaining({ text: after('en', 'intake.refused.media', 'url') })]);
    expect(await draftOf(harness)).toBeNull();
  });

  it.each(['account', 'category', 'affected', 'comment'] as const)('refuses a photo and a forward at the %s step, repeating its prompt', async (step) => {
    const harness = botHarness();
    const reporter = reporterIn(harness, IDS.reporter);
    await reporter.say(IG_POST);
    if (step !== 'account') await reporter.press(pressData({ kind: 'account_unknown' }));
    if (step === 'affected' || step === 'comment') await reporter.press(pressData({ kind: 'category', category: 'harassment' }));
    if (step === 'comment') await reporter.press(pressData({ kind: 'affected', affected: false }));
    const before = await draftOf(harness);
    await reporter.send(privateMedia(IDS.reporter, 'photo', 'https://x.com/other'));
    await reporter.say('https://x.com/other', { forwarded: true });
    expect(harness.textsTo(IDS.reporter).slice(-2)).toEqual([after('en', 'intake.refused.media', step), after('en', 'intake.refused.media', step)]);
    expect(await draftOf(harness)).toEqual(before);
    for (const id of reporter.sent) expect(harness.telegram.messageIn(IDS.reporter, id)).toBeUndefined();
    if (step !== 'comment') expect(buttonsOf(harness, IDS.reporter, reporter.lastPrompt()?.message_id ?? 0).length).toBeGreaterThan(0);
  });

  it('repeats the prompt, with its buttons, for a text at a step a press answers', async () => {
    const harness = botHarness();
    const reporter = reporterIn(harness, IDS.reporter);
    await reporter.say(X_POST);
    await reporter.say('https://x.com/another/status/1');
    expect(harness.textsTo(IDS.reporter).at(-1)).toBe(after('en', 'intake.repeat', 'category'));
    expect(buttonsOf(harness, IDS.reporter, reporter.lastPrompt()?.message_id ?? 0)).toHaveLength(7);
    await reporter.press(pressData({ kind: 'category', category: 'harassment' }));
    await reporter.say('/skip');
    expect(harness.textsTo(IDS.reporter).at(-1)).toBe(after('en', 'intake.repeat', 'affected'));
    expect(await draftOf(harness)).toMatchObject({ step: 'affected', url: X_POST_NORMAL });
  });
});

describe('the URL step', () => {
  it.each([
    ['no link', 'hello there', 'intake.refused.not_a_link'],
    ['two links', 'https://x.com/a and https://x.com/b', 'intake.refused.one_link'],
    ['an http link', 'http://x.com/someone', 'intake.refused.link'],
    ['a raw IP', 'https://127.0.0.1/x', 'intake.refused.link'],
    ['a port', 'https://x.com:8443/someone', 'intake.refused.link'],
    ['userinfo', 'https://x.com@evil-site.com/someone', 'intake.refused.link'],
    ['a shortener', 'https://bit.ly/abc', 'intake.refused.redirector'],
    ["a platform's redirector", 'https://l.facebook.com/l.php?u=x', 'intake.refused.redirector'],
    ['a Telegram invite', 'https://t.me/+AbCdEfGh', 'intake.refused.telegram'],
    ['a bot start link', 'https://t.me/some_bot?start=x', 'intake.refused.telegram'],
    ['a Mini App link', 'https://t.me/some_bot/app', 'intake.refused.telegram'],
    ['a page that is no account or post', 'https://x.com/home', 'intake.refused.not_a_target'],
    ["a platform's domain that is no alias", 'https://business.facebook.com/x', 'intake.refused.link'],
  ] as const)('refuses %s, says why and deletes it', async (_label, text, key) => {
    const harness = botHarness();
    const reporter = reporterIn(harness, IDS.reporter);
    await reporter.say(text);
    expect(harness.textsTo(IDS.reporter)).toEqual([after('en', key, 'url')]);
    expect(await draftOf(harness)).toBeNull();
    expect(harness.telegram.messagesIn(IDS.reporter)).toHaveLength(1);
  });

  it('takes a link of some other site, asks for the account, and accepts any link of another site for it', async () => {
    const harness = botHarness();
    member(harness);
    const reporter = reporterIn(harness, IDS.reporter);
    await reporter.say('https://example-site.org/leak/page?id=4');
    expect(harness.textsTo(IDS.reporter)).toEqual([promptText('account')]);
    await reporter.say('https://example-site.org/users/someone');
    expect(await draftOf(harness)).toMatchObject({ platform: 'other', url: 'https://example-site.org/leak/page', accountUrl: 'https://example-site.org/users/someone' });
  });

  it('takes a Telegram post, its username and post number derivable, straight to the category', async () => {
    const harness = botHarness();
    const reporter = reporterIn(harness, IDS.reporter);
    await reporter.say('https://t.me/some_channel/42?single');
    expect(await draftOf(harness)).toMatchObject({ step: 'category', platform: 'telegram', url: 'https://t.me/some_channel/42', accountUrl: 'https://t.me/some_channel' });
  });
});

describe('a stale or foreign press', () => {
  it('is answered "already answered" and changes nothing', async () => {
    const harness = botHarness();
    const reporter = reporterIn(harness, IDS.reporter);
    await reporter.say(X_POST);
    await reporter.press(pressData({ kind: 'category', category: 'harassment' }));
    const prompt = reporter.lastPrompt()?.message_id ?? 0;
    const before = await draftOf(harness);
    for (const data of [pressData({ kind: 'category', category: 'other' }), pressData({ kind: 'account_unknown' }), 'intake:category:spam', 'intake:x']) {
      const calls = harness.telegram.calls.length;
      await harness.send(buttonPress(IDS.reporter, data, { chatId: IDS.reporter, messageId: prompt, chatType: 'private' }));
      expect(harness.telegram.calls.slice(calls).map((call) => [call.method, call.payload.text]), data).toEqual([
        ['answerCallbackQuery', t('en', 'intake.already_answered')],
      ]);
    }
    expect(await draftOf(harness)).toEqual(before);
  });

  it('with no draft is answered "already answered"', async () => {
    const harness = botHarness();
    await harness.send(buttonPress(IDS.reporter, pressData({ kind: 'affected', affected: true }), { chatId: IDS.reporter, messageId: 9, chatType: 'private' }));
    expect(harness.telegram.calls.map((call) => [call.method, call.payload.text])).toEqual([['answerCallbackQuery', t('en', 'intake.already_answered')]]);
  });

  it('on a message of another chat than the presser\'s own is answered empty and reads nothing', async () => {
    const harness = botHarness();
    await reporterIn(harness, IDS.reporter).say(X_POST);
    const before = await draftOf(harness);
    const calls = harness.telegram.calls.length;
    await harness.send(buttonPress(IDS.stranger, pressData({ kind: 'category', category: 'other' }), { chatId: IDS.reporter, messageId: 9, chatType: 'private' }));
    expect(harness.telegram.calls.slice(calls)).toEqual([
      { method: 'answerCallbackQuery', chatId: undefined, payload: { callback_query_id: expect.any(String) as string } },
    ]);
    expect(await draftOf(harness)).toEqual(before);
  });

  it('pressed twice at once moves the draft on once', async () => {
    const harness = botHarness();
    const reporter = reporterIn(harness, IDS.reporter);
    await reporter.say(X_POST);
    const prompt = reporter.lastPrompt()?.message_id ?? 0;
    await Promise.all(
      (['harassment', 'other'] as const).map((category) =>
        harness.send(buttonPress(IDS.reporter, pressData({ kind: 'category', category }), { chatId: IDS.reporter, messageId: prompt, chatType: 'private' })),
      ),
    );
    expect(harness.telegram.count('editMessageText')).toBe(1);
    expect(harness.telegram.callsOf('answerCallbackQuery').map((call) => call.payload.text)).toContain(t('en', 'intake.already_answered'));
    expect(await draftOf(harness)).toMatchObject({ step: 'affected' });
  });

  it('is answered with the neutral text under lockdown, the draft untouched', async () => {
    const harness = botHarness();
    const reporter = reporterIn(harness, IDS.reporter);
    await reporter.say(X_POST);
    const before = await draftOf(harness);
    await setLockdown(harness.db, harness.clock);
    const calls = harness.telegram.calls.length;
    await reporter.press(pressData({ kind: 'category', category: 'other' }));
    expect(harness.telegram.calls.slice(calls).map((call) => [call.method, call.payload.text])).toEqual([
      ['answerCallbackQuery', t('en', 'lockdown.unavailable')],
    ]);
    expect(await draftOf(harness)).toEqual(before);
  });
});

describe('/cancel and other commands', () => {
  it('/cancel deletes the draft at any step, then the message, then says so', async () => {
    const harness = botHarness();
    const reporter = reporterIn(harness, IDS.reporter);
    await reporter.say(IG_POST);
    await reporter.say('/cancel');
    expect(harness.textsTo(IDS.reporter).at(-1)).toBe(t('en', 'intake.cancelled'));
    expect(await draftOf(harness)).toBeNull();
    await reporter.say('/cancel');
    expect(harness.textsTo(IDS.reporter).at(-1)).toBe(t('en', 'intake.nothing_to_cancel'));
    for (const id of reporter.sent) expect(harness.telegram.messageIn(IDS.reporter, id)).toBeUndefined();
  });

  it('deletes a command it does not know, stores nothing, answers fallback.help', async () => {
    const harness = botHarness();
    const reporter = reporterIn(harness, IDS.reporter);
    await reporter.say(X_POST);
    const before = await draftOf(harness);
    const calls = harness.telegram.calls.length;
    const update = await reporter.say('/nosuchcommand https://www.instagram.com/p/x/');
    expect(harness.telegram.calls.slice(calls).map((call) => call.method)).toEqual(['deleteMessage', 'sendMessage']);
    expect(harness.textsTo(IDS.reporter).at(-1)).toBe(t('en', 'fallback.help'));
    expect(harness.telegram.messageIn(IDS.reporter, update.message?.message_id ?? 0)).toBeUndefined();
    expect(await draftOf(harness)).toEqual(before);
  });

  it('asks the reporter to delete a command it could not delete', async () => {
    const harness = botHarness();
    const reporter = reporterIn(harness, IDS.reporter);
    harness.telegram.fail({ method: 'deleteMessage' }, FAILURES.messageCantBeDeleted, 2);
    await reporter.say('/nosuchcommand evil-site.com/x');
    expect(harness.textsTo(IDS.reporter)).toEqual([`${t('en', 'fallback.help')}\n\n${t('en', 'intake.delete_yourself')}`]);
    expect(harness.log.records().map((record) => record.event)).toEqual(['intake.message_not_deleted']);
    expect(await draftOf(harness)).toBeNull();
  });

  it('answers a command it does not know in the /language choice', async () => {
    const harness = botHarness();
    const reporter = reporterIn(harness, IDS.reporter);
    await reporter.say('/language fa');
    await reporter.say('/nosuchcommand');
    expect(harness.textsTo(IDS.reporter).at(-1)).toBe(t('fa', 'fallback.help'));
    for (const id of reporter.sent) expect(harness.telegram.messageIn(IDS.reporter, id)).toBeUndefined();
  });
});

describe('the deletion of each reporter message', () => {
  it('comes after the draft write and before the reply', async () => {
    const config = testConfig();
    const clock = fakeClock(NOW);
    const telegram = fakeBotApi({ botInfo: botInfoFor(config), now: () => clock.now() });
    const { db, connection } = migratedDatabase(clock);
    const seen: string[] = [];
    const watching: typeof fetch = (input, init) => {
      const method = String(input instanceof Request ? input.url : input).split('/').at(-1) ?? '';
      const step = connection.prepare('SELECT step FROM drafts').all()[0]?.step;
      seen.push(`${method}:${String(step ?? 'none')}`);
      return telegram.fetch(input, init);
    };
    const bot = createBot({ config, db, clock, logger: recordingLogger().logger, fetch: watching, membershipCache: createMembershipCache() });
    const reporter = reporterIn({ telegram, send: (update: Update) => bot.handleUpdate(update) }, IDS.reporter);
    await reporter.say(IG_POST);
    await reporter.say('https://www.instagram.com/someone');
    expect(seen).toEqual(['deleteMessage:account', 'sendMessage:account', 'deleteMessage:category', 'sendMessage:category']);
  });

  it('is retried once, and when it still fails the reply asks the reporter to delete it, the failure logged by class', async () => {
    const harness = botHarness();
    const reporter = reporterIn(harness, IDS.reporter);
    harness.telegram.fail({ method: 'deleteMessage' }, FAILURES.messageCantBeDeleted, 2);
    await reporter.say(X_POST);
    expect(harness.telegram.count('deleteMessage')).toBe(2);
    expect(harness.textsTo(IDS.reporter)).toEqual([`${promptText('category')}\n\n${t('en', 'intake.delete_yourself')}`]);
    expect(harness.log.records()).toEqual([
      { level: 'error', event: 'intake.message_not_deleted', errorClass: 'GrammyError', telegramErrorCode: 400, apiMethod: 'deleteMessage' },
    ]);
  });

  it('succeeds on the retry without a note', async () => {
    const harness = botHarness();
    const reporter = reporterIn(harness, IDS.reporter);
    harness.telegram.fail({ method: 'deleteMessage' }, FAILURES.serverError, 1);
    await reporter.say(X_POST);
    expect(harness.telegram.count('deleteMessage')).toBe(2);
    expect(harness.textsTo(IDS.reporter)).toEqual([promptText('category')]);
    expect(harness.log.lines).toEqual([]);
    for (const id of reporter.sent) expect(harness.telegram.messageIn(IDS.reporter, id)).toBeUndefined();
  });

  it('happens even when the draft write fails, before the error boundary answers', async () => {
    const harness = botHarness();
    harness.connection.exec("CREATE TRIGGER refuse_drafts BEFORE INSERT ON drafts BEGIN SELECT RAISE(ABORT, 'refused'); END");
    const reporter = reporterIn(harness, IDS.reporter);
    await reporter.say(X_POST);
    expect(harness.telegram.calls.map((call) => call.method)).toEqual(['deleteMessage', 'sendMessage']);
    expect(harness.textsTo(IDS.reporter)).toEqual([t('en', 'error.unexpected')]);
    for (const id of reporter.sent) expect(harness.telegram.messageIn(IDS.reporter, id)).toBeUndefined();
    expect(harness.log.records()).toEqual([{ level: 'error', event: 'update.failed', errorClass: 'AppError', errorCode: 'STORAGE_FAILURE' }]);
  });
});

describe('the limits, through the membership fake', () => {
  const reportOnce = async (harness: BotHarness, id: number, url: string) => {
    await report(reporterIn(harness, id), { url, account: 'unknown', category: 'other', affected: false });
  };

  it('let a non-member report once a day, and answer the next one neutrally, deleting its draft', async () => {
    const harness = botHarness();
    await reportOnce(harness, IDS.reporter, X_POST);
    await reportOnce(harness, IDS.reporter, 'https://x.com/other/status/2');
    expect(harness.textsTo(IDS.reporter).at(-1)).toBe(t('en', 'error.rate_limited'));
    expect(await reportRows(harness)).toHaveLength(1);
    expect(await draftOf(harness)).toBeNull();
    // On the update's user id, in the membership chat; the answer is cached, never stored.
    expect(harness.telegram.callsOf('getChatMember').map((call) => [call.chatId, call.payload.user_id])).toEqual([
      [IDS.membershipChat, IDS.reporter],
    ]);
  });

  it('let a member report more than once a day', async () => {
    const harness = botHarness();
    member(harness);
    await reportOnce(harness, IDS.reporter, X_POST);
    await reportOnce(harness, IDS.reporter, 'https://x.com/other/status/2');
    expect((await reportRows(harness)).map((row) => row.status)).toEqual(['pending', 'pending']);
  });

  it('refuse a blocked reference with the same neutral answer', async () => {
    const harness = botHarness();
    member(harness);
    await harness.db.run(sql`INSERT INTO reporter_stats (reporter_ref, blocked, last_seen) VALUES (?, 1, ?)`, [await keyOf(harness, IDS.reporter), TODAY]);
    await reportOnce(harness, IDS.reporter, X_POST);
    expect(harness.textsTo(IDS.reporter).at(-1)).toBe(t('en', 'error.rate_limited'));
    expect(await reportRows(harness)).toEqual([]);
  });
});

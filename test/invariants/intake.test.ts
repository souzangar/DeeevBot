// Always-run invariant spec, critical invariants 3, 4, 5 and 8, for the
// intake (src/telegram/intake.ts, src/review/drafts.ts, the link policy of
// src/platforms/). A battery of whole conversations (every platform, the
// "sexual content involving a minor" label, the affected person, a merged
// duplicate, "I don't know", /cancel, an abandoned draft, a refused link of
// each class, media and forwards at every step) is driven through the
// composed bot over the fakes, then every recorded call and every stored
// value is checked:
// - rule 4: intake is text only, so no media, forward, inline-bot message
//   or external reply is ever stored, and each is deleted; nothing is
//   forwarded, copied, downloaded or looked up, and nothing but the Bot API
//   is called, so no reported URL is ever fetched; every send and edit has
//   previews off and HTML; every link the bot sends a reporter is on
//   TRUSTED_HELP_HOSTS, and so is every link of both catalogs;
// - rule 3: nothing the bot sends a reporter echoes a reported URL, an
//   account link, a comment, or anyone's id, username, name or reporter
//   reference; the acknowledgement is byte for byte the same for a new and
//   a merged report; the review card a submit posts to the admin review
//   venue carries no reporter's id, username or name (its reference, the
//   URLs and the comment as code text are what the admins review by);
// - rule 5: every message goes to the reporter's own chat but one, the
//   review card of a submitted pending report, which goes to the venue and
//   nowhere else, once per report (none for a merged duplicate); a press
//   causes no new message (its callback answer and an edit of its own
//   prompt only), every deletion is in the reporter's own chat, and
//   membership is looked up in the membership chat only, for the update's
//   own user;
// - rule 8: no table holds a plaintext Telegram id of a reporter, in any
//   column, as a number or a text; drafts and reports are keyed by the
//   reporter reference; a draft is gone after its submit and its /cancel;
//   outside lockdown every message the bot receives in a private chat is
//   deleted on receipt, whatever it is (an intake step, a refused or
//   misplaced message, /cancel, /skip, a command it does not know, /start,
//   /language), each exactly once, a keyholder's own commands aside; under
//   lockdown nothing is.
// The commit gate runs this file on every commit (`npm run test:invariants`).
import type { Update } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import { en } from '../../src/i18n/en';
import { fa } from '../../src/i18n/fa';
import { outgoingLinkProblems } from '../../src/platforms/link-policy';
import { reporterRef } from '../../src/privacy/reporter-ref';
import { pressData } from '../../src/review/intake';
import type { RecordedCall } from '../fakes/bot-api';
import { botHarness, type BotHarness } from '../support/bot-harness';
import { report, reporterIn, type Reporter } from '../support/intake-driver';
import { isOwnTable } from '../support/schema-description';
import { buttonPress, MEDIA_KINDS, privateMedia } from '../support/updates';
import { IDS } from '../support/variables';

/** The battery's reporters: each a distinct Telegram id of nine digits or more. */
const REPORTERS = [IDS.reporter, IDS.stranger, 424240041, 424240042, 424240043, 424240044, 424240045, 424240046] as const;
const NAMES = { username: 'reporter_handle', firstName: 'Reporter Name' };
const COMMENTS = ['she is the woman in the photos', 'my neighbour leaked my address', 'a short note'] as const;
const LINKS = {
  instagram: 'https://www.instagram.com/p/LeakPost123/?igsh=tracking',
  instagramAccount: 'https://instagram.com/leaking.account/',
  x: 'https://twitter.com/doxxer_account/status/1234567890123?s=20',
  facebook: 'https://m.facebook.com/some.leaker/posts/pfbid0abcdefghijklmnop',
  tiktok: 'https://www.tiktok.com/@leaker.tiktok/video/7234567890123456789',
  telegram: 'https://t.me/leak_channel/77',
  other: 'https://leak-site.org/people/someone',
} as const;
const REFUSED_LINKS = [
  'http://www.instagram.com/x',
  'https://user@x.com/someone',
  'https://x.com:8443/someone',
  'https://127.0.0.1/x',
  'https://localhost/x',
  'https://bit.ly/abcdef',
  'https://l.facebook.com/l.php?u=x',
  'https://t.me/+InviteHash',
  'https://t.me/some_bot?start=ref',
  'https://t.me/some_bot/app',
  'https://x.com/home',
  'https://business.facebook.com/x',
];

/** Commands carrying a link, which the battery sends after everything else. */
const COMMANDS_WITH_A_LINK = [
  '/nosuchcommand https://www.instagram.com/p/x/',
  '/start https://www.instagram.com/p/x/',
  '/language https://www.instagram.com/p/x/',
] as const;

/** Runs the battery; returns the harness, its reporters, and each update's own calls. */
async function battery(): Promise<{ harness: BotHarness; reporters: Reporter[]; byUpdate: { update: Update; calls: RecordedCall[] }[] }> {
  const harness = botHarness();
  for (const id of REPORTERS.slice(0, 6)) harness.telegram.setMember(IDS.membershipChat, id, { status: 'member' });
  const byUpdate: { update: Update; calls: RecordedCall[] }[] = [];
  const recording = {
    telegram: harness.telegram,
    send: async (update: Update) => {
      const before = harness.telegram.calls.length;
      await harness.send(update);
      byUpdate.push({ update, calls: harness.telegram.calls.slice(before) });
    },
  };
  const reporters = REPORTERS.map((id) => reporterIn(recording, id, NAMES));
  const [first, second, third, fourth, fifth, sixth, seventh, eighth] = reporters as [Reporter, Reporter, Reporter, Reporter, Reporter, Reporter, Reporter, Reporter];

  // Whole conversations, each platform once; a merged duplicate; the CSAM label.
  await report(first, { url: LINKS.instagram, account: LINKS.instagramAccount, category: 'intimate_images', affected: true, comment: COMMENTS[0] });
  await report(second, { url: 'https://instagram.com/p/LeakPost123?utm_source=x', account: 'unknown', category: 'private_data', affected: false, comment: COMMENTS[1] });
  await report(third, { url: LINKS.x, category: 'private_data', affected: true, comment: COMMENTS[2] });
  await report(fourth, { url: LINKS.facebook, category: 'harassment', affected: false });
  await report(fifth, { url: LINKS.tiktok, category: 'csam', affected: false });
  await report(sixth, { url: LINKS.telegram, category: 'impersonation', affected: false });
  await report(seventh, { url: LINKS.other, account: 'https://leak-site.org/people', category: 'other', affected: false });

  // Media and forwards at every step, a /cancel midway, an abandoned draft.
  for (const step of ['url', 'account', 'category', 'affected', 'comment'] as const) {
    if (step === 'account') await eighth.say(LINKS.instagram);
    if (step === 'category') await eighth.press(pressData({ kind: 'account_unknown' }));
    if (step === 'affected') await eighth.press(pressData({ kind: 'category', category: 'harassment' }));
    if (step === 'comment') await eighth.press(pressData({ kind: 'affected', affected: false }));
    for (const kind of MEDIA_KINDS) await eighth.send(privateMedia(eighth.id, kind, LINKS.x));
    await eighth.say(LINKS.x, { forwarded: true });
    await eighth.say(LINKS.x, { viaBot: true });
    await eighth.say(LINKS.x, { externalReply: true });
  }
  await eighth.say('/cancel');
  for (const link of REFUSED_LINKS) await eighth.say(link);
  await eighth.say(LINKS.x);
  // Commands carrying a link: deleted like every other message.
  for (const text of COMMANDS_WITH_A_LINK) await eighth.say(text);
  // A stale press on an old prompt.
  await recording.send(buttonPress(eighth.id, pressData({ kind: 'affected', affected: true }), { chatId: eighth.id, messageId: 1, chatType: 'private' }));
  return { harness, reporters, byUpdate };
}

const SENT_TO_REPORTERS = ['sendMessage', 'editMessageText'];
const FORBIDDEN_METHODS = ['forwardMessage', 'forwardMessages', 'copyMessage', 'copyMessages', 'getFile', 'getChat'];

describe('critical invariant 4: intake is text only, fetches nothing, and links only to trusted hosts', () => {
  it('stores no media, forward, inline-bot message or external reply, and deletes each', async () => {
    const { harness, reporters } = await battery();
    const eighth = reporters[7];
    for (const id of eighth?.sent ?? []) expect(harness.telegram.messageIn(eighth?.id ?? 0, id), `message ${id}`).toBeUndefined();
    const stored = harness.connection.prepare('SELECT url, account_url, comment FROM drafts UNION ALL SELECT url, account_url, comment FROM reports').all();
    for (const row of stored) expect(JSON.stringify(row)).not.toContain('media-file');
  });

  it('never forwards, copies, downloads or looks up, and calls nothing but the Bot API', async () => {
    const { harness } = await battery();
    for (const method of FORBIDDEN_METHODS) expect(harness.telegram.count(method), method).toBe(0);
    expect(harness.telegram.foreignRequests).toEqual([]);
  });

  it('sends and edits with previews off and HTML parse mode, every time', async () => {
    const { harness } = await battery();
    const texts = harness.telegram.calls.filter((call) => SENT_TO_REPORTERS.includes(call.method));
    expect(texts.length).toBeGreaterThan(50);
    for (const call of texts) {
      expect(call.payload.link_preview_options).toEqual({ is_disabled: true });
      expect(call.payload.parse_mode).toBe('HTML');
    }
  });

  it('sends a reporter no link off TRUSTED_HELP_HOSTS', async () => {
    const { harness } = await battery();
    for (const call of harness.telegram.calls.filter((recorded) => SENT_TO_REPORTERS.includes(recorded.method))) {
      expect(outgoingLinkProblems(String(call.payload.text), []), String(call.payload.text)).toEqual([]);
    }
    const hotlines = harness.telegram.calls.filter((call) => String(call.payload.text) === en['intake.hotlines']);
    expect(hotlines).toHaveLength(1);
  });

  it('keeps every link of both catalogs on TRUSTED_HELP_HOSTS', () => {
    for (const [key, text] of [...Object.entries(en), ...Object.entries(fa)]) expect(outgoingLinkProblems(text, []), key).toEqual([]);
  });

  it('stores no draft for a refused link of any class', async () => {
    const harness = botHarness();
    const reporter = reporterIn(harness, IDS.reporter);
    for (const link of REFUSED_LINKS) {
      await reporter.say(link);
      expect(harness.connection.prepare('SELECT count(*) AS n FROM drafts').get(), link).toEqual({ n: 0 });
    }
  });
});

describe('critical invariant 3: nothing the bot sends a reporter exposes anyone', () => {
  it('echoes no reported URL, account link, comment, id, username, name or reference', async () => {
    const { harness } = await battery();
    const refs = await Promise.all(REPORTERS.map((id) => reporterRef(id, harness.config.reporterRefKey)));
    const toReporters = harness.telegram.calls.filter(
      (recorded) => SENT_TO_REPORTERS.includes(recorded.method) && (REPORTERS as readonly unknown[]).includes(recorded.chatId),
    );
    expect(toReporters.length).toBeGreaterThan(50);
    const forbidden = [
      ...Object.values(LINKS),
      'LeakPost123',
      'leaking.account',
      'doxxer_account',
      'some.leaker',
      'leaker.tiktok',
      'leak_channel',
      'leak-site.org',
      ...COMMENTS,
      ...REPORTERS.map(String),
      NAMES.username,
      NAMES.firstName,
      ...refs,
    ];
    for (const call of toReporters) {
      for (const fragment of forbidden) expect(String(call.payload.text), fragment).not.toContain(fragment);
    }
  });

  it('posts each pending report\'s review card to the venue with its reference, never a reporter\'s id, username or name', async () => {
    const { harness } = await battery();
    const cards = harness.telegram.calls.filter((call) => call.chatId === IDS.adminChat);
    const pending = harness.connection.prepare("SELECT reporter_ref FROM reports WHERE status = 'pending'").all();
    expect(cards.map((call) => call.method)).toEqual(pending.map(() => 'sendMessage'));
    for (const card of cards) {
      const text = String(card.payload.text);
      for (const fragment of [...REPORTERS.map(String), NAMES.username, NAMES.firstName]) expect(text, fragment).not.toContain(fragment);
      expect(pending.some((row) => text.includes(String(row.reporter_ref)))).toBe(true);
    }
  });

  it('acknowledges a new and a merged report with the same bytes', async () => {
    const { harness } = await battery();
    const statuses = harness.connection.prepare('SELECT status FROM reports ORDER BY created_at, status DESC').all().map((row) => row.status);
    expect(statuses.filter((status) => status === 'merged')).toHaveLength(1);
    const ackOf = (id: number) => harness.textsTo(id).find((text) => text.startsWith('<b>Thank you.</b>'));
    expect(ackOf(IDS.reporter)).toBeDefined();
    expect(ackOf(IDS.reporter)).toBe(ackOf(IDS.stranger));
  });
});

describe('critical invariant 5: the intake answers in the reporter\'s own chat only', () => {
  it('sends, edits and deletes in the chat of the update only, and a press causes no new message', async () => {
    const { byUpdate } = await battery();
    for (const { update, calls } of byUpdate) {
      const own = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
      const cards = calls.filter((call) => call.chatId === IDS.adminChat);
      // The one message outside the reporter's chat: a submit's review card, to the venue, with its buttons.
      expect(cards.length).toBeLessThanOrEqual(1);
      for (const card of cards) {
        expect(update.message).toBeDefined();
        expect(card.method).toBe('sendMessage');
        expect(JSON.stringify(card.payload.reply_markup)).toContain('"callback_data":"rv:ap:');
      }
      for (const call of calls) {
        if (call.method === 'answerCallbackQuery' || cards.includes(call)) continue;
        if (call.method === 'getChatMember') {
          expect(call.chatId).toBe(IDS.membershipChat);
          expect(call.payload.user_id).toBe(update.message?.from?.id);
          continue;
        }
        expect(call.chatId, call.method).toBe(own);
      }
      if (update.callback_query !== undefined) {
        expect(calls.map((call) => call.method).filter((method) => method === 'sendMessage')).toEqual([]);
        for (const edit of calls.filter((call) => call.method === 'editMessageText')) {
          expect(edit.payload.message_id).toBe(update.callback_query.message?.message_id);
        }
      }
    }
    const methods = new Set(byUpdate.flatMap(({ calls }) => calls.map((call) => call.method)));
    expect([...methods].sort()).toEqual(['answerCallbackQuery', 'deleteMessage', 'editMessageText', 'getChatMember', 'sendMessage']);
  });
});

describe('critical invariant 8: no reporter id is stored, and intake leaves nothing behind', () => {
  it('holds no plaintext Telegram id of a reporter in any column of any table', async () => {
    const { harness } = await battery();
    const tables = harness.connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String(row.name))
      .filter(isOwnTable);
    expect(tables).toContain('reports');
    const ids = REPORTERS.map(String);
    let values = 0;
    for (const table of tables) {
      for (const row of harness.connection.prepare(`SELECT * FROM ${table}`).all()) {
        for (const value of Object.values(row)) {
          values += 1;
          for (const id of ids) expect(String(value), `${table}: ${id}`).not.toContain(id);
        }
      }
    }
    expect(values).toBeGreaterThan(100);
  });

  it('keys drafts and reports by the reporter reference', async () => {
    const { harness } = await battery();
    const refs = new Set(await Promise.all(REPORTERS.map((id) => reporterRef(id, harness.config.reporterRefKey))));
    const keys = harness.connection
      .prepare('SELECT draft_key AS ref FROM drafts UNION ALL SELECT reporter_ref FROM reports UNION ALL SELECT reporter_ref FROM reporter_stats')
      .all()
      .map((row) => String(row.ref));
    expect(keys.length).toBeGreaterThan(10);
    for (const key of keys) expect(refs.has(key), key).toBe(true);
  });

  it('deletes the draft at its submit and at its /cancel, and every reporter message it read', async () => {
    const { harness, reporters } = await battery();
    // Seven submits and a /cancel: only the eighth reporter's last, abandoned draft is left.
    const drafts = harness.connection.prepare('SELECT draft_key FROM drafts').all().map((row) => String(row.draft_key));
    expect(drafts).toEqual([await reporterRef(REPORTERS[7], harness.config.reporterRefKey)]);
    for (const reporter of reporters) {
      for (const id of reporter.sent) expect(harness.telegram.messageIn(reporter.id, id), `${reporter.id}: ${id}`).toBeUndefined();
    }
  });
});

describe('critical invariant 8: outside lockdown every message received in a private chat is deleted on receipt', () => {
  it('leaves none of them in the chat, each deleted exactly once, and deletes nothing else but the acknowledgements', async () => {
    const { harness, reporters, byUpdate } = await battery();
    let sent = 0;
    for (const reporter of reporters) {
      sent += reporter.sent.length;
      for (const id of reporter.sent) expect(harness.telegram.messageIn(reporter.id, id), `${reporter.id}: ${id}`).toBeUndefined();
    }
    const deletions = harness.telegram.callsOf('deleteMessage');
    const received = new Set(reporters.flatMap((reporter) => reporter.sent.map((id) => `${reporter.id}:${id}`)));
    const ofReceived = deletions.filter((call) => received.has(`${String(call.chatId)}:${String(call.payload.message_id)}`));
    expect(ofReceived).toHaveLength(sent);
    expect(new Set(ofReceived.map((call) => `${String(call.chatId)}:${String(call.payload.message_id)}`)).size).toBe(sent);
    // Every other deletion is an acknowledgement deleting itself, one per submitted report.
    const submitted = Number(harness.connection.prepare('SELECT count(*) AS n FROM reports').get()?.n);
    expect(submitted).toBe(7);
    expect(deletions.length - sent).toBe(submitted);
    // The battery did send every kind, the commands carrying a link included.
    const texts = byUpdate.map(({ update }) => update.message?.text ?? (update.message === undefined ? '' : 'media'));
    for (const text of [...COMMANDS_WITH_A_LINK, '/cancel', '/skip', 'media']) expect(texts, text).toContain(text);
    expect(sent).toBeGreaterThan(80);
  });

  it("spares a keyholder's own commands, and deletes nothing under lockdown", async () => {
    const harness = botHarness();
    const keyholder = reporterIn(harness, IDS.keyholder);
    const reporter = reporterIn(harness, IDS.reporter);
    await keyholder.say('/start');
    await keyholder.say('/lockdown');
    for (const text of [LINKS.x, '/start', '/language fa', '/nosuchcommand', ...COMMANDS_WITH_A_LINK]) await reporter.say(text);
    await keyholder.say('/unlock');
    expect(harness.telegram.count('deleteMessage')).toBe(0);
    for (const who of [keyholder, reporter]) {
      for (const id of who.sent) expect(harness.telegram.messageIn(who.id, id), `${who.id}: ${id}`).toBeDefined();
    }
    // Unlocked again, the reporter's next message goes on receipt.
    const after = await reporter.say('/start');
    expect(harness.telegram.callsOf('deleteMessage').map((call) => call.payload.message_id)).toEqual([after.message?.message_id]);
  });
});

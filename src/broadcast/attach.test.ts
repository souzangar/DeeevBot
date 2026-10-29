// Unit tests for /attach (src/broadcast/attach.ts; critical invariants 1, 2,
// 4 and 5), over the fakes on node:sqlite, after a run whose send Telegram
// answered ambiguously and whose post did reach the channel. The fake holds
// a channel post as Telegram does, by its plain text (plainText() of the
// stored post), so the verification reads what Telegram would return:
// - the argument read;
// - the probe: its keyboards carry no press data, two variants, "message is
//   not modified" only ever switching the variant;
// - the verification by the message's text, its date in the send window and
//   no other claim in it, never by its keyboard: the real post verified on
//   either variant and healed when its button was relabelled or removed; a
//   human message in the window refused on its text; a probe whose answer
//   was lost, then the same /attach again, binding nothing;
// - the probe's keyboard removed after a refusal (tried twice), the post's
//   own keyboard put back after a verification (a post it cannot be put
//   back on is not recorded);
// - the record and its follow-ups, and the lockdown rules.
import { describe, expect, it } from 'vitest';
import { setLockdown } from '../auth/lockdown';
import { sql, type SqlStatement } from '../db/sql';
import { postedNoticeText } from '../review/notify';
import { plainText } from '../review/render-post';
import { statusCard } from '../review/status-card';
import { MARK_DATA, MARK_PREFIX, recordPress } from '../telegram/presses';
import { FAILURES, rateLimited } from '../../test/fakes/bot-api';
import { hex, insertReport, reportRow } from '../../test/support/review-rows';
import { plantApproved, TICK_AT, tickHarness, type PlantedPost, type TickHarness } from '../../test/support/tick-harness';
import { IDS } from '../../test/support/variables';
import { ATTACH_EARLY_MS, ATTACH_LATE_MS, attachPost, channelLinkId, parseAttach, PROBE_DATA, PROBE_KEYBOARDS } from './attach';
import { postKeyboard } from './post';

const ID = 'abcdefghijklmnopqrst';
const CHANNEL = IDS.broadcastChannel;
const POST = 41;

/** A report whose send timed out at TICK_AT; nothing in the channel yet. */
const timedOut = async (harness: TickHarness): Promise<PlantedPost> => {
  const planted = await plantApproved(harness);
  harness.telegram.fail({ method: 'sendMessage', chatId: CHANNEL }, FAILURES.timeout, 1);
  expect((await harness.run()).post).toBe('ambiguous');
  return planted;
};

/** Puts a message into the channel as Telegram holds it, sent at `at` (TICK_AT unless given). */
const seed = (harness: TickHarness, message: { readonly message_id: number; readonly text: string; readonly reply_markup?: unknown }, at = TICK_AT): void => {
  const now = harness.clock.now();
  harness.clock.set(at);
  harness.telegram.seedMessage(CHANNEL, message);
  harness.clock.set(now);
};

/** A report whose post did reach the channel as message POST, with `markup` (its own keyboard unless given). */
const ambiguous = async (harness: TickHarness, markup?: unknown): Promise<PlantedPost> => {
  const planted = await timedOut(harness);
  seed(harness, { message_id: POST, text: plainText(planted.text), reply_markup: markup === undefined ? postKeyboard(planted.reportId) : markup });
  return planted;
};

const probes = (harness: TickHarness) => harness.telegram.callsOf('editMessageReplyMarkup');
const markupOf = (harness: TickHarness, messageId = POST) => harness.telegram.messageIn(CHANNEL, messageId)?.reply_markup;

describe('parseAttach', () => {
  it('reads a report id and a message id, or a t.me/c/ link of the broadcast channel', () => {
    const internal = channelLinkId(CHANNEL) ?? '';
    expect(internal).toBe('4242400061');
    for (const target of ['45', `https://t.me/c/${internal}/45`, `t.me/c/${internal}/45`, `https://t.me/c/${internal}/45?single`, `https://telegram.me/c/${internal}/45`]) {
      expect(parseAttach(`${ID} ${target}`, CHANNEL), target).toEqual({ ok: true, reportId: ID, messageId: 45 });
    }
    expect(parseAttach(`  ${ID.toUpperCase()}   7 `, CHANNEL)).toEqual({ ok: true, reportId: ID, messageId: 7 });
  });

  it("refuses another chat's link, and anything else", () => {
    expect(parseAttach(`${ID} https://t.me/c/1234567890/45`, CHANNEL)).toEqual({ ok: false, reason: 'other_channel' });
    for (const argument of ['', ID, `${ID} 0`, `${ID} 045`, `${ID} 12x`, `${ID} https://t.me/somechannel/45`, `${ID} http://t.me/c/4242400061/45`, `${ID} 45 46`, 'notareportid 45', `${ID} ${'9'.repeat(17)}`]) {
      expect(parseAttach(argument, CHANNEL), argument).toEqual({ ok: false, reason: 'usage' });
    }
  });

  it('knows no t.me/c/ id for a chat id without the channel prefix', () => {
    expect(channelLinkId(-12345)).toBeNull();
    expect(channelLinkId(12345)).toBeNull();
  });
});

describe("the probe's keyboards", () => {
  it('carry no press data: the presses parser refuses both variants, which differ', () => {
    expect(PROBE_DATA[0]).not.toBe(PROBE_DATA[1]);
    for (const data of PROBE_DATA) {
      expect(MARK_DATA.test(data), data).toBe(false);
      expect(data.startsWith(MARK_PREFIX), data).toBe(false);
    }
    expect(PROBE_KEYBOARDS.map((keyboard) => keyboard.inline_keyboard[0]?.[0])).toEqual(PROBE_DATA.map((data) => ({ text: '…', callback_data: data })));
  });
});

describe('/attach of the post a report sent', () => {
  it('verifies it by its text and its date, puts its own keyboard back, and records it', async () => {
    const harness = tickHarness();
    const planted = await ambiguous(harness);
    harness.clock.advance(5 * 60_000);
    expect(await attachPost(harness.deps, 'keyholder', planted.reportId, POST)).toBe('recorded');
    expect(await reportRow(harness.db, planted.reportId)).toMatchObject({
      status: 'posted',
      post_message_id: POST,
      posted_at: TICK_AT + 5 * 60_000,
      needs_attention: 0,
      alert_sent_at: null,
    });
    expect(await harness.db.all(sql`SELECT * FROM jobs`)).toEqual([]);
    expect(probes(harness).map((call) => call.payload.reply_markup)).toEqual([PROBE_KEYBOARDS[0], postKeyboard(planted.reportId)]);
    expect(markupOf(harness)).toEqual(postKeyboard(planted.reportId));
    // Its button counts now: the press is on the report's own post.
    expect(await recordPress(harness.deps, planted.reportId, POST)).toBe(true);
  });

  it('verifies it on either probe variant: a leftover of either is never taken for anything', async () => {
    for (const leftover of PROBE_KEYBOARDS) {
      const harness = tickHarness();
      const planted = await ambiguous(harness, leftover);
      expect(await attachPost(harness.deps, 'keyholder', planted.reportId, POST)).toBe('recorded');
      expect(markupOf(harness)).toEqual(postKeyboard(planted.reportId));
    }
  });

  it('heals a post whose button a catalog revision relabelled, or a human removed', async () => {
    for (const markup of [{ inline_keyboard: [[{ text: 'an older label', callback_data: `mark:${ID}` }]] }, null]) {
      const harness = tickHarness();
      const planted = await timedOut(harness);
      seed(harness, { message_id: POST, text: plainText(planted.text), ...(markup === null ? {} : { reply_markup: markup }) });
      expect(await attachPost(harness.deps, 'keyholder', planted.reportId, POST)).toBe('recorded');
      expect(markupOf(harness)).toEqual(postKeyboard(planted.reportId));
    }
  });

  it('edits the remembered keyholder notices to "posted", and the venue as after a post', async () => {
    const harness = tickHarness();
    const planted = await ambiguous(harness);
    harness.telegram.seedMessage(IDS.keyholder, { message_id: 3, text: 'the notice' });
    harness.notices.remember(planted.approvalId, [{ chatId: IDS.keyholder, messageId: 3 }]);
    await attachPost(harness.deps, 'admin', planted.reportId, POST);
    expect(harness.telegram.messageIn(IDS.keyholder, 3)?.text).toBe(postedNoticeText(planted.reportId));
    expect(harness.telegram.messageIn(IDS.adminChat, planted.cardMessageId)).toBeUndefined();
    const posted = statusCard({ id: planted.reportId, status: 'posted', platform: 'x', category: 'harassment', reporterRef: hex(1) }, null, harness.config.venueLocale);
    expect(harness.telegram.messageIn(IDS.adminChat, planted.statusMessageId)?.text).toBe(posted.text);
  });

  it("records nothing when the post's own keyboard cannot be put back; the next /attach does", async () => {
    const harness = tickHarness();
    const planted = await ambiguous(harness);
    const api = harness.deps.api;
    let calls = 0;
    const deps = {
      ...harness.deps,
      api: Object.assign(Object.create(api) as typeof api, {
        editMessageReplyMarkup: (...args: Parameters<typeof api.editMessageReplyMarkup>) => {
          calls += 1;
          // The probe goes through; both tries to put the post's keyboard back fail.
          return calls === 1 ? api.editMessageReplyMarkup(...args) : Promise.reject(new TypeError('fetch failed'));
        },
      }),
    };
    expect(await attachPost(deps, 'keyholder', planted.reportId, POST)).toBe('unavailable');
    expect(calls).toBe(3);
    expect((await reportRow(harness.db, planted.reportId))?.status).toBe('posting');
    expect(harness.log.records().map((record) => record.event)).toContain('attach.restore_failed');
    // The message still carries the probe's keyboard: the next /attach sends the other variant, verifies and records.
    expect(markupOf(harness)).toEqual(PROBE_KEYBOARDS[0]);
    expect(await attachPost(harness.deps, 'keyholder', planted.reportId, POST)).toBe('recorded');
    expect(markupOf(harness)).toEqual(postKeyboard(planted.reportId));
  });
});

describe('/attach refuses', () => {
  it("another report's post, before any call", async () => {
    const harness = tickHarness();
    const planted = await ambiguous(harness);
    await insertReport(harness.db, { status: 'posted', posting_started_at: 1, posted_at: 2, post_message_id: POST });
    expect(await attachPost(harness.deps, 'admin', planted.reportId, POST)).toBe('taken');
    expect(probes(harness)).toEqual([]);
    expect((await reportRow(harness.db, planted.reportId))?.status).toBe('posting');
  });

  it('a message the bot cannot edit: none in the channel, or one it may not edit', async () => {
    const harness = tickHarness();
    const planted = await timedOut(harness);
    expect(await attachPost(harness.deps, 'admin', planted.reportId, POST)).toBe('not_verified');
    harness.telegram.fail({ method: 'editMessageReplyMarkup' }, { kind: 'error', errorCode: 400, description: "Bad Request: message can't be edited" }, 1);
    expect(await attachPost(harness.deps, 'admin', planted.reportId, 9)).toBe('not_verified');
    expect((await reportRow(harness.db, planted.reportId))?.status).toBe('posting');
  });

  it('a human message in the send window under a mistyped id, on its text, its probe keyboard taken off again', async () => {
    const harness = tickHarness();
    const planted = await timedOut(harness);
    seed(harness, { message_id: 52, text: 'A note of the keyholder, posted by hand' }, TICK_AT + 5_000);
    expect(await attachPost(harness.deps, 'keyholder', planted.reportId, 52)).toBe('text_mismatch');
    expect(harness.log.records().at(-1)).toEqual({ level: 'info', event: 'attach.text_mismatch', reportId: planted.reportId });
    expect(markupOf(harness, 52)).toBeUndefined();
    expect(harness.telegram.messageIn(CHANNEL, 52)?.text).toBe('A note of the keyholder, posted by hand');
    expect((await reportRow(harness.db, planted.reportId))?.status).toBe('posting');
  });

  it('a probe whose answer was lost, then the same /attach again: nothing is ever bound', async () => {
    const harness = tickHarness();
    const planted = await timedOut(harness);
    seed(harness, { message_id: 53, text: 'Another message, its id mistyped for the post' }, TICK_AT + 5_000);
    // The probe lands, its answer lost; both removals are lost too: its keyboard stays on the message.
    harness.telegram.fail({ method: 'editMessageReplyMarkup' }, FAILURES.lostResponse, 1);
    harness.telegram.fail({ method: 'editMessageReplyMarkup' }, FAILURES.timeout, 2);
    expect(await attachPost(harness.deps, 'keyholder', planted.reportId, 53)).toBe('unavailable');
    expect(markupOf(harness, 53)).toEqual(PROBE_KEYBOARDS[0]);
    expect(harness.log.records().map((record) => record.event)).toContain('attach.revert_failed');
    // Again: "not modified" decides nothing; the other variant returns the message, whose text refuses it.
    expect(await attachPost(harness.deps, 'keyholder', planted.reportId, 53)).toBe('text_mismatch');
    expect(markupOf(harness, 53)).toBeUndefined();
    expect(await reportRow(harness.db, planted.reportId)).toMatchObject({ status: 'posting', post_message_id: null });
  });

  it("a post whose text a human edited, on its text, even in its window: such a post can never be attached", async () => {
    const harness = tickHarness();
    const planted = await timedOut(harness);
    seed(harness, { message_id: POST, text: `${plainText(planted.text)}\nEdited by hand.`, reply_markup: postKeyboard(planted.reportId) });
    expect(await attachPost(harness.deps, 'keyholder', planted.reportId, POST)).toBe('text_mismatch');
    expect(markupOf(harness)).toBeUndefined();
  });

  it("this report's text sent outside the send window, its probe keyboard taken off again", async () => {
    for (const offset of [-ATTACH_EARLY_MS - 1_000, ATTACH_LATE_MS + 1_000]) {
      const harness = tickHarness();
      const planted = await timedOut(harness);
      seed(harness, { message_id: POST, text: plainText(planted.text) }, TICK_AT + offset);
      expect(await attachPost(harness.deps, 'keyholder', planted.reportId, POST), String(offset)).toBe('window_mismatch');
      expect(harness.log.records().at(-1), String(offset)).toEqual({ level: 'info', event: 'attach.window_mismatch', reportId: planted.reportId });
      expect(markupOf(harness), String(offset)).toBeUndefined();
      expect((await reportRow(harness.db, planted.reportId))?.status).toBe('posting');
    }
  });

  it("this report's text in the window when another report was claimed in it too", async () => {
    const harness = tickHarness();
    const planted = await timedOut(harness);
    await insertReport(harness.db, { status: 'posted', posting_started_at: TICK_AT + 2_000, posted_at: TICK_AT + 3_000, post_message_id: 99 });
    seed(harness, { message_id: POST, text: plainText(planted.text) });
    expect(await attachPost(harness.deps, 'keyholder', planted.reportId, POST)).toBe('window_mismatch');
    expect(markupOf(harness)).toBeUndefined();
  });

  it('a report that is not posting without a message id, and an unknown one', async () => {
    const harness = tickHarness();
    const approved = await plantApproved(harness, { startsAt: TICK_AT + 60_000 });
    const pending = await insertReport(harness.db);
    const posted = await insertReport(harness.db, { status: 'posted', posting_started_at: 1, posted_at: 2, post_message_id: 77 });
    for (const reportId of [approved.reportId, pending, posted]) expect(await attachPost(harness.deps, 'admin', reportId, POST), reportId).toBe('not_posting');
    expect(await attachPost(harness.deps, 'admin', ID, POST)).toBe('not_found');
    expect(probes(harness)).toEqual([]);
  });

  it('as "try again" a probe Telegram answered ambiguously, removed again, so the retry verifies the post', async () => {
    const harness = tickHarness();
    const planted = await ambiguous(harness);
    harness.telegram.fail({ method: 'editMessageReplyMarkup' }, FAILURES.timeout, 1);
    expect(await attachPost(harness.deps, 'keyholder', planted.reportId, POST)).toBe('unavailable');
    expect(markupOf(harness)).toBeUndefined();
    expect(await attachPost(harness.deps, 'keyholder', planted.reportId, POST)).toBe('recorded');
    expect(markupOf(harness)).toEqual(postKeyboard(planted.reportId));
  });

  it('tries the removal twice, and logs by class one that still fails', async () => {
    const harness = tickHarness();
    const planted = await ambiguous(harness);
    harness.telegram.fail({ method: 'editMessageReplyMarkup' }, FAILURES.timeout, 2);
    expect(await attachPost(harness.deps, 'keyholder', planted.reportId, POST)).toBe('unavailable');
    expect(probes(harness)).toHaveLength(3);
    expect(harness.log.records().map((record) => record.event)).not.toContain('attach.revert_failed');
    harness.telegram.fail({ method: 'editMessageReplyMarkup' }, FAILURES.timeout, 3);
    await attachPost(harness.deps, 'keyholder', planted.reportId, POST);
    expect(harness.log.records().map((record) => record.event)).toContain('attach.revert_failed');
  });

  it('as "try again" a probe Telegram answered 429, with nothing to undo', async () => {
    const harness = tickHarness();
    const planted = await ambiguous(harness);
    harness.telegram.fail({ method: 'editMessageReplyMarkup' }, rateLimited(3), 1);
    expect(await attachPost(harness.deps, 'admin', planted.reportId, POST)).toBe('unavailable');
    expect(probes(harness)).toHaveLength(1);
  });
});

describe('/attach and the lockdown', () => {
  it("an admin's is refused once the switch is set, before the probe", async () => {
    const harness = tickHarness();
    const planted = await ambiguous(harness);
    await setLockdown(harness.db, harness.clock);
    expect(await attachPost(harness.deps, 'admin', planted.reportId, POST)).toBe('locked');
    expect(probes(harness)).toEqual([]);
    expect((await reportRow(harness.db, planted.reportId))?.status).toBe('posting');
  });

  it("an admin's write binds the switch: one set after the probe records nothing", async () => {
    const harness = tickHarness({
      store: (db) => ({
        ...db,
        batch: async (statements: readonly SqlStatement[]) => {
          if (String(statements[0]?.sql).startsWith("UPDATE reports SET status = 'posted', post_message_id")) {
            await db.run(sql`INSERT INTO meta (key, value) VALUES ('lockdown', 1)`);
          }
          return db.batch(statements);
        },
      }),
    });
    const planted = await ambiguous(harness);
    expect(await attachPost(harness.deps, 'admin', planted.reportId, POST)).toBe('locked');
    expect(await reportRow(harness.db, planted.reportId)).toMatchObject({ status: 'posting', post_message_id: null });
    expect(await harness.db.all(sql`SELECT kind FROM jobs`)).toEqual([{ kind: 'post' }]);
  });

  it("a keyholder's works, and leaves the venue alone", async () => {
    const harness = tickHarness();
    const planted = await ambiguous(harness);
    await setLockdown(harness.db, harness.clock);
    const venue = harness.telegram.messagesIn(IDS.adminChat);
    const from = harness.telegram.calls.length;
    expect(await attachPost(harness.deps, 'keyholder', planted.reportId, POST)).toBe('recorded');
    expect(harness.telegram.messagesIn(IDS.adminChat)).toEqual(venue);
    expect(harness.telegram.calls.slice(from).filter((call) => call.chatId === IDS.adminChat)).toEqual([]);
  });
});

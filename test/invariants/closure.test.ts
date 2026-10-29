// Always-run invariant spec for closure and retraction (src/broadcast/
// closure.ts, retraction.ts, concluding.ts, finalize.ts; critical
// invariants 1, 4, 5 and 8), over the fakes on node:sqlite, the reports
// approved through the real review where the rule is about the approval:
// - rule 1: no closure or retraction edit without the report's live
//   approval record: the orders refuse a posted report that holds none, and
//   an edit job never edits the post of a report that holds none; the
//   terminal status is written only by the edit's success: under every
//   failure class of the edit, run after run, the report stays closing or
//   retracting with its post's id and its correction, and reconciliation
//   never finalizes it; every edit reaches that report's own post in the
//   configured channel and no other message;
// - rule 4: every edit of a post has previews off and HTML parse mode, and
//   carries no tappable link off the lists; a correction holding a link, a
//   domain, a mention or a phone number never reaches the channel, refused
//   at the prompt and, written past it, refused at the edit;
// - rule 5: over a report's whole life the channel gets its post and that
//   post's edits alone; the closure sends no direct message to anyone; the
//   retraction's only messages besides the edit are the keyholder's own
//   prompt and answer in their own chat; after the retraction nothing about
//   the report reaches the channel any more, and its button counts nothing.
// The commit gate runs this file on every commit (`npm run test:invariants`).
import type { Update } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import { orderClosure } from '../../src/broadcast/closure';
import { finalize } from '../../src/broadcast/maintenance';
import { retractStatements, RETRACT_STATUS_STATEMENT, startRetraction } from '../../src/broadcast/retraction';
import { sql } from '../../src/db/sql';
import { linksIn, outgoingLinkProblems } from '../../src/platforms/link-policy';
import { recordPress } from '../../src/telegram/presses';
import { FAILURES, rateLimited, type RecordedCall } from '../fakes/bot-api';
import { reviewIn, type SubmittedReport } from '../support/review-driver';
import { insertApproval, insertReport, reportRow } from '../support/review-rows';
import { plantPosted, TICK_AT, tickHarness, type PostedPost, type TickHarness } from '../support/tick-harness';
import { IDS } from '../support/variables';
import { groupMessage, privateMessage } from '../support/updates';

const MINUTE = 60_000;
const DAY = 86_400_000;
const CORRECTION = 'The admins were wrong: this account is the victim. Please do not report it.';
const X_POST = 'https://x.com/someone/status/1234567890';
/** Past the 48 hours of the harness's posts, on a 15th minute: 2027-01-17 12:15 UTC. */
const LATER = Date.UTC(2027, 0, 17, 12, 15);

const channelCalls = (harness: TickHarness): RecordedCall[] => harness.telegram.calls.filter((call) => call.chatId === IDS.broadcastChannel);

/** Every run from `from` to `to`, `step` apart. */
const runFor = async (harness: TickHarness, from: number, to: number, step = MINUTE): Promise<void> => {
  for (let at = from; at <= to; at += step) {
    harness.clock.set(at);
    await harness.run(at);
  }
};

/** A keyholder's text in their own chat, as Telegram holds it; its message id. */
const keyholderSays = async (harness: TickHarness, text: string, replyTo?: number): Promise<number> => {
  const messageId = harness.telegram.receive(IDS.keyholder, { text });
  const update = privateMessage(IDS.keyholder, text, replyTo === undefined ? {} : { replyToBot: replyTo });
  await harness.send({ ...update, message: { ...update.message, message_id: messageId } } as Update);
  return messageId;
};

const promptIn = (harness: TickHarness, chatId: number) =>
  harness.telegram
    .messagesIn(chatId)
    .filter((message) => (message.reply_markup as { force_reply?: boolean } | undefined)?.force_reply === true)
    .at(-1);

/** A posted report moved to `status` by the statements the orders write, with its edit job. */
const editing = async (harness: TickHarness, status: 'closing' | 'retracting'): Promise<PostedPost> => {
  const posted = await plantPosted(harness);
  if (status === 'closing') expect(await orderClosure(harness.deps, posted.reportId, 'taken_down')).toBe('closing');
  else {
    const results = await harness.db.batch(
      retractStatements({ reportId: posted.reportId, correction: CORRECTION, now: harness.clock.now(), byAdmin: false, prompt: { chatId: IDS.keyholder, promptMessageId: 1 } }),
    );
    expect(results[RETRACT_STATUS_STATEMENT]?.changes).toBe(1);
  }
  return posted;
};

/** A report submitted and approved through the real review, then posted by the runs. */
const approvedAndPosted = async (harness: TickHarness): Promise<SubmittedReport & { readonly postMessageId: number; readonly statusMessageId: number }> => {
  const review = reviewIn(harness);
  const report = await review.submit({ url: X_POST, category: 'harassment', affected: false, comment: 'a comment' });
  await review.approve(IDS.admin, report, { category: 'harassment', mode: 'account', points: 'Say it mocks a private person every day.' });
  await runFor(harness, harness.clock.now(), harness.clock.now() + 32 * MINUTE);
  const row = await reportRow(harness.db, report.reportId);
  expect(row?.status).toBe('posted');
  return { ...report, postMessageId: Number(row?.post_message_id), statusMessageId: Number(row?.status_message_id) };
};

describe('critical invariant 1: no closure or retraction edit without the report\'s approval record', () => {
  it('the orders refuse a posted report that holds no live approval record', async () => {
    const harness = tickHarness();
    const unbound = await insertReport(harness.db, { status: 'posted', posting_started_at: 1, posted_at: 2, post_message_id: 91 });
    const voided = await plantPosted(harness);
    await harness.db.run(sql`UPDATE approvals SET voided_at = 1 WHERE report_id = ?`, [voided.reportId]);
    for (const reportId of [unbound, voided.reportId]) {
      expect(await orderClosure(harness.deps, reportId, 'taken_down'), reportId).toBe('refused');
      const results = await harness.db.batch(retractStatements({ reportId, correction: CORRECTION, now: TICK_AT, byAdmin: false, prompt: { chatId: IDS.keyholder, promptMessageId: 1 } }));
      expect(results[RETRACT_STATUS_STATEMENT]?.changes, reportId).toBe(0);
      expect(await startRetraction(harness.deps, { id: IDS.keyholder, role: 'keyholder', locale: 'en', chatId: IDS.keyholder }, reportId), reportId).toBe('refused');
      expect(await reportRow(harness.db, reportId), reportId).toMatchObject({ status: 'posted', correction_text: null });
    }
    expect(await harness.db.all(sql`SELECT * FROM jobs`)).toEqual([]);
  });

  it('an edit job never edits the post of a report whose approval record is gone, over a day of runs', async () => {
    for (const status of ['closing', 'retracting'] as const) {
      const harness = tickHarness();
      const posted = await editing(harness, status);
      await harness.db.run(sql`DELETE FROM approvals WHERE report_id = ?`, [posted.reportId]);
      const before = channelCalls(harness).length;
      await runFor(harness, TICK_AT + MINUTE, TICK_AT + DAY, 15 * MINUTE);
      expect(channelCalls(harness).slice(before), status).toEqual([]);
      expect(await reportRow(harness.db, posted.reportId), status).toMatchObject({ status, post_message_id: posted.postMessageId, data_deleted_at: null });
    }
  });
});

describe('critical invariant 1: the terminal status is written only by the edit\'s success', () => {
  const FAILURE_CLASSES = [
    ['a 429', rateLimited(60)],
    ['a timeout', FAILURES.timeout],
    ['a 5xx', FAILURES.serverError],
    ['a network failure', FAILURES.networkFailure],
    ['a 400', FAILURES.chatNotFound],
    ['a 403', FAILURES.botBlocked],
  ] as const;

  it.each(FAILURE_CLASSES)('under %s, run after run, reconciliation included, the report keeps closing or retracting with its post and its correction', async (_label, failure) => {
    for (const status of ['closing', 'retracting'] as const) {
      const harness = tickHarness();
      const posted = await editing(harness, status);
      harness.telegram.fail({ method: 'editMessageText', chatId: IDS.broadcastChannel }, failure);
      // Two days on, so a retracted post is past the 48 hours and never deleted instead; every 15th minute, so each run reconciles.
      await runFor(harness, LATER, LATER + 3 * 60 * MINUTE, 15 * MINUTE);
      const kept = await reportRow(harness.db, posted.reportId);
      expect(kept, status).toMatchObject({ status, post_message_id: posted.postMessageId, data_deleted_at: null });
      if (status === 'retracting') expect(kept?.correction_text).toBe(CORRECTION);
      expect(await harness.db.all(sql`SELECT * FROM stats`), status).toEqual([]);
      // Reconciliation's finalization never takes it, called on it directly either.
      await finalize(harness.deps, posted.reportId, harness.clock.now());
      expect(await reportRow(harness.db, posted.reportId), status).toEqual(kept);
    }
  });

  it('concludes on the edit\'s success alone, in the batch that finalizes it', async () => {
    for (const status of ['closing', 'retracting'] as const) {
      const harness = tickHarness();
      const posted = await editing(harness, status);
      harness.telegram.fail({ method: 'editMessageText', chatId: IDS.broadcastChannel }, FAILURES.serverError, 2);
      await runFor(harness, LATER, LATER + 2 * MINUTE);
      expect((await reportRow(harness.db, posted.reportId))?.status, status).toBe(status);
      await runFor(harness, LATER + 20 * MINUTE, LATER + 40 * MINUTE, 10 * MINUTE);
      expect(await reportRow(harness.db, posted.reportId), status).toMatchObject({ status: status === 'closing' ? 'closed' : 'retracted', post_message_id: null });
      expect(await harness.db.all(sql`SELECT report_id FROM stats`), status).toEqual([{ report_id: posted.reportId }]);
    }
  });
});

describe('critical invariant 1: every edit reaches that report\'s own post in the configured channel', () => {
  it('closing one report and retracting another edits each one\'s own message and nothing else', async () => {
    const harness = tickHarness();
    const untouched = await plantPosted(harness);
    const closed = await plantPosted(harness);
    const retracted = await plantPosted(harness);
    const from = harness.telegram.calls.length;
    expect(await orderClosure(harness.deps, closed.reportId, 'no_result')).toBe('closing');
    await harness.db.batch(
      retractStatements({ reportId: retracted.reportId, correction: CORRECTION, now: TICK_AT, byAdmin: false, prompt: { chatId: IDS.keyholder, promptMessageId: 1 } }),
    );
    await runFor(harness, TICK_AT + MINUTE, TICK_AT + 5 * MINUTE);
    const edits = harness.telegram.calls.slice(from).filter((call) => ['editMessageText', 'editMessageReplyMarkup', 'deleteMessage'].includes(call.method) && call.chatId !== IDS.adminChat);
    for (const call of edits) expect(call.chatId).toBe(IDS.broadcastChannel);
    expect(edits.map((call) => [call.method, call.payload.message_id]).sort()).toEqual(
      [
        ['editMessageText', closed.postMessageId],
        ['editMessageText', retracted.postMessageId],
        ['deleteMessage', retracted.postMessageId],
      ].sort(),
    );
    expect(harness.telegram.messageIn(IDS.broadcastChannel, untouched.postMessageId)?.text).toBe(untouched.text);
  });
});

describe('critical invariant 4: the edits carry no preview, no HTML but the catalog\'s, and no link off the lists', () => {
  it('every edit of a post has previews off and HTML parse mode, and only listed links', async () => {
    const harness = tickHarness();
    await editing(harness, 'closing');
    await editing(harness, 'retracting');
    await runFor(harness, TICK_AT + MINUTE, TICK_AT + 3 * MINUTE);
    const edits = harness.telegram.callsOf('editMessageText').filter((call) => call.chatId === IDS.broadcastChannel);
    expect(edits).toHaveLength(2);
    for (const call of edits) {
      expect(call.payload.link_preview_options).toEqual({ is_disabled: true });
      expect(call.payload.parse_mode).toBe('HTML');
      expect(call.payload.reply_markup).toBeUndefined();
      expect(outgoingLinkProblems(String(call.payload.text), harness.config.allowedLinkHosts)).toEqual([]);
    }
    // The retraction's text links to nothing at all.
    expect(linksIn(String(edits.find((call) => String(call.payload.text).includes('victim'))?.payload.text))).toEqual([]);
  });

  it.each([
    ['a URL', 'See https://x.com/another instead'],
    ['a bare domain', 'Report x.com/another instead'],
    ['a mention', 'Ask @another about it'],
    ['a phone number', 'Call 0912 345 6789 for help'],
  ])('a correction holding %s never reaches the channel', async (_label, bad) => {
    const harness = tickHarness();
    const posted = await plantPosted(harness);
    await keyholderSays(harness, `/retract ${posted.reportId}`);
    await keyholderSays(harness, bad, promptIn(harness, IDS.keyholder)?.message_id);
    expect(await reportRow(harness.db, posted.reportId)).toMatchObject({ status: 'posted', correction_text: null });
    // Written past the prompt, it is refused at the edit all the same.
    await harness.db.batch(retractStatements({ reportId: posted.reportId, correction: bad, now: TICK_AT, byAdmin: false, prompt: { chatId: IDS.keyholder, promptMessageId: 1 } }));
    await runFor(harness, TICK_AT + MINUTE, TICK_AT + 30 * MINUTE);
    const fragment = bad.split(' ')[1] ?? bad;
    expect(channelCalls(harness).filter((call) => typeof call.payload.text === 'string' && call.payload.text.includes(fragment))).toEqual([]);
    expect(harness.telegram.callsOf('editMessageText').filter((call) => call.chatId === IDS.broadcastChannel)).toEqual([]);
  });
});

describe('critical invariant 5: the post and its edits are the only messages about a report', () => {
  it('over a report\'s whole life to its closure: the channel gets the post and one edit, and the closure messages nobody', async () => {
    const harness = tickHarness();
    const report = await approvedAndPosted(harness);
    const beforeClosure = harness.telegram.calls.length;
    await harness.send(groupMessage(IDS.adminChat, IDS.admin, `/close ${report.reportId} taken_down`));
    await runFor(harness, harness.clock.now() + MINUTE, harness.clock.now() + 20 * MINUTE);
    expect((await reportRow(harness.db, report.reportId))?.status).toBe('closed');
    const channel = channelCalls(harness);
    expect(channel.map((call) => call.method)).toEqual(['sendMessage', 'editMessageText']);
    for (const call of channel) expect(call.payload.message_id ?? report.postMessageId).toBe(report.postMessageId);
    // From the order on: the venue (the answer, the status card) and the channel's edit, nothing else, and no direct message.
    for (const call of harness.telegram.calls.slice(beforeClosure)) {
      expect([IDS.adminChat, IDS.broadcastChannel, undefined]).toContain(call.chatId);
    }
    expect(harness.telegram.calls.slice(beforeClosure).filter((call) => call.method === 'sendMessage' && call.chatId !== IDS.adminChat)).toEqual([]);
  });

  it("a keyholder's retraction: the prompt and the answer in their own chat, the edit and the deletion in the channel, nothing else", async () => {
    const harness = tickHarness();
    const report = await approvedAndPosted(harness);
    const from = harness.telegram.calls.length;
    await keyholderSays(harness, `/retract ${report.reportId}`);
    await keyholderSays(harness, CORRECTION, promptIn(harness, IDS.keyholder)?.message_id);
    await runFor(harness, harness.clock.now() + MINUTE, harness.clock.now() + 3 * MINUTE);
    expect((await reportRow(harness.db, report.reportId))?.status).toBe('retracted');
    const sends = harness.telegram.calls.slice(from).filter((call) => call.method === 'sendMessage');
    expect(sends.map((call) => call.chatId)).toEqual([IDS.keyholder, IDS.keyholder]);
    expect(channelCalls(harness).map((call) => call.method)).toEqual(['sendMessage', 'editMessageText', 'deleteMessage']);
  });

  it('after the retraction nothing about the report reaches the channel any more, and its button counts nothing', async () => {
    const harness = tickHarness();
    const posted = await editing(harness, 'retracting');
    await runFor(harness, TICK_AT + MINUTE, TICK_AT + 2 * MINUTE);
    expect((await reportRow(harness.db, posted.reportId))?.status).toBe('retracted');
    const after = channelCalls(harness).length;
    expect(await recordPress(harness.deps, posted.reportId, posted.postMessageId)).toBe(false);
    expect(await orderClosure(harness.deps, posted.reportId, 'taken_down')).toBe('refused');
    // 120 nights of retention and the quarter hours around them.
    for (let night = 1; night <= 120; night += 1) {
      const at = Date.UTC(2027, 0, 15 + night, 0, 15);
      harness.clock.set(at);
      await harness.run(at);
    }
    expect(channelCalls(harness).slice(after)).toEqual([]);
    expect(await reportRow(harness.db, posted.reportId)).toBeNull();
  });

  it('a press after the closure writes nothing', async () => {
    const harness = tickHarness();
    const posted = await editing(harness, 'closing');
    await runFor(harness, TICK_AT + MINUTE, TICK_AT + 2 * MINUTE);
    expect((await reportRow(harness.db, posted.reportId))?.status).toBe('closed');
    const counters = await harness.db.all(sql`SELECT * FROM counters`);
    expect(await recordPress(harness.deps, posted.reportId, posted.postMessageId)).toBe(false);
    expect(await harness.db.all(sql`SELECT * FROM counters`)).toEqual(counters);
    expect(await harness.db.all(sql`SELECT presses FROM stats`)).toEqual([{ presses: 0 }]);
  });

  it('an approved report without its post id is never closed or retracted, so nothing is edited before its post', async () => {
    const harness = tickHarness();
    const reportId = await insertReport(harness.db, {});
    await insertApproval(harness.db, reportId);
    await harness.db.run(sql`UPDATE reports SET status = 'approved' WHERE id = ?`, [reportId]);
    expect(await orderClosure(harness.deps, reportId, 'no_result')).toBe('refused');
    expect((await harness.db.batch(retractStatements({ reportId, correction: CORRECTION, now: TICK_AT, byAdmin: false, prompt: { chatId: IDS.keyholder, promptMessageId: 1 } })))[RETRACT_STATUS_STATEMENT]?.changes).toBe(0);
  });
});

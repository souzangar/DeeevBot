// Unit tests for the review's decisions after Approve (src/telegram/review.ts
// over src/review/), driven through the composed bot over the fakes: Cancel
// by an admin on the card or the status card and by a keyholder on the
// notice, under lockdown the keyholder's only, and on a notice whose
// approval was never recorded, by its age; a re-approval under a new
// approval id; the Lockdown button; Reject with its reason; Route as
// suspected CSAM with its routing card and its Confirm; the first decision
// winning and the losing press told so; Block reporter; and /open, /block,
// /unblock and /card. No decision ever messages the reporter.
import type { Update } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import { FAILURES } from '../../test/fakes/bot-api';
import { botHarness, type BotHarness } from '../../test/support/bot-harness';
import { reviewIn, type ReviewDriver, type SubmittedReport } from '../../test/support/review-driver';
import { reportRow, snapshot } from '../../test/support/review-rows';
import { buttonPress, groupMessage, privateMessage } from '../../test/support/updates';
import { IDS } from '../../test/support/variables';
import { isLockedDown, setLockdown } from '../auth/lockdown';
import { sql } from '../db/sql';
import { t } from '../i18n/index';
import { reporterRef } from '../privacy/reporter-ref';
import { randomId } from '../db/ids';
import { noticeData, parseReviewData } from '../review/callbacks';
import { NOTICE_SETTLE_MS } from '../review/cancel';
import { cancelledNoticeText, noticeKeyboard } from '../review/notify';

const X_POST = 'https://x.com/someone/status/1234567890';
/** The venue's one language, VENUE_LOCALE, Persian by default: every venue text and every answer to a venue press. */
const V = 'fa';
const POINTS = 'Say it mocks a private person, and that it is repeated every day.';

interface Setup {
  readonly harness: BotHarness;
  readonly review: ReviewDriver;
  readonly report: SubmittedReport;
}

/** A pending X report of IDS.reporter's, with its card. */
const pending = async (variables?: Readonly<Record<string, string>>): Promise<Setup> => {
  const harness = botHarness(variables === undefined ? {} : { variables });
  const review = reviewIn(harness);
  const report = await review.submit({ url: X_POST, category: 'harassment', affected: false, comment: 'a comment' });
  return { harness, review, report };
};

/** That report, approved by IDS.admin; its approval id and status card. */
const approved = async (variables?: Readonly<Record<string, string>>) => {
  const setup = await pending(variables);
  await setup.review.approve(IDS.admin, setup.report, { category: 'harassment', mode: 'account', points: POINTS });
  const approval = await setup.harness.db.first<{ approval_id: string }>(sql`SELECT approval_id FROM approvals`);
  const row = await reportRow(setup.harness.db, setup.report.reportId);
  return { ...setup, approvalId: approval?.approval_id ?? '', statusId: Number(row?.status_message_id) };
};

const lastAnswer = (harness: BotHarness) => harness.telegram.callsOf('answerCallbackQuery').at(-1)?.payload.text;
const reporterTexts = (harness: BotHarness) => harness.textsTo(IDS.reporter);

describe('Cancel', () => {
  it('by an admin on the card: back to pending, the approval voided, the job deleted, the notices and the cards updated', async () => {
    const { harness, review, report, approvalId, statusId } = await approved();
    const toReporter = reporterTexts(harness).length;
    await review.press(IDS.admin, { kind: 'cancel', reportId: report.reportId, approvalId }, report.cardId);
    expect(lastAnswer(harness)).toBe(t(V, 'review.answer.cancelled'));
    expect(await reportRow(harness.db, report.reportId)).toMatchObject({ status: 'pending', broadcast_text: null, link_mode: null, status_message_id: null });
    expect(await harness.db.all(sql`SELECT voided_at FROM approvals`)).toEqual([{ voided_at: harness.clock.now() }]);
    expect(await harness.db.all(sql`SELECT * FROM jobs`)).toEqual([]);
    for (const keyholder of [IDS.keyholder, IDS.secondKeyholder]) {
      expect(harness.telegram.messageIn(keyholder, 1)).toMatchObject({ text: cancelledNoticeText(report.reportId) });
      expect(harness.telegram.messageIn(keyholder, 1)?.reply_markup).toBeUndefined();
    }
    expect(harness.telegram.messageIn(IDS.adminChat, statusId)).toBeUndefined();
    expect(review.buttonsOf(review.card(report)).map((data) => parseReviewData(data)?.kind)).toEqual(['approve', 'reject', 'route', 'block']);
    expect(review.card(report)?.text).toContain(t(V, 'review.card.category_earlier', { category: t(V, 'review.category.harassment') }));
    expect(review.card(report)?.text).toContain(t(V, 'review.card.affected_cleared'));
    expect(reporterTexts(harness)).toHaveLength(toReporter);
  });

  it('by an admin on the status card works the same', async () => {
    const { harness, review, report, approvalId, statusId } = await approved();
    await review.press(IDS.secondAdmin, { kind: 'cancel', reportId: report.reportId, approvalId }, statusId);
    expect(await reportRow(harness.db, report.reportId)).toMatchObject({ status: 'pending' });
  });

  it('by a keyholder on the notice: the same batch, the pressed notice edited, under lockdown too', async () => {
    for (const locked of [false, true]) {
      const { harness, review, report, approvalId } = await approved();
      if (locked) await setLockdown(harness.db, harness.clock);
      const venue = harness.telegram.calls.filter((call) => call.chatId === IDS.adminChat).length;
      await review.pressData(IDS.keyholder, noticeData({ kind: 'cancel', reportId: report.reportId, approvalId }), 1, IDS.keyholder);
      expect(lastAnswer(harness), String(locked)).toBe(t('en', 'review.answer.cancelled'));
      expect(await reportRow(harness.db, report.reportId)).toMatchObject({ status: 'pending' });
      expect(await harness.db.all(sql`SELECT * FROM jobs`)).toEqual([]);
      expect(harness.telegram.messageIn(IDS.keyholder, 1)).toMatchObject({ text: cancelledNoticeText(report.reportId) });
      // Under lockdown the venue, compromised by assumption, gets nothing.
      const venueAfter = harness.telegram.calls.filter((call) => call.chatId === IDS.adminChat).length;
      if (locked) expect(venueAfter).toBe(venue);
      else expect(venueAfter).toBeGreaterThan(venue);
    }
  });

  it("leaves the venue alone at a keyholder's Cancel under lockdown, and an admin's later Cancel brings the card back to review", async () => {
    const { harness, review, report, approvalId } = await approved();
    await setLockdown(harness.db, harness.clock);
    await review.pressData(IDS.keyholder, noticeData({ kind: 'cancel', reportId: report.reportId, approvalId }), 1, IDS.keyholder);
    expect(review.buttonsOf(review.card(report)).map((data) => parseReviewData(data)?.kind)).toEqual(['cancel']);
    await harness.db.run(sql`DELETE FROM meta WHERE key = 'lockdown'`);
    await review.press(IDS.admin, { kind: 'cancel', reportId: report.reportId, approvalId }, report.cardId);
    expect(lastAnswer(harness)).toBe(t(V, 'review.answer.already_cancelled'));
    expect(review.buttonsOf(review.card(report)).map((data) => parseReviewData(data)?.kind)).toEqual(['approve', 'reject', 'route', 'block']);
  });

  it("refuses an admin's Cancel under lockdown, and a keyholder's on another's notice", async () => {
    const { harness, review, report, approvalId } = await approved();
    await setLockdown(harness.db, harness.clock);
    await review.press(IDS.admin, { kind: 'cancel', reportId: report.reportId, approvalId }, report.cardId);
    expect(lastAnswer(harness)).toBe(t(V, 'admin.refused'));
    await review.pressData(IDS.keyholder, noticeData({ kind: 'cancel', reportId: report.reportId, approvalId }), 1, IDS.secondKeyholder);
    expect(lastAnswer(harness)).toBe(t('en', 'error.unauthorized'));
    expect(await reportRow(harness.db, report.reportId)).toMatchObject({ status: 'approved' });
  });

  it('is too late once the tick claimed the report, and says so', async () => {
    const { harness, review, report, approvalId } = await approved();
    await harness.db.run(sql`UPDATE reports SET status = 'posting', posting_started_at = ? WHERE id = ?`, [harness.clock.now(), report.reportId]);
    await review.pressData(IDS.keyholder, noticeData({ kind: 'cancel', reportId: report.reportId, approvalId }), 1, IDS.keyholder);
    expect(lastAnswer(harness)).toBe(t('en', 'review.answer.too_late'));
    expect(await harness.db.all(sql`SELECT voided_at FROM approvals`)).toEqual([{ voided_at: null }]);
  });

  it("by a keyholder on a notice whose approval was never recorded: nothing while it is young, settled as cancelled once five minutes old", async () => {
    for (const [age, answer, settled] of [
      [60_000, 'review.answer.not_recorded', false],
      [NOTICE_SETTLE_MS + 1000, 'review.answer.already_cancelled', true],
    ] as const) {
      const { harness, review, report } = await pending();
      // A notice Telegram delivered though its send was answered ambiguously: its approval never written.
      const approvalId = randomId();
      harness.telegram.seedMessage(IDS.keyholder, { message_id: 50, text: 'a notice', reply_markup: noticeKeyboard(report.reportId, approvalId) });
      const before = await snapshot(harness.db);
      harness.clock.set(harness.clock.now() + age);
      await review.pressData(IDS.keyholder, noticeData({ kind: 'cancel', reportId: report.reportId, approvalId }), 50, IDS.keyholder);
      expect(lastAnswer(harness), String(age)).toBe(t('en', answer));
      expect(await snapshot(harness.db), String(age)).toEqual(before);
      const notice = harness.telegram.messageIn(IDS.keyholder, 50);
      if (settled) {
        expect(notice).toMatchObject({ text: cancelledNoticeText(report.reportId) });
        expect(notice?.reply_markup).toBeUndefined();
      } else {
        expect(notice).toMatchObject({ text: 'a notice' });
        expect(review.buttonsOf(notice)).toHaveLength(2);
      }
    }
  });

  it('then a re-approval writes a new approval id, and the cancelled approval\'s job id no longer matches', async () => {
    const { harness, review, report, approvalId } = await approved();
    await review.press(IDS.admin, { kind: 'cancel', reportId: report.reportId, approvalId }, report.cardId);
    await review.approve(IDS.secondAdmin, report, { category: 'harassment', mode: 'account', points: POINTS });
    const [again] = await harness.db.all<{ approval_id: string; admin_id: number }>(sql`SELECT approval_id, admin_id FROM approvals`);
    expect(again?.approval_id).not.toBe(approvalId);
    expect(again?.admin_id).toBe(IDS.secondAdmin);
    expect(await harness.db.all(sql`SELECT json_extract(payload, '$.approval_id') AS approval_id FROM jobs`)).toEqual([{ approval_id: again?.approval_id }]);
    // The old notice's Cancel names the cancelled approval: it cancels nothing now.
    await review.pressData(IDS.keyholder, noticeData({ kind: 'cancel', reportId: report.reportId, approvalId }), 1, IDS.keyholder);
    expect(await reportRow(harness.db, report.reportId)).toMatchObject({ status: 'approved' });
    expect(harness.telegram.messageIn(IDS.keyholder, 1)).toMatchObject({ text: cancelledNoticeText(report.reportId) });
  });
});

describe('the Lockdown button', () => {
  it("locks the bot down for a keyholder, after which the admins' actions are refused", async () => {
    const { harness, review, report } = await approved();
    await review.pressData(IDS.secondKeyholder, noticeData({ kind: 'lockdown' }), 1, IDS.secondKeyholder);
    expect(lastAnswer(harness)).toBe(t('en', 'keyholder.lockdown_is_on'));
    expect(await isLockedDown(harness.config, harness.db)).toBe(true);
    expect(harness.log.records().map((record) => record.event)).toContain('lockdown.set');
    await review.pressData(IDS.keyholder, noticeData({ kind: 'lockdown' }), 1, IDS.keyholder);
    expect(lastAnswer(harness)).toBe(t('en', 'lockdown.already_on'));
    await review.press(IDS.admin, { kind: 'block', reportId: report.reportId }, report.cardId);
    expect(lastAnswer(harness)).toBe(t(V, 'admin.refused'));
  });

  it('is refused to an admin', async () => {
    const { harness, review } = await approved();
    await review.pressData(IDS.admin, noticeData({ kind: 'lockdown' }), 1, IDS.admin);
    expect(lastAnswer(harness)).toBe(t('en', 'error.unauthorized'));
    expect(await isLockedDown(harness.config, harness.db)).toBe(false);
  });
});

describe('Reject', () => {
  it('shows the reasons, then rejects: the card deleted, the counters raised, nothing to the reporter', async () => {
    const { harness, review, report } = await pending();
    const toReporter = reporterTexts(harness).length;
    await review.press(IDS.admin, { kind: 'reject', reportId: report.reportId }, report.cardId);
    expect(review.buttonsOf(review.card(report)).map((data) => parseReviewData(data)?.kind)).toEqual(['reason', 'reason', 'reason', 'reason', 'back']);
    await review.press(IDS.admin, { kind: 'reason', reportId: report.reportId, reason: 'weaponised' }, report.cardId);
    expect(lastAnswer(harness)).toBe(t(V, 'review.answer.rejected'));
    expect(await reportRow(harness.db, report.reportId)).toMatchObject({
      status: 'rejected',
      rejection_reason: 'weaponised',
      decided_by: IDS.admin,
      decided_at: harness.clock.now(),
      comment: null,
      affected_person: null,
      card_message_id: null,
    });
    const ref = await reporterRef(IDS.reporter, harness.config.reporterRefKey);
    expect(await harness.db.all(sql`SELECT rejections_30d FROM reporter_stats WHERE reporter_ref = ?`, [ref])).toEqual([{ rejections_30d: 1 }]);
    expect(review.card(report)).toBeUndefined();
    expect(reporterTexts(harness)).toHaveLength(toReporter);
  });

  it('edits the card to the outcome, without links, when it cannot be deleted', async () => {
    const { harness, review, report } = await pending();
    harness.telegram.fail({ method: 'deleteMessage', chatId: IDS.adminChat }, FAILURES.messageCantBeDeleted);
    await review.press(IDS.admin, { kind: 'reject', reportId: report.reportId }, report.cardId);
    await review.press(IDS.admin, { kind: 'reason', reportId: report.reportId, reason: 'no_violation' }, report.cardId);
    expect(review.card(report)).toMatchObject({ text: t(V, 'review.card.outcome', { id: report.reportId, outcome: t(V, 'status.rejected') }) });
    expect(review.card(report)?.reply_markup).toBeUndefined();
  });
});

describe('Route as suspected CSAM', () => {
  it('replaces the card with the routing card, in the venue only, and Confirm routes and deletes it', async () => {
    const { harness, review, report } = await pending();
    const toReporter = reporterTexts(harness).length;
    const sends = harness.telegram.calls.length;
    await review.press(IDS.admin, { kind: 'route', reportId: report.reportId }, report.cardId);
    expect(review.card(report)?.text).toContain(t(V, 'review.route.title', { id: report.reportId }));
    expect(review.card(report)?.text).toContain(`<code>${X_POST}</code>`);
    await review.press(IDS.admin, { kind: 'confirm_route', reportId: report.reportId }, report.cardId);
    expect(lastAnswer(harness)).toBe(t(V, 'review.answer.routed'));
    expect(await reportRow(harness.db, report.reportId)).toMatchObject({
      status: 'routed',
      category: 'csam',
      url: null,
      account_url: null,
      comment: null,
      affected_person: null,
      decided_by: IDS.admin,
    });
    expect(review.card(report)).toBeUndefined();
    // The link went to the venue and nowhere else.
    for (const call of harness.telegram.calls.slice(sends)) {
      if (call.method !== 'answerCallbackQuery') expect(call.chatId).toBe(IDS.adminChat);
    }
    expect(reporterTexts(harness)).toHaveLength(toReporter);
    expect(await harness.db.all(sql`SELECT * FROM approvals`)).toEqual([]);
  });

  it('goes Back from the routing card to the review', async () => {
    const { review, report } = await pending();
    await review.press(IDS.admin, { kind: 'route', reportId: report.reportId }, report.cardId);
    await review.press(IDS.admin, { kind: 'back', reportId: report.reportId }, report.cardId);
    expect(review.buttonsOf(review.card(report)).map((data) => parseReviewData(data)?.kind)).toEqual(['approve', 'reject', 'route', 'block']);
  });
});

describe('first decision wins', () => {
  it("tells a losing press the outcome, and leaves the winner's decision as it is", async () => {
    const { harness, review, report } = await pending();
    await review.press(IDS.admin, { kind: 'route', reportId: report.reportId }, report.cardId);
    harness.telegram.fail({ method: 'deleteMessage', chatId: IDS.adminChat }, FAILURES.messageCantBeDeleted);
    await review.press(IDS.secondAdmin, { kind: 'reject', reportId: report.reportId }, report.cardId);
    await review.press(IDS.secondAdmin, { kind: 'reason', reportId: report.reportId, reason: 'no_violation' }, report.cardId);
    await review.press(IDS.admin, { kind: 'confirm_route', reportId: report.reportId }, report.cardId);
    expect(lastAnswer(harness)).toBe(t(V, 'review.answer.decided', { state: t(V, 'status.rejected') }));
    expect(await reportRow(harness.db, report.reportId)).toMatchObject({ status: 'rejected' });
  });

  it("ends a losing reply: no approval, the prompt and the reply deleted", async () => {
    const { harness, review, report } = await pending();
    await review.press(IDS.admin, { kind: 'approve', reportId: report.reportId }, report.cardId);
    await review.press(IDS.admin, { kind: 'category', reportId: report.reportId, category: 'harassment' }, report.cardId);
    await review.press(IDS.admin, { kind: 'mode', reportId: report.reportId, category: 'harassment', mode: 'account' }, report.cardId);
    const prompt = review.lastPrompt();
    // The other admin rejects first, from the card shown under the prompt: the card is deleted, and so is the prompt.
    await harness.db.run(sql`UPDATE reports SET status = 'rejected' WHERE id = ?`, [report.reportId]);
    const replyId = await review.reply(IDS.admin, prompt?.message_id ?? 0, POINTS);
    expect(await harness.db.all(sql`SELECT * FROM approvals`)).toEqual([]);
    expect(await harness.db.all(sql`SELECT * FROM admin_prompts`)).toEqual([]);
    expect(harness.telegram.messageIn(IDS.adminChat, prompt?.message_id ?? 0)).toBeUndefined();
    expect(harness.telegram.messageIn(IDS.adminChat, replyId)).toBeUndefined();
    expect(harness.telegram.callsOf('sendMessage').filter((call) => call.chatId === IDS.keyholder)).toEqual([]);
  });
});

describe('Block reporter', () => {
  it("blocks the reporter's reference from the card, after which the intake refuses it", async () => {
    const { harness, review, report } = await pending();
    await review.press(IDS.admin, { kind: 'block', reportId: report.reportId }, report.cardId);
    expect(lastAnswer(harness)).toBe(t(V, 'review.answer.blocked'));
    await review.press(IDS.secondAdmin, { kind: 'block', reportId: report.reportId }, report.cardId);
    expect(lastAnswer(harness)).toBe(t(V, 'review.answer.already_blocked'));
    const ref = await reporterRef(IDS.reporter, harness.config.reporterRefKey);
    expect(await harness.db.all(sql`SELECT blocked FROM reporter_stats WHERE reporter_ref = ?`, [ref])).toEqual([{ blocked: 1 }]);
    await review.submit({ url: 'https://x.com/other/status/42', category: 'other', affected: false });
    expect(reporterTexts(harness).at(-1)).toBe(t('en', 'error.rate_limited'));
  });

  it('blocks from the status card too', async () => {
    const { harness, review, report, statusId } = await approved();
    await review.press(IDS.admin, { kind: 'block', reportId: report.reportId }, statusId);
    expect(lastAnswer(harness)).toBe(t(V, 'review.answer.blocked'));
  });
});

describe('the venue commands', () => {
  const venue = async (harness: BotHarness, adminId: number, text: string): Promise<string | undefined> => {
    await harness.send(groupMessage(IDS.adminChat, adminId, text));
    return harness.textsTo(IDS.adminChat).at(-1);
  };

  it('/open lists the open reports to an admin in the venue, and to a keyholder in their own chat, under lockdown too', async () => {
    const { harness, report } = await approved();
    const admin = await venue(harness, IDS.admin, '/open');
    expect(admin).toContain(`<code>${report.reportId}</code>`);
    expect(admin).not.toContain('https://');
    await setLockdown(harness.db, harness.clock);
    await harness.send(privateMessage(IDS.keyholder, '/open'));
    expect(harness.textsTo(IDS.keyholder).at(-1)).toContain(`<code>${report.reportId}</code>`);
    expect(await venue(harness, IDS.admin, '/open')).toBe(t(V, 'admin.refused'));
    // A keyholder's own command is kept: their chat is their operations log.
    expect(harness.telegram.callsOf('deleteMessage').filter((call) => call.chatId === IDS.keyholder)).toEqual([]);
  });

  it('/block and /unblock set and clear a reference, and explain themselves', async () => {
    const harness = botHarness();
    const ref = 'ab'.repeat(32);
    expect(await venue(harness, IDS.admin, '/block')).toBe(t(V, 'block.usage'));
    expect(await venue(harness, IDS.admin, `/block ${ref.toUpperCase()}`)).toBe(t(V, 'block.done'));
    expect(await venue(harness, IDS.admin, `/block ${ref}`)).toBe(t(V, 'block.already'));
    expect(await harness.db.all(sql`SELECT blocked FROM reporter_stats WHERE reporter_ref = ?`, [ref])).toEqual([{ blocked: 1 }]);
    expect(await venue(harness, IDS.secondAdmin, `/unblock ${ref}`)).toBe(t(V, 'unblock.done'));
    expect(await venue(harness, IDS.secondAdmin, `/unblock ${ref}`)).toBe(t(V, 'unblock.not_blocked'));
    expect(await venue(harness, IDS.admin, '/unblock 424240031')).toBe(t(V, 'unblock.usage'));
  });

  it('/card posts a pending report\'s card again, the old one deleted, and refuses anything else', async () => {
    const { harness, review, report } = await pending();
    await harness.send(groupMessage(IDS.adminChat, IDS.admin, `/card ${report.reportId}`));
    const row = await reportRow(harness.db, report.reportId);
    expect(row?.card_message_id).not.toBe(report.cardId);
    expect(review.card(report)).toBeUndefined();
    // A press on the old card is out of date.
    await review.press(IDS.admin, { kind: 'approve', reportId: report.reportId }, report.cardId);
    expect(lastAnswer(harness)).toBe(t(V, 'review.answer.stale_card'));
    expect(await venue(harness, IDS.admin, '/card nonsense')).toBe(t(V, 'card.usage'));
    expect(await venue(harness, IDS.admin, '/card abcdefghijklmnopqrst')).toBe(t(V, 'card.not_found'));
  });

  it('are no command from anyone but an admin, nor forwarded: nothing answers in the venue', async () => {
    const harness = botHarness();
    const before = await snapshot(harness.db);
    for (const update of [
      groupMessage(IDS.adminChat, IDS.reporter, `/block ${'ab'.repeat(32)}`),
      groupMessage(IDS.adminChat, IDS.keyholder, '/open'),
      groupMessage(IDS.adminChat, IDS.admin, `/block ${'ab'.repeat(32)}`, { forwarded: true }),
      groupMessage(IDS.membershipChat, IDS.admin, '/open'),
    ] as Update[]) {
      await harness.send(update);
    }
    expect(harness.telegram.calls).toEqual([]);
    expect(await snapshot(harness.db)).toEqual(before);
  });
});

describe('the decisions and the reporter', () => {
  it('never message the reporter, nor the channel: Approve, Cancel and Route', async () => {
    const harness = botHarness();
    const review = reviewIn(harness);
    const report = await review.submit({ url: X_POST, category: 'harassment', affected: false });
    const from = harness.telegram.calls.length;
    await review.approve(IDS.admin, report, { category: 'harassment', mode: 'account', points: POINTS });
    const approval = await harness.db.first<{ approval_id: string }>(sql`SELECT approval_id FROM approvals`);
    await review.press(IDS.admin, { kind: 'cancel', reportId: report.reportId, approvalId: approval?.approval_id ?? '' }, report.cardId);
    await review.press(IDS.admin, { kind: 'route', reportId: report.reportId }, report.cardId);
    await review.press(IDS.admin, { kind: 'confirm_route', reportId: report.reportId }, report.cardId);
    const decisions = harness.telegram.calls.slice(from);
    expect(decisions.length).toBeGreaterThan(10);
    expect(decisions.filter((call) => call.chatId === IDS.reporter || call.chatId === IDS.broadcastChannel)).toEqual([]);
  });

  it('never message the reporter at a rejection', async () => {
    const { harness, review, report } = await pending();
    const from = harness.telegram.calls.length;
    await harness.send(buttonPress(IDS.admin, `rv:rs:${report.reportId}:other`, { chatId: IDS.adminChat, messageId: report.cardId, chatType: 'supergroup' }));
    expect(await reportRow(harness.db, report.reportId)).toMatchObject({ status: 'rejected' });
    expect(harness.telegram.calls.slice(from).filter((call) => call.chatId === IDS.reporter)).toEqual([]);
    expect(review.card(report)).toBeUndefined();
  });
});

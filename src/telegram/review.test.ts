// Unit tests for the review's handlers (src/telegram/review.ts), the
// approval's conversation, driven through the composed bot over the fakes
// (test/support/bot-harness.ts, test/support/review-driver.ts): a report
// submitted through the real intake gets its card in the venue; Approve
// confirms the category (suspected CSAM routes, never approves), asks for
// the account link when the report has none, offers the allowed link
// modes, then the recommended points by a force-reply prompt; a refused
// reply gets a fresh prompt saying why and writes nothing; the approval
// notifies every keyholder first and, once one of them has the notice,
// writes its record, its job and the post, edits the card to Cancel, posts
// the status card and deletes the prompts and the reply; a reply whose
// notice reaches nobody is refused and writes nothing; a batch that loses
// or fails after the notices went out edits them to "cancelled" only when
// the approval surely did not land, and one that failed after committing
// goes on as approved; a keyholder's Cancel while the approval is on its
// way writes nothing and says so. A report that changes under an approval
// (an affected reporter's duplicate raising its flag; another admin's
// approval cleared it and a keyholder's Cancel) never gets a post-mode
// approval the report no longer allows: a stale mode press gets the modes
// as they are now, and a reply, or a batch, the report no longer allows
// starts again at the category, the notices withdrawn, a card edit that
// fails then logged by class and never answered with the generic error;
// neither a forged press nor a reply to a prompt row the routing table
// does not allow (intimate images with the post) passes it. And the gates on
// every press, reply and command (critical invariant 2). Cancel, Reject,
// Route, Block reporter and the commands are in
// src/telegram/review-decisions.test.ts.
import { describe, expect, it } from 'vitest';
import { FAILURES } from '../../test/fakes/bot-api';
import { botHarness, NOW, type BotHarness } from '../../test/support/bot-harness';
import { reviewIn, type ReviewDriver, type SubmittedReport } from '../../test/support/review-driver';
import { harnessOver, storeWith } from '../../test/support/review-store';
import { reportRow, snapshot } from '../../test/support/review-rows';
import { buttonPress, groupMessage, privateMessage } from '../../test/support/updates';
import { IDS } from '../../test/support/variables';
import { setLockdown } from '../auth/lockdown';
import { sql, type SqlDb } from '../db/sql';
import { AppError } from '../errors/app-error';
import { en } from '../i18n/en';
import { isPlainKey, LOCALES, t, type MessageKey } from '../i18n/index';
import { outgoingLinkProblems } from '../platforms/link-policy';
import { reporterRef } from '../privacy/reporter-ref';
import { parseNoticeData, parseReviewData, reviewData } from '../review/callbacks';
import { CATEGORIES, type LinkMode } from '../review/categories';
import { STATUS_NAME_KEYS } from '../review/names';
import { cancelledNoticeText, createNoticeMemory } from '../review/notify';
import { createPrompt } from '../review/prompts';
import { rejectStatements } from '../review/reject';
import { renderBilingualPost } from '../review/render-post';
import { REPORT_STATUSES } from '../review/reports';
import { reviewFeatures } from './review';

const X_POST = 'https://x.com/someone/status/1234567890';
const X_ACCOUNT = 'https://x.com/someone';
const IG_POST = 'https://www.instagram.com/p/AbC123xyz';
const COMMENT = 'they mock her every day';
const POINTS = 'Say it mocks a private person, and that it is repeated every day.';
const GRACE = 30 * 60_000;
/** The venue's one language, VENUE_LOCALE, Persian by default: every venue text and every answer to a venue press. */
const V = 'fa';

/** A harness, its review driver, and one X report of a post submitted by IDS.reporter. */
const submitted = async (
  answers: Partial<Parameters<ReviewDriver['submit']>[0]> = {},
  variables?: Readonly<Record<string, string>>,
): Promise<{ harness: BotHarness; review: ReviewDriver; report: SubmittedReport }> => {
  const harness = botHarness(variables === undefined ? {} : { variables });
  const review = reviewIn(harness);
  const report = await review.submit({ url: X_POST, category: 'harassment', affected: false, comment: COMMENT, ...answers });
  return { harness, review, report };
};

/** The texts the bot answered presses with, from call `from` on. */
const answers = (harness: BotHarness, from = 0) =>
  harness.telegram.calls.slice(from).filter((call) => call.method === 'answerCallbackQuery').map((call) => call.payload.text);
const cardText = (review: ReviewDriver, report: SubmittedReport) => review.card(report)?.text ?? '';

describe('the review card', () => {
  it('is posted to the venue at the submit, with the reference and never the reporter\'s id, username or name', async () => {
    const harness = botHarness();
    const review = reviewIn(harness);
    const report = await review.submit({ url: X_POST, category: 'harassment', affected: false, comment: COMMENT }, IDS.reporter, {
      username: 'reporter_handle',
      firstName: 'Reporter Name',
    });
    const text = cardText(review, report);
    expect(text).toContain(`<code>${report.reportId}</code>`);
    expect(text).toContain(`<code>${await reporterRef(IDS.reporter, harness.config.reporterRefKey)}</code>`);
    expect(text).toContain(`<code>${X_POST}</code>`);
    expect(text).toContain(`<code>${COMMENT}</code>`);
    for (const fragment of [String(IDS.reporter), 'reporter_handle', 'Reporter Name']) expect(text).not.toContain(fragment);
    expect(review.buttonsOf(review.card(report)).map((data) => parseReviewData(data)?.kind)).toEqual(['approve', 'reject', 'route', 'block']);
  });

  it('is posted once per target: a merged duplicate gets none', async () => {
    const { harness, review } = await submitted();
    await review.submit({ url: X_POST, category: 'other', affected: true }, IDS.stranger);
    expect(harness.telegram.callsOf('sendMessage').filter((call) => call.chatId === IDS.adminChat)).toHaveLength(1);
  });
});

describe('Approve', () => {
  it('confirms the category first, the reporter\'s label marked, then offers the modes the report allows', async () => {
    const { review, report } = await submitted();
    await review.press(IDS.admin, { kind: 'approve', reportId: report.reportId }, report.cardId);
    const buttons = review.buttonsOf(review.card(report)).map((data) => parseReviewData(data));
    expect(buttons).toEqual([...CATEGORIES.map((category) => ({ kind: 'category', reportId: report.reportId, category })), { kind: 'back', reportId: report.reportId }]);
    await review.press(IDS.admin, { kind: 'category', reportId: report.reportId, category: 'private_data' }, report.cardId);
    expect(review.buttonsOf(review.card(report)).map((data) => parseReviewData(data))).toEqual([
      { kind: 'mode', reportId: report.reportId, category: 'private_data', mode: 'account' },
      { kind: 'mode', reportId: report.reportId, category: 'private_data', mode: 'post' },
      { kind: 'back', reportId: report.reportId },
    ]);
  });

  it('offers the account link alone to the affected person, and for intimate images', async () => {
    const affected = await submitted({ affected: true });
    await affected.review.press(IDS.admin, { kind: 'approve', reportId: affected.report.reportId }, affected.report.cardId);
    await affected.review.press(IDS.admin, { kind: 'category', reportId: affected.report.reportId, category: 'harassment' }, affected.report.cardId);
    expect(affected.review.buttonsOf(affected.review.card(affected.report)).map((data) => parseReviewData(data)?.kind)).toEqual(['mode', 'back']);
    const intimate = await submitted();
    await intimate.review.press(IDS.admin, { kind: 'approve', reportId: intimate.report.reportId }, intimate.report.cardId);
    await intimate.review.press(IDS.admin, { kind: 'category', reportId: intimate.report.reportId, category: 'intimate_images' }, intimate.report.cardId);
    expect(intimate.review.buttonsOf(intimate.review.card(intimate.report))).toEqual([
      reviewData({ kind: 'mode', reportId: intimate.report.reportId, category: 'intimate_images', mode: 'account' }),
      reviewData({ kind: 'back', reportId: intimate.report.reportId }),
    ]);
  });

  it('refuses a link mode the report does not allow, a forged press, with nothing written', async () => {
    const { harness, review, report } = await submitted({ affected: true });
    await review.press(IDS.admin, { kind: 'approve', reportId: report.reportId }, report.cardId);
    const before = await snapshot(harness.db);
    await review.press(IDS.admin, { kind: 'mode', reportId: report.reportId, category: 'harassment', mode: 'post' }, report.cardId);
    await review.press(IDS.admin, { kind: 'mode', reportId: report.reportId, category: 'csam', mode: 'account' }, report.cardId);
    expect(answers(harness).slice(-2)).toEqual([t(V, 'review.answer.not_allowed'), t(V, 'review.answer.not_allowed')]);
    expect(await snapshot(harness.db)).toEqual(before);
    expect(review.lastPrompt()).toBeUndefined();
  });

  it("refuses a forged press of the post mode for intimate images on a report that is not the affected person's, the routing table's rule: no prompt, nothing written", async () => {
    const { harness, review, report } = await submitted({ affected: false });
    await review.press(IDS.admin, { kind: 'approve', reportId: report.reportId }, report.cardId);
    const before = await snapshot(harness.db);
    await review.press(IDS.admin, { kind: 'mode', reportId: report.reportId, category: 'intimate_images', mode: 'post' }, report.cardId);
    expect(answers(harness).at(-1)).toBe(t(V, 'review.answer.not_allowed'));
    expect(review.lastPrompt()).toBeUndefined();
    expect(await snapshot(harness.db)).toEqual(before);
    // The card offers what the category allows: the account link alone.
    expect(review.buttonsOf(review.card(report))).toEqual([
      reviewData({ kind: 'mode', reportId: report.reportId, category: 'intimate_images', mode: 'account' }),
      reviewData({ kind: 'back', reportId: report.reportId }),
    ]);
  });

  it("starts again at the category for a reply to a prompt recording intimate images with the post mode, the routing table's rule at the reply: nothing to a keyholder, nothing written", async () => {
    const { harness, review, report } = await submitted({ affected: false });
    // The report itself would allow the post: not the affected person's, a post URL distinct from the account's.
    expect(await reportRow(harness.db, report.reportId)).toMatchObject({ affected_person: 0, url: X_POST, account_url: X_ACCOUNT });
    // A prompt no flow writes (the press is refused), put in the real store, its message in the venue.
    const promptId = report.cardId + 100;
    harness.telegram.seedMessage(IDS.adminChat, { message_id: promptId, text: t(V, 'review.prompt.points', { id: report.reportId }) });
    await createPrompt(harness.db, {
      chatId: IDS.adminChat,
      promptMessageId: promptId,
      adminId: IDS.admin,
      reportId: report.reportId,
      kind: 'recommended_comment',
      category: 'intimate_images',
      linkMode: 'post',
      createdAt: harness.clock.now(),
    });
    const replyId = await review.reply(IDS.admin, promptId, POINTS);
    const keyholders: unknown[] = [IDS.keyholder, IDS.secondKeyholder];
    expect(harness.telegram.calls.filter((call) => keyholders.includes(call.chatId))).toEqual([]);
    expect(await harness.db.all(sql`SELECT * FROM approvals`)).toEqual([]);
    expect(await harness.db.all(sql`SELECT * FROM jobs`)).toEqual([]);
    expect(await reportRow(harness.db, report.reportId)).toMatchObject({ status: 'pending', link_mode: null, broadcast_text: null });
    expect(await harness.db.all(sql`SELECT * FROM admin_prompts`)).toEqual([]);
    expect(harness.telegram.messageIn(IDS.adminChat, promptId)).toBeUndefined();
    expect(harness.telegram.messageIn(IDS.adminChat, replyId)).toBeUndefined();
    expect(cardText(review, report)).toContain(t(V, 'review.step.category'));
    expect(review.buttonsOf(review.card(report)).map((data) => parseReviewData(data)?.kind)).toEqual([...CATEGORIES.map(() => 'category'), 'back']);
  });

  it('never approves suspected CSAM: its category leads to the routing card', async () => {
    const { harness, review, report } = await submitted({ category: 'csam' });
    await review.press(IDS.admin, { kind: 'approve', reportId: report.reportId }, report.cardId);
    await review.press(IDS.admin, { kind: 'category', reportId: report.reportId, category: 'csam' }, report.cardId);
    expect(cardText(review, report)).toContain(t(V, 'review.route.title', { id: report.reportId }));
    expect(review.buttonsOf(review.card(report)).map((data) => parseReviewData(data)?.kind)).toEqual(['confirm_route', 'back']);
    expect(review.lastPrompt()).toBeUndefined();
    expect(await harness.db.all(sql`SELECT * FROM approvals`)).toEqual([]);
  });

  it('writes the approval, its job and the post, notifies every keyholder, and cleans up the venue', async () => {
    const { harness, review, report } = await submitted();
    await review.approve(IDS.admin, report, { category: 'harassment', mode: 'post', points: POINTS });
    const approvedAt = harness.clock.now();
    const [approval] = await harness.db.all<{ approval_id: string; admin_id: number; approved_at: number; starts_at: number; link_mode: string; recommended_comment: string; voided_at: null }>(
      sql`SELECT approval_id, admin_id, approved_at, starts_at, link_mode, recommended_comment, voided_at FROM approvals`,
    );
    expect(approval).toEqual({
      approval_id: expect.stringMatching(/^[a-z]{20}$/) as string,
      admin_id: IDS.admin,
      approved_at: approvedAt,
      starts_at: approvedAt + GRACE,
      link_mode: 'post',
      recommended_comment: POINTS,
      voided_at: null,
    });
    const post = renderBilingualPost({ platform: 'x', category: 'harassment', url: X_POST, accountUrl: X_ACCOUNT }, { linkMode: 'post', recommendedComment: POINTS }, harness.config.allowedLinkHosts);
    expect(await reportRow(harness.db, report.reportId)).toMatchObject({
      status: 'approved',
      category: 'harassment',
      link_mode: 'post',
      broadcast_text: post.ok ? post.text : 'unrendered',
      comment: null,
      affected_person: null,
    });
    expect(await harness.db.all(sql`SELECT kind, due_at, payload FROM jobs`)).toEqual([
      { kind: 'post', due_at: approvedAt + GRACE, payload: JSON.stringify({ approval_id: approval?.approval_id }) },
    ]);
    // Every keyholder holds the post with Cancel, bound to the approval, and Lockdown.
    for (const keyholder of [IDS.keyholder, IDS.secondKeyholder]) {
      const [notice] = harness.telegram.messagesIn(keyholder);
      expect(notice?.text).toContain(post.ok ? post.text : 'unrendered');
      expect(review.buttonsOf(notice).map((data) => parseNoticeData(data))).toEqual([
        { kind: 'cancel', reportId: report.reportId, approvalId: approval?.approval_id },
        { kind: 'lockdown' },
      ]);
    }
    // The card shows Cancel; the status card is posted; the prompt and the reply are gone.
    expect(review.buttonsOf(review.card(report))).toEqual([reviewData({ kind: 'cancel', reportId: report.reportId, approvalId: approval?.approval_id ?? '' })]);
    const row = await reportRow(harness.db, report.reportId);
    const status = harness.telegram.messageIn(IDS.adminChat, Number(row?.status_message_id));
    expect(status?.text).toContain(t(V, 'review.status_card.notified', { sent: 2, total: 2 }));
    expect(review.buttonsOf(status).map((data) => parseReviewData(data)?.kind)).toEqual(['cancel', 'block']);
    const left = harness.telegram.messagesIn(IDS.adminChat).map((message) => message.message_id);
    expect(left).toEqual([report.cardId, Number(row?.status_message_id)]);
    expect(await harness.db.all(sql`SELECT * FROM admin_prompts`)).toEqual([]);
  });

  it('sends nothing to the reporter, the channel or the membership group', async () => {
    const { harness, review, report } = await submitted();
    const before = harness.telegram.calls.length;
    await review.approve(IDS.admin, report, { category: 'harassment', mode: 'account', points: POINTS });
    const chats = new Set(harness.telegram.calls.slice(before).map((call) => call.chatId));
    expect([...chats].filter((chat) => chat !== undefined).sort()).toEqual([IDS.adminChat, IDS.keyholder, IDS.secondKeyholder].sort());
  });

  it('asks for the account link a report lacks, refuses one that is no account of its platform, and takes one that is', async () => {
    const { harness, review, report } = await submitted({ url: IG_POST, account: 'unknown' });
    await review.press(IDS.admin, { kind: 'approve', reportId: report.reportId }, report.cardId);
    await review.press(IDS.admin, { kind: 'category', reportId: report.reportId, category: 'harassment' }, report.cardId);
    const first = review.lastPrompt();
    expect(first?.text).toContain(t(V, 'review.prompt.account', { id: report.reportId }));
    for (const [reply, refusal] of [
      ['not a link', 'review.refused.account_not_link'],
      ['https://bit.ly/abcdef', 'review.refused.account_policy'],
      [X_ACCOUNT, 'review.refused.account_link'],
      ['https://www.instagram.com/p/OtherPost12', 'review.refused.account_link'],
    ] as const) {
      const prompt = review.lastPrompt();
      const replyId = await review.reply(IDS.admin, prompt?.message_id ?? 0, reply);
      const next = review.lastPrompt();
      expect(next?.text?.startsWith(t(V, refusal)), reply).toBe(true);
      expect(next?.message_id).not.toBe(prompt?.message_id);
      expect(harness.telegram.messageIn(IDS.adminChat, prompt?.message_id ?? 0)).toBeUndefined();
      expect(harness.telegram.messageIn(IDS.adminChat, replyId)).toBeUndefined();
      expect(await reportRow(harness.db, report.reportId)).toMatchObject({ account_url: null });
    }
    await review.reply(IDS.admin, review.lastPrompt()?.message_id ?? 0, 'https://instagram.com/the.account/?hl=en');
    expect(await reportRow(harness.db, report.reportId)).toMatchObject({ account_url: 'https://www.instagram.com/the.account', status: 'pending' });
    expect(review.lastPrompt()).toBeUndefined();
    expect(review.buttonsOf(review.card(report)).map((data) => parseReviewData(data)?.kind)).toEqual(['mode', 'mode', 'back']);
    expect(await harness.db.all(sql`SELECT * FROM admin_prompts`)).toEqual([]);
  });

  it.each([
    ['a URL', 'Report it at https://help.x.com/ now', 'review.refused.url'],
    ['a bare domain', 'See example.com for more', 'review.refused.domain'],
    ['a mention', 'Ask @someone about it', 'review.refused.mention'],
    ['t.me', 'Find them on t.me first', 'review.refused.domain'],
    ['a phone number', 'Call 0912 345 6789 to help', 'review.refused.phone'],
    ['301 characters', 'a'.repeat(301), 'review.refused.too_long'],
    ['nothing but spaces', '   ', 'review.refused.empty'],
  ] as const)('refuses points holding %s with a fresh prompt saying why, and writes nothing', async (_label, points, refusal) => {
    const { harness, review, report } = await submitted();
    await review.press(IDS.admin, { kind: 'approve', reportId: report.reportId }, report.cardId);
    await review.press(IDS.admin, { kind: 'category', reportId: report.reportId, category: 'harassment' }, report.cardId);
    await review.press(IDS.admin, { kind: 'mode', reportId: report.reportId, category: 'harassment', mode: 'account' }, report.cardId);
    const prompt = review.lastPrompt();
    const before = await snapshot(harness.db);
    const replyId = await review.reply(IDS.admin, prompt?.message_id ?? 0, points);
    const lead = refusal === 'review.refused.too_long' ? t(V, refusal, { length: 301 }) : t(V, refusal);
    expect(review.lastPrompt()?.text).toBe(`${lead}\n\n${t(V, 'review.prompt.points', { id: report.reportId })}`);
    expect(harness.telegram.messageIn(IDS.adminChat, replyId)).toBeUndefined();
    expect(harness.telegram.messageIn(IDS.adminChat, prompt?.message_id ?? 0)).toBeUndefined();
    const after = await snapshot(harness.db);
    expect({ ...after, admin_prompts: [] }).toEqual({ ...before, admin_prompts: [] });
    expect(after.admin_prompts).toEqual([expect.objectContaining({ prompt_message_id: review.lastPrompt()?.message_id, kind: 'recommended_comment', category: 'harassment', link_mode: 'account' })]);
    expect(harness.telegram.callsOf('sendMessage').filter((call) => call.chatId === IDS.keyholder)).toEqual([]);
  });

  it('takes 300 characters of points, the bound, and a sentence of the warning line\'s own words', async () => {
    for (const points of ['b'.repeat(300), t('en', 'post.warning')]) {
      const { harness, review, report } = await submitted();
      await review.approve(IDS.admin, report, { category: 'harassment', mode: 'account', points });
      expect(await reportRow(harness.db, report.reportId), points.slice(0, 10)).toMatchObject({ status: 'approved' });
    }
  });

  it('refuses a reply that is not a text', async () => {
    const { harness, review, report } = await submitted();
    await review.press(IDS.admin, { kind: 'approve', reportId: report.reportId }, report.cardId);
    await review.press(IDS.admin, { kind: 'category', reportId: report.reportId, category: 'harassment' }, report.cardId);
    await review.press(IDS.admin, { kind: 'mode', reportId: report.reportId, category: 'harassment', mode: 'account' }, report.cardId);
    const prompt = review.lastPrompt();
    const update = groupMessage(IDS.adminChat, IDS.admin, 'x', { replyToBot: prompt?.message_id ?? 0 });
    // The same reply, carrying a photo instead of a text.
    const photo = Object.fromEntries(Object.entries(update.message ?? {}).filter(([key]) => key !== 'text' && key !== 'entities'));
    await review.sendVenue({ ...update, message: { ...photo, photo: [{ file_id: 'f', file_unique_id: 'u', width: 1, height: 1 }] } } as typeof update);
    expect(review.lastPrompt()?.text?.startsWith(t(V, 'review.refused.not_text'))).toBe(true);
    expect(await reportRow(harness.db, report.reportId)).toMatchObject({ status: 'pending' });
  });

  it('refuses a post that would not fit Telegram with its notice', async () => {
    const long = `https://leak-site.org/people/${'p'.repeat(1700)}`;
    const { harness, review, report } = await submitted(
      { url: long, account: 'https://leak-site.org/people', category: 'other' },
      { ALLOWED_LINK_HOSTS: 'x.com,leak-site.org' },
    );
    await review.press(IDS.admin, { kind: 'approve', reportId: report.reportId }, report.cardId);
    await review.press(IDS.admin, { kind: 'category', reportId: report.reportId, category: 'other' }, report.cardId);
    await review.press(IDS.admin, { kind: 'mode', reportId: report.reportId, category: 'other', mode: 'post' }, report.cardId);
    await review.reply(IDS.admin, review.lastPrompt()?.message_id ?? 0, POINTS);
    const refused = review.lastPrompt()?.text ?? '';
    const excess = /[0-9]+/.exec(refused)?.[0] ?? 'none';
    expect(refused.startsWith(t(V, 'review.refused.post_too_long', { excess }))).toBe(true);
    expect(Number(excess)).toBeGreaterThan(0);
    expect(await reportRow(harness.db, report.reportId)).toMatchObject({ status: 'pending' });
  });

  it('goes Back to the review, deleting the presser\'s open prompt', async () => {
    const { harness, review, report } = await submitted();
    await review.press(IDS.admin, { kind: 'approve', reportId: report.reportId }, report.cardId);
    await review.press(IDS.admin, { kind: 'category', reportId: report.reportId, category: 'harassment' }, report.cardId);
    await review.press(IDS.admin, { kind: 'mode', reportId: report.reportId, category: 'harassment', mode: 'account' }, report.cardId);
    const prompt = review.lastPrompt();
    await review.press(IDS.admin, { kind: 'back', reportId: report.reportId }, report.cardId);
    expect(harness.telegram.messageIn(IDS.adminChat, prompt?.message_id ?? 0)).toBeUndefined();
    expect(await harness.db.all(sql`SELECT * FROM admin_prompts`)).toEqual([]);
    expect(review.buttonsOf(review.card(report)).map((data) => parseReviewData(data)?.kind)).toEqual(['approve', 'reject', 'route', 'block']);
  });

  it('keeps one approval prompt per admin and report: a new one replaces the old', async () => {
    const { harness, review, report } = await submitted();
    await review.press(IDS.admin, { kind: 'approve', reportId: report.reportId }, report.cardId);
    await review.press(IDS.admin, { kind: 'category', reportId: report.reportId, category: 'harassment' }, report.cardId);
    await review.press(IDS.admin, { kind: 'mode', reportId: report.reportId, category: 'harassment', mode: 'account' }, report.cardId);
    const first = review.lastPrompt();
    await review.press(IDS.admin, { kind: 'mode', reportId: report.reportId, category: 'harassment', mode: 'post' }, report.cardId);
    expect(harness.telegram.messageIn(IDS.adminChat, first?.message_id ?? 0)).toBeUndefined();
    expect(await harness.db.all(sql`SELECT link_mode FROM admin_prompts`)).toEqual([{ link_mode: 'post' }]);
  });
});

describe('the gates (critical invariant 2)', () => {
  it('refuse a press by an id outside ADMIN_IDS, a keyholder\'s included, and change nothing', async () => {
    const { harness, review, report } = await submitted();
    const before = await snapshot(harness.db);
    const from = harness.telegram.calls.length;
    for (const id of [IDS.reporter, IDS.stranger, IDS.keyholder]) {
      await review.press(id, { kind: 'approve', reportId: report.reportId }, report.cardId);
      await review.press(id, { kind: 'reason', reportId: report.reportId, reason: 'no_violation' }, report.cardId);
    }
    expect(answers(harness, from)).toEqual(Array.from({ length: 6 }, () => t(V, 'error.unauthorized')));
    expect(await snapshot(harness.db)).toEqual(before);
    expect(review.buttonsOf(review.card(report)).map((data) => parseReviewData(data)?.kind)).toEqual(['approve', 'reject', 'route', 'block']);
  });

  it('refuse an admin\'s press on a message outside the venue, and on an older card of the report', async () => {
    const { harness, review, report } = await submitted();
    const from = harness.telegram.calls.length;
    await review.pressData(IDS.admin, reviewData({ kind: 'approve', reportId: report.reportId }), 3, IDS.admin);
    await review.press(IDS.admin, { kind: 'approve', reportId: report.reportId }, report.cardId + 50);
    expect(answers(harness, from)).toEqual([t('en', 'error.unauthorized'), t(V, 'review.answer.stale_card')]);
  });

  it('refuse every admin action under lockdown, a press, a reply and a command alike', async () => {
    const { harness, review, report } = await submitted();
    await review.press(IDS.admin, { kind: 'approve', reportId: report.reportId }, report.cardId);
    await review.press(IDS.admin, { kind: 'category', reportId: report.reportId, category: 'harassment' }, report.cardId);
    await review.press(IDS.admin, { kind: 'mode', reportId: report.reportId, category: 'harassment', mode: 'account' }, report.cardId);
    const prompt = review.lastPrompt();
    await setLockdown(harness.db, harness.clock);
    const before = await snapshot(harness.db);
    const calls = harness.telegram.calls.length;
    await review.press(IDS.admin, { kind: 'back', reportId: report.reportId }, report.cardId);
    await review.reply(IDS.admin, prompt?.message_id ?? 0, POINTS);
    await review.sendVenue(groupMessage(IDS.adminChat, IDS.admin, '/open'));
    expect(harness.telegram.calls.slice(calls).map((call) => [call.method, call.chatId, call.payload.text])).toEqual([
      ['answerCallbackQuery', undefined, t(V, 'admin.refused')],
      ['sendMessage', IDS.adminChat, t(V, 'admin.refused')],
      ['sendMessage', IDS.adminChat, t(V, 'admin.refused')],
    ]);
    expect(await snapshot(harness.db)).toEqual(before);
  });

  it('ignore a reply from anyone but the admin who was asked', async () => {
    const { harness, review, report } = await submitted();
    await review.press(IDS.admin, { kind: 'approve', reportId: report.reportId }, report.cardId);
    await review.press(IDS.admin, { kind: 'category', reportId: report.reportId, category: 'harassment' }, report.cardId);
    await review.press(IDS.admin, { kind: 'mode', reportId: report.reportId, category: 'harassment', mode: 'account' }, report.cardId);
    const prompt = review.lastPrompt();
    const before = await snapshot(harness.db);
    const calls = harness.telegram.calls.length;
    for (const id of [IDS.reporter, IDS.keyholder, IDS.secondAdmin]) await review.reply(id, prompt?.message_id ?? 0, POINTS);
    await review.reply(IDS.admin, prompt?.message_id ?? 0, POINTS, { forwarded: true });
    expect(harness.telegram.calls.slice(calls)).toEqual([]);
    expect(await snapshot(harness.db)).toEqual(before);
  });

  it("treat an admin's command typed in a private chat as no command: deleted, the fallback answer", async () => {
    const harness = botHarness();
    for (const command of ['/open', '/block aaaa', '/card abcdefghijklmnopqrst']) {
      const messageId = harness.telegram.receive(IDS.admin, { text: command });
      const update = privateMessage(IDS.admin, command);
      await harness.send({ ...update, message: { ...update.message, message_id: messageId } } as typeof update);
      expect(harness.telegram.messageIn(IDS.admin, messageId), command).toBeUndefined();
    }
    expect(harness.textsTo(IDS.admin)).toEqual(Array.from({ length: 3 }, () => t('en', 'fallback.help')));
  });

  it('answer a press of another unit\'s data, or data the flow does not take, empty', async () => {
    const { harness, report } = await submitted();
    await harness.send(buttonPress(IDS.admin, `rv:ap:${report.reportId}:x`, { chatId: IDS.adminChat, messageId: report.cardId, chatType: 'supergroup' }));
    expect(harness.telegram.callsOf('answerCallbackQuery').at(-1)?.payload).toEqual({ callback_query_id: expect.any(String) as string });
  });
});

describe('every message of the review', () => {
  it('leaves with previews off and HTML, and links only to the lists', async () => {
    const { harness, review, report } = await submitted({ url: IG_POST, account: 'unknown' });
    await review.approve(IDS.admin, report, { category: 'private_data', account: 'https://www.instagram.com/the.account', mode: 'post', points: POINTS });
    const texts = harness.telegram.calls.filter((call) => call.method === 'sendMessage' || call.method === 'editMessageText');
    expect(texts.length).toBeGreaterThan(8);
    for (const call of texts) {
      expect(call.payload.link_preview_options).toEqual({ is_disabled: true });
      expect(call.payload.parse_mode).toBe('HTML');
      expect(outgoingLinkProblems(String(call.payload.text), harness.config.allowedLinkHosts)).toEqual([]);
    }
  });

  it('survives a keyholder it cannot reach, and says so on the status card', async () => {
    const { harness, review, report } = await submitted();
    harness.telegram.fail({ chatId: IDS.secondKeyholder }, FAILURES.cantInitiateConversation);
    await review.approve(IDS.admin, report, { category: 'harassment', mode: 'account', points: POINTS });
    const row = await reportRow(harness.db, report.reportId);
    expect(row).toMatchObject({ status: 'approved' });
    expect(harness.telegram.messageIn(IDS.adminChat, Number(row?.status_message_id))?.text).toContain(
      t(V, 'review.status_card.notified', { sent: 1, total: 2 }),
    );
    expect(harness.log.records().map((record) => record.event)).toEqual(['alert.failed', 'review.notice_incomplete']);
  });
});

describe("the venue's one language", () => {
  it('is Persian by default for the card posted at intake, and English under VENUE_LOCALE=en', async () => {
    for (const [variables, locale] of [[undefined, 'fa'], [{ VENUE_LOCALE: 'en' }, 'en']] as const) {
      const { review, report } = await submitted({}, variables);
      expect(cardText(review, report)).toContain(t(locale, 'review.card.hint', { category: t(locale, 'review.category.harassment') }));
    }
  });

  it("keeps the card in Persian when an admin whose app is in English presses, and answers in Persian too", async () => {
    const { harness, review, report } = await submitted();
    await review.press(IDS.admin, { kind: 'approve', reportId: report.reportId }, report.cardId, { languageCode: 'en' });
    expect(cardText(review, report)).toContain(t('fa', 'review.step.category'));
    expect(cardText(review, report)).not.toContain(t('en', 'review.step.category'));
    await review.press(IDS.admin, { kind: 'approve', reportId: report.reportId }, report.cardId + 50, { languageCode: 'en' });
    expect(answers(harness).at(-1)).toBe(t('fa', 'review.answer.stale_card'));
    await review.press(IDS.admin, { kind: 'category', reportId: report.reportId, category: 'harassment' }, report.cardId, { languageCode: 'en' });
    await review.press(IDS.admin, { kind: 'mode', reportId: report.reportId, category: 'harassment', mode: 'account' }, report.cardId, { languageCode: 'en' });
    expect(review.lastPrompt()?.text).toBe(t('fa', 'review.prompt.points', { id: report.reportId }));
    await review.reply(IDS.admin, review.lastPrompt()?.message_id ?? 0, POINTS, { languageCode: 'en' });
    const row = await reportRow(harness.db, report.reportId);
    expect(harness.telegram.messageIn(IDS.adminChat, Number(row?.status_message_id))?.text).toContain(t('fa', 'review.status_card.notified', { sent: 2, total: 2 }));
  });

  it("answers a keyholder's /open in the keyholder's own language", async () => {
    const harness = botHarness();
    await harness.send(privateMessage(IDS.keyholder, '/open', { languageCode: 'en' }));
    await harness.send(privateMessage(IDS.secondKeyholder, '/open', { languageCode: 'fa' }));
    expect(harness.textsTo(IDS.keyholder)).toEqual([t('en', 'open.none')]);
    expect(harness.textsTo(IDS.secondKeyholder)).toEqual([t('fa', 'open.none')]);
  });
});

/**
 * A harness whose review (not the intake) runs over `over(the harness's
 * store, the harness)` (test/support/review-store.ts), its driver, and one
 * X report of IDS.reporter's.
 */
const submittedOver = async (over: (db: SqlDb, harness: () => BotHarness) => SqlDb) => {
  const harness = harnessOver(over);
  const review = reviewIn(harness);
  const report = await review.submit({ url: X_POST, category: 'harassment', affected: false, comment: COMMENT });
  return { harness, review, report };
};

/** Approve, the category and `mode` (the account link unless given) pressed by IDS.admin on `report`'s card: the points prompt is out. */
const toPoints = async (review: ReviewDriver, report: SubmittedReport, mode: LinkMode = 'account'): Promise<void> => {
  await review.press(IDS.admin, { kind: 'approve', reportId: report.reportId }, report.cardId);
  await review.press(IDS.admin, { kind: 'category', reportId: report.reportId, category: 'harassment' }, report.cardId);
  await review.press(IDS.admin, { kind: 'mode', reportId: report.reportId, category: 'harassment', mode }, report.cardId);
};

/** The kinds of the buttons the card of `report` shows. */
const cardKinds = (review: ReviewDriver, report: SubmittedReport) => review.buttonsOf(review.card(report)).map((data) => parseReviewData(data)?.kind);

describe('an approval whose notice reaches no keyholder', () => {
  it.each([
    ['every send answers 403', FAILURES.cantInitiateConversation],
    ['every send times out, an ambiguous answer included', FAILURES.timeout],
  ] as const)('is never written when %s: the reply is refused by a fresh prompt saying why', async (_label, failure) => {
    const { harness, review, report } = await submitted();
    await toPoints(review, report);
    for (const keyholder of [IDS.keyholder, IDS.secondKeyholder]) harness.telegram.fail({ chatId: keyholder }, failure);
    const prompt = review.lastPrompt();
    const before = await snapshot(harness.db);
    const replyId = await review.reply(IDS.admin, prompt?.message_id ?? 0, POINTS);
    // Nothing written: no approval row, no job, the report pending without its post.
    const after = await snapshot(harness.db);
    expect({ ...after, admin_prompts: [] }).toEqual({ ...before, admin_prompts: [] });
    expect(await harness.db.all(sql`SELECT * FROM approvals`)).toEqual([]);
    expect(await harness.db.all(sql`SELECT * FROM jobs`)).toEqual([]);
    expect(await reportRow(harness.db, report.reportId)).toMatchObject({ status: 'pending', broadcast_text: null, link_mode: null, status_message_id: null });
    // The prompt stays live, as a fresh one with the lead; the old one and the reply are gone.
    expect(review.lastPrompt()?.text).toBe(`${t(V, 'review.refused.unnotified')}\n\n${t(V, 'review.prompt.points', { id: report.reportId })}`);
    expect(after.admin_prompts).toEqual([
      expect.objectContaining({ prompt_message_id: review.lastPrompt()?.message_id, kind: 'recommended_comment', category: 'harassment', link_mode: 'account' }),
    ]);
    expect(harness.telegram.messageIn(IDS.adminChat, prompt?.message_id ?? 0)).toBeUndefined();
    expect(harness.telegram.messageIn(IDS.adminChat, replyId)).toBeUndefined();
    expect(review.buttonsOf(review.card(report)).map((data) => parseReviewData(data)?.kind)).not.toContain('cancel');
    expect(harness.notices.size).toBe(0);
    expect(harness.log.records().filter((record) => record.event === 'review.notice_unreached')).toEqual([
      { level: 'info', event: 'review.notice_unreached', reportId: report.reportId, sent: 0, failed: 2 },
    ]);
  });

  it('is written once a keyholder is reachable, by a reply to the fresh prompt', async () => {
    const { harness, review, report } = await submitted();
    await toPoints(review, report);
    for (const keyholder of [IDS.keyholder, IDS.secondKeyholder]) harness.telegram.fail({ chatId: keyholder }, FAILURES.cantInitiateConversation, 1);
    await review.reply(IDS.admin, review.lastPrompt()?.message_id ?? 0, POINTS);
    expect(await reportRow(harness.db, report.reportId)).toMatchObject({ status: 'pending' });
    await review.reply(IDS.admin, review.lastPrompt()?.message_id ?? 0, POINTS);
    expect(await reportRow(harness.db, report.reportId)).toMatchObject({ status: 'approved' });
    expect(await harness.db.all(sql`SELECT voided_at FROM approvals`)).toEqual([{ voided_at: null }]);
    expect(await harness.db.all(sql`SELECT count(*) AS n FROM jobs`)).toEqual([{ n: 1 }]);
    expect(review.noticesOf(report.reportId)).toHaveLength(2);
  });

  it('stands when one keyholder of two got the notice, and the status card says 1 of 2', async () => {
    const { harness, review, report } = await submitted();
    harness.telegram.fail({ chatId: IDS.keyholder }, FAILURES.botBlocked);
    await review.approve(IDS.admin, report, { category: 'harassment', mode: 'account', points: POINTS });
    const row = await reportRow(harness.db, report.reportId);
    expect(row).toMatchObject({ status: 'approved' });
    expect(await harness.db.all(sql`SELECT count(*) AS n FROM jobs`)).toEqual([{ n: 1 }]);
    expect(harness.telegram.messageIn(IDS.adminChat, Number(row?.status_message_id))?.text).toContain(t(V, 'review.status_card.notified', { sent: 1, total: 2 }));
    expect(harness.log.records().map((record) => record.event)).not.toContain('review.notice_unreached');
  });

  it('is refused, the failure logged by class, when the notice cannot be sent at all', async () => {
    const harness = botHarness({
      features: (deps) => [
        reviewFeatures({
          ...deps,
          notices: {
            ...createNoticeMemory(),
            remember: () => {
              throw new AppError('UNEXPECTED', 'the memory is full');
            },
          },
        }),
      ],
    });
    const review = reviewIn(harness);
    const report = await review.submit({ url: X_POST, category: 'harassment', affected: false, comment: COMMENT });
    await review.approve(IDS.admin, report, { category: 'harassment', mode: 'account', points: POINTS });
    expect(await harness.db.all(sql`SELECT * FROM approvals`)).toEqual([]);
    expect(review.lastPrompt()?.text?.startsWith(t(V, 'review.refused.unnotified'))).toBe(true);
    const lines = harness.log.records().filter((record) => String(record.event).startsWith('review.notice'));
    expect(lines).toEqual([
      { level: 'error', event: 'review.notice_failed', reportId: report.reportId, errorClass: 'AppError', errorCode: 'UNEXPECTED' },
      { level: 'info', event: 'review.notice_unreached', reportId: report.reportId, sent: 0, failed: 2 },
    ]);
  });
});

describe('an approval whose batch does not win after its notices went out', () => {
  it('edits the notices to "cancelled" when another decision won meanwhile, and ends the prompt', async () => {
    const { harness, review, report } = await submittedOver((db, self) =>
      storeWith(db, {
        batch: async (statements) => {
          await db.batch(rejectStatements(report.reportId, 'other', IDS.secondAdmin, self().clock.now()));
          return db.batch(statements);
        },
      }),
    );
    await toPoints(review, report);
    const prompt = review.lastPrompt();
    const replyId = await review.reply(IDS.admin, prompt?.message_id ?? 0, POINTS);
    expect(await reportRow(harness.db, report.reportId)).toMatchObject({ status: 'rejected' });
    expect(await harness.db.all(sql`SELECT * FROM approvals`)).toEqual([]);
    expect(await harness.db.all(sql`SELECT * FROM jobs`)).toEqual([]);
    expect(await harness.db.all(sql`SELECT * FROM admin_prompts`)).toEqual([]);
    for (const keyholder of [IDS.keyholder, IDS.secondKeyholder]) {
      expect(harness.telegram.messageIn(keyholder, 1)).toMatchObject({ text: cancelledNoticeText(report.reportId) });
      expect(harness.telegram.messageIn(keyholder, 1)?.reply_markup).toBeUndefined();
    }
    expect(harness.telegram.messageIn(IDS.adminChat, prompt?.message_id ?? 0)).toBeUndefined();
    expect(harness.telegram.messageIn(IDS.adminChat, replyId)).toBeUndefined();
    expect(review.buttonsOf(review.card(report)).map((data) => parseReviewData(data)?.kind)).not.toContain('cancel');
  });

  it("writes no post-mode approval once an affected reporter's duplicate raised the flag meanwhile: the notices \"cancelled\", the card back at the category", async () => {
    let fired = false;
    const { harness, review, report } = await submittedOver((db, self) =>
      storeWith(db, {
        batch: async (statements) => {
          if (!fired) {
            fired = true;
            // The notices are out, the batch on its way: the affected person's duplicate of the target lands now, through the intake.
            await reviewIn(self()).submit({ url: X_POST, category: 'harassment', affected: true, comment: 'it is my account' }, IDS.stranger);
          }
          return db.batch(statements);
        },
      }),
    );
    await toPoints(review, report, 'post');
    const prompt = review.lastPrompt();
    const replyId = await review.reply(IDS.admin, prompt?.message_id ?? 0, POINTS);
    expect(fired).toBe(true);
    expect(await harness.db.all(sql`SELECT * FROM approvals`)).toEqual([]);
    expect(await harness.db.all(sql`SELECT * FROM jobs`)).toEqual([]);
    expect(await reportRow(harness.db, report.reportId)).toMatchObject({ status: 'pending', affected_person: 1, link_mode: null, broadcast_text: null });
    expect(await harness.db.all(sql`SELECT status, merged_into FROM reports WHERE id <> ?`, [report.reportId])).toEqual([{ status: 'merged', merged_into: report.reportId }]);
    for (const keyholder of [IDS.keyholder, IDS.secondKeyholder]) {
      expect(harness.telegram.messageIn(keyholder, 1)).toMatchObject({ text: cancelledNoticeText(report.reportId) });
      expect(harness.telegram.messageIn(keyholder, 1)?.reply_markup).toBeUndefined();
    }
    expect(harness.telegram.messageIn(IDS.adminChat, prompt?.message_id ?? 0)).toBeUndefined();
    expect(harness.telegram.messageIn(IDS.adminChat, replyId)).toBeUndefined();
    expect(await harness.db.all(sql`SELECT * FROM admin_prompts`)).toEqual([]);
    // The card at the category step, the raised flag on it.
    expect(cardText(review, report)).toContain(t(V, 'review.step.category'));
    expect(cardText(review, report)).toContain(t(V, 'review.card.affected_yes'));
    expect(cardKinds(review, report)).toEqual([...CATEGORIES.map(() => 'category'), 'back']);
    // Approving again offers the account link alone, and takes it.
    await review.press(IDS.admin, { kind: 'category', reportId: report.reportId, category: 'harassment' }, report.cardId);
    expect(review.buttonsOf(review.card(report))).toEqual([
      reviewData({ kind: 'mode', reportId: report.reportId, category: 'harassment', mode: 'account' }),
      reviewData({ kind: 'back', reportId: report.reportId }),
    ]);
    await review.press(IDS.admin, { kind: 'mode', reportId: report.reportId, category: 'harassment', mode: 'account' }, report.cardId);
    await review.reply(IDS.admin, review.lastPrompt()?.message_id ?? 0, POINTS);
    expect(await reportRow(harness.db, report.reportId)).toMatchObject({ status: 'approved', link_mode: 'account' });
    expect(harness.log.records().filter((record) => record.level === 'error')).toEqual([]);
  });

  it('ends such a lost approval all the same when the card cannot be edited after the batch: the failure logged by class, no generic error in the venue', async () => {
    let fired = false;
    const { harness, review, report } = await submittedOver((db, self) =>
      storeWith(db, {
        batch: async (statements) => {
          if (!fired) {
            fired = true;
            await reviewIn(self()).submit({ url: X_POST, category: 'harassment', affected: true, comment: 'it is my account' }, IDS.stranger);
            // The venue's next edit, the card's once the batch has lost, fails.
            self().telegram.fail({ method: 'editMessageText', chatId: IDS.adminChat }, FAILURES.serverError, 1);
          }
          return db.batch(statements);
        },
      }),
    );
    await toPoints(review, report, 'post');
    const prompt = review.lastPrompt();
    const replyId = await review.reply(IDS.admin, prompt?.message_id ?? 0, POINTS);
    expect(fired).toBe(true);
    expect(await harness.db.all(sql`SELECT * FROM approvals`)).toEqual([]);
    expect(await harness.db.all(sql`SELECT * FROM jobs`)).toEqual([]);
    expect(await reportRow(harness.db, report.reportId)).toMatchObject({ status: 'pending', affected_person: 1 });
    for (const keyholder of [IDS.keyholder, IDS.secondKeyholder]) {
      expect(harness.telegram.messageIn(keyholder, 1)).toMatchObject({ text: cancelledNoticeText(report.reportId) });
      expect(harness.telegram.messageIn(keyholder, 1)?.reply_markup).toBeUndefined();
    }
    expect(harness.telegram.messageIn(IDS.adminChat, prompt?.message_id ?? 0)).toBeUndefined();
    expect(harness.telegram.messageIn(IDS.adminChat, replyId)).toBeUndefined();
    expect(await harness.db.all(sql`SELECT * FROM admin_prompts`)).toEqual([]);
    // The edit that failed is the card's: the venue's last edit, and the card is not at the category step.
    expect(harness.telegram.callsOf('editMessageText').filter((call) => call.chatId === IDS.adminChat).at(-1)?.payload.message_id).toBe(report.cardId);
    expect(cardText(review, report)).not.toContain(t(V, 'review.step.category'));
    expect(harness.log.records().filter((record) => record.level === 'error')).toEqual([
      { level: 'error', event: 'review.message_not_edited', errorClass: 'GrammyError', telegramErrorCode: 502, apiMethod: 'editMessageText' },
    ]);
    for (const locale of LOCALES) expect(harness.textsTo(IDS.adminChat)).not.toContain(t(locale, 'error.unexpected'));
  });

  it("still writes the post-mode approval when the duplicate that lands meanwhile is not the affected person's", async () => {
    let fired = false;
    const { harness, review, report } = await submittedOver((db, self) =>
      storeWith(db, {
        batch: async (statements) => {
          if (!fired) {
            fired = true;
            await reviewIn(self()).submit({ url: X_POST, category: 'harassment', affected: false }, IDS.stranger);
          }
          return db.batch(statements);
        },
      }),
    );
    await toPoints(review, report, 'post');
    await review.reply(IDS.admin, review.lastPrompt()?.message_id ?? 0, POINTS);
    expect(fired).toBe(true);
    expect(await harness.db.all(sql`SELECT status FROM reports WHERE id <> ?`, [report.reportId])).toEqual([{ status: 'merged' }]);
    expect(await reportRow(harness.db, report.reportId)).toMatchObject({ status: 'approved', link_mode: 'post' });
    expect(await harness.db.all(sql`SELECT link_mode, voided_at FROM approvals`)).toEqual([{ link_mode: 'post', voided_at: null }]);
  });

  it("writes no post-mode approval over another admin's approval that a keyholder cancelled meanwhile: that voided row untouched, the notices withdrawn, the card back at the category", async () => {
    let fired = false;
    const meanwhile: { approvals?: unknown[]; cancelled?: unknown; firstNoticesLive?: boolean[] } = {};
    const { harness, review, report } = await submittedOver((db, self) =>
      storeWith(db, {
        batch: async (statements) => {
          if (!fired) {
            // Set first: the nested approval's own batch passes through here too.
            fired = true;
            const second = reviewIn(self());
            await second.approve(IDS.secondAdmin, report, { category: 'harassment', mode: 'account', points: POINTS });
            // The keyholder cancels the second approval on its own notice: id 2 (id 1 is the first admin's, on its way).
            const [cancel] = second.buttonsOf(self().telegram.messageIn(IDS.keyholder, 2));
            await second.pressData(IDS.keyholder, cancel ?? '', 2, IDS.keyholder);
            meanwhile.cancelled = self().telegram.callsOf('answerCallbackQuery').at(-1)?.payload.text;
            meanwhile.approvals = await db.all(sql`SELECT * FROM approvals`);
            meanwhile.firstNoticesLive = [IDS.keyholder, IDS.secondKeyholder].map((keyholder) => self().telegram.messageIn(keyholder, 1)?.reply_markup !== undefined);
          }
          return db.batch(statements);
        },
      }),
    );
    await toPoints(review, report, 'post');
    const prompt = review.lastPrompt();
    const replyId = await review.reply(IDS.admin, prompt?.message_id ?? 0, POINTS);
    expect(fired).toBe(true);
    expect(meanwhile.cancelled).toBe(t('en', 'review.answer.cancelled'));
    expect(meanwhile.firstNoticesLive).toEqual([true, true]);
    // The first approval is not written: the approvals table holds the second admin's voided row, as the Cancel left it.
    expect(meanwhile.approvals).toEqual([expect.objectContaining({ admin_id: IDS.secondAdmin, link_mode: 'account', voided_at: expect.any(Number) as number })]);
    expect(await harness.db.all(sql`SELECT * FROM approvals`)).toEqual(meanwhile.approvals);
    expect(await harness.db.all(sql`SELECT * FROM jobs`)).toEqual([]);
    expect(await reportRow(harness.db, report.reportId)).toMatchObject({ status: 'pending', affected_person: null, link_mode: null, broadcast_text: null });
    // The first admin's notices withdrawn.
    for (const keyholder of [IDS.keyholder, IDS.secondKeyholder]) {
      expect(harness.telegram.messageIn(keyholder, 1)).toMatchObject({ text: cancelledNoticeText(report.reportId) });
      expect(harness.telegram.messageIn(keyholder, 1)?.reply_markup).toBeUndefined();
    }
    // The card at the category step, the cleared flag on it; the prompt and the reply gone.
    expect(cardText(review, report)).toContain(t(V, 'review.step.category'));
    expect(cardText(review, report)).toContain(t(V, 'review.card.affected_cleared'));
    expect(cardKinds(review, report)).toEqual([...CATEGORIES.map(() => 'category'), 'back']);
    expect(harness.telegram.messageIn(IDS.adminChat, prompt?.message_id ?? 0)).toBeUndefined();
    expect(harness.telegram.messageIn(IDS.adminChat, replyId)).toBeUndefined();
    expect(harness.log.records().filter((record) => record.level === 'error')).toEqual([]);
  });

  it('edits the notices to "cancelled" when the batch failed and a read shows it did not land; the failure goes on', async () => {
    const { harness, review, report } = await submittedOver((db) =>
      storeWith(db, { batch: () => Promise.reject(new AppError('STORAGE_FAILURE', 'D1 batch failed')) }),
    );
    await toPoints(review, report);
    await review.reply(IDS.admin, review.lastPrompt()?.message_id ?? 0, POINTS);
    expect(await reportRow(harness.db, report.reportId)).toMatchObject({ status: 'pending' });
    for (const keyholder of [IDS.keyholder, IDS.secondKeyholder]) {
      expect(harness.telegram.messageIn(keyholder, 1)).toMatchObject({ text: cancelledNoticeText(report.reportId) });
    }
    // The prompt is still the admin's to answer: the failed batch deleted nothing.
    expect(await harness.db.all(sql`SELECT kind FROM admin_prompts`)).toEqual([{ kind: 'recommended_comment' }]);
    expect(harness.log.records().filter((record) => record.level === 'error')).toEqual([
      { level: 'error', event: 'update.failed', errorClass: 'AppError', errorCode: 'STORAGE_FAILURE' },
    ]);
  });

  it('goes on as approved when the failed batch committed after all: the notices live, the card and the status card shown, the failure logged by class', async () => {
    const { harness, review, report } = await submittedOver((db) =>
      storeWith(db, {
        batch: async (statements) => {
          await db.batch(statements);
          throw new AppError('STORAGE_FAILURE', 'D1 lost the answer');
        },
      }),
    );
    await toPoints(review, report);
    const prompt = review.lastPrompt();
    const replyId = await review.reply(IDS.admin, prompt?.message_id ?? 0, POINTS);
    const row = await reportRow(harness.db, report.reportId);
    expect(row).toMatchObject({ status: 'approved' });
    const [approval] = await harness.db.all<{ approval_id: string }>(sql`SELECT approval_id FROM approvals`);
    // A live approval's notice never says "cancelled".
    for (const keyholder of [IDS.keyholder, IDS.secondKeyholder]) {
      const notice = harness.telegram.messageIn(keyholder, 1);
      expect(notice?.text).not.toBe(cancelledNoticeText(report.reportId));
      expect(review.buttonsOf(notice).map((data) => parseNoticeData(data))).toEqual([
        { kind: 'cancel', reportId: report.reportId, approvalId: approval?.approval_id },
        { kind: 'lockdown' },
      ]);
    }
    // The venue as after any approval: the card with Cancel, the status card, the prompt and the reply gone.
    expect(review.buttonsOf(review.card(report)).map((data) => parseReviewData(data))).toEqual([
      { kind: 'cancel', reportId: report.reportId, approvalId: approval?.approval_id },
    ]);
    expect(harness.telegram.messageIn(IDS.adminChat, Number(row?.status_message_id))?.text).toContain(t(V, 'review.status_card.notified', { sent: 2, total: 2 }));
    expect(harness.telegram.messageIn(IDS.adminChat, prompt?.message_id ?? 0)).toBeUndefined();
    expect(harness.telegram.messageIn(IDS.adminChat, replyId)).toBeUndefined();
    expect(harness.log.records().filter((record) => record.level === 'error')).toEqual([
      { level: 'error', event: 'review.approval_landed', reportId: report.reportId, errorClass: 'AppError', errorCode: 'STORAGE_FAILURE' },
    ]);
    for (const locale of LOCALES) expect(harness.textsTo(IDS.adminChat)).not.toContain(t(locale, 'error.unexpected'));
  });

  it('leaves the notices as they are when the read after the failure fails too, and logs that by class', async () => {
    let failed = false;
    const { harness, review, report } = await submittedOver((db) =>
      storeWith(db, {
        batch: () => {
          failed = true;
          return Promise.reject(new AppError('STORAGE_FAILURE', 'D1 batch failed'));
        },
        first: () => (failed ? Promise.reject(new AppError('STORAGE_FAILURE', 'D1 read failed')) : undefined),
      }),
    );
    await toPoints(review, report);
    await review.reply(IDS.admin, review.lastPrompt()?.message_id ?? 0, POINTS);
    for (const keyholder of [IDS.keyholder, IDS.secondKeyholder]) {
      expect(harness.telegram.messageIn(keyholder, 1)?.text).not.toBe(cancelledNoticeText(report.reportId));
    }
    const keyholders: unknown[] = [IDS.keyholder, IDS.secondKeyholder];
    expect(harness.telegram.callsOf('editMessageText').filter((call) => keyholders.includes(call.chatId))).toEqual([]);
    expect(harness.log.records().filter((record) => record.level === 'error')).toEqual([
      { level: 'error', event: 'review.approval_unknown', reportId: report.reportId, errorClass: 'AppError', errorCode: 'STORAGE_FAILURE' },
      { level: 'error', event: 'update.failed', errorClass: 'AppError', errorCode: 'STORAGE_FAILURE' },
    ]);
  });
});

describe("a keyholder's Cancel while the approval is on its way", () => {
  it('writes nothing, leaves the notice live and says so; once the approval stands, the Cancel cancels it', async () => {
    const pressed: (string | undefined)[] = [];
    const { harness, review, report } = await submittedOver((db, self) =>
      storeWith(db, {
        batch: async (statements) => {
          // The notice is out, the approval not yet written: the keyholder presses Cancel now.
          const [notice] = self().telegram.messagesIn(IDS.keyholder);
          const [cancel] = review.buttonsOf(notice);
          await review.pressData(IDS.keyholder, cancel ?? '', notice?.message_id ?? 0, IDS.keyholder);
          pressed.push(self().telegram.callsOf('answerCallbackQuery').at(-1)?.payload.text as string | undefined);
          return db.batch(statements);
        },
      }),
    );
    await review.approve(IDS.admin, report, { category: 'harassment', mode: 'account', points: POINTS });
    expect(pressed).toEqual([t('en', 'review.answer.not_recorded')]);
    expect(await reportRow(harness.db, report.reportId)).toMatchObject({ status: 'approved' });
    const notice = harness.telegram.messageIn(IDS.keyholder, 1);
    expect(notice?.text).not.toBe(cancelledNoticeText(report.reportId));
    const [cancel] = review.buttonsOf(notice);
    await review.pressData(IDS.keyholder, cancel ?? '', 1, IDS.keyholder);
    expect(harness.telegram.callsOf('answerCallbackQuery').at(-1)?.payload.text).toBe(t('en', 'review.answer.cancelled'));
    expect(await reportRow(harness.db, report.reportId)).toMatchObject({ status: 'pending' });
    expect(await harness.db.all(sql`SELECT * FROM jobs`)).toEqual([]);
  });
});

describe('the report changing under an open approval step', () => {
  it('starts again at the category when an affected duplicate raised the flag under an open post-mode prompt: nothing to a keyholder, nothing written', async () => {
    const { harness, review, report } = await submitted();
    await toPoints(review, report, 'post');
    const prompt = review.lastPrompt();
    await review.submit({ url: X_POST, category: 'harassment', affected: true, comment: 'it is my account' }, IDS.stranger);
    expect(await reportRow(harness.db, report.reportId)).toMatchObject({ status: 'pending', affected_person: 1 });
    const replyId = await review.reply(IDS.admin, prompt?.message_id ?? 0, POINTS);
    const keyholders: unknown[] = [IDS.keyholder, IDS.secondKeyholder];
    expect(harness.telegram.calls.filter((call) => keyholders.includes(call.chatId))).toEqual([]);
    expect(await harness.db.all(sql`SELECT * FROM approvals`)).toEqual([]);
    expect(await harness.db.all(sql`SELECT * FROM jobs`)).toEqual([]);
    expect(await harness.db.all(sql`SELECT * FROM admin_prompts`)).toEqual([]);
    expect(harness.telegram.messageIn(IDS.adminChat, prompt?.message_id ?? 0)).toBeUndefined();
    expect(harness.telegram.messageIn(IDS.adminChat, replyId)).toBeUndefined();
    expect(cardText(review, report)).toContain(t(V, 'review.step.category'));
    expect(cardText(review, report)).toContain(t(V, 'review.card.affected_yes'));
    expect(cardKinds(review, report)).toEqual([...CATEGORIES.map(() => 'category'), 'back']);
  });

  it('shows the modes again and refuses a stale press of the post mode after an affected duplicate raised the flag: nothing written', async () => {
    const { harness, review, report } = await submitted();
    await review.press(IDS.admin, { kind: 'approve', reportId: report.reportId }, report.cardId);
    await review.press(IDS.admin, { kind: 'category', reportId: report.reportId, category: 'harassment' }, report.cardId);
    const post = reviewData({ kind: 'mode', reportId: report.reportId, category: 'harassment', mode: 'post' });
    expect(review.buttonsOf(review.card(report))).toContain(post);
    expect(cardText(review, report)).toContain(t(V, 'review.card.affected_no'));
    // The duplicate leaves the open card as it was: it still offers the post.
    await review.submit({ url: X_POST, category: 'harassment', affected: true, comment: 'it is my account' }, IDS.stranger);
    expect(review.buttonsOf(review.card(report))).toContain(post);
    const before = await snapshot(harness.db);
    await review.press(IDS.admin, { kind: 'mode', reportId: report.reportId, category: 'harassment', mode: 'post' }, report.cardId);
    expect(answers(harness).at(-1)).toBe(t(V, 'review.answer.not_allowed'));
    expect(review.buttonsOf(review.card(report))).toEqual([
      reviewData({ kind: 'mode', reportId: report.reportId, category: 'harassment', mode: 'account' }),
      reviewData({ kind: 'back', reportId: report.reportId }),
    ]);
    expect(cardText(review, report)).toContain(t(V, 'review.step.mode', { category: t(V, 'review.category.harassment') }));
    expect(cardText(review, report)).toContain(t(V, 'review.card.affected_yes'));
    expect(review.lastPrompt()).toBeUndefined();
    expect(await snapshot(harness.db)).toEqual(before);
  });

  it('answers a stale press "not allowed" even when the card cannot be edited, the failure logged by class', async () => {
    const { harness, review, report } = await submitted();
    await review.press(IDS.admin, { kind: 'approve', reportId: report.reportId }, report.cardId);
    await review.press(IDS.admin, { kind: 'category', reportId: report.reportId, category: 'harassment' }, report.cardId);
    await review.submit({ url: X_POST, category: 'harassment', affected: true }, IDS.stranger);
    harness.telegram.fail({ method: 'editMessageText', chatId: IDS.adminChat }, FAILURES.serverError, 1);
    await review.press(IDS.admin, { kind: 'mode', reportId: report.reportId, category: 'harassment', mode: 'post' }, report.cardId);
    expect(answers(harness).at(-1)).toBe(t(V, 'review.answer.not_allowed'));
    expect(harness.log.records().filter((record) => record.level === 'error')).toEqual([
      { level: 'error', event: 'review.message_not_edited', errorClass: 'GrammyError', telegramErrorCode: 502, apiMethod: 'editMessageText' },
    ]);
    expect(review.lastPrompt()).toBeUndefined();
  });
});

describe('the answers to presses', () => {
  it("are plain text within Telegram's 200 characters, in both locales", () => {
    const keys = (Object.keys(en) as MessageKey[]).filter((key) => key.startsWith('review.answer.') && isPlainKey(key));
    expect(keys.length).toBeGreaterThan(10);
    for (const locale of LOCALES) {
      const texts = [
        ...keys.map((key) => (isPlainKey(key) ? t(locale, key) : '')),
        ...REPORT_STATUSES.map((status) => t(locale, 'review.answer.decided', { state: t(locale, STATUS_NAME_KEYS[status]) })),
        t(locale, 'keyholder.lockdown_is_on'),
        t(locale, 'lockdown.already_on'),
      ];
      for (const text of texts) {
        expect(text, text).toMatch(/^[^<>&]+$/);
        expect([...text].length, text).toBeLessThanOrEqual(200);
      }
    }
  });
});

describe('the approval in time', () => {
  it('starts after the grace, from the moment of the reply', async () => {
    const { harness, review, report } = await submitted({}, { APPROVAL_GRACE_MINUTES: '5' });
    harness.clock.set(NOW + 3_600_000);
    await review.approve(IDS.admin, report, { category: 'harassment', mode: 'account', points: POINTS });
    expect(await harness.db.all(sql`SELECT approved_at, starts_at FROM approvals`)).toEqual([{ approved_at: NOW + 3_600_000, starts_at: NOW + 3_600_000 + 300_000 }]);
  });
});

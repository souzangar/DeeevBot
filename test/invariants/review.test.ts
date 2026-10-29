// Always-run invariant spec for the admin review (unit U4; src/review/,
// src/telegram/review.ts), driven through the composed bot over the fakes
// with reports submitted through the real intake:
// - rule 1: no approval row exists but the one the whole flow writes (the
//   points accepted, the post validated), with a random approval id and
//   `starts_at` = `approved_at` + the grace; a press of any review button by
//   anyone, a reply by anyone but the asked admin, writes none; the status
//   change cannot happen without its approval row (the schema's trigger);
//   Cancel voids the approval and deletes its post job together, and a
//   re-approval writes a new approval id, so the cancelled job's id claims
//   nothing; an approval whose notice reached no keyholder, the one check
//   outside the admins' reach, is never written: the notice goes out first
//   and, reaching nobody, the reply is refused;
// - rule 3: the post and the keyholders' notice carry no reporter
//   reference, comment, reporter id, username or name, no admin id, and no
//   post URL under the account mode, in both locales; the card shows the
//   reference and never a reporter's id, username or name;
// - rule 4: every send and edit of the review has previews off and HTML
//   parse mode, and every tappable link in it is on the two lists; the
//   points validator refuses a URL, a bare domain, a mention, t.me, a phone
//   number and 301 characters, and the post's own links pass the link
//   policy;
// - rule 5: the review sends to the venue and, by direct message, to the
//   keyholders only: never to the channel, a reporter or the membership
//   group;
// - rule 7: a report the admin categorises as suspected CSAM gets no
//   approval, by any path; Route nulls the links, the comment and the flag
//   on the report and on its merged rows in one batch; the routing card is
//   only ever in the venue; the reporter gets nothing at routing;
// - rule 8: a merged report stores no comment and no affected-person flag
//   (its affected reporter raises the pending target's flag instead);
//   `comment` and `affected_person` are null on the report and its merged
//   rows after every decision; every prompt and reply is deleted from the
//   venue; no table holds a reporter's Telegram id.
// The commit gate runs this file on every commit (`npm run test:invariants`).
import { describe, expect, it } from 'vitest';
import { sql } from '../../src/db/sql';
import { t } from '../../src/i18n/index';
import { linksIn, outgoingLinkProblems } from '../../src/platforms/link-policy';
import { reporterRef } from '../../src/privacy/reporter-ref';
import { approveStatements } from '../../src/review/approve';
import { noticeData, REJECT_REASONS, REVIEW_PREFIXES, reviewData, type ReviewAction } from '../../src/review/callbacks';
import { CATEGORIES } from '../../src/review/categories';
import { renderBilingualPost } from '../../src/review/render-post';
import { routeStatements } from '../../src/review/route';
import { FAILURES, type RecordedCall } from '../fakes/bot-api';
import { botHarness, type BotHarness } from '../support/bot-harness';
import { reviewIn, type ReviewDriver, type SubmittedReport } from '../support/review-driver';
import { insertReport } from '../support/review-rows';
import { isOwnTable } from '../support/schema-description';
import { IDS } from '../support/variables';

const X_POST = 'https://x.com/doxxed_target/status/1234567890';
const X_ACCOUNT = 'https://x.com/doxxed_target';
const COMMENT = 'my neighbour leaked my address';
const POINTS = 'Say it publishes a private person\'s home address without consent.';
const NAMES = { username: 'reporter_handle', firstName: 'Reporter Name' };
const GRACE = 30 * 60_000;

/** A harness with one pending report of IDS.reporter's. */
const withReport = async (answers: Partial<Parameters<ReviewDriver['submit']>[0]> = {}) => {
  const harness = botHarness();
  const review = reviewIn(harness);
  const report = await review.submit({ url: X_POST, category: 'private_data', affected: false, comment: COMMENT, ...answers }, IDS.reporter, NAMES);
  return { harness, review, report };
};

/** Every review action on `report`, as data. */
const everyAction = (report: SubmittedReport, approvalId: string): ReviewAction[] => [
  { kind: 'approve', reportId: report.reportId },
  ...CATEGORIES.map((category) => ({ kind: 'category' as const, reportId: report.reportId, category })),
  ...CATEGORIES.flatMap((category) => (['account', 'post'] as const).map((mode) => ({ kind: 'mode' as const, reportId: report.reportId, category, mode }))),
  { kind: 'reject', reportId: report.reportId },
  { kind: 'route', reportId: report.reportId },
  { kind: 'cancel', reportId: report.reportId, approvalId },
  { kind: 'back', reportId: report.reportId },
];

const approvals = (harness: BotHarness) => harness.db.all<Record<string, unknown>>(sql`SELECT * FROM approvals`);

describe('critical invariant 1: no approval without the whole flow', () => {
  it('writes none for any press by anyone, nor for a reply by anyone but the admin who was asked', async () => {
    const { harness, review, report } = await withReport();
    for (const id of [IDS.reporter, IDS.stranger, IDS.keyholder, IDS.admin, IDS.secondAdmin]) {
      for (const action of everyAction(report, 'zyxwvutsrqponmlkjihg')) await review.press(id, action, report.cardId);
    }
    await review.press(IDS.admin, { kind: 'approve', reportId: report.reportId }, report.cardId);
    await review.press(IDS.admin, { kind: 'category', reportId: report.reportId, category: 'private_data' }, report.cardId);
    await review.press(IDS.admin, { kind: 'mode', reportId: report.reportId, category: 'private_data', mode: 'account' }, report.cardId);
    const prompt = review.lastPrompt()?.message_id ?? 0;
    for (const id of [IDS.reporter, IDS.keyholder, IDS.secondAdmin]) await review.reply(id, prompt, POINTS);
    await review.reply(IDS.admin, prompt, POINTS, { forwarded: true });
    expect(await approvals(harness)).toEqual([]);
    expect(await harness.db.all(sql`SELECT * FROM jobs`)).toEqual([]);
  });

  it('writes one, with a random approval id and its start after the grace, when the asked admin answers', async () => {
    const { harness, review, report } = await withReport();
    await review.approve(IDS.secondAdmin, report, { category: 'private_data', mode: 'account', points: POINTS });
    const [approval] = await approvals(harness);
    expect(approval).toMatchObject({ admin_id: IDS.secondAdmin, voided_at: null });
    expect(String(approval?.approval_id)).toMatch(/^[a-z]{20}$/);
    expect(Number(approval?.starts_at) - Number(approval?.approved_at)).toBe(GRACE);
    expect(await harness.db.all(sql`SELECT due_at, json_extract(payload, '$.approval_id') AS approval_id FROM jobs`)).toEqual([
      { due_at: approval?.starts_at, approval_id: approval?.approval_id },
    ]);
  });

  it('cannot approve without the approval row: the schema refuses the status change alone', async () => {
    const { harness } = await withReport();
    const reportId = await insertReport(harness.db);
    const statements = approveStatements({
      reportId,
      approvalId: 'abcdefghijklmnopqrst',
      jobId: 'bcdefghijklmnopqrstu',
      adminId: IDS.admin,
      category: 'harassment',
      linkMode: 'account',
      recommendedComment: POINTS,
      broadcastText: 'post',
      now: 1,
      startsAt: 2,
      prompt: { chatId: IDS.adminChat, promptMessageId: 1 },
    });
    // Every statement but the approval row's: the status change binds an approval that is not there.
    const results = await harness.db.batch(statements.slice(1));
    expect(results.every((result) => result.changes === 0)).toBe(true);
    await expect(harness.db.run(sql`UPDATE reports SET status = 'approved' WHERE id = ?`, [reportId])).rejects.toMatchObject({ code: 'STORAGE_FAILURE' });
  });

  it('never writes an approval that reached no keyholder: no approval row, no job, the report pending, the reply refused', async () => {
    for (const outcome of [FAILURES.cantInitiateConversation, FAILURES.botBlocked, FAILURES.timeout, FAILURES.serverError] as const) {
      const { harness, review, report } = await withReport();
      for (const keyholder of harness.config.keyholderIds) harness.telegram.fail({ chatId: keyholder }, outcome);
      await review.approve(IDS.admin, report, { category: 'private_data', mode: 'account', points: POINTS });
      expect(await approvals(harness), outcome.kind).toEqual([]);
      expect(await harness.db.all(sql`SELECT * FROM jobs`), outcome.kind).toEqual([]);
      expect(review.lastPrompt()?.text?.startsWith(t(harness.config.venueLocale, 'review.refused.unnotified')), outcome.kind).toBe(true);
      expect(await harness.db.first(sql`SELECT status, broadcast_text FROM reports WHERE id = ?`, [report.reportId]), outcome.kind).toEqual({
        status: 'pending',
        broadcast_text: null,
      });
    }
  });

  it('voids the approval and deletes its job at Cancel, and a re-approval writes a new approval id', async () => {
    const { harness, review, report } = await withReport();
    await review.approve(IDS.admin, report, { category: 'private_data', mode: 'account', points: POINTS });
    const [first] = await approvals(harness);
    await review.pressData(IDS.keyholder, noticeData({ kind: 'cancel', reportId: report.reportId, approvalId: String(first?.approval_id) }), 1, IDS.keyholder);
    expect(await approvals(harness)).toEqual([expect.objectContaining({ approval_id: first?.approval_id, voided_at: expect.any(Number) as number })]);
    expect(await harness.db.all(sql`SELECT * FROM jobs`)).toEqual([]);
    await review.approve(IDS.secondAdmin, report, { category: 'private_data', mode: 'account', points: POINTS });
    const [second] = await approvals(harness);
    expect(second?.approval_id).not.toBe(first?.approval_id);
    expect(await harness.db.all(sql`SELECT json_extract(payload, '$.approval_id') AS approval_id FROM jobs`)).toEqual([{ approval_id: second?.approval_id }]);
  });
});

describe('critical invariant 3: the post, the notice and the card expose nobody', () => {
  it('carry no reporter reference, comment, id, username or name, no admin id, and no post URL under the account mode', async () => {
    const { harness, review, report } = await withReport();
    await review.approve(IDS.admin, report, { category: 'private_data', mode: 'account', points: POINTS });
    const ref = await reporterRef(IDS.reporter, harness.config.reporterRefKey);
    const post = await harness.db.first<{ broadcast_text: string }>(sql`SELECT broadcast_text FROM reports WHERE id = ?`, [report.reportId]);
    const notices = harness.config.keyholderIds.map((keyholder) => harness.telegram.messagesIn(keyholder)[0]?.text ?? '');
    for (const text of [post?.broadcast_text ?? '', ...notices]) {
      expect(text).toContain(X_ACCOUNT);
      for (const fragment of [ref, COMMENT, String(IDS.reporter), NAMES.username, NAMES.firstName, String(IDS.admin), 'status/1234567890']) {
        expect(text, fragment).not.toContain(fragment);
      }
    }
    // Both locales are in the one post.
    const expected = renderBilingualPost({ platform: 'x', category: 'private_data', url: X_POST, accountUrl: X_ACCOUNT }, { linkMode: 'account', recommendedComment: POINTS }, harness.config.allowedLinkHosts);
    expect(post?.broadcast_text).toBe(expected.ok ? expected.text : 'unrendered');
  });

  it('shows the card the reference, never the reporter\'s id, username or name', async () => {
    const { harness, review, report } = await withReport();
    const text = review.card(report)?.text ?? '';
    expect(text).toContain(await reporterRef(IDS.reporter, harness.config.reporterRefKey));
    for (const fragment of [String(IDS.reporter), NAMES.username, NAMES.firstName]) expect(text).not.toContain(fragment);
  });

  it('renders a Telegram target as code text, never a link', async () => {
    const { harness, review, report } = await withReport({ url: 'https://t.me/leak_channel/77' });
    await review.approve(IDS.admin, report, { category: 'private_data', mode: 'post', points: POINTS });
    const post = (await harness.db.first<{ broadcast_text: string }>(sql`SELECT broadcast_text FROM reports WHERE id = ?`, [report.reportId]))?.broadcast_text ?? '';
    expect(post).toContain('<code>@leak_channel</code>');
    expect(post).not.toContain('t.me/leak_channel');
    expect(linksIn(post).filter((link) => link.text.toLowerCase().includes('leak_channel'))).toEqual([]);
  });
});

describe('critical invariants 4 and 5: what the review sends, and where', () => {
  /** A whole review over several reports: approve, cancel, re-approve, reject, route. */
  const battery = async (): Promise<{ harness: BotHarness; calls: RecordedCall[] }> => {
    const harness = botHarness();
    const review = reviewIn(harness);
    const from = harness.telegram.calls.length;
    const first = await review.submit({ url: X_POST, category: 'private_data', affected: false, comment: COMMENT });
    await review.approve(IDS.admin, first, { category: 'private_data', mode: 'post', points: POINTS });
    const approval = await harness.db.first<{ approval_id: string }>(sql`SELECT approval_id FROM approvals`);
    await review.press(IDS.admin, { kind: 'cancel', reportId: first.reportId, approvalId: approval?.approval_id ?? '' }, first.cardId);
    await review.approve(IDS.secondAdmin, first, { category: 'harassment', mode: 'account', points: POINTS });
    const second = await review.submit({ url: 'https://www.instagram.com/p/AbC123xyz', account: 'unknown', category: 'csam', affected: false }, IDS.stranger);
    await review.press(IDS.admin, { kind: 'route', reportId: second.reportId }, second.cardId);
    await review.press(IDS.admin, { kind: 'confirm_route', reportId: second.reportId }, second.cardId);
    const third = await review.submit({ url: 'https://www.tiktok.com/@someone/video/123', category: 'harassment', affected: true }, 424240041);
    await review.press(IDS.admin, { kind: 'reject', reportId: third.reportId }, third.cardId);
    await review.press(IDS.admin, { kind: 'reason', reportId: third.reportId, reason: REJECT_REASONS[0] }, third.cardId);
    return { harness, calls: harness.telegram.calls.slice(from) };
  };

  it('sends and edits with previews off and HTML, linking only to the lists', async () => {
    const { harness, calls } = await battery();
    const texts = calls.filter((call) => call.method === 'sendMessage' || call.method === 'editMessageText');
    expect(texts.length).toBeGreaterThan(20);
    for (const call of texts) {
      expect(call.payload.link_preview_options).toEqual({ is_disabled: true });
      expect(call.payload.parse_mode).toBe('HTML');
      expect(outgoingLinkProblems(String(call.payload.text), harness.config.allowedLinkHosts)).toEqual([]);
    }
  });

  it('sends the review to the venue and the keyholders only, and never to the channel or the membership group', async () => {
    const { calls } = await battery();
    const reporters = [IDS.reporter, IDS.stranger, 424240041];
    for (const call of calls) {
      if (call.method === 'answerCallbackQuery' || call.method === 'getChatMember') continue;
      expect([IDS.adminChat, IDS.keyholder, IDS.secondKeyholder, ...reporters], call.method).toContain(call.chatId);
    }
    const messages = calls.filter((call) => ['sendMessage', 'editMessageText', 'editMessageReplyMarkup', 'deleteMessage'].includes(call.method));
    expect(messages.filter((call) => call.chatId === IDS.broadcastChannel)).toEqual([]);
    expect(messages.filter((call) => call.chatId === IDS.membershipChat)).toEqual([]);
  });

  it.each([
    ['a URL', 'Open https://evil.test/ first'],
    ['a bare domain', 'Look at evil.test first'],
    ['a mention', 'Ask @recruiter first'],
    ['t.me', 'Join t.me first'],
    ['a phone number', 'Call 09123456789 first'],
    ['301 characters', 'c'.repeat(301)],
  ])('refuses points holding %s: no approval, nothing to the keyholders', async (_label, points) => {
    const { harness, review, report } = await withReport();
    await review.approve(IDS.admin, report, { category: 'private_data', mode: 'account', points });
    expect(await approvals(harness)).toEqual([]);
    expect(harness.telegram.calls.filter((call) => call.chatId === IDS.keyholder)).toEqual([]);
  });
});

describe('critical invariant 7: suspected CSAM is never approved, and routing leaves no link', () => {
  it('offers no approval for the category, by the card or by a forged press', async () => {
    const { harness, review, report } = await withReport({ category: 'csam' });
    await review.press(IDS.admin, { kind: 'approve', reportId: report.reportId }, report.cardId);
    await review.press(IDS.admin, { kind: 'category', reportId: report.reportId, category: 'csam' }, report.cardId);
    expect(review.buttonsOf(review.card(report))).not.toContain(reviewData({ kind: 'mode', reportId: report.reportId, category: 'csam', mode: 'account' }));
    for (const mode of ['account', 'post'] as const) {
      await review.press(IDS.admin, { kind: 'mode', reportId: report.reportId, category: 'csam', mode }, report.cardId);
    }
    expect(review.lastPrompt()).toBeUndefined();
    expect(await approvals(harness)).toEqual([]);
    expect(renderBilingualPost({ platform: 'x', category: 'csam', url: X_POST, accountUrl: X_ACCOUNT }, { linkMode: 'account', recommendedComment: POINTS }, harness.config.allowedLinkHosts).ok).toBe(false);
  });

  it('nulls the links, the comment and the flag of the report and its merged rows in one batch, the card in the venue only', async () => {
    const { harness, review, report } = await withReport({ category: 'csam' });
    await review.submit({ url: X_POST, category: 'csam', affected: true, comment: 'another view' }, IDS.stranger);
    const from = harness.telegram.calls.length;
    await review.press(IDS.admin, { kind: 'route', reportId: report.reportId }, report.cardId);
    await review.press(IDS.admin, { kind: 'confirm_route', reportId: report.reportId }, report.cardId);
    expect(await harness.db.all(sql`SELECT status, url, account_url, comment, affected_person FROM reports ORDER BY created_at, rowid`)).toEqual([
      { status: 'routed', url: null, account_url: null, comment: null, affected_person: null },
      { status: 'merged', url: null, account_url: null, comment: null, affected_person: null },
    ]);
    for (const call of harness.telegram.calls.slice(from)) {
      if (call.method !== 'answerCallbackQuery') expect(call.chatId).toBe(IDS.adminChat);
    }
    expect(harness.telegram.calls.slice(from).filter((call) => call.chatId === IDS.reporter || call.chatId === IDS.stranger)).toEqual([]);
    expect(review.card(report)).toBeUndefined();
  });

  it('routes in one batch: its statements are every write the routing makes', () => {
    expect(routeStatements('abcdefghijklmnopqrst', IDS.admin, 1)).toHaveLength(3);
  });
});

describe('critical invariant 8: the review keeps nothing it does not need', () => {
  it("stores no comment and no flag on a merged report, its affected reporter limiting the pending target's post to the account link", async () => {
    const { harness, review, report } = await withReport({ affected: false });
    await review.submit({ url: X_POST, category: 'private_data', affected: true, comment: 'it is my address' }, IDS.stranger);
    expect(await harness.db.all(sql`SELECT status, comment, affected_person FROM reports ORDER BY created_at, rowid`)).toEqual([
      { status: 'pending', comment: COMMENT, affected_person: 1 },
      { status: 'merged', comment: null, affected_person: null },
    ]);
    await review.press(IDS.admin, { kind: 'approve', reportId: report.reportId }, report.cardId);
    await review.press(IDS.admin, { kind: 'category', reportId: report.reportId, category: 'private_data' }, report.cardId);
    expect(review.buttonsOf(review.card(report))).not.toContain(reviewData({ kind: 'mode', reportId: report.reportId, category: 'private_data', mode: 'post' }));
  });

  it('leaves nothing of a duplicate merged into a target already approved', async () => {
    const { harness, review, report } = await withReport();
    await review.approve(IDS.admin, report, { category: 'private_data', mode: 'account', points: POINTS });
    await review.submit({ url: X_POST, category: 'harassment', affected: true, comment: 'my data, my comment' }, IDS.stranger);
    expect(await harness.db.all(sql`SELECT status, comment, affected_person FROM reports ORDER BY created_at, rowid`)).toEqual([
      { status: 'approved', comment: null, affected_person: null },
      { status: 'merged', comment: null, affected_person: null },
    ]);
  });

  it('nulls the comment and the flag on the report and its merged rows at every decision', async () => {
    for (const decide of ['approve', 'reject', 'route'] as const) {
      const { harness, review, report } = await withReport({ affected: true });
      await review.submit({ url: X_POST, category: 'harassment', affected: true, comment: 'another view' }, IDS.stranger);
      if (decide === 'approve') await review.approve(IDS.admin, report, { category: 'private_data', mode: 'account', points: POINTS });
      if (decide === 'reject') {
        await review.press(IDS.admin, { kind: 'reject', reportId: report.reportId }, report.cardId);
        await review.press(IDS.admin, { kind: 'reason', reportId: report.reportId, reason: 'other' }, report.cardId);
      }
      if (decide === 'route') {
        await review.press(IDS.admin, { kind: 'route', reportId: report.reportId }, report.cardId);
        await review.press(IDS.admin, { kind: 'confirm_route', reportId: report.reportId }, report.cardId);
      }
      expect(await harness.db.all(sql`SELECT comment, affected_person FROM reports`), decide).toEqual([
        { comment: null, affected_person: null },
        { comment: null, affected_person: null },
      ]);
    }
  });

  it('deletes every prompt and every reply from the venue, and every prompt row', async () => {
    const { harness, review, report } = await withReport({ url: 'https://www.instagram.com/p/AbC123xyz', account: 'unknown' });
    await review.press(IDS.admin, { kind: 'approve', reportId: report.reportId }, report.cardId);
    await review.press(IDS.admin, { kind: 'category', reportId: report.reportId, category: 'private_data' }, report.cardId);
    await review.reply(IDS.admin, review.lastPrompt()?.message_id ?? 0, 'not a link');
    await review.reply(IDS.admin, review.lastPrompt()?.message_id ?? 0, 'https://www.instagram.com/the.account');
    await review.press(IDS.admin, { kind: 'mode', reportId: report.reportId, category: 'private_data', mode: 'account' }, report.cardId);
    await review.reply(IDS.admin, review.lastPrompt()?.message_id ?? 0, 'Call 09123456789');
    await review.reply(IDS.admin, review.lastPrompt()?.message_id ?? 0, POINTS);
    const row = await harness.db.first<{ status_message_id: number }>(sql`SELECT status_message_id FROM reports`);
    expect(harness.telegram.messagesIn(IDS.adminChat).map((message) => message.message_id)).toEqual([report.cardId, row?.status_message_id]);
    expect(await harness.db.all(sql`SELECT * FROM admin_prompts`)).toEqual([]);
  });

  it('stores no reporter\'s Telegram id in any table, through a whole review', async () => {
    const { harness, review, report } = await withReport();
    await review.approve(IDS.admin, report, { category: 'private_data', mode: 'account', points: POINTS });
    const rejected = await review.submit({ url: 'https://www.tiktok.com/@someone/video/123', category: 'harassment', affected: false }, IDS.stranger);
    await review.press(IDS.secondAdmin, { kind: 'reject', reportId: rejected.reportId }, rejected.cardId);
    await review.press(IDS.secondAdmin, { kind: 'reason', reportId: rejected.reportId, reason: 'no_violation' }, rejected.cardId);
    await review.press(IDS.admin, { kind: 'block', reportId: rejected.reportId }, rejected.cardId);
    const tables = harness.connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((each) => String(each.name))
      .filter(isOwnTable);
    let values = 0;
    for (const table of tables) {
      for (const row of harness.connection.prepare(`SELECT * FROM ${table}`).all()) {
        for (const value of Object.values(row)) {
          values += 1;
          for (const id of [IDS.reporter, IDS.stranger]) expect(String(value), table).not.toContain(String(id));
        }
      }
    }
    expect(values).toBeGreaterThan(50);
  });

  it('registers every review button under its own prefix, so the specs reach each one', () => {
    expect(Object.values(REVIEW_PREFIXES)).toHaveLength(10);
  });
});

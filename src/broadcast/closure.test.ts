// Unit tests for closure (src/broadcast/closure.ts; critical invariants 1,
// 2, 4, 5 and 8), over the tick harness's fakes with reports posted by a
// real run: the closed post's text, with its outcome lines in both locales
// and the fallback without links; the order, bound to a posted report under
// its live approval and to no lockdown, with its edit job and the status
// card's note; the 90-day expiry's statements; the edit job, which edits
// that report's own post and nothing else, without a keyboard, and on its
// success alone writes the terminal status and finalizes; "not modified"
// and "not found" as non-errors; a refusal flagged and alerted once, the
// report left closing with its data; a hold read again; a report without
// its approval never edited; a stale job dropped; the status card's buttons.
import { describe, expect, it } from 'vitest';
import { setLockdown } from '../auth/lockdown';
import { sql } from '../db/sql';
import { AppError } from '../errors/app-error';
import { t } from '../i18n/index';
import { outgoingLinkProblems } from '../platforms/link-policy';
import { parseReviewData, reviewData } from '../review/callbacks';
import { POST_DIVIDER } from '../review/render-post';
import { FAILURES, rateLimited } from '../../test/fakes/bot-api';
import { insertApproval, insertReport, reportRow } from '../../test/support/review-rows';
import { plantApproved, plantPosted, TICK_AT, tickHarness, type TickHarness } from '../../test/support/tick-harness';
import { IDS } from '../../test/support/variables';
import { buttonPress } from '../../test/support/updates';
import {
  closedPostText,
  closeEdit,
  closeStatements,
  closureText,
  CLOSE_STATUS_STATEMENT,
  EXPIRY_BATCH_LIMIT,
  expiryStatements,
  orderClosure,
  outcomeOnlyText,
} from './closure';
import type { EditJob } from './edits';

const MINUTE = 60_000;
const DAY = 86_400_000;

const channelEdits = (harness: TickHarness) => harness.telegram.callsOf('editMessageText').filter((call) => call.chatId === IDS.broadcastChannel);
const jobsOf = (harness: TickHarness, reportId: string) =>
  harness.db.all<{ kind: string; due_at: number; attempts: number; action: string }>(
    sql`SELECT kind, due_at, attempts, json_extract(payload, '$.action') AS action FROM jobs WHERE report_id = ?`,
    [reportId],
  );

/** A posted report, closed with `outcome` by the order itself; the harness's clock a minute on. */
const closing = async (harness: TickHarness, outcome: 'taken_down' | 'no_result' = 'taken_down') => {
  const posted = await plantPosted(harness);
  expect(await orderClosure(harness.deps, posted.reportId, outcome)).toBe('closing');
  harness.clock.advance(MINUTE);
  return posted;
};

describe('the closed post', () => {
  it('is the stored post, the divider and the outcome lines in both locales, Persian first, bold', () => {
    for (const outcome of ['taken_down', 'no_result', 'expired'] as const) {
      const key = `post.outcome.${outcome}` as const;
      expect(closedPostText('<b>the post</b>', outcome)).toBe(`<b>the post</b>\n\n${POST_DIVIDER}\n\n<b>${t('fa', key)}</b>\n<b>${t('en', key)}</b>`);
      expect(outcomeOnlyText(outcome)).toBe(`<b>${t('fa', key)}</b>\n<b>${t('en', key)}</b>`);
      expect(outgoingLinkProblems(outcomeOnlyText(outcome), [])).toEqual([]);
    }
  });

  it('falls back to the outcome lines alone when the closed post may not be sent: too long once they are appended, a tappable link off the lists, or no stored post', () => {
    const hosts = ['x.com'];
    // A target is code text, which the check does not read as a link: the closed post stands whatever the hosts allow now.
    expect(closureText({ allowedLinkHosts: [] }, 'A post <code>https://x.com/someone</code>', 'taken_down')).toBe(
      closedPostText('A post <code>https://x.com/someone</code>', 'taken_down'),
    );
    expect(closureText({ allowedLinkHosts: hosts }, 'A post <code>https://x.com/someone</code>', 'taken_down')).toBe(
      closedPostText('A post <code>https://x.com/someone</code>', 'taken_down'),
    );
    expect(closureText({ allowedLinkHosts: hosts }, 'See <a href="https://evil.example/">this</a>', 'no_result')).toBe(outcomeOnlyText('no_result'));
    expect(closureText({ allowedLinkHosts: hosts }, 'x'.repeat(4090), 'expired')).toBe(outcomeOnlyText('expired'));
    expect(closureText({ allowedLinkHosts: hosts }, null, 'taken_down')).toBe(outcomeOnlyText('taken_down'));
  });
});

describe('the order', () => {
  it('moves a posted report to closing with its outcome, enqueues its edit job due now, and puts the status card under way', async () => {
    const harness = tickHarness();
    const posted = await plantPosted(harness);
    expect(await orderClosure(harness.deps, posted.reportId, 'no_result')).toBe('closing');
    expect(await reportRow(harness.db, posted.reportId)).toMatchObject({ status: 'closing', outcome: 'no_result', post_message_id: posted.postMessageId });
    expect(await jobsOf(harness, posted.reportId)).toEqual([{ kind: 'edit', due_at: TICK_AT, attempts: 0, action: 'close' }]);
    const card = harness.telegram.messageIn(IDS.adminChat, posted.statusMessageId);
    expect(card?.text).toContain(t(harness.config.venueLocale, 'review.status_card.note.closing', { id: posted.reportId }));
    const buttons = ((card?.reply_markup as { inline_keyboard?: { callback_data?: string }[][] } | undefined)?.inline_keyboard ?? []).flat();
    expect(buttons.map((button) => parseReviewData(button.callback_data ?? '')?.kind)).toEqual(['block']);
    expect(harness.log.records().filter((record) => record.event === 'close.ordered')).toEqual([{ level: 'info', event: 'close.ordered', reportId: posted.reportId }]);
    // Nothing goes to anyone: the edited post is the outcome.
    expect(harness.telegram.callsOf('sendMessage').filter((call) => call.chatId !== IDS.broadcastChannel)).toEqual([]);
  });

  it('refuses a report that is not posted, writing nothing', async () => {
    const harness = tickHarness();
    const approved = await plantApproved(harness);
    const pending = await insertReport(harness.db);
    const posted = await closing(harness);
    for (const id of [approved.reportId, pending, posted.reportId]) {
      const before = await reportRow(harness.db, id);
      expect(await orderClosure(harness.deps, id, 'taken_down'), id).toBe('refused');
      expect(await reportRow(harness.db, id), id).toEqual(before);
    }
    expect(await jobsOf(harness, posted.reportId)).toHaveLength(1);
  });

  it('refuses a posted report without a live approval record (rule 1), and a missing or merged one is not found', async () => {
    const harness = tickHarness();
    const unbound = await insertReport(harness.db, { status: 'posted', posting_started_at: 1, posted_at: 2, post_message_id: 77 });
    expect(await orderClosure(harness.deps, unbound, 'taken_down')).toBe('refused');
    expect(await reportRow(harness.db, unbound)).toMatchObject({ status: 'posted' });
    expect(await jobsOf(harness, unbound)).toEqual([]);
    const merged = await insertReport(harness.db, { status: 'merged' });
    expect(await orderClosure(harness.deps, merged, 'taken_down')).toBe('not_found');
    expect(await orderClosure(harness.deps, 'nosuchreportxxxxxxxx', 'taken_down')).toBe('not_found');
  });

  it('binds the switch in its own statement: a lockdown set after the gates read it closes nothing', async () => {
    const harness = tickHarness();
    const posted = await plantPosted(harness);
    await setLockdown(harness.db, harness.clock);
    expect(await orderClosure(harness.deps, posted.reportId, 'taken_down')).toBe('locked');
    expect(await reportRow(harness.db, posted.reportId)).toMatchObject({ status: 'posted', outcome: null });
    expect(await jobsOf(harness, posted.reportId)).toEqual([]);
    const results = await harness.db.batch(closeStatements(posted.reportId, 'taken_down', TICK_AT));
    expect(results[CLOSE_STATUS_STATEMENT]?.changes).toBe(0);
  });
});

describe('the expiry statements', () => {
  it('move the posted reports at or before the cut-off to closing, expired, with their edit jobs, and no younger one', async () => {
    const harness = tickHarness();
    const old = await plantPosted(harness);
    const young = await plantPosted(harness);
    const cutoff = Number((await reportRow(harness.db, old.reportId))?.posted_at);
    await harness.db.run(sql`UPDATE reports SET posted_at = ?, posting_started_at = ? WHERE id = ?`, [cutoff + DAY, cutoff + DAY, young.reportId]);
    await harness.db.batch(expiryStatements([old.reportId, young.reportId], cutoff, TICK_AT));
    expect(await reportRow(harness.db, old.reportId)).toMatchObject({ status: 'closing', outcome: 'expired' });
    expect(await jobsOf(harness, old.reportId)).toEqual([{ kind: 'edit', due_at: TICK_AT, attempts: 0, action: 'close' }]);
    expect(await reportRow(harness.db, young.reportId)).toMatchObject({ status: 'posted', outcome: null });
    expect(await jobsOf(harness, young.reportId)).toEqual([]);
  });

  it('take none for no report, and at most EXPIRY_BATCH_LIMIT', () => {
    expect(expiryStatements([], 1, 2)).toEqual([]);
    const ids = Array.from({ length: EXPIRY_BATCH_LIMIT + 1 }, (_unused, n) => `${'e'.repeat(18)}${String.fromCharCode(97 + Math.floor(n / 26))}${String.fromCharCode(97 + (n % 26))}`);
    expect(() => expiryStatements(ids, 1, 2)).toThrow(AppError);
  });
});

describe('the edit job', () => {
  it('edits the report\'s own post to the closed post, without the button, then concludes closed and finalizes, sending nothing to anyone', async () => {
    const harness = tickHarness();
    const other = await plantPosted(harness);
    const posted = await closing(harness);
    const sendsBefore = harness.telegram.callsOf('sendMessage').length;
    expect((await harness.run()).edits).toBe(1);
    expect(channelEdits(harness).map((call) => call.payload)).toEqual([
      {
        chat_id: IDS.broadcastChannel,
        message_id: posted.postMessageId,
        text: closedPostText(posted.text, 'taken_down'),
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      },
    ]);
    expect(harness.telegram.messageIn(IDS.broadcastChannel, posted.postMessageId)?.reply_markup).toBeUndefined();
    expect(harness.telegram.messageIn(IDS.broadcastChannel, other.postMessageId)?.text).toBe(other.text);
    expect(await reportRow(harness.db, posted.reportId)).toMatchObject({ status: 'closed', outcome: 'taken_down', post_message_id: null, broadcast_text: null, url: null });
    expect(await harness.db.all(sql`SELECT report_id, outcome FROM stats`)).toEqual([{ report_id: posted.reportId, outcome: 'taken_down' }]);
    expect(await jobsOf(harness, posted.reportId)).toEqual([]);
    const card = harness.telegram.messageIn(IDS.adminChat, posted.statusMessageId);
    expect(card?.text).toContain(t(harness.config.venueLocale, 'review.status_card.concluded', { outcome: t(harness.config.venueLocale, 'review.outcome.taken_down') }));
    expect(card?.reply_markup).toBeUndefined();
    expect(harness.telegram.callsOf('sendMessage')).toHaveLength(sendsBefore);
    expect(harness.log.records().filter((record) => record.event === 'close.done')).toEqual([{ level: 'info', event: 'close.done', reportId: posted.reportId }]);
  });

  it('concludes an expiry as expired', async () => {
    const harness = tickHarness();
    const posted = await plantPosted(harness);
    await harness.db.batch(expiryStatements([posted.reportId], TICK_AT, TICK_AT));
    await harness.run();
    expect(channelEdits(harness).map((call) => call.payload.text)).toEqual([closedPostText(posted.text, 'expired')]);
    expect(await reportRow(harness.db, posted.reportId)).toMatchObject({ status: 'expired', outcome: 'expired', data_deleted_at: TICK_AT });
  });

  it.each([
    ['message is not modified', FAILURES.messageNotModified, 'close.done'],
    ['message to edit not found', FAILURES.messageToEditNotFound, 'edit.post_gone'],
  ] as const)('takes "%s" as the post addressed, and concludes, logging %s', async (_label, failure, event) => {
    const harness = tickHarness();
    const posted = await closing(harness);
    harness.telegram.fail({ method: 'editMessageText', chatId: IDS.broadcastChannel }, failure, 1);
    await harness.run();
    expect(await reportRow(harness.db, posted.reportId)).toMatchObject({ status: 'closed', data_deleted_at: harness.clock.now() });
    const concluded = harness.log.records().filter((record) => record.event === 'close.done' || record.event === 'edit.post_gone');
    expect(concluded).toEqual([{ level: 'info', event, reportId: posted.reportId }]);
  });

  it('on a refusal, flags the report, alerts once and notes the status card, leaving it closing with its post and its text', async () => {
    const harness = tickHarness();
    const posted = await closing(harness);
    harness.telegram.fail({ method: 'editMessageText', chatId: IDS.broadcastChannel }, FAILURES.chatNotFound);
    await harness.run();
    harness.clock.advance(20 * MINUTE);
    await harness.run();
    expect(channelEdits(harness)).toHaveLength(2);
    expect(await reportRow(harness.db, posted.reportId)).toMatchObject({
      status: 'closing',
      post_message_id: posted.postMessageId,
      broadcast_text: posted.text,
      needs_attention: 1,
      data_deleted_at: null,
    });
    expect(await harness.db.all(sql`SELECT * FROM stats`)).toEqual([]);
    expect(await jobsOf(harness, posted.reportId)).toEqual([expect.objectContaining({ attempts: 2 })]);
    const alerts = harness.telegram.callsOf('sendMessage').filter((call) => String(call.payload.text).includes(t('en', 'alert.edit_held', { id: posted.reportId, state: t('en', 'status.closing') })));
    expect(alerts.map((call) => call.chatId)).toEqual([IDS.keyholder, IDS.secondKeyholder]);
    expect(harness.telegram.callsOf('sendMessage').filter((call) => call.chatId === IDS.adminChat)).toHaveLength(1);
    expect((await reportRow(harness.db, posted.reportId))?.alert_sent_at).not.toBeNull();
    expect(harness.telegram.messageIn(IDS.adminChat, posted.statusMessageId)?.text).toContain(t(harness.config.venueLocale, 'review.status_card.note.edit_failed', { id: posted.reportId }));
    expect(harness.log.records().filter((record) => record.event === 'edit.flagged')).toHaveLength(1);
  });

  it('on a 429 or an ambiguous answer, writes nothing to the report and flags nothing: the job is tried again', async () => {
    for (const failure of [rateLimited(30), FAILURES.timeout, FAILURES.serverError]) {
      const harness = tickHarness();
      const posted = await closing(harness);
      harness.telegram.fail({ method: 'editMessageText', chatId: IDS.broadcastChannel }, failure, 1);
      await harness.run();
      expect(await reportRow(harness.db, posted.reportId)).toMatchObject({ status: 'closing', needs_attention: 0, post_message_id: posted.postMessageId });
      expect(await jobsOf(harness, posted.reportId)).toEqual([expect.objectContaining({ attempts: 1 })]);
    }
  });

  it('reads the hold again: under /halt or the switch, set after the run read the state, it edits nothing and fails nothing', async () => {
    for (const key of ['halted', 'lockdown'] as const) {
      const harness = tickHarness();
      const posted = await closing(harness);
      await harness.db.run(sql`INSERT INTO meta (key, value) VALUES (?, 1)`, [key]);
      const job: EditJob = { id: 'closejobxxxxxxxxxxxx', reportId: posted.reportId, action: 'close', dueAt: TICK_AT, attempts: 0 };
      await closeEdit(harness.deps, job, TICK_AT);
      expect(channelEdits(harness), key).toEqual([]);
      expect(await reportRow(harness.db, posted.reportId), key).toMatchObject({ status: 'closing', needs_attention: 0 });
    }
  });

  it('never edits the post of a report that holds no live approval record (rule 1): flagged, and the job\'s failure recorded', async () => {
    const harness = tickHarness();
    const posted = await closing(harness);
    await harness.db.run(sql`UPDATE approvals SET voided_at = ? WHERE report_id = ?`, [TICK_AT, posted.reportId]);
    await harness.run();
    expect(channelEdits(harness)).toEqual([]);
    expect(await reportRow(harness.db, posted.reportId)).toMatchObject({ status: 'closing', needs_attention: 1, post_message_id: posted.postMessageId });
    expect(await jobsOf(harness, posted.reportId)).toEqual([expect.objectContaining({ attempts: 1 })]);
    expect(harness.log.records().find((record) => record.event === 'edit.failed')).toMatchObject({ errorClass: 'AppError', errorCode: 'UNEXPECTED' });
  });

  it('drops a job whose report is no longer closing', async () => {
    const harness = tickHarness();
    const reportId = await insertReport(harness.db, { status: 'posted', posting_started_at: 1, posted_at: 2, post_message_id: 78 });
    await insertApproval(harness.db, reportId);
    await harness.db.run(sql`INSERT INTO jobs (id, kind, report_id, due_at, payload, attempts, created_at) VALUES ('stalejobxxxxxxxxxxxx', 'edit', ?, 1, '{"action":"close"}', 0, 1)`, [reportId]);
    await harness.run();
    expect(channelEdits(harness)).toEqual([]);
    expect(await jobsOf(harness, reportId)).toEqual([]);
    expect(harness.log.records().filter((record) => record.event === 'edit.stale')).toEqual([{ level: 'info', event: 'edit.stale', reportId }]);
  });
});

describe('the status card\'s buttons', () => {
  it('close the posted report from its status card, answering the press, and refuse a stale card', async () => {
    const harness = tickHarness();
    const posted = await plantPosted(harness);
    const press = async (messageId: number) => {
      await harness.send(
        buttonPress(IDS.admin, reviewData({ kind: 'close', reportId: posted.reportId, outcome: 'taken_down' }), { chatId: IDS.adminChat, messageId, chatType: 'supergroup' }),
      );
      return harness.telegram.callsOf('answerCallbackQuery').at(-1)?.payload.text;
    };
    expect(await press(posted.statusMessageId + 1000)).toBe(t(harness.config.venueLocale, 'review.answer.stale_card'));
    expect(await reportRow(harness.db, posted.reportId)).toMatchObject({ status: 'posted' });
    expect(await press(posted.statusMessageId)).toBe(t(harness.config.venueLocale, 'review.answer.closing'));
    expect(await reportRow(harness.db, posted.reportId)).toMatchObject({ status: 'closing', outcome: 'taken_down' });
    expect(await press(posted.statusMessageId)).toBe(t(harness.config.venueLocale, 'review.answer.close_refused'));
  });
});

// Unit tests for what the edit jobs share (src/broadcast/concluding.ts;
// critical invariants 1, 4, 5 and 8), over the tick harness's fakes: the
// edit target read in one query (its live approval, the hold, the time of
// its send); a conclusion overtaken by a change concluding nothing and
// touching nothing after; the report's prompts deleted from their chats
// once it concluded, within Telegram's 48 hours, the venue's not under
// lockdown; a refusal flagged and alerted once only, to the keyholders only
// under lockdown; a stale job dropped; the deletions, the lockdown read and
// the status card's note, each never throwing.
import { describe, expect, it } from 'vitest';
import { setLockdown } from '../auth/lockdown';
import { sql, type SqlDb } from '../db/sql';
import { AppError } from '../errors/app-error';
import { t } from '../i18n/index';
import { createPrompt } from '../review/prompts';
import { FAILURES } from '../../test/fakes/bot-api';
import { insertApproval, insertReport, reportRow } from '../../test/support/review-rows';
import { plantPosted, TICK_AT, tickHarness, type TickHarness } from '../../test/support/tick-harness';
import { IDS } from '../../test/support/variables';
import {
  concludeEdit,
  deleteFromChat,
  dropStale,
  flagEdit,
  lockedOrUnknown,
  MESSAGE_DELETE_WINDOW_MS,
  readEditTarget,
  showState,
  type EditPlan,
} from './concluding';
import { closedPostText } from './closure';
import { enqueueEditStatement } from './jobs';

const MINUTE = 60_000;

const CLOSURE: Omit<EditPlan, 'text'> = { conclusion: { from: 'closing', to: 'closed' }, deleteYoung: false, done: 'close.done', notice: null };

/** A posted report moved to closing (taken down) with its edit job, as the order leaves it. */
const closing = async (harness: TickHarness) => {
  const posted = await plantPosted(harness);
  await harness.db.run(sql`UPDATE reports SET status = 'closing', outcome = 'taken_down' WHERE id = ?`, [posted.reportId]);
  const job = enqueueEditStatement({ reportId: posted.reportId, status: 'closing', dueAt: TICK_AT, now: TICK_AT });
  await harness.db.run(job.sql, job.params);
  return posted;
};

const failingReads = (db: SqlDb): SqlDb => ({ ...db, first: () => Promise.reject(new AppError('STORAGE_FAILURE', 'down')) });

describe('readEditTarget', () => {
  it('reads the report, its live approval, the hold and its send in one query', async () => {
    const harness = tickHarness();
    const posted = await closing(harness);
    harness.reset();
    const target = await readEditTarget(harness.deps.db, posted.reportId);
    expect(harness.tally.queries).toBe(1);
    expect(target).toMatchObject({
      reportId: posted.reportId,
      status: 'closing',
      outcome: 'taken_down',
      postMessageId: posted.postMessageId,
      sentAt: TICK_AT,
      broadcastText: posted.text,
      approvalId: posted.approvalId,
      held: false,
      venue: { platform: 'x', category: 'harassment', statusMessageId: posted.statusMessageId },
    });
    await harness.db.run(sql`INSERT INTO meta (key, value) VALUES ('halted', 1)`);
    await harness.db.run(sql`UPDATE approvals SET voided_at = 1 WHERE report_id = ?`, [posted.reportId]);
    expect(await readEditTarget(harness.db, posted.reportId)).toMatchObject({ held: true, approvalId: null });
    expect(await readEditTarget(harness.db, 'nosuchreportxxxxxxxx')).toBeNull();
  });

  it('takes the record\'s time for the send when the claim\'s is not there', async () => {
    const harness = tickHarness();
    const reportId = await insertReport(harness.db, { status: 'posted', posting_started_at: 5, posted_at: 9, post_message_id: 3 });
    await harness.db.run(sql`UPDATE reports SET posting_started_at = NULL, posted_at = NULL, status = 'retracting' WHERE id = ?`, [reportId]);
    expect((await readEditTarget(harness.db, reportId))?.sentAt).toBeNull();
  });
});

describe('concludeEdit', () => {
  it('refuses a target without its post or its approval record, before any call', async () => {
    const harness = tickHarness();
    const posted = await closing(harness);
    const target = await readEditTarget(harness.db, posted.reportId);
    if (target === null) throw new Error('no target');
    await expect(concludeEdit(harness.deps, { ...target, approvalId: null }, { ...CLOSURE, text: 'x' })).rejects.toMatchObject({ code: 'UNEXPECTED' });
    await expect(concludeEdit(harness.deps, { ...target, postMessageId: null }, { ...CLOSURE, text: 'x' })).rejects.toMatchObject({ code: 'UNEXPECTED' });
    expect(harness.telegram.callsOf('editMessageText').filter((call) => call.chatId === IDS.broadcastChannel)).toEqual([]);
  });

  it('concludes nothing, and touches nothing after, when a change overtook the edit', async () => {
    const harness = tickHarness();
    const posted = await closing(harness);
    const target = await readEditTarget(harness.db, posted.reportId);
    if (target === null) throw new Error('no target');
    await harness.db.run(sql`INSERT INTO meta (key, value) VALUES ('halted', 1)`);
    const venueBefore = harness.telegram.calls.filter((call) => call.chatId === IDS.adminChat).length;
    expect(await concludeEdit(harness.deps, target, { ...CLOSURE, text: closedPostText(posted.text, 'taken_down') })).toBe(false);
    expect(await reportRow(harness.db, posted.reportId)).toMatchObject({ status: 'closing', data_deleted_at: null });
    expect(harness.telegram.calls.filter((call) => call.chatId === IDS.adminChat).length).toBe(venueBefore);
    expect(harness.log.records().filter((record) => record.event === 'edit.unconcluded')).toEqual([{ level: 'info', event: 'edit.unconcluded', reportId: posted.reportId }]);
  });

  it("deletes the report's prompts from their chats once it concluded, within the 48 hours, and the venue's not under lockdown", async () => {
    for (const locked of [false, true]) {
      const harness = tickHarness();
      const posted = await plantPosted(harness);
      await harness.db.run(sql`UPDATE reports SET status = 'retracting', correction_text = 'A neutral correction.' WHERE id = ?`, [posted.reportId]);
      const prompts = [
        { chatId: IDS.adminChat, promptMessageId: 801, createdAt: TICK_AT - MINUTE },
        { chatId: IDS.keyholder, promptMessageId: 802, createdAt: TICK_AT - MINUTE },
        { chatId: IDS.secondKeyholder, promptMessageId: 803, createdAt: TICK_AT - MESSAGE_DELETE_WINDOW_MS },
      ];
      for (const prompt of prompts) {
        harness.telegram.seedMessage(prompt.chatId, { message_id: prompt.promptMessageId, text: 'a prompt' });
        await createPrompt(harness.db, { ...prompt, adminId: prompt.chatId === IDS.adminChat ? IDS.admin : prompt.chatId, reportId: posted.reportId, kind: 'retraction', category: null, linkMode: null });
      }
      if (locked) await setLockdown(harness.db, harness.clock);
      const target = await readEditTarget(harness.db, posted.reportId);
      if (target === null) throw new Error('no target');
      expect(
        await concludeEdit(harness.deps, target, { conclusion: { from: 'retracting', to: 'retracted' }, text: 'A neutral correction.', deleteYoung: false, done: 'retract.done', notice: null }),
      ).toBe(true);
      const left = (chatId: number, id: number) => harness.telegram.messageIn(chatId, id) !== undefined;
      expect([left(IDS.adminChat, 801), left(IDS.keyholder, 802), left(IDS.secondKeyholder, 803)], String(locked)).toEqual([locked, false, true]);
      expect(await harness.db.all(sql`SELECT * FROM admin_prompts`)).toEqual([]);
    }
  });
});

describe('flagEdit', () => {
  it('flags the report and alerts once, to the keyholders and the venue, with the status card\'s note', async () => {
    const harness = tickHarness();
    const posted = await closing(harness);
    const target = await readEditTarget(harness.db, posted.reportId);
    if (target === null) throw new Error('no target');
    await flagEdit(harness.deps, target);
    await flagEdit(harness.deps, target);
    const alert = t('en', 'alert.edit_held', { id: posted.reportId, state: t('en', 'status.closing') });
    expect(harness.telegram.callsOf('sendMessage').filter((call) => String(call.payload.text).includes(alert)).map((call) => call.chatId)).toEqual([IDS.keyholder, IDS.secondKeyholder]);
    expect(harness.telegram.callsOf('sendMessage').filter((call) => call.chatId === IDS.adminChat)).toHaveLength(1);
    expect(await reportRow(harness.db, posted.reportId)).toMatchObject({ needs_attention: 1, alert_sent_at: TICK_AT });
    expect(harness.telegram.messageIn(IDS.adminChat, posted.statusMessageId)?.text).toContain(t(harness.config.venueLocale, 'review.status_card.note.edit_failed', { id: posted.reportId }));
  });

  it('under lockdown alerts the keyholders only and leaves the status card alone', async () => {
    const harness = tickHarness();
    const posted = await closing(harness);
    await setLockdown(harness.db, harness.clock);
    const target = await readEditTarget(harness.db, posted.reportId);
    if (target === null) throw new Error('no target');
    const before = harness.telegram.messageIn(IDS.adminChat, posted.statusMessageId)?.text;
    const from = harness.telegram.calls.length;
    await flagEdit(harness.deps, target);
    expect(harness.telegram.calls.slice(from).map((call) => [call.method, call.chatId])).toEqual([
      ['sendMessage', IDS.keyholder],
      ['sendMessage', IDS.secondKeyholder],
    ]);
    expect(harness.telegram.messageIn(IDS.adminChat, posted.statusMessageId)?.text).toBe(before);
  });

  it('leaves the flag unmarked when no keyholder got the alert, for reconciliation to send again', async () => {
    const harness = tickHarness();
    const posted = await closing(harness);
    for (const keyholder of harness.config.keyholderIds) harness.telegram.fail({ chatId: keyholder }, FAILURES.botBlocked);
    const target = await readEditTarget(harness.db, posted.reportId);
    if (target === null) throw new Error('no target');
    await flagEdit(harness.deps, target);
    expect(await reportRow(harness.db, posted.reportId)).toMatchObject({ needs_attention: 1, alert_sent_at: null });
  });
});

describe('dropStale', () => {
  it('drops a job whose report left the state, and keeps one whose report is in it', async () => {
    const harness = tickHarness();
    const reportId = await insertReport(harness.db, { status: 'posted', posting_started_at: 1, posted_at: 2, post_message_id: 4 });
    await insertApproval(harness.db, reportId);
    await harness.db.run(sql`INSERT INTO jobs (id, kind, report_id, due_at, payload, attempts, created_at) VALUES ('stalejobxxxxxxxxxxxx', 'edit', ?, 1, '{"action":"retract"}', 0, 1)`, [reportId]);
    const job = { id: 'stalejobxxxxxxxxxxxx', reportId, action: 'retract' as const, dueAt: 1, attempts: 0 };
    await harness.db.run(sql`UPDATE reports SET status = 'retracting' WHERE id = ?`, [reportId]);
    await dropStale(harness.deps, job, 'retracting');
    expect(await harness.db.all(sql`SELECT id FROM jobs`)).toHaveLength(1);
    await harness.db.run(sql`UPDATE reports SET status = 'posted' WHERE id = ?`, [reportId]);
    await dropStale(harness.deps, job, 'retracting');
    expect(await harness.db.all(sql`SELECT id FROM jobs`)).toEqual([]);
  });
});

describe('the helpers', () => {
  it('deleteFromChat tries twice, takes a message already gone as deleted, and logs a failure by class', async () => {
    const harness = tickHarness();
    harness.telegram.seedMessage(IDS.keyholder, { message_id: 5, text: 'x' });
    harness.telegram.fail({ method: 'deleteMessage' }, FAILURES.serverError, 1);
    expect(await deleteFromChat(harness.deps, IDS.keyholder, 5)).toBe(true);
    expect(await deleteFromChat(harness.deps, IDS.keyholder, 5)).toBe(true);
    harness.telegram.fail({ method: 'deleteMessage' }, FAILURES.messageCantBeDeleted, 2);
    harness.telegram.seedMessage(IDS.keyholder, { message_id: 6, text: 'x' });
    expect(await deleteFromChat(harness.deps, IDS.keyholder, 6)).toBe(false);
    expect(harness.log.records().filter((record) => record.event === 'review.message_not_deleted')).toHaveLength(1);
  });

  it('lockedOrUnknown reads the switch and the override, and takes an unreadable switch as locked', async () => {
    const harness = tickHarness();
    expect(await lockedOrUnknown(harness.deps)).toBe(false);
    expect(await lockedOrUnknown({ ...harness.deps, db: failingReads(harness.db) })).toBe(true);
    expect(await lockedOrUnknown({ ...harness.deps, config: tickHarness({ variables: { LOCKDOWN: '1' } }).config })).toBe(true);
  });

  it('showState edits the status card unless locked down or unknown, and never throws', async () => {
    const harness = tickHarness();
    const posted = await plantPosted(harness);
    const venue = { platform: 'x' as const, category: 'harassment' as const, reporterRef: null, cardMessageId: null, statusMessageId: posted.statusMessageId };
    await showState({ ...harness.deps, db: failingReads(harness.db) }, posted.reportId, venue, 'closing', 'closing');
    await showState(harness.deps, posted.reportId, { ...venue, statusMessageId: null }, 'closing', 'closing');
    expect(harness.telegram.messageIn(IDS.adminChat, posted.statusMessageId)?.text).not.toContain(t(harness.config.venueLocale, 'review.status_card.note.closing', { id: posted.reportId }));
    harness.telegram.fail({ method: 'editMessageText', chatId: IDS.adminChat }, FAILURES.serverError, 1);
    await showState(harness.deps, posted.reportId, venue, 'closing', 'closing');
    await showState(harness.deps, posted.reportId, venue, 'closing', 'closing');
    expect(harness.telegram.messageIn(IDS.adminChat, posted.statusMessageId)?.text).toContain(t(harness.config.venueLocale, 'review.status_card.note.closing', { id: posted.reportId }));
  });
});

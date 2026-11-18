// Unit tests for the Cancel's batch (src/review/cancel.ts; critical
// invariant 1), on node:sqlite with the D1 migrations: an approved report
// back to pending, its approval voided and its post job deleted, together;
// nothing done by a stale Cancel of an approval a re-approval replaced, nor
// for a report the tick claimed or posted; and the re-approval after it
// under a new approval id, so the cancelled job's id claims nothing. And
// the two Cancels called as the handlers call them: an admin's whose steps
// after the commit fail, answered "cancelled" and logged by class; a
// keyholder's on the notice of an approval not recorded, which writes and
// edits nothing and says so while the notice is five minutes old or
// younger, and settles an older one as cancelled.
import { describe, expect, it } from 'vitest';
import { fakeBotApi } from '../../test/fakes/bot-api';
import { fakeClock } from '../../test/fakes/clock';
import { recordingLogger } from '../../test/fakes/logger';
import { testConfig } from '../../test/support/config';
import { migratedDatabase } from '../../test/support/database';
import { insertApproval, insertReport, reportRow, snapshot } from '../../test/support/review-rows';
import { IDS } from '../../test/support/variables';
import { enqueuePostStatement } from '../broadcast/jobs';
import { randomId } from '../db/ids';
import { sql, type SqlDb, type SqlText, type SqlValue } from '../db/sql';
import { AppError } from '../errors/app-error';
import { t } from '../i18n/index';
import { createBotApi } from '../telegram/api';
import { writeApproval } from './approve';
import { cancelByAdmin, cancelByKeyholder, NOTICE_SETTLE_MS, writeCancel } from './cancel';
import { cancelledNoticeText, createNoticeMemory } from './notify';

const NOW = 1_800_000_000_000;
const setup = () => migratedDatabase(fakeClock(NOW));

/** An approved report with its approval and post job; the report's and the approval's ids. */
const approved = async (db: SqlDb): Promise<{ reportId: string; approvalId: string }> => {
  const reportId = await insertReport(db, { broadcast_text: 'a post', link_mode: 'account', status_message_id: 9 });
  const approvalId = await insertApproval(db, reportId, { approvedAt: NOW - 1000, startsAt: NOW + 60_000 });
  await db.run(sql`UPDATE reports SET status = 'approved' WHERE id = ?`, [reportId]);
  const job = enqueuePostStatement({ reportId, approvalId, startsAt: NOW + 60_000, now: NOW - 1000 });
  await db.run(job.sql, job.params);
  return { reportId, approvalId };
};

describe('the Cancel batch', () => {
  it('returns the report to pending, voids its approval and deletes its post job, together', async () => {
    const { db } = setup();
    const { reportId, approvalId } = await approved(db);
    expect(await writeCancel({ db }, reportId, approvalId, NOW)).toBe(true);
    expect(await reportRow(db, reportId)).toMatchObject({ status: 'pending', broadcast_text: null, link_mode: null, status_message_id: null });
    expect(await db.all(sql`SELECT approval_id, voided_at FROM approvals`)).toEqual([{ approval_id: approvalId, voided_at: NOW }]);
    expect(await db.all(sql`SELECT * FROM jobs`)).toEqual([]);
  });

  it('does nothing a second time, nor for another approval id', async () => {
    const { db } = setup();
    const { reportId, approvalId } = await approved(db);
    const before = await snapshot(db);
    expect(await writeCancel({ db }, reportId, randomId(), NOW)).toBe(false);
    expect(await snapshot(db)).toEqual(before);
    expect(await writeCancel({ db }, reportId, approvalId, NOW)).toBe(true);
    const cancelled = await snapshot(db);
    expect(await writeCancel({ db }, reportId, approvalId, NOW + 1)).toBe(false);
    expect(await snapshot(db)).toEqual(cancelled);
  });

  it('does nothing for a report the tick claimed, or one already posted', async () => {
    const { db } = setup();
    const { reportId, approvalId } = await approved(db);
    await db.run(sql`UPDATE reports SET status = 'posting', posting_started_at = ? WHERE id = ?`, [NOW, reportId]);
    const before = await snapshot(db);
    expect(await writeCancel({ db }, reportId, approvalId, NOW)).toBe(false);
    expect(await snapshot(db)).toEqual(before);
    await db.run(sql`UPDATE reports SET status = 'posted', posted_at = ?, post_message_id = 5 WHERE id = ?`, [NOW + 1, reportId]);
    expect(await writeCancel({ db }, reportId, approvalId, NOW)).toBe(false);
    expect(await db.all(sql`SELECT voided_at FROM approvals`)).toEqual([{ voided_at: null }]);
  });

  it('leaves a re-approval alone: a stale Cancel of the cancelled approval does nothing to it', async () => {
    const { db } = setup();
    const { reportId, approvalId } = await approved(db);
    expect(await writeCancel({ db }, reportId, approvalId, NOW)).toBe(true);
    const again = randomId();
    expect(
      await writeApproval(
        { db },
        {
          reportId,
          approvalId: again,
          jobId: randomId(),
          adminId: IDS.secondAdmin,
          category: 'harassment',
          linkMode: 'account',
          links: { url: 'https://x.com/someone/status/1234567890', accountUrl: 'https://x.com/someone' },
          recommendedComment: 'points',
          broadcastText: 'a post',
          now: NOW + 10,
          startsAt: NOW + 10 + 60_000,
          prompt: { chatId: IDS.adminChat, promptMessageId: 1 },
        },
      ),
    ).toBe(true);
    expect(await writeCancel({ db }, reportId, approvalId, NOW + 20)).toBe(false);
    expect(await reportRow(db, reportId)).toMatchObject({ status: 'approved' });
    expect(await db.all(sql`SELECT json_extract(payload, '$.approval_id') AS approval_id FROM jobs`)).toEqual([{ approval_id: again }]);
  });
});

/** The flows' deps over `db`: the fake Bot API, the test configuration, a recording logger, a fresh notice memory. */
const flowDeps = (db: SqlDb) => {
  const config = testConfig();
  const telegram = fakeBotApi();
  const log = recordingLogger();
  const deps = { api: createBotApi(config, telegram.fetch), config, db, clock: fakeClock(NOW), logger: log.logger, notices: createNoticeMemory() };
  return { deps, telegram, log };
};

describe('the Cancels as the handlers call them', () => {
  it("answers an admin's Cancel \"cancelled\" when the steps after the commit fail, and logs that by class", async () => {
    const { db } = setup();
    const { reportId, approvalId } = await approved(db);
    let committed = false;
    // Every read after the Cancel's batch fails: the lockdown read first.
    const store: SqlDb = {
      run: (text, params) => db.run(text, params),
      all: <T extends object>(text: SqlText, params?: readonly SqlValue[]) => db.all<T>(text, params),
      first: <T extends object>(text: SqlText, params?: readonly SqlValue[]) =>
        committed ? Promise.reject(new AppError('STORAGE_FAILURE', 'D1 read failed')) : db.first<T>(text, params),
      batch: async (statements) => {
        const results = await db.batch(statements);
        committed = true;
        return results;
      },
    };
    const { deps, log } = flowDeps(store);
    const outcome = await cancelByAdmin(deps, { id: IDS.admin, locale: 'fa' }, reportId, approvalId, { chatId: IDS.adminChat, messageId: 7 });
    expect(outcome).toEqual({ answer: t('fa', 'review.answer.cancelled') });
    expect(await reportRow(db, reportId)).toMatchObject({ status: 'pending' });
    expect(log.records()).toEqual([{ level: 'error', event: 'review.message_not_edited', reportId, errorClass: 'AppError', errorCode: 'STORAGE_FAILURE' }]);
  });

  it("writes and edits nothing at a keyholder's Cancel of an approval not recorded, and says so, while the notice is five minutes old or younger", async () => {
    for (const earlier of [false, true]) {
      // The notice's age unknown, a second, exactly the five minutes.
      for (const sentAt of [undefined, NOW - 1000, NOW - NOTICE_SETTLE_MS]) {
        const label = `${String(earlier)} ${String(sentAt)}`;
        const { db } = setup();
        const reportId = await insertReport(db);
        // No approval row yet, or only an earlier approval's, voided.
        if (earlier) await insertApproval(db, reportId, { voidedAt: NOW - 1 });
        const before = await snapshot(db);
        const { deps, telegram } = flowDeps(db);
        const pressed = { chatId: IDS.keyholder, messageId: 3, ...(sentAt === undefined ? {} : { sentAt }) };
        const outcome = await cancelByKeyholder(deps, { id: IDS.keyholder, locale: 'en' }, reportId, randomId(), pressed);
        expect(outcome, label).toEqual({ answer: t('en', 'review.answer.not_recorded') });
        expect(await snapshot(db), label).toEqual(before);
        expect(telegram.calls, label).toEqual([]);
      }
    }
  });

  it("settles the notice of an approval not recorded as cancelled once it is older than five minutes, writing nothing", async () => {
    // Just past the five minutes, and a message Telegram no longer gives (date 0).
    for (const sentAt of [NOW - NOTICE_SETTLE_MS - 1, 0]) {
      const { db } = setup();
      const reportId = await insertReport(db);
      const before = await snapshot(db);
      const { deps, telegram } = flowDeps(db);
      telegram.seedMessage(IDS.keyholder, { message_id: 3, text: 'the notice' });
      const outcome = await cancelByKeyholder(deps, { id: IDS.keyholder, locale: 'en' }, reportId, randomId(), { chatId: IDS.keyholder, messageId: 3, sentAt });
      expect(outcome, String(sentAt)).toEqual({ answer: t('en', 'review.answer.already_cancelled') });
      expect(await snapshot(db), String(sentAt)).toEqual(before);
      expect(telegram.messageIn(IDS.keyholder, 3)?.text, String(sentAt)).toBe(cancelledNoticeText(reportId));
      expect(telegram.callsOf('editMessageText').map((call) => call.chatId), String(sentAt)).toEqual([IDS.keyholder]);
    }
  });

  it("edits the notice of an approval recorded and cancelled since to \"cancelled\" at a keyholder's Cancel", async () => {
    const { db } = setup();
    const { reportId, approvalId } = await approved(db);
    expect(await writeCancel({ db }, reportId, approvalId, NOW)).toBe(true);
    const { deps, telegram } = flowDeps(db);
    telegram.seedMessage(IDS.keyholder, { message_id: 3, text: 'the notice' });
    const outcome = await cancelByKeyholder(deps, { id: IDS.keyholder, locale: 'en' }, reportId, approvalId, { chatId: IDS.keyholder, messageId: 3 });
    expect(outcome).toEqual({ answer: t('en', 'review.answer.already_cancelled') });
    expect(telegram.callsOf('editMessageText').map((call) => call.chatId)).toEqual([IDS.keyholder]);
  });
});

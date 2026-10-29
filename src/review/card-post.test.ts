// Unit tests for posting the review card (src/review/card-post.ts; critical
// invariants 3, 4 and 5): a pending report's card to the venue and nowhere
// else, its message id stored; none for a merged duplicate; a failure
// logged by class and never thrown; /card's new card in place of the old
// one, for a pending report only; and no card left in the venue that its
// report does not know of: a card sent for a report that left review
// before its id was stored is deleted, or edited to the outcome, and one
// whose id could not be stored is deleted.
import { describe, expect, it } from 'vitest';
import { FAILURES, fakeBotApi } from '../../test/fakes/bot-api';
import { fakeClock } from '../../test/fakes/clock';
import { recordingLogger } from '../../test/fakes/logger';
import { IDS, testConfig } from '../../test/support/config';
import { migratedDatabase } from '../../test/support/database';
import { insertReport, reportRow } from '../../test/support/review-rows';
import { sql, type SqlDb, type SqlRunResult, type SqlText, type SqlValue } from '../db/sql';
import { AppError } from '../errors/app-error';
import { t } from '../i18n/index';
import { createBotApi } from '../telegram/api';
import { postReviewCard, repostCard } from './card-post';

const setup = (variables: Readonly<Record<string, string>> = {}) => {
  const config = testConfig(variables);
  const telegram = fakeBotApi();
  const { db } = migratedDatabase(fakeClock(1_800_000_000_000));
  const log = recordingLogger();
  return { config, telegram, db, log, deps: { api: createBotApi(config, telegram.fetch), config, db, logger: log.logger } };
};

/** `db`, with `store` in place of its own run() for the store of the card's id. */
const storingCardWith = (db: SqlDb, store: (text: SqlText, params?: readonly SqlValue[]) => Promise<SqlRunResult>): SqlDb => ({
  run: (text, params) => (text.startsWith('UPDATE reports SET card_message_id') ? store(text, params) : db.run(text, params)),
  all: <T extends object>(text: SqlText, params?: readonly SqlValue[]) => db.all<T>(text, params),
  first: <T extends object>(text: SqlText, params?: readonly SqlValue[]) => db.first<T>(text, params),
  batch: (statements) => db.batch(statements),
});

describe('postReviewCard', () => {
  it("posts a pending report's card to the venue only, and stores its message id", async () => {
    const { deps, telegram, db } = setup();
    const reportId = await insertReport(db, { card_message_id: null });
    expect(await postReviewCard(deps, reportId)).toBe(1);
    expect(telegram.calls.map((call) => [call.method, call.chatId])).toEqual([['sendMessage', IDS.adminChat]]);
    expect(String(telegram.calls[0]?.payload.text)).toContain(`<code>${reportId}</code>`);
    expect(telegram.calls[0]?.payload.link_preview_options).toEqual({ is_disabled: true });
    expect(await reportRow(db, reportId)).toMatchObject({ card_message_id: 1 });
  });

  it('posts nothing for a merged duplicate, or a report that is gone', async () => {
    const { deps, telegram, db } = setup();
    const primary = await insertReport(db);
    const merged = await insertReport(db, { status: 'merged', merged_into: primary, card_message_id: null });
    expect(await postReviewCard(deps, merged)).toBeNull();
    expect(await postReviewCard(deps, 'nosuchreportxxxxxxxx')).toBeNull();
    expect(telegram.calls).toEqual([]);
  });

  it('is in Persian by default, and in English under VENUE_LOCALE=en', async () => {
    for (const [variables, locale] of [[{}, 'fa'], [{ VENUE_LOCALE: 'en' }, 'en']] as const) {
      const { deps, telegram, db } = setup(variables);
      const reportId = await insertReport(db, { card_message_id: null });
      await postReviewCard(deps, reportId);
      expect(String(telegram.callsOf('sendMessage')[0]?.payload.text)).toContain(
        t(locale, 'review.card.hint', { category: t(locale, 'review.category.harassment') }),
      );
    }
  });

  it('logs a failed card by class, never throws, and leaves the report pending without a card', async () => {
    const { deps, telegram, db, log } = setup();
    const reportId = await insertReport(db, { card_message_id: null });
    telegram.fail({ method: 'sendMessage' }, FAILURES.chatNotFound);
    expect(await postReviewCard(deps, reportId)).toBeNull();
    expect(await reportRow(db, reportId)).toMatchObject({ status: 'pending', card_message_id: null });
    expect(log.records()).toEqual([
      { level: 'error', event: 'review.card_not_sent', reportId, errorClass: 'GrammyError', telegramErrorCode: 400, apiMethod: 'sendMessage' },
    ]);
  });
});

describe('repostCard', () => {
  it("posts a new card in the venue's language and deletes the old one", async () => {
    const { deps, telegram, db } = setup();
    telegram.seedMessage(IDS.adminChat, { message_id: 7, text: 'the old card' });
    const reportId = await insertReport(db, { card_message_id: 7 });
    expect(await repostCard(deps, reportId)).toBe('posted');
    expect(telegram.messageIn(IDS.adminChat, 7)).toBeUndefined();
    expect(String(telegram.messageIn(IDS.adminChat, 8)?.text)).toContain(t('fa', 'review.card.hint', { category: t('fa', 'review.category.harassment') }));
    expect(await reportRow(db, reportId)).toMatchObject({ card_message_id: 8 });
  });

  it('edits an old card it cannot delete to say it is out of date', async () => {
    const { deps, telegram, db } = setup();
    telegram.seedMessage(IDS.adminChat, { message_id: 7, text: 'the old card' });
    telegram.fail({ method: 'deleteMessage' }, FAILURES.messageCantBeDeleted);
    const reportId = await insertReport(db, { card_message_id: 7 });
    await repostCard(deps, reportId);
    expect(telegram.messageIn(IDS.adminChat, 7)?.text).toBe(t('fa', 'review.card.replaced', { id: reportId }));
  });

  it('posts nothing for a report that is not pending, or not there', async () => {
    const { deps, telegram, db } = setup();
    const rejected = await insertReport(db, { status: 'rejected' });
    expect(await repostCard(deps, rejected)).toBe('not_pending');
    expect(await repostCard(deps, 'nosuchreportxxxxxxxx')).toBe('not_found');
    expect(telegram.calls).toEqual([]);
  });
});

describe('a card its report does not know of', () => {
  it('is deleted when the report left review before the card\'s id was stored', async () => {
    const { deps, telegram, db, log } = setup();
    const reportId = await insertReport(db, { card_message_id: null });
    const store = storingCardWith(db, async (text, params) => {
      await db.run(sql`UPDATE reports SET status = 'rejected', decided_at = 1, decided_by = 424240011 WHERE id = ?`, [reportId]);
      return db.run(text, params);
    });
    expect(await postReviewCard({ ...deps, db: store }, reportId)).toBeNull();
    expect(telegram.callsOf('sendMessage')).toHaveLength(1);
    expect(telegram.messagesIn(IDS.adminChat)).toEqual([]);
    expect(await reportRow(db, reportId)).toMatchObject({ status: 'rejected', card_message_id: null });
    expect(log.records()).toEqual([]);
  });

  it('is edited to the outcome, without links or buttons, when it cannot be deleted', async () => {
    const { deps, telegram, db } = setup();
    const reportId = await insertReport(db, { card_message_id: null });
    telegram.fail({ method: 'deleteMessage' }, FAILURES.messageCantBeDeleted);
    const store = storingCardWith(db, async (text, params) => {
      await db.run(sql`UPDATE reports SET status = 'rejected', decided_at = 1, decided_by = 424240011 WHERE id = ?`, [reportId]);
      return db.run(text, params);
    });
    expect(await postReviewCard({ ...deps, db: store }, reportId)).toBeNull();
    const [card] = telegram.messagesIn(IDS.adminChat);
    expect(card?.text).toBe(t('fa', 'review.card.outcome', { id: reportId, outcome: t('fa', 'status.rejected') }));
    expect(card?.reply_markup).toBeUndefined();
  });

  it('is deleted when the report is gone before the card\'s id was stored', async () => {
    const { deps, telegram, db } = setup();
    const reportId = await insertReport(db, { card_message_id: null });
    const store = storingCardWith(db, async (text, params) => {
      await db.run(sql`DELETE FROM reports WHERE id = ?`, [reportId]);
      return db.run(text, params);
    });
    expect(await postReviewCard({ ...deps, db: store }, reportId)).toBeNull();
    expect(telegram.messagesIn(IDS.adminChat)).toEqual([]);
  });

  it('is deleted when its id cannot be stored: logged by class at the submit, thrown on to /card', async () => {
    const { deps, telegram, db, log } = setup();
    const reportId = await insertReport(db, { card_message_id: null });
    const store = storingCardWith(db, () => Promise.reject(new AppError('STORAGE_FAILURE', 'D1 run failed')));
    expect(await postReviewCard({ ...deps, db: store }, reportId)).toBeNull();
    expect(telegram.messagesIn(IDS.adminChat)).toEqual([]);
    expect(log.records()).toEqual([{ level: 'error', event: 'review.card_not_sent', reportId, errorClass: 'AppError', errorCode: 'STORAGE_FAILURE' }]);
    await expect(repostCard({ ...deps, db: store }, reportId)).rejects.toMatchObject({ code: 'STORAGE_FAILURE' });
    expect(telegram.messagesIn(IDS.adminChat)).toEqual([]);
  });

  it('leaves /card\'s old card alone when the report was decided while the new one went out', async () => {
    const { deps, telegram, db } = setup();
    telegram.seedMessage(IDS.adminChat, { message_id: 7, text: 'the old card, edited to the outcome' });
    const reportId = await insertReport(db, { card_message_id: 7 });
    const store = storingCardWith(db, async (text, params) => {
      await db.run(sql`UPDATE reports SET status = 'rejected', decided_at = 1, decided_by = 424240011 WHERE id = ?`, [reportId]);
      return db.run(text, params);
    });
    expect(await repostCard({ ...deps, db: store }, reportId)).toBe('not_pending');
    expect(telegram.messagesIn(IDS.adminChat).map((message) => [message.message_id, message.text])).toEqual([[7, 'the old card, edited to the outcome']]);
  });
});

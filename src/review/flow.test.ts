// Unit tests for what the review's presses and replies share
// (src/review/flow.ts; critical invariants 1, 2 and 8), over the fake Bot
// API and node:sqlite: a press bound to its report's own card (or status
// card), a decided report's press answered with its state on whatever card
// it sat, an out-of-date card refused; a prompt sent as a force reply under
// the card and recorded with the admin's choice, an admin's earlier prompt
// replaced, a prompt whose record fails taking its message with it.
import { describe, expect, it } from 'vitest';
import { FAILURES, fakeBotApi } from '../../test/fakes/bot-api';
import { fakeClock } from '../../test/fakes/clock';
import { recordingLogger } from '../../test/fakes/logger';
import { IDS, testConfig } from '../../test/support/config';
import { migratedDatabase } from '../../test/support/database';
import { insertReport } from '../../test/support/review-rows';
import { sql, type SqlDb } from '../db/sql';
import { t } from '../i18n/index';
import { createBotApi } from '../telegram/api';
import { clearActorPrompts, loadPress, promptView, sendPrompt, showDecided } from './flow';
import { createNoticeMemory } from './notify';
import { promptsOf } from './prompts';
import { readReport } from './reports';
import type { ReviewDeps } from './venue';

const ADMIN = { id: IDS.admin, locale: 'en' as const };

const setup = () => {
  const config = testConfig();
  const telegram = fakeBotApi();
  const clock = fakeClock(1_800_000_000_000);
  const { db } = migratedDatabase(clock);
  const deps: ReviewDeps = { api: createBotApi(config, telegram.fetch), config, db, clock, logger: recordingLogger().logger, notices: createNoticeMemory() };
  return { telegram, db, deps };
};

const report = async (db: SqlDb, fields: Parameters<typeof insertReport>[1] = {}) => {
  const id = await insertReport(db, { card_message_id: 7, ...fields });
  const read = await readReport(db, id);
  if (read === null) throw new Error('no report');
  return read;
};

describe('loadPress', () => {
  it("takes a press on the report's own card, and on its status card when allowed", async () => {
    const { db, deps } = setup();
    const pending = await report(db, { status_message_id: 9 });
    expect(await loadPress(deps, ADMIN, pending.id, { chatId: IDS.adminChat, messageId: 7 }, { pendingOnly: true })).toEqual({ ok: true, report: pending });
    expect(await loadPress(deps, ADMIN, pending.id, { chatId: IDS.adminChat, messageId: 9 }, { pendingOnly: false, statusCard: true })).toMatchObject({ ok: true });
    expect(await loadPress(deps, ADMIN, pending.id, { chatId: IDS.adminChat, messageId: 9 }, { pendingOnly: true })).toEqual({
      ok: false,
      outcome: { answer: t('en', 'review.answer.stale_card') },
    });
  });

  it('refuses a press outside the venue, on another message, or of a report that is gone or merged', async () => {
    const { db, deps } = setup();
    const pending = await report(db);
    const merged = await report(db, { status: 'merged', merged_into: pending.id });
    const stale = { ok: false, outcome: { answer: t('en', 'review.answer.stale_card') } };
    const gone = { ok: false, outcome: { answer: t('en', 'review.answer.gone') } };
    expect(await loadPress(deps, ADMIN, pending.id, { chatId: IDS.admin, messageId: 7 }, { pendingOnly: true })).toEqual(stale);
    expect(await loadPress(deps, ADMIN, pending.id, { chatId: IDS.adminChat, messageId: 8 }, { pendingOnly: true })).toEqual(stale);
    expect(await loadPress(deps, ADMIN, 'nosuchreportxxxxxxxx', { chatId: IDS.adminChat, messageId: 7 }, { pendingOnly: true })).toEqual(gone);
    expect(await loadPress(deps, ADMIN, merged.id, { chatId: IDS.adminChat, messageId: 7 }, { pendingOnly: true })).toEqual(gone);
  });

  it("answers a decided report's press with its state, and edits its card to the outcome, on whatever card it sat", async () => {
    const { db, deps, telegram } = setup();
    telegram.seedMessage(IDS.adminChat, { message_id: 7, text: 'the card' });
    const rejected = await report(db, { status: 'rejected' });
    const answer = { ok: false, outcome: { answer: t('en', 'review.answer.decided', { state: t('en', 'status.rejected') }) } };
    expect(await loadPress(deps, ADMIN, rejected.id, { chatId: IDS.adminChat, messageId: 7 }, { pendingOnly: true })).toEqual(answer);
    // The card is in the venue's language (Persian by default), the answer in the actor's.
    expect(telegram.messageIn(IDS.adminChat, 7)?.text).toBe(t('fa', 'review.card.outcome', { id: rejected.id, outcome: t('fa', 'status.rejected') }));
    // A card the winner's batch cleared: the answer still says what happened, and nothing is edited.
    const routed = await report(db, { status: 'routed', card_message_id: null });
    const edits = telegram.count('editMessageText');
    expect(await loadPress(deps, ADMIN, routed.id, { chatId: IDS.adminChat, messageId: 12 }, { pendingOnly: true })).toEqual({
      ok: false,
      outcome: { answer: t('en', 'review.answer.decided', { state: t('en', 'status.routed') }) },
    });
    expect(telegram.count('editMessageText')).toBe(edits);
  });

  it('lets a press that needs no pending report through on a decided one', async () => {
    const { db, deps } = setup();
    const approved = await report(db, { status: 'rejected' });
    expect(await loadPress(deps, ADMIN, approved.id, { chatId: IDS.adminChat, messageId: 7 }, { pendingOnly: false })).toMatchObject({ ok: true });
  });
});

describe('showDecided', () => {
  it('edits nothing but the report\'s own card', async () => {
    const { db, deps, telegram } = setup();
    const rejected = await report(db, { status: 'rejected' });
    await showDecided(deps, ADMIN, rejected, 99);
    expect(telegram.count('editMessageText')).toBe(0);
  });
});

describe('prompts', () => {
  it('are sent as a force reply under the card and recorded with the choice', async () => {
    const { db, deps, telegram } = setup();
    const pending = await report(db);
    await sendPrompt(deps, ADMIN, pending, 'recommended_comment', { category: 'harassment', linkMode: 'post' });
    const [call] = telegram.callsOf('sendMessage');
    expect(call?.chatId).toBe(IDS.adminChat);
    expect(call?.payload.reply_markup).toEqual(promptView('recommended_comment', pending.id, 'fa').forceReply);
    expect(call?.payload.reply_parameters).toEqual({ message_id: 7, allow_sending_without_reply: true });
    expect(call?.payload.text).toBe(t('fa', 'review.prompt.points', { id: pending.id }));
    expect(await promptsOf(db, pending.id)).toEqual([
      expect.objectContaining({ promptMessageId: 1, adminId: IDS.admin, kind: 'recommended_comment', category: 'harassment', linkMode: 'post' }),
    ]);
  });

  it("replace the admin's earlier approval prompt, row and message, and leave another admin's alone, all in the venue's language", async () => {
    const { db, deps, telegram } = setup();
    const pending = await report(db);
    await sendPrompt(deps, ADMIN, pending, 'account_link', { category: 'harassment', linkMode: null });
    await sendPrompt(deps, { id: IDS.secondAdmin, locale: 'fa' }, pending, 'account_link', { category: 'other', linkMode: null });
    await sendPrompt(deps, ADMIN, pending, 'recommended_comment', { category: 'harassment', linkMode: 'account' });
    expect((await promptsOf(db, pending.id)).map((each) => [each.adminId, each.promptMessageId])).toEqual([
      [IDS.secondAdmin, 2],
      [IDS.admin, 3],
    ]);
    expect(telegram.messageIn(IDS.adminChat, 1)).toBeUndefined();
    expect(telegram.messageIn(IDS.adminChat, 2)?.text).toBe(t('fa', 'review.prompt.account', { id: pending.id }));
    await clearActorPrompts(deps, ADMIN, pending);
    expect((await promptsOf(db, pending.id)).map((each) => each.adminId)).toEqual([IDS.secondAdmin]);
    expect(telegram.messageIn(IDS.adminChat, 3)).toBeUndefined();
  });

  it('take their message with them when their record fails', async () => {
    const { db, deps, telegram } = setup();
    const pending = await report(db);
    await db.run(sql`DELETE FROM reports WHERE id = ?`, [pending.id]);
    await expect(sendPrompt(deps, ADMIN, pending, 'account_link', { category: 'harassment', linkMode: null })).rejects.toMatchObject({ code: 'STORAGE_FAILURE' });
    expect(telegram.messagesIn(IDS.adminChat)).toEqual([]);
  });

  it('send nothing when the venue refuses the prompt', async () => {
    const { db, deps, telegram } = setup();
    const pending = await report(db);
    telegram.fail({ method: 'sendMessage' }, FAILURES.chatNotFound);
    await expect(sendPrompt(deps, ADMIN, pending, 'account_link', { category: 'harassment', linkMode: null })).rejects.toThrow();
    expect(await promptsOf(db, pending.id)).toEqual([]);
  });
});

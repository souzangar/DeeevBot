// Unit tests for the keyholder's approval notice (src/review/notify.ts;
// critical invariants 1, 2, 4 and 5): the post as it goes out under a
// header in both locales, sent to every keyholder by direct message with a
// Cancel bound to the approval and a Lockdown beside it, a failure counted
// and never thrown, a text off the link policy never sent; the isolate's
// bounded memory of the notices; the edit to "cancelled", without links or
// buttons, of every remembered notice and the one pressed.
import { describe, expect, it } from 'vitest';
import { FAILURES, fakeBotApi } from '../../test/fakes/bot-api';
import { recordingLogger } from '../../test/fakes/logger';
import { IDS, testConfig } from '../../test/support/config';
import { AppError } from '../errors/app-error';
import { t } from '../i18n/index';
import { outgoingLinkProblems } from '../platforms/link-policy';
import { createBotApi } from '../telegram/api';
import { noticeData } from './callbacks';
import {
  cancelledNoticeText,
  createNoticeMemory,
  editNotices,
  noticeKeyboard,
  noticeText,
  notifyKeyholders,
  type NoticeFacts,
} from './notify';
import { POST_DIVIDER } from './render-post';

const FACTS: NoticeFacts = { reportId: 'abcdefghijklmnopqrst', platform: 'x', category: 'harassment', startsAt: Date.UTC(2027, 0, 15, 12, 30) };
const APPROVAL = 'zyxwvutsrqponmlkjihg';
const POST = '<b>The post</b>\nAccount: <code>https://x.com/someone</code>';

const setup = () => {
  const config = testConfig();
  const telegram = fakeBotApi();
  const log = recordingLogger();
  const notices = createNoticeMemory();
  return { config, telegram, log, notices, deps: { api: createBotApi(config, telegram.fetch), config, logger: log.logger, notices } };
};

describe('noticeText and the buttons', () => {
  it('heads the post with the report, its start and what the buttons do, in Persian and English', () => {
    const text = noticeText(FACTS, POST);
    for (const locale of ['fa', 'en'] as const) {
      expect(text).toContain(
        t(locale, 'notice.body', {
          id: FACTS.reportId,
          platform: t(locale, 'platform.x'),
          category: t(locale, 'review.category.harassment'),
          time: '2027-01-15 12:30 UTC',
        }),
      );
    }
    expect(text.endsWith(`\n\n${POST_DIVIDER}\n\n${POST}`)).toBe(true);
    // Persian first, like the post.
    expect(text.startsWith(t('fa', 'notice.body', { id: FACTS.reportId, platform: t('fa', 'platform.x'), category: t('fa', 'review.category.harassment'), time: '2027-01-15 12:30 UTC' }))).toBe(true);
  });

  it('gives a Cancel bound to the approval and a Lockdown, labelled in both locales', () => {
    expect(noticeKeyboard(FACTS.reportId, APPROVAL)).toEqual({
      inline_keyboard: [
        [
          { text: `${t('fa', 'notice.button.cancel')} · ${t('en', 'notice.button.cancel')}`, callback_data: noticeData({ kind: 'cancel', reportId: FACTS.reportId, approvalId: APPROVAL }) },
          { text: `${t('fa', 'notice.button.lockdown')} · ${t('en', 'notice.button.lockdown')}`, callback_data: 'kh:lk' },
        ],
      ],
    });
  });

  it('says "cancelled" without links', () => {
    const text = cancelledNoticeText(FACTS.reportId);
    expect(text).toBe(`${t('fa', 'notice.cancelled', { id: FACTS.reportId })}\n${t('en', 'notice.cancelled', { id: FACTS.reportId })}`);
    expect(text).not.toContain('https://');
    expect(outgoingLinkProblems(text, [])).toEqual([]);
  });
});

describe('notifyKeyholders', () => {
  it('sends the notice to every keyholder, and to nobody else, with its buttons, and remembers where', async () => {
    const { deps, telegram, notices } = setup();
    const outcome = await notifyKeyholders(deps, FACTS, APPROVAL, POST);
    expect(outcome).toMatchObject({ sent: 2, failed: 0 });
    const sends = telegram.callsOf('sendMessage');
    expect(sends.map((call) => call.chatId)).toEqual([IDS.keyholder, IDS.secondKeyholder]);
    for (const call of sends) {
      expect(call.payload.text).toBe(noticeText(FACTS, POST));
      expect(call.payload.reply_markup).toEqual(noticeKeyboard(FACTS.reportId, APPROVAL));
      expect(call.payload.link_preview_options).toEqual({ is_disabled: true });
    }
    expect(notices.recall(APPROVAL)).toEqual(outcome.deliveries);
  });

  it('counts a keyholder it could not reach, and throws nothing', async () => {
    const { deps, telegram, log } = setup();
    telegram.fail({ chatId: IDS.keyholder }, FAILURES.cantInitiateConversation);
    expect(await notifyKeyholders(deps, FACTS, APPROVAL, POST)).toMatchObject({ sent: 1, failed: 1 });
    expect(log.records().map((record) => record.event)).toEqual(['alert.failed']);
  });

  it('sends nothing for a post that carries a link off the lists', async () => {
    const { deps, telegram } = setup();
    await expect(notifyKeyholders(deps, FACTS, APPROVAL, 'see https://evil.test/')).rejects.toBeInstanceOf(AppError);
    expect(telegram.calls).toEqual([]);
  });
});

describe('the notice memory and editNotices', () => {
  it('keeps the newest approvals only, up to its bound', () => {
    const memory = createNoticeMemory(2);
    memory.remember('a', [{ chatId: 1, messageId: 1 }]);
    memory.remember('b', [{ chatId: 1, messageId: 2 }]);
    memory.remember('c', [{ chatId: 1, messageId: 3 }]);
    expect(memory.size).toBe(2);
    expect(memory.recall('a')).toEqual([]);
    expect(memory.recall('c')).toEqual([{ chatId: 1, messageId: 3 }]);
    memory.forget('c');
    expect(memory.recall('c')).toEqual([]);
  });

  it('edits every remembered notice and the pressed one to the text, without buttons, then forgets them', async () => {
    const { deps, telegram, notices } = setup();
    await notifyKeyholders(deps, FACTS, APPROVAL, POST);
    await editNotices(deps, APPROVAL, cancelledNoticeText(FACTS.reportId), { chatId: IDS.keyholder, messageId: 1 });
    for (const keyholder of [IDS.keyholder, IDS.secondKeyholder]) {
      expect(telegram.messageIn(keyholder, 1)).toMatchObject({ text: cancelledNoticeText(FACTS.reportId) });
      expect(telegram.messageIn(keyholder, 1)?.reply_markup).toBeUndefined();
    }
    expect(telegram.callsOf('editMessageText')).toHaveLength(2);
    expect(notices.recall(APPROVAL)).toEqual([]);
  });

  it('edits the pressed notice when nothing is remembered, and takes a notice gone or unchanged as done', async () => {
    const { deps, telegram, log } = setup();
    telegram.seedMessage(IDS.keyholder, { message_id: 4, text: 'a notice' });
    await editNotices(deps, APPROVAL, cancelledNoticeText(FACTS.reportId), { chatId: IDS.keyholder, messageId: 4 });
    await editNotices(deps, APPROVAL, cancelledNoticeText(FACTS.reportId), { chatId: IDS.keyholder, messageId: 4 });
    await editNotices(deps, APPROVAL, cancelledNoticeText(FACTS.reportId), { chatId: IDS.keyholder, messageId: 99 });
    expect(telegram.messageIn(IDS.keyholder, 4)).toMatchObject({ text: cancelledNoticeText(FACTS.reportId) });
    expect(log.lines).toEqual([]);
    telegram.fail({ method: 'editMessageText' }, FAILURES.serverError, 1);
    await editNotices(deps, APPROVAL, 'another text', { chatId: IDS.keyholder, messageId: 4 });
    expect(log.records().map((record) => record.event)).toEqual(['review.notice_not_edited']);
  });
});

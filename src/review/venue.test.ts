// Unit tests for the review's venue helpers (src/review/venue.ts; critical
// invariants 3, 4 and 5): every text checked before it leaves, sent only to
// the venue, through the one transformer; an edit to what the message
// shows already is no failure; a deletion tried twice, a message already
// gone counted as deleted, one that cannot be deleted edited instead; what
// still fails is logged by class, after a decision, and never thrown.
import { describe, expect, it } from 'vitest';
import { FAILURES, fakeBotApi } from '../../test/fakes/bot-api';
import { recordingLogger } from '../../test/fakes/logger';
import { IDS, testConfig } from '../../test/support/config';
import { AppError } from '../errors/app-error';
import { createBotApi } from '../telegram/api';
import { checkedText, deleteInVenue, deleteOrEdit, editAfterCommit, editMessage, sendToVenue } from './venue';

const setup = () => {
  const config = testConfig();
  const telegram = fakeBotApi();
  const log = recordingLogger();
  return { config, telegram, log, deps: { api: createBotApi(config, telegram.fetch), config, logger: log.logger } };
};

const KEYBOARD = { inline_keyboard: [[{ text: 'Approve', callback_data: 'rv:ap:abcdefghijklmnopqrst' }]] };

describe('checkedText', () => {
  it('takes a text whose links are code text, or on the lists, within 4096 characters', () => {
    const { config } = setup();
    const text = 'Link: <code>https://evil.test/x</code> and <a href="https://report.cybertip.org/">NCMEC</a>';
    expect(checkedText(config, text)).toBe(text);
  });

  it.each([
    ['a tappable link off the lists', 'see https://evil.test/ now'],
    ['a bare domain', 'see evil.test now'],
    ['an anchor to a host off the lists', '<a href="https://evil.test/">tap</a>'],
    ['a mention', 'ask @someone'],
    ['a text over 4096 characters', 'x'.repeat(4097)],
  ])('refuses %s', (_label, text) => {
    const { config } = setup();
    expect(() => checkedText(config, text)).toThrow(AppError);
  });
});

describe('sendToVenue', () => {
  it('sends to the venue only, with previews off and HTML, its buttons or a force reply, as a reply when asked', async () => {
    const { deps, telegram } = setup();
    await sendToVenue(deps, { text: 'a card', keyboard: KEYBOARD });
    await sendToVenue(deps, { text: 'a prompt' }, { forceReply: { force_reply: true }, replyTo: 1 });
    expect(telegram.callsOf('sendMessage').map((call) => call.payload)).toEqual([
      { chat_id: IDS.adminChat, text: 'a card', reply_markup: KEYBOARD, parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
      {
        chat_id: IDS.adminChat,
        text: 'a prompt',
        reply_markup: { force_reply: true },
        reply_parameters: { message_id: 1, allow_sending_without_reply: true },
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      },
    ]);
  });

  it('sends nothing for a text that may not be sent', async () => {
    const { deps, telegram } = setup();
    await expect(sendToVenue(deps, { text: 'go to https://evil.test/' })).rejects.toBeInstanceOf(AppError);
    expect(telegram.calls).toEqual([]);
  });
});

describe('editMessage and editAfterCommit', () => {
  it('edit a message, its buttons removed when the view has none, and take "not modified" as done', async () => {
    const { deps, telegram } = setup();
    telegram.seedMessage(IDS.adminChat, { message_id: 5, text: 'old', reply_markup: KEYBOARD });
    await editMessage(deps, 5, { text: 'new' });
    expect(telegram.messageIn(IDS.adminChat, 5)).toMatchObject({ text: 'new' });
    expect(telegram.messageIn(IDS.adminChat, 5)?.reply_markup).toBeUndefined();
    await expect(editMessage(deps, 5, { text: 'new' })).resolves.toBeUndefined();
    await editMessage(deps, 5, { text: 'with buttons', keyboard: KEYBOARD });
    expect(telegram.messageIn(IDS.adminChat, 5)?.reply_markup).toEqual(KEYBOARD);
  });

  it('throw any other failure before a decision, and log it by class after one', async () => {
    const { deps, telegram, log } = setup();
    telegram.seedMessage(IDS.adminChat, { message_id: 5, text: 'old' });
    telegram.fail({ method: 'editMessageText' }, FAILURES.serverError, 2);
    await expect(editMessage(deps, 5, { text: 'new' })).rejects.toThrow();
    expect(await editAfterCommit(deps, 5, { text: 'new' })).toBe(false);
    expect(log.records()).toEqual([{ level: 'error', event: 'review.message_not_edited', errorClass: 'GrammyError', telegramErrorCode: 502, apiMethod: 'editMessageText' }]);
  });

  it('leave a message already gone alone after a decision, unlogged', async () => {
    const { deps, log } = setup();
    expect(await editAfterCommit(deps, 99, { text: 'new' })).toBe(false);
    expect(log.lines).toEqual([]);
  });
});

describe('deleteInVenue and deleteOrEdit', () => {
  it('delete a message, a message already gone counting as deleted', async () => {
    const { deps, telegram } = setup();
    telegram.seedMessage(IDS.adminChat, { message_id: 5, text: 'a card' });
    expect(await deleteInVenue(deps, 5)).toBe(true);
    expect(await deleteInVenue(deps, 5)).toBe(true);
    expect(telegram.callsOf('deleteMessage').map((call) => call.chatId)).toEqual([IDS.adminChat, IDS.adminChat]);
  });

  it('try a deletion twice, then log it by class', async () => {
    const { deps, telegram, log } = setup();
    telegram.seedMessage(IDS.adminChat, { message_id: 5, text: 'a card' });
    telegram.fail({ method: 'deleteMessage' }, FAILURES.timeout, 1);
    expect(await deleteInVenue(deps, 5)).toBe(true);
    telegram.seedMessage(IDS.adminChat, { message_id: 6, text: 'a card' });
    telegram.fail({ method: 'deleteMessage' }, FAILURES.messageCantBeDeleted);
    expect(await deleteInVenue(deps, 6)).toBe(false);
    expect(log.records().map((record) => record.event)).toEqual(['review.message_not_deleted']);
  });

  it('edit a message that cannot be deleted to the fallback, without buttons', async () => {
    const { deps, telegram } = setup();
    telegram.seedMessage(IDS.adminChat, { message_id: 5, text: 'a card with https://x.com/someone', reply_markup: KEYBOARD });
    telegram.fail({ method: 'deleteMessage' }, FAILURES.messageCantBeDeleted);
    await deleteOrEdit(deps, 5, { text: 'Report rejected.' });
    expect(telegram.messageIn(IDS.adminChat, 5)).toMatchObject({ text: 'Report rejected.' });
    expect(telegram.messageIn(IDS.adminChat, 5)?.reply_markup).toBeUndefined();
  });
});

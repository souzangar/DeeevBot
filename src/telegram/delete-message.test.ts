// Unit tests for deleting what a user sends on receipt
// (src/telegram/delete-message.ts): deleted at once, or on the one retry; a
// message already gone counts as deleted, with no retry; two failures
// return false and log one line by class, never an id; the reply's note
// asking the sender to delete it themselves; an update with no message
// costs no call.
import { GrammyError, type Context } from 'grammy';
import { describe, expect, it } from 'vitest';
import { recordingLogger } from '../../test/fakes/logger';
import { IDS } from '../../test/support/variables';
import { t } from '../i18n/index';
import { deleteOwnMessage, deleteReceivedMessage, withDeleteNote } from './delete-message';

const failure = (code: number, description: string) =>
  new GrammyError(
    "Call to 'deleteMessage' failed!",
    { ok: false, error_code: code, description },
    'deleteMessage',
    { chat_id: IDS.reporter, message_id: 7 },
  );

/** A deleteMessage that answers with `outcomes` in turn, true once they run out. */
const scripted = (...outcomes: unknown[]) => {
  const calls: [number, number][] = [];
  return {
    calls,
    api: {
      deleteMessage: (chatId: number, messageId: number): Promise<true> => {
        calls.push([chatId, messageId]);
        const outcome = outcomes.shift();
        return outcome === undefined ? Promise.resolve(true) : Promise.reject(outcome instanceof Error ? outcome : new Error('failed'));
      },
    },
  };
};

describe('deleteReceivedMessage', () => {
  it('deletes the message once', async () => {
    const { api, calls } = scripted();
    const log = recordingLogger();
    expect(await deleteReceivedMessage(api, log.logger, IDS.reporter, 7)).toBe(true);
    expect(calls).toEqual([[IDS.reporter, 7]]);
    expect(log.lines).toEqual([]);
  });

  it('takes a message already gone as deleted, with no retry and no log', async () => {
    const { api, calls } = scripted(failure(400, 'Bad Request: message to delete not found'));
    const log = recordingLogger();
    expect(await deleteReceivedMessage(api, log.logger, IDS.reporter, 7)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(log.lines).toEqual([]);
  });

  it('retries once, and says deleted when the retry works', async () => {
    const { api, calls } = scripted(failure(502, 'Bad Gateway'));
    const log = recordingLogger();
    expect(await deleteReceivedMessage(api, log.logger, IDS.reporter, 7)).toBe(true);
    expect(calls).toHaveLength(2);
    expect(log.lines).toEqual([]);
  });

  it('gives up after the retry, logging the failure by class only', async () => {
    const { api, calls } = scripted(failure(400, "Bad Request: message can't be deleted"), failure(400, "Bad Request: message can't be deleted"));
    const log = recordingLogger();
    expect(await deleteReceivedMessage(api, log.logger, IDS.reporter, 7)).toBe(false);
    expect(calls).toHaveLength(2);
    expect(log.records()).toEqual([
      { level: 'error', event: 'intake.message_not_deleted', errorClass: 'GrammyError', telegramErrorCode: 400, apiMethod: 'deleteMessage' },
    ]);
    expect(log.text()).not.toContain(String(IDS.reporter));
  });
});

describe('deleteOwnMessage', () => {
  it("deletes the update's own message, and costs no call for an update without one", async () => {
    const { api, calls } = scripted();
    const log = recordingLogger();
    const withMessage = { message: { chat: { id: IDS.reporter }, message_id: 9 }, api } as unknown as Context;
    expect(await deleteOwnMessage(withMessage, log.logger)).toBe(true);
    expect(calls).toEqual([[IDS.reporter, 9]]);
    expect(await deleteOwnMessage({ message: undefined, api } as unknown as Context, log.logger)).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe('withDeleteNote', () => {
  it('adds the request to delete the message by hand, in the locale, only when the delete failed', () => {
    expect(withDeleteNote('en', 'text', true)).toBe('text');
    expect(withDeleteNote('en', 'text', false)).toBe(`text\n\n${t('en', 'intake.delete_yourself')}`);
    expect(withDeleteNote('fa', 'متن', false)).toBe(`متن\n\n${t('fa', 'intake.delete_yourself')}`);
  });
});

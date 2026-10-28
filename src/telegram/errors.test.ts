// Unit tests for the classification of Bot API failures
// (src/telegram/errors.ts): every class from a real GrammyError or
// HttpError, as grammY raises it from the fake Bot API's scripted answers.
import { GrammyError, HttpError } from 'grammy';
import { describe, expect, it } from 'vitest';
import { FAILURES, fakeBotApi, rateLimited, type FakeOutcome } from '../../test/fakes/bot-api';
import { AppError } from '../errors/app-error';
import { ErrorCode, type CatalogEntry } from '../errors/catalog';
import { createBotApi } from './api';
import { classifyTelegramError, MAX_RETRY_AFTER_SECONDS, telegramAppError } from './errors';

const USER = 424240031;

/** What grammY throws when the fake answers a sendMessage with `outcome`. */
const thrownFor = async (outcome: FakeOutcome): Promise<unknown> => {
  const telegram = fakeBotApi();
  telegram.fail({ method: 'sendMessage' }, outcome);
  return createBotApi({ botToken: 'unit-test-bot-token' }, telegram.fetch)
    .sendMessage(USER, 'x')
    .then(
      () => undefined,
      (error: unknown) => error,
    );
};

const grammyError = (error_code: number, description: string, retryAfter?: unknown): GrammyError =>
  new GrammyError(
    "Call to 'sendMessage' failed!",
    {
      ok: false,
      error_code,
      description,
      ...(retryAfter === undefined ? {} : { parameters: { retry_after: retryAfter as number } }),
    },
    'sendMessage',
    {},
  );

describe('classifyTelegramError', () => {
  it.each([
    ['403 bot was blocked by the user', FAILURES.botBlocked, 'TELEGRAM_BLOCKED', 'blocked'],
    ['403 user is deactivated', FAILURES.userDeactivated, 'TELEGRAM_CHAT_GONE', 'deactivated'],
    ['400 chat not found', FAILURES.chatNotFound, 'TELEGRAM_CHAT_GONE', 'chat_not_found'],
    ['400 private chat not found', FAILURES.privateChatNotFound, 'TELEGRAM_CHAT_GONE', 'chat_not_found'],
    ['400 message is not modified', FAILURES.messageNotModified, 'TELEGRAM_PERMANENT', 'message_not_modified'],
    ['400 message to edit not found', FAILURES.messageToEditNotFound, 'TELEGRAM_PERMANENT', 'message_not_found'],
    ['400 message to delete not found', FAILURES.messageToDeleteNotFound, 'TELEGRAM_PERMANENT', 'message_not_found'],
    ['400 message cannot be deleted', FAILURES.messageCantBeDeleted, 'TELEGRAM_PERMANENT', 'message_cannot_be_deleted'],
    ['400 user not found', FAILURES.userNotFound, 'TELEGRAM_PERMANENT', 'user_not_found'],
    ['403 cannot initiate a conversation', FAILURES.cantInitiateConversation, 'TELEGRAM_PERMANENT', 'permanent'],
    ['a 5xx', FAILURES.serverError, 'TELEGRAM_TRANSIENT', 'transient'],
    ['a timeout', FAILURES.timeout, 'TELEGRAM_TRANSIENT', 'transient'],
    ['a network failure', FAILURES.networkFailure, 'TELEGRAM_TRANSIENT', 'transient'],
  ])('classifies %s', async (_label, outcome, code, kind) => {
    const failure = classifyTelegramError(await thrownFor(outcome));
    expect(failure.code).toBe(code);
    expect(failure.kind).toBe(kind);
  });

  it('carries the status of an answered failure, and none for an HttpError', async () => {
    expect(classifyTelegramError(await thrownFor(FAILURES.botBlocked)).status).toBe(403);
    expect(classifyTelegramError(await thrownFor(FAILURES.serverError)).status).toBe(502);
    expect(classifyTelegramError(await thrownFor(FAILURES.timeout))).not.toHaveProperty('status');
  });

  it("classifies a 429 as rate limited, with Telegram's retry_after", async () => {
    expect(classifyTelegramError(await thrownFor(rateLimited(23)))).toEqual({
      code: 'TELEGRAM_RATE_LIMITED',
      kind: 'rate_limited',
      status: 429,
      retryAfterSeconds: 23,
    });
  });

  it('rounds a fractional retry_after up, bounds a huge one, and drops an unusable one', () => {
    expect(classifyTelegramError(grammyError(429, 'Too Many Requests', 1.2)).retryAfterSeconds).toBe(2);
    expect(classifyTelegramError(grammyError(429, 'Too Many Requests', 10 ** 9)).retryAfterSeconds).toBe(
      MAX_RETRY_AFTER_SECONDS,
    );
    for (const value of [undefined, 0, -5, Number.NaN, '30']) {
      expect(classifyTelegramError(grammyError(429, 'Too Many Requests', value))).not.toHaveProperty(
        'retryAfterSeconds',
      );
    }
  });

  it('reads the code first: a "chat not found" text under another code is not a gone chat', () => {
    expect(classifyTelegramError(grammyError(403, 'Forbidden: chat not found')).kind).toBe('permanent');
    expect(classifyTelegramError(grammyError(500, 'Internal Server Error: chat not found')).kind).toBe('transient');
  });

  it('matches descriptions case-insensitively', () => {
    expect(classifyTelegramError(grammyError(403, 'Forbidden: Bot was blocked by the user')).kind).toBe('blocked');
  });

  it('classifies every other 4xx as permanent', () => {
    for (const code of [400, 401, 403, 404, 409]) {
      expect(classifyTelegramError(grammyError(code, 'Something else')).code).toBe('TELEGRAM_PERMANENT');
    }
  });

  it('keeps the code of an AppError, and calls anything else unexpected', () => {
    expect(classifyTelegramError(new AppError('STORAGE_FAILURE', 'D1 run failed'))).toEqual({
      code: 'STORAGE_FAILURE',
      kind: 'not_telegram',
    });
    expect(classifyTelegramError(new TypeError('x'))).toEqual({ code: 'UNEXPECTED', kind: 'not_telegram' });
    expect(classifyTelegramError('a string')).toEqual({ code: 'UNEXPECTED', kind: 'not_telegram' });
  });

  it('classifies an HttpError however it was made', () => {
    expect(classifyTelegramError(new HttpError('x', new Error('y'))).code).toBe('TELEGRAM_TRANSIENT');
  });
});

describe('telegramAppError', () => {
  it('wraps a failure in an AppError of its class, naming the method only, the original as its cause', async () => {
    const original = await thrownFor(FAILURES.botBlocked);
    const error = telegramAppError(original, 'sendMessage');
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('TELEGRAM_BLOCKED');
    expect(error.message).toBe('sendMessage failed');
    expect(error.cause).toBe(original);
  });

  it('returns an AppError as it is', () => {
    const error = new AppError('STORAGE_FAILURE', 'D1 batch failed');
    expect(telegramAppError(error, 'sendMessage')).toBe(error);
  });

  it('marks a rate limit retryable; a timeout, a network failure or a 5xx ambiguous and never retryable', async () => {
    const limited = telegramAppError(await thrownFor(rateLimited(1)), 'sendMessage');
    expect(limited.retryable).toBe(true);
    expect((ErrorCode[limited.code] as CatalogEntry).ambiguous).not.toBe(true);
    for (const outcome of [FAILURES.timeout, FAILURES.networkFailure, FAILURES.serverError]) {
      const error = telegramAppError(await thrownFor(outcome), 'sendMessage');
      expect(error.code).toBe('TELEGRAM_TRANSIENT');
      expect(error.retryable).toBe(false);
      expect((ErrorCode[error.code] as CatalogEntry).ambiguous).toBe(true);
    }
    expect(telegramAppError(await thrownFor(FAILURES.botBlocked), 'sendMessage').retryable).toBe(false);
  });
});

// @critical-path
// The classification of Bot API failures, used by every send, edit, delete
// and lookup (doc/architecture/adr-0005-error-handling-convention.md;
// CLAUDE.md, "Error handling"): Telegram's answer decides the class, never a
// guess. The exact description texts are those of the Bot API server source
// (doc/reference/telegram-bot-api-notes.md); Telegram documents error_code
// as "subject to change", so the class rests on the code first and on the
// description only where the code is shared by several meanings.
//
// - 403 "bot was blocked by the user": TELEGRAM_BLOCKED.
// - 403 "user is deactivated", 400 "chat not found" or "private chat not
//   found": TELEGRAM_CHAT_GONE.
//   On a reply both are logged by class and ignored: there is no
//   subscriber to remove, and nothing is retried.
// - 429: TELEGRAM_RATE_LIMITED, with Telegram's `retry_after` when given.
// - a 5xx, a timeout or a network failure (grammY's HttpError):
//   TELEGRAM_TRANSIENT. AMBIGUOUS on a send: Telegram may have accepted
//   it, so the caller decides, and a post is never re-sent blindly.
// - any other 4xx: TELEGRAM_PERMANENT. Among them the edit and delete
//   answers a caller may treat as non-errors ("message is not modified",
//   "message to edit not found", "message to delete not found", "message
//   can't be deleted") and getChatMember's "user not found", each with its
//   own `kind`.
// - anything that is not a Bot API failure keeps its AppError code, or is
//   UNEXPECTED.
// Nothing here reads a payload, and the AppError made from a failure names
// the method only: the GrammyError, whose payload carries the outgoing text
// and the chat id, stays its `cause`, which the logger never reads.
import { GrammyError, HttpError } from 'grammy';
import { AppError, isAppError } from '../errors/app-error';
import type { ErrorCode } from '../errors/catalog';

export type TelegramFailureKind =
  | 'blocked'
  | 'deactivated'
  | 'chat_not_found'
  | 'rate_limited'
  | 'message_not_modified'
  | 'message_not_found'
  | 'message_cannot_be_deleted'
  | 'user_not_found'
  | 'transient'
  | 'permanent'
  | 'not_telegram';

export interface TelegramFailure {
  readonly code: ErrorCode;
  readonly kind: TelegramFailureKind;
  /** The Bot API's error_code, when Telegram answered. */
  readonly status?: number;
  /** A 429's `retry_after`: whole seconds, when Telegram gave a usable one. */
  readonly retryAfterSeconds?: number;
}

/** The longest `retry_after` taken as given; anything longer is passed as this bound. */
export const MAX_RETRY_AFTER_SECONDS = 86_400;

/** The descriptions that tell the 400s and 403s apart, as fragments of Telegram's lowercased text. */
const DESCRIPTIONS: readonly (readonly [number, string, TelegramFailureKind])[] = [
  [403, 'bot was blocked by the user', 'blocked'],
  [403, 'user is deactivated', 'deactivated'],
  [400, 'private chat not found', 'chat_not_found'],
  [400, 'chat not found', 'chat_not_found'],
  [400, 'message is not modified', 'message_not_modified'],
  [400, 'message to edit not found', 'message_not_found'],
  [400, 'message to delete not found', 'message_not_found'],
  [400, "message can't be deleted", 'message_cannot_be_deleted'],
  [400, 'user not found', 'user_not_found'],
  [400, 'member not found', 'user_not_found'],
  [400, 'participant_id_invalid', 'user_not_found'],
];

const CODE_FOR: Readonly<Record<TelegramFailureKind, ErrorCode>> = {
  blocked: 'TELEGRAM_BLOCKED',
  deactivated: 'TELEGRAM_CHAT_GONE',
  chat_not_found: 'TELEGRAM_CHAT_GONE',
  rate_limited: 'TELEGRAM_RATE_LIMITED',
  message_not_modified: 'TELEGRAM_PERMANENT',
  message_not_found: 'TELEGRAM_PERMANENT',
  message_cannot_be_deleted: 'TELEGRAM_PERMANENT',
  user_not_found: 'TELEGRAM_PERMANENT',
  transient: 'TELEGRAM_TRANSIENT',
  permanent: 'TELEGRAM_PERMANENT',
  not_telegram: 'UNEXPECTED',
};

const failure = (kind: TelegramFailureKind, status?: number, retryAfterSeconds?: number): TelegramFailure => ({
  code: CODE_FOR[kind],
  kind,
  ...(status === undefined ? {} : { status }),
  ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
});

/** A 429's retry_after as whole seconds from 1 to MAX_RETRY_AFTER_SECONDS, or undefined. */
const retryAfter = (error: GrammyError): number | undefined => {
  const value: unknown = error.parameters.retry_after;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(Math.ceil(value), MAX_RETRY_AFTER_SECONDS);
};

const classifyAnswer = (error: GrammyError): TelegramFailure => {
  const status = error.error_code;
  if (status === 429) return failure('rate_limited', status, retryAfter(error));
  if (status >= 500) return failure('transient', status);
  const description = typeof error.description === 'string' ? error.description.toLowerCase() : '';
  for (const [code, fragment, kind] of DESCRIPTIONS) {
    if (status === code && description.includes(fragment)) return failure(kind, status);
  }
  return failure('permanent', status);
};

/** The class of a failed Bot API call (see the header). Never throws. */
export function classifyTelegramError(error: unknown): TelegramFailure {
  if (error instanceof GrammyError) return classifyAnswer(error);
  if (error instanceof HttpError) return failure('transient');
  if (isAppError(error)) return { code: error.code, kind: 'not_telegram' };
  return failure('not_telegram');
}

/**
 * The AppError for a failed Bot API call: the classified code, a message
 * naming `method` only, the original error as its cause. An AppError is
 * returned as it is.
 */
export function telegramAppError(error: unknown, method: string): AppError {
  if (isAppError(error)) return error;
  return new AppError(classifyTelegramError(error).code, `${method} failed`, { cause: error });
}

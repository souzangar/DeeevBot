// The single registry of error codes
// (doc/architecture/adr-0005-error-handling-convention.md; CLAUDE.md, "Error
// handling"). Every AppError carries one of these codes, and its
// `retryable` flag and `userMessageKey` are read from the entry here, never
// chosen at the throw site: a throw site never invents a code, a new code is
// added here, and a code a user can see maps to a key present in both i18n
// catalogs.
//
// `ErrorCode` is both this object (the entries) and the type of a code (the
// union of its keys).
import type { MessageKey } from '../i18n/en';

/** What the catalog records for a code. */
export interface CatalogEntry {
  /** The code itself; always equal to the entry's key (checked when this file compiles). */
  readonly code: string;
  /**
   * Whether a later attempt may succeed. It schedules nothing by itself:
   * the caller reschedules or backs off (ADR 0004 rejects in-invocation
   * retry bursts).
   */
  readonly retryable: boolean;
  /**
   * The i18n key for whoever is told about the error. Absent for a code no
   * one is shown as a reply; a boundary that receives such a code replies
   * with the generic `error.unexpected`.
   */
  readonly userMessageKey?: MessageKey;
}

type Registry<T> = { readonly [Code in keyof T]: CatalogEntry & { readonly code: Code } };
/** Returns its argument; the constraint makes a code that differs from its key a build error. */
const registry = <const T extends Registry<T>>(entries: T): T => entries;

export const ErrorCode = registry({
  /** The deployment's variables failed validation (src/config/schema.ts); its text is an admin alert. */
  CONFIG_INVALID: {
    code: 'CONFIG_INVALID',
    retryable: false,
    userMessageKey: 'alert.config_invalid',
  },
  /** Telegram answered 429: persist progress and reschedule for now plus `retry_after`. */
  TELEGRAM_RATE_LIMITED: { code: 'TELEGRAM_RATE_LIMITED', retryable: true },
  /**
   * 403 "bot was blocked by the user": the unsubscribe class. Not an error
   * to retry or to report; the user is unsubscribed.
   */
  TELEGRAM_BLOCKED: { code: 'TELEGRAM_BLOCKED', retryable: false },
  /** 400 "chat not found" or "user is deactivated": the chat is gone; the user is unsubscribed. */
  TELEGRAM_CHAT_GONE: { code: 'TELEGRAM_CHAT_GONE', retryable: false },
  /** A 5xx answer or a network failure: retried with bounded backoff, then a failed delivery. */
  TELEGRAM_TRANSIENT: { code: 'TELEGRAM_TRANSIENT', retryable: true },
  /** Any other refusal by the Bot API: recorded, not retried. */
  TELEGRAM_PERMANENT: { code: 'TELEGRAM_PERMANENT', retryable: false },
  /** A storage operation failed (D1, or node:sqlite on the Node port). */
  STORAGE_FAILURE: { code: 'STORAGE_FAILURE', retryable: false },
  /** A Free-plan daily cap was hit: stop in a resumable state until the 00:00 UTC reset. */
  STORAGE_CAP_HIT: { code: 'STORAGE_CAP_HIT', retryable: false },
  /** The sender is not on the admin allowlist (critical invariant 2). */
  UNAUTHORIZED: { code: 'UNAUTHORIZED', retryable: false, userMessageKey: 'error.unauthorized' },
  /** The sender is not a member of the membership chat. */
  NOT_A_MEMBER: { code: 'NOT_A_MEMBER', retryable: false, userMessageKey: 'error.not_a_member' },
  /** An intake or command limit was reached. */
  RATE_LIMITED: { code: 'RATE_LIMITED', retryable: false, userMessageKey: 'error.rate_limited' },
  /** The user's input was refused. */
  INVALID_INPUT: { code: 'INVALID_INPUT', retryable: false, userMessageKey: 'error.invalid_input' },
  /** Anything unclassified: a bug or a failure no other code describes. */
  UNEXPECTED: { code: 'UNEXPECTED', retryable: false, userMessageKey: 'error.unexpected' },
});

export type ErrorCode = keyof typeof ErrorCode;

export const isErrorCode = (value: unknown): value is ErrorCode =>
  typeof value === 'string' && Object.hasOwn(ErrorCode, value);

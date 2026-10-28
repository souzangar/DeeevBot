// The one error shape (doc/architecture/adr-0005-error-handling-convention.md;
// CLAUDE.md, "Error handling"): every error leaves the system as an
// AppError, never as an ad-hoc string or a raw exception from a lower layer.
// Its code comes from src/errors/catalog.ts, which also decides `retryable`
// and `userMessageKey`. The message is internal: it never contains report
// data (a URL, a comment, an id, a Telegram payload), so a lower-layer error
// is attached as `cause` and never copied into the message.
import type { MessageKey } from '../i18n/en';
import { ErrorCode, type CatalogEntry } from './catalog';

export interface AppErrorOptions {
  /** The lower-layer error. The logger never reads it (src/privacy/logger.ts). */
  readonly cause?: unknown;
  /** For CONFIG_INVALID: the offending configuration variable names. Names only, never values. */
  readonly variables?: readonly string[];
}

export class AppError extends Error {
  override readonly name = 'AppError';
  readonly code: ErrorCode;
  /** From the catalog entry of `code`. */
  readonly retryable: boolean;
  /** From the catalog entry of `code`; undefined for a code no one is shown as a reply. */
  readonly userMessageKey: MessageKey | undefined;
  /** CONFIG_INVALID only: the offending variable names, sorted by the loader. Absent otherwise. */
  declare readonly variables?: readonly string[];

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    // No `cause` property at all unless one is given.
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    const entry: CatalogEntry = ErrorCode[code];
    this.code = code;
    this.retryable = entry.retryable;
    this.userMessageKey = entry.userMessageKey;
    if (options.variables !== undefined) this.variables = Object.freeze([...options.variables]);
  }
}

export const isAppError = (value: unknown): value is AppError => value instanceof AppError;

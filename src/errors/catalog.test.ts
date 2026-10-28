// Unit tests for the error catalog (doc/architecture/adr-0005-error-handling-convention.md):
// the single registry of codes, their retry classes and their i18n keys.
import { describe, expect, it } from 'vitest';
import { en } from '../i18n/en';
import { fa } from '../i18n/fa';
import { ErrorCode, isErrorCode, type CatalogEntry } from './catalog';

const ENTRIES: readonly CatalogEntry[] = Object.values(ErrorCode);

describe('ErrorCode, the catalog', () => {
  it('registers the codes the MVP plan names, and no others', () => {
    expect(Object.keys(ErrorCode).sort()).toEqual(
      [
        'CONFIG_INVALID',
        'TELEGRAM_RATE_LIMITED',
        'TELEGRAM_BLOCKED',
        'TELEGRAM_CHAT_GONE',
        'TELEGRAM_TRANSIENT',
        'TELEGRAM_PERMANENT',
        'STORAGE_FAILURE',
        'STORAGE_CAP_HIT',
        'UNAUTHORIZED',
        'NOT_A_MEMBER',
        'RATE_LIMITED',
        'INVALID_INPUT',
        'UNEXPECTED',
      ].sort(),
    );
  });

  it('records each code under its own name', () => {
    for (const [key, entry] of Object.entries(ErrorCode)) expect(entry.code).toBe(key);
  });

  it('marks only the rate-limited Telegram failure retryable', () => {
    const retryable = ENTRIES.filter((entry) => entry.retryable).map((entry) => entry.code);
    expect(retryable).toEqual(['TELEGRAM_RATE_LIMITED']);
  });

  it('marks only the transient Telegram failure ambiguous', () => {
    const ambiguous = ENTRIES.filter((entry) => entry.ambiguous === true).map((entry) => entry.code);
    expect(ambiguous).toEqual(['TELEGRAM_TRANSIENT']);
  });

  it('never marks an entry both retryable and ambiguous, so a timed-out send is never re-sent by a retry', () => {
    for (const entry of ENTRIES) expect(entry.retryable && entry.ambiguous === true, entry.code).toBe(false);
  });

  it('gives a message key to the codes someone is told about, and none to the internal classes', () => {
    const keys = Object.fromEntries(ENTRIES.map((entry) => [entry.code, entry.userMessageKey]));
    expect(keys).toEqual({
      CONFIG_INVALID: 'alert.config_invalid',
      TELEGRAM_RATE_LIMITED: undefined,
      TELEGRAM_BLOCKED: undefined,
      TELEGRAM_CHAT_GONE: undefined,
      TELEGRAM_TRANSIENT: undefined,
      TELEGRAM_PERMANENT: undefined,
      STORAGE_FAILURE: undefined,
      STORAGE_CAP_HIT: undefined,
      UNAUTHORIZED: 'error.unauthorized',
      NOT_A_MEMBER: 'error.not_a_member',
      RATE_LIMITED: 'error.rate_limited',
      INVALID_INPUT: 'error.invalid_input',
      UNEXPECTED: 'error.unexpected',
    });
  });

  it('maps every message key to a string in both catalogs', () => {
    for (const { userMessageKey } of ENTRIES) {
      if (userMessageKey === undefined) continue;
      expect(Object.hasOwn(en, userMessageKey)).toBe(true);
      expect(Object.hasOwn(fa, userMessageKey)).toBe(true);
    }
  });
});

describe('isErrorCode', () => {
  it('accepts every registered code', () => {
    for (const code of Object.keys(ErrorCode)) expect(isErrorCode(code)).toBe(true);
  });

  it.each([
    ['an unknown code', 'NO_SUCH_CODE'],
    ['a lowercase code', 'unexpected'],
    ['an inherited property name', 'toString'],
    ['a number', 429],
    ['undefined', undefined],
  ])('rejects %s', (_label, value) => {
    expect(isErrorCode(value)).toBe(false);
  });
});

// Unit tests for AppError, the one error shape
// (doc/architecture/adr-0005-error-handling-convention.md).
import { describe, expect, it } from 'vitest';
import { AppError, isAppError } from './app-error';
import { ErrorCode, type CatalogEntry } from './catalog';

describe('AppError', () => {
  it('is an Error named AppError, with its code and its internal message', () => {
    const error = new AppError('TELEGRAM_RATE_LIMITED', 'sendMessage answered 429');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AppError);
    expect(error.name).toBe('AppError');
    expect(error.code).toBe('TELEGRAM_RATE_LIMITED');
    expect(error.message).toBe('sendMessage answered 429');
    expect(String(error)).toBe('AppError: sendMessage answered 429');
  });

  it.each(Object.entries(ErrorCode))(
    'takes retryable and userMessageKey for %s from the catalog',
    (code, entry: CatalogEntry) => {
      const error = new AppError(code as ErrorCode, 'internal message');
      expect(error.retryable).toBe(entry.retryable);
      expect(error.userMessageKey).toBe(entry.userMessageKey);
    },
  );

  it('carries a lower-layer error as its cause, and has no cause property without one', () => {
    const lower = new TypeError('lower-layer detail');
    expect(new AppError('STORAGE_FAILURE', 'the batch failed', { cause: lower }).cause).toBe(lower);
    expect(Object.hasOwn(new AppError('STORAGE_FAILURE', 'the batch failed'), 'cause')).toBe(false);
  });

  it('carries configuration variable names only when given, as a frozen copy', () => {
    const names = ['ADMIN_IDS', 'BOT_ID'];
    const error = new AppError('CONFIG_INVALID', 'invalid configuration', { variables: names });
    names.push('LATE_ADDITION');
    expect(error.variables).toEqual(['ADMIN_IDS', 'BOT_ID']);
    expect(Object.isFrozen(error.variables)).toBe(true);
    expect(Object.hasOwn(new AppError('UNEXPECTED', 'a bug'), 'variables')).toBe(false);
  });

  it('serialises to its code and catalog fields, never its message or cause', () => {
    const error = new AppError('UNEXPECTED', 'internal detail', {
      cause: new Error('lower-layer detail'),
    });
    const serialised = JSON.stringify(error);
    expect(JSON.parse(serialised)).toEqual({
      name: 'AppError',
      code: 'UNEXPECTED',
      retryable: false,
      userMessageKey: 'error.unexpected',
    });
    expect(serialised).not.toContain('detail');
  });
});

describe('isAppError', () => {
  it('accepts an AppError', () => {
    expect(isAppError(new AppError('INVALID_INPUT', 'refused'))).toBe(true);
  });

  it.each([
    ['a plain Error', new Error('x')],
    ['an Error named AppError', Object.assign(new Error('x'), { name: 'AppError', code: 'UNEXPECTED' })],
    ['an object shaped like one', { name: 'AppError', code: 'UNEXPECTED', retryable: false }],
    ['a string', 'AppError'],
    ['undefined', undefined],
  ])('rejects %s', (_label, value) => {
    expect(isAppError(value)).toBe(false);
  });
});

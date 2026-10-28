// Unit tests for the i18n mechanism: locale resolution and t().
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors/app-error';
import { en } from './en';
import { fa } from './fa';
import { telegramHtmlProblems } from './html';
import { isLocale, LOCALES, resolveLocale, t, type Locale } from './index';

describe('resolveLocale', () => {
  it.each([
    ['fa', 'fa'],
    ['fa-IR', 'fa'],
    ['fa-AF', 'fa'],
    ['FA', 'fa'],
    ['Fa-Ir', 'fa'],
    ['en', 'en'],
    ['en-US', 'en'],
    ['de', 'en'],
    ['far', 'en'],
    ['fa_IR', 'en'],
    ['', 'en'],
  ])('maps %j to %s', (code, locale) => {
    expect(resolveLocale(code)).toBe(locale);
  });

  it('defaults to en without a language code', () => {
    expect(resolveLocale()).toBe('en');
    expect(resolveLocale(undefined)).toBe('en');
  });
});

describe('isLocale', () => {
  it('accepts the two locales and nothing else', () => {
    for (const locale of LOCALES) expect(isLocale(locale)).toBe(true);
    for (const value of ['de', 'FA', 'fa-IR', '', undefined, 0]) expect(isLocale(value)).toBe(false);
  });
});

describe('t', () => {
  it("returns the locale's catalog string", () => {
    expect(t('en', 'error.unexpected')).toBe(en['error.unexpected']);
    expect(t('fa', 'error.unexpected')).toBe(fa['error.unexpected']);
  });

  it('substitutes each placeholder with its parameter', () => {
    expect(t('en', 'alert.config_invalid', { variables: 'ADMIN_IDS, BOT_ID' })).toBe(
      '<b>Configuration error.</b> The bot could not load its configuration. Check these variables: <code>ADMIN_IDS, BOT_ID</code>',
    );
    expect(t('fa', 'alert.config_invalid', { variables: 'BOT_ID' })).toContain('<code>BOT_ID</code>');
  });

  it('renders a number parameter', () => {
    expect(t('en', 'alert.config_invalid', { variables: 3 })).toContain('<code>3</code>');
  });

  it('HTML-escapes every parameter, so the result is still valid Telegram HTML', () => {
    const text = t('en', 'alert.config_invalid', { variables: '</code><b>A & "B" > C' });
    expect(text).toContain('<code>&lt;/code&gt;&lt;b&gt;A &amp; &quot;B&quot; &gt; C</code>');
    expect(telegramHtmlProblems(text)).toEqual([]);
  });

  it('substitutes a placeholder-looking parameter as text, once', () => {
    expect(t('en', 'alert.config_invalid', { variables: '{variables}' })).toContain(
      '<code>{variables}</code>',
    );
  });

  it('reads the English catalog for a locale outside LOCALES (past the types)', () => {
    expect(t('de' as Locale, 'error.unexpected')).toBe(en['error.unexpected']);
  });

  it('rejects a wrong key or wrong parameters at compile time, and throws past the types', () => {
    // @ts-expect-error: not a message key
    expect(() => t('en', 'no.such.key')).toThrow(AppError);
    // @ts-expect-error: the key takes {variables}
    expect(() => t('en', 'alert.config_invalid')).toThrow(AppError);
    // @ts-expect-error: a misspelled parameter
    expect(() => t('en', 'alert.config_invalid', { variable: 'X' })).toThrow(AppError);
    // @ts-expect-error: the key takes no parameter (an extra one is ignored at run time)
    expect(t('en', 'error.unexpected', { variables: 'X' })).toBe(en['error.unexpected']);
  });

  it('throws an AppError UNEXPECTED whose message names the key and the placeholder only', () => {
    let caught: unknown;
    try {
      // @ts-expect-error: the key takes {variables}
      t('en', 'alert.config_invalid', {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('UNEXPECTED');
    expect((caught as AppError).message).toBe(
      'alert.config_invalid was rendered without its {variables} parameter',
    );
  });
});

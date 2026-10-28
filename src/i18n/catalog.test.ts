// The catalog test (doc/architecture/adr-0005-error-handling-convention.md:
// "a new code needs a key in both fa and en"): the Persian catalog carries
// exactly the English keys with the same placeholders, and every string of
// both parses as Telegram HTML under the rules in src/i18n/en.ts. Each later
// unit's keys fall under it as soon as they are added.
import { describe, expect, it } from 'vitest';
import { en } from './en';
import { fa } from './fa';
import { telegramHtmlProblems } from './html';
import { LOCALES } from './index';

const CATALOGS: Readonly<Record<(typeof LOCALES)[number], Readonly<Record<string, string>>>> = {
  en,
  fa,
};
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const placeholders = (text: string): string[] =>
  [...text.matchAll(PLACEHOLDER)].map((match) => match[1] ?? '').sort();

describe('the message catalogs', () => {
  it('fa has exactly the keys of en: none missing, none extra', () => {
    expect(Object.keys(fa).sort()).toEqual(Object.keys(en).sort());
  });

  it.each(LOCALES)('every %s string is non-blank Telegram HTML', (locale) => {
    for (const [key, text] of Object.entries(CATALOGS[locale])) {
      expect(text.trim(), key).not.toBe('');
      expect(telegramHtmlProblems(text), `${locale} ${key}`).toEqual([]);
    }
  });

  it.each(LOCALES)('every %s string uses braces only for placeholders', (locale) => {
    for (const [key, text] of Object.entries(CATALOGS[locale])) {
      expect(text.replace(PLACEHOLDER, ''), `${locale} ${key}`).not.toMatch(/[{}]/);
    }
  });

  it('every key has the same placeholders in both locales', () => {
    for (const [key, text] of Object.entries(en)) {
      expect(placeholders(fa[key as keyof typeof en]), key).toEqual(placeholders(text));
    }
  });

  it('every Persian string is written in Persian, not copied from English', () => {
    for (const [key, text] of Object.entries(fa)) {
      expect(text, key).not.toBe(en[key as keyof typeof en]);
      expect(text, key).toMatch(/[؀-ۿ]/);
    }
  });
});

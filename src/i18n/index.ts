// The i18n mechanism (doc/architecture/adr-0002-language-and-framework.md,
// doc/architecture/adr-0005-error-handling-convention.md): the two locales,
// locale resolution from Telegram's language_code, and t(), the only way
// user-facing text is produced. The catalogs are src/i18n/en.ts (the source
// of the keys) and src/i18n/fa.ts.
//
// t() is typed by the English string: a key with placeholders takes exactly
// those names as parameters, and a key without any takes none, so a missing,
// misspelled or extra parameter fails the build. Every substituted value is
// HTML-escaped, because every catalog string is Telegram HTML and a value
// (a variable name today, later report data) is text, never markup.
import { AppError } from '../errors/app-error';
import { en, type MessageKey } from './en';
import { fa } from './fa';
import { escapeHtml } from './html';

export type { MessageKey } from './en';

/** The bot's locales. */
export const LOCALES = ['fa', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

const CATALOGS: Readonly<Record<Locale, Readonly<Record<MessageKey, string>>>> = { en, fa };

export const isLocale = (value: unknown): value is Locale => value === 'fa' || value === 'en';

/**
 * The locale for a Telegram `language_code` (an IETF tag such as `fa` or
 * `en-US`): `fa` for `fa` and any `fa-*` tag, compared case-insensitively;
 * `en` for anything else, a missing code included.
 */
export function resolveLocale(languageCode?: string): Locale {
  if (languageCode === undefined) return 'en';
  const tag = languageCode.toLowerCase();
  return tag === 'fa' || tag.startsWith('fa-') ? 'fa' : 'en';
}

/** The `{name}` placeholders of a catalog string, as a union of names. */
type PlaceholderNames<S extends string> = S extends `${string}{${infer Name}}${infer Rest}`
  ? Name | PlaceholderNames<Rest>
  : never;

/** The parameters a key takes: one value per placeholder of its English string. */
export type MessageParams<K extends MessageKey> = {
  readonly [Name in PlaceholderNames<(typeof en)[K]>]: string | number;
};

type ParamsArgs<K extends MessageKey> = [PlaceholderNames<(typeof en)[K]>] extends [never]
  ? []
  : [params: MessageParams<K>];

/** The keys whose English string has no placeholder: t() takes them without parameters. */
export type PlainMessageKey = {
  [K in MessageKey]: [PlaceholderNames<(typeof en)[K]>] extends [never] ? K : never;
}[MessageKey];

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const HAS_PLACEHOLDER = /\{[A-Za-z_][A-Za-z0-9_]*\}/;

/**
 * Whether `key` takes no parameters, read from its English string (the
 * catalog test keeps the Persian placeholders equal): a key known only at
 * run time, such as an AppError's userMessageKey, is rendered without
 * parameters only when this holds.
 */
export const isPlainKey = (key: MessageKey): key is PlainMessageKey =>
  Object.hasOwn(en, key) && !HAS_PLACEHOLDER.test(en[key]);

/**
 * The text for `key` in `locale`, with each `{name}` replaced by its
 * HTML-escaped parameter. A locale outside LOCALES (only reachable past the
 * types, say from a stored row) reads the English catalog, as
 * resolveLocale() would; an unknown key or a missing parameter throws an
 * AppError UNEXPECTED, which the types make unreachable.
 */
export function t<K extends MessageKey>(locale: Locale, key: K, ...args: ParamsArgs<K>): string;
export function t(
  locale: Locale,
  key: MessageKey,
  params: Readonly<Record<string, string | number>> = {},
): string {
  const catalog = isLocale(locale) ? CATALOGS[locale] : CATALOGS.en;
  const template = Object.hasOwn(catalog, key) ? catalog[key] : undefined;
  if (template === undefined) throw new AppError('UNEXPECTED', `no catalog string for ${key}`);
  return template.replace(PLACEHOLDER, (_placeholder, name: string) => {
    const value = Object.hasOwn(params, name) ? params[name] : undefined;
    if (value === undefined) {
      throw new AppError('UNEXPECTED', `${key} was rendered without its {${name}} parameter`);
    }
    return escapeHtml(String(value));
  });
}

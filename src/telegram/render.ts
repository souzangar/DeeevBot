// @critical-path
// Rendering helpers for the bot's Telegram-HTML messages (critical
// invariants 3 and 4; the MVP plan, section 4, "Rendering"). Every message
// the bot sends is HTML (the one transformer in src/telegram/api.ts sets
// parse_mode HTML and turns previews off on every sendMessage and
// editMessageText), so report data enters a message only through these
// helpers or through t()'s escaped parameters:
// - escape(): text as text, never markup;
// - codeUrl(): a URL as a <code> entity, copyable and never tappable, so
//   no reported URL becomes a link; control and format characters in it
//   (a right-to-left override, a zero-width joiner) are shown as U+FFFD
//   instead of reordering or hiding what the reader sees;
// - bidiIsolate(): a left-to-right run inside Persian text, between U+2068
//   FIRST STRONG ISOLATE and U+2069 POP DIRECTIONAL ISOLATE, placed around
//   the <code> entity, never inside it, so a copied URL stays clean;
// - withLinks(): a text followed by its URLs, one per line, as code.
// These helpers only format. Which links a message may carry at all is the
// link policy's decision (src/platforms/, from the intake unit on), made
// before a URL reaches them; the review card shows any URL, as code.
import { escapeHtml } from '../i18n/html';
import type { Locale } from '../i18n/index';

/** Escapes text for Telegram HTML (src/i18n/html.ts). */
export const escape = escapeHtml;

/** FIRST STRONG ISOLATE and POP DIRECTIONAL ISOLATE. */
export const FSI = '\u2068';
export const PDI = '\u2069';

/** Control (Cc) and format (Cf) characters: invisible, or able to reorder the line. */
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;

/** `text` isolated as a left-to-right run inside right-to-left text. */
export const bidiIsolate = (text: string): string => `${FSI}${text}${PDI}`;

/** `url` as a <code> entity: escaped, its control and format characters shown as U+FFFD. */
export const codeUrl = (url: string): string => `<code>${escape(url.replace(INVISIBLE, '\uFFFD'))}</code>`;

/**
 * `text` (already Telegram HTML) followed by each URL on its own line as
 * code; in Persian each URL line is bidi-isolated. With no URLs, `text`.
 */
export function withLinks(locale: Locale, text: string, urls: readonly string[]): string {
  if (urls.length === 0) return text;
  const lines = urls.map((url) => (locale === 'fa' ? bidiIsolate(codeUrl(url)) : codeUrl(url)));
  return [text, ...lines].join('\n');
}

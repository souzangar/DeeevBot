// @critical-path
// The admin free-text validator (critical invariant 4; the MVP plan,
// section 4, "Admin free text"; doc/product/review-and-abuse-controls.md):
// the text an admin writes into a post, the recommended comment and a
// retraction's correction, may carry no link of any kind, because Telegram
// linkifies what looks like one and a seized admin account must not be able
// to send the members anywhere. It is refused when it holds:
// - a URL: a scheme with "//" (https://, tg://), a scheme Telegram opens
//   without them (tg:, tel:, sms:, mailto:, callto:, intent:), or a
//   dotted-quad address;
// - a bare domain: dot-separated labels ending in a top-level label of two
//   or more letters (example.com, t.me/..., www.x.com), in any script, a
//   label with an underscore included (my_site.com), which a browser
//   opens;
// - an @mention: an @ followed by a letter, a digit or an underscore;
// - a phone number: seven or more digits, of any script (Persian and
//   Arabic-Indic digits included), in groups joined by runs of
//   separators (whitespace, dashes, dots, parentheses, slashes:
//   "0912 - 345 - 6789", "0912/345/6789"), each run counting as one;
// and the recommended comment is at most RECOMMENDED_COMMENT_MAX_LENGTH
// characters. There is no custom-instructions field: "other" uses the
// catalog's fixed generic block (the MVP plan, section 3).
//
// The checks run on a copy normalised against the usual evasions: NFKC
// (fullwidth letters and dots fold to ASCII), every format character
// removed (zero-width spaces and joiners, bidi controls, the soft hyphen),
// and the ideographic and other full stops read as dots. The text itself is
// never changed. The rule is strict on purpose: ordinary prose passes, the
// fixed warning line of every post passes in both locales (tested), and an
// admin whose text is refused rewrites it; a sentence whose next word
// follows its full stop without a space ("end.Next"), a range of years
// written with a dash ("2024-2025") and a date written with slashes
// ("1403/08/07") are refused too. Social engineering
// through free text is bounded by this rule, the length limit, the fixed
// warning line and the keyholder's Cancel; it is not eliminated
// (doc/product/threat-model-seizure.md).

/** The admin-written fields this policy covers. */
export const ADMIN_TEXT_FIELDS = ['recommended_comment', 'correction_text'] as const;
export type AdminTextField = (typeof ADMIN_TEXT_FIELDS)[number];

/** Why a text is refused. */
export type AdminTextProblem = 'url' | 'domain' | 'mention' | 'phone' | 'too_long';

/** The recommended comment's bound, in characters (code points). */
export const RECOMMENDED_COMMENT_MAX_LENGTH = 300;

/** The fewest digits that make a phone number. */
export const PHONE_MIN_DIGITS = 7;

/** Format characters: zero-width spaces and joiners, bidi controls, the soft hyphen, the BOM. */
const FORMAT = /\p{Cf}/gu;
/** Full stops that IDNA reads as label separators, or that NFKC leaves as they are. */
const FULL_STOPS = /[\u3002\uFF0E\uFF61\u2024\uFE52]/gu;

const URL_WITH_SLASHES = /\p{L}[\p{L}\p{N}+.-]*:\/\//u;
const URL_WITHOUT_SLASHES = /(?<![\p{L}\p{N}])(?:tg|tel|sms|mailto|callto|intent):/iu;
const DOTTED_QUAD = /(?<![\p{N}.])\p{N}{1,3}(?:\.\p{N}{1,3}){3}(?!\p{N})/u;
/** Dot-separated labels (letters, digits, underscores; hyphens inside) and a top-level label of letters. */
const DOMAIN =
  /(?<![\p{L}\p{N}_-])(?:[\p{L}\p{N}_](?:[\p{L}\p{N}_-]{0,61}[\p{L}\p{N}_])?\.)+\p{L}{2,}(?![\p{L}\p{N}_-])/u;
const MENTION = /@[\p{L}\p{N}_]/u;
/** Digit groups joined by runs of separators: whitespace, dashes, dots, parentheses, slashes. */
const DIGIT_GROUPS = /\p{Nd}+(?:[\s\-\u2010-\u2015\u2212.()/]+\p{Nd}+)*/gu;
const DIGIT = /\p{Nd}/gu;

/** The copy the checks run on (see the header). */
export const normaliseForChecks = (text: string): string =>
  text.normalize('NFKC').replace(FORMAT, '').replace(FULL_STOPS, '.');

const hasPhoneNumber = (text: string): boolean =>
  [...text.matchAll(DIGIT_GROUPS)].some((match) => (match[0].match(DIGIT)?.length ?? 0) >= PHONE_MIN_DIGITS);

/** The link-like classes `text` holds, each at most once, in a fixed order. */
export function adminTextProblems(text: string): AdminTextProblem[] {
  const subject = normaliseForChecks(text);
  const problems: AdminTextProblem[] = [];
  if (URL_WITH_SLASHES.test(subject) || URL_WITHOUT_SLASHES.test(subject) || DOTTED_QUAD.test(subject)) {
    problems.push('url');
  }
  if (DOMAIN.test(subject)) problems.push('domain');
  if (MENTION.test(subject)) problems.push('mention');
  if (hasPhoneNumber(subject)) problems.push('phone');
  return problems;
}

/** What keeps `text` from being accepted as `field`; an empty list accepts it. */
export function checkAdminText(field: AdminTextField, text: string): AdminTextProblem[] {
  const problems = adminTextProblems(text);
  if (field === 'recommended_comment' && [...text].length > RECOMMENDED_COMMENT_MAX_LENGTH) {
    problems.push('too_long');
  }
  return problems;
}

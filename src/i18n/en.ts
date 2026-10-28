// The English catalog, the source of the message keys
// (doc/architecture/adr-0002-language-and-framework.md,
// doc/architecture/adr-0005-error-handling-convention.md). User-facing text
// is only ever looked up by key: `MessageKey` is derived from this object, so
// a key missing here fails the build wherever it is used, and src/i18n/fa.ts
// carries exactly the same keys (typed, and checked by
// src/i18n/catalog.test.ts). Each later unit adds its own keys, in both
// catalogs.
//
// Every string is Telegram HTML (the bot sends with parse_mode HTML): only
// <b>, <i>, <code> and <a href="..."> tags, and &, < and > outside a tag
// written as &amp;, &lt; and &gt;. A placeholder is {name}, and braces are
// reserved for placeholders; t() HTML-escapes every value it substitutes.
export const en = {
  'error.unexpected': 'Something went wrong. Please try again later.',
  'error.invalid_input': 'That input is not valid. Please check it and try again.',
  'error.rate_limited': 'You have reached the limit for now. Please try again later.',
  'error.not_a_member': 'This is only available to members of the organisation.',
  'error.unauthorized': 'You are not allowed to do that.',
  'alert.config_invalid':
    '<b>Configuration error.</b> The bot could not load its configuration. Check these variables: <code>{variables}</code>',
} as const;

/** A key of the message catalogs. */
export type MessageKey = keyof typeof en;

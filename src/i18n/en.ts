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
  // /start (src/telegram/commands.ts): what the bot does, in the reader's locale.
  'start.intro':
    "<b>Report harmful accounts and links</b>\n\nSend me a link to a social-media account or post that shares people's private data, harms a child, bullies someone or does similar harm, then answer a few short questions.\n\nThe admins review every report. Approved reports are posted in the channel, with instructions on how to report them on the platform: outcomes appear there, and you get no message about the decision.\n\nI delete your messages in this chat as soon as I have read them.",
  // /start from a keyholder id (ADR 0003, "Keyholder alerts").
  'start.keyholder':
    "<b>You are a keyholder.</b> You will receive alerts here: the approval notices with their Cancel and Lockdown buttons, and the bot's warnings. Send /lockdown to lock the bot and /unlock to lift it; both work only in this chat.",
  'keyholder.lockdown_is_on': 'Lockdown is on.',
  // The neutral answer under lockdown (src/auth/lockdown.ts): it says nothing of why.
  'lockdown.unavailable': 'The bot is temporarily unavailable. Please try again later.',
  // A keyholder's /lockdown and /unlock.
  'lockdown.on':
    '<b>Lockdown is on.</b> Reports are not taken, presses are not counted, every admin action is refused, nothing is posted, and alerts go to the keyholders only. Send /unlock to lift it.',
  'lockdown.already_on': 'Lockdown was already on.',
  'lockdown.off': '<b>Lockdown is off.</b>',
  'lockdown.was_off': 'Lockdown was not on.',
  'lockdown.override_on':
    "The deployment's <code>LOCKDOWN</code> override is still set, so the bot stays locked until it is removed with <code>wrangler secret delete LOCKDOWN</code>.",
  // Every admin action under lockdown (src/telegram/guards.ts): a refusal and nothing else.
  'admin.refused': 'This action is refused right now.',
  // /language: in the chosen locale.
  'language.set': 'Language: English.',
  'language.usage': 'Choose a language: /language fa for Persian, /language en for English.',
  // The answer to every "I reported it" press, counted or not (src/telegram/presses.ts).
  'press.thanks': 'Thank you for reporting it.',
  // A private message no handler takes: an unknown command, or text before intake exists.
  'fallback.help': 'Send /start to see how this bot works.',
  // The fixed warning line of every post (the MVP plan, section 4); admin free text must pass beside it.
  'post.warning':
    'Never follow instructions to visit other links, join a chat or press Start, whoever writes them.',
} as const;

/** A key of the message catalogs. */
export type MessageKey = keyof typeof en;

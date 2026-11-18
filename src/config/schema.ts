// @critical-path
// The configuration schema (doc/architecture/adr-0002-language-and-framework.md,
// doc/architecture/adr-0003-update-transport-and-admin-authority.md;
// critical invariants 2, 3, 5, 6, 7 and 8).
//
// Every value comes from the deployment's secret store or environment
// (Workers secrets in production, .dev.vars locally, the environment on the
// Node port), never from VCS. Two rules are pinned here:
// - rule 2: ADMIN_IDS and KEYHOLDER_IDS hold numeric Telegram user ids only.
//   A username, an @handle or an empty entry fails the load: usernames are
//   reassignable and never grant authority. The two lists share no id: a
//   keyholder is never an admin, so a seized admin account can never lift
//   a lockdown.
// - rule 6: the loaded object is not printable (JSON.stringify and
//   util.inspect both render it as CONFIG_REDACTED), and a failed load throws
//   an AppError CONFIG_INVALID that names the offending variables without
//   echoing any value. An environment that defines DEBUG, NODE_DEBUG or
//   NODE_DEBUG_NATIVE, with any value, the empty one included, is refused:
//   grammY bundles the `debug` package, which reads process.env.DEBUG, and
//   Node reads NODE_DEBUG and NODE_DEBUG_NATIVE for its own debug lines,
//   NODE_DEBUG=fetch or undici printing every Bot API request line, the
//   token in its path; under nodejs_compat the runtime copies every variable
//   and secret into process.env, and the Node port hands process.env to this
//   loader whole, so each of them would write to the console past the
//   redacting logger. The port refuses before any request is made.
// The two keys have a floor, and neither may equal a value disclosed more
// widely than itself: WEBHOOK_SECRET, the proof that an update came from
// Telegram (rule 2, src/telegram/webhook.ts), which Telegram holds too, has
// 32 to 256 characters of Telegram's alphabet and is never
// WEBHOOK_PATH_SEGMENT's value, which is in the webhook's URL;
// REPORTER_REF_KEY, the key of every reporter reference and link hash
// (rule 8, src/privacy/), has at least 32 characters (UTF-16 units, so at
// least 32 bytes of key) and is never the value of WEBHOOK_SECRET or
// BOT_TOKEN, which Telegram holds, or of WEBHOOK_PATH_SEGMENT. Equality is
// all these checks see: they catch a value pasted twice, never a weak or a
// related one, and no length proves that a value is random.
// The posts go to one channel, BROADCAST_CHAT_ID, and only to links on the
// exact hosts of ALLOWED_LINK_HOSTS. ADMIN_CHAT_ID, the admin review venue,
// is a group's or a channel's chat id (negative), and never the value of
// BROADCAST_CHAT_ID or MEMBERSHIP_CHAT_ID: the venue's cards show the
// reported links, the reporter's comment and reference and the routing card
// of suspected CSAM, which no member of the channel or of the membership
// chat may see (rules 3, 5 and 7). MEMBERSHIP_CHAT_ID may be the channel
// itself. VENUE_LOCALE is the one language of every message the bot writes
// in the admin review venue, whoever acts, so the venue's text reveals no
// admin's client language. LOCKDOWN is the keyholder's override
// (`wrangler secret put LOCKDOWN` with the value 1), which no Telegram
// command can clear.
// SQLITE_PATH is the Node port's alone (src/node.ts): the SQLite file it
// keeps its database in; the Worker never reads it and never needs it.
// The rules between variables (CROSS_FIELD_RULES: the admins and the
// keyholders, the keys apart from one another, the venue apart from the
// channel and the membership chat) are checked once every variable holds
// on its own; every one that fails goes into the one CONFIG_INVALID,
// naming the variables it binds and never a value.
// The Worker and the Node port read their configuration through
// configFor(env) in src/config/memo.ts, which parses once per env object.
import { z } from 'zod';
import { AppError } from '../errors/app-error';

/** What a loaded configuration prints as, whatever it holds. */
export const CONFIG_REDACTED = '[config redacted]';

/** Node's util.inspect hook: a registered symbol, inert on Workers. */
const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');

/** A decimal integer in canonical form: only '-' as a sign, no leading zero, no space, no exponent. */
const INTEGER = /^-?(?:0|[1-9][0-9]*)$/;
/** One entry of a user-id list: a positive decimal integer in canonical form. */
const USER_ID = /^[1-9][0-9]*$/;
/** Telegram's setWebhook secret_token alphabet and maximum (doc/guides/operations-and-security.md, 2.1), at least 32 characters. */
const WEBHOOK_SECRET = /^[A-Za-z0-9_-]{32,256}$/;
/** The fewest UTF-16 units REPORTER_REF_KEY holds: each encodes to a byte of key or more, so 32 bytes at least, RFC 2104's floor for HMAC-SHA-256. */
const REFERENCE_KEY_MIN_LENGTH = 32;
/** A URL path segment that needs no escaping. */
const PATH_SEGMENT = /^[A-Za-z0-9_-]+$/;
/** A Telegram bot username, without the @. */
const BOT_USERNAME = /^[A-Za-z0-9_]{5,32}$/;
/** At least one character that is not whitespace. */
const NOT_BLANK = /\S/;
/** Where the Node port keeps its SQLite file unless SQLITE_PATH says otherwise: relative to its working directory. */
export const DEFAULT_SQLITE_PATH = './data/div-report.sqlite';
/** One ALLOWED_LINK_HOSTS entry's alphabet: lowercase letters, digits, dots and hyphens; no scheme, path or port. */
const HOST_ALPHABET = /^[a-z0-9.-]+$/;
/** One label of a hostname: 1 to 63 characters, no hyphen at either end. */
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** A top-level label made of digits only, which makes a dotted-quad address of the whole. */
const DIGITS_ONLY = /^[0-9]+$/;

/** The hosts a post may link to by default: the platforms' own, exactly. */
export const DEFAULT_LINK_HOSTS = Object.freeze([
  'instagram.com',
  'www.instagram.com',
  'x.com',
  'twitter.com',
  'www.facebook.com',
  'facebook.com',
  'www.tiktok.com',
  'tiktok.com',
  't.me',
] as const);

const secret = z.string().regex(NOT_BLANK);

/**
 * REPORTER_REF_KEY: a non-blank secret of any alphabet, at least
 * REFERENCE_KEY_MIN_LENGTH UTF-16 units long. `.length` on purpose: zod's
 * own min() counts code points.
 */
const referenceKey = secret.refine((value) => value.length >= REFERENCE_KEY_MIN_LENGTH);

/** A decimal integer in [min, max]; zod's int() also bounds it to the safe-integer range. */
const integer = (min: number, max: number) =>
  z
    .string()
    .regex(INTEGER)
    .transform((value) => Number(value))
    .pipe(z.int().min(min).max(max));

/** A Telegram chat id: a non-zero safe integer, negative for groups and channels. */
const chatId = z
  .string()
  .regex(INTEGER)
  .transform((value) => Number(value))
  .pipe(z.int().refine((id) => id !== 0));

/** A group's or a channel's chat id: a negative safe integer. */
const negativeChatId = z
  .string()
  .regex(INTEGER)
  .transform((value) => Number(value))
  .pipe(z.int().max(-1));

/** Comma-separated numeric Telegram user ids, at least one; spaces around an entry are ignored. */
const userIds = z
  .string()
  .transform((list) => list.split(',').map((entry) => entry.trim()))
  .pipe(
    z
      .array(
        z
          .string()
          .regex(USER_ID)
          .transform((id) => Number(id))
          .pipe(z.int().positive()),
      )
      .min(1),
  );

/**
 * Whether `value` is an exact hostname: the allowed alphabet, at most 253
 * characters, at least two labels, each well formed, and not a dotted-quad
 * address (a top-level label of digits only).
 */
const isHostname = (value: string): boolean => {
  if (!HOST_ALPHABET.test(value) || value.length > 253) return false;
  const labels = value.split('.');
  const last = labels[labels.length - 1] ?? '';
  return labels.length >= 2 && labels.every((label) => HOST_LABEL.test(label)) && !DIGITS_ONLY.test(last);
};

/** Comma-separated exact hostnames, at least one; spaces around an entry are ignored. */
const hostList = z
  .string()
  .transform((list) => list.split(',').map((entry) => entry.trim()))
  .pipe(z.array(z.string().refine(isHostname)).min(1));

const envSchema = z.object({
  BOT_TOKEN: secret,
  BOT_ID: integer(1, Number.MAX_SAFE_INTEGER),
  BOT_USERNAME: z.string().regex(BOT_USERNAME),
  WEBHOOK_SECRET: z.string().regex(WEBHOOK_SECRET),
  WEBHOOK_PATH_SEGMENT: z.string().regex(PATH_SEGMENT),
  ADMIN_IDS: userIds,
  KEYHOLDER_IDS: userIds,
  REPORTER_REF_KEY: referenceKey,
  ADMIN_CHAT_ID: negativeChatId,
  MEMBERSHIP_CHAT_ID: chatId,
  BROADCAST_CHAT_ID: negativeChatId,
  ALLOWED_LINK_HOSTS: hostList.default([...DEFAULT_LINK_HOSTS]),
  LOCKDOWN: z.literal('1').optional(),
  APPROVAL_GRACE_MINUTES: integer(1, 1440).default(30),
  VENUE_LOCALE: z.enum(['fa', 'en']).default('fa'),
  MARKS_PER_DAY: integer(0, 1_000_000).default(20_000),
  MARKS_PER_REPORT: integer(0, 1_000_000).default(5_000),
  SQLITE_PATH: z.string().regex(NOT_BLANK).default(DEFAULT_SQLITE_PATH),
});

type VariableName = keyof typeof envSchema.shape;

/** What each variable must hold: the only text a failed load reports besides the names. */
const REQUIREMENTS: Readonly<Record<VariableName, string>> = {
  BOT_TOKEN: 'a non-blank secret',
  BOT_ID: "a positive integer, the bot's numeric Telegram id",
  BOT_USERNAME: "the bot's username without the @: 5 to 32 characters from A-Z, a-z, 0-9 and _",
  WEBHOOK_SECRET: '32 to 256 characters from A-Z, a-z, 0-9, _ and -, equal to neither WEBHOOK_PATH_SEGMENT nor REPORTER_REF_KEY',
  WEBHOOK_PATH_SEGMENT: 'a URL path segment of A-Z, a-z, 0-9, _ and -',
  ADMIN_IDS: 'comma-separated numeric Telegram user ids, never usernames',
  KEYHOLDER_IDS: 'comma-separated numeric Telegram user ids, never usernames, none of them in ADMIN_IDS',
  REPORTER_REF_KEY: 'a non-blank secret of at least 32 characters, equal to none of BOT_TOKEN, WEBHOOK_SECRET and WEBHOOK_PATH_SEGMENT',
  ADMIN_CHAT_ID: "a negative integer chat id, the private admin supergroup's: never the broadcast channel's or the membership chat's",
  MEMBERSHIP_CHAT_ID: 'a non-zero integer chat id',
  BROADCAST_CHAT_ID: "a negative integer chat id, the broadcast channel's",
  ALLOWED_LINK_HOSTS:
    'optional; comma-separated exact lowercase hostnames of a-z, 0-9, dots and hyphens, with no scheme, path or port',
  LOCKDOWN: 'optional; 1, or nothing',
  APPROVAL_GRACE_MINUTES: 'an integer from 1 to 1440 (default 30)',
  VENUE_LOCALE: 'optional; fa or en (default fa), the language of the admin review venue',
  MARKS_PER_DAY: 'an integer from 0 to 1000000 (default 20000)',
  MARKS_PER_REPORT: 'an integer from 0 to 1000000 (default 5000)',
  SQLITE_PATH: `optional; the Node port's SQLite file, not blank (default ${DEFAULT_SQLITE_PATH}); the Worker never reads it`,
};

const isVariableName = (name: string): name is VariableName => Object.hasOwn(REQUIREMENTS, name);

/** The variables an environment must not define at all, with why: any value is refused. */
const FORBIDDEN: Readonly<Record<string, string>> = {
  DEBUG: "DEBUG would switch on grammY's own logging past the redacting logger",
  NODE_DEBUG:
    "NODE_DEBUG would switch on Node's own debug lines past the redacting logger, with fetch or undici every Bot API request and the token in its path",
  NODE_DEBUG_NATIVE: "NODE_DEBUG_NATIVE would switch on Node's native debug lines past the redacting logger",
};

/** Why `name` must not be set, if it is one of FORBIDDEN. */
const forbiddenBecause = (name: string): string | undefined =>
  Object.hasOwn(FORBIDDEN, name) ? FORBIDDEN[name] : undefined;

/** The variables once each holds on its own. */
type Values = z.output<typeof envSchema>;

/**
 * A rule between variables, checked once each holds on its own: the
 * variables it binds, and the sentence a refusal gives, which names them
 * and why, never a value.
 */
interface CrossFieldRule {
  readonly variables: readonly VariableName[];
  readonly sentence: string;
  readonly holds: (values: Values) => boolean;
}

/** The rules between variables (see the header), in the order a refusal gives them. */
const CROSS_FIELD_RULES: readonly CrossFieldRule[] = [
  {
    variables: ['ADMIN_IDS', 'KEYHOLDER_IDS'],
    sentence: 'ADMIN_IDS and KEYHOLDER_IDS must not share an id: a keyholder is never an admin',
    holds: (values) => !values.KEYHOLDER_IDS.some((id) => values.ADMIN_IDS.includes(id)),
  },
  {
    variables: ['WEBHOOK_PATH_SEGMENT', 'WEBHOOK_SECRET'],
    sentence: "WEBHOOK_SECRET and WEBHOOK_PATH_SEGMENT must differ: the path segment is in the webhook's URL, which getWebhookInfo and request logs show",
    holds: (values) => values.WEBHOOK_SECRET !== values.WEBHOOK_PATH_SEGMENT,
  },
  {
    variables: ['REPORTER_REF_KEY', 'WEBHOOK_SECRET'],
    sentence: 'REPORTER_REF_KEY and WEBHOOK_SECRET must differ: Telegram holds the webhook secret',
    holds: (values) => values.REPORTER_REF_KEY !== values.WEBHOOK_SECRET,
  },
  {
    variables: ['REPORTER_REF_KEY', 'WEBHOOK_PATH_SEGMENT'],
    sentence: "REPORTER_REF_KEY and WEBHOOK_PATH_SEGMENT must differ: the path segment is in the webhook's URL",
    holds: (values) => values.REPORTER_REF_KEY !== values.WEBHOOK_PATH_SEGMENT,
  },
  {
    variables: ['BOT_TOKEN', 'REPORTER_REF_KEY'],
    sentence: 'REPORTER_REF_KEY and BOT_TOKEN must differ: Telegram holds the bot token',
    holds: (values) => values.REPORTER_REF_KEY !== values.BOT_TOKEN,
  },
  {
    variables: ['ADMIN_CHAT_ID', 'BROADCAST_CHAT_ID'],
    sentence: 'ADMIN_CHAT_ID and BROADCAST_CHAT_ID must differ: the review venue is never the broadcast channel',
    holds: (values) => values.ADMIN_CHAT_ID !== values.BROADCAST_CHAT_ID,
  },
  {
    variables: ['ADMIN_CHAT_ID', 'MEMBERSHIP_CHAT_ID'],
    sentence: 'ADMIN_CHAT_ID and MEMBERSHIP_CHAT_ID must differ: the review venue is never the membership chat',
    holds: (values) => values.ADMIN_CHAT_ID !== values.MEMBERSHIP_CHAT_ID,
  },
];

/**
 * The error for the rules of CROSS_FIELD_RULES that failed: the variables
 * they bind, sorted, once each, and each one's sentence; never a value, and
 * no cause.
 */
const crossFieldInvalid = (failed: readonly CrossFieldRule[]): AppError =>
  new AppError('CONFIG_INVALID', `invalid configuration: ${failed.map((rule) => rule.sentence).join('; ')}`, {
    variables: [...new Set(failed.flatMap((rule) => rule.variables))].sort(),
  });

/** The validated configuration. Printing it in any form yields CONFIG_REDACTED. */
export interface Config {
  readonly botToken: string;
  /** With botUsername, the bot's identity for grammY's botInfo: no getMe call per update. */
  readonly botId: number;
  readonly botUsername: string;
  /** The webhook's secret_token: 32 to 256 characters, never the path segment's value. */
  readonly webhookSecret: string;
  readonly webhookPathSegment: string;
  readonly adminIds: readonly number[];
  /** The keyholders: they receive the alerts and may run /lockdown, /unlock and /retract. */
  readonly keyholderIds: readonly number[];
  /** The key of the reporter references and link hashes: at least 32 characters, never the token's, the webhook secret's or the path segment's value. */
  readonly reporterRefKey: string;
  /** The admin review venue: a negative chat id, never the channel's or the membership chat's. */
  readonly adminChatId: number;
  /** The chat whose members get the members' intake limits. */
  readonly membershipChatId: number;
  /** The channel each approved report is posted into, once. */
  readonly broadcastChatId: number;
  /** The exact hosts a post may link to; any other link is never sent. */
  readonly allowedLinkHosts: readonly string[];
  /** The keyholder's LOCKDOWN override: true when the secret is set to 1. */
  readonly lockdown: boolean;
  readonly approvalGraceMinutes: number;
  /** The one language of the bot's messages in the admin review venue. */
  readonly venueLocale: 'fa' | 'en';
  /** The daily cap on recorded "I reported it" presses, all reports together. */
  readonly marksPerDay: number;
  /** The cap on recorded "I reported it" presses for one report. */
  readonly marksPerReport: number;
  /** The Node port's SQLite file (src/node.ts); the Worker never reads it. */
  readonly sqlitePath: string;
  /** JSON.stringify calls this: the configuration serialises as CONFIG_REDACTED. */
  toJSON(): string;
}

/**
 * The error for a configuration that failed validation: an AppError
 * CONFIG_INVALID carrying the offending variable names and what each must
 * hold, never a value, and no cause: the validator's own error stays inside
 * this module.
 */
const configInvalid = (variables: readonly string[]): AppError => {
  const details = variables.map((name) => {
    if (isVariableName(name)) return `${name} must be ${REQUIREMENTS[name]}`;
    const because = forbiddenBecause(name);
    return because === undefined ? name : `${name} must not be set: ${because}`;
  });
  return new AppError('CONFIG_INVALID', `invalid configuration: ${details.join('; ')}`, {
    variables,
  });
};

/**
 * Validates the deployment's variables and returns the frozen, unprintable
 * configuration. An empty value counts as absent, so an optional variable
 * left blank in .dev.vars takes its default. Throws an AppError
 * CONFIG_INVALID whose `variables` lists the offending names, sorted; an
 * environment that defines DEBUG, NODE_DEBUG or NODE_DEBUG_NATIVE, with any
 * value, the empty one included, is refused the same way, naming each and
 * why. Once every variable holds on its own, a configuration that breaks
 * any of CROSS_FIELD_RULES (ADMIN_IDS and KEYHOLDER_IDS sharing an id, say)
 * is refused the same way, by one error naming every variable the broken
 * rules bind and saying each rule.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  // Defined at all is enough: the empty value counts here, unlike below.
  const forbidden = Object.keys(FORBIDDEN).filter((name) => Object.hasOwn(env, name) && env[name] !== undefined);
  const present: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && value !== '') present[name] = value;
  }

  const parsed = envSchema.safeParse(present);
  if (!parsed.success || forbidden.length > 0) {
    const names = new Set(forbidden);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) names.add(String(issue.path[0] ?? '(config)'));
    }
    throw configInvalid([...names].sort());
  }

  const values = parsed.data;
  const broken = CROSS_FIELD_RULES.filter((rule) => !rule.holds(values));
  if (broken.length > 0) throw crossFieldInvalid(broken);
  return Object.freeze({
    botToken: values.BOT_TOKEN,
    botId: values.BOT_ID,
    botUsername: values.BOT_USERNAME,
    webhookSecret: values.WEBHOOK_SECRET,
    webhookPathSegment: values.WEBHOOK_PATH_SEGMENT,
    adminIds: Object.freeze([...values.ADMIN_IDS]),
    keyholderIds: Object.freeze([...values.KEYHOLDER_IDS]),
    reporterRefKey: values.REPORTER_REF_KEY,
    adminChatId: values.ADMIN_CHAT_ID,
    membershipChatId: values.MEMBERSHIP_CHAT_ID,
    broadcastChatId: values.BROADCAST_CHAT_ID,
    allowedLinkHosts: Object.freeze([...values.ALLOWED_LINK_HOSTS]),
    lockdown: values.LOCKDOWN === '1',
    approvalGraceMinutes: values.APPROVAL_GRACE_MINUTES,
    venueLocale: values.VENUE_LOCALE,
    marksPerDay: values.MARKS_PER_DAY,
    marksPerReport: values.MARKS_PER_REPORT,
    sqlitePath: values.SQLITE_PATH,
    // Own enumerable properties on purpose: a spread or Object.assign copy
    // carries them along and stays redacted.
    toJSON: (): string => CONFIG_REDACTED,
    [INSPECT_CUSTOM]: (): string => CONFIG_REDACTED,
  });
}

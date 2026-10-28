// @critical-path
// The configuration schema (doc/architecture/adr-0002-language-and-framework.md,
// doc/architecture/adr-0003-update-transport-and-admin-authority.md;
// critical invariants 2 and 6).
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
//   echoing any value.
// The posts go to one channel, BROADCAST_CHAT_ID, and only to links on the
// exact hosts of ALLOWED_LINK_HOSTS. LOCKDOWN is the keyholder's override
// (`wrangler secret put LOCKDOWN` with the value 1), which no Telegram
// command can clear.
// The Worker reads its configuration through configFor(env) in
// src/config/memo.ts, which parses once per isolate per env object.
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
/** Telegram's setWebhook secret_token alphabet (doc/guides/operations-and-security.md, 2.1). */
const WEBHOOK_SECRET = /^[A-Za-z0-9_-]{1,256}$/;
/** A URL path segment that needs no escaping. */
const PATH_SEGMENT = /^[A-Za-z0-9_-]+$/;
/** A Telegram bot username, without the @. */
const BOT_USERNAME = /^[A-Za-z0-9_]{5,32}$/;
/** At least one character that is not whitespace. */
const NOT_BLANK = /\S/;
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

/** A channel's chat id: a negative safe integer. */
const channelId = z
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
  REPORTER_REF_KEY: secret,
  ADMIN_CHAT_ID: chatId,
  MEMBERSHIP_CHAT_ID: chatId,
  BROADCAST_CHAT_ID: channelId,
  ALLOWED_LINK_HOSTS: hostList.default([...DEFAULT_LINK_HOSTS]),
  LOCKDOWN: z.literal('1').optional(),
  APPROVAL_GRACE_MINUTES: integer(1, 1440).default(30),
  MARKS_PER_DAY: integer(0, 1_000_000).default(20_000),
  MARKS_PER_REPORT: integer(0, 1_000_000).default(5_000),
});

type VariableName = keyof typeof envSchema.shape;

/** What each variable must hold: the only text a failed load reports besides the names. */
const REQUIREMENTS: Readonly<Record<VariableName, string>> = {
  BOT_TOKEN: 'a non-blank secret',
  BOT_ID: "a positive integer, the bot's numeric Telegram id",
  BOT_USERNAME: "the bot's username without the @: 5 to 32 characters from A-Z, a-z, 0-9 and _",
  WEBHOOK_SECRET: '1 to 256 characters from A-Z, a-z, 0-9, _ and -',
  WEBHOOK_PATH_SEGMENT: 'a URL path segment of A-Z, a-z, 0-9, _ and -',
  ADMIN_IDS: 'comma-separated numeric Telegram user ids, never usernames',
  KEYHOLDER_IDS: 'comma-separated numeric Telegram user ids, never usernames, none of them in ADMIN_IDS',
  REPORTER_REF_KEY: 'a non-blank secret',
  ADMIN_CHAT_ID: 'a non-zero integer chat id',
  MEMBERSHIP_CHAT_ID: 'a non-zero integer chat id',
  BROADCAST_CHAT_ID: "a negative integer chat id, the broadcast channel's",
  ALLOWED_LINK_HOSTS:
    'optional; comma-separated exact lowercase hostnames of a-z, 0-9, dots and hyphens, with no scheme, path or port',
  LOCKDOWN: 'optional; 1, or nothing',
  APPROVAL_GRACE_MINUTES: 'an integer from 1 to 1440 (default 30)',
  MARKS_PER_DAY: 'an integer from 0 to 1000000 (default 20000)',
  MARKS_PER_REPORT: 'an integer from 0 to 1000000 (default 5000)',
};

const isVariableName = (name: string): name is VariableName => Object.hasOwn(REQUIREMENTS, name);

/** The error for an id in both ADMIN_IDS and KEYHOLDER_IDS: both names, no value. */
const sharedId = (): AppError =>
  new AppError(
    'CONFIG_INVALID',
    'invalid configuration: ADMIN_IDS and KEYHOLDER_IDS must not share an id: a keyholder is never an admin',
    { variables: ['ADMIN_IDS', 'KEYHOLDER_IDS'] },
  );

/** The validated configuration. Printing it in any form yields CONFIG_REDACTED. */
export interface Config {
  readonly botToken: string;
  /** With botUsername, the bot's identity for grammY's botInfo: no getMe call per update. */
  readonly botId: number;
  readonly botUsername: string;
  readonly webhookSecret: string;
  readonly webhookPathSegment: string;
  readonly adminIds: readonly number[];
  /** The keyholders: they receive the alerts and may run /lockdown, /unlock and /retract. */
  readonly keyholderIds: readonly number[];
  readonly reporterRefKey: string;
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
  /** The daily cap on recorded "I reported it" presses, all reports together. */
  readonly marksPerDay: number;
  /** The cap on recorded "I reported it" presses for one report. */
  readonly marksPerReport: number;
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
  const details = variables.map((name) =>
    isVariableName(name) ? `${name} must be ${REQUIREMENTS[name]}` : name,
  );
  return new AppError('CONFIG_INVALID', `invalid configuration: ${details.join('; ')}`, {
    variables,
  });
};

/**
 * Validates the deployment's variables and returns the frozen, unprintable
 * configuration. An empty value counts as absent, so an optional variable
 * left blank in .dev.vars takes its default. Throws an AppError
 * CONFIG_INVALID whose `variables` lists the offending names, sorted; a
 * configuration whose ADMIN_IDS and KEYHOLDER_IDS share an id is refused
 * the same way, naming both.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const present: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && value !== '') present[name] = value;
  }

  const parsed = envSchema.safeParse(present);
  if (!parsed.success) {
    const names = new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? '(config)')));
    throw configInvalid([...names].sort());
  }

  const values = parsed.data;
  if (values.KEYHOLDER_IDS.some((id) => values.ADMIN_IDS.includes(id))) throw sharedId();
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
    marksPerDay: values.MARKS_PER_DAY,
    marksPerReport: values.MARKS_PER_REPORT,
    // Own enumerable properties on purpose: a spread or Object.assign copy
    // carries them along and stays redacted.
    toJSON: (): string => CONFIG_REDACTED,
    [INSPECT_CUSTOM]: (): string => CONFIG_REDACTED,
  });
}

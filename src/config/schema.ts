// @critical-path
// The configuration schema (doc/architecture/adr-0002-language-and-framework.md,
// doc/architecture/adr-0003-update-transport-and-admin-authority.md;
// critical invariants 2 and 6).
//
// Every value comes from the deployment's secret store or environment
// (Workers secrets in production, .dev.vars locally, the environment on the
// Node port), never from VCS. Two rules are pinned here:
// - rule 2: ADMIN_IDS holds numeric Telegram user ids only. A username, an
//   @handle or an empty entry fails the load: usernames are reassignable and
//   never grant authority.
// - rule 6: the loaded object is not printable (JSON.stringify and
//   util.inspect both render it as CONFIG_REDACTED), and a failed load throws
//   an AppError CONFIG_INVALID that names the offending variables without
//   echoing any value.
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
/** One ADMIN_IDS entry: a positive decimal integer in canonical form. */
const USER_ID = /^[1-9][0-9]*$/;
/** Telegram's setWebhook secret_token alphabet (doc/guides/operations-and-security.md, 2.1). */
const WEBHOOK_SECRET = /^[A-Za-z0-9_-]{1,256}$/;
/** A URL path segment that needs no escaping. */
const PATH_SEGMENT = /^[A-Za-z0-9_-]+$/;
/** A Telegram bot username, without the @. */
const BOT_USERNAME = /^[A-Za-z0-9_]{5,32}$/;
/** At least one character that is not whitespace. */
const NOT_BLANK = /\S/;

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

/** Comma-separated numeric Telegram user ids; spaces around an entry are ignored. */
const adminIds = z
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

const envSchema = z.object({
  BOT_TOKEN: secret,
  BOT_ID: integer(1, Number.MAX_SAFE_INTEGER),
  BOT_USERNAME: z.string().regex(BOT_USERNAME),
  WEBHOOK_SECRET: z.string().regex(WEBHOOK_SECRET),
  WEBHOOK_PATH_SEGMENT: z.string().regex(PATH_SEGMENT),
  ADMIN_IDS: adminIds,
  REPORTER_REF_KEY: secret,
  ADMIN_CHAT_ID: chatId,
  MIRROR_CHAT_ID: chatId.optional(),
  MEMBERSHIP_CHAT_ID: chatId,
  DAILY_RECIPIENT_BUDGET: integer(1, Number.MAX_SAFE_INTEGER),
  BROADCAST_BATCH_SIZE: integer(1, 45).default(35),
  // 25 is the decided ceiling, below Telegram's "about 30" per second.
  BROADCAST_MESSAGES_PER_SECOND: integer(1, 25).default(25),
  APPROVAL_GRACE_MINUTES: integer(1, 60).default(5),
  MARKS_PER_DAY: integer(0, 1_000_000).default(20_000),
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
  REPORTER_REF_KEY: 'a non-blank secret',
  ADMIN_CHAT_ID: 'a non-zero integer chat id',
  MIRROR_CHAT_ID: 'optional; a non-zero integer chat id',
  MEMBERSHIP_CHAT_ID: 'a non-zero integer chat id',
  DAILY_RECIPIENT_BUDGET: 'a positive integer',
  BROADCAST_BATCH_SIZE: 'an integer from 1 to 45 (default 35)',
  BROADCAST_MESSAGES_PER_SECOND: 'an integer from 1 to 25 (default 25)',
  APPROVAL_GRACE_MINUTES: 'an integer from 1 to 60 (default 5)',
  MARKS_PER_DAY: 'an integer from 0 to 1000000 (default 20000)',
};

const isVariableName = (name: string): name is VariableName => Object.hasOwn(REQUIREMENTS, name);

/** The validated configuration. Printing it in any form yields CONFIG_REDACTED. */
export interface Config {
  readonly botToken: string;
  /** With botUsername, the bot's identity for grammY's botInfo: no getMe call per update. */
  readonly botId: number;
  readonly botUsername: string;
  readonly webhookSecret: string;
  readonly webhookPathSegment: string;
  readonly adminIds: readonly number[];
  readonly reporterRefKey: string;
  readonly adminChatId: number;
  readonly mirrorChatId: number | undefined;
  /** The chat whose members may subscribe and get the member limits at intake. */
  readonly membershipChatId: number;
  readonly dailyRecipientBudget: number;
  readonly broadcastBatchSize: number;
  readonly broadcastMessagesPerSecond: number;
  readonly approvalGraceMinutes: number;
  /** The daily cap on recorded "I reported it" presses. */
  readonly marksPerDay: number;
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
 * CONFIG_INVALID whose `variables` lists the offending names, sorted.
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
  return Object.freeze({
    botToken: values.BOT_TOKEN,
    botId: values.BOT_ID,
    botUsername: values.BOT_USERNAME,
    webhookSecret: values.WEBHOOK_SECRET,
    webhookPathSegment: values.WEBHOOK_PATH_SEGMENT,
    adminIds: Object.freeze([...values.ADMIN_IDS]),
    reporterRefKey: values.REPORTER_REF_KEY,
    adminChatId: values.ADMIN_CHAT_ID,
    mirrorChatId: values.MIRROR_CHAT_ID,
    membershipChatId: values.MEMBERSHIP_CHAT_ID,
    dailyRecipientBudget: values.DAILY_RECIPIENT_BUDGET,
    broadcastBatchSize: values.BROADCAST_BATCH_SIZE,
    broadcastMessagesPerSecond: values.BROADCAST_MESSAGES_PER_SECOND,
    approvalGraceMinutes: values.APPROVAL_GRACE_MINUTES,
    marksPerDay: values.MARKS_PER_DAY,
    // Own enumerable properties on purpose: a spread or Object.assign copy
    // carries them along and stays redacted.
    toJSON: (): string => CONFIG_REDACTED,
    [INSPECT_CUSTOM]: (): string => CONFIG_REDACTED,
  });
}

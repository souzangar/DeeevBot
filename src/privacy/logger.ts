// @critical-path
// The redacting logger (critical invariant 6;
// doc/architecture/adr-0005-error-handling-convention.md): the only logger,
// and the ONLY file in src/ allowed to write to the console. eslint's
// no-console is an error everywhere else; eslint.config.js lifts it for this
// one file, for console.log and console.error only, and
// test/invariants/logger-redaction.test.ts fails if any other file under
// src/ touches the console. The critical-path tripwire flags the two console
// calls in consoleSink below: they are the sanctioned ones.
//
// A line is one JSON object built from allow-listed scalars, never from a
// payload: `level`, `event` (from LOG_EVENTS) and the LogFields below.
// Anything else is a type error. At runtime:
// - a field whose value is outside its permitted set is kept as "[dropped]";
// - a field the allow-list does not name is left out, since its name could
//   itself be data, and only counted in `unknownFields`;
// - only own data properties are read, so no getter ever runs;
// - every string is also dropped when it holds a bot-token shape, a URL
//   (`://`) or a run of 5 or more digits: a Telegram id (a member's, a
//   reporter's or an admin's) is such a run, whatever field it is passed in;
// - no number of 5 or more digits is logged exactly either: a count or a
//   duration of 10000 or more is coarsened to two significant digits and an
//   SI suffix ("50k", "1.4M"; see coarsen()), which keeps the magnitude
//   operations need and can neither equal nor contain an id, and a
//   telegramErrorCode outside 100 to 999 is dropped.
//
// logError(event, error) reads only the error's class name and, for a
// GrammyError, its error_code and method, or for an AppError, its catalog
// code; never its message, description, payload, parameters, cause or
// stack, which can carry a reported URL, the outgoing text, a chat id or, in
// an HttpError, the token URL. (grammY's `sensitiveLogs` client option must
// stay false: it copies that URL into HttpError messages, which this logger
// never reads but the runtime's own report of an uncaught error would.)
import { GrammyError } from 'grammy';
import { AppError } from '../errors/app-error';
import { isErrorCode, type ErrorCode } from '../errors/catalog';

/** The events a line may name. Each unit adds its own here. */
export const LOG_EVENTS = [
  'config.invalid',
  'update.failed',
  // The webhook's body was not an update (src/telegram/webhook.ts).
  'update.unreadable',
  // A reply or a callback answer failed (src/telegram/respond.ts, the error boundary).
  'reply.failed',
  // A keyholder or venue alert failed (src/telegram/alerts.ts); retried by reconciliation.
  'alert.failed',
  // getChatMember failed for a reason other than "user not found" (src/auth/membership.ts).
  'membership.failed',
  // A keyholder set or lifted the lockdown switch (src/telegram/commands.ts).
  'lockdown.set',
  'lockdown.cleared',
  // A message received in a private chat still there after one retry (the
  // reply asks the sender to delete it; src/telegram/delete-message.ts), the
  // intake acknowledgement's self-deletion failed, a press's prompt was not
  // edited (src/telegram/intake.ts).
  'intake.message_not_deleted',
  'intake.ack_not_deleted',
  'intake.prompt_not_edited',
  // The review (unit U4, src/review/): a submitted report's card was not
  // posted to the venue (src/review/card-post.ts); a venue message (a card,
  // a prompt, an admin's reply, a status card) could not be deleted, or
  // edited after its decision committed (src/review/venue.ts); the status
  // card was not posted after an approval; the approval notice reached
  // only some keyholders (with the counts), or none could be sent, or one
  // could not be edited to its outcome (src/review/notify.ts); a reply was
  // refused because its approval's notice reached no keyholder, with the
  // counts, or the approval's batch failed and a read could not tell
  // whether it landed, or showed that it had landed after all, the approval
  // going on (src/review/approve.ts).
  'review.card_not_sent',
  'review.message_not_deleted',
  'review.message_not_edited',
  'review.status_card_not_sent',
  'review.notice_incomplete',
  'review.notice_failed',
  'review.notice_not_edited',
  'review.notice_unreached',
  'review.approval_unknown',
  'review.approval_landed',
  // The scheduling unit (U5, src/broadcast/): a cron run that failed
  // unexpectedly, that a storage failure stopped, the keyholders alerted
  // of that failure, a cron expression this Worker does not run; the post:
  // sent, its claim lost to another run or a hold, a 429 (with the wait),
  // Telegram's refusal, an ambiguous send, a stored text the send-time check
  // refused, a send whose record failed, a record another path wrote first;
  // an edit job's failure or 429, or a job row it cannot read (its report
  // flagged for the alert); reconciliation's re-enqueued edit jobs and
  // its alert (incomplete when a keyholder did not get it); the once-only
  // lockdown alert (likewise); a retention pass, a snapshot or a
  // finalization that failed (src/broadcast/maintenance.ts); /attach
  // recorded, refused (a message it cannot edit; a text that is not the
  // post; a date outside the send window or another claim in it), a probe it
  // could not undo, and a verified post whose keyboard it could not put
  // back; /repost;
  // /halt and /resume; the deployed probe's counts, and its one-time check
  // of the text comparison against Telegram (src/probe.ts).
  'tick.failed',
  'tick.storage_failed',
  'tick.storage_alerted',
  'cron.unknown',
  'post.sent',
  'post.claim_lost',
  'post.rate_limited',
  'post.refused',
  'post.ambiguous',
  'post.text_refused',
  'post.not_recorded',
  'post.resolved_elsewhere',
  'edit.failed',
  'edit.rate_limited',
  'edit.unreadable',
  'reconcile.reenqueued',
  'reconcile.alerted',
  'reconcile.alert_incomplete',
  'lockdown.alerted',
  'lockdown.alert_incomplete',
  'retention.failed',
  'snapshot.failed',
  'finalize.failed',
  'attach.recorded',
  'attach.refused',
  'attach.text_mismatch',
  'attach.window_mismatch',
  'attach.revert_failed',
  'attach.restore_failed',
  'repost.done',
  'halt.set',
  'halt.cleared',
  'probe.invocation',
  'probe.fidelity',
  // The closure and retraction unit (U6): a closure or a retraction
  // ordered, then concluded (the post edited and the report finalized in
  // one batch: src/broadcast/concluding.ts), or concluded on a post
  // Telegram reports as gone (deleted by hand, say); an edit job whose
  // report left its state, dropped; an edit that could not be made, its
  // report flagged for a human; an edit whose conclusion a hold or a change
  // overtook; a
  // retraction's deletion of a young post that failed (the edit stands);
  // the retention job's counts, and its alert of the jobs it abandoned
  // (src/privacy/retention.ts); the monthly snapshot sent
  // (src/broadcast/stats.ts).
  'close.ordered',
  'close.done',
  'retract.ordered',
  'retract.done',
  'edit.post_gone',
  'edit.stale',
  'edit.flagged',
  'edit.unconcluded',
  'retract.not_deleted',
  'retention.done',
  'retention.abandoned',
  'snapshot.sent',
  // The Node port (unit U7, src/node.ts): its database file could not be
  // opened, prepared or closed; the migrations applied at start (with how
  // many were new), or one that failed, which refuses the start;
  // deleteWebhook refused, which refuses the start too; started; stopping
  // (a signal, or polling that ended by itself); stopped (polling ended,
  // the running tick awaited, the database closed); a stop past its
  // deadline; an uncaught exception or an unhandled rejection, by class.
  // Long polling (src/telegram/polling.ts): a getUpdates that failed, which
  // the runner retries; polling that ended by itself (a 401, another
  // poller's 409, or retries exhausted); polling ended by a webhook set for
  // the bot, and the keyholders' alert of it (with the counts), after which
  // the port yields. The minute loop (src/broadcast/minute-loop.ts): a
  // minute skipped because the run before it was still going.
  'port.database_failed',
  'port.migrated',
  'port.migration_failed',
  'port.webhook_not_deleted',
  'port.started',
  'port.stopping',
  'port.stopped',
  'port.stop_timeout',
  'port.crashed',
  'polling.failed',
  'polling.stopped',
  'polling.webhook_set',
  'polling.webhook_alerted',
  'tick.skipped',
] as const;
export type LogEvent = (typeof LOG_EVENTS)[number];

/** The Bot API methods a line may name. */
export const API_METHODS = [
  'getMe',
  'getUpdates',
  'setWebhook',
  'deleteWebhook',
  'getChatMember',
  'sendMessage',
  'editMessageText',
  'editMessageReplyMarkup',
  'deleteMessage',
  'answerCallbackQuery',
] as const;
export type ApiMethod = (typeof API_METHODS)[number];

/**
 * The counts a line may carry. Each unit adds its own here: the deployed
 * probe's D1 queries and Bot API calls per invocation (src/probe.ts); the
 * retention job's rows by path (src/privacy/retention.ts): drafts and
 * prompts deleted, jobs abandoned, posted reports set to expire, reports
 * finalized, finalized rows removed, idle reporter rows and old counter
 * rows deleted.
 */
export const COUNT_FIELDS = [
  'count',
  'sent',
  'failed',
  'attempts',
  'queries',
  'apiCalls',
  'drafts',
  'prompts',
  'abandoned',
  'expiring',
  'finalized',
  'removed',
  'reporterRows',
  'counterRows',
] as const;
export type CountField = (typeof COUNT_FIELDS)[number];

/** Everything a line may carry besides its level and event. */
export type LogFields = {
  /** An error's class name: an identifier of at most 64 characters. */
  readonly errorClass?: string;
  readonly errorCode?: ErrorCode;
  /** A Bot API `error_code`: an integer from 100 to 999. */
  readonly telegramErrorCode?: number;
  readonly apiMethod?: ApiMethod;
  /** A report id: exactly 20 lowercase letters a to z, the shape src/db/ids.ts draws. */
  readonly reportId?: string;
  /** Milliseconds, 0 or more, rounded to whole ms: exact below 10000, coarsened from 10000 ("12k"). */
  readonly durationMs?: number;
} & {
  /** A non-negative integer: exact below 10000, coarsened from 10000 ("50k"). */
  readonly [Field in CountField]?: number;
};

export interface Logger {
  log(event: LogEvent, fields?: LogFields): void;
  /** Logs `error` by class only (see the header), with the given fields beside it. */
  logError(event: LogEvent, error: unknown, fields?: LogFields): void;
}

export type LogLevel = 'info' | 'error';
/** Where finished lines go: the console in production, a recorder in tests. */
export type LogSink = (level: LogLevel, line: string) => void;

/** What a value outside its field's permitted set is replaced by. */
export const DROPPED = '[dropped]';

/** A bot token: the shape the commit gate's secret-shape scan looks for. */
const TOKEN_SHAPE = /[0-9]{8,10}:[A-Za-z0-9_-]{35}/;
/** A run of digits as long as a Telegram id (5 or more). */
const ID_DIGITS = /[0-9]{5,}/;
/** The smallest number with 5 digits: from here on, a number is logged only coarsened. */
const ID_FLOOR = 10_000;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
// Pinned to the id shape (src/db/ids.ts): anything else, a username, a
// reporter reference or a hex digest included, is dropped.
const REPORT_ID = /^[a-z]{20}$/;

/**
 * Whether a string holds a bot-token shape, a URL (`://`) or a run of 5 or
 * more digits (a Telegram id). Every string field is checked with it on top
 * of its own permitted set, so the rule holds even for a field whose set is
 * later widened.
 */
export const looksSensitive = (value: string): boolean =>
  TOKEN_SHAPE.test(value) || value.includes('://') || ID_DIGITS.test(value);

/** The SI suffix for each power of 1000, as coarsen() writes it. */
const UNIT_SUFFIXES = ['', 'k', 'M', 'G', 'T', 'P'] as const;

/**
 * A number from 10000 to Number.MAX_SAFE_INTEGER as two significant digits
 * and an SI suffix: 12345 is "12k", 123456 "120k", 999999 "1.0M", 1400000
 * "1.4M", 424242001 "420M". The result is never the number's own digits and
 * holds at most three digits, so it can neither equal nor contain a Telegram
 * id. Anything outside that range is DROPPED.
 */
export const coarsen = (value: number): string => {
  if (!Number.isFinite(value) || value < ID_FLOOR || value > Number.MAX_SAFE_INTEGER) {
    return DROPPED;
  }
  // value is about digits × 10^exponent, with two-digit digits.
  let exponent = String(Math.floor(value)).length - 2;
  let digits = Math.round(value / 10 ** exponent);
  if (digits === 100) {
    digits = 10;
    exponent += 1;
  }
  // The leading digit's power is exponent + 1; the unit is the power of
  // 1000 at or below it, which leaves the digits a shift of -1, 0 or 1.
  const unit = Math.floor((exponent + 1) / 3);
  const suffix = UNIT_SUFFIXES[unit];
  if (suffix === undefined) return DROPPED;
  const shift = exponent - 3 * unit;
  const mantissa =
    shift < 0 ? `${Math.floor(digits / 10)}.${digits % 10}` : shift === 0 ? `${digits}` : `${digits}0`;
  return `${mantissa}${suffix}`;
};

/** What a field logs for a value: the value itself, its coarsened form, or DROPPED. */
type Render = (value: unknown) => string | number;

const keptIf =
  (permitted: (value: string | number) => boolean): Render =>
  (value) =>
    (typeof value === 'string' || typeof value === 'number') && permitted(value) ? value : DROPPED;

const inList =
  (permitted: readonly string[]) =>
  (value: unknown): boolean =>
    typeof value === 'string' && permitted.includes(value) && !looksSensitive(value);

const matching = (shape: RegExp): Render =>
  keptIf((value) => typeof value === 'string' && shape.test(value) && !looksSensitive(value));

/** Below 10000 the number itself; from 10000 its coarsened form. */
const exactOrCoarse = (value: number): string | number => (value < ID_FLOOR ? value : coarsen(value));

const count: Render = (value) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? exactOrCoarse(value)
    : DROPPED;

// Rounded to whole milliseconds first: a fraction could otherwise print a
// run of five or more digits (1234.5678901), which the rule forbids.
const duration: Render = (value) =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= Number.MAX_SAFE_INTEGER
    ? exactOrCoarse(Math.round(value))
    : DROPPED;

/** How each field renders, in the order the fields appear on a line. */
const RENDER: Readonly<Record<keyof LogFields, Render>> = {
  errorClass: matching(IDENTIFIER),
  errorCode: keptIf((value) => isErrorCode(value) && !looksSensitive(value)),
  telegramErrorCode: keptIf(
    (value) => typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 999,
  ),
  apiMethod: keptIf(inList(API_METHODS)),
  reportId: matching(REPORT_ID),
  durationMs: duration,
  count,
  sent: count,
  failed: count,
  attempts: count,
  queries: count,
  apiCalls: count,
  drafts: count,
  prompts: count,
  abandoned: count,
  expiring: count,
  finalized: count,
  removed: count,
  reporterRows: count,
  counterRows: count,
};

const isEvent = (value: unknown): value is LogEvent => inList(LOG_EVENTS)(value);

interface Sanitised {
  readonly fields: Readonly<Record<string, string | number>>;
  readonly unknownFields: number;
}

/** The allow-listed part of `source`, rendered, read through own data properties only. */
const sanitise = (source: unknown): Sanitised => {
  if (typeof source !== 'object' || source === null) return { fields: {}, unknownFields: 0 };
  const fields: Record<string, string | number> = {};
  for (const [name, render] of Object.entries(RENDER)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, name);
    if (descriptor === undefined) continue;
    if (!('value' in descriptor)) {
      // An accessor: never invoked, since a getter could compute anything.
      fields[name] = DROPPED;
      continue;
    }
    const value: unknown = descriptor.value;
    if (value === undefined) continue;
    fields[name] = render(value);
  }
  const unknownFields = Reflect.ownKeys(source).filter(
    (key) => typeof key !== 'string' || !Object.hasOwn(RENDER, key),
  ).length;
  return { fields, unknownFields };
};

/** What logError() may know about an error: its class and, for two classes, a code. */
const describeError = (error: unknown): Record<string, unknown> => {
  if (!(error instanceof Error)) return { errorClass: 'NonError' };
  if (error instanceof GrammyError) {
    return { errorClass: error.name, telegramErrorCode: error.error_code, apiMethod: error.method };
  }
  if (error instanceof AppError) return { errorClass: error.name, errorCode: error.code };
  return { errorClass: error.name };
};

/** A logger that redacts as the header says and hands each finished line to `sink`. */
export function createLogger(sink: LogSink): Logger {
  const emit = (level: LogLevel, event: unknown, parts: readonly Sanitised[]): void => {
    const record: Record<string, string | number> = {
      level,
      event: isEvent(event) ? event : DROPPED,
    };
    let unknownFields = 0;
    // A part's keys are allow-listed names only, so `level` and `event` stay put.
    for (const part of parts) {
      Object.assign(record, part.fields);
      unknownFields += part.unknownFields;
    }
    if (unknownFields > 0) record.unknownFields = count(unknownFields);
    sink(level, JSON.stringify(record));
  };
  return {
    log: (event, fields) => {
      emit('info', event, [sanitise(fields)]);
    },
    // The error's own fields come last, so a caller cannot overwrite them.
    logError: (event, error, fields) => {
      emit('error', event, [sanitise(fields), sanitise(describeError(error))]);
    },
  };
}

/** The production sink, and the only console access in src/. */
const consoleSink: LogSink = (level, line) => {
  if (level === 'error') console.error(line);
  else console.log(line);
};

/** The logger the application uses. */
export const consoleLogger: Logger = createLogger(consoleSink);

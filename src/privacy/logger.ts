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
//   (`://`) or a run of 5 or more digits: a Telegram id (a subscriber's, a
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
export const LOG_EVENTS = ['config.invalid', 'update.failed'] as const;
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
  'deleteMessage',
  'answerCallbackQuery',
] as const;
export type ApiMethod = (typeof API_METHODS)[number];

/** The counts a line may carry. Each unit adds its own here. */
export const COUNT_FIELDS = ['count', 'sent', 'failed', 'attempts'] as const;
export type CountField = (typeof COUNT_FIELDS)[number];

/** Everything a line may carry besides its level and event. */
export type LogFields = {
  /** An error's class name: an identifier of at most 64 characters. */
  readonly errorClass?: string;
  readonly errorCode?: ErrorCode;
  /** A Bot API `error_code`: an integer from 100 to 999. */
  readonly telegramErrorCode?: number;
  readonly apiMethod?: ApiMethod;
  /** A report id: 1 to 64 characters from A-Z, a-z, 0-9, _ and -. */
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
const REPORT_ID = /^[A-Za-z0-9_-]{1,64}$/;

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

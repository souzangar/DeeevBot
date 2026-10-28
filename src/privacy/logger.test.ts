// Unit tests for the redacting logger's mechanism: the line format, the
// allow-list and each drop rule, logError()'s reading of an error, the
// compile-time checks and the console sink. The rule-6 regression cases (a
// real GrammyError and HttpError carrying report data or the token URL, a
// Telegram id of an admin) are always-run invariant specs:
// test/invariants/logger-redaction.test.ts.
import { GrammyError, HttpError } from 'grammy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordingLogger } from '../../test/fakes/logger';
import { AppError } from '../errors/app-error';
import {
  API_METHODS,
  coarsen,
  consoleLogger,
  DROPPED,
  LOG_EVENTS,
  looksSensitive,
  type LogFields,
  type Logger,
} from './logger';

// Fixture values are never secret-shaped in this source (the commit gate's
// secret-shape scan reads test files): the token shape is assembled here.
const TOKEN_SHAPED = ['12345678', 'x'.repeat(35)].join(':');

/** A report id of the one shape the logger keeps (src/db/ids.ts): 20 lowercase letters. */
const REPORT_ID = 'qwertyuiopasdfghjklz';

/** The one record a single call emits. */
const recordOf = (log: (logger: Logger) => void): Record<string, unknown> => {
  const recorder = recordingLogger();
  log(recorder.logger);
  const [record, ...rest] = recorder.records();
  if (record === undefined || rest.length > 0) throw new Error('expected exactly one line');
  return record;
};

const fieldsOf = (fields: unknown) =>
  recordOf((logger) => {
    logger.log('update.failed', fields as LogFields);
  });

describe('the line', () => {
  it('is one JSON object: level, event, then the fields in allow-list order', () => {
    const { logger, lines } = recordingLogger();
    logger.log('update.failed', { attempts: 2, reportId: REPORT_ID, errorClass: 'TypeError' });
    expect(lines).toEqual([
      {
        level: 'info',
        line: `{"level":"info","event":"update.failed","errorClass":"TypeError","reportId":"${REPORT_ID}","attempts":2}`,
      },
    ]);
  });

  it('keeps every allow-listed field that holds a permitted value', () => {
    const fields: LogFields = {
      errorClass: 'GrammyError',
      errorCode: 'TELEGRAM_TRANSIENT',
      telegramErrorCode: 502,
      apiMethod: 'sendMessage',
      reportId: REPORT_ID,
      durationMs: 1234,
      count: 0,
      sent: 35,
      failed: 1,
      attempts: 9999,
    };
    expect(fieldsOf(fields)).toEqual({ level: 'info', event: 'update.failed', ...fields });
  });

  it('carries the level and the event alone when there are no fields', () => {
    expect(recordOf((logger) => logger.log('config.invalid'))).toEqual({
      level: 'info',
      event: 'config.invalid',
    });
  });

  it('replaces an event outside LOG_EVENTS (past the types)', () => {
    expect(recordOf((logger) => logger.log('chat 424242001' as 'update.failed'))).toEqual({
      level: 'info',
      event: DROPPED,
    });
  });

  it('names no event or API method that its own string checks would drop', () => {
    for (const value of [...LOG_EVENTS, ...API_METHODS]) expect(looksSensitive(value)).toBe(false);
  });
});

describe('looksSensitive', () => {
  it.each([
    ['a bot-token shape', TOKEN_SHAPED],
    ['a bot-token shape inside text', `token ${TOKEN_SHAPED} here`],
    ['a URL', 'https://www.instagram.com/someone/'],
    ['any scheme', 'tg://resolve?domain=x'],
    ['a 5-digit run', '12345'],
    ['a Telegram user id', '424242001'],
    ['a group chat id', '-1001234567890'],
    ['a digit run inside an identifier', 'rpt1234567x'],
  ])('flags %s', (_label, value) => {
    expect(looksSensitive(value)).toBe(true);
  });

  it.each([
    ['a class name', 'GrammyError'],
    ['a report id', REPORT_ID],
    ['four digits', 'v1234'],
    ['a catalog code', 'TELEGRAM_RATE_LIMITED'],
  ])('passes %s', (_label, value) => {
    expect(looksSensitive(value)).toBe(false);
  });
});

describe('coarsen', () => {
  it.each([
    [10_000, '10k'],
    [12_345, '12k'],
    [50_000, '50k'],
    [99_499, '99k'],
    [99_500, '100k'],
    [100_000, '100k'],
    [123_456, '120k'],
    [999_999, '1.0M'],
    [1_000_000, '1.0M'],
    [1_400_000, '1.4M'],
    [1_449_999, '1.4M'],
    [1_450_000, '1.5M'],
    [12_345_678, '12M'],
    [424_242_001, '420M'],
    [1_234_567_890, '1.2G'],
    [9_999_999_999, '10G'],
    [Number.MAX_SAFE_INTEGER, '9.0P'],
  ])('writes %i as %s', (value, coarse) => {
    expect(coarsen(value)).toBe(coarse);
  });

  it('never yields the digits it stands for, nor any 4-digit run', () => {
    const values = [10_000, 77_700, 777_000, 424_242_001, 1_000_000_007, 2 ** 40, Number.MAX_SAFE_INTEGER];
    for (let value = 10_007; value < Number.MAX_SAFE_INTEGER / 7; value = value * 7 + 3) values.push(value);
    for (const value of values) {
      const coarse = coarsen(value);
      expect(coarse, String(value)).toMatch(/^[0-9]{1,3}(\.[0-9])?[kMGTP]$/);
      expect(coarse).not.toContain(String(value));
      expect(looksSensitive(coarse)).toBe(false);
    }
  });

  it('drops anything below 10000 or beyond the safe-integer range', () => {
    for (const value of [9999, 0, -50_000, Number.MAX_SAFE_INTEGER + 2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(coarsen(value)).toBe(DROPPED);
    }
  });
});

describe('the drop rules', () => {
  it.each([
    ['digits as long as an id', '12345'],
    ['an embedded id', 'rpt-424242001'],
    ['a URL', 'https://example.org/x'],
    ['a space', 'rpt abc'],
    ['a colon', 'rpt:abc'],
    ['19 letters', REPORT_ID.slice(1)],
    ['21 letters', `${REPORT_ID}a`],
    ['a capital', `Q${REPORT_ID.slice(1)}`],
    ['a digit', `${REPORT_ID.slice(1)}7`],
    ['an underscore', `${REPORT_ID.slice(1)}_`],
    ['a hyphen', `${REPORT_ID.slice(1)}-`],
    ['nothing', ''],
  ])('drops a report id with %s', (_label, reportId) => {
    expect(fieldsOf({ reportId }).reportId).toBe(DROPPED);
  });

  it('keeps a report id of exactly 20 lowercase letters', () => {
    expect(fieldsOf({ reportId: REPORT_ID }).reportId).toBe(REPORT_ID);
  });

  it.each([
    ['a space', 'Not An Identifier'],
    ['a leading digit', '9Error'],
    ['an id-length digit run', 'Error12345'],
    ['a dot', 'grammy.GrammyError'],
    ['65 characters', 'E'.repeat(65)],
  ])('drops an error class with %s', (_label, errorClass) => {
    expect(fieldsOf({ errorClass }).errorClass).toBe(DROPPED);
  });

  it('drops an API method or an error code outside its list', () => {
    const record = fieldsOf({ apiMethod: 'sendPhoto', errorCode: 'NO_SUCH_CODE' });
    expect(record.apiMethod).toBe(DROPPED);
    expect(record.errorCode).toBe(DROPPED);
  });

  it.each([
    -1,
    -424242001,
    1.5,
    12_345.5,
    Number.MAX_SAFE_INTEGER + 1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('drops the count %s', (value) => {
    expect(fieldsOf({ count: value, sent: value, failed: value, attempts: value })).toEqual({
      level: 'info',
      event: 'update.failed',
      count: DROPPED,
      sent: DROPPED,
      failed: DROPPED,
      attempts: DROPPED,
    });
  });

  it('keeps a count below 10000 exact, and coarsens one from 10000', () => {
    expect(fieldsOf({ count: 0, sent: 9999, failed: 10_000, attempts: 50_000 })).toEqual({
      level: 'info',
      event: 'update.failed',
      count: 0,
      sent: 9999,
      failed: '10k',
      attempts: '50k',
    });
  });

  it('keeps a duration below 10000 ms exact, coarsens one from 10000, and drops anything else', () => {
    expect(fieldsOf({ durationMs: 0 }).durationMs).toBe(0);
    expect(fieldsOf({ durationMs: 9999.4 }).durationMs).toBe(9999);
    expect(fieldsOf({ durationMs: 9999.9 }).durationMs).toBe('10k');
    expect(fieldsOf({ durationMs: 1234.5678901 }).durationMs).toBe(1235);
    expect(fieldsOf({ durationMs: 10_000 }).durationMs).toBe('10k');
    expect(fieldsOf({ durationMs: 12_345.6 }).durationMs).toBe('12k');
    expect(fieldsOf({ durationMs: 86_400_000 }).durationMs).toBe('86M');
    for (const durationMs of [-1, Number.MAX_SAFE_INTEGER + 2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(fieldsOf({ durationMs }).durationMs).toBe(DROPPED);
    }
  });

  it('coarsens the unknownFields count too', () => {
    const many = Object.fromEntries(Array.from({ length: 12_345 }, (_, at) => [`k${at}`, at]));
    expect(fieldsOf(many)).toEqual({ level: 'info', event: 'update.failed', unknownFields: '12k' });
  });

  it('keeps a Telegram error code from 100 to 999, and drops anything else', () => {
    expect(fieldsOf({ telegramErrorCode: 429 }).telegramErrorCode).toBe(429);
    for (const telegramErrorCode of [99, 1000, 429.5, -429]) {
      expect(fieldsOf({ telegramErrorCode }).telegramErrorCode).toBe(DROPPED);
    }
  });

  it.each([
    ['a boolean', true],
    ['an object', { url: 'https://example.org/' }],
    ['an array', [REPORT_ID]],
    ['a function', () => REPORT_ID],
    ['null', null],
    ['a bigint', 5n],
    ['a symbol', Symbol(REPORT_ID)],
  ])('drops %s in any field (past the types)', (_label, value) => {
    const record = fieldsOf({ reportId: value, count: value });
    expect(record.reportId).toBe(DROPPED);
    expect(record.count).toBe(DROPPED);
  });

  it('drops a number in a string field and a string in a number field (past the types)', () => {
    const record = fieldsOf({ reportId: 7, errorClass: 7, count: '7', durationMs: '7' });
    expect(record).toEqual({
      level: 'info',
      event: 'update.failed',
      errorClass: DROPPED,
      reportId: DROPPED,
      durationMs: DROPPED,
      count: DROPPED,
    });
  });

  it('leaves out an undefined field', () => {
    expect(fieldsOf({ reportId: undefined })).toEqual({ level: 'info', event: 'update.failed' });
  });

  it('leaves out a field the allow-list does not name, without its name, and counts it', () => {
    const recorder = recordingLogger();
    const forbidden = 'chat_id_field';
    recorder.logger.log('update.failed', { reportId: REPORT_ID, [forbidden]: 1, [Symbol('s')]: 2 } as LogFields);
    expect(recorder.records()).toEqual([
      { level: 'info', event: 'update.failed', reportId: REPORT_ID, unknownFields: 2 },
    ]);
    expect(recorder.text()).not.toContain(forbidden);
  });

  it('never runs a getter', () => {
    const fields = {
      get reportId(): string {
        throw new Error('the getter ran');
      },
    };
    expect(fieldsOf(fields).reportId).toBe(DROPPED);
  });

  it('reads own properties only, never inherited ones', () => {
    const fields: unknown = Object.create({ reportId: REPORT_ID });
    expect(fieldsOf(fields)).toEqual({ level: 'info', event: 'update.failed' });
  });

  it('treats fields that are not an object as none (past the types)', () => {
    for (const fields of [null, REPORT_ID, 42]) {
      expect(fieldsOf(fields)).toEqual({ level: 'info', event: 'update.failed' });
    }
  });
});

describe('logError', () => {
  const errorRecord = (error: unknown, fields?: LogFields) =>
    recordOf((logger) => {
      logger.logError('update.failed', error, fields);
    });

  it('records a GrammyError by class, error_code and method only', () => {
    const error = new GrammyError(
      "Call to 'sendMessage' failed!",
      { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
      'sendMessage',
      { chat_id: 1234, text: 'the outgoing text' },
    );
    expect(errorRecord(error)).toEqual({
      level: 'error',
      event: 'update.failed',
      errorClass: 'GrammyError',
      telegramErrorCode: 403,
      apiMethod: 'sendMessage',
    });
  });

  it('drops the method of a GrammyError when it is not in API_METHODS', () => {
    const error = new GrammyError(
      "Call to 'sendPhoto' failed!",
      { ok: false, error_code: 400, description: 'Bad Request' },
      'sendPhoto',
      {},
    );
    expect(errorRecord(error).apiMethod).toBe(DROPPED);
  });

  it('records an AppError by class and catalog code, never its cause', () => {
    const error = new AppError('STORAGE_CAP_HIT', 'the daily write cap was hit', {
      cause: new TypeError('the lower layer'),
    });
    expect(errorRecord(error)).toEqual({
      level: 'error',
      event: 'update.failed',
      errorClass: 'AppError',
      errorCode: 'STORAGE_CAP_HIT',
    });
  });

  it.each([
    ['a TypeError', new TypeError('x'), 'TypeError'],
    ['an HttpError', new HttpError("Network request for 'getMe' failed!", new Error('x')), 'HttpError'],
    ['a custom class that sets its name', Object.assign(new Error('x'), { name: 'TimeoutError' }), 'TimeoutError'],
  ])('records %s by class only', (_label, error, errorClass) => {
    expect(errorRecord(error)).toEqual({ level: 'error', event: 'update.failed', errorClass });
  });

  it.each([
    ['a string', 'https://example.org/thrown'],
    ['a number', 424242001],
    ['an object with a message', { message: 'x', name: 'AppError' }],
    ['null', null],
    ['undefined', undefined],
  ])('records a thrown %s as NonError', (_label, thrown) => {
    expect(errorRecord(thrown)).toEqual({ level: 'error', event: 'update.failed', errorClass: 'NonError' });
  });

  it('drops a class name outside the identifier shape', () => {
    const error = Object.assign(new Error('x'), { name: 'Error at https://example.org/' });
    expect(errorRecord(error).errorClass).toBe(DROPPED);
  });

  it("keeps the caller's fields beside the error's, and the error's win a clash", () => {
    expect(errorRecord(new TypeError('x'), { reportId: REPORT_ID, errorClass: 'Forged' })).toEqual({
      level: 'error',
      event: 'update.failed',
      errorClass: 'TypeError',
      reportId: REPORT_ID,
    });
  });
});

describe('the compile-time allow-list', () => {
  it('rejects an unknown event, an unknown field or a value of the wrong type', () => {
    const { logger } = recordingLogger();
    // @ts-expect-error: not in LOG_EVENTS
    logger.log('no.such.event');
    // @ts-expect-error: not an allow-listed field
    logger.log('update.failed', { chatId: 1 });
    // @ts-expect-error: a report id is a string
    logger.log('update.failed', { reportId: 1 });
    // @ts-expect-error: a count is a number
    logger.log('update.failed', { sent: '35' });
    // @ts-expect-error: not in API_METHODS
    logger.log('update.failed', { apiMethod: 'sendPhoto' });
    // @ts-expect-error: not a catalog code
    logger.logError('update.failed', new Error('x'), { errorCode: 'NO_SUCH_CODE' });
  });
});

describe('the console sink', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes info lines with console.log and error lines with console.error, and nothing else', () => {
    const writes = {
      log: vi.spyOn(console, 'log').mockImplementation(() => undefined),
      error: vi.spyOn(console, 'error').mockImplementation(() => undefined),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      info: vi.spyOn(console, 'info').mockImplementation(() => undefined),
      debug: vi.spyOn(console, 'debug').mockImplementation(() => undefined),
    };
    consoleLogger.log('update.failed', { count: 1 });
    consoleLogger.logError('update.failed', new TypeError('x'));
    expect(writes.log).toHaveBeenCalledExactlyOnceWith('{"level":"info","event":"update.failed","count":1}');
    expect(writes.error).toHaveBeenCalledExactlyOnceWith(
      '{"level":"error","event":"update.failed","errorClass":"TypeError"}',
    );
    for (const spy of [writes.warn, writes.info, writes.debug]) expect(spy).not.toHaveBeenCalled();
  });
});

// Always-run invariant spec, critical invariant 6: secrets and personal data
// never reach a log line, the platform's invocation logs included. The
// redacting logger (src/privacy/logger.ts) is driven through the instance
// the application uses, consoleLogger, and everything written to the
// console is captured:
// - an error is logged by class only: a real GrammyError whose payload
//   carries a reported URL, a comment and a chat id, and a real HttpError
//   whose cause carries the token URL, leave none of them in the output;
// - no Telegram id of anyone, an admin's included, gets through, whether it
//   is passed as a number or as a string, in any field: a count or a
//   duration of 10000 or more is logged only coarsened ("420M"), never as
//   its digits;
// - the logger is the only code in src/ that touches the console.
// The commit gate runs this file on every commit (`npm run test:invariants`).
import { GrammyError, HttpError } from 'grammy';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/errors/app-error';
import { consoleLogger, DROPPED, type LogFields } from '../../src/privacy/logger';

// Distinctive fixture values. None is secret-shaped in this source (the
// commit gate's secret-shape scan reads test files too): the token and the
// token URL are assembled at run time.
const ADMIN_ID = 424242001;
const SUBSCRIBER_CHAT_ID = 424242010;
const GROUP_CHAT_ID = -100424242011;
const REPORTED_URL = 'https://www.instagram.com/invariant.reported.account/';
const COMMENT = 'invariant reporter comment text';
const BOT_TOKEN = ['123456789', 'A'.repeat(35)].join(':');
const TOKEN_URL = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

const CONSOLE_METHODS = ['log', 'error', 'warn', 'info', 'debug', 'trace'] as const;

/** Everything written to the console while `act` runs, one line per call. */
const consoleOutput = (act: () => void): string => {
  const written: string[] = [];
  const capture = (...args: unknown[]): void => {
    written.push(args.map((arg) => (typeof arg === 'string' ? arg : inspect(arg))).join(' '));
  };
  const spies = CONSOLE_METHODS.map((method) =>
    vi.spyOn(console, method).mockImplementation(capture),
  );
  try {
    act();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  return written.join('\n');
};

const expectNoneOf = (output: string, values: readonly (string | number)[]): void => {
  for (const value of values) expect(output).not.toContain(String(value));
};

describe('critical invariant 6: an error is logged by class, never by content', () => {
  it('a GrammyError whose payload carries a reported URL, a comment and a chat id', () => {
    const error = new GrammyError(
      "Call to 'sendMessage' failed!",
      { ok: false, error_code: 400, description: 'Bad Request: chat not found' },
      'sendMessage',
      {
        chat_id: SUBSCRIBER_CHAT_ID,
        text: `Report this account: ${REPORTED_URL}\n${COMMENT}`,
        link_preview_options: { is_disabled: true },
      },
    );
    const output = consoleOutput(() => {
      consoleLogger.logError('update.failed', error);
    });
    expect(output).toBe(
      '{"level":"error","event":"update.failed","errorClass":"GrammyError","telegramErrorCode":400,"apiMethod":"sendMessage"}',
    );
    expectNoneOf(output, [REPORTED_URL, 'instagram', COMMENT, SUBSCRIBER_CHAT_ID, 'chat not found']);
  });

  it("a GrammyError whose payload carries an admin's id and the membership chat's", () => {
    const error = new GrammyError(
      "Call to 'getChatMember' failed!",
      { ok: false, error_code: 400, description: 'Bad Request: member not found' },
      'getChatMember',
      { chat_id: GROUP_CHAT_ID, user_id: ADMIN_ID },
    );
    const output = consoleOutput(() => {
      consoleLogger.logError('update.failed', error);
    });
    expect(output).toContain('"apiMethod":"getChatMember"');
    expectNoneOf(output, [ADMIN_ID, GROUP_CHAT_ID, '424242', 'member not found']);
  });

  it('an HttpError whose cause carries the token URL, bare and wrapped in an AppError', () => {
    const cause = new Error(`request to ${TOKEN_URL} failed, reason: connect ECONNREFUSED`);
    const error = new HttpError(`Network request for 'sendMessage' failed! ${cause.message}`, cause);
    const wrapped = new AppError('TELEGRAM_TRANSIENT', 'sendMessage failed on the network', {
      cause: error,
    });
    const output = consoleOutput(() => {
      consoleLogger.logError('update.failed', error);
      consoleLogger.logError('update.failed', wrapped);
    });
    expect(output).toBe(
      [
        '{"level":"error","event":"update.failed","errorClass":"HttpError"}',
        '{"level":"error","event":"update.failed","errorClass":"AppError","errorCode":"TELEGRAM_TRANSIENT"}',
      ].join('\n'),
    );
    expectNoneOf(output, [BOT_TOKEN, TOKEN_URL, 'api.telegram.org', '123456789', 'ECONNREFUSED']);
  });
});

describe("critical invariant 6: no Telegram id reaches a log line, an admin's included", () => {
  it('an admin id passed as a number, in every numeric field', () => {
    const fields = {
      telegramErrorCode: ADMIN_ID,
      durationMs: ADMIN_ID,
      count: ADMIN_ID,
      sent: ADMIN_ID,
      failed: ADMIN_ID,
      attempts: ADMIN_ID,
    } satisfies LogFields;
    const output = consoleOutput(() => {
      consoleLogger.log('update.failed', fields);
      consoleLogger.logError('update.failed', new TypeError('x'), fields);
    });
    expect(output).toContain(`"telegramErrorCode":"${DROPPED}"`);
    expect(output).toContain('"durationMs":"420M"');
    const fraction = consoleOutput(() => {
      consoleLogger.log('update.failed', { durationMs: 0.424242001 });
    });
    expect(fraction).toBe('{"level":"info","event":"update.failed","durationMs":0}');
    expect(output).toContain('"count":"420M"');
    expectNoneOf(output, [ADMIN_ID, '424242']);
  });

  it('a count equal to an admin id logs as the coarse string, never the digits', () => {
    const output = consoleOutput(() => {
      consoleLogger.log('update.failed', { sent: ADMIN_ID });
    });
    expect(output).toBe('{"level":"info","event":"update.failed","sent":"420M"}');
    expectNoneOf(output, [ADMIN_ID, '424242']);
  });

  it('a large count operations needs keeps its magnitude, coarsened', () => {
    const output = consoleOutput(() => {
      consoleLogger.log('update.failed', { sent: 50_000, failed: 1_234, durationMs: 3_600_000 });
    });
    expect(output).toBe(
      '{"level":"info","event":"update.failed","durationMs":"3.6M","sent":"50k","failed":1234}',
    );
  });

  it("a group chat id passed as a count, being negative, is dropped", () => {
    const output = consoleOutput(() => {
      consoleLogger.log('update.failed', { count: GROUP_CHAT_ID });
    });
    expect(output).toBe(`{"level":"info","event":"update.failed","count":"${DROPPED}"}`);
    expectNoneOf(output, [GROUP_CHAT_ID, '424242']);
  });

  it('an admin id passed as a string, in every string field, alone or embedded', () => {
    const output = consoleOutput(() => {
      for (const value of [String(ADMIN_ID), `rpt-${ADMIN_ID}`, String(GROUP_CHAT_ID)]) {
        consoleLogger.log('update.failed', { reportId: value });
        consoleLogger.log('update.failed', { errorClass: `E${value.replace('-', '_')}` });
      }
    });
    expect(output).toContain(`"reportId":"${DROPPED}"`);
    expectNoneOf(output, [ADMIN_ID, GROUP_CHAT_ID, '424242']);
  });

  it('an admin id in a field of the wrong kind, or under a name the allow-list lacks (past the types)', () => {
    const output = consoleOutput(() => {
      consoleLogger.log('update.failed', { reportId: ADMIN_ID } as unknown as LogFields);
      consoleLogger.log('update.failed', { count: String(ADMIN_ID) } as unknown as LogFields);
      consoleLogger.log('update.failed', { adminId: ADMIN_ID } as unknown as LogFields);
      // A computed key type-checks as LogFields without a cast: only the
      // runtime rule (unknown names are left out) stops this one.
      consoleLogger.log('update.failed', { [String(ADMIN_ID)]: 1 });
    });
    expect(output).toContain('"unknownFields":1');
    expectNoneOf(output, [ADMIN_ID, '424242', 'adminId']);
  });

  it('an admin id carried by an error: in its message, its name or its cause', () => {
    const output = consoleOutput(() => {
      consoleLogger.logError('update.failed', new Error(`admin ${ADMIN_ID} pressed Approve`));
      consoleLogger.logError('update.failed', Object.assign(new Error('x'), { name: `E${ADMIN_ID}` }));
      consoleLogger.logError(
        'update.failed',
        new AppError('UNAUTHORIZED', 'not on the allowlist', { cause: { from: ADMIN_ID } }),
      );
    });
    expect(output).toContain('"errorClass":"Error"');
    expectNoneOf(output, [ADMIN_ID, '424242', 'pressed Approve']);
  });
});

describe('critical invariant 6: the logger is the only code in src/ that touches the console', () => {
  // `.href`: the Workers and Node type packages both declare URL.
  const SRC = fileURLToPath(new URL('../../src', import.meta.url).href);
  const LOGGER = 'privacy/logger.ts';
  /** A reference to the console identifier, comments aside. */
  const CONSOLE = /\bconsole\b/;
  const withoutComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
    });

  it('finds no console reference outside src/privacy/logger.ts', () => {
    const offenders = sourceFiles(SRC)
      .map((path) => relative(SRC, path).split('\\').join('/'))
      .filter((path) => path !== LOGGER)
      .filter((path) => CONSOLE.test(withoutComments(readFileSync(join(SRC, path), 'utf8'))));
    expect(offenders).toEqual([]);
  });

  it('sees the logger itself, so the scan is not vacuous', () => {
    expect(sourceFiles(SRC).length).toBeGreaterThan(1);
    expect(CONSOLE.test(withoutComments(readFileSync(join(SRC, LOGGER), 'utf8')))).toBe(true);
  });
});

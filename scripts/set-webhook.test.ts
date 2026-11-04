// Unit tests for the webhook registration script (scripts/set-webhook.ts;
// critical invariants 2 and 6), over the fake Bot API, which records each
// call's exact payload and keeps the webhook as Telegram does; the script is
// never run against Telegram:
// - rule 2: setWebhook registers the Worker's origin plus
//   WEBHOOK_PATH_SEGMENT with exactly the deployment's parameters
//   (`secret_token` = WEBHOOK_SECRET, `allowed_updates` message and
//   callback_query only, the Node port's own, `max_connections` 10,
//   `drop_pending_updates` true); --delete calls deleteWebhook with exactly
//   `drop_pending_updates` false; anything but one https origin or --delete
//   is refused before any call;
// - rule 6: what it prints is the getWebhookInfo answer with the URL's path
//   masked and every other string scrubbed, never the token, the secret
//   token or the path segment; a configuration that does not load (DEBUG
//   and NODE_DEBUG included), wrong arguments and a failed call are each
//   ONE class-only line, exit code 1, nothing printed;
// - the entry, in a child process as `npm run set-webhook` runs it: without
//   an environment it fails fast, exit code 1, one class-only line; and its
//   import graph holds none of the Node port (no node:sqlite, whose notice
//   Node 22 would print, no runner).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { WebhookInfo } from 'grammy/types';
import { afterEach, describe, expect, it } from 'vitest';
import { ALLOWED_UPDATES as POLLED_UPDATES } from '../src/telegram/polling';
import { FAILURES, fakeBotApi, type FakeBotApi } from '../test/fakes/bot-api';
import { recordingLogger, type RecordingLogger } from '../test/fakes/logger';
import { importGraph, NODE_PORT_FILES } from '../test/support/module-graph';
import { TEST_VARIABLES } from '../test/support/variables';
import {
  ALLOWED_UPDATES,
  DELETE_OPTIONS,
  isScriptEntry,
  maskUrl,
  MASKS,
  MAX_CONNECTIONS,
  parseArguments,
  printedInfo,
  runSetWebhook,
  scrub,
} from './set-webhook';

// `.href`: the Workers and Node type packages both declare URL.
const SCRIPT = fileURLToPath(new URL('./set-webhook.ts', import.meta.url).href);
const HOOKS = fileURLToPath(new URL('../src/node-hooks.ts', import.meta.url).href);

const ORIGIN = 'https://div-report.unit-test.workers.dev';
const SEGMENT = TEST_VARIABLES.WEBHOOK_PATH_SEGMENT;
const SECRETS = {
  botToken: TEST_VARIABLES.BOT_TOKEN,
  webhookSecret: TEST_VARIABLES.WEBHOOK_SECRET,
  webhookPathSegment: SEGMENT,
} as const;
/** The values nothing the script prints or logs may hold. */
const NEVER_SHOWN = [TEST_VARIABLES.BOT_TOKEN, TEST_VARIABLES.WEBHOOK_SECRET, SEGMENT];

/** Temporary directories, removed after each test. */
const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Run {
  readonly code: number;
  readonly telegram: FakeBotApi;
  readonly log: RecordingLogger;
  /** Everything the script printed. */
  readonly output: string;
}

/** Runs the script in-process over the fake Bot API, with the test deployment's variables unless given others. */
const run = async (
  args: readonly string[],
  options: { readonly env?: object; readonly telegram?: FakeBotApi } = {},
): Promise<Run> => {
  const telegram = options.telegram ?? fakeBotApi();
  const log = recordingLogger();
  let output = '';
  const code = await runSetWebhook({
    args,
    env: options.env ?? { ...TEST_VARIABLES },
    fetch: telegram.fetch,
    logger: log.logger,
    write: (text) => {
      output += text;
    },
  });
  return { code, telegram, log, output };
};

const expectNothingSecret = (text: string): void => {
  for (const value of NEVER_SHOWN) expect(text).not.toContain(value);
};

describe('critical invariant 2: the webhook is registered with exactly the deployment\'s parameters', () => {
  it('registers the origin plus WEBHOOK_PATH_SEGMENT with the secret token, message and callback_query only, 10 connections and the pending updates dropped, then reads the webhook back', async () => {
    const { code, telegram, log } = await run([ORIGIN]);
    expect(code).toBe(0);
    expect(telegram.calls.map((call) => call.method)).toEqual(['setWebhook', 'getWebhookInfo']);
    expect(telegram.callsOf('setWebhook')[0]?.payload).toEqual({
      url: `${ORIGIN}/${SEGMENT}`,
      secret_token: TEST_VARIABLES.WEBHOOK_SECRET,
      allowed_updates: ['message', 'callback_query'],
      max_connections: 10,
      drop_pending_updates: true,
    });
    expect(telegram.callsOf('getWebhookInfo')[0]?.payload).toEqual({});
    expect(telegram.foreignRequests).toEqual([]);
    expect(log.lines).toEqual([]);
  });

  it('asks for the update kinds the Node port polls for, and keeps the connections at 10', () => {
    expect([...ALLOWED_UPDATES]).toEqual([...POLLED_UPDATES]);
    expect(MAX_CONNECTIONS).toBe(10);
  });

  it('with --delete, calls deleteWebhook with exactly drop_pending_updates false, and nothing else', async () => {
    const telegram = fakeBotApi();
    await run([ORIGIN], { telegram });
    const { code, log, output } = await run(['--delete'], { telegram });
    expect(code).toBe(0);
    expect(telegram.calls.map((call) => call.method)).toEqual(['setWebhook', 'getWebhookInfo', 'deleteWebhook', 'getWebhookInfo']);
    expect(telegram.callsOf('deleteWebhook')[0]?.payload).toEqual({ drop_pending_updates: false });
    expect(DELETE_OPTIONS).toEqual({ drop_pending_updates: false });
    expect(JSON.parse(output)).toEqual({ url: '', has_custom_certificate: false, pending_update_count: 0 });
    expect(log.lines).toEqual([]);
  });

  it('takes the origin of an https URL that is an origin and nothing more', () => {
    expect(parseArguments([ORIGIN])).toEqual({ mode: 'set', origin: ORIGIN });
    expect(parseArguments([`${ORIGIN}/`])).toEqual({ mode: 'set', origin: ORIGIN });
    expect(parseArguments(['https://DIV-REPORT.Unit-Test.workers.dev'])).toEqual({ mode: 'set', origin: ORIGIN });
    expect(parseArguments(['--delete'])).toEqual({ mode: 'delete' });
  });

  it.each([
    ['no argument', []],
    ['two origins', [ORIGIN, ORIGIN]],
    ['an origin and --delete', [ORIGIN, '--delete']],
    ['an unknown flag', ['--remove']],
    ['plain http', ['http://div-report.unit-test.workers.dev']],
    ['no scheme', ['div-report.unit-test.workers.dev']],
    ['the whole webhook URL, its segment included', [`${ORIGIN}/${SEGMENT}`]],
    ['a path', [`${ORIGIN}/bot`]],
    ['a query', [`${ORIGIN}/?segment=${SEGMENT}`]],
    ['a fragment', [`${ORIGIN}/#${SEGMENT}`]],
    ['userinfo', [`https://${SEGMENT}@div-report.unit-test.workers.dev`]],
    ['a port', ['https://div-report.unit-test.workers.dev:8443']],
  ])('refuses %s before any call: one class-only line, never the argument, nothing printed', async (_name, args) => {
    const { code, telegram, log, output } = await run(args);
    expect(code).toBe(1);
    expect(telegram.calls).toEqual([]);
    expect(output).toBe('');
    expect(log.records()).toEqual([{ level: 'error', event: 'webhook.usage', errorClass: 'AppError', errorCode: 'INVALID_INPUT' }]);
    expect(log.text()).not.toContain('unit-test.workers.dev');
    expectNothingSecret(log.text());
  });
});

describe('critical invariant 6: the script prints the webhook without its secret segment, and fails by class only', () => {
  it('prints the getWebhookInfo answer as JSON, the path masked, and nothing else', async () => {
    const { output, log } = await run([ORIGIN]);
    expect(JSON.parse(output)).toEqual({
      url: `${ORIGIN}/${MASKS.segment}`,
      has_custom_certificate: false,
      pending_update_count: 0,
      max_connections: 10,
      allowed_updates: ['message', 'callback_query'],
    });
    expect(output.endsWith('\n')).toBe(true);
    expectNothingSecret(output);
    expect(log.lines).toEqual([]);
  });

  it('scrubs the token, the secret token and the segment out of every other string Telegram answers', async () => {
    const telegram = fakeBotApi();
    telegram.setWebhookInfo({
      ip_address: '203.0.113.7',
      last_error_date: 1_900_000_000,
      last_error_message: `Wrong response from the webhook ${ORIGIN}/${SEGMENT}: 404 Not Found (${TEST_VARIABLES.WEBHOOK_SECRET} ${TEST_VARIABLES.BOT_TOKEN})`,
      last_synchronization_error_date: 1_900_000_100,
    });
    const { output } = await run([ORIGIN], { telegram });
    expect(JSON.parse(output)).toEqual({
      url: `${ORIGIN}/${MASKS.segment}`,
      has_custom_certificate: false,
      pending_update_count: 0,
      max_connections: 10,
      allowed_updates: ['message', 'callback_query'],
      ip_address: '203.0.113.7',
      last_error_date: 1_900_000_000,
      last_error_message: `Wrong response from the webhook ${ORIGIN}/${MASKS.scrubbed}: 404 Not Found (${MASKS.scrubbed} ${MASKS.scrubbed})`,
      last_synchronization_error_date: 1_900_000_100,
    });
    expectNothingSecret(output);
  });

  it('masks the path of a URL whatever it holds, never showing it', () => {
    expect(maskUrl('', SEGMENT)).toBe('');
    expect(maskUrl(`${ORIGIN}/${SEGMENT}`, SEGMENT)).toBe(`${ORIGIN}/${MASKS.segment}`);
    expect(maskUrl(`${ORIGIN}/an-older-segment`, SEGMENT)).toBe(`${ORIGIN}/${MASKS.otherPath}`);
    expect(maskUrl(`${ORIGIN}/${SEGMENT}?x=1`, SEGMENT)).toBe(`${ORIGIN}/${MASKS.otherPath}`);
    expect(maskUrl(`${ORIGIN}/${SEGMENT}/deeper`, SEGMENT)).toBe(`${ORIGIN}/${MASKS.otherPath}`);
    expect(maskUrl(`https://user:${TEST_VARIABLES.WEBHOOK_SECRET}@div-report.unit-test.workers.dev/${SEGMENT}`, SEGMENT)).toBe(`${ORIGIN}/${MASKS.segment}`);
    expect(maskUrl(`not a URL ${SEGMENT}`, SEGMENT)).toBe(MASKS.unreadable);
    expect(scrub(`a ${SEGMENT} b ${SEGMENT}`, SECRETS)).toBe(`a ${MASKS.scrubbed} b ${MASKS.scrubbed}`);
  });

  it('scrubs the segment out of the origin too: as a host label, in any letter case, it prints as <hidden>', async () => {
    const answer = (url: string) => ({ url, has_custom_certificate: false, pending_update_count: 0 });
    expect(printedInfo(answer(`https://${SEGMENT}.unit-test.workers.dev/${SEGMENT}`), SECRETS)).toEqual({
      url: `https://${MASKS.scrubbed}.unit-test.workers.dev/${MASKS.segment}`,
      has_custom_certificate: false,
      pending_update_count: 0,
    });
    // The URL parser lowercases a hostname: a segment with capitals is still found there.
    const mixedCase = { ...SECRETS, webhookPathSegment: 'Unit-Test-Path-Segment' };
    const printed = JSON.stringify(printedInfo(answer('https://Unit-Test-Path-Segment.unit-test.workers.dev/Unit-Test-Path-Segment'), mixedCase));
    expect(printed).toContain(`https://${MASKS.scrubbed}.unit-test.workers.dev/${MASKS.segment}`);
    expect(printed.toLowerCase()).not.toContain('unit-test-path-segment');
    expect(scrub(`A ${SEGMENT.toUpperCase()} b`, SECRETS)).toBe(`A ${MASKS.scrubbed} b`);
    // End to end: a webhook another tool registered with the segment in its host.
    const telegram = fakeBotApi();
    telegram.setWebhookInfo({ url: `https://${SEGMENT}.unit-test.workers.dev/hook` });
    const { output } = await run([ORIGIN], { telegram });
    expect((JSON.parse(output) as { url: string }).url).toBe(`https://${MASKS.scrubbed}.unit-test.workers.dev/${MASKS.otherPath}`);
    expectNothingSecret(output);
  });

  it('prints only the documented fields, each with its documented type', () => {
    const answer = {
      url: `${ORIGIN}/${SEGMENT}`,
      has_custom_certificate: 'yes',
      pending_update_count: TEST_VARIABLES.BOT_TOKEN,
      max_connections: 10,
      allowed_updates: ['message', 7, SEGMENT],
      secret_token: TEST_VARIABLES.WEBHOOK_SECRET,
      certificate: TEST_VARIABLES.BOT_TOKEN,
    } as unknown as WebhookInfo;
    const printed = printedInfo(answer, SECRETS);
    expect(printed).toEqual({ url: `${ORIGIN}/${MASKS.segment}`, max_connections: 10, allowed_updates: ['message', MASKS.scrubbed] });
    expectNothingSecret(JSON.stringify(printed));
  });

  it.each([
    ['setWebhook', 'a 401', FAILURES.unauthorized, [ORIGIN], ['setWebhook'], { errorClass: 'GrammyError', telegramErrorCode: 401 }],
    ['setWebhook', 'a timeout', FAILURES.timeout, [ORIGIN], ['setWebhook'], { errorClass: 'HttpError' }],
    ['deleteWebhook', 'a network failure', FAILURES.networkFailure, ['--delete'], ['deleteWebhook'], { errorClass: 'HttpError' }],
    ['getWebhookInfo', 'a 502', FAILURES.serverError, [ORIGIN], ['setWebhook', 'getWebhookInfo'], { errorClass: 'GrammyError', telegramErrorCode: 502 }],
  ] as const)('a failed %s (%s) is one class-only line naming the method, exit code 1, nothing printed', async (method, _what, failure, args, methods, error) => {
    const telegram = fakeBotApi();
    telegram.fail({ method }, failure);
    const { code, log, output } = await run(args, { telegram });
    expect(code).toBe(1);
    expect(telegram.calls.map((call) => call.method)).toEqual(methods);
    expect(output).toBe('');
    expect(log.records()).toEqual([{ level: 'error', event: 'webhook.failed', ...error, apiMethod: method }]);
    expect(log.text()).not.toContain('unit-test.workers.dev');
    expectNothingSecret(log.text());
  });

  it.each([
    ['an empty environment', {}],
    ['a variable missing', { ...TEST_VARIABLES, WEBHOOK_SECRET: '' }],
    ['DEBUG set', { ...TEST_VARIABLES, DEBUG: 'grammy*' }],
    ['NODE_DEBUG set', { ...TEST_VARIABLES, NODE_DEBUG: 'fetch' }],
    ['NODE_DEBUG_NATIVE set', { ...TEST_VARIABLES, NODE_DEBUG_NATIVE: 'http' }],
  ])('refuses %s before any call: config.invalid by class, no value echoed', async (_name, env) => {
    const { code, telegram, log, output } = await run([ORIGIN], { env });
    expect(code).toBe(1);
    expect(telegram.calls).toEqual([]);
    expect(output).toBe('');
    expect(log.records()).toEqual([{ level: 'error', event: 'config.invalid', errorClass: 'AppError', errorCode: 'CONFIG_INVALID' }]);
    expectNothingSecret(log.text());
  });
});

describe('the entry', () => {
  it('is this module when the process runs this file, and not otherwise', () => {
    const url = pathToFileURL(SCRIPT).href;
    expect(isScriptEntry(SCRIPT, url)).toBe(true);
    expect(isScriptEntry(process.argv[1], url)).toBe(false);
    expect(isScriptEntry(undefined, url)).toBe(false);
    expect(isScriptEntry(join(tmpdir(), 'div-report-no-such-script.ts'), url)).toBe(false);
  });

  it('runs as npm runs it and, without an environment, fails fast: exit code 1, one class-only line, no value echoed', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'div-report-set-webhook-'));
    scratch.push(cwd);
    const result = spawnSync(process.execPath, ['--import', HOOKS, SCRIPT, ORIGIN], {
      cwd,
      encoding: 'utf8',
      timeout: 60_000,
      env: { PATH: process.env.PATH ?? '', WEBHOOK_SECRET: TEST_VARIABLES.WEBHOOK_SECRET, BOT_TOKEN: TEST_VARIABLES.BOT_TOKEN },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    const lines = result.stderr.split('\n').filter((line) => line !== '');
    expect(lines.filter((line) => line.startsWith('{'))).toEqual(['{"level":"error","event":"config.invalid","errorClass":"AppError","errorCode":"CONFIG_INVALID"}']);
    // Anything else is Node's own notice that a feature is experimental, on some Node 22 releases.
    for (const line of lines.filter((entry) => !entry.startsWith('{'))) expect(line).toMatch(/ExperimentalWarning|--trace-warnings/);
    expectNothingSecret(result.stderr);
  });

  it("holds none of the Node port in its import graph: no port file, no node:sqlite, no runner", () => {
    const { files, external } = importGraph('../scripts/set-webhook.ts');
    expect(files).toEqual(expect.arrayContaining(['../scripts/set-webhook.ts', 'config/memo.ts', 'telegram/api.ts', 'privacy/logger.ts']));
    expect(files.filter((file) => NODE_PORT_FILES.includes(file))).toEqual([]);
    expect(external).not.toContain('node:sqlite');
    expect(external).not.toContain('@grammyjs/runner');
  });
});

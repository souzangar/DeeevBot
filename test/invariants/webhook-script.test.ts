// Always-run invariant spec, critical invariant 6, for the webhook
// registration script (scripts/set-webhook.ts): it never prints or logs the
// bot token, the webhook's secret token or its path segment. The script runs
// in-process over the fake Bot API with the production logger
// (consoleLogger) and the console captured, so what console.error receives
// is what reaches stderr, and what the script writes is its stdout. Driven
// with the test deployment's values (never secret-shaped):
// - wrong arguments that carry the values (the whole webhook URL with its
//   segment, the segment as userinfo, the token after --delete): ONE
//   class-only `webhook.usage` line;
// - a configuration that does not load while holding the values (DEBUG set
//   to the secret, a handle in ADMIN_IDS, an empty environment): ONE
//   class-only `config.invalid` line;
// - a failed setWebhook, answered with a GrammyError whose description holds
//   the token, the secret token and the segment and whose payload, the
//   request, holds the secret token and the segment; failed by an HttpError
//   wrapping a network error whose message holds all three and the token
//   URL; and a failed deleteWebhook and getWebhookInfo alike: ONE class-only
//   `webhook.failed` line each;
// each with exit code 1, nothing on stdout and no fixture value on either
// stream; and a registration that succeeds prints nothing on stderr and none
// of the values on stdout.
// The commit gate runs this file on every commit (`npm run test:invariants`).
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { runSetWebhook } from '../../scripts/set-webhook';
import { consoleLogger } from '../../src/privacy/logger';
import { fakeBotApi, type FakeBotApi, type FakeOutcome } from '../fakes/bot-api';
import { TEST_VARIABLES } from '../support/variables';

const TOKEN = TEST_VARIABLES.BOT_TOKEN;
const SECRET = TEST_VARIABLES.WEBHOOK_SECRET;
const SEGMENT = TEST_VARIABLES.WEBHOOK_PATH_SEGMENT;
const ORIGIN = 'https://div-report.unit-test.workers.dev';

/** What neither stream may ever hold. */
const NEVER: readonly string[] = [TOKEN, SECRET, SEGMENT, 'bad webhook', 'fetch failed', 'api.telegram.org'];

/** A GrammyError's answer that holds every value: the payload it carries holds the secret and the segment by itself. */
const REFUSED: FakeOutcome = { kind: 'error', errorCode: 400, description: `Bad Request: bad webhook: ${TOKEN} ${SECRET} ${SEGMENT}` };

let errors: MockInstance<typeof console.error>;
let infos: MockInstance<typeof console.log>;
beforeEach(() => {
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  infos = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** A fetch that fails `method` as a refused or lost connection does, its error naming every value, and passes the rest to the fake. */
const losing =
  (telegram: FakeBotApi, method: string): typeof fetch =>
  (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith(`/${method}`)) return Promise.reject(new TypeError(`fetch failed: ${url} ${SECRET} ${SEGMENT}`));
    return telegram.fetch(input, init);
  };

/** Runs the script with the production logger; returns its exit code and both streams. */
const runScript = async (
  args: readonly string[],
  options: { readonly env?: object; readonly fetch?: typeof fetch } = {},
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string[] }> => {
  let stdout = '';
  const code = await runSetWebhook({
    args,
    env: options.env ?? { ...TEST_VARIABLES },
    fetch: options.fetch ?? fakeBotApi().fetch,
    logger: consoleLogger,
    write: (text) => {
      stdout += text;
    },
  });
  // consoleLogger writes an info line with console.log, which goes to stdout too.
  for (const call of infos.mock.calls) stdout += String(call[0]);
  return { code, stdout, stderr: errors.mock.calls.map((call) => String(call[0])) };
};

const expectNone = (text: string): void => {
  for (const value of NEVER) expect(text, value).not.toContain(value);
};

describe('critical invariant 6: the webhook script never prints or logs the token, the secret token or the segment', () => {
  it.each([
    ['the whole webhook URL', [`${ORIGIN}/${SEGMENT}`]],
    ['the segment as userinfo', [`https://${SEGMENT}:${SECRET}@div-report.unit-test.workers.dev`]],
    ['the token after --delete', ['--delete', TOKEN]],
  ])('wrong arguments (%s): one class-only line, nothing printed', async (_name, args) => {
    const { code, stdout, stderr } = await runScript(args);
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toEqual(['{"level":"error","event":"webhook.usage","errorClass":"AppError","errorCode":"INVALID_INPUT"}']);
    expectNone(stderr.join('\n'));
  });

  it.each([
    ['DEBUG set to the secret', { ...TEST_VARIABLES, DEBUG: SECRET }],
    ['a handle in ADMIN_IDS', { ...TEST_VARIABLES, ADMIN_IDS: `@${SEGMENT}` }],
    ['an empty environment', {}],
  ])('a configuration that does not load (%s): one class-only line, nothing printed', async (_name, env) => {
    const { code, stdout, stderr } = await runScript([ORIGIN], { env });
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toEqual(['{"level":"error","event":"config.invalid","errorClass":"AppError","errorCode":"CONFIG_INVALID"}']);
    expectNone(stderr.join('\n'));
  });

  it.each(['setWebhook', 'deleteWebhook', 'getWebhookInfo'])('a %s refused with every value in its GrammyError: one class-only line, nothing printed', async (method) => {
    const telegram = fakeBotApi();
    telegram.fail({ method }, REFUSED);
    const { code, stdout, stderr } = await runScript(method === 'deleteWebhook' ? ['--delete'] : [ORIGIN], { fetch: telegram.fetch });
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr.map((line) => JSON.parse(line) as unknown)).toEqual([
      { level: 'error', event: 'webhook.failed', errorClass: 'GrammyError', telegramErrorCode: 400, apiMethod: method },
    ]);
    expectNone(stderr.join('\n'));
    // The fixture is not vacuous: the GrammyError the script met carried the values.
    expect(telegram.callsOf(method)).toHaveLength(1);
    if (method === 'setWebhook') expect(JSON.stringify(telegram.callsOf(method)[0]?.payload)).toContain(SECRET);
  });

  it.each(['setWebhook', 'deleteWebhook', 'getWebhookInfo'])('a %s lost with every value in its HttpError: one class-only line, nothing printed', async (method) => {
    const telegram = fakeBotApi();
    const { code, stdout, stderr } = await runScript(method === 'deleteWebhook' ? ['--delete'] : [ORIGIN], { fetch: losing(telegram, method) });
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr.map((line) => JSON.parse(line) as unknown)).toEqual([{ level: 'error', event: 'webhook.failed', errorClass: 'HttpError', apiMethod: method }]);
    expectNone(stderr.join('\n'));
  });

  it('a registration that succeeds: nothing on stderr, and none of the values in what it prints', async () => {
    const { code, stdout, stderr } = await runScript([ORIGIN]);
    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toContain('div-report.unit-test.workers.dev/<WEBHOOK_PATH_SEGMENT>');
    for (const value of [TOKEN, SECRET, SEGMENT]) expect(stdout, value).not.toContain(value);
  });
});

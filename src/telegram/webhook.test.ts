// Unit tests for the webhook boundary (src/telegram/webhook.ts; critical
// invariant 2): an off-path request and a wrong or missing secret are
// answered 404 with an empty body before the body is read, before any bot
// object exists and before any Bot API call; the compare is node:crypto's
// timingSafeEqual over SHA-256 digests, equal-length wrong secrets
// included; a correct request is answered 200 while its handler still runs
// under waitUntil; a failing handler costs one class-only log line. The
// Worker's own boundary runs the same cases in the Workers runtime
// (test/workers/webhook.test.ts); the always-run pin is
// test/invariants/webhook-authenticity.test.ts.
import { timingSafeEqual } from 'node:crypto';
import { BotError, type Context } from 'grammy';
import type { Update } from 'grammy/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FAILURES } from '../../test/fakes/bot-api';
import { recordingLogger } from '../../test/fakes/logger';
import { botHarness } from '../../test/support/bot-harness';
import { IDS, testConfig } from '../../test/support/config';
import { privateMessage } from '../../test/support/updates';
import { handleWebhook, onWebhookPath, SECRET_HEADER, secretMatches, type UpdateHandler } from './webhook';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const config = testConfig();
const ORIGIN = 'https://div-report.test';
const PATH = `${ORIGIN}/${config.webhookPathSegment}`;
const UPDATE = privateMessage(IDS.reporter, 'https://www.instagram.com/reported.account/');

afterEach(() => {
  vi.mocked(timingSafeEqual).mockClear();
});

/** A request that records every property read on it, and throws if its body is touched. */
const guardedRequest = (url: string, init: { method?: string; secret?: string | null } = {}) => {
  const touched: string[] = [];
  const headers = new Headers(init.secret === undefined || init.secret === null ? {} : { [SECRET_HEADER]: init.secret });
  const target = { method: init.method ?? 'POST', url, headers };
  const request = new Proxy(target, {
    get: (object, property) => {
      touched.push(String(property));
      if (property in object) return object[property as keyof typeof object];
      throw new Error(`the body was touched: ${String(property)}`);
    },
  }) as unknown as Request;
  return { request, touched };
};

const post = (body: unknown, secret: string | null = config.webhookSecret, url = PATH): Request =>
  new Request(url, {
    method: 'POST',
    headers: secret === null ? {} : { [SECRET_HEADER]: secret },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

/** The boundary's dependencies, with a bot factory that counts its calls. */
const deps = (bot: () => UpdateHandler = () => ({ handleUpdate: () => Promise.resolve() })) => {
  const log = recordingLogger();
  const factory = vi.fn(bot);
  const waited: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => void waited.push(promise) };
  return { log, factory, waited, ctx, deps: { config, logger: log.logger, bot: factory } };
};

describe('rejection before anything else', () => {
  it.each([
    ['another path', `${ORIGIN}/webhook`, 'POST', config.webhookSecret],
    ['the root', `${ORIGIN}/`, 'POST', config.webhookSecret],
    ['the path with a trailing slash', `${PATH}/`, 'POST', config.webhookSecret],
    ['a longer path', `${PATH}/extra`, 'POST', config.webhookSecret],
    ['a GET on the path', PATH, 'GET', config.webhookSecret],
    ['a PUT on the path', PATH, 'PUT', config.webhookSecret],
    ['no secret header', PATH, 'POST', null],
    ['an empty secret header', PATH, 'POST', ''],
    ['a wrong secret of the same length', PATH, 'POST', 'X'.repeat(config.webhookSecret.length)],
    ['the secret with one character changed', PATH, 'POST', `${config.webhookSecret.slice(0, -1)}X`],
    ['a prefix of the secret', PATH, 'POST', config.webhookSecret.slice(0, 5)],
    ['the secret with more after it', PATH, 'POST', `${config.webhookSecret}-and-more`],
    ['the secret in another case', PATH, 'POST', config.webhookSecret.toUpperCase()],
  ])('%s: 404, empty body, no body read, no bot, no Bot API call', async (_label, url, method, secret) => {
    const bot = botHarness();
    const { request, touched } = guardedRequest(url, { method, secret });
    const boundary = deps(() => bot.bot);
    const response = await handleWebhook(request, boundary.ctx, boundary.deps);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
    expect(touched.filter((key) => !['method', 'url', 'headers'].includes(key))).toEqual([]);
    expect(boundary.factory).not.toHaveBeenCalled();
    expect(boundary.waited).toEqual([]);
    expect(bot.telegram.calls).toEqual([]);
    expect(boundary.log.lines).toEqual([]);
  });

  it('checks the path before the secret: an off-path request never reaches the compare', async () => {
    const { request } = guardedRequest(`${ORIGIN}/elsewhere`, { secret: config.webhookSecret });
    const harness = deps();
    await handleWebhook(request, harness.ctx, harness.deps);
    expect(timingSafeEqual).not.toHaveBeenCalled();
  });
});

describe('the secret compare', () => {
  it('is timingSafeEqual over two 32-byte SHA-256 digests, whatever the header length', () => {
    const headers = [
      null,
      '',
      'X'.repeat(config.webhookSecret.length),
      config.webhookSecret.slice(0, 3),
      'x'.repeat(256),
      config.webhookSecret,
    ];
    for (const header of headers) secretMatches(header, config.webhookSecret);
    const calls = vi.mocked(timingSafeEqual).mock.calls;
    expect(calls).toHaveLength(headers.length);
    for (const [left, right] of calls) {
      expect((left as Buffer).byteLength).toBe(32);
      expect((right as Buffer).byteLength).toBe(32);
    }
  });

  it('matches the configured secret and nothing else', () => {
    expect(secretMatches(config.webhookSecret, config.webhookSecret)).toBe(true);
    expect(secretMatches('X'.repeat(config.webhookSecret.length), config.webhookSecret)).toBe(false);
    expect(secretMatches(null, config.webhookSecret)).toBe(false);
    expect(secretMatches(` ${config.webhookSecret}`, config.webhookSecret)).toBe(false);
  });

  it('is applied to every request that reaches the path', async () => {
    const harness = deps();
    await handleWebhook(post(UPDATE, 'wrong-secret-value'), harness.ctx, harness.deps);
    await handleWebhook(post(UPDATE), harness.ctx, harness.deps);
    expect(timingSafeEqual).toHaveBeenCalledTimes(2);
  });
});

describe('onWebhookPath', () => {
  it('is a POST to exactly the segment; a URL that does not parse is not', () => {
    expect(onWebhookPath(new Request(PATH, { method: 'POST' }), config.webhookPathSegment)).toBe(true);
    expect(onWebhookPath(new Request(`${PATH}?x=1`, { method: 'POST' }), config.webhookPathSegment)).toBe(true);
    expect(onWebhookPath({ method: 'POST', url: 'not a url' } as Request, config.webhookPathSegment)).toBe(false);
  });
});

describe('an authentic request', () => {
  it('is answered 200 while its handler is still running, its promise handed to waitUntil', async () => {
    const harness = botHarness();
    harness.telegram.fail({ method: 'sendMessage' }, FAILURES.hang);
    const boundary = deps(() => harness.bot);
    const response = await handleWebhook(post(privateMessage(IDS.reporter, '/start')), boundary.ctx, boundary.deps);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(boundary.factory).toHaveBeenCalledTimes(1);
    expect(boundary.waited).toHaveLength(1);
    const settled = await Promise.race([
      boundary.waited[0]?.then(() => 'settled'),
      new Promise((resolve) => setTimeout(() => resolve('still running'), 25)),
    ]);
    expect(settled).toBe('still running');
    expect(harness.telegram.hanging()).toBe(1);
  });

  it('hands the parsed update to the bot', async () => {
    const received: Update[] = [];
    const boundary = deps(() => ({
      handleUpdate: (update) => {
        received.push(update);
        return Promise.resolve();
      },
    }));
    await handleWebhook(post(UPDATE), boundary.ctx, boundary.deps);
    await Promise.all(boundary.waited);
    expect(received).toEqual([UPDATE]);
  });

  it('is answered 200 when the handler throws, with one log line naming the class only', async () => {
    const boundary = deps(() => ({
      handleUpdate: () => Promise.reject(new TypeError(`chat ${IDS.reporter}: https://www.instagram.com/reported.account/`)),
    }));
    const response = await handleWebhook(post(UPDATE), boundary.ctx, boundary.deps);
    await Promise.all(boundary.waited);
    expect(response.status).toBe(200);
    expect(boundary.log.lines).toEqual([
      { level: 'error', line: '{"level":"error","event":"update.failed","errorClass":"TypeError"}' },
    ]);
  });

  it('logs the error inside a BotError, never the context around it', async () => {
    const boundary = deps(() => ({
      handleUpdate: () => Promise.reject(new BotError(new RangeError('x'), {} as Context)),
    }));
    await handleWebhook(post(UPDATE), boundary.ctx, boundary.deps);
    await Promise.all(boundary.waited);
    expect(boundary.log.records()).toEqual([{ level: 'error', event: 'update.failed', errorClass: 'RangeError' }]);
  });

  it('is answered 200 when the bot cannot be built, and logged by class', async () => {
    const boundary = deps(() => {
      throw new Error('cannot build');
    });
    const response = await handleWebhook(post(UPDATE), boundary.ctx, boundary.deps);
    expect(response.status).toBe(200);
    expect(boundary.log.records()).toEqual([{ level: 'error', event: 'update.failed', errorClass: 'Error' }]);
  });
});

describe('an authentic request whose body is not an update', () => {
  it.each([
    ['invalid JSON', '{"update_id": 1,'],
    ['an array', [UPDATE]],
    ['a number', 42],
    ['null', null],
    ['an object without an update_id', { message: UPDATE.message }],
    ['a fractional update_id', { update_id: 1.5 }],
  ])('%s: 200, logged by class, no bot', async (_label, body) => {
    const boundary = deps();
    const response = await handleWebhook(post(body), boundary.ctx, boundary.deps);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(boundary.factory).not.toHaveBeenCalled();
    expect(boundary.log.records()).toEqual([expect.objectContaining({ event: 'update.unreadable' })]);
    expect(boundary.log.text()).not.toContain('instagram');
  });
});

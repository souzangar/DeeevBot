// Always-run invariant spec, critical invariant 2: an update is acted on
// only if it provably came from Telegram. On the webhook transport
// (src/telegram/webhook.ts, wired by src/worker.ts):
// - a request off the webhook's path, or without the configured secret in
//   X-Telegram-Bot-Api-Secret-Token (missing, empty, wrong, wrong with the
//   right length, a prefix, a longer string), is answered 404 with an empty
//   body, and before that answer nothing happens: no body read, no bot
//   built, no Bot API call, no log line;
// - the secret is compared with node:crypto's timingSafeEqual over SHA-256
//   digests, so the compare's time does not depend on how much of the
//   header matches;
// - no configuration loads with a secret shorter than 32 characters, or
//   equal to the path segment, so no deployment runs on a short one or on
//   one its webhook URL shows (a length is no proof of randomness);
// - grammY's webhookCallback, which reads the body itself, is used nowhere
//   in src/.
// The commit gate runs this file on every commit (`npm run test:invariants`).
import { timingSafeEqual } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/errors/app-error';
import { handleWebhook, SECRET_HEADER } from '../../src/telegram/webhook';
import { recordingLogger } from '../fakes/logger';
import { botHarness } from '../support/bot-harness';
import { testConfig } from '../support/config';
import { IDS } from '../support/variables';
import { privateMessage } from '../support/updates';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

afterEach(() => {
  vi.mocked(timingSafeEqual).mockClear();
});

const config = testConfig();
const ORIGIN = 'https://div-report.test';
const PATH = `${ORIGIN}/${config.webhookPathSegment}`;
const SECRET = config.webhookSecret;

/** A request that answers only method, url and headers; anything else is a read of its body, and throws. */
const guarded = (url: string, method: string, secret: string | null) => {
  const reads: string[] = [];
  const target = { method, url, headers: new Headers(secret === null ? {} : { [SECRET_HEADER]: secret }) };
  const request = new Proxy(target, {
    get: (object, property) => {
      if (property in object) return object[property as keyof typeof object];
      reads.push(String(property));
      throw new Error('the body was read');
    },
  }) as unknown as Request;
  return { request, reads };
};

const REJECTED: readonly (readonly [string, string, string, string | null])[] = [
  ['another path', `${ORIGIN}/webhook`, 'POST', SECRET],
  ['the bare origin', `${ORIGIN}/`, 'POST', SECRET],
  ['a path below the segment', `${PATH}/x`, 'POST', SECRET],
  ['a GET on the path', PATH, 'GET', SECRET],
  ['no secret header', PATH, 'POST', null],
  ['an empty secret header', PATH, 'POST', ''],
  ['a wrong secret of the same length', PATH, 'POST', 'y'.repeat(SECRET.length)],
  ['the secret but its last character', PATH, 'POST', `${SECRET.slice(0, -1)}Z`],
  ['a prefix of the secret', PATH, 'POST', SECRET.slice(0, 1)],
  ['the secret and more', PATH, 'POST', `${SECRET}0`],
  // Not here: the secret with spaces around it. HTTP strips the whitespace
  // around a field value (RFC 9110, 5.5), and so does Headers, so it arrives
  // as the secret itself.
];

describe('critical invariant 2: nothing happens for a request that is not authentic', () => {
  it.each(REJECTED)('%s: 404, empty body, no read, no bot, no Bot API call, no log line', async (_label, url, method, secret) => {
    const harness = botHarness();
    const { request, reads } = guarded(url, method, secret);
    const log = recordingLogger();
    const bot = vi.fn(() => harness.bot);
    const waited: unknown[] = [];
    const response = await handleWebhook(request, { waitUntil: (promise) => void waited.push(promise) }, {
      config,
      logger: log.logger,
      bot,
    });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
    expect(reads).toEqual([]);
    expect(bot).not.toHaveBeenCalled();
    expect(waited).toEqual([]);
    expect(harness.telegram.calls).toEqual([]);
    expect(log.lines).toEqual([]);
  });

  it('an authentic request, by contrast, is handed to the bot', async () => {
    const harness = botHarness();
    const waited: Promise<unknown>[] = [];
    const response = await handleWebhook(
      new Request(PATH, {
        method: 'POST',
        headers: { [SECRET_HEADER]: SECRET },
        body: JSON.stringify(privateMessage(IDS.reporter, '/start')),
      }),
      { waitUntil: (promise) => void waited.push(promise) },
      { config, logger: recordingLogger().logger, bot: () => harness.bot },
    );
    await Promise.all(waited);
    expect(response.status).toBe(200);
    expect(harness.telegram.count('sendMessage')).toBe(1);
  });
});

describe('critical invariant 2: the secret compare takes constant time', () => {
  it('is timingSafeEqual over two 32-byte digests, for every header on the path', async () => {
    for (const [, url, method, secret] of REJECTED.filter(([, url, method]) => url === PATH && method === 'POST')) {
      const { request } = guarded(url, method, secret);
      await handleWebhook(request, { waitUntil: () => undefined }, { config, logger: recordingLogger().logger, bot: vi.fn() });
    }
    const calls = vi.mocked(timingSafeEqual).mock.calls;
    expect(calls.length).toBe(REJECTED.filter(([, url, method]) => url === PATH && method === 'POST').length);
    for (const [left, right] of calls) {
      expect([(left as Buffer).byteLength, (right as Buffer).byteLength]).toEqual([32, 32]);
    }
  });
});

describe('critical invariant 2: the secret has 32 characters or more, and is not the path segment', () => {
  /** The AppError CONFIG_INVALID a configuration with `overrides` is refused with. */
  const refused = (overrides: Readonly<Record<string, string>>): AppError => {
    try {
      testConfig(overrides);
    } catch (error) {
      if (error instanceof AppError && error.code === 'CONFIG_INVALID') return error;
      throw error;
    }
    throw new Error('expected the configuration to be refused');
  };

  it('refuses a secret of 31 characters, and takes one of 32', () => {
    expect(refused({ WEBHOOK_SECRET: 's'.repeat(31) }).variables).toEqual(['WEBHOOK_SECRET']);
    expect(testConfig({ WEBHOOK_SECRET: 's'.repeat(32) }).webhookSecret).toHaveLength(32);
  });

  it('refuses a secret equal to the path segment, which the webhook URL shows', () => {
    const shared = 'webhook-secret-and-path-of-32-chars';
    expect(refused({ WEBHOOK_SECRET: shared, WEBHOOK_PATH_SEGMENT: shared }).variables).toEqual(['WEBHOOK_PATH_SEGMENT', 'WEBHOOK_SECRET']);
  });

  it('runs on a test secret above the floor, so the checks above are not vacuous', () => {
    expect(SECRET.length).toBeGreaterThanOrEqual(32);
    expect(SECRET).not.toBe(config.webhookPathSegment);
  });
});

describe('critical invariant 2: no grammY webhook handler', () => {
  // `.href`: the Workers and Node type packages both declare URL.
  const SRC = fileURLToPath(new URL('../../src', import.meta.url).href);
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sources(path);
      return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
    });

  /** The source without its comments: a comment may name what the code must not use. */
  const code = (path: string): string =>
    readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('finds webhookCallback in the code of no file under src/, and the boundary in the Worker entry', () => {
    const files = sources(SRC);
    expect(files.length).toBeGreaterThan(10);
    expect(files.filter((path) => /\bwebhookCallback\b/.test(code(path))).map((path) => relative(SRC, path))).toEqual([]);
    expect(code(join(SRC, 'worker.ts'))).toMatch(/handleWebhook\(/);
  });
});

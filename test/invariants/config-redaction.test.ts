// Always-run invariant spec, critical invariant 6: secrets never reach a log
// or a chat. A loaded configuration must be unprintable in every form a
// logger or an error reporter would use, and a configuration that fails to
// load must never echo a supplied value (the admin and keyholder
// allowlists, the broadcast channel and the link hosts included, a key
// refused as too short or as equal to another variable, and a review venue
// refused as positive or as the channel or the membership chat). And an
// environment that defines DEBUG, NODE_DEBUG or NODE_DEBUG_NATIVE is refused,
// whatever its value: grammY's bundled `debug` package reads DEBUG from
// process.env, which the runtime fills with every variable and secret under
// nodejs_compat and the Node port hands to the loader whole, and Node reads
// the other two for its own debug lines (with NODE_DEBUG=fetch or undici,
// every Bot API request, the token in its path); each would write to the
// console, past the redacting logger. The commit gate runs this file on
// every commit (`npm run test:invariants`).
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { CONFIG_REDACTED, loadConfig } from '../../src/config/schema';
import { AppError } from '../../src/errors/app-error';

// Distinctive fixture values, deliberately not secret-shaped (the commit
// gate's secret-shape scan covers this file too).
const ENV = {
  BOT_TOKEN: 'invariant-bot-token-value',
  BOT_ID: '424242006',
  BOT_USERNAME: 'invariant_bot_username_value',
  WEBHOOK_SECRET: 'invariant-webhook-secret-value-at-least-32',
  WEBHOOK_PATH_SEGMENT: 'invariant-path-segment-value',
  ADMIN_IDS: '424242001,424242002',
  KEYHOLDER_IDS: '424242007,424242008',
  REPORTER_REF_KEY: 'invariant-reporter-ref-key-value-at-least-32',
  ADMIN_CHAT_ID: '-100424242003',
  MEMBERSHIP_CHAT_ID: '-100424242005',
  BROADCAST_CHAT_ID: '-100424242004',
  ALLOWED_LINK_HOSTS: 'invariant-link-host.example,www.invariant-link-host.example',
  LOCKDOWN: '1',
  MARKS_PER_DAY: '424243',
  MARKS_PER_REPORT: '424244',
} as const;

/**
 * The values a printed text must never contain: every supplied value of six
 * characters or more, and each id and host on its own. LOCKDOWN's only
 * value, "1", is too short to look for in a text; the locked-down
 * configuration is covered by printing as the marker alone, and a rejected
 * LOCKDOWN value by the failed-load cases.
 */
const distinctive = (values: readonly string[]): string[] => values.filter((value) => value.length >= 6);
const SENSITIVE = [
  ...distinctive(Object.values(ENV)),
  '424242001',
  '424242002',
  '424242007',
  '424242008',
  'invariant-link-host.example',
];

const expectNoValueIn = (text: string): void => {
  for (const value of SENSITIVE) expect(text).not.toContain(value);
};

describe('critical invariant 6: the loaded configuration is unprintable', () => {
  const config = loadConfig(ENV);

  it('holds every value it must never print, so the checks below are not vacuous', () => {
    expect(config.adminIds).toEqual([424242001, 424242002]);
    expect(config.keyholderIds).toEqual([424242007, 424242008]);
    expect(config.broadcastChatId).toBe(-100424242004);
    expect(config.allowedLinkHosts).toEqual(['invariant-link-host.example', 'www.invariant-link-host.example']);
    expect(config.lockdown).toBe(true);
    expect(config.marksPerReport).toBe(424244);
  });

  it('JSON.stringify renders it as the redaction marker and nothing else', () => {
    expect(JSON.stringify(config)).toBe(JSON.stringify(CONFIG_REDACTED));
    expectNoValueIn(JSON.stringify(config));
    expectNoValueIn(JSON.stringify({ config }));
    expectNoValueIn(JSON.stringify({ ...config }));
    expectNoValueIn(JSON.stringify(config, null, 2));
  });

  it('util.inspect renders it as the redaction marker and nothing else', () => {
    expect(inspect(config)).toBe(CONFIG_REDACTED);
    expectNoValueIn(inspect(config));
    expectNoValueIn(inspect({ config }, { depth: 10 }));
    expectNoValueIn(inspect({ ...config }));
    expectNoValueIn(inspect(config, { showHidden: true, depth: 10 }));
  });

  it('cannot be stripped of its redaction', () => {
    expect(Object.isFrozen(config)).toBe(true);
    expect(() => {
      Object.defineProperty(config, 'toJSON', { value: () => 'leak' });
    }).toThrow(TypeError);
  });
});

describe('critical invariant 6: a failed load never echoes a value', () => {
  const failure = (env: Record<string, string | undefined>): AppError => {
    try {
      loadConfig(env);
    } catch (error) {
      if (error instanceof AppError && error.code === 'CONFIG_INVALID') return error;
      throw error;
    }
    throw new Error('expected loadConfig to reject the configuration');
  };

  it.each([
    ['a username in the allowlist', { ...ENV, ADMIN_IDS: '424242001,@leaky_admin_handle' }],
    ['a username among the keyholders', { ...ENV, KEYHOLDER_IDS: '424242007,@leaky_keyholder_handle' }],
    ['a keyholder who is also an admin', { ...ENV, KEYHOLDER_IDS: '424242008,424242001' }],
    ['a positive broadcast chat id', { ...ENV, BROADCAST_CHAT_ID: '424242099' }],
    ['a positive review venue', { ...ENV, ADMIN_CHAT_ID: '424242098' }],
    ['a review venue that is the broadcast channel', { ...ENV, ADMIN_CHAT_ID: ENV.BROADCAST_CHAT_ID }],
    ['a review venue that is the membership chat', { ...ENV, ADMIN_CHAT_ID: ENV.MEMBERSHIP_CHAT_ID }],
    ['a link host with a scheme', { ...ENV, ALLOWED_LINK_HOSTS: 'https://leaky-link-host.example' }],
    ['a lockdown value other than 1', { ...ENV, LOCKDOWN: 'leaky-lockdown-value' }],
    ['an out-of-range tunable', { ...ENV, MARKS_PER_REPORT: '424242046' }],
    ['a webhook secret outside the alphabet', { ...ENV, WEBHOOK_SECRET: 'leaky secret value' }],
    ['a webhook secret shorter than 32 characters', { ...ENV, WEBHOOK_SECRET: 'leaky-short-webhook-secret' }],
    ['a reporter reference key shorter than 32 characters', { ...ENV, REPORTER_REF_KEY: 'leaky-short-reporter-key' }],
    ['the webhook secret equal to the path segment', { ...ENV, WEBHOOK_SECRET: 'leaky-shared-secret-value-of-32-chars', WEBHOOK_PATH_SEGMENT: 'leaky-shared-secret-value-of-32-chars' }],
    ['the reference key equal to the webhook secret', { ...ENV, REPORTER_REF_KEY: 'leaky-shared-secret-value-of-32-chars', WEBHOOK_SECRET: 'leaky-shared-secret-value-of-32-chars' }],
    ['the reference key equal to the path segment', { ...ENV, REPORTER_REF_KEY: 'leaky-shared-secret-value-of-32-chars', WEBHOOK_PATH_SEGMENT: 'leaky-shared-secret-value-of-32-chars' }],
    ['the reference key equal to the bot token', { ...ENV, REPORTER_REF_KEY: 'leaky-shared-secret-value-of-32-chars', BOT_TOKEN: 'leaky-shared-secret-value-of-32-chars' }],
    ['a missing bot token', { ...ENV, BOT_TOKEN: undefined }],
    ['a DEBUG variable', { ...ENV, DEBUG: 'leaky-debug-value' }],
    ['a NODE_DEBUG variable', { ...ENV, NODE_DEBUG: 'leaky-node-debug-value' }],
    ['a NODE_DEBUG_NATIVE variable', { ...ENV, NODE_DEBUG_NATIVE: 'leaky-node-debug-native-value' }],
  ])('%s', (_label, env) => {
    const error = failure(env);
    const supplied = distinctive(Object.values(env).filter((value): value is string => value !== undefined));
    for (const text of [error.message, String(error), inspect(error), JSON.stringify(error)]) {
      expectNoValueIn(text);
      for (const value of supplied) expect(text).not.toContain(value);
    }
    expect(error.cause).toBeUndefined();
  });

  it.each(['grammy*', 'grammy:core', '*', 'leaky-debug-value', ''])(
    "refuses DEBUG=%j: it would switch on grammY's own logging past the redacting logger",
    (value) => {
      const error = failure({ ...ENV, DEBUG: value });
      expect(error.variables).toEqual(['DEBUG']);
      expect(error.message).toContain("DEBUG would switch on grammY's own logging past the redacting logger");
    },
  );

  it.each(['fetch', 'undici', 'http,net,fetch', '*', ''])(
    "refuses NODE_DEBUG=%j: Node's own debug lines would print every Bot API request, the token in its path",
    (value) => {
      const error = failure({ ...ENV, NODE_DEBUG: value });
      expect(error.variables).toEqual(['NODE_DEBUG']);
      expect(error.message).toContain("NODE_DEBUG would switch on Node's own debug lines past the redacting logger");
    },
  );

  it.each(['net', 'net,http2', ''])("refuses NODE_DEBUG_NATIVE=%j: Node's native debug lines would bypass the redacting logger", (value) => {
    const error = failure({ ...ENV, NODE_DEBUG_NATIVE: value });
    expect(error.variables).toEqual(['NODE_DEBUG_NATIVE']);
    expect(error.message).toContain("NODE_DEBUG_NATIVE would switch on Node's native debug lines past the redacting logger");
  });
});

// Always-run invariant spec, critical invariant 6: secrets never reach a log
// or a chat. A loaded configuration must be unprintable in every form a
// logger or an error reporter would use, and a configuration that fails to
// load must never echo a supplied value (the admin allowlist is a secret
// too). The commit gate runs this file on every commit
// (`npm run test:invariants`).
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { CONFIG_REDACTED, ConfigError, loadConfig } from '../../src/config/schema';

// Distinctive fixture values, deliberately not secret-shaped (the commit
// gate's secret-shape scan covers this file too).
const ENV = {
  BOT_TOKEN: 'invariant-bot-token-value',
  WEBHOOK_SECRET: 'invariant-webhook-secret-value',
  WEBHOOK_PATH_SEGMENT: 'invariant-path-segment-value',
  ADMIN_IDS: '424242001,424242002',
  REPORTER_REF_KEY: 'invariant-reporter-ref-key-value',
  ADMIN_CHAT_ID: '-100424242003',
  MIRROR_CHAT_ID: '-100424242004',
  NGO_GROUP_ID: '-100424242005',
  DAILY_RECIPIENT_BUDGET: '424242',
} as const;

/** Every supplied value, and each admin id on its own. */
const SENSITIVE = [...Object.values(ENV), '424242001', '424242002'];

const expectNoValueIn = (text: string): void => {
  for (const value of SENSITIVE) expect(text).not.toContain(value);
};

describe('critical invariant 6: the loaded configuration is unprintable', () => {
  const config = loadConfig(ENV);

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
  const failure = (env: Record<string, string | undefined>): ConfigError => {
    try {
      loadConfig(env);
    } catch (error) {
      if (error instanceof ConfigError) return error;
      throw error;
    }
    throw new Error('expected loadConfig to reject the configuration');
  };

  it.each([
    ['a username in the allowlist', { ...ENV, ADMIN_IDS: '424242001,@leaky_admin_handle' }],
    ['an out-of-range tunable', { ...ENV, BROADCAST_BATCH_SIZE: '424242046' }],
    ['a webhook secret outside the alphabet', { ...ENV, WEBHOOK_SECRET: 'leaky secret value' }],
    ['a missing bot token', { ...ENV, BOT_TOKEN: undefined }],
  ])('%s', (_label, env) => {
    const error = failure(env);
    const supplied = Object.values(env).filter((value): value is string => value !== undefined);
    for (const text of [error.message, String(error), inspect(error), JSON.stringify(error)]) {
      expectNoValueIn(text);
      for (const value of supplied) expect(text).not.toContain(value);
    }
    expect(error.cause).toBeUndefined();
  });
});

// Unit tests for configFor(), the per-isolate configuration memo.
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors/app-error';
import { configFor } from './memo';
import { CONFIG_REDACTED } from './schema';

// Fixture values are deliberately not secret-shaped: the commit gate's
// secret-shape scan covers test files too.
const VARIABLES = {
  BOT_TOKEN: 'unit-test-bot-token',
  BOT_ID: '1000001',
  BOT_USERNAME: 'unit_test_bot',
  WEBHOOK_SECRET: 'unit-test-webhook-secret',
  WEBHOOK_PATH_SEGMENT: 'unit-test-path-segment',
  ADMIN_IDS: '1001,1002',
  KEYHOLDER_IDS: '2001',
  REPORTER_REF_KEY: 'unit-test-reporter-ref-key',
  ADMIN_CHAT_ID: '-1001234567890',
  MEMBERSHIP_CHAT_ID: '-1009876543210',
  BROADCAST_CHAT_ID: '-1005555555555',
} as const;

/** A Workers-shaped env: the variables beside binding objects. */
const workerEnv = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...VARIABLES,
  DB: { prepare: () => undefined },
  ...overrides,
});

describe('configFor', () => {
  it('parses the string-valued variables and passes over the bindings', () => {
    const config = configFor(workerEnv());
    expect(config.botUsername).toBe('unit_test_bot');
    expect(config.membershipChatId).toBe(-1009876543210);
    expect(Object.keys(config)).not.toContain('DB');
    expect(JSON.stringify(config)).toBe(JSON.stringify(CONFIG_REDACTED));
  });

  it('returns the same configuration object for the same env object', () => {
    const env = workerEnv();
    expect(configFor(env)).toBe(configFor(env));
  });

  it('parses a different env object afresh, even with equal contents', () => {
    expect(configFor(workerEnv())).not.toBe(configFor(workerEnv()));
  });

  it('does not see a later mutation of an env it has parsed', () => {
    const env = workerEnv();
    const first = configFor(env);
    env.BOT_USERNAME = 'another_bot';
    expect(configFor(env)).toBe(first);
    expect(configFor(env).botUsername).toBe('unit_test_bot');
  });

  it('ignores a non-string value, even under a known name', () => {
    // A JSON number from wrangler `vars`; this deployment keeps `vars` empty.
    expect(configFor(workerEnv({ MARKS_PER_REPORT: 40 })).marksPerReport).toBe(5000);
    expect(() => configFor(workerEnv({ BOT_ID: 1000001 }))).toThrow(AppError);
  });

  it('passes DEBUG through to the loader, which refuses the env', () => {
    let caught: unknown;
    try {
      configFor(workerEnv({ DEBUG: 'grammy*' }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'CONFIG_INVALID', variables: ['DEBUG'] });
  });

  it('throws CONFIG_INVALID for an invalid env, and does not memoise the failure', () => {
    const env = workerEnv({ BOT_ID: undefined });
    let caught: unknown;
    try {
      configFor(env);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect(caught).toMatchObject({ code: 'CONFIG_INVALID', variables: ['BOT_ID'] });
    env.BOT_ID = '1000001';
    expect(configFor(env).botId).toBe(1000001);
  });
});

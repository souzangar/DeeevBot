// Unit tests for the configuration schema: the parsing cases. The rule-6
// redaction assertions live in test/invariants/config-redaction.test.ts.
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors/app-error';
import { loadConfig } from './schema';

// Fixture values are deliberately not secret-shaped: the commit gate's
// secret-shape scan covers test files too.
const VALID = {
  BOT_TOKEN: 'unit-test-bot-token',
  BOT_ID: '1000001',
  BOT_USERNAME: 'unit_test_bot',
  WEBHOOK_SECRET: 'unit-test-webhook-secret',
  WEBHOOK_PATH_SEGMENT: 'unit-test-path-segment',
  ADMIN_IDS: '1001,1002',
  REPORTER_REF_KEY: 'unit-test-reporter-ref-key',
  ADMIN_CHAT_ID: '-1001234567890',
  MEMBERSHIP_CHAT_ID: '-1009876543210',
  DAILY_RECIPIENT_BUDGET: '20000',
} as const;

type Overrides = Record<string, string | undefined>;

const load = (overrides: Overrides = {}) => loadConfig({ ...VALID, ...overrides });

/** The variable names a rejected load reports. */
const rejectedVariables = (overrides: Overrides): readonly string[] => {
  try {
    load(overrides);
  } catch (error) {
    if (error instanceof AppError && error.code === 'CONFIG_INVALID') return error.variables ?? [];
    throw error;
  }
  throw new Error('expected loadConfig to reject the configuration');
};

describe('loadConfig', () => {
  it('parses a complete configuration and applies the documented defaults', () => {
    const config = load();
    expect(config.botToken).toBe(VALID.BOT_TOKEN);
    expect(config.botId).toBe(1000001);
    expect(config.botUsername).toBe(VALID.BOT_USERNAME);
    expect(config.webhookSecret).toBe(VALID.WEBHOOK_SECRET);
    expect(config.webhookPathSegment).toBe(VALID.WEBHOOK_PATH_SEGMENT);
    expect(config.reporterRefKey).toBe(VALID.REPORTER_REF_KEY);
    expect(config.adminIds).toEqual([1001, 1002]);
    expect(config.adminChatId).toBe(-1001234567890);
    expect(config.membershipChatId).toBe(-1009876543210);
    expect(config.mirrorChatId).toBeUndefined();
    expect(config.dailyRecipientBudget).toBe(20000);
    expect(config.broadcastBatchSize).toBe(35);
    expect(config.broadcastMessagesPerSecond).toBe(25);
    expect(config.approvalGraceMinutes).toBe(5);
    expect(config.marksPerDay).toBe(20000);
  });

  it('ignores variables it does not know', () => {
    const config = load({ PATH: '/usr/bin', UNRELATED: 'x' });
    expect(Object.keys(config)).not.toContain('PATH');
    expect(Object.keys(config)).not.toContain('UNRELATED');
  });

  it('returns a frozen object with a frozen admin list', () => {
    const config = load();
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.adminIds)).toBe(true);
  });

  describe('ADMIN_IDS (critical invariant 2: numeric ids only, never usernames)', () => {
    it.each([
      ['a single id', '1001', [1001]],
      ['several ids', '1001,1002,1003', [1001, 1002, 1003]],
      ['spaces around entries', ' 1001 , 1002 ', [1001, 1002]],
      ['the largest safe integer', '9007199254740991', [9007199254740991]],
    ])('accepts %s', (_label, value, expected) => {
      expect(load({ ADMIN_IDS: value }).adminIds).toEqual(expected);
    });

    it.each([
      ['a username', 'someadmin'],
      ['an @handle', '@someadmin'],
      ['an @handle beside a valid id', '1001,@someadmin'],
      ['a username beside a valid id', '1001,someadmin'],
      ['an empty entry', '1001,,1002'],
      ['a trailing comma', '1001,'],
      ['a leading comma', ',1001'],
      ['blank', ' '],
      ['zero', '0'],
      ['a negative id', '-1001'],
      ['a leading zero', '01001'],
      ['a plus sign', '+1001'],
      ['a decimal', '1001.5'],
      ['an exponent', '1e3'],
      ['hexadecimal', '0x3e9'],
      ['an id beyond the safe-integer range', '9007199254740992'],
      ['a different separator', '1001;1002'],
      ['spaces instead of commas', '1001 1002'],
    ])('rejects %s', (_label, value) => {
      expect(rejectedVariables({ ADMIN_IDS: value })).toEqual(['ADMIN_IDS']);
    });

    it('rejects a missing or empty allowlist', () => {
      expect(rejectedVariables({ ADMIN_IDS: undefined })).toEqual(['ADMIN_IDS']);
      expect(rejectedVariables({ ADMIN_IDS: '' })).toEqual(['ADMIN_IDS']);
    });
  });

  describe('chat ids', () => {
    it('accepts negative and positive ids', () => {
      expect(load({ ADMIN_CHAT_ID: '-100555' }).adminChatId).toBe(-100555);
      expect(load({ MEMBERSHIP_CHAT_ID: '777' }).membershipChatId).toBe(777);
    });

    it.each([
      ['zero', '0'],
      ['minus zero', '-0'],
      ['text', 'review-chat'],
      ['an @handle', '@reviewchat'],
      ['a lone minus', '-'],
      ['a decimal', '-100.5'],
      ['a leading zero', '-0100'],
    ])('rejects %s', (_label, value) => {
      expect(rejectedVariables({ ADMIN_CHAT_ID: value })).toEqual(['ADMIN_CHAT_ID']);
      expect(rejectedVariables({ MEMBERSHIP_CHAT_ID: value })).toEqual(['MEMBERSHIP_CHAT_ID']);
      expect(rejectedVariables({ MIRROR_CHAT_ID: value })).toEqual(['MIRROR_CHAT_ID']);
    });

    it('requires the admin venue and the membership chat', () => {
      expect(rejectedVariables({ ADMIN_CHAT_ID: undefined })).toEqual(['ADMIN_CHAT_ID']);
      expect(rejectedVariables({ MEMBERSHIP_CHAT_ID: '' })).toEqual(['MEMBERSHIP_CHAT_ID']);
    });

    it('no longer reads the pre-rename NGO_GROUP_ID', () => {
      expect(rejectedVariables({ MEMBERSHIP_CHAT_ID: undefined, NGO_GROUP_ID: '-100777' })).toEqual([
        'MEMBERSHIP_CHAT_ID',
      ]);
    });

    it('treats the mirror chat as optional', () => {
      expect(load({ MIRROR_CHAT_ID: undefined }).mirrorChatId).toBeUndefined();
      expect(load({ MIRROR_CHAT_ID: '' }).mirrorChatId).toBeUndefined();
      expect(load({ MIRROR_CHAT_ID: '-100333' }).mirrorChatId).toBe(-100333);
    });
  });

  describe('numeric bounds', () => {
    it.each([
      ['BROADCAST_BATCH_SIZE', 'broadcastBatchSize', 1, 45],
      ['BROADCAST_MESSAGES_PER_SECOND', 'broadcastMessagesPerSecond', 1, 25],
      ['APPROVAL_GRACE_MINUTES', 'approvalGraceMinutes', 1, 60],
      ['MARKS_PER_DAY', 'marksPerDay', 0, 1_000_000],
    ] as const)('%s accepts %i to %i and nothing outside', (name, key, min, max) => {
      expect(load({ [name]: String(min) })[key]).toBe(min);
      expect(load({ [name]: String(max) })[key]).toBe(max);
      for (const value of [String(min - 1), String(max + 1), '-1', '2.5', 'many']) {
        expect(rejectedVariables({ [name]: value })).toEqual([name]);
      }
    });

    it('takes the default when a tunable is left blank', () => {
      const config = load({
        BROADCAST_BATCH_SIZE: '',
        BROADCAST_MESSAGES_PER_SECOND: '',
        APPROVAL_GRACE_MINUTES: '',
        MARKS_PER_DAY: '',
      });
      expect(config.broadcastBatchSize).toBe(35);
      expect(config.broadcastMessagesPerSecond).toBe(25);
      expect(config.approvalGraceMinutes).toBe(5);
      expect(config.marksPerDay).toBe(20000);
    });

    it('caps the pacing at the decided 25 messages per second, below Telegram\'s "about 30"', () => {
      for (const value of ['26', '30']) {
        expect(rejectedVariables({ BROADCAST_MESSAGES_PER_SECOND: value })).toEqual([
          'BROADCAST_MESSAGES_PER_SECOND',
        ]);
      }
    });

    it('requires a positive daily recipient budget', () => {
      expect(load({ DAILY_RECIPIENT_BUDGET: '1' }).dailyRecipientBudget).toBe(1);
      for (const value of [undefined, '', '0', '-5', '1.5', 'unlimited']) {
        expect(rejectedVariables({ DAILY_RECIPIENT_BUDGET: value })).toEqual([
          'DAILY_RECIPIENT_BUDGET',
        ]);
      }
    });
  });

  describe('secrets', () => {
    it.each(['BOT_TOKEN', 'WEBHOOK_SECRET', 'WEBHOOK_PATH_SEGMENT', 'REPORTER_REF_KEY'])(
      '%s must be present and non-blank',
      (name) => {
        for (const value of [undefined, '', '   ']) {
          expect(rejectedVariables({ [name]: value })).toEqual([name]);
        }
      },
    );

    it('limits the webhook secret to the alphabet Telegram accepts, 1 to 256 characters', () => {
      expect(load({ WEBHOOK_SECRET: 'A'.repeat(256) }).webhookSecret).toHaveLength(256);
      for (const value of ['A'.repeat(257), 'has space', 'semi;colon', 'slash/']) {
        expect(rejectedVariables({ WEBHOOK_SECRET: value })).toEqual(['WEBHOOK_SECRET']);
      }
    });

    it('limits the webhook path segment to characters that need no escaping', () => {
      for (const value of ['a/b', 'a?b', 'a#b', 'a%2Fb', 'a b']) {
        expect(rejectedVariables({ WEBHOOK_PATH_SEGMENT: value })).toEqual([
          'WEBHOOK_PATH_SEGMENT',
        ]);
      }
    });
  });

  describe("the bot's identity (grammY's botInfo, so no getMe call per update)", () => {
    it('requires BOT_ID, a positive integer', () => {
      expect(load({ BOT_ID: '9007199254740991' }).botId).toBe(9007199254740991);
      for (const value of [undefined, '', '0', '-1001', '01001', '1.5', '1e6', 'some_bot']) {
        expect(rejectedVariables({ BOT_ID: value })).toEqual(['BOT_ID']);
      }
    });

    it('requires BOT_USERNAME, 5 to 32 characters from A-Z, a-z, 0-9 and _, without the @', () => {
      expect(load({ BOT_USERNAME: 'Ab_12' }).botUsername).toBe('Ab_12');
      expect(load({ BOT_USERNAME: 'b'.repeat(32) }).botUsername).toHaveLength(32);
      const invalid = [undefined, '', 'abcd', 'b'.repeat(33), '@unit_test_bot', 'unit-test-bot', 'a b'];
      for (const value of invalid) {
        expect(rejectedVariables({ BOT_USERNAME: value })).toEqual(['BOT_USERNAME']);
      }
    });
  });

  describe('CONFIG_INVALID', () => {
    it('names every failing variable, sorted, with what it must hold', () => {
      let caught: unknown;
      try {
        load({ BOT_TOKEN: undefined, ADMIN_IDS: '@someadmin', BROADCAST_BATCH_SIZE: '99' });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AppError);
      const error = caught as AppError;
      expect(error.name).toBe('AppError');
      expect(error.code).toBe('CONFIG_INVALID');
      expect(error.retryable).toBe(false);
      expect(error.userMessageKey).toBe('alert.config_invalid');
      expect(error.variables).toEqual(['ADMIN_IDS', 'BOT_TOKEN', 'BROADCAST_BATCH_SIZE']);
      expect(error.message).toContain('ADMIN_IDS must be comma-separated numeric Telegram user ids');
      expect(error.message).toContain('BOT_TOKEN must be a non-blank secret');
      expect(error.message).toContain('BROADCAST_BATCH_SIZE must be an integer from 1 to 45');
    });
  });
});

// Unit tests for the configuration schema: the parsing cases. The rule-6
// redaction assertions live in test/invariants/config-redaction.test.ts.
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors/app-error';
import { DEFAULT_LINK_HOSTS, loadConfig } from './schema';

// Fixture values are deliberately not secret-shaped: the commit gate's
// secret-shape scan covers test files too.
const VALID = {
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
    expect(config.keyholderIds).toEqual([2001]);
    expect(config.adminChatId).toBe(-1001234567890);
    expect(config.membershipChatId).toBe(-1009876543210);
    expect(config.broadcastChatId).toBe(-1005555555555);
    expect(config.allowedLinkHosts).toEqual([
      'instagram.com',
      'www.instagram.com',
      'x.com',
      'twitter.com',
      'www.facebook.com',
      'facebook.com',
      'www.tiktok.com',
      'tiktok.com',
      't.me',
    ]);
    expect(config.lockdown).toBe(false);
    expect(config.approvalGraceMinutes).toBe(30);
    expect(config.marksPerDay).toBe(20000);
    expect(config.marksPerReport).toBe(5000);
  });

  it('ignores variables it does not know, the removed direct-message ones included', () => {
    const config = load({
      PATH: '/usr/bin',
      UNRELATED: 'x',
      MIRROR_CHAT_ID: '-100333',
      DAILY_RECIPIENT_BUDGET: '20000',
      BROADCAST_BATCH_SIZE: 'not even a number',
      BROADCAST_MESSAGES_PER_SECOND: '99',
    });
    for (const key of ['PATH', 'UNRELATED', 'mirrorChatId', 'dailyRecipientBudget', 'broadcastBatchSize']) {
      expect(Object.keys(config)).not.toContain(key);
    }
  });

  it('returns a frozen object with frozen lists', () => {
    const config = load();
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.adminIds)).toBe(true);
    expect(Object.isFrozen(config.keyholderIds)).toBe(true);
    expect(Object.isFrozen(config.allowedLinkHosts)).toBe(true);
  });

  // Each list is checked with the other set to an id none of its cases use,
  // since the two must never share one.
  describe.each([
    ['ADMIN_IDS', 'adminIds', { KEYHOLDER_IDS: '3001' }],
    ['KEYHOLDER_IDS', 'keyholderIds', { ADMIN_IDS: '3001' }],
  ] as const)('%s (critical invariant 2: numeric ids only, never usernames)', (name, key, other) => {
    it.each([
      ['a single id', '1001', [1001]],
      ['several ids', '1001,1002,1003', [1001, 1002, 1003]],
      ['spaces around entries', ' 1001 , 1002 ', [1001, 1002]],
      ['the largest safe integer', '9007199254740991', [9007199254740991]],
    ])('accepts %s', (_label, value, expected) => {
      expect(load({ ...other, [name]: value })[key]).toEqual(expected);
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
      expect(rejectedVariables({ ...other, [name]: value })).toEqual([name]);
    });

    it('rejects a missing or empty list', () => {
      expect(rejectedVariables({ ...other, [name]: undefined })).toEqual([name]);
      expect(rejectedVariables({ ...other, [name]: '' })).toEqual([name]);
    });
  });

  describe('the keyholders and the admins (a keyholder is never an admin)', () => {
    it('loads two lists that share no id', () => {
      const config = load({ ADMIN_IDS: '1001,1002', KEYHOLDER_IDS: '2001,2002' });
      expect(config.adminIds).toEqual([1001, 1002]);
      expect(config.keyholderIds).toEqual([2001, 2002]);
    });

    it.each([
      ['the same single id', '1001', '1001'],
      ['one shared id among others', '1001,1002,1003', '2001,1003'],
      ['a shared id written with spaces', '1001, 1002', ' 1002 '],
    ])('refuses %s, naming both variables and no value', (_label, admins, keyholders) => {
      let caught: unknown;
      try {
        load({ ADMIN_IDS: admins, KEYHOLDER_IDS: keyholders });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AppError);
      const error = caught as AppError;
      expect(error.code).toBe('CONFIG_INVALID');
      expect(error.variables).toEqual(['ADMIN_IDS', 'KEYHOLDER_IDS']);
      expect(error.message).toContain('ADMIN_IDS and KEYHOLDER_IDS must not share an id');
      for (const id of ['1001', '1002', '1003', '2001']) expect(error.message).not.toContain(id);
      expect(error.cause).toBeUndefined();
    });
  });

  describe('chat ids', () => {
    it('accepts negative and positive ids for the venue and the membership chat', () => {
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
      expect(rejectedVariables({ BROADCAST_CHAT_ID: value })).toEqual(['BROADCAST_CHAT_ID']);
    });

    it('requires the admin venue, the membership chat and the broadcast channel', () => {
      expect(rejectedVariables({ ADMIN_CHAT_ID: undefined })).toEqual(['ADMIN_CHAT_ID']);
      expect(rejectedVariables({ MEMBERSHIP_CHAT_ID: '' })).toEqual(['MEMBERSHIP_CHAT_ID']);
      expect(rejectedVariables({ BROADCAST_CHAT_ID: undefined })).toEqual(['BROADCAST_CHAT_ID']);
    });

    it("takes only a negative id for the broadcast channel, a channel's", () => {
      expect(load({ BROADCAST_CHAT_ID: '-1' }).broadcastChatId).toBe(-1);
      expect(load({ BROADCAST_CHAT_ID: '-9007199254740991' }).broadcastChatId).toBe(-9007199254740991);
      for (const value of ['1', '1005555555555', '-9007199254740992']) {
        expect(rejectedVariables({ BROADCAST_CHAT_ID: value })).toEqual(['BROADCAST_CHAT_ID']);
      }
    });

    it('no longer reads the pre-rename NGO_GROUP_ID', () => {
      expect(rejectedVariables({ MEMBERSHIP_CHAT_ID: undefined, NGO_GROUP_ID: '-100777' })).toEqual([
        'MEMBERSHIP_CHAT_ID',
      ]);
    });
  });

  describe('ALLOWED_LINK_HOSTS', () => {
    it('defaults to the platforms\' own hosts, each of which the rules accept', () => {
      expect(load({ ALLOWED_LINK_HOSTS: undefined }).allowedLinkHosts).toEqual([...DEFAULT_LINK_HOSTS]);
      expect(load({ ALLOWED_LINK_HOSTS: '' }).allowedLinkHosts).toEqual([...DEFAULT_LINK_HOSTS]);
      expect(load({ ALLOWED_LINK_HOSTS: DEFAULT_LINK_HOSTS.join(',') }).allowedLinkHosts).toEqual([
        ...DEFAULT_LINK_HOSTS,
      ]);
    });

    it.each([
      ['one host', 'instagram.com', ['instagram.com']],
      ['several hosts', 'x.com,t.me', ['x.com', 't.me']],
      ['spaces around entries', ' x.com , t.me ', ['x.com', 't.me']],
      ['a deeper subdomain', 'm.facebook.com', ['m.facebook.com']],
      ['hyphens and digits inside labels', 'a-1.b2.example', ['a-1.b2.example']],
      ['a punycode label', 'xn--mgbh0fb.example', ['xn--mgbh0fb.example']],
    ])('accepts %s', (_label, value, expected) => {
      expect(load({ ALLOWED_LINK_HOSTS: value }).allowedLinkHosts).toEqual(expected);
    });

    it.each([
      ['a scheme', 'https://instagram.com'],
      ['a path', 'instagram.com/someone'],
      ['a port', 'instagram.com:443'],
      ['userinfo', 'user@instagram.com'],
      ['a query', 'instagram.com?x=1'],
      ['capitals', 'Instagram.com'],
      ['a wildcard', '*.instagram.com'],
      ['an underscore', 'in_stagram.com'],
      ['a single label', 'localhost'],
      ['a dotted-quad address', '93.184.216.34'],
      ['a leading dot', '.instagram.com'],
      ['a trailing dot', 'instagram.com.'],
      ['an empty label', 'insta..gram.com'],
      ['a label starting with a hyphen', '-x.com'],
      ['a label ending with a hyphen', 'x-.com'],
      ['a label of 64 characters', `${'a'.repeat(64)}.com`],
      ['an empty entry', 'x.com,,t.me'],
      ['a trailing comma', 'x.com,'],
      ['blank', ' '],
    ])('rejects %s', (_label, value) => {
      expect(rejectedVariables({ ALLOWED_LINK_HOSTS: value })).toEqual(['ALLOWED_LINK_HOSTS']);
    });
  });

  describe('LOCKDOWN', () => {
    it('is off when absent or empty, and on for 1', () => {
      expect(load({ LOCKDOWN: undefined }).lockdown).toBe(false);
      expect(load({ LOCKDOWN: '' }).lockdown).toBe(false);
      expect(load({ LOCKDOWN: '1' }).lockdown).toBe(true);
    });

    it.each(['0', 'true', 'yes', 'on', ' 1', '1 ', '01', '2'])('rejects %j: 1 is the only value', (value) => {
      expect(rejectedVariables({ LOCKDOWN: value })).toEqual(['LOCKDOWN']);
    });
  });

  describe('VENUE_LOCALE', () => {
    it('is Persian by default, when absent or empty, and English for en', () => {
      expect(load({ VENUE_LOCALE: undefined }).venueLocale).toBe('fa');
      expect(load({ VENUE_LOCALE: '' }).venueLocale).toBe('fa');
      expect(load({ VENUE_LOCALE: 'fa' }).venueLocale).toBe('fa');
      expect(load({ VENUE_LOCALE: 'en' }).venueLocale).toBe('en');
    });

    it.each(['FA', 'En', 'fa-IR', 'de', ' fa', 'fa,en', 'persian'])('rejects %j: fa and en are the only values', (value) => {
      expect(rejectedVariables({ VENUE_LOCALE: value })).toEqual(['VENUE_LOCALE']);
    });
  });

  describe('numeric bounds', () => {
    it.each([
      ['APPROVAL_GRACE_MINUTES', 'approvalGraceMinutes', 1, 1440],
      ['MARKS_PER_DAY', 'marksPerDay', 0, 1_000_000],
      ['MARKS_PER_REPORT', 'marksPerReport', 0, 1_000_000],
    ] as const)('%s accepts %i to %i and nothing outside', (name, key, min, max) => {
      expect(load({ [name]: String(min) })[key]).toBe(min);
      expect(load({ [name]: String(max) })[key]).toBe(max);
      for (const value of [String(min - 1), String(max + 1), '-1', '2.5', 'many']) {
        expect(rejectedVariables({ [name]: value })).toEqual([name]);
      }
    });

    it('takes the default when a tunable is left blank', () => {
      const config = load({ APPROVAL_GRACE_MINUTES: '', MARKS_PER_DAY: '', MARKS_PER_REPORT: '' });
      expect(config.approvalGraceMinutes).toBe(30);
      expect(config.marksPerDay).toBe(20000);
      expect(config.marksPerReport).toBe(5000);
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

  describe('DEBUG (grammY would log past the redacting logger)', () => {
    it.each([
      ['a grammY pattern', 'grammy*'],
      ['a wildcard', '*'],
      ['any other value', 'unrelated-tool'],
      ['the empty value', ''],
    ])('refuses an environment that defines it, with %s', (_label, value) => {
      expect(rejectedVariables({ DEBUG: value })).toEqual(['DEBUG']);
    });

    it('says why, beside every other failing variable, and echoes no value', () => {
      let caught: unknown;
      try {
        load({ DEBUG: 'grammy:core,grammy:bot', BOT_ID: 'not-a-number' });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: 'CONFIG_INVALID', variables: ['BOT_ID', 'DEBUG'] });
      const message = (caught as AppError).message;
      expect(message).toContain("DEBUG must not be set: DEBUG would switch on grammY's own logging past the redacting logger");
      expect(message).toContain('BOT_ID must be a positive integer');
      expect(message).not.toContain('grammy:core');
      expect(message).not.toContain('not-a-number');
    });

    it('loads when DEBUG is absent, or present only as undefined', () => {
      expect(load({ DEBUG: undefined }).botId).toBe(1000001);
    });
  });

  describe('CONFIG_INVALID', () => {
    it('names every failing variable, sorted, with what it must hold', () => {
      let caught: unknown;
      try {
        load({ BOT_TOKEN: undefined, ADMIN_IDS: '@someadmin', APPROVAL_GRACE_MINUTES: '1441' });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AppError);
      const error = caught as AppError;
      expect(error.name).toBe('AppError');
      expect(error.code).toBe('CONFIG_INVALID');
      expect(error.retryable).toBe(false);
      expect(error.userMessageKey).toBe('alert.config_invalid');
      expect(error.variables).toEqual(['ADMIN_IDS', 'APPROVAL_GRACE_MINUTES', 'BOT_TOKEN']);
      expect(error.message).toContain('ADMIN_IDS must be comma-separated numeric Telegram user ids');
      expect(error.message).toContain('BOT_TOKEN must be a non-blank secret');
      expect(error.message).toContain('APPROVAL_GRACE_MINUTES must be an integer from 1 to 1440');
    });
  });
});

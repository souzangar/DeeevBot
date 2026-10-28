// The test deployment's variables, as plain data with no imports, so that
// vitest.config.ts can hand them to the Workers runtime as bindings (the
// workers tier boots the real Worker with them) and test/support/config.ts
// can load them through the real schema. Every Telegram id has 9 or more
// digits, so a test that searches a log line, a payload or a reply for one
// finds it if it is there. Fixture values are never secret-shaped (the
// secret-shape scan reads test files too).

export const IDS = {
  bot: 424240001,
  admin: 424240011,
  secondAdmin: 424240012,
  keyholder: 424240021,
  secondKeyholder: 424240022,
  reporter: 424240031,
  stranger: 424240032,
  adminChat: -1004242400041,
  membershipChat: -1004242400051,
  broadcastChannel: -1004242400061,
  strangerGroup: -1004242400071,
} as const;

/** The variables of the test configuration, as the Worker's env holds them. */
export const TEST_VARIABLES = {
  BOT_TOKEN: 'unit-test-bot-token',
  BOT_ID: String(IDS.bot),
  BOT_USERNAME: 'div_report_test_bot',
  WEBHOOK_SECRET: 'unit-test-webhook-secret',
  WEBHOOK_PATH_SEGMENT: 'unit-test-path-segment',
  ADMIN_IDS: `${IDS.admin},${IDS.secondAdmin}`,
  KEYHOLDER_IDS: `${IDS.keyholder},${IDS.secondKeyholder}`,
  REPORTER_REF_KEY: 'unit-test-reporter-ref-key',
  ADMIN_CHAT_ID: String(IDS.adminChat),
  MEMBERSHIP_CHAT_ID: String(IDS.membershipChat),
  BROADCAST_CHAT_ID: String(IDS.broadcastChannel),
} as const satisfies Readonly<Record<string, string>>;

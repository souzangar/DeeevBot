// Three test tiers (doc/guides/developer-setup.md):
// - unit: plain node, `*.test.ts` beside the module; no network, mock at the boundary.
// - workers: the Workers runtime through @cloudflare/vitest-plugin, with
//   the local D1 binding from wrangler.jsonc, plus TEST_MIGRATIONS, the D1
//   migrations read here so a test can apply them with applyD1Migrations(),
//   and the test deployment's variables, so the real Worker boots with a
//   valid configuration; none is secret-shaped. They are written out here,
//   not imported, since the config file imports packages only; the source is
//   test/support/variables.ts, and test/workers/webhook.test.ts fails when
//   the two differ.
// - invariants: plain node, the always-run specs that pin a "must never
//   happen" rule; the commit gate runs them on every commit.
// The two node tiers run node:sqlite, whose Node 22 ExperimentalWarning is
// accepted and silenced in their output.
import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const QUIET_EXPERIMENTAL = ['--disable-warning=ExperimentalWarning'];
// `.href`: the Workers and Node type packages both declare URL.
const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url).href);
/** The test deployment's variables: test/support/variables.ts's TEST_VARIABLES. */
const TEST_VARIABLES = {
  BOT_TOKEN: 'unit-test-bot-token',
  BOT_ID: '424240001',
  BOT_USERNAME: 'div_report_test_bot',
  WEBHOOK_SECRET: 'unit-test-webhook-secret',
  WEBHOOK_PATH_SEGMENT: 'unit-test-path-segment',
  ADMIN_IDS: '424240011,424240012',
  KEYHOLDER_IDS: '424240021,424240022',
  REPORTER_REF_KEY: 'unit-test-reporter-ref-key',
  ADMIN_CHAT_ID: '-1004242400041',
  MEMBERSHIP_CHAT_ID: '-1004242400051',
  BROADCAST_CHAT_ID: '-1004242400061',
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          execArgv: QUIET_EXPERIMENTAL,
        },
      },
      {
        plugins: [
          cloudflareTest(async () => ({
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: {
              bindings: { ...TEST_VARIABLES, TEST_MIGRATIONS: await readD1Migrations(MIGRATIONS_DIR) },
            },
          })),
        ],
        test: {
          name: 'workers',
          include: ['test/workers/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'invariants',
          environment: 'node',
          include: ['test/invariants/**/*.test.ts'],
          execArgv: QUIET_EXPERIMENTAL,
        },
      },
    ],
  },
});

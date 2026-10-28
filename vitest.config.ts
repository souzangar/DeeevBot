// Three test tiers (doc/guides/developer-setup.md):
// - unit: plain node, `*.test.ts` beside the module; no network, mock at the boundary.
// - workers: the Workers runtime through @cloudflare/vitest-plugin, with
//   the local D1 binding from wrangler.jsonc, plus TEST_MIGRATIONS, the D1
//   migrations read here so a test can apply them with applyD1Migrations().
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
            miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations(MIGRATIONS_DIR) } },
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

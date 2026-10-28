// Three test tiers (doc/guides/developer-setup.md):
// - unit: plain node, `*.test.ts` beside the module; no network, mock at the boundary.
// - workers: the Workers runtime through @cloudflare/vitest-plugin, with
//   the local D1 and Durable Object bindings from wrangler.jsonc.
// - invariants: plain node, the always-run specs that pin a "must never
//   happen" rule; the commit gate runs them on every commit.
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
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
        },
      },
    ],
  },
});

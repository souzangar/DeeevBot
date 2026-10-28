// The bindings the workers tier sees through `env` from cloudflare:workers:
// wrangler.jsonc's D1 binding, plus TEST_MIGRATIONS, the D1 migrations
// vitest.config.ts reads so a test can apply them with applyD1Migrations().
declare namespace Cloudflare {
  interface Env {
    readonly DB: D1Database;
    readonly TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
}

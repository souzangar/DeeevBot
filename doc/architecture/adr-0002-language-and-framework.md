---
type: adr
title: "ADR 0002: Language and framework"
description: "TypeScript 5.9 strict ESM with grammY, Vitest with the Workers Vitest plugin, wrangler, eslint with typescript-eslint, zod, npm, and Node 22 for the port; versions as looked up on 2026-10-28; the compatibility-date rule; no AI services."
status: active
tags: [architecture, adr, stack, typescript, grammy]
timestamp: 2026-10-28T00:00:00Z
---

# ADR 0002: Language and framework

## Context

One codebase has to run on two runtimes
([ADR 0001](./adr-0001-runtime-and-hosting.md)): Cloudflare Workers with
a webhook, and Node with long polling as the fallback. The bot speaks
Persian and English, is run by one or two admins, and must never hand
report data to a third-party service.

## Decision

- TypeScript 5.9.x, strict, ESM (typescript-eslint supports TypeScript
  below 6.1).
- grammY 1.46: on Workers the entry parses the update itself and runs
  `bot.handleUpdate` under `executionCtx.waitUntil` (grammY's
  `webhookCallback` is not used: its wrapper resolves while the handling
  task runs detached, so nothing could be registered with the runtime);
  on Node, long polling through grammY's runner, `@grammyjs/runner` 2.0.3,
  which hands each update on as it arrives instead of after the one
  before.
- Vitest 4.1 with `@cloudflare/vitest-plugin` 1.4.9 (the successor of
  Cloudflare's deprecated Workers Vitest pool package; peer `vitest ^4.1`
  or `^5`) for the adapters; plain node for pure logic.
- wrangler 4 for deploy and D1 migrations.
- `compatibility_date` in `wrangler.jsonc` is the newest date every
  runtime in the toolchain accepts when it is set: today's UTC date is the
  ceiling miniflare enforces, and workerd 1.20261023.1's hard ceiling is
  2026-10-30. It is raised together with a run of the workers tests.
- eslint 10 with typescript-eslint 8, and `tsc --noEmit` as the build
  check.
- zod 4: one schema validates the configuration read from Workers secrets
  or the environment.
- npm as the package manager.
- Node 22 for the port; its SQLite driver is `node:sqlite`, built into
  Node, so there is no native build to install or audit; its
  ExperimentalWarning is accepted (the test runner silences it).
  `better-sqlite3` is dropped. The same driver runs every SQL-level test,
  the invariants tier's included (`src/db/node-sqlite.ts`). The port runs
  its TypeScript sources through Node's own type stripping (on by default
  from Node 22.18), with a resolve hook for their extensionless imports
  (`src/node-hooks.ts`): no build step, and the image installs the
  production packages only
  ([developer setup](../guides/developer-setup.md), section 8).
- i18n catalogs for `fa` and `en`; user-facing text is looked up by key
  ([ADR 0005](./adr-0005-error-handling-convention.md)).
- No AI services.

Versions are as looked up on 2026-10-28.

## Consequences

- Pure logic (the report state machine, the routing table, the error
  catalog) is tested under plain node; only the Cloudflare adapters need
  the Workers Vitest plugin.
- One pin constrains upgrades: TypeScript stays below 6.1 until
  typescript-eslint moves. The plugin accepts vitest 4.1 or 5, and the
  repo pins 4.1.12.
- The port's SQLite driver sits behind the same `SqlDb` port as D1
  ([ADR 0004](./adr-0004-storage-and-delivery-ledger.md)), and the
  adapters refuse the statement shapes D1 refuses (a parameter count that
  differs from the placeholders, a second statement, more than 100
  parameters), which node:sqlite would otherwise accept silently; the
  workers tier runs the schema on D1 itself. The driver is still marked
  experimental in Node 22: an API change in a later Node line lands in
  `src/db/node-sqlite.ts` alone.
- No AI service means no model-assisted categorisation or translation
  touches report data; the Persian and English copy is written by people.

## Alternatives considered

- The Telegram Serverless runtime, which has no npm: rejected in
  ADR 0001.
- The decision records no competing bot framework; grammY was chosen
  because the same bot code runs under `webhookCallback` on Workers and
  under long polling on Node, which is exactly the primary-plus-fallback
  shape ADR 0001 requires.
- A heavier ORM or migration tool over D1: not adopted; plain SQL
  migrations keep the D1 and SQLite adapters identical.

## Status

Accepted 2026-10-28.

Amended 2026-10-28 (Phase 2): the Workers Vitest integration moved to
`@cloudflare/vitest-plugin` 1.4.9, the successor of the deprecated pool
package, and the compatibility-date rule was recorded.

Amended 2026-10-28 (Phase 3, unit U1b): the Node port's SQLite driver is
`node:sqlite`; `better-sqlite3` is dropped.

Amended 2026-11-04 (Phase 3, unit U7): the port's long polling runs on
`@grammyjs/runner` 2.0.3 (an exact dependency), and the port runs through
Node's type stripping with a module hook rather than a `tsc` build, because
`tsc` keeps the extensionless specifiers Node's resolver cannot load.

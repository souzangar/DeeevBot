---
type: adr
title: "ADR 0002: Language and framework"
description: "TypeScript 5.9 strict ESM with grammY, Vitest and the Workers test pool, wrangler, eslint with typescript-eslint, zod, npm, and Node 22 for the port; versions as looked up on 2026-10-28; no AI services."
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
- grammY 1.46: `webhookCallback` on Workers, long polling on Node.
- Vitest 4.1 with `@cloudflare/vitest-pool-workers` 0.23 (peer `vitest
  ^4.1`) for the adapters; plain node for pure logic.
- wrangler 4 for deploy and D1 migrations.
- eslint 10 with typescript-eslint 8, and `tsc --noEmit` as the build
  check.
- zod 4: one schema validates the configuration read from Workers secrets
  or the environment.
- npm as the package manager.
- Node 22 for the port; its SQLite driver is `node:sqlite` (experimental
  warning accepted) or `better-sqlite3`, decided in the MVP plan.
- i18n catalogs for `fa` and `en`; user-facing text is looked up by key
  ([ADR 0005](./adr-0005-error-handling-convention.md)).
- No AI services.

Versions are as looked up on 2026-10-28.

## Consequences

- Pure logic (the report state machine, the routing table, the broadcast
  `step()`, the error catalog) is tested under plain node; only the
  Cloudflare adapters need the Workers pool.
- Two pins constrain upgrades: TypeScript stays below 6.1 until
  typescript-eslint moves, and the Workers pool requires `vitest ^4.1`.
- The SQLite driver for the port is an open item of the MVP plan; both
  candidates sit behind the same `SqlDb` port
  ([ADR 0004](./adr-0004-storage-and-delivery-ledger.md)).
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

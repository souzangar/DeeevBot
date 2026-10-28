<!-- generated-by: scripts/okf/build-index.mjs — do not edit by hand -->

# architecture/

System design, data model, and decision records.

↑ [bundle index](../index.md)

- [ADR 0001: Runtime and hosting](./adr-0001-runtime-and-hosting.md) — Cloudflare Workers Free plan as the primary target with a Node port as the fallback; Telegram Serverless rejected for now with a named re-evaluation trigger; the meters that shape the design, the over-limit behaviour, the risks, and the yearly fallback drill.
- [ADR 0002: Language and framework](./adr-0002-language-and-framework.md) — TypeScript 5.9 strict ESM with grammY, Vitest with the Workers Vitest plugin, wrangler, eslint with typescript-eslint, zod, npm, and Node 22 for the port; versions as looked up on 2026-10-28; the compatibility-date rule; no AI services.
- [ADR 0003: Update transport and admin authority](./adr-0003-update-transport-and-admin-authority.md) — A webhook with a verified secret token on Cloudflare, long polling on a VPS, and admin authority from a numeric allowlist re-checked at every action; the admin chat is a venue, never an authority.
- [ADR 0004: Storage and the delivery ledger](./adr-0004-storage-and-delivery-ledger.md) — D1 behind a SqlDb port with plain SQL migrations, one broadcaster Durable Object with alarms driving a pure step(), its SQLite storage holding the delivery ledger and marks, batching and pacing, the 429 pause, budgets and quota exhaustion, and retraction and closure through stored message ids.
- [ADR 0005: Error-handling convention](./adr-0005-error-handling-convention.md) — One typed AppError shape, one code catalog mapped to i18n keys, a grammY boundary that never leaks report data, a classification of Telegram API errors, nothing swallowed, and the regression tests that pin it.
- [ADR 0006: Data model and module layout](./adr-0006-data-model-and-module-layout.md) — The MVP tables in D1 and in the broadcaster's storage, the report statuses, the module map under src/, which modules are critical paths, and the tripwire patterns.
- [Critical invariants](./critical-invariants.md) — The eight catastrophic invariants explained: each rule by title, why it exists, and the regression test that pins it; the verbatim block lives in CLAUDE.md, synced to AGENTS.md and the devil's invariants file.

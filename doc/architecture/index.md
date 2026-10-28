<!-- generated-by: scripts/okf/build-index.mjs — do not edit by hand -->

# architecture/

System design, data model, and decision records.

↑ [bundle index](../index.md)

- [ADR 0001: Runtime and hosting](./adr-0001-runtime-and-hosting.md) — Cloudflare Workers Free plan as the primary target with a Node port as the fallback; Telegram Serverless rejected for now with a named re-evaluation trigger; the meters that shape the design, the over-limit behaviour, the risks, and the yearly fallback drill.
- [ADR 0002: Language and framework](./adr-0002-language-and-framework.md) — TypeScript 5.9 strict ESM with grammY, Vitest with the Workers Vitest plugin, wrangler, eslint with typescript-eslint, zod, npm, and Node 22 for the port; versions as looked up on 2026-10-28; the compatibility-date rule; no AI services.
- [ADR 0003: Update transport and admin authority](./adr-0003-update-transport-and-admin-authority.md) — A webhook with a verified secret token on Cloudflare, long polling on a VPS; admin authority from a numeric allowlist re-checked at every action, the admin chat a venue and never an authority; the keyholder allowlist that never overlaps it; and the two-layer lockdown switch that refuses every admin action without a code deploy.
- [ADR 0004: Storage, scheduling and the single post](./adr-0004-storage-and-delivery-ledger.md) — D1 as the only store behind a SqlDb port with plain SQL migrations; no Durable Object, no delivery ledger, no pacing; a jobs table drained by a one-minute cron, the approval row as the schedule; each approved report posted once into the channel, at most once, through one claim statement, with the two failure classes and the verified /attach and /repost; edits at retraction and closure; finalization in one D1 batch; reconciliation; the cap contract; D1 Time Travel and the emergency wipe.
- [ADR 0005: Error-handling convention](./adr-0005-error-handling-convention.md) — One typed AppError shape, one code catalog mapped to i18n keys, a grammY boundary that never leaks report data, the classification of Telegram API failures into unambiguous ones (retried by reverting the post's claim) and ambiguous ones (never re-sent), the cap contract without a 00:05 reschedule, nothing swallowed, and the regression tests that pin it.
- [ADR 0006: Data model and module layout](./adr-0006-data-model-and-module-layout.md) — The MVP tables, all in D1, with their conventions, keys and indexes (no member or reporter identity stored), the report statuses, the module map under src/, which modules are critical paths (src/platforms/ among them, for the link policy), and the tripwire patterns.
- [Critical invariants](./critical-invariants.md) — The eight catastrophic invariants explained: each rule by title, why it exists, and the regression test that pins it, after the amendment of rules 1, 2, 4, 5 and 8 for the seizure threat; the verbatim block lives in CLAUDE.md, synced to AGENTS.md and the devil's invariants file.

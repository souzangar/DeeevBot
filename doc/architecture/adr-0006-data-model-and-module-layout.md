---
type: adr
title: "ADR 0006: Data model and module layout"
description: "The MVP tables in D1 and in the broadcaster's storage, the report statuses, the module map under src/, which modules are critical paths, and the planned tripwire patterns."
status: active
tags: [architecture, adr, data-model, modules, critical-path]
timestamp: 2026-10-28T00:00:00Z
---

# ADR 0006: Data model and module layout

## Context

Q10 of [Planning decisions](../product/planning-decisions-2026-10-28.md).
CLAUDE.md's Architecture map, critical globs and tripwire patterns are
EDIT-ME slots that Phase 2 fills from this record. Catastrophic invariant
1 asks for an approval record that code cannot bypass, invariant 8 for a
deletion path per personal field, and the Free-plan meters
([ADR 0001](./adr-0001-runtime-and-hosting.md)) split state between D1
and the broadcaster Durable Object
([ADR 0004](./adr-0004-storage-and-delivery-ledger.md)).

## Decision

### Tables in D1

- `subscribers(chat_id, locale, subscribed_at, member_checked_at)`
- `reports(id, status, platform, category, url, account_url, comment,
  reporter_chat_id nullable, reporter_ref, merged_into, affected_person,
  created_at, decided_at, decided_by, broadcast_text, link_mode,
  mirror_message_id, scheduled_at, closed_at, outcome)`
- `approvals(report_id, admin_id, approved_at, link_mode,
  recommended_comment, starts_at)`, a separate table so that rule 1 is
  testable: a broadcast must join an approval row.
- `reporter_stats(reporter_ref, open_count, day_count, day,
  rejections_30d, blocked, last_seen)`
- `stats(report_id, category, platform, created_day, decided_day,
  closed_day, outcome, recipients, reported, link_hash)`, the aggregate
  row that outlives the report.

### Tables in the broadcaster's storage

- `broadcast(report_id, cursor_chat_id, sent, failed, status, lease,
  started_at, finished_at)`
- `deliveries(report_id, batch_no, pairs of chat_id/message_id, failed,
  created_at)`
- `marks(report_id, chat_id, marked_at)`

### Statuses

`pending` to `approved` (grace, cancellable: Cancel returns the report to
pending and voids the approval record; the broadcaster re-reads the
report's status at its start alarm instead of trusting a cleared alarm) to
`broadcasting` to `broadcast` to `closed`, `retracted` or `expired`;
`pending` to `rejected`; `pending` to `routed` (suspected CSAM); `pending`
to `merged`. New subscribers with a chat id below the running cursor are
skipped for that report (deterministic, documented in
[Report lifecycle](../product/report-lifecycle.md)).

### Module layout

| Module | Holds |
|---|---|
| `src/telegram/` | bot wiring, handlers, message rendering with previews disabled, the webhook secret check |
| `src/auth/` | the allowlist gate, the membership check |
| `src/review/` | the report state machine, categories and the routing table, approval records, grace and cancel |
| `src/broadcast/` | the engine, the ledger, pacing, retraction, closure, the budget |
| `src/privacy/` | HMAC references, log redaction, the retention job |
| `src/config/` | the zod schema and loaders |
| `src/db/` | the `SqlDb` port, adapters, migrations |
| `src/errors/` | `AppError` and the catalog |
| `src/i18n/` | the `fa` and `en` catalogs |
| `src/platforms/` | URL parsing, per-platform instruction keys |

### Critical globs (Phase 2)

`telegram`, `auth`, `review`, `broadcast`, `privacy`, `config` and `db`
are critical paths; `i18n` and `platforms` are not.

### Tripwire patterns (Phase 2)

`console.(log|error|warn)(` anywhere in `src/`; `forwardMessage` or
`copyMessage`; `getChat(` or `getFile(` on targets; `fetch(` outside the
Telegram API adapter; `JSON.stringify((err|error|e))`.

## Consequences

- Each critical module carries named rules: `telegram` and `auth` rule 2
  and rule 4 (rendering), `review` rules 1, 3 and 7, `broadcast` rules 1
  and 5, `privacy` rules 6 and 8, `config` rule 6, `db` rule 8. The
  domain-auditor reads diffs under these globs against those rules.
- `member_checked_at` caches the membership check made at subscription
  and at intake against the NGO group, where the bot is a plain member in
  privacy mode and never an admin (or against a channel the bot
  administers, if `getChatMember` turns out not to answer for a member
  bot); leaving the chat does not end a subscription. Intake is text-only,
  so `reports` has no media columns and the `forwardMessage` or
  `copyMessage` tripwire has no legitimate hit in `src/`.
- Every new logic file gets a unit test; pure modules run under plain
  node, adapters under the Workers pool
  ([ADR 0002](./adr-0002-language-and-framework.md)).
- The Phase 2 commit fills CLAUDE.md's Architecture map, the critical
  globs file and the tripwire's `BANNED_PATTERNS` from this record.
- `platforms` and `i18n` being outside the critical globs means copy
  changes do not trigger the tripwire; the broadcast renderer in
  `telegram` still owns preview disabling and escaping.

## Alternatives considered

- Folding the approval into `reports` (`decided_by`, `decided_at` only):
  rejected; a separate `approvals` table makes rule 1 a join the engine
  cannot skip.
- Keeping "I reported it" marks and the ledger in D1: rejected, the D1
  rows-written meter (ADR 0004).
- A flat `src/` without module boundaries: rejected; the critical globs
  and the tripwire need stable paths.

## Status

Accepted 2026-10-28.

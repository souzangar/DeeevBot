---
type: adr
title: "ADR 0006: Data model and module layout"
description: "The MVP tables, all in D1, with their conventions, keys and indexes (no member or reporter identity stored), the report statuses, the module map under src/, which modules are critical paths (src/platforms/ among them, for the link policy), and the tripwire patterns."
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
deletion path per personal field. On 2026-10-28, during unit U1b, the
owner narrowed the scope: no direct-message broadcasts and no member or
reporter identity in storage; an approved report is posted once into a
configured channel owned by the keyholder (`BROADCAST_CHAT_ID`),
retraction and closure edit that post, and "I reported it" is a counter
([Threat model: seizure](../product/threat-model-seizure.md)). D1 is
therefore the only store
([ADR 0004](./adr-0004-storage-and-delivery-ledger.md)).

## Decision

### Conventions

The DDL is authoritative: `migrations/0001_init.sql`, pinned by
`test/support/expected-schema.ts` on node:sqlite and on D1 (columns, CHECK
constraints, keys, indexes and the trigger). A time
(`*_at`) is INTEGER milliseconds since the epoch, a day (`day`, `*_day`,
`last_seen`) is TEXT `YYYY-MM-DD` in UTC, a flag is 0 or 1, a JSON column
is TEXT. Report, approval and job ids are 20 random lowercase letters
(`src/db/ids.ts`, about 94 bits; callback data must be neither forgeable
nor enumerable), and every id column refuses another shape. A reporter
reference, a draft key and a link hash are 64 lowercase hex characters, so
a raw Telegram id or URL cannot be stored there as is; that the value is
the keyed one is tested where it is written. Every table but
`reports` is WITHOUT ROWID: an insert writes one row instead of two, and a
NULL key is refused rather than turned into a fresh rowid. A personal
field is nullable wherever
[Retention and minimisation](../product/retention-and-minimisation.md)
nulls it instead of deleting its row.

The store holds no member or reporter identity: there is no subscriber
table, a reporter is known only by the keyed reporter reference (an
HMAC-SHA-256 of the Telegram id, `src/privacy/reporter-ref.ts`), and the
"I reported it" presses are a count, never a list. The only Telegram ids
stored are the allowlisted admins' and keyholders' own ids (both
deployment configuration: `approvals.admin_id`, `reports.decided_by`,
`admin_prompts.admin_id` and `admin_prompts.chat_id`, where a keyholder's
`/retract` prompt stores the keyholder's) and message ids.

### Tables in D1

- `drafts(draft_key PK, step, url, platform, account_url, category,
  affected_person, comment, locale, created_at, updated_at)`: the intake
  conversation, keyed by the reporter reference of the chat, never the chat
  id. No message id is kept: each reporter message is deleted on receipt by
  the handler that processed it. Deleted on submit, on /cancel and after 24
  hours.
- `reports(id PK, status, platform, category, url, account_url, comment,
  affected_person, reporter_ref, merged_into, link_hash, created_at,
  decided_at, decided_by, rejection_reason, broadcast_text,
  correction_text, link_mode, card_message_id,
  status_message_id, post_message_id, posting_started_at, posted_at,
  presses, alert_sent_at, needs_attention, data_deleted_at, closed_at,
  outcome)`. The post job claims a report by one conditional update
  (`approved` to `posting`, exactly one row changed): the claim binds the
  approval's random id, the lockdown and halted keys and the pause in one
  statement, so two overlapping cron runs never post twice;
  `posting_started_at` is written before the post is sent and
  `post_message_id` with `posted_at` after it, so a report is posted at
  most once. The schema refuses a `posted_at` without an earlier
  `posting_started_at`, a `posted` row without `posted_at`, two reports
  with the same `post_message_id` (the post job's write, or the
  human-supplied id `/attach` records), and, by a trigger, a status update
  into `approved` or `posting` while the report has no un-voided approval.
  `presses` counts the "I reported it" presses.
  `comment` and `affected_person` serve the review only and are nulled at
  the decision. `correction_text` is written before the status change to
  `retracting`, so a lost edit job is rebuilt from the row; the "other"
  category uses a fixed instruction block, so no admin-written instructions
  are stored; `alert_sent_at` is the once-only alert marker;
  `needs_attention` flags a post that started without an id stored;
  `data_deleted_at` marks a completed finalization; `link_hash` is the keyed
  hash of the normalised reported URL (the post URL when there is one, else
  the account URL). A merged row references its primary and goes with it.
- `approvals(report_id PK, approval_id UNIQUE, admin_id, approved_at,
  link_mode, recommended_comment, starts_at, voided_at)`, a separate table
  so that rule 1 is a join: the post derives from an un-voided approval
  row, and the row is the schedule ("approved, not voided, `starts_at`
  reached"). `approval_id` is a random id that every approval and every
  re-approval writes afresh; the post job carries the one it was enqueued
  for and its claim binds it, so a timestamp is never the key and a job of
  a cancelled approval never posts under a re-approval. An approval cannot
  start before it was given; Cancel sets `voided_at`, and a re-approval
  upserts over the voided row with a new `approval_id`.
- `admin_prompts(chat_id, prompt_message_id, admin_id, report_id, kind,
  link_mode, created_at)`, keyed `(chat_id, prompt_message_id)` because
  message ids are per chat: the force-reply prompts awaiting an admin's
  or a keyholder's reply (the recommended comment, the retraction text);
  deleted on completion and after 24 hours.
- `reporter_stats(reporter_ref PK, open_count, day, day_count,
  rejections_30d, blocked, last_seen)`.
- `counters(day, key, count)`, keyed `(day, key)`: the global non-member
  cap, the day's presses against `MARKS_PER_DAY` (a report's own presses,
  `reports.presses`, are capped by `MARKS_PER_REPORT`), other daily counts.
- `stats(report_id PK, category, platform, created_day, decided_day,
  closed_day, outcome, presses, link_hash)`, the aggregate row that
  outlives the report.
- `jobs(id PK, kind, report_id, due_at, payload, attempts, created_at)`
  with `UNIQUE(kind, report_id)`, kinds `post` and `edit` only: the work
  the one-minute cron drains. An enqueue never resets an existing job of
  its kind and report, which keeps its payload, attempts and due time; a
  job goes on completion and with its report.
- `meta(key PK, value)`: `schema_version` (set by each migration that
  changes the schema; 1 for `0001_init.sql`), `halted` (/halt),
  `paused_until` (the global 429 pause) and `lockdown` (the keyholder's
  switch, set by `/lockdown` and cleared only by `/unlock` from a
  keyholder; the `LOCKDOWN` secret is its override outside D1). An absent
  key reads as its default; a value is an integer or a text of at most 64
  characters.

`approvals`, `admin_prompts` and `jobs` reference their report, and a
merged row its primary, all `ON DELETE CASCADE`; foreign keys are enforced
on D1 and on node:sqlite alike. The indexes are those the flows query by,
every index row costing a D1 row written: reports by `(status,
data_deleted_at)`, by `link_hash`, by `reporter_ref`, by `merged_into`
(merged rows only) and by `post_message_id` (unique, posted rows only);
un-voided approvals by `starts_at`, and the approval ids' uniqueness; a
report's prompts; the aggregate by `link_hash`; the jobs by `due_at`, the
cron's due query. The primary key serves the counters by day.

### Statuses

`pending` to `approved` (grace, cancellable: Cancel returns the report to
pending and voids the approval record; the post is gated on the approval
row and its claim binds the approval's id, so a post job of a cancelled
approval does nothing) to `posting` (the
post is being made) to `posted`, then `closing` (to `closed`, or to
`expired` 90 days after the post) or `retracting` (to `retracted`), the
terminal status written only by the edit job's success; `pending` to
`rejected`; `pending` to `routed` (suspected CSAM); `pending` to `merged`;
a pending report expires after 30 days (`expired`, outcome
`no_decision`). The schema refuses any other status.

### Module layout

| Module | Holds |
|---|---|
| `src/telegram/` | the Bot API adapter with the one transformer (previews off and HTML parse mode on every send and edit), bot composition and the error boundary, the webhook boundary with the secret check, render helpers, the intake, review, press and command handlers, the admin free-text validator, keyholder alerts |
| `src/auth/` | `isAdmin`, `isKeyholder`, the membership check with the member definition, the two-layer lockdown check |
| `src/review/` | categories and routing as data, the report state machine with its conditional updates, approval records, grace and cancel, the admin prompts |
| `src/broadcast/` | the post and edit jobs, `tick()`, reconciliation, the link allowlist check at render |
| `src/privacy/` | HMAC references, log redaction, the retention job, the emergency wipe |
| `src/config/` | the zod schema and loaders (a load whose `KEYHOLDER_IDS` and `ADMIN_IDS` overlap is refused) |
| `src/db/` | the `SqlDb` port and its D1 and node:sqlite adapters, the Node migrations runner, the random ids |
| `migrations/`, at the repository root | the D1 SQL migrations (wrangler's `migrations_dir`) |
| `src/errors/` | `AppError` and the catalog |
| `src/i18n/` | the `fa` and `en` catalogs |
| `src/platforms/` | URL parsing, the link policy (the exact hosts a post may link to), per-platform instruction keys |
| `src/worker.ts`, `src/node.ts`, `src/clock.ts` | the Worker entry (`fetch` and `scheduled`), the Node port's entry (long polling and the minute loop over node:sqlite), the clock port |

### Critical globs (Phase 2)

`.claude/devil/critical-globs.conf` holds one glob per critical path:
`*src/telegram/*`, `*src/auth/*`, `*src/review/*`, `*src/broadcast/*`,
`*src/privacy/*`, `*src/config/*`, `*src/db/*`, `*migrations/*` (the root
migrations directory), `*src/platforms/*` (the link policy lives there:
rule 4), `*src/worker.ts` (the Worker entry) and `*src/node.ts` (the Node
port's entry, when it lands). `src/errors/` and `src/i18n/` are not
critical.

### Tripwire patterns (Phase 2)

`BANNED_PATTERNS` in `.claude/hooks/critical-path-tripwire.sh` is checked
on the lines added to a file the critical globs match, test files
(`*.spec.*`, `*.test.*`, `*_test.*`) skipped:
`console.(log|error|warn|info|debug)(`; `forwardMessage(s)(` and
`copyMessage(s)(`; `getChat(` and `getFile(`; a bare `fetch(` (at the
start of a line, or not preceded by a dot or an identifier character),
plus `globalThis.fetch(`, `self.fetch(` and `window.fetch(`;
`JSON.stringify(` of `err`, `error`, `e`, `ctx` or `update`;
`disable_web_page_preview`; and `is_disabled: false`. A `console` call
anywhere in `src/` fails the build through eslint's `no-console`, an
error; the tripwire covers only the critical globs.

## Consequences

- Each critical module carries named rules: `telegram` and `auth` rule 2
  and rule 4 (rendering), `review` rules 1, 3 and 7, `broadcast` rules 1
  and 5, `privacy` rules 6 and 8, `config` rules 2 and 6, `db` and the
  root `migrations/` rule 8, `platforms` rule 4. The domain-auditor reads diffs under these
  globs against those rules.
- Membership of the membership chat, which sets a reporter's intake
  limits, is checked with `getChatMember` against the NGO group, where the
  bot is a plain member in privacy mode and never an admin (or against a
  channel the bot administers, if `getChatMember` turns out not to answer
  for a member bot); its answer is never stored, as no member identity is.
  Intake is text-only, so `reports` has no media columns and the
  `forwardMessage` or `copyMessage` tripwire has no legitimate hit in
  `src/`.
- Every new logic file gets a unit test; pure modules run under plain
  node, adapters under the Workers Vitest plugin, `@cloudflare/vitest-plugin`
  ([ADR 0002](./adr-0002-language-and-framework.md)).
- The Phase 2 commit fills CLAUDE.md's Architecture map, the critical
  globs file and the tripwire's `BANNED_PATTERNS` from this record.
- `i18n` being outside the critical globs means copy changes do not
  trigger the tripwire; `platforms` is inside them because the link policy
  lives there; the post renderer in `telegram` still owns preview
  disabling and escaping.

## Alternatives considered

- Folding the approval into `reports` (`decided_by`, `decided_at` only):
  rejected; a separate `approvals` table makes rule 1 a join the posting
  code cannot skip.
- A subscriber table, a delivery ledger and a list of who pressed "I
  reported it", in D1 or in a Durable Object: dropped with the owner's
  scope change; each would store member identities, which a seizure of
  the deployment would expose (ADR 0001, "Threat model: seizure").
- STRICT tables: not used; the column checks above hold the shapes that
  matter, and nothing here depends on a feature whose support on D1 in
  production was not verified.
- A flat `src/` without module boundaries: rejected; the critical globs
  and the tripwire need stable paths.

## Status

Accepted 2026-10-28.

Amended 2026-10-28 (Phase 2): config rules, migrations location, entry
files and tripwire patterns aligned with the implementation.

Amended 2026-10-28 (Phase 3, unit U1b): the data model as built after the
owner's scope change of the same day: D1 only, no member or reporter
identity (`drafts` keyed by the reporter reference, no subscriber table,
no reporter chat id, the presses a count), the single post with its
at-most-once columns, `jobs` with the kinds `post` and `edit`, `meta`,
`voided_at` on the approval, the column conventions; then, from the plan's
revision 8, the statuses `posting` and `posted`, no message ids on
`drafts`, and `meta.lockdown`; then, from the devil's round on the plan,
the statuses `closing` and `retracting`, no `custom_instructions`, the
review-only fields nulled at the decision, `src/platforms/` a critical
path, `approvals.approval_id` and a unique `reports.post_message_id`;
then, from the domain audit of the unit, the check that a `posted` row
carries `posted_at`, the trigger that refuses an `approved` or `posting`
status without an un-voided approval, and `meta.value` bounded to an
integer or a short text; then, from the plan's closure, the module map's
final shape: `src/auth/` with `isKeyholder` and the lockdown check,
`src/broadcast/` with `tick()` and reconciliation, `src/privacy/` with
the emergency wipe, the entries and the clock.

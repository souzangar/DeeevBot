---
type: adr
title: "ADR 0004: Storage, scheduling and the single post"
description: "D1 as the only store behind a SqlDb port with plain SQL migrations; no Durable Object, no delivery ledger, no pacing; a jobs table drained by a one-minute cron, the approval row as the schedule; each approved report posted once into the channel, at most once, through one claim statement, with the two failure classes and the verified /attach and /repost; edits at retraction and closure; finalization in one D1 batch; reconciliation; the cap contract; D1 Time Travel and the emergency wipe."
status: active
tags: [architecture, adr, storage, d1, scheduling, broadcast]
timestamp: 2026-10-28T00:00:00Z
---

# ADR 0004: Storage, scheduling and the single post

The file keeps its first name, `adr-0004-storage-and-delivery-ledger.md`,
so that every link to it still resolves; the delivery ledger it once
decided is gone.

## Context

The Free-plan meters in [ADR 0001](./adr-0001-runtime-and-hosting.md)
decide where state may live: D1 rows written are capped at 100,000 per
day with index rows and deletes counting; an invocation has 50
subrequests, D1 queries among them; Workers CPU is 10 ms per invocation;
Cron Triggers are limited to five per account. Catastrophic invariants 1
(approval record with a start time) and 8 (deletion at closure) bind the
design. On 2026-10-28, during unit U1b, the owner narrowed the scope: the
bot sends no direct-message broadcasts and stores no member or reporter
identity; an approved report is posted once into a configured channel
owned by the keyholder (`BROADCAST_CHAT_ID`), retraction and closure edit
that post, and "I reported it" is a counter, not a list; reporters get no
decision message. What a seizure of the deployment and of the admins
would yield is the reason (ADR 0001, "Threat model: seizure";
[Threat model: seizure](../product/threat-model-seizure.md)).

## Decision

### Storage

- Cloudflare D1 is the only store, behind the `SqlDb` port
  (`src/db/sql.ts`): `run`, `all`, `first`, and `batch`, the only
  multi-write primitive, one transaction (D1's `batch`; `BEGIN ... COMMIT`
  on node:sqlite). It holds `drafts`, `reports`, `approvals`,
  `admin_prompts`, `reporter_stats`, `counters`, `stats`, `jobs` and `meta`
  ([ADR 0006](./adr-0006-data-model-and-module-layout.md)). There is no
  Durable Object, no delivery ledger and no subscriber table.
- Plain SQL migrations in `migrations/`, applied by wrangler on Cloudflare
  and by `src/db/migrate.ts` on the Node port, each file once, inside a
  transaction with its record. The Node adapter runs the same SQL on
  node:sqlite ([ADR 0002](./adr-0002-language-and-framework.md)).
- No value is ever written into SQL text: a statement is `SqlText`, which
  only the `sql` tag mints and which refuses an interpolation, and every
  value is bound. Every adapter refuses, before running a statement, the
  shapes D1 refuses and node:sqlite would accept silently (a parameter
  count that differs from the placeholders, a second statement in one
  text, more than 100 parameters); the workers tier applies the
  migrations to D1 itself and checks that it builds the same tables.
- D1 keeps a 30-day point-in-time history of the database (Time Travel)
  that the account holder can restore; the MVP keeps no dumps of its own.
  The emergency wipe is a documented `wrangler d1 execute` script that
  deletes every row of every table except `stats` and `meta`, run by the
  keyholder at least a minute after setting lockdown (in-flight
  `waitUntil` handlers may write for up to 30 seconds); it defends
  against the seized admins, not against a seized Cloudflare account,
  whose answer is `wrangler d1 delete` and recreate, the one step that
  also removes the history. When D1 refuses queries (a daily cap
  exhausted, possibly by the attacker), the `LOCKDOWN` secret still stops
  all activity without a query and `wrangler d1 delete` still works. With
  no plaintext ids in D1, the 30-day exposure is references, URLs and
  comments
  ([Retention and minimisation](../product/retention-and-minimisation.md)).

### Scheduling

- One Cron Trigger fires every minute (set with the scheduling unit, U5):
  `tick()` drains the `jobs` table (the due jobs by due time, at most one
  `post` and a bounded number of `edit` jobs per run, each one Bot API
  call), then, by the minute, runs reconciliation every 15th minute, the
  retention job at 00:15 UTC and the monthly snapshot on the first day at
  06:00 UTC; 1,440 invocations a day, each a few subrequests. On the Node
  port an in-process timer runs the same function. Jobs are unique per
  kind and report, kinds `post` and `edit`; an enqueue never resets an
  existing job, which keeps its payload, attempts and due time.
- The approval row is the schedule. Approving writes the approval row,
  under a fresh random `approval_id` and with `starts_at` at the end of the
  grace period, and a `post` job due then, carrying that `approval_id`;
  the job posts only for a report that is still approved, whose approval
  is the job's own (by `approval_id`), is not voided and has reached
  `starts_at`, so rule 1 is a query, a Cancel within the grace (which voids
  the approval) leaves the job nothing to do, and a re-approval, which
  writes a new `approval_id`, is never posted by the cancelled approval's
  job. The schema itself refuses a status update into `approved` or
  `posting` while the report has no un-voided approval (a trigger).
- `meta.lockdown`, set by a keyholder's `/lockdown` and cleared only by
  `/unlock`, and the `LOCKDOWN` secret, the keyholder's override, stop
  every job but a keyholder's `/retract`; a locked-down tick alerts the
  keyholders once (`meta.lockdown_alerted_at`) and still runs retention,
  which reduces exposure, and `/lockdown` triggers an immediate retention
  pass. `meta.halted` (/halt) holds the posts and the closure edits;
  retraction edits still run, since they remove harm. `meta.paused_until`,
  the global 429 pause, holds every job send (post and edit) until it
  passes, because edits, alerts and intake share the bot's API limits;
  nothing is retried in the invocation.
- Reconciliation, every 15th minute: a `post` job past due by two periods
  with no progress (a `posting` row whose job is still present and within
  its window is in progress, not stuck), a `posting` row without an id
  past two minutes, and a `closing` or `retracting` row whose edit job is
  missing are re-enqueued or alerted; a terminal status with
  `data_deleted_at` null (only possible if the finalization batch itself
  failed after the edit) is finalized; `needs_attention` rows are alerted
  once (`alert_sent_at`). Reconciliation never finalizes a `closing` or
  `retracting` row. Every alert goes to the keyholders by direct message
  and, when not locked down, to the venue too; a failed keyholder alert
  is retried by the next reconciliation, never dropped.
- There is no pacing and no batching: one post per approved report.

### The single post

- A report is posted at most once. The post job claims the report by one
  conditional update (`approved` to `posting`, exactly one row changed):
  the claim binds the approval's random id, the lockdown and halted keys
  and the pause in one statement, so two overlapping cron runs never post
  twice, and a run that read a since-cancelled approval, or that a
  lockdown overtook, claims nothing. It writes `posting_started_at` before
  the send and `post_message_id` with `posted_at` (status `posted`) after
  it; `post_message_id` is unique, so no two reports ever hold the same
  post, whether the id comes from the job's write or from a human after
  the alert below. Only unambiguous failures are retried: a 429 reverts
  the claim (`posting` to `approved`, `posting_started_at` cleared) in
  the same batch that reschedules the job for now plus `retry_after` and
  sets `meta.paused_until`; a 400 or 403 (no post rights, chat not found)
  reverts the claim the same way, abandons the job, sets
  `needs_attention` and alerts. A timeout, a network error or a 5xx is
  ambiguous (Telegram may have accepted the send): the report stays
  `posting` without an id, is never re-sent automatically, and is alerted
  once; so is a `posting_started_at` older than two minutes with no
  `post_message_id`, a run cut between the send and the write
  (`alert_sent_at`, `needs_attention`). A human then checks the channel:
  if the post is there, `/attach <id> <message id or t.me/c/... link of
  the broadcast channel>` records `post_message_id` and moves the report
  to `posted`, after verification (the bot calls `editMessageReplyMarkup`
  on that message with this report's own keyboard and accepts only if the
  returned message carries the callback data `mark:<this report id>`); if
  it is not, `/repost <id>` (admitted only while no `post_message_id`
  exists; admins only, never under lockdown) clears `posting_started_at`,
  returns the report to `approved` and re-enqueues. Admins and keyholders
  may `/attach`, under lockdown keyholders only. There is no blind "Post
  again".
- The post carries the reviewed links the category's routing allows and
  admin-authored text, with link previews disabled (rule 4), and an "I
  reported it" button. A press increments `reports.presses` and the day's
  count in `counters`, two D1 writes, at most `MARKS_PER_REPORT` presses per
  report and `MARKS_PER_DAY` a day; beyond either cap the button still
  answers and nothing is written. Nobody's id is kept.
- Retraction and closure each set the report to `retracting` or `closing`
  (the 90-day expiry too) and enqueue an `edit` job that edits the post in
  place: retraction to `reports.correction_text` (written before the
  status change, so a lost job is rebuilt from the row), closure to the
  outcome. Only the edit job's success writes the terminal status
  (`retracted`, `closed` or `expired`). "Message is not modified" and "message to edit not found" are
  non-errors; any other permanent failure is alerted, never swallowed.

### Finalization and the cap contract

- Finalization is one D1 batch: the aggregate row in `stats` (category,
  platform, day-level dates, outcome, presses, keyed link hash) is
  upserted, every personal field of the report and its merged rows is
  nulled, its approval, prompts and jobs are deleted, and
  `data_deleted_at` is set. It runs once the closure or retraction edit has
  succeeded; an edit that cannot be made is alerted, never swallowed, and
  leaves the report in `closing` or `retracting`. Pending expiry,
  rejection and routing finalize without an edit. The retention job deletes the finalized row afterwards.
- The cap contract: a cron run that meets a Free-plan cap error stops
  without writing; the next minute's run picks the due work up again once
  the 00:00 UTC reset has passed, and the keyholders (and the venue when
  not locked down) are alerted once. A cap
  error between a post's send and its id write is the alert case above,
  never a retry.

## Consequences

- D1 writes per report stay small: a few dozen rows over its lifecycle
  (the report, its approval, its prompts and jobs, the aggregate row and
  the index rows), plus one row per "I reported it" press.
- No idempotency ledger is needed: the post is at most once by
  construction, and an edit repeated after a cut run is a "not modified"
  non-error.
- The Durable Object meters no longer apply; the Workers request meter
  (webhook updates, presses, 1,440 cron runs a day) and D1's are the ones
  that count.
- The Node port runs the same jobs function on a timer, over node:sqlite.
- Open measurement for the MVP plan: the per-update CPU of the webhook
  path (configuration memo, HMAC, grammY parse, render), confirmed once by
  a deployed probe.

Tests this decision requires: the post job posts nothing for a pending,
cancelled or not-yet-started approval, nor under a re-approval for a job
of the cancelled approval (the claim binds the `approval_id`); a status
update into `approved` or `posting` without an un-voided approval is
refused; a post is never sent twice
(`posting_started_at` before the send, the alert for a missing id, no
automatic retry); an enqueue never resets a progressed job; retraction and
closure edit the post and never send a new message; finalization leaves
only the aggregate row; a press after closure writes nothing; a cap error
leaves the store unchanged; two ticks racing on one due job post once; a
timed-out send is never re-sent; a 429 reschedules without re-sending; a
locked-down tick sends nothing; an attach of another report's message id
is refused, as is an attach of a message the bot did not send; `/attach`
then `/retract` edits the attached message. The storage-level ones are
`test/invariants/approval-record.test.ts`,
`test/invariants/storage-retention.test.ts` and
`src/db/d1-schema.test.ts`; the rest land with the units that run them.

## Alternatives considered

- A broadcaster Durable Object with alarms, a delivery ledger, bucketed
  marks and a paced direct-message fan-out to subscribers: this record's
  first decision, built in unit U1b and removed the same day with the
  owner's scope change, because every one of those tables held member
  identities.
- Retrying a post whose message id was not stored, or a blind "Post
  again" command: rejected; the first send may have succeeded, so a
  second is a second post; the alert lets a human decide, with the
  verified `/attach` or `/repost`.
- Cloudflare Queues: not used; the Free tier allows 10,000 operations per
  day, and a minute cron over a D1 table needs none.
- Retrying 429 inside the invocation: rejected; it bursts against the
  flood limit and spends CPU; pausing every job is the defined behaviour.

## Status

Accepted 2026-10-28.

Amended 2026-10-28 (Phase 3, unit U1b): after the owner's scope change,
retitled in substance from "Storage and the delivery ledger" to "Storage,
scheduling and the single post": D1 only, no Durable Object, no ledger, no
pacing; the jobs table drained by a one-minute cron, the approval row as
the schedule; the single post made at most once and edited at retraction
and closure; finalization in one D1 batch; the cap contract; then, from
the plan's revision 8, the post claimed by a conditional update to
`posting` and the two lockdown layers; then, from the devil's round on the
plan, `closing` and `retracting`, the terminal status written only by the
edit job's success, the claim bound to the approval's random
`approval_id`, and `post_message_id` unique; then, from the domain audit
of the unit, the trigger that refuses an `approved` or `posting` status
without an un-voided approval; then, from the plan's closure (revisions
R10 and R11), the two failure classes with the 429 revert of the claim,
the verified `/attach` and `/repost`, reconciliation's scope, the
keyholder alerts, Time Travel and the emergency wipe.

---
type: adr
title: "ADR 0004: Storage and the delivery ledger"
description: "D1 behind a SqlDb port with plain SQL migrations, one broadcaster Durable Object with alarms driving a pure step(), its SQLite storage holding the delivery ledger and marks, batching and pacing, the 429 pause, budgets and quota exhaustion, and retraction and closure through stored message ids."
status: active
tags: [architecture, adr, storage, d1, durable-objects, broadcast]
timestamp: 2026-10-28T00:00:00Z
---

# ADR 0004: Storage and the delivery ledger

## Context

The Free-plan meters in [ADR 0001](./adr-0001-runtime-and-hosting.md)
decide where state may live: D1 rows written are capped at 100,000 per
day with index rows and deletes counting; Durable Object SQLite rows
written have their own 100,000; an invocation has 50 subrequests, of
which D1 queries count and DO storage calls do not; Workers CPU is 10 ms
per invocation against 30 s in a DO; six simultaneous outgoing
connections. Catastrophic invariants 1 (approval record with a start
time), 5 (idempotent by construction) and 8 (deletion at closure) bind the
design.

## Decision

- Cloudflare D1 sits behind a thin `SqlDb` port with plain SQL migrations
  and holds `subscribers`, `reports`, `approvals`, `reporter_stats` and
  `stats` ([ADR 0006](./adr-0006-data-model-and-module-layout.md)). The
  Node adapter runs the same SQL on a local SQLite file.
- The broadcast engine is a pure `step()` driven by one Durable Object,
  the broadcaster, with alarms on Cloudflare, and by a loop on Node. The
  broadcaster's SQLite storage holds `broadcast` (report id, cursor chat
  id, sent, failed, status, lease, started and finished times),
  `deliveries` (report id, batch number, pairs of chat id and message id,
  failed, created time) and `marks` (report id, chat id, marked time).
- Progress and the next alarm commit together after every batch. One
  broadcast runs at a time and only the runner holding its lease advances
  it, so a retry after a partial failure resumes from the ledger and can
  repeat at most one batch.
- Start: the approval record's `starts_at` schedules the start alarm. At
  that alarm the broadcaster re-reads the report's status instead of
  trusting a cleared alarm, proceeds only if the report is still approved
  and never before `starts_at`, posts the mirror message first (storing
  `mirror_message_id`), then fans out to subscribers.
- Batch: 35 sends within the 50-subrequest cap (the D1 reads of the
  subscriber page and a margin fill the rest), paced to 25 messages per
  second in total; a batch takes about 2 s. The cursor walks subscribers
  in chat-id order; a subscriber whose chat id is below the running
  cursor is skipped for that report.
- 429: persist progress and reschedule the step for now plus
  `retry_after`; the whole broadcast pauses, with no in-invocation retry
  burst.
- 403 blocked, 400 chat not found and user deactivated unsubscribe the
  user and count as non-deliveries, not errors. 5xx and network errors
  retry with bounded backoff, then are recorded as a failed delivery for
  that recipient; a failure never aborts the batch.
- A configured per-day recipient budget is checked before the start and
  shown on the approval card. On a platform cap error (a storage failure
  included) the broadcaster stops in a resumable state, reschedules for
  00:05 UTC plus jitter and alerts the admin chat once; a stall-detector
  cron re-alerts.
- Retraction and closure act through the stored message ids: each
  delivered message is edited in place, or deleted where younger than 48
  hours, and the mirror post is edited. Notices queue behind a running
  broadcast, so a retraction completes within the hour.
- "I reported it" presses write `marks` in the broadcaster (one DO request
  each). At closure the ledger and marks are deleted and their counts are
  folded into the aggregate row.

## Consequences

- D1 writes per broadcast stay constant (status changes, the approval
  row, the aggregate row) instead of growing with the recipient count;
  the DO absorbs about 1,430 batch rows and as many alarms per 50k
  broadcast.
- Idempotency is a property of the ledger, not of a counter: the bound is
  one repeated batch, and no number appears in the rule.
- A webhook flood exhausts the Workers request meter, not the DO request
  meter, so a running broadcast continues.
- The Node port plays the DO's role with a loop and the same `step()`
  over a SQLite ledger.
- Open measurements for the MVP plan: the subrequest and CPU cost of a
  35-send batch in a DO alarm on Free, and whether a DO storage write and
  `setAlarm` commit atomically.

Tests this decision requires: a resumed broadcast never re-sends to a chat
id the ledger records as delivered; the start alarm does nothing for a
report that is no longer approved or whose `starts_at` is in the future;
a 429 reschedules without re-sending; a cap error leaves a resumable
state; closure deletes `deliveries` and `marks` for the report.

## Alternatives considered

- Per-recipient rows in D1: rejected. Fifty thousand recipients with
  inserts, index rows and deletes would consume the 100,000 D1 rows
  written per day in a single broadcast.
- Cloudflare Queues: not used; the Free tier allows 10,000 operations per
  day.
- Retrying 429 inside the invocation: rejected; it bursts against the
  flood limit and spends CPU; pausing the whole broadcast is the defined
  behaviour.
- Telegram paid broadcasts to raise the per-second limit: not available to
  the NGO; they require a Stars balance, with conflicting thresholds on
  Telegram's own pages (see
  [Telegram Bot API notes](../reference/telegram-bot-api-notes.md)).

## Status

Accepted 2026-10-28.

---
type: rule
title: "Retention and minimisation"
description: "What the bot stores about reports, reporters and subscribers, for how long, which deletion path removes each field, what survives as an aggregate row, and what never reaches logs or backups."
status: active
tags: [product, rule, retention, privacy, minimisation]
timestamp: 2026-10-28T00:00:00Z
---

# Retention and minimisation

The owner's policy, verbatim: "we don't need keep all of the data for a
long time, when the channel is closed, we can report to users who seen it
and report it and delete them in our db and only count how many of what
we reported." This rule makes it concrete (Q5 in
[Planning decisions](./planning-decisions-2026-10-28.md)); catastrophic
invariant 8, "Reports leave only counts behind", pins it. The tables named
below are defined in
[ADR 0006](../architecture/adr-0006-data-model-and-module-layout.md).

## The reporter reference

- The reporter's Telegram id is kept only until the decision notice is
  delivered or abandoned (bounded retries). It is then replaced by an
  HMAC-SHA-256 of the id under a server key: the "reporter reference".
- The reference drives rate limits, rejection counts and blocks without
  identifying anyone from the database alone.
- The operator holding the key could re-identify a reference, so the key
  lives only in the deployment's secret store and is never exported.
- The review card shows the reference, never the id, username or name.

## Deletion schedule

| What | Where | Deleted |
|---|---|---|
| `url`, `account_url`, `comment`, `broadcast_text`, admin notes, `link_mode`, `mirror_message_id` and the rest of the report row | D1 `reports` | at closure |
| the approval record (`admin_id`, `approved_at`, `link_mode`, `recommended_comment`, `starts_at`) | D1 `approvals` | at closure, with the report |
| the delivery ledger: `broadcast` (cursor, counts, lease, times) and `deliveries` (batch pairs of chat id and message id) | broadcaster storage | at closure |
| "I reported it" marks (`report_id`, `chat_id`, `marked_at`) | broadcaster storage | at closure |
| `reporter_chat_id` on the report row | D1 `reports` | replaced by `reporter_ref` once the decision notice is delivered or abandoned |
| a rejected report's row | D1 `reports` | 30 days after rejection; the reference and outcome stay in the reporter's counters |
| a routed (suspected CSAM) report's `url` and `comment` | D1 `reports` | at routing, at once; the aggregate row and keyed link hash remain |
| reporter counters (`open_count`, `day_count`, `day`, `rejections_30d`, `last_seen`) | D1 `reporter_stats` | expire after 90 days without activity; a `blocked` entry persists |
| the subscriber row (`chat_id`, `locale`, `subscribed_at`, `member_checked_at`) | D1 `subscribers` | on `/stop` or on a block |
| the review card | the admin review venue | after the decision, at any age |
| the reporter's intake message | the reporter's chat | after the acknowledgement |

Closure means an admin marks "taken down", "closed without result" or
"retracted", or 90 days (configurable) pass since the broadcast
("expired"). When the remaining fields of a routed report's row go is not
fixed by the decision and is set in the MVP plan (amendable).

Every deletion path above is covered by a test (invariant 8).

## What survives

One aggregate row per report in D1 `stats`: category, platform, day-level
created, decided and closed dates, outcome, recipients count, "I reported
it" count, and the keyed link hash. The hash lets the admin's card for a
later report of the same target say "previously reported, outcome X"; the
reporter is never told.

## Chat hygiene

- Reporter side: after acknowledging, the bot deletes the reporter's intake
  message from their chat, so the URL leaves the reporter's device history;
  `/start` says so.
- Admin side: the review venue is a private supergroup with the bot as an
  admin holding `can_delete_messages`, so review cards are deleted after
  the decision at any age; auto-delete is enabled on the venue; reported
  URLs in cards are rendered as non-tappable code text.

## Logs and third parties

Logs never contain URLs, comments, reporter ids or subscriber ids. A
redacting logger enforces this, and a regression test uses a real
GrammyError, whose payload carries the outgoing text and chat id, to prove
the boundary never leaks either. Workers observability and `wrangler tail`
are logs. No third-party error tracker, telemetry or AI service ever
receives report data. Open: whether Workers invocation logs record request
headers, which would put the webhook secret in a log if observability is
enabled.

## Backups and recovery

No backup ever contains per-user tables. The MVP keeps no database dumps.
A monthly stats snapshot (aggregate rows only) is posted to the admin
chat. The recovery story after a lost deployment is re-subscription,
announced in the mirror chat, plus re-submission of open reports; nothing
in it may depend on an account that is already suspended (see
[ADR 0001](../architecture/adr-0001-runtime-and-hosting.md)).

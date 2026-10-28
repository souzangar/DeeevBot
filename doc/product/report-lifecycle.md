---
type: spec
title: "Report lifecycle"
description: "The report state machine: states, transitions, who triggers each, what is recorded, and what the reporter is told at each step."
status: active
tags: [product, lifecycle, state-machine, review, broadcast]
timestamp: 2026-10-28T00:00:00Z
---

# Report lifecycle

The states a report passes through, from intake to the aggregate row that
outlives it. Decided on 2026-10-28 (Q3, Q4, Q5 and Q10 in
[Planning decisions](./planning-decisions-2026-10-28.md)); the storage
behind it is in
[ADR 0004](../architecture/adr-0004-storage-and-delivery-ledger.md) and
the tables in
[ADR 0006](../architecture/adr-0006-data-model-and-module-layout.md).

## States

| State | Meaning |
|---|---|
| `pending` | submitted, waiting for an admin decision |
| `approved` | approved; the 5-minute grace period runs; Cancel is available |
| `broadcasting` | the broadcaster is delivering |
| `broadcast` | every subscriber has been attempted; waiting for closure |
| `closed` | an admin marked "taken down" or "closed without result" |
| `retracted` | an admin retracted a broadcast report |
| `expired` | 90 days (configurable) passed since the broadcast |
| `rejected` | an admin rejected it |
| `routed` | the admin categorised it as suspected CSAM and routed it |
| `merged` | a second report of a target that is already open |

Transitions: pending to approved (grace, cancellable) to broadcasting to
broadcast to closed, retracted or expired; pending to rejected; pending to
routed; pending to merged. Cancel during the grace returns an approved
report to pending.

## Transitions

| From | To | Trigger | Recorded |
|---|---|---|---|
| intake | `pending` | a reporter sends a link (text only; media and forwarded posts are refused with a reply and deleted) | the report row: platform, category, URL, account URL, comment, reporter chat id, affected-person flag, created_at |
| intake | `merged` | the keyed hash of the normalised URL matches an open target | its own row, `merged_into` the first; every reporter of a merged target is notified of the decision |
| `pending` | `approved` | an allowlisted admin presses Approve; the check is server-side at the press | the approval record: admin id, timestamp, link mode, recommended comment, `starts_at` (the end of the 5-minute grace); the per-day recipient budget is checked before the start and shown on the card |
| `approved` | `pending` | an admin presses Cancel within the grace | the approval record is voided |
| `approved` | `broadcasting` | the broadcaster's start alarm fires at `starts_at`; it re-reads the report's status instead of trusting a cleared alarm, and proceeds only if the report is still approved and never before `starts_at` | the mirror post (its message id stored), then the direct-message ledger as batches commit |
| `broadcasting` | `broadcast` | the cursor passes the last subscriber | sent and failed counts, `finished_at` |
| `broadcast` | `closed` | an admin marks "taken down" or "closed without result" | closure notices to pressers still subscribed; the mirror post edited; data deleted; the aggregate row completed |
| `broadcast` | `retracted` | an admin's retraction command | delivered messages edited in place, deleted where younger than 48 hours; the mirror post edited; the aggregate row keeps "retracted" |
| `broadcast` | `expired` | the nightly retention job, 90 days (configurable) after the broadcast | data deleted; the aggregate row completed |
| `pending` | `rejected` | an admin presses Reject | the rejection counter of the reporter reference; the row is deleted 30 days later |
| `pending` | `routed` | the admin categorises as suspected CSAM | admin id and timestamp; URL and comment deleted at once; the review card deleted; see [categories and routing](./report-categories-and-routing.md) |

### First decision wins

With one or two admins a status change is a conditional update
(`WHERE status = 'pending'`, exactly one row changed). The losing admin's
card is edited to show the outcome. The same conditional update guards
Cancel and the start of the broadcast.

### Grace period, Cancel and /halt

Approval starts a 5-minute grace period; the card carries a Cancel button;
`/halt` pauses all sending for every report until lifted. Both are in the
[operations and security](../guides/operations-and-security.md) runbook.
Notices (retraction, closure) queue behind a running broadcast, one
broadcast at a time, so a retraction completes within the hour rather
than at once.

## What the reporter is told

- At intake: one acknowledgement, identical for a new and a merged report,
  so nobody can probe whether an account was already reported; the bot
  then deletes the reporter's intake message from their chat (so the URL
  leaves the reporter's device history), as `/start` says it will.
- At the decision: a decision notice (approved, rejected, or, for a routed
  report, a neutral acknowledgement carrying the public hotline links).
  The prior outcome of a re-reported target is shown on the admin's card
  only, never to the reporter.
- After the decision notice is delivered or abandoned (bounded retries),
  the reporter's Telegram id is replaced by the keyed reporter reference,
  so the bot holds no way to reach the reporter about the report. A
  reporter who wants the outcome subscribes and presses "I reported it"
  on the broadcast like any member.

## Closure outcomes

An admin closes a broadcast report as "taken down" or "closed without
result", or retracts it; the retention job expires it after 90 days.
Closure sends the outcome by direct message only to users who pressed "I
reported it" on that report and are still subscribed at send time; a
press made from the mirror chat earns no direct message and the outcome
reaches the mirror chat through the edited post. Every closure path
deletes the report's links, comment, broadcast text, admin notes, delivery
ledger and marks, and leaves the aggregate row (see
[Retention and minimisation](./retention-and-minimisation.md)).

## Cursor-skip note for new subscribers

The direct-message fan-out walks subscribers in chat-id order with a
cursor. A user who subscribes while a broadcast is running and whose chat
id is below the running cursor is skipped for that report. This is
deterministic and accepted; the subscriber receives the next report.

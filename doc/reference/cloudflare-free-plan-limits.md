---
type: reference
title: "Cloudflare Free plan limits"
description: "The Free-plan meters that shape div-report's design, with the values used in planning, the source pages and the dates they were read."
status: active
tags: [reference, cloudflare, limits, workers, d1, durable-objects]
timestamp: 2026-10-28T00:00:00Z
---

# Cloudflare Free plan limits

Values as read on 2026-10-28 for
[ADR 0001](../architecture/adr-0001-runtime-and-hosting.md) and
[ADR 0004](../architecture/adr-0004-storage-and-delivery-ledger.md).
Cloudflare revises these pages; re-read the source before relying on a
number and record the date.

## Sources

- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
  (page updated 2026-10-12).
- Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/
  (2026-10-02; the Paid plan's minimum is 5 USD/month).
- D1 pricing: https://developers.cloudflare.com/d1/platform/pricing/
  (rows written include index rows and DELETEs).
- Durable Objects pricing and limits:
  https://developers.cloudflare.com/durable-objects/platform/pricing/ and
  https://developers.cloudflare.com/durable-objects/platform/limits/
  (2026-06-01).
- Queues pricing: https://developers.cloudflare.com/queues/platform/pricing/.
- The alternative evaluated in ADR 0001: https://core.telegram.org/bots/serverless
  (recent changes 2026-10-06).

## Meter table

| Meter (Free plan) | Value | Source | Note for div-report |
|---|---|---|---|
| Workers requests per day | 100,000 | Workers limits | every webhook update and callback press is one; the bot is never a group admin, which would deliver every group message |
| Durable Object requests per day | 100,000 (separate meter) | DO pricing and limits | not used: there is no Durable Object (ADR 0004) |
| Durable Object duration per day | 13,000 GB-s | DO pricing and limits | not used |
| Subrequests per invocation | 50 (D1 queries count) | Workers limits | a cron run drains a few jobs, each one Bot API call and a few D1 queries |
| CPU per invocation | Workers 10 ms; DO 30 s (no Free distinction stated for the DO figure) | Workers limits; DO pricing and limits | everything runs in the Worker; the per-update work is measured by the deployed probe |
| DO alarm invocation duration | 15 min | DO pricing and limits | not used |
| Simultaneous outgoing connections | 6 | Workers limits | one post or edit per job; no pacing |
| D1 rows written per day | 100,000 (indexes and deletes count) | D1 pricing | D1 is the only store and holds nothing per member: a few dozen rows per report, one per press |
| DO SQLite rows written per day | 100,000 (separate meter; each setAlarm = 1) | DO pricing and limits | not used |
| D1 rows read per day | 5,000,000 | D1 pricing | the minute cron reads the due jobs through an index, a few rows a run |
| DO SQLite rows read per day | 5,000,000 | DO pricing and limits | not used |
| D1 database size | 500 MB | D1 pricing | minimisation keeps it tiny |
| DO storage per object | 10 GB (an FAQ entry still says 1 GB on Free) | DO pricing and limits | not used |
| Cron Triggers per account | 5 | Workers limits | one: `* * * * *`, whose run posts, edits and, by the minute, reconciles (every 15th minute), runs the retention job (00:15 UTC) and the monthly snapshot (ADR 0004) |
| Queues (Free) | 10,000 ops/day | Queues pricing | not used |

## Over-limit behaviour

On the Free plan an operation over a daily cap fails until 00:00 UTC. The
design response is in ADR 0001 and ADR 0004: a cron run that meets a cap
error stops without writing, the next minute's run picks the due work up
again once the reset has passed, and the keyholders are alerted: at most
once a UTC day from one Worker instance, on a 15th minute (the venue never:
with the store down the bot cannot read its lockdown switch). The
Paid plan (minimum 5 USD/month) removes the caps if the NGO ever has a
payment path.

## Open measurements

- The CPU of the per-update work on the webhook path (configuration memo,
  HMAC, grammY parse, render), by a deployed probe.
- Whether Workers invocation logs record request headers (relevant to the
  webhook secret, not to a meter).

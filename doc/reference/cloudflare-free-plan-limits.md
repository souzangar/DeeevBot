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
| Durable Object requests per day | 100,000 (separate meter) | DO pricing and limits | broadcast steps as alarms, about 1,430 per 50k broadcast, plus one per "I reported it" press |
| Durable Object duration per day | 13,000 GB-s | DO pricing and limits | a broadcaster resident for a one-hour 50k run is about 460 GB-s |
| Subrequests per invocation | 50 (D1 queries count; DO storage calls do not) | Workers limits | batch of 35 sends plus D1 reads plus margin; verify by measurement |
| CPU per invocation | Workers 10 ms; DO 30 s (no Free distinction stated for the DO figure) | Workers limits; DO pricing and limits | batch work runs in the DO |
| DO alarm invocation duration | 15 min | DO pricing and limits | a batch takes about 2 s |
| Simultaneous outgoing connections | 6 | Workers limits | pace sends; 25 msg/s target |
| D1 rows written per day | 100,000 (indexes and deletes count) | D1 pricing | D1 holds subscribers, reports, approvals, stats only |
| DO SQLite rows written per day | 100,000 (separate meter; each setAlarm = 1) | DO pricing and limits | the ledger and the marks live in the broadcaster |
| D1 rows read per day | 5,000,000 | D1 pricing | about 50k per broadcast |
| DO SQLite rows read per day | 5,000,000 | DO pricing and limits | about 50k per broadcast |
| D1 database size | 500 MB | D1 pricing | minimisation keeps it tiny |
| DO storage per object | 10 GB (an FAQ entry still says 1 GB on Free) | DO pricing and limits | minimisation keeps it tiny |
| Cron Triggers per account | 5 | Workers limits | nightly retention job, stall detector |
| Queues (Free) | 10,000 ops/day | Queues pricing | not used |

## Over-limit behaviour

On the Free plan an operation over a daily cap fails until 00:00 UTC. The
design response (persist, reschedule for 00:05 UTC plus jitter, alert the
admin chat once, stall-detector cron, per-day recipient budget) is in
ADR 0001 and ADR 0004. The Paid plan (minimum 5 USD/month) removes the
caps if the NGO ever has a payment path.

## Open measurements

- The subrequest and CPU cost of a 35-send batch inside a DO alarm on the
  Free plan.
- Whether a DO storage write and `setAlarm` commit atomically.
- Whether Workers invocation logs record request headers (relevant to the
  webhook secret, not to a meter).

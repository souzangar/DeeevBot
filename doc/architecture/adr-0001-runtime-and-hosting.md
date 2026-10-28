---
type: adr
title: "ADR 0001: Runtime and hosting"
description: "Cloudflare Workers Free plan as the primary target with a Node port as the fallback; Telegram Serverless rejected for now with a named re-evaluation trigger; the meters that shape the design, the over-limit behaviour, the risks, and the yearly fallback drill."
status: active
tags: [architecture, adr, hosting, cloudflare, telegram-serverless]
timestamp: 2026-10-28T00:00:00Z
---

# ADR 0001: Runtime and hosting

## Context

The owner asked: "what about cloudflares platform? they have workers, DB
... can we use their free service for this work? otherwise we have to
have our own VPS." and, on transport, "if cloudflare, it can be webhook
and if VPS it can be pulls." The NGO's group has 2,333 members today,
"possibly over 50000 in a year"; the NGO is in Iran, works through VPNs,
and no payment path is assumed. Telegram Serverless was checked first
because it would sidestep the sanctions and payment problem. Facts as of
2026-10-21: handlers run only on incoming updates; no timers, queues or
background jobs are documented; no execution limits, no pricing, no
export or backup, no npm; access by invitation
(core.telegram.org/bots/serverless, recent changes 2026-10-06; a hackernoon
review of 2026-10-21).

## Decision

Cloudflare Workers Free plan is the primary target. A Node port of the
same code is the fallback, deployed with an empty database. Telegram
Serverless is rejected for now; it is re-evaluated when all three appear:
documented timers or background execution, documented limits, and an
export path.

### Meters that shape the design

Free-plan values from developers.cloudflare.com (Workers limits updated
2026-10-12; D1 pricing; Durable Objects pricing and limits updated
2026-06-01; Queues pricing); the sourced table is
[Cloudflare Free plan limits](../reference/cloudflare-free-plan-limits.md).

| Meter (Free plan) | Value | Design consequence |
|---|---|---|
| Workers requests per day | 100,000 | every webhook update and callback press is one; burnable by anyone who messages the bot (accepted risk, the Paid plan is the fix); an admin bot in a group receives every group message, so the bot is never a group admin |
| Durable Object requests per day | 100,000 (separate meter) | broadcast steps are DO alarms: about 1,430 per 50k broadcast, plus one per "I reported it" press; a webhook flood does not stall a running broadcast |
| Durable Object duration per day | 13,000 GB-s | a broadcaster resident for a one-hour 50k run is about 460 GB-s; scales with pacing |
| Subrequests per invocation | 50 (D1 queries count; DO storage calls do not) | batch = 35 sends + D1 reads of subscribers + margin; verify by measurement |
| CPU per invocation | Workers 10 ms; DO 30 s | batch work runs in the DO; measure 35 grammY sends anyway |
| DO alarm invocation duration | 15 min | a batch takes about 2 s |
| Simultaneous outgoing connections | 6 | pace sends; 25 msg/s target |
| D1 rows written per day | 100,000 (indexes and deletes count) | D1 holds subscribers, reports, approvals, stats only |
| DO SQLite rows written per day | 100,000 (separate meter; each setAlarm = 1) | ledger (cursor, batch pairs, counters) and "I reported it" marks live in the broadcaster DO |
| D1 / DO rows read per day | 5,000,000 each | about 50k per broadcast |
| D1 database size / DO storage | 500 MB / 10 GB per object (an FAQ entry still says 1 GB on Free) | minimisation keeps both tiny |
| Cron Triggers per account | 5 | nightly retention job, stall detector |
| Queues (Free) | 10,000 ops/day | not used |

### Over-limit behaviour

On Free, an operation over a daily cap fails until 00:00 UTC. Defined
behaviour: on a cap error the broadcaster persists its progress,
reschedules for 00:05 UTC plus jitter and alerts the admin chat once; a
stall-detector cron re-alerts; a configured per-day recipient budget is
checked before a broadcast starts and shown on the approval card.
Realistic capacity on Free at 50k subscribers: a few report lifecycles per
day with heavy engagement. The Paid plan (minimum 5 USD/month) removes the
caps if the NGO ever has a payment path.

## Consequences

- The broadcast engine is a pure `step()` driven by one Durable Object
  with alarms on Cloudflare and by a loop on Node; the delivery ledger
  lives in the DO's SQLite storage, D1 holds only subscribers, reports,
  approvals and stats ([ADR 0004](./adr-0004-storage-and-delivery-ledger.md)).
- The webhook path carries a random segment so scanner traffic stays off
  the daily request budget ([ADR 0003](./adr-0003-update-transport-and-admin-authority.md)).
- The bot is never an admin of the NGO group (request meter); membership
  is checked as a plain member or anchored on a channel the bot
  administers.
- Risks recorded: account suspension under US sanctions (Cloudflare has
  stated sanctions constrain its Iran operations; OFAC General License D-2
  authorises certain communication-related services, which is not legal
  advice); the dashboard and API being blocked from Iranian IPs (the NGO
  works through VPNs); hard daily caps; data on a US provider (minimised
  per [Retention and minimisation](../product/retention-and-minimisation.md)).
- Fallback: the Node port (Docker, long polling, the same SQL on a local
  SQLite file) is deployed with an empty database, because nothing in the
  recovery story may depend on a Cloudflare account that is already
  suspended. A yearly drill proves the port starts and receives updates
  ([operations and security](../guides/operations-and-security.md)).
- Open measurements for the MVP plan: the subrequest and CPU cost of a
  35-send batch in a DO alarm on Free, and the atomicity of a DO storage
  write plus `setAlarm`.

## Alternatives considered

- Telegram Serverless: rejected for now on the facts above; re-evaluation
  trigger named in the decision.
- A VPS first (the owner's own alternative): a foreign VPS needs a payment
  path, an Iranian VPS needs a tunnel to api.telegram.org; both are the
  owner's operational choices at that time, and the Node port keeps either
  open as the fallback target.
- The Cloudflare Paid plan: removes the caps for a minimum of 5 USD/month;
  it is the upgrade path if a payment path ever exists, not a starting
  point.

## Status

Accepted 2026-10-28.

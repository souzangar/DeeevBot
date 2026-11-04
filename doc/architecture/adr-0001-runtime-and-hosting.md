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
| Durable Object requests per day | 100,000 (separate meter) | not used: there is no Durable Object ([ADR 0004](./adr-0004-storage-and-delivery-ledger.md)) |
| Durable Object duration per day | 13,000 GB-s | not used |
| Subrequests per invocation | 50 (D1 queries count) | a cron run drains a few jobs, each one Bot API call and a few D1 queries; a webhook update makes a few calls |
| CPU per invocation | Workers 10 ms | every invocation is a Worker one; the per-update work is to be measured by the deployed probe, built and not yet run |
| DO alarm invocation duration | 15 min | not used |
| Simultaneous outgoing connections | 6 | one post or edit per job; no pacing, a report being posted once |
| D1 rows written per day | 100,000 (indexes and deletes count) | D1 is the only store and holds nothing per member: a report costs a few dozen rows over its lifecycle, a press one (capacity below) |
| DO SQLite rows written per day | 100,000 (separate meter; each setAlarm = 1) | not used |
| D1 / DO rows read per day | 5,000,000 each | D1: the minute cron reads the due jobs through an index, a few rows a run; DO not used |
| D1 database size / DO storage | 500 MB / 10 GB per object (an FAQ entry still says 1 GB on Free) | minimisation keeps both tiny |
| Cron Triggers per account | 5 | one as built (three were planned): `* * * * *`, the one-minute job cron, which also replaces the stall detector and, by the minute, runs the nightly retention job and the monthly snapshot; the five are counted per account, and the account runs no other cron Worker, the deployed probe's while it briefly exists aside |
| Queues (Free) | 10,000 ops/day | not used |

### Over-limit behaviour

On Free, an operation over a daily cap fails until 00:00 UTC. Defined
behaviour ([ADR 0004](./adr-0004-storage-and-delivery-ledger.md), the cap
contract): a cron run that meets a cap error stops without writing, the
next minute's run picks the due work up again once the reset has passed,
and the keyholders are alerted, at most once a UTC day from one Worker
instance (as built: ADR 0004, "The run as built").

Capacity on Free: each approved report is posted once, into the broadcast
chat, so a report costs a few dozen D1 rows over its whole lifecycle
whatever the audience; each "I reported it" press writes two D1 rows (the
report's count and the day's), capped by `MARKS_PER_REPORT` (5,000 per
report by default) and `MARKS_PER_DAY` (20,000 by default), so presses
take at most two fifths of the 100,000 D1 rows written per day. The Workers request meter is
the one an audience can exhaust (every press and every update is a
request). The Paid plan (minimum 5 USD/month) removes the caps if the NGO
ever has a payment path.

### Threat model: seizure

The design assumes the deployment can be seized, compelled or breached:
the Cloudflare account, its D1 database and the Node port's SQLite file.
So the bot stores no member or reporter identity. There is no subscriber
list; a reporter is known only by an HMAC reference whose key never
leaves the deployment's secret store; a press is a count, not a list of
who pressed; reporters get no decision message, so nothing needs a way back
to them; and a report's links and texts are deleted at closure. What a
seizure yields is the reports still open, the admins' numeric ids on
their decisions, and the aggregate counts. The product-level threat
model is [Threat model: seizure](../product/threat-model-seizure.md).

## Consequences

- Scheduling is a one-minute Cron Trigger draining a jobs table in D1, the
  only store, on Cloudflare, and an in-process timer running the same
  function on Node; an approved report is posted once into the broadcast
  chat ([ADR 0004](./adr-0004-storage-and-delivery-ledger.md)).
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
  suspended. As built, it is `src/node.ts`, run by Node 22.18 or later
  from its TypeScript sources through Node's type stripping and the module
  hook `src/node-hooks.ts` (`npm run port`), in the image of `Dockerfile`
  with `docker-compose.yml`. A yearly drill proves the port starts and
  receives updates ([operations and security](../guides/operations-and-security.md); the
  procedure and the drill are the
  [fallback drill runbook](../guides/fallback-drill.md)).
- Open measurement for the MVP plan: the CPU of the per-update work on
  the webhook path (configuration memo, HMAC, grammY parse, render), by a
  deployed probe: built (`src/probe.ts` with `wrangler.probe.jsonc`; the
  procedure is ADR 0004's "The deployed probe") and not yet run, an owner
  dependency.

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

Amended 2026-10-28 (Phase 3, unit U1b): the owner's scope change of the
same day (no direct-message broadcasts, no member or reporter identity, a
single post per approved report): the meters' design consequences without
a Durable Object, the over-limit behaviour as ADR 0004's cap contract, the
capacity statement simplified, and the threat model of a seizure.

Amended 2026-11-04 (Phase 3, unit U7): the Node port as built, `src/node.ts`
in Docker (`Dockerfile`, `docker-compose.yml`): the same bot over long
polling, a minute loop calling the same run, the same migrations on a
SQLite file; its deployment, the switch back and the yearly drill are the
[fallback drill runbook](../guides/fallback-drill.md).

Amended 2026-11-04 (Phase 3, unit U8, the reconciliation with the code):
one cron as built in place of the three planned, the Free plan's five
being counted per account; the cap alert to the keyholders, never the
admin chat; the Node port's runtime (Node 22.18 or later, type stripping
with `src/node-hooks.ts`); the deployed probe built and not yet run.

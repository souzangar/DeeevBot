---
type: spec
title: "Planning decisions (2026-10-28)"
description: "The owner's Phase 1 inputs verbatim, the decision on each of the brief's ten open questions with a pointer to the doc that holds the detail, and the confirmation and amendment of the catastrophic invariants."
status: active
tags: [product, planning, decisions]
timestamp: 2026-10-28T00:00:00Z
---

# Planning decisions (2026-10-28)

Phase 1 planning with the owner on 2026-10-28 settled the ten open
questions of the [project brief](./project-brief.md). This document is the
record: the owner's inputs as given, one entry per question with the
decision and the document that holds the detail, and what happened to the
seven draft invariants. The review that shaped revision 2 of the decisions
(the angel's twelve round-1 objections and twelve suggestions, and the
seven round-2 objections, each with its disposition) is in the audit
[Planning review (2026-10-28)](../audits/2026-10-28-planning-review.md).

Three facts frame every decision below:

- Counsel was unavailable. In the owner's words: "we don't have official
  way to contact with the platforms and our government don't care about
  these things." Where the brief had asked for a decision "with counsel",
  the owner decided alone, after the alternatives were presented.
- The owner adopted rule 7 (suspected CSAM is routed to the platform and
  the hotlines, never re-broadcast) after the hotline route was presented
  as the alternative to broadcasting.
- The owner revised the private-data default. The first answer was "should
  be both account link and posts."; after the Telegram Bot Developer Terms
  5.2(i) were put on the table the answer became "Account link by default,
  post URL by admin opt-in".

## Owner inputs (verbatim where it matters)

- Counsel: none. "we don't have official way to contact with the platforms
  and our government don't care about these things."
- Private-data (doxxing) broadcasts: first "should be both account link and
  posts."; after the Telegram Bot Developer Terms 5.2(i) were put on the
  table: "Account link by default, post URL by admin opt-in".
- Platforms: Instagram, X, Facebook, TikTok, "possible other platforms".
  Telegram was added as a target because the owner's own abuse cases are on
  Telegram (channels fed by throwaway public bots).
- Languages: Persian and English.
- Admins: 1 to 2.
- Hosting: "what about cloudflares platform? they have workers, DB ... can
  we use their free service for this work? otherwise we have to have our
  own VPS." Telegram Serverless was checked first and rejected for now
  (Q10).
- Subscribers: 2,333 members in the NGO's group today; "possibly over 50000
  in a year".
- Transport: "if cloudflare, it can be webhook and if VPS it can be pulls."
- Categories: "all of possible. we have some cases that they share public
  images of people with some nasty words. or many doxxing way that even for
  the devil it's new."
- Retention: "we don't need keep all of the data for a long time, when the
  channel is closed, we can report to users who seen it and report it and
  delete them in our db and only count how many of what we reported."
- Country: Iran.
- Who may report: "Anyone, with stricter limits for non-members" (members
  of the NGO's group get the normal limits; non-members one report per day
  and no direct-message subscription).
- Approval grace period: 5 minutes, with Cancel and /halt.
- Side request: Telegram posts forwarded from public bots into channels
  (research note section 5A; summarised under Q7).

## Decisions by open question

### Q1. Suspected CSAM routing

Rule 7 stands, adopted by the owner on 2026-10-28 without counsel. The
reporter's label is a hint; the admin categorises at review from the
description and the context visible without opening media, and never opens
media. A report categorised as suspected CSAM is never broadcast and never
posted to any chat other than the reviewing admin's; the bot sends the
admin a routing card (the platform's child-exploitation report path and the
hotlines), records admin id and timestamp, deletes the URL and comment at
once, and sends the reporter a neutral acknowledgement with the public
hotline links. "Doubt" means doubt about whether the material is sexual,
not whether a minor appears. Detail: the CSAM section of
[Report categories and routing](./report-categories-and-routing.md); the
card and hotline list in the
[admin review runbook](../guides/admin-review-runbook.md) and
[CSAM hotlines](../reference/csam-hotlines.md).

### Q2. Private-data routing

Decided by the owner, revised once (see above): the broadcast carries the
account link and the platform's private-information report path by
default; the admins report the specific post themselves; the admin may
include the post URL for one report by an explicit opt-in recorded with
the approval. A reporter-side flag "I am the affected person" forces
account-only and the instructions tell the affected person to file the
platform's first-person report. Intimate images shared without consent
never carry the post URL. Detail and the reasons:
[Report categories and routing](./report-categories-and-routing.md).

### Q3. Verification standard, reporter abuse, retraction

Verification is a runbook duty, not a bot feature: the admin confirms the
link, confirms the category from the platform's own view in an isolated
profile, checks for weaponisation, never opens suspected CSAM, writes the
recommended comment as points to make, and picks the link mode. The bot
checks membership of the NGO group as a plain member in privacy mode
(never as an admin), takes text only (media and forwarded posts are
refused and deleted), and enforces membership-based limits with a global
cap of 20 non-member reports per day, duplicate detection by a keyed URL
hash, a block list, a rejection throttle and first-decision-wins.
Retraction edits every delivered message in place (deleting where younger
than 48 hours), edits the mirror post and marks the report retracted; it
queues behind a running broadcast and completes within the hour. Detail:
[Review and abuse controls](./review-and-abuse-controls.md) and the
[admin review runbook](../guides/admin-review-runbook.md).

### Q4. Consent and Telegram's rules

Explicit opt-in for members of the NGO group, /stop, unsubscription on a
reported block or on the 403/400 send errors, at most 25 direct messages
per second, a global pause on 429, a per-day recipient budget, exactly
three bulk message kinds (closure outcomes go only to pressers who are
still subscribed at send time), and an optional mirror chat whose readers
leave no ids unless they press "I reported it" and who receive every
broadcast twice if they also subscribe. Detail:
[Broadcast consent policy](./broadcast-consent-policy.md).

### Q5. Retention and minimisation

The owner's policy made concrete: the reporter's Telegram id is replaced by
a keyed reference once the decision notice is delivered or abandoned;
report data is deleted at closure (admin outcome or 90 days after the
broadcast); rejected reports go after 30 days; routed CSAM reports lose URL
and comment at routing; only an aggregate row survives (a re-reported target's prior outcome is
shown on the admin's card only, never to the reporter); logs never carry
URLs, comments or ids; no per-user backups, ever. Detail:
[Retention and minimisation](./retention-and-minimisation.md).

### Q6. Admin review runbook and operations guide

Two runbooks under `doc/guides/`:
[admin review runbook](../guides/admin-review-runbook.md) (isolation
setup, decision checklist, routing table, CSAM routing card, closure and
retraction, reporter abuse, Telegram forwarded-from-bot guidance, legal
notes for the Iranian context, a dedicated admin account) and
[operations and security](../guides/operations-and-security.md) (the
BotFather owner account as the root of trust, admin accounts, succession,
grace period, Cancel and /halt, quota exhaustion and the daily budget, the
fallback deployment, the stats snapshot).

### Q7. Platform coordinated-reporting policies

Research-backed: no platform documents that report volume raises priority;
Facebook states the number of reports does not determine removal; X
prohibits duplicate or false reports in large numbers; Meta and TikTok
prohibit groundless or clearly unfounded reports; INHOPE and IWF say report
once. So the broadcast asks each member for one genuine report in their own
words, gives the points to make, and never promises removal. One reference
doc per platform:
[Instagram](../reference/platform-reporting-instagram.md),
[X](../reference/platform-reporting-x.md),
[Facebook](../reference/platform-reporting-facebook.md),
[TikTok](../reference/platform-reporting-tiktok.md),
[Telegram](../reference/platform-reporting-telegram.md) (including the
forwarded-from-bot guidance) and
[other platforms](../reference/platform-reporting-other.md); trusted-flagger
applications are a roadmap item in
[Trusted-flagger programmes](../reference/trusted-flagger-programmes.md).

### Q8. Update authenticity

Both transports, one rule: on Cloudflare a webhook registered with a
secret token, rejected before parsing unless the header matches
(constant-time compare), on a random path that is not itself the check; on
a VPS long polling with no inbound port. Admin authority from `ADMIN_IDS`
in the secret store through one `isAdmin(userId)` gate; the admin chat id
is a venue, never an authority. Detail:
[ADR 0003](../architecture/adr-0003-update-transport-and-admin-authority.md).

### Q9. Error-handling convention

One typed `AppError` shape, one code catalog, a grammY boundary that never
leaks report data, a classification of Telegram API errors, nothing
swallowed, and a regression test with a real GrammyError. Detail:
[ADR 0005](../architecture/adr-0005-error-handling-convention.md); the text
also fills the CLAUDE.md "Error handling" section in the same change.

### Q10. Stack, hosting, data model, module layout

Cloudflare Workers Free as the primary target with a Node port as the
fallback, Telegram Serverless rejected for now with a named re-evaluation
trigger ([ADR 0001](../architecture/adr-0001-runtime-and-hosting.md), meter
table in [Cloudflare Free plan limits](../reference/cloudflare-free-plan-limits.md));
TypeScript strict ESM, grammY, Vitest, wrangler, zod, npm, no AI services
([ADR 0002](../architecture/adr-0002-language-and-framework.md)); D1 behind
a SqlDb port plus a broadcaster Durable Object holding the delivery ledger
([ADR 0004](../architecture/adr-0004-storage-and-delivery-ledger.md));
tables, statuses, module map, critical globs and tripwire patterns
([ADR 0006](../architecture/adr-0006-data-model-and-module-layout.md)).
Review model: single approval with a 5-minute grace period (Cancel returns
the report to pending and voids the approval), first decision wins; the
state machine is in [Report lifecycle](./report-lifecycle.md).

## The catastrophic invariants

The seven draft rules of the install review were confirmed or amended on
2026-10-28 and an eighth was added; the amended block lives verbatim in
CLAUDE.md, AGENTS.md and the devil's invariants file, and
[Critical invariants](../architecture/critical-invariants.md) explains each
rule and names its regression test. What changed, and why (the objection
numbers are the angel's, round 1 unless marked round 2, dispositioned in
the audit):

- Rule 1 was reworded around the approval record (#4) and scoped to the
  broadcast audience, subscribers as such or the mirror chat (round 2,
  #6). It now covers every message about a report that reaches that
  audience (broadcast, retraction notice, closure notice), each derived
  from the approval record, which carries the admin's numeric id,
  timestamp and start time; the report broadcast itself is sent only while
  the report is approved or broadcasting and never before the start time
  (round 2, #4).
- Rule 2 kept its substance; the authenticity clause now names the two
  accepted forms exactly: a webhook request carrying the configured secret
  token, or an update fetched by long polling.
- Rule 3 was scoped to the links (#12): a broadcast carries only the
  reviewed links the category's routing allows, and the review flow shows
  admins an opaque reporter reference, never the reporter's Telegram id,
  username or name. The pending routing question it used to carry is now
  decided (Q2).
- Rule 4 is unchanged.
- Rule 5 was scoped to direct messages and bound by construction, with no
  number in the rule (#5): a resumed broadcast never re-sends to a
  subscriber the ledger records as delivered, progress and the next step
  commit together after every batch, only the lease holder advances, so a
  retry can repeat at most one batch.
- Rule 6 was scoped (#6): the webhook secret, the reporter-reference key
  and the admin allowlist join the bot token and database credentials in
  the secret store; comments and subscriber ids join URLs and reporter ids
  in the list of what never reaches logs; the hosting platform's
  invocation logs count as logs; nothing goes to any service other than
  the Telegram Bot API and the deployment's own storage.
- Rule 7 now points to the hotlines listed in the review runbook and to
  the admin's routing card (#12), and forbids sending the link to any chat
  other than the admin review venue. The owner adopted it; the draft's
  "pending the owner's decision, with counsel" clause is gone.
- Rule 8 is new (#9, Q5): reports leave only counts behind. The reporter's
  id is replaced by a keyed reference once the decision notice is
  delivered or abandoned; at closure the links, comment, broadcast text,
  delivery ledger and per-user records are deleted; only the aggregate row
  remains; every stored personal field has a deletion path covered by a
  test.

## Open items carried into the MVP plan

- Measure on the Free plan: the subrequest and CPU cost of a 35-send batch
  inside a Durable Object alarm, and the atomicity of a DO storage write
  plus `setAlarm`.
- Whether Workers invocation logs record request headers, which would put
  the webhook secret in a log if observability is enabled.
- The research note's unverified items (Telegram's live report option
  tree, moderator handling of forwarded posts, NGO escalation routes),
  listed in the [planning review](../audits/2026-10-28-planning-review.md).

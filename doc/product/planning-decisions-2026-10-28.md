---
type: spec
title: "Planning decisions (2026-10-28)"
description: "The owner's Phase 1 inputs verbatim, the decision on each of the brief's ten open questions with a pointer to the doc that holds the detail, the scope reduction of the same evening after the owner stated the seizure threat (their words and answers, and which docs hold each decision), and the confirmation and amendment of the catastrophic invariants."
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
The same evening the owner stated the seizure threat and reduced the
scope; the dated section "Scope reduction after the seizure threat" below
records it, and supersedes what it names in the entries above it.

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

Amended the same evening by the scope reduction (below), which sends no
message at any decision: nothing goes to the reporter at routing. The
hotline links go out at intake instead, in a persistent message carrying
no target URL, when the reporter's own label is "sexual content involving
a minor" (as built: `src/review/route.ts`, `src/telegram/intake.ts`).

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

Phase 1 recorded:

> Verification is a runbook duty, not a bot feature: the admin confirms the
> link, confirms the category from the platform's own view in an isolated
> profile, checks for weaponisation, never opens suspected CSAM, writes the
> recommended comment as points to make, and picks the link mode. The bot
> checks membership of the NGO group as a plain member in privacy mode
> (never as an admin), takes text only (media and forwarded posts are
> refused and deleted), and enforces membership-based limits with a global
> cap of 20 non-member reports per day, duplicate detection by a keyed URL
> hash, a block list, a rejection throttle and first-decision-wins.
> Retraction edits every delivered message in place (deleting where younger
> than 48 hours), edits the mirror post and marks the report retracted; it
> queues behind a running broadcast and completes within the hour. Detail:
> [Review and abuse controls](./review-and-abuse-controls.md) and the
> [admin review runbook](../guides/admin-review-runbook.md).

The scope reduction (below) superseded its retraction sentences: there
are no delivered messages and no mirror post. The decision now, as built
(unit U8):

- Verification stays a runbook duty, as above, in the
  [admin review runbook](../guides/admin-review-runbook.md).
- Intake (`src/telegram/intake.ts`, `src/review/intake.ts`,
  `src/review/drafts.ts`): private chats only, text only (media, forwards,
  messages sent through an inline bot and replies quoting another chat are
  refused and deleted, never read), every message deleted on receipt
  outside lockdown; membership of the NGO group read with `getChatMember`
  on the update's user id by a plain-member bot in privacy mode, never
  stored; members 5 open reports (pending a decision) and 20 a day,
  non-members 1 a day and 20 a day all together, a reference with 3
  rejections in 30 days 1 a day, a blocked reference none; a report of an
  open target (pending, approved, posting or posted) merged into it by the
  keyed link hash; first decision wins by a conditional update.
- Retraction edits the one post in the channel in place, and nothing in
  any other chat: `/retract <id>` by an admin in the venue or by a
  keyholder in their own chat (also under lockdown), or the status card's
  Retract button, the correction asked for by prompt and held to the admin
  free-text policy; its edit job, due at once and run under `/halt` and
  lockdown too, replaces the post's text with the correction under a fixed
  heading and the warning line, removes the button, and deletes the post
  as well when it is younger than 48 hours; the report becomes `retracted`
  only when that edit succeeds, finalized in the same batch
  (`src/broadcast/retraction.ts`, `src/broadcast/concluding.ts`).

Detail: [Review and abuse controls](./review-and-abuse-controls.md) and
[Report lifecycle](./report-lifecycle.md).

### Q4. Consent and Telegram's rules

Decided in Phase 1 as an explicit opt-in with a direct-message fan-out
and an optional mirror chat; superseded the same evening (the scope
reduction below). The decision now: an approved report is posted once
into a channel owned by the keyholder (`BROADCAST_CHAT_ID`); joining the
channel is the consent and leaving it the opt-out; there is no
subscription, no subscriber list and no direct-message broadcast;
retraction and closure edit the post; "I reported it" is a counter with a
per-day and a per-report cap, labelled advisory; the bot sends a direct
message only as a reply in a user's own chat or as an alert to a
keyholder; the only bulk message kind is the post with its edits (Bot
Developer Terms 5.2). Detail:
[Broadcast consent policy](./broadcast-consent-policy.md).

### Q5. Retention and minimisation

The owner's policy made concrete, then tightened the same evening (the
scope reduction below): no plaintext Telegram id of any member or
reporter is ever stored (the allowlisted admins' and keyholders' own ids
excepted); intake state is keyed by the keyed reporter reference computed
from each update; reporters get no decision message, so nothing needs a
way back to them; `comment` and `affected_person` are nulled at the
decision; report data is deleted at closure (admin outcome, retraction,
or expiry 90 days after the post), rejected and routed rows 30 days after
the decision, pending rows 30 days after intake; routed CSAM reports lose
URL, account URL and comment at routing; only an aggregate row survives
(a re-reported target's prior outcome is shown on the admin's card only,
never to the reporter); logs never carry URLs, comments or ids; no
backups of our own, while D1's 30-day Time Travel history is named as the
platform's, and the emergency wipe leaves only the aggregate rows.
Detail: [Retention and minimisation](./retention-and-minimisation.md).

### Q6. Admin review runbook and operations guide

Phase 1 recorded:

> Two runbooks under `doc/guides/`:
> [admin review runbook](../guides/admin-review-runbook.md) (isolation
> setup, decision checklist, routing table, CSAM routing card, closure and
> retraction, reporter abuse, Telegram forwarded-from-bot guidance, legal
> notes for the Iranian context, a dedicated admin account) and
> [operations and security](../guides/operations-and-security.md) (the
> BotFather owner account as the root of trust, admin accounts, succession,
> grace period, Cancel and /halt, quota exhaustion and the daily budget, the
> fallback deployment, the stats snapshot).

Amended by the scope reduction (below), which made the keyholder the root
of trust and added lockdown and the wipe. The decision now, as built
(unit U8): three runbooks under `doc/guides/`.

- The [admin review runbook](../guides/admin-review-runbook.md): the
  dedicated admin account and the isolated workstation, the review venue,
  the suspected-CSAM gate and its routing card, the decision checklist with
  the approve prompts and the free-text rules, the per-category routing
  table, closure and retraction as edits of the channel post, reporter
  abuse and why nobody is messaged, what lockdown looks like to an admin,
  Telegram posts forwarded from bots, and the legal and safety notes for
  the Iranian context.
- The [operations and security runbook](../guides/operations-and-security.md):
  the keyholder outside the country as the root of trust (the BotFather
  owner account, the Cloudflare account, the channel, the secrets), admin
  accounts that administer nothing, the configuration, the webhook
  registration with `scripts/set-webhook.ts`, the grace period with Cancel
  and `/halt`, the single post and its edits, quota exhaustion, lockdown,
  logs, the single cron with retention and the stats snapshot, the
  incident procedures with the emergency wipe (`scripts/wipe.sh`), the
  risk register, and the go-live, weekly, monthly and yearly checklists.
- The [fallback drill runbook](../guides/fallback-drill.md), added by unit
  U7: the Node port run when Cloudflare is out of reach, the switch back to
  the Worker, the destruction of the port's database, and the yearly drill.

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

Phase 1 recorded:

> Both transports, one rule: on Cloudflare a webhook registered with a
> secret token, rejected before parsing unless the header matches
> (constant-time compare), on a random path that is not itself the check; on
> a VPS long polling with no inbound port. Admin authority from `ADMIN_IDS`
> in the secret store through one `isAdmin(userId)` gate; the admin chat id
> is a venue, never an authority. Detail:
> [ADR 0003](../architecture/adr-0003-update-transport-and-admin-authority.md).

Amended by the scope reduction (below), which added the keyholders. The
decision now, as built (unit U8):

- The webhook (`src/telegram/webhook.ts`): only a POST to
  `/<WEBHOOK_PATH_SEGMENT>` whose `X-Telegram-Bot-Api-Secret-Token` header
  equals `WEBHOOK_SECRET`, compared in constant time over the SHA-256
  digests of both, is read; anything else is answered 404 with an empty
  body before the body is read and before any bot exists. An update is
  answered 200 at once and handled under `waitUntil`.
- Its registration, `scripts/set-webhook.ts`, an operator script run with
  Node 22.18 or later and never part of the Worker:
  `npm run set-webhook -- <Worker origin>` calls `setWebhook` with the url
  `<origin>/<WEBHOOK_PATH_SEGMENT>`, `secret_token` = `WEBHOOK_SECRET`,
  `allowed_updates` = `["message", "callback_query"]`,
  `max_connections` = 10 and `drop_pending_updates` = true;
  `npm run set-webhook:delete` calls `deleteWebhook` and keeps the pending
  updates. Either then prints `getWebhookInfo` with the URL's path masked,
  and never the token or the secret token.
- Long polling on the Node port (`src/telegram/polling.ts`), `message` and
  `callback_query` only, with no inbound port. The port calls
  `deleteWebhook`, keeping the pending updates, at every start
  (`src/node.ts`), and a webhook set while it runs ends its polling: it
  alerts the keyholders and stops, yielding the bot to the Worker.
- Admin authority from `ADMIN_IDS`, numeric ids only, through `isAdmin`,
  re-checked at every admin action; keyholder authority from
  `KEYHOLDER_IDS` through `isKeyholder`; the two lists never overlap, since
  the configuration refuses a load where they do (`src/auth/allowlist.ts`,
  `src/config/schema.ts`). The admin chat id is a venue, never an
  authority.

Detail:
[ADR 0003](../architecture/adr-0003-update-transport-and-admin-authority.md)
and the [operations and security runbook](../guides/operations-and-security.md),
section 2.1.

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
([ADR 0002](../architecture/adr-0002-language-and-framework.md)); D1 as
the only store behind a SqlDb port, a jobs table drained by a one-minute
cron, no Durable Object and no delivery ledger since the evening's scope
reduction ([ADR 0004](../architecture/adr-0004-storage-and-delivery-ledger.md));
tables, statuses, module map, critical globs (`src/platforms/` among
them) and tripwire patterns
([ADR 0006](../architecture/adr-0006-data-model-and-module-layout.md)).
Review model: single approval with a 30-minute grace period (Cancel, on
the card or on a keyholder's notice, returns the report to pending and
voids the approval), first decision wins, the post claimed by one
conditional update binding the approval and the lockdown state; the
state machine is in [Report lifecycle](./report-lifecycle.md).

## Scope reduction after the seizure threat (2026-10-28, evening)

During unit U1b, after the Phase 1 decisions above were recorded, the
owner stated the threat the product must survive, verbatim:

"imagine a situation where the admins get arrested because of they are
defending human rights and then use this platform to target or identify
users and their real IP. I only know with telegram inline bot chats or
telegram serverless server it's possible. or maybe having some proxy in
between. but still if they have access the account, they still can change
anything."

The owner's answers the same evening:

- Where approved reports go: a channel or group only, with no
  direct-message list; once a group's member list was shown to be
  readable by any member, a channel owned by the keyholder.
- No decision message to reporters.
- Outcomes by editing the post, with counts only.
- A keyholder outside the country: "not yet, but I can arrange it".
- The approval grace period: 30 minutes (the Phase 1 input of 5 minutes
  is superseded).

The decisions that follow, each held by the doc named:

- The threat model itself, the attacker's capabilities and the controls:
  [Threat model: seizure](./threat-model-seizure.md), a binding rule
  pinned in the root index.
- No direct-message broadcast, no subscription, no subscriber list; one
  post per approved report into the channel; retraction and closure edit
  it; "I reported it" is a counter with two caps:
  [Broadcast consent policy](./broadcast-consent-policy.md) (supersedes Q4
  as first decided).
- No plaintext Telegram id of any member or reporter in storage; drafts
  keyed by the reporter reference; `comment` and `affected_person` nulled
  at the decision; the emergency wipe; D1 Time Travel named:
  [Retention and minimisation](./retention-and-minimisation.md) (tightens
  Q5).
- The statuses `posting`, `posted`, `closing` and `retracting`; the post
  claimed by one conditional update binding the approval and the lockdown
  state; ambiguous failures never re-sent, a verified `/attach` and
  `/repost` instead of a blind re-post; no reporter notices; each reporter
  message deleted on receipt: [Report lifecycle](./report-lifecycle.md)
  (supersedes the retraction and notice sentences of Q3 and Q5).
- The link policy (exact hosts, https only, no userinfo, port, query or
  fragment, redirectors rejected, Telegram targets as code text, the fixed
  `TRUSTED_HELP_HOSTS` list, no Mini App, no inline mode), no
  admin-written instructions for "other", the hotline message at intake
  for a CSAM label:
  [Report categories and routing](./report-categories-and-routing.md).
- The admin free-text validator and the 300-character recommended comment
  under the fixed warning line, the lockdown's effect on intake and
  review, review cards deleted within 48 hours (the "at any age" claim
  withdrawn): [Review and abuse controls](./review-and-abuse-controls.md)
  and the [admin review runbook](../guides/admin-review-runbook.md)
  (amends Q3 and Q6).
- The keyholder role (`KEYHOLDER_IDS`, never overlapping `ADMIN_IDS`),
  the two lockdown layers, keyholder alerts with a Cancel and a Lockdown
  button at every approval, the channel setup, the single cron, the wipe
  and `wrangler d1 delete`, the quota-exhausted path:
  [ADR 0003](../architecture/adr-0003-update-transport-and-admin-authority.md),
  [ADR 0004](../architecture/adr-0004-storage-and-delivery-ledger.md),
  [ADR 0006](../architecture/adr-0006-data-model-and-module-layout.md) and
  the [operations and security runbook](../guides/operations-and-security.md)
  (amends Q6, Q8 and Q10).
- Ambiguous versus unambiguous Telegram failures, no retry of a timeout,
  a network error or a 5xx on a send, no 00:05 UTC reschedule:
  [ADR 0005](../architecture/adr-0005-error-handling-convention.md)
  (amends Q9).
- Catastrophic invariants 1, 2, 4, 5 and 8 amended: the section below.

The design built for the Phase 1 decisions (a direct-message fan-out with
a Durable Object delivery ledger, in unit U1b) was removed the same day.
The critic rounds that took the reduced design from its first revision to
closure (the angel's rounds 5, 6 and 7, the codex devil's second run,
every objection conceded) are recorded in the
[planning review](../audits/2026-10-28-planning-review.md) ("Scope
reduction review").

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

The same evening, after the seizure threat, the owner amended rules 1, 2,
4, 5 and 8 again; the texts are in the three synced copies, and
[Threat model: seizure](./threat-model-seizure.md) holds the reasons:

- Rule 1 names the channel as the broadcast audience and the states
  `approved` or `posting`: no message about a report reaches the channel
  without the approval record, and the post is sent only while the report
  is approved or posting and never before the record's start time.
- Rule 2 adds the lockdown: while the lockdown switch is set, by a
  keyholder's command or by the deployment's override, no admin action,
  intake, press or post is performed and alerts go to the keyholders.
- Rule 4 adds the link policy: every link the bot sends to the channel,
  to a reporter or to a keyholder is parsed, https-only, free of userinfo,
  port, query and fragment, and its exact hostname is on the configured
  allowlist of the target platforms' own domains, or on the code's fixed
  list of platform help and hotline hosts, with platform redirectors and
  Telegram invite, start and Mini App links rejected and admin-authored
  text checked for links, domains, mentions and phone numbers; the bot
  has no Mini App and no inline mode.
- Rule 5 becomes "Posts go only to the configured channel": an approved
  report is posted once to the configured channel (joining it is the
  consent, leaving it the opt-out); the bot sends a direct message only
  as a reply to a user's own message in their own chat or as an alert to
  a configured keyholder; no list of members or subscribers exists
  anywhere in the bot's storage.
- Rule 8 becomes "No plaintext Telegram id of a reporter or member is
  ever stored (the allowlisted admins' and keyholders' own ids excepted,
  both deployment configuration), and reports leave only counts behind":
  intake state is keyed by the keyed reporter reference; at closure a
  report's links, comment, texts and per-report records are deleted and
  only the aggregate row remains; every stored personal field has a
  deletion path covered by a test, and the emergency wipe leaves only the
  aggregate rows in the live database.
- Rules 3, 6 and 7 are unchanged.

## Open items carried into the MVP plan

- Measure on the Free plan: the per-update CPU of the webhook path
  (configuration memo, HMAC, grammY parse, render), by a deployed probe
  once, recorded in
  [ADR 0004](../architecture/adr-0004-storage-and-delivery-ledger.md); the
  Durable Object measurements of the first plan are moot.
  (U8: the probe is built, `src/probe.ts` under `wrangler.probe.jsonc`,
  bundled offline by `npm run probe:dry-run`, with the one-time fidelity
  check of `/attach`'s text comparison; ADR 0004, "The deployed probe",
  has its procedure. It has not been run: still open, an owner
  dependency, since it needs the owner's Cloudflare account.)
- Whether Workers invocation logs record request headers, which would put
  the webhook secret in a log if observability is enabled.
  (U8: not settled by the code; wrangler.jsonc keeps `observability` off,
  and `src/worker.test.ts` pins it off.)
- The research note's unverified items (Telegram's live report option
  tree, moderator handling of forwarded posts, NGO escalation routes),
  listed in the [planning review](../audits/2026-10-28-planning-review.md).
  (U8: still open.)
- The owner's: a keyholder outside the country ("not yet, but I can
  arrange it"), which blocks go-live; the future of the existing NGO
  group, whose history exposes its authors whatever the member setting
  (for example a channel with a comments group under auto-delete); the
  go-live probes (the bot posts into the channel as its only posting
  administrator; `getChatMember` answers for a plain-member bot in the
  group, else `MEMBERSHIP_CHAT_ID` becomes the channel).
  (U8: all three still open, owner dependencies, as is a native speaker's
  review of every Persian string of the catalogs; the go-live checklist
  is in the
  [operations and security runbook](../guides/operations-and-security.md),
  section 9.)

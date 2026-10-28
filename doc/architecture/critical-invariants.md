---
type: rule
title: "Critical invariants"
description: "The eight catastrophic invariants explained: each rule by title, why it exists, and the regression test that pins it; the verbatim block lives in CLAUDE.md, synced to AGENTS.md and the devil's invariants file."
status: active
tags: [architecture, rule, invariants, safety, tests]
timestamp: 2026-10-28T00:00:00Z
---

# Critical invariants

The verbatim rules live in CLAUDE.md's "Critical invariants" section,
between `<!-- sync:catastrophic-invariants -->` markers, and are kept
byte-identical in AGENTS.md ("Catastrophic invariants", what the codex
critic reads) and `.claude/devil/critical-invariants.md` (what devil.sh
injects) by `.claude/hooks/rules-sync-check.sh`, the first step of the
commit gate. This document explains and does not duplicate: for each
rule, its title, why it exists, and the regression test that will pin it,
because a stated "must not" gets a regression test in the same change as
the code that implements it. The owner confirmed and amended the rules on
2026-10-28; what changed is recorded in
[Planning decisions](../product/planning-decisions-2026-10-28.md).

## 1. No message about a report reaches the broadcast audience without a recorded approval

Why: the approval record (the admin's numeric id, timestamp and start
time) is the single provenance for the broadcast, a retraction notice and
a closure notice. Keeping it in its own table makes the rule structural
([ADR 0006](./adr-0006-data-model-and-module-layout.md)); the start time
gives the 5-minute grace in which Cancel voids the record before anything
leaves; the broadcaster re-reads the report's status at its start alarm.
Test: drive the engine with a pending report, with an approved report
whose `starts_at` is in the future, with a cancelled report, and with a
retraction or closure for a report that has no approval row; assert zero
sends in every case, and one mirror post plus the fan-out only for an
approved report at or after its start time.

## 2. Admin authority is decided server-side, on authentic updates

Why: usernames are reassignable, callback payloads and chat context are
client-controlled, and the webhook endpoint is public
([ADR 0003](./adr-0003-update-transport-and-admin-authority.md)). Test: a
webhook request with a missing or wrong secret header is rejected before
the body is parsed; a callback pressed in the admin chat by an id outside
`ADMIN_IDS` is refused; the configuration schema rejects a username in
`ADMIN_IDS`; a forwarded message from an admin grants nothing.

## 3. Nobody is exposed by a broadcast's text

Why: the reporter's identity and comment and the admin's identity are
review-only, and the routing table decides which links a category's
broadcast may carry ([Report categories and routing](../product/report-categories-and-routing.md)).
Test: render a broadcast from a report that carries a reporter id,
username, name, a comment, an approving admin id and a post URL under
account-only link mode; assert none of them appears in the rendered
text; render the review card and assert it shows the opaque reference
and not the Telegram id, username or name.

## 4. Reported content is hostile data, never content

Why: fetching or previewing a reported link would make the bot access the
content, and a preview multiplies views of it in every chat. Test: every
outgoing message that contains a reported URL is sent with
`link_preview_options.is_disabled` set, asserted on the Telegram API
mock; URLs and comments render as escaped code text; intake refuses media
and forwarded posts and never calls `forwardMessage`, `copyMessage`,
`getFile` or `getChat` on a target; the only `fetch(` is in the Telegram
API adapter (tripwire pattern plus a test).

## 5. Direct-message broadcasts are consensual and idempotent

Why: unsolicited bulk messages get bots banned and take the NGO's channel
with them; a resumed broadcast must not double-send
([Broadcast consent policy](../product/broadcast-consent-policy.md),
[ADR 0004](./adr-0004-storage-and-delivery-ledger.md)). Test: `/stop`, a
`my_chat_member` block and the 403/400 send responses each delete the
subscriber row; a broadcast interrupted mid-batch and resumed never
re-sends to a chat id the ledger records as delivered and repeats at most
that batch; a runner without the lease cannot advance; a non-subscriber
never receives a direct message.

## 6. Secrets and sensitive data stay out of code, VCS, logs, and telemetry

Why: the token, webhook secret, reference key and allowlist are the
deployment's trust roots, and a reported URL or a reporter id in a log is
a leak to whoever reads the platform's logs. Test: the secret-shape scan
(`.claude/hooks/secret-shape-scan.sh`, in place); the redacting logger
test with a real GrammyError whose payload carries the outgoing text and
chat id, asserting neither reaches the log line; the configuration schema
accepts secrets only from the environment or secret store.

## 7. Suspected child sexual abuse material is never re-broadcast

Why: recorded for the owner in
[Report categories and routing](../product/report-categories-and-routing.md):
platforms deduplicate so volume buys no speed, every member who opens the
link accesses CSAM, a bot that bulk-sends such links will be banned, and
the hotlines hold escalation lines the NGO cannot get. Test: approving a
report categorised as suspected CSAM is refused and no approval row can
exist for it; routing sends the card only to the admin review venue;
immediately after routing the report's URL and comment are gone; the
reporter's acknowledgement carries the hotline links and not the URL.

## 8. Reports leave only counts behind

Why: the owner's policy ("delete them in our db and only count how many
of what we reported") made testable
([Retention and minimisation](../product/retention-and-minimisation.md)).
Test: one test per deletion path in the retention table; after closure
the only row that references the report id is the aggregate row and its
columns are exactly the aggregate set; `reporter_chat_id` is null and
`reporter_ref` set once the decision notice is delivered or abandoned.

## Status of the tests

The secret-shape scan exists today. Phase 2 added the first two seeds:
`test/invariants/config-redaction.test.ts` (rule 6: the loaded
configuration is unprintable, and a failed load never echoes a value) and
the `ADMIN_IDS` rejection cases in `src/config/schema.test.ts` (rule 2: the
configuration schema rejects a username or an @handle in `ADMIN_IDS`, one
of the tests rule 2's paragraph names). The remaining tests are written in
the same change as the module that implements each rule, under the module
map in ADR 0006; a rule whose test is still missing is listed in that
change's commit body.

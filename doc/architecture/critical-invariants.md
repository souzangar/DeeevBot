---
type: rule
title: "Critical invariants"
description: "The eight catastrophic invariants explained: each rule by title, why it exists, and the regression test that pins it, after the amendment of rules 1, 2, 4, 5 and 8 for the seizure threat; the verbatim block lives in CLAUDE.md, synced to AGENTS.md and the devil's invariants file."
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
rule, its title, why it exists, and the regression test that pins it,
because a stated "must not" gets a regression test in the same change as
the code that implements it. The owner confirmed and amended the rules on
2026-10-28, and amended rules 1, 2, 4, 5 and 8 again the same evening
after stating the seizure threat; both are recorded in
[Planning decisions](../product/planning-decisions-2026-10-28.md), the
threat itself in
[Threat model: seizure](../product/threat-model-seizure.md).

## 1. No message about a report reaches the channel without a recorded approval

Why: the approval record (its random `approval_id`, the admin's numeric
id, timestamp and start time) is the single provenance for the post and
for the edits that retract or close it. Keeping it in its own table makes
the rule structural
([ADR 0006](./adr-0006-data-model-and-module-layout.md)); the start time
gives the 30-minute grace in which Cancel, on the card or on a
keyholder's notice, voids the record before anything leaves; the post is
sent only while the report is `approved` or `posting`, and the post job
is claimed by one conditional update that binds the approval the job was
enqueued for and the lockdown state
([ADR 0004](./adr-0004-storage-and-delivery-ledger.md)). Test: drive the
tick with a pending report, with an approved report whose `starts_at` is
in the future, with a cancelled report, with a job enqueued for an
approval that was voided and replaced (the Cancel-and-re-approve
interleaving, the stale-tick case), and with a closure or retraction for
a report that has no approval row; assert zero sends in every case, and
one post only for an approved report at or after its start time; a
keyholder's Cancel during the grace voids the approval.

## 2. Admin authority is decided server-side, on authentic updates

Why: usernames are reassignable, callback payloads and chat context are
client-controlled, the webhook endpoint is public, and, since the seizure
threat, the admins' own accounts may be the attacker's: while the
lockdown switch is set, by a keyholder's command or by the deployment's
override, no admin action, intake, press or post is performed and alerts
go to the keyholders
([ADR 0003](./adr-0003-update-transport-and-admin-authority.md)). Test: a
webhook request with a missing or wrong secret header is answered 404
before the body is parsed and before any Bot API call; the compare is
constant time; a callback pressed in the admin chat by an id outside
`ADMIN_IDS` is refused; the configuration schema rejects a username in
`ADMIN_IDS` and in `KEYHOLDER_IDS`; a forwarded message from an admin
grants nothing; under lockdown every admin action is refused, intake
stores nothing, presses are ignored, alerts reach keyholders only, and
only a keyholder's `/unlock` clears `meta.lockdown`.

## 3. Nobody is exposed by a broadcast's text

Why: the reporter's identity and comment and the admin's identity are
review-only, and the routing table decides which links a category's post
may carry
([Report categories and routing](../product/report-categories-and-routing.md)).
Test: render a post from a report that carries a reporter reference, a
comment, an affected-person flag, an approving admin id and a post URL
under account-only link mode; assert none of them appears in the rendered
text and only the allowed links do; render the review card and assert it
shows the opaque reference and not a Telegram id, username or name.

## 4. Reported content is hostile data, never content

Why: fetching or previewing a reported link would make the bot access the
content, and a preview multiplies views of it in every chat; and, since
the seizure threat, a link in a post is the one way a seized approver
could send the members somewhere that identifies them, so every link the
bot sends to the channel, to a reporter or to a keyholder passes the link
policy (its exact host on the configured allowlist or on the fixed list
of help and hotline hosts, https only, no userinfo, port, query or
fragment, redirectors and Telegram invite, start and Mini App links
rejected, Telegram targets rendered as code text, admin text checked for
links, domains, mentions and phone numbers), and the bot has no Mini App
and no inline mode
([Report categories and routing](../product/report-categories-and-routing.md),
[Threat model: seizure](../product/threat-model-seizure.md)). Test: every
send and edit has `link_preview_options.is_disabled` set and HTML parse
mode, asserted on the fake Bot API; URLs and comments render as escaped
code text; intake refuses media and forwarded posts and never calls
`forwardMessage`, `copyMessage`, `getFile` or `getChat` on a target; the
only `fetch(` is in the Telegram API adapter (tripwire pattern plus a
test); no link outside the two exact-host lists is ever sent to the
channel, to a reporter or to a keyholder (the render-time check, one test
per bypass class: exact host, https, userinfo, port, query, punycode,
redirectors, the Telegram path rules); no admin free text with a URL,
bare domain, mention or phone number reaches a post; the fixed warning
line is present in both locales; a source scan finds no Mini App or
inline handler.

## 5. Posts go only to the configured channel

Why: an approved report is posted once to the configured channel, joining
it is the consent and leaving it the opt-out, so no list of members or
subscribers exists anywhere in the bot's storage for a seizure to yield;
unsolicited bulk messages would also get the bot banned and take the
NGO's channel with it
([Broadcast consent policy](../product/broadcast-consent-policy.md),
[ADR 0004](./adr-0004-storage-and-delivery-ledger.md)). Test: the only
message to the channel per report is the post plus its edits (retraction
and closure edit, never send); no direct message is sent to anyone but as
a reply to their own message in their own chat or as an alert to a
keyholder id (the fake records every send's chat id); two ticks racing on
one due job post once; a timed-out send is never re-sent; the schema
holds no subscriber, ledger or per-presser table.

## 6. Secrets and sensitive data stay out of code, VCS, logs, and telemetry

Why: the token, webhook secret, reference key and allowlists are the
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
link accesses CSAM, a bot that distributes such links will be banned, and
the hotlines hold escalation lines the NGO cannot get. Test: no un-voided
approval row can exist for a report categorised as suspected CSAM
(Approve offers Route only); routing nulls `url`, `account_url` and
`comment` on the report and its merged rows in the same batch; the
routing card goes only to the admin review venue; the intake message for
a "sexual content involving a minor" label carries the hotline links and
no URL.

## 8. No plaintext Telegram id of a reporter or member is ever stored, and reports leave only counts behind

Why: the owner's policy ("delete them in our db and only count how many
of what we reported") and the seizure threat together: what a seizure of
the database yields must identify nobody, so intake state is keyed by the
keyed reporter reference computed from each update, the allowlisted
admins' and keyholders' own ids (deployment configuration) are the only
plaintext ids in storage, and the emergency wipe leaves only the
aggregate rows in the live database
([Retention and minimisation](../product/retention-and-minimisation.md),
[Threat model: seizure](../product/threat-model-seizure.md)). Test: a
schema scan finds no column that could hold a plaintext Telegram id
except `approvals.admin_id`, `reports.decided_by` and `admin_prompts`
(`chat_id`, `admin_id`); the draft key is the reference; `comment` and
`affected_person` are null after every decision; one test per deletion
path in the retention table; after closure the only row that references
the report id is the aggregate row and its columns are exactly the
aggregate set; the wipe script leaves only `stats` and `meta`; the
configuration refuses an id present in both `KEYHOLDER_IDS` and
`ADMIN_IDS`.

## Status of the tests

The secret-shape scan exists today. Phase 2 added the first two seeds:
`test/invariants/config-redaction.test.ts` (rule 6: the loaded
configuration is unprintable, and a failed load never echoes a value) and
the `ADMIN_IDS` rejection cases in `src/config/schema.test.ts` (rule 2: the
configuration schema rejects a username or an @handle in `ADMIN_IDS`, one
of the tests rule 2's paragraph names). Unit U1a added
`test/invariants/logger-redaction.test.ts` (rule 6: the production logger
drops a reported URL, a comment, a chat id and a token-shaped URL from a
real `GrammyError` and an `HttpError`, keeps no Telegram id of anyone,
admins included, and no file under `src/` except the logger touches the
console). Unit U1b added the storage-level specs, on the D1 schema
under node:sqlite: `test/invariants/approval-record.test.ts` (rule 1: an
approval row cannot exist without its report, the admin's id, its time and
its start, cannot start before it was given, and the due query the post is
gated on returns neither a voided approval nor a future start nor a report
no longer approved) and `test/invariants/storage-retention.test.ts` (rule
8 with the owner's rule of 2026-10-28 that no member or reporter identity
is stored: no subscriber, ledger or per-presser table and no reporter chat
id; every column has a classified fate and every personal column is named
in the deletion schedule; no raw Telegram id or URL where a keyed value
belongs; a report takes its approval, prompts, jobs and merged rows with
it), and pinned the logger's report-id shape (rule 6: a username or a hex
digest in that field is dropped). Rules 1, 2, 4, 5 and 8 were amended on
the evening of 2026-10-28 for the seizure threat; the three synced copies
change in the same commit as this document. The remaining tests are
written in the same change as the module that implements each rule, under
the module map in ADR 0006; a rule whose test is still missing is listed
in that change's commit body.

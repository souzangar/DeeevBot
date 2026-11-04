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

Tests:

- `test/invariants/approval-record.test.ts`: an approval row needs its
  report, its random approval id, the admin's numeric id, its time and its
  start, and cannot start before it was given; `approved` and `posting` need
  an un-voided approval (the schema's trigger); the due query returns no
  voided approval, no future start and no report no longer approved; a
  re-approval's new id leaves the cancelled one claiming nothing.
- `test/invariants/review.test.ts`: no approval row but the one the whole
  flow writes, with a random approval id and its start after the grace; none
  for a press, for a reply by anyone but the asked admin, or for a notice
  that reached no keyholder; Cancel voids it and deletes its job.
- `test/invariants/post.test.ts`: nothing reaches the channel without a live
  approval whose start has come (a pending, cancelled or voided report, the
  interleaving, a hold, a hold set after the run read the state); a report
  is posted at most once; `/attach` records only this report's own post;
  `/repost` is refused once a message id exists.
- `test/invariants/closure.test.ts`: no closure or retraction edit without
  the report's live approval record; only the edit's success writes the
  terminal status; every edit reaches that report's own post.
- `src/review/approve.test.ts`: the approval batch writes the row with its
  random id and its start, binds the status change to that id and gives the
  post job that id; a re-approval only over a voided row.
- `src/review/cancel.test.ts`: Cancel voids the approval and deletes its
  post job together; a stale Cancel leaves a re-approval alone.
- `src/broadcast/jobs.test.ts`: the post job is due at the approval's start
  and carries its id, and is never written for a missing or voided approval.
- `src/broadcast/post.test.ts`: the claim statement, and every case in which
  it claims nothing.
- `src/broadcast/attach.test.ts`: `/attach` verifies the message by its text
  and its date in the send window, never by its keyboard.
- `src/broadcast/repost.test.ts`: `/repost` only under the live approval,
  refused inside the send window, in the grace, under a voided approval and
  once a message id exists.
- `src/broadcast/closure.test.ts`: the closure order needs a posted report
  under its live approval; the edit job edits that report's own post, and
  never the post of a report without its approval record.
- `src/broadcast/retraction.test.ts`: the retraction's batch is bound to a
  posted report with its message id under its live approval.
- `src/broadcast/concluding.test.ts`: the edit target is read with its live
  approval, and one without its post or its approval record is refused
  before any call.
- `test/workers/d1.test.ts`: on D1, `approved` and `posting` are refused
  without an un-voided approval, as on node:sqlite.
- `test/workers/review.test.ts`: on D1, approve, Cancel and a re-approval
  under a new approval id, the post job following each.
- `test/workers/scheduled.test.ts`: on D1, the cron's run posts a due
  approved report once, claimed and recorded there, and a second run sends
  nothing.

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

Tests:

- `test/invariants/webhook-authenticity.test.ts`: a request off the
  webhook's path or without the secret is answered 404 before its body is
  read, a bot is built or the Bot API is called; the compare is
  `timingSafeEqual` over SHA-256 digests; no grammY webhook handler.
- `test/invariants/polling-authenticity.test.ts`: on the Node port, only the
  webhook boundary and long polling hand updates to the bot, nothing in
  `src/` opens a server or listens on a port, and the import graphs of the
  Worker's entry and of the deployed probe hold nothing of the port.
- `test/invariants/lockdown.test.ts`: under either lockdown layer no admin
  command, button or reply is acted on, a press writes nothing, intake
  stores nothing and the venue gets no alert; only a keyholder's `/unlock`
  in their own chat clears the switch, and nothing clears the override;
  every admin button pressed by anyone but an admin is refused; no
  registration bypasses the admin surface.
- `test/invariants/post.test.ts`: `/attach`, `/repost`, `/halt` and
  `/resume` are no commands from anyone off the allowlists or outside their
  chats; nobody may `/repost` under lockdown.
- `src/config/schema.test.ts`: `ADMIN_IDS` and `KEYHOLDER_IDS` take numeric
  ids only, a username or an @handle refused.
- `src/auth/allowlist.test.ts`: the gates admit exactly the configured
  numeric ids, and never a string.
- `src/auth/lockdown.test.ts`: the override needs no query, and a switch
  that cannot be read is an error, never "not locked".
- `src/telegram/guards.test.ts`: the authority gates check who typed a
  command and where, a forwarded one never passing and an id dropped from
  the configuration losing its commands, and refuse admin actions under
  lockdown.
- `src/telegram/registry.test.ts`: the admin surface runs an admin command
  typed in the venue and nowhere else, refuses an admin button to anyone but
  an admin, and refuses both under lockdown.
- `src/telegram/review.test.ts`: the gates on every review press, reply and
  command.
- `src/telegram/posting.test.ts`: the scheduler's commands for an admin in
  the venue and a keyholder in their own chat, and no command for anyone
  else or anywhere else.
- `src/telegram/closing.test.ts`: the closure unit's commands for an admin
  in the venue, `/retract` and `/stats` for a keyholder in their own chat,
  and `/close` and `/budget` no keyholder's commands.
- `src/telegram/intake-entry.test.ts`: under either lockdown layer intake
  answers the neutral text and stores nothing.
- `src/review/approve.test.ts`: the approval row binds the lockdown switch
  in its own statement.
- `src/telegram/alerts.test.ts`: alerts reach every keyholder, under
  lockdown too, and the venue only while the bot is not locked down.
- `src/telegram/webhook.test.ts`: the webhook boundary's 404 before the body
  is read, and its constant-time compare.
- `src/telegram/polling.test.ts`: long polling asks for messages and presses
  only, and a webhook set meanwhile ends it, the keyholders alerted.
- `src/node.test.ts`: the port deletes the webhook before its first
  `getUpdates`, and the Worker's own bot answers an update it fetched.
- `src/worker.test.ts`: the Worker answers everything but an authentic
  request 404 with no Bot API call, and neither its import graph nor the
  deployed probe's holds anything of the Node port, or anything outside
  `src/` (so never the webhook registration script).
- `scripts/set-webhook.test.ts`: the webhook is registered with exactly the
  deployment's parameters (`secret_token` the `WEBHOOK_SECRET`,
  `allowed_updates` `message` and `callback_query` only, `max_connections`
  10, `drop_pending_updates` true); `--delete` calls `deleteWebhook` with
  exactly `drop_pending_updates` false; anything but one https origin or
  `--delete` is refused before any call.
- `test/workers/webhook.test.ts`: in the Workers runtime, everything but an
  authentic webhook request is answered 404, and a keyholder's `/lockdown`
  makes intake answer neutrally until `/unlock` lifts it.

## 3. Nobody is exposed by a broadcast's text

Why: the reporter's identity and comment and the admin's identity are
review-only, and the routing table decides which links a category's post
may carry
([Report categories and routing](../product/report-categories-and-routing.md)).
Test: render a post from a report that carries a reporter reference, a
comment, the reporter's id, username and name, an approving admin id and a
post URL under account-only link mode; assert none of them appears in the
rendered text or in the keyholders' notice and only the allowed links do;
offer a report whose reporter is the affected person the account link alone,
a forged press for another mode writing nothing; render the review card and
assert it shows the opaque reference and not a Telegram id, username or
name.

Tests:

- `test/invariants/review.test.ts`: the post and the keyholders' notice
  carry no reporter reference, comment, id, username or name, no admin id
  and no post URL under the account mode, in both locales; the card shows
  the reference, never a reporter's id, username or name.
- `test/invariants/intake.test.ts`: nothing the bot sends a reporter echoes
  a reported URL, an account link, a comment or anyone's id, username, name
  or reference; the acknowledgement is the same bytes for a new and a merged
  report; the review card carries the reference, never a reporter's id,
  username or name.
- `src/review/render-post.test.ts`: what each link mode carries, nothing of
  the reporter, and another site's link left out unless its host is allowed.
- `src/review/categories.test.ts`: the routing table's link modes, never the
  post for intimate images, and the account link alone when the reporter is
  the affected person.
- `src/telegram/review.test.ts`: the affected person's report is offered the
  account link alone, and a forged press for another mode writes nothing.
- `src/review/card.test.ts`: the card shows the reference, never an id, a
  username or a name.
- `src/review/open.test.ts`: `/open` lists the open reports by id, platform,
  category, day and state, never a URL, a comment or a reference.
- `src/review/status-card.test.ts`: the status card never shows a URL, a
  comment or a reference.
- `src/review/block.test.ts`: the block list takes the reporter reference
  alone, and Block reporter blocks a report's reporter by it, never by an
  id.

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
`forwardMessage`, `copyMessage`, `getFile` or `getChat` on a target; no
request goes to any host but the Bot API's (the fake Bot API records any
other, and the specs assert there is none; a bare `fetch(` on a critical
path trips the tripwire, whose pattern `selftest/tripwire-patterns.sh`
pins); no link outside the two exact-host lists is ever sent to the channel,
to a reporter or to a keyholder (the link policy, one test per bypass class:
exact host, https, userinfo, port, query, punycode, redirectors, the
Telegram path rules, applied again at render time); no admin free text with
a URL, bare domain, mention or phone number reaches a post; the fixed
warning line is present in both locales; a source scan finds no Mini App or
inline handler.

Tests:

- `test/invariants/outgoing-messages.test.ts`: every send and edit of every
  handler leaves with previews off and HTML parse mode; nothing is
  forwarded, copied, downloaded or looked up, and no host but the Bot API's
  is called; no inline-mode or Mini App handler in the source.
- `test/invariants/intake.test.ts`: intake is text only, so no media,
  forward, inline-bot message or external reply is stored, and each is
  deleted; nothing is fetched; every link a reporter gets, and every link of
  both catalogs, is on the help hosts; no draft for a refused link of any
  class.
- `test/invariants/review.test.ts`: the review's sends and edits have
  previews off and HTML and link only to the two lists; the points validator
  refuses a URL, a bare domain, a mention, `t.me` and a phone number; the
  post's own links pass the link policy.
- `test/invariants/post.test.ts`: the post leaves with previews off and
  HTML, its targets as code text, its only tappable links on the lists, the
  fixed warning line in both locales, a Telegram target never a link.
- `test/invariants/closure.test.ts`: every edit of a post has previews off
  and HTML and no link off the lists; a correction holding a link, a domain,
  a mention or a phone number never reaches the channel.
- `src/platforms/link-policy.test.ts`: one test per bypass class, the two
  lists every outgoing link is checked against, and the outgoing scan, which
  fails closed.
- `src/review/text-policy.test.ts`: the admin free-text validator, each
  refused class in English and in Persian, and the usual evasions.
- `src/telegram/api.test.ts`: the one transformer puts previews off and HTML
  on every `sendMessage` and `editMessageText`, whatever the caller set, and
  the Bot API is called through the injected fetch only.
- `src/telegram/bot-api-port.test.ts`: the Bot API port holds none of the
  methods rule 4 forbids.
- `src/telegram/render.test.ts`: report data escaped, and URLs as code
  entities that cannot be broken out of.
- `src/review/render-post.test.ts`: the post's targets as code text,
  Telegram targets never a link, every tappable link on the lists.
- `src/review/card.test.ts`: every URL and the comment as code text on the
  card, and the routing card's links on the help hosts.
- `src/telegram/alerts.test.ts`: an alert carrying a link off the lists is
  sent to nobody.
- `src/platforms/instructions.test.ts`: every instruction block links only
  to `TRUSTED_HELP_HOSTS`, and Telegram's never send the member to Start.

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

Tests:

- `test/invariants/outgoing-messages.test.ts`: a message goes only to the
  chat of the update being handled, and nothing for a press, a group or the
  channel; an alert goes to the keyholders, and to the venue only when not
  locked down; no subscription command in the source.
- `test/invariants/post.test.ts`: the only message sent to the channel per
  report is its post, to the configured channel and nowhere else; a run
  messages nobody but the channel, the keyholders and the venue; two runs
  racing on one job post once, and a send that timed out is never sent again
  (both under rule 1's "at most once").
- `test/invariants/closure.test.ts`: over a report's whole life the channel
  gets its post and that post's edits alone (and, for a retraction, the
  deletion of a post younger than 48 hours); the closure messages nobody;
  the retraction's only other messages are the keyholder's own prompt and
  answer.
- `test/invariants/intake.test.ts`: the intake answers in the reporter's own
  chat only, but for the review card of a submitted report, which goes to
  the venue once.
- `test/invariants/review.test.ts`: the review sends to the venue and, by
  direct message, to the keyholders only, never to the channel, a reporter
  or the membership group.
- `test/invariants/storage-retention.test.ts`: no subscriber, ledger or
  per-presser table (asserted under rule 8).
- `src/telegram/respond.test.ts`: a press is answered by its callback
  answer, a private chat and the venue by a reply in that chat, any other
  chat not at all.
- `src/telegram/alerts.test.ts`: alerts go by direct message to every
  keyholder, and to the venue only while the bot is not locked down.
- `src/review/notify.test.ts`: the approval notice goes to every keyholder
  and to nobody else.
- `src/broadcast/post.test.ts`: a due approved report is posted once into
  the channel.
- `src/telegram/presses.test.ts`: "I reported it" counts presses, not
  people, and stores nothing about the presser.
- `test/workers/scheduled.test.ts`: on D1, a due approved report is posted
  once into the channel, and a second run sends nothing.

## 6. Secrets and sensitive data stay out of code, VCS, logs, and telemetry

Why: the token, webhook secret, reference key and allowlists are the
deployment's trust roots, and a reported URL or a reporter id in a log is
a leak to whoever reads the platform's logs. Test: the secret-shape scan
(`.claude/hooks/secret-shape-scan.sh`, in place); the redacting logger
test with a real GrammyError whose payload carries the outgoing text and
chat id, asserting neither reaches the log line; the configuration has no
default for a secret: `BOT_TOKEN`, `WEBHOOK_SECRET`, `WEBHOOK_PATH_SEGMENT`
and `REPORTER_REF_KEY` are refused when the environment lacks them or holds
them blank.

Tests:

- `test/invariants/config-redaction.test.ts`: the loaded configuration is
  unprintable; a failed load never echoes a value; an environment that
  defines `DEBUG`, `NODE_DEBUG` or `NODE_DEBUG_NATIVE` is refused.
- `test/invariants/logger-redaction.test.ts`: an error is logged by class,
  never by content (a real `GrammyError` carrying a reported URL, a comment
  and a chat id, a real `HttpError` carrying the token URL); no Telegram id
  reaches a line, an admin's included; the report-id field keeps a report id
  alone; the logger is the only code in `src/` that touches the console.
- `test/invariants/handler-logs.test.ts`: no log line of any handler or job,
  on any failure path, holds a URL, an id, a text, the token or any part of
  an update.
- `src/config/schema.test.ts`: no secret has a default; `DEBUG` and Node's
  debug switches are refused; a failed load names its variables and echoes
  no value.
- `src/privacy/logger.test.ts`: the redacting logger's allow-list and each
  drop rule, and `logError` recording an error by class and code only.
- `src/telegram/polling.test.ts`: long polling logs a failure by class,
  never the update or the payload, and writes nothing to the console.
- `src/node.test.ts`: on the port, a configuration that does not load
  (`NODE_DEBUG` included), a crash and the entry run without a token each
  log one class-only line, echoing no value.
- `src/worker.test.ts`: `wrangler.jsonc` and `wrangler.probe.jsonc` keep
  Workers observability off, and a configuration that does not load is
  answered 500 with a class-only line.
- `scripts/set-webhook.test.ts`: the script prints the `getWebhookInfo`
  answer alone, its URL's path masked and every string, the URL's origin
  included, scrubbed of the token, the secret token and the path segment in
  any letter case; a configuration that does not load (`DEBUG` and
  `NODE_DEBUG` included), wrong arguments and a failed call are each one
  class-only line.
- `test/invariants/webhook-script.test.ts`: with the production logger and
  the console captured, wrong arguments, a configuration that does not load
  and each of the script's three calls refused (a `GrammyError`) or lost (an
  `HttpError`), every fixture carrying the token, the secret token and the
  segment, each end with one class-only line on stderr, nothing on stdout
  and none of the values on either; a registration that succeeds prints none
  of them.

## 7. Suspected child sexual abuse material is never re-broadcast

Why: recorded for the owner in
[Report categories and routing](../product/report-categories-and-routing.md):
platforms deduplicate so volume buys no speed, every member who opens the
link accesses CSAM, a bot that distributes such links will be banned, and
the hotlines hold escalation lines the NGO cannot get. Test: no path writes
an approval for a report the admin categorises as suspected CSAM, by the
card or by a forged press (Approve offers Route only), and routing leaves no
un-voided approval behind; routing nulls `url`, `account_url` and `comment`
on the report and its merged rows in the same batch; the routing card goes
only to the admin review venue; the intake message for a "sexual content
involving a minor" label carries the hotline links alone, never the reported
URL.

Tests:

- `test/invariants/review.test.ts`: a report the admin categorises as
  suspected CSAM gets no approval, by the card or by a forged press, and the
  post renderer refuses it; Route nulls the links, the comment and the flag
  of the report and its merged rows in one batch; the routing card is only
  ever in the venue, and the reporter gets nothing at routing.
- `src/review/categories.test.ts`: suspected CSAM has no link mode, with or
  without the flag.
- `src/review/render-post.test.ts`: suspected CSAM is never rendered,
  whatever the mode.
- `src/review/route.test.ts`: the routing batch nulls the links, the comment
  and the flag of the report and of every merged row together, and leaves no
  un-voided approval.
- `src/review/card.test.ts`: the routing card shows the links as code, the
  platform's path and the hotlines on the help hosts, and Confirm.
- `src/telegram/review.test.ts`: Approve on the suspected-CSAM category
  leads to the routing card and writes no approval.
- `src/telegram/review-decisions.test.ts`: Route replaces the card with the
  routing card, in the venue only, and Confirm routes and deletes it,
  messaging nobody else.
- `src/telegram/intake.test.ts`: a "sexual content involving a minor" label
  gets a persistent message with the hotline links alone, never the reported
  URL.
- `test/workers/review.test.ts`: on D1, the routing nulls the links of the
  report and its merged rows together.

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
path in the retention table; after the night that follows a report's
closure, or any other terminal path, the only row that references the report
id is the aggregate row and its columns are exactly the aggregate set; the
wipe script leaves only `stats` and `meta`; the configuration refuses an id
present in both `KEYHOLDER_IDS` and `ADMIN_IDS`.

Tests:

- `test/invariants/storage-retention.test.ts`: the schema holds no member or
  reporter identity: no subscriber, ledger or per-presser table, and no
  column that may hold a Telegram id but `approvals.admin_id`,
  `reports.decided_by` and `admin_prompts` (`chat_id`, `admin_id`); a draft
  keyed by the keyed reference; every column classified and every personal
  one in the deletion schedule; no raw id or URL where a keyed value
  belongs; a report takes its approval, prompts, jobs and merged rows with
  it.
- `test/invariants/retention.test.ts`: each deletion path of the schedule at
  its moment and not before; every terminal path leaves, after the night's
  run, only its aggregate row, whose columns are exactly the aggregate set;
  at most 50 finalizations a night; the job runs under either lockdown layer
  and on a lockdown.
- `test/invariants/wipe.test.ts`: the wipe script deletes every table but
  `stats` and `meta`, each once and without a condition, against the bot's
  own database once its name is typed, and leaves a full store's aggregate
  rows and `meta` as they were.
- `test/invariants/intake.test.ts`: no table holds a reporter's Telegram id;
  drafts and reports are keyed by the reporter reference; a draft is gone
  after its submit and its `/cancel`; outside lockdown every message
  received in a private chat is deleted on receipt, a keyholder's own
  commands aside.
- `test/invariants/review.test.ts`: a merged report stores no comment and no
  flag; `comment` and `affected_person` are null on the report and its
  merged rows after every decision; every prompt and reply is deleted from
  the venue; no table holds a reporter's Telegram id.
- `src/privacy/retention.test.ts`: the retention job, one case per path of
  the deletion schedule, its statements counted.
- `src/broadcast/finalize.test.ts`: finalization writes the aggregate row,
  deletes the approval, prompts, jobs and merged rows, and nulls every
  personal field.
- `src/privacy/reporter-ref.test.ts`: the reporter reference is the keyed
  HMAC of the id and never contains it.
- `src/privacy/link-hash.test.ts`: the keyed link hash, never equal to a
  reporter reference.
- `src/review/drafts.test.ts`: the draft and the report are keyed by the
  reference, and a merged report stores no comment and no flag.
- `src/review/approve.test.ts`: the approval nulls the review-only fields on
  the report and its merged rows.
- `src/review/reject.test.ts`: the rejection nulls the review-only fields on
  the report and its merged rows.
- `src/review/route.test.ts`: the routing nulls the links, the comment and
  the flag, keeping the keyed link hash and the aggregate fields.
- `src/review/block.test.ts`: the block list holds the keyed reference,
  never an id.
- `src/telegram/presses.test.ts`: a press stores nothing about the presser.
- `src/telegram/commands.test.ts`: the commands store nothing about the
  sender but the `/language` choice, in a draft keyed by the reference.
- `src/config/schema.test.ts`: an id in both `ADMIN_IDS` and `KEYHOLDER_IDS`
  is refused, naming no value.
- `src/node.test.ts`: the port opens its database owner-only and with
  `secure_delete` on, or does not start.
- `test/workers/finalize.test.ts`: on D1, a closing report concludes and is
  finalized in one batch, and rejected and routed rows are finalized
  set-based.
- `test/workers/intake.test.ts`: on D1, a merged report stores no comment or
  flag of its own.
- `test/workers/d1.test.ts`: on D1, a report's deletion cascades to its
  approval, prompts, jobs and merged rows.

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
no longer approved; `approved` and `posting` need an un-voided approval, the
schema's trigger refusing either status without one, and a re-approval's new
approval id leaves the cancelled one claiming nothing) and
`test/invariants/storage-retention.test.ts` (rule
8 with the owner's rule of 2026-10-28 that no member or reporter identity
is stored: no subscriber, ledger or per-presser table and no reporter chat
id; every column has a classified fate and every personal column is named
in the deletion schedule; no raw Telegram id or URL where a keyed value
belongs; a report takes its approval, prompts, jobs and merged rows with
it), and pinned the logger's report-id shape (rule 6: a username or a hex
digest in that field is dropped). Rules 1, 2, 4, 5 and 8 were amended on
the evening of 2026-10-28 for the seizure threat; the three synced copies
change in the same commit as this document. Unit U2, the Telegram wiring,
added four specs, each driving the composed bot over the fake Bot API
(`test/fakes/bot-api.ts`): `test/invariants/webhook-authenticity.test.ts`
(rule 2: a request off the webhook's path or without the secret is answered
404 before its body is read, before any bot exists and before any Bot API
call, and the compare is `timingSafeEqual` over SHA-256 digests),
`test/invariants/lockdown.test.ts` (rule 2: under either lockdown layer an
admin command and an admin button are refused, a press writes nothing,
intake stores nothing and answers the neutral text, the venue gets no alert;
only a keyholder's `/unlock` clears the switch, with one caller and one
writer in the source; nothing clears the override; a non-keyholder's
`/lockdown` gets an unknown command's answer),
`test/invariants/outgoing-messages.test.ts` (rules 4 and 5: every send and
edit has previews off and HTML parse mode, goes only to the chat of the
update it answers or, for an alert, to the keyholders and the venue when not
locked down; nothing is forwarded, copied, fetched or looked up; no inline
mode, Mini App or subscription command in the source) and
`test/invariants/handler-logs.test.ts` (rule 6: no log line of any handler,
the boundary, the membership check or the alerts holds a URL, an id, a text
or an update). Unit U3, the intake, added `test/invariants/intake.test.ts`
(whole conversations driven through the composed bot over the fakes; rule 4:
intake is text only, so no media, forward, inline-bot message or external
reply is stored and each is deleted, nothing is forwarded, copied,
downloaded, looked up or fetched, every send and edit has previews off and
HTML, and every link a reporter gets, like every link of both catalogs, is
on the help hosts; rule 3: nothing sent to a reporter echoes a reported URL,
an account link, a comment or anyone's id, username, name or reference, and
the acknowledgement is the same bytes for a new and a merged report; rule 5:
every message goes to the reporter's own chat, and a press causes no new
message; rule 8: no table holds a reporter's Telegram id, drafts and reports
are keyed by the reporter reference, a draft is gone after its submit and
its `/cancel`, and outside lockdown every message received in a private chat
is deleted on receipt, exactly once, a keyholder's own commands aside), and
extended the lockdown spec (an intake press answered with the neutral text,
and nothing deleted under lockdown) and the log spec (the intake's failure
paths). Unit U4, the admin review, added `test/invariants/review.test.ts`
(rule 1: no approval row but the one the whole flow writes, with a random
approval id and its start after the grace, none for any press or a reply by
anyone but the asked admin, the status change impossible without its row,
none ever written whose notice reached no keyholder, Cancel voiding it and
deleting its job, a re-approval under a new id; rule 3: the post and the
keyholders' notice carry no reporter reference, comment, id, username or
name and no admin id, and no post URL under the account mode, the card
the reference only; rules 4 and 5: the review's sends and edits have
previews off and HTML, link only to the two lists, and go to the venue
and the keyholders only; rule 7: no approval for suspected CSAM by any
path, Route nulling the links, the comment and the flag on the report and
its merged rows, the routing card in the venue only; rule 8: the comment
and the flag null after every decision, every prompt and reply deleted,
no reporter id in any table), extended `test/invariants/lockdown.test.ts`
to drive the REAL admin surface (every registered admin command, button
prefix and reply refused under either layer, the keyholder's Cancel,
Lockdown and `/open` working, every admin prefix refused to anyone but an
admin, the review's command names hinting nothing in a private chat, a
source scan that no command or button registration bypasses
`src/telegram/registry.ts`, and one that nothing in `src/` registers a
handler but the five registrars of `src/telegram/`, probed with planted
bypasses; and a Lockdown tapped on the notice while the approval's batch
is on its way leaving nothing approved), the review's failure paths, the
approval's unreached, unsent and unreadable notices and batches and one that
committed after failing included, to `test/invariants/handler-logs.test.ts`,
and the review card of a submitted report, sent to the venue once with the
reference and never a reporter's id, username or name, to
`test/invariants/intake.test.ts`. Unit U5, the scheduler, added
`test/invariants/post.test.ts` (rule 1: nothing reaches the channel for a
report that is not approved under a live approval whose start has come, not
for a pending or cancelled report, not before the start, not for the job of
a cancelled approval after a re-approval, not while halted, locked down or
paused, nor once a hold is set after the run read the state, the claim
binding them all in its own statement; a report is posted at most once, two
runs racing on one job, a timed-out send, a 429 and a 400 included;
`/attach` records only this report's own post, by its text and never its
keyboard, and `/repost` is refused once a message id exists; rule 4: the
post leaves with previews off and HTML, its targets as code text, its only
tappable links on the lists, the fixed warning line in both locales; rule 5:
the post is the only message sent to the channel per report, and a run
messages nobody but the channel, the keyholders and the venue; rule 2: the
scheduler's commands are no commands from anyone off the allowlists, and
nobody may `/repost` under lockdown), and extended the lockdown spec (both
lockdown entry points running the immediate retention pass through
`lockdownNow()`, and under either layer the scheduler's admin commands
refused while a keyholder's `/attach` and `/halt` keep working), the
outgoing-messages spec (no alert carrying a tappable link off the lists, to
anyone) and the log spec (the scheduler's failure paths). Unit U6, closure,
retraction, retention, the snapshot and the wipe, added
`test/invariants/closure.test.ts` (rule 1: no closure or retraction edit,
and no order, for a report without its live approval record; under every
failure class of the edit the report keeps `closing` or `retracting` with
its post id and its correction, reconciliation included, and only the edit's
success writes the terminal status; every edit reaches that report's own
post; rule 4: every edit with previews off and HTML, no link off the lists,
a correction holding a link, a domain, a mention or a phone number never
reaching the channel; rule 5: over a report's whole life the channel gets
its post and its edits alone, the closure messages nobody, the retraction's
only other messages are the keyholder's own prompt and answer, and after the
retraction nothing about the report reaches the channel and its button
counts nothing), `test/invariants/retention.test.ts` (rule 8: each
deletion path of the schedule at its moment and not before; every
terminal path leaves, after the night's run, no row holding the report's
id but its aggregate row, whose columns are exactly the aggregate set; at
most 50 finalizations a night; the job runs under either lockdown layer
and on a lockdown) and `test/invariants/wipe.test.ts` (rule 8: the wipe
script deletes every table but `stats` and `meta`, each once, without a
condition, against the bot's own database after a typed confirmation, and
on a full store leaves the aggregate rows and `meta` alone), and extended
the lockdown spec (a keyholder's `/retract` and `/stats` working under
either layer, the retraction's edit running, the admin's closure commands
and buttons refused, retention running, the snapshot kept from the venue)
and the log spec (the closure unit's failure paths). Unit U7, the Node
port, added `test/invariants/polling-authenticity.test.ts` (rule 2 on the
port: only the webhook boundary and long polling hand updates to the bot,
nothing in `src/` opens a server or listens on a port, the port composes the
bot exactly as the Worker does, and the import graphs of the Worker's entry
and of the deployed probe hold nothing of the port, each scan probed with
planted sources) and extended `test/invariants/config-redaction.test.ts`
(rule 6: `NODE_DEBUG` and `NODE_DEBUG_NATIVE`, Node's own debug switches,
refused like `DEBUG`, with no value echoed). Unit U8, the go-live, added
`scripts/set-webhook.test.ts` (rule 2: the webhook is registered with
exactly the deployment's parameters, `secret_token` the `WEBHOOK_SECRET`,
`allowed_updates` `message` and `callback_query` only, `max_connections` 10
and `drop_pending_updates` true, and `--delete` calls `deleteWebhook` with
exactly `drop_pending_updates` false; rule 6: the script prints the
`getWebhookInfo` answer alone, the URL's path masked and every string, its
origin included, scrubbed of the token, the secret token and the path
segment, and a failure is one class-only line), the always-run
`test/invariants/webhook-script.test.ts` (rule 6: the same must-not with the
production logger, every fixture of a refused, lost or wrong call carrying
the three values, none of them on stdout or stderr), extended
`test/invariants/handler-logs.test.ts` with the script's failure paths, and
extended `src/worker.test.ts` (rule 6:
`wrangler.jsonc` and `wrangler.probe.jsonc` keep Workers observability off;
each declares exactly the one cron the Worker runs, pinned there too; rule
2: the Worker's and the probe's import graphs hold nothing outside `src/`,
so never the webhook script). Every
rule now has the specs that pin it listed at the end of its own section,
under "Tests:".

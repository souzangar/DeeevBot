---
type: rule
title: "Retention and minimisation"
description: "What the bot stores about reports and reporters (no plaintext Telegram id of any member or reporter: a keyed reference and counts), for how long, which deletion path removes each field, what survives as an aggregate row, the chat hygiene on every side, D1's 30-day Time Travel history and the emergency wipe, and what never reaches logs or backups."
status: active
tags: [product, rule, retention, privacy, minimisation]
timestamp: 2026-10-28T00:00:00Z
---

# Retention and minimisation

The owner's policy, verbatim: "we don't need keep all of the data for a
long time, when the channel is closed, we can report to users who seen it
and report it and delete them in our db and only count how many of what
we reported." This rule makes it concrete (Q5 in
[Planning decisions](./planning-decisions-2026-10-28.md)), tightened on
the evening of 2026-10-28 after the owner stated the seizure threat
([Threat model: seizure](./threat-model-seizure.md)); catastrophic
invariant 8, "No plaintext Telegram id of a reporter or member is ever
stored, and reports leave only counts behind", pins it. The tables named
below are defined in
[ADR 0006](../architecture/adr-0006-data-model-and-module-layout.md).

## The reporter reference

- The bot stores no plaintext Telegram id of any member or reporter,
  ever. A reporter's Telegram id is held only while the bot handles the
  reporter's own update, and everything it keeps is keyed by an
  HMAC-SHA-256 of the id under a server key, `REPORTER_REF_KEY`, the
  "reporter reference" (the draft's `draft_key`, the report's
  `reporter_ref`, the counters' `reporter_ref`).
- There is no subscriber list and no list of who pressed "I reported it":
  an approved report is posted once into the configured channel, and a
  press only increments the report's count and the day's.
- The reference drives rate limits, rejection counts and blocks without
  identifying anyone from the database alone. Reporters get no decision
  message, so nothing needs a way back to them.
- The exception: the allowlisted admins' and keyholders' own ids, both
  deployment configuration, on their decisions and prompts
  (`approvals.admin_id`, `reports.decided_by`, `admin_prompts.chat_id`
  and `admin_id`).
- The caveat: whoever holds `REPORTER_REF_KEY`, the keyholder, can
  re-identify a reference by brute force over the Telegram id space. The
  reference protects against the seized admins and against a read of the
  database, not against the key holder; the key lives only in the
  deployment's secret store and is never exported. Removing sender
  metadata is not anonymity either: a comment, the reported URLs and the
  affected-person flag can identify the reporter by their content, which
  is why the comment prompt warns against identifying details, the
  comment is limited to 500 characters, and both fields are nulled at the
  decision.
- The review card shows the reference, never the id, username or name.

## Deletion schedule

Every table and column named here is defined in
[ADR 0006](../architecture/adr-0006-data-model-and-module-layout.md) and
created by `migrations/0001_init.sql` and the files after it (`category` on
`admin_prompts` by `0002_prompt_category.sql`); D1 is the only store.

### Finalization

A report that reaches a terminal state is finalized in one D1 batch
([ADR 0004](../architecture/adr-0004-storage-and-delivery-ledger.md);
`src/broadcast/finalize.ts`): the aggregate row in `stats` is upserted,
its `approvals`, `admin_prompts` and `jobs` rows are deleted, the rows
merged into it are deleted, every personal field of the report is nulled,
and `data_deleted_at` is set; every statement is bound to the report being
in its terminal status and not finalized yet, so nothing else is touched
and a second run changes nothing. What remains of the report's row, its id
and its state, is deleted by the next nightly retention job, after which
the aggregate row is the only one that holds the id. Closure and
retraction first edit the report's post (an `edit` job): the report waits
in `closing` or `retracting` until the edit succeeds, which alone writes
the terminal status, and the batch runs then, in the same transaction;
nothing is finalized while the post is unaddressed, and reconciliation
never finalizes a `closing` or `retracting` row. A rejected report's
finalization also counts its rejection off the references it was counted
on (`rejections_30d`), so that count holds the rejections of the last 30
days, as the intake's throttle reads it.

The terminal paths: closure ("taken down" or "closed without result");
retraction; expiry 90 days after the post, through the closure edit (not
while the bot is locked down or halted, when that edit could not run and
the report could no longer be retracted: the next night without a hold
catches up); a pending report's expiry 30 days after intake (status `expired`, outcome
`no_decision`); a rejection, finalized 30 days after it; a routing
(suspected CSAM), finalized 30 days after it, its links being gone at
once. The retention job (`src/privacy/retention.ts`, at 00:15 UTC and at
once on a lockdown) finalizes at most 50 reports a night, the oldest
first, and the rest the next night.

| What | Where | Deleted |
|---|---|---|
| the intake conversation: `draft_key` (the reporter reference, never the chat id), `step`, `url`, `platform`, `account_url`, `category`, `affected_person`, `comment` and `locale` | D1 `drafts` | on submit, on `/cancel`, and by the retention job after 24 hours |
| the review-only fields: the reporter's `comment` and the `affected_person` flag | D1 `reports`, the report and every row merged into it | never stored on a merged row (a merged reporter's flag raises the pending target's instead); at the decision (approval, rejection or routing), since they serve the review only; a pending report's at its expiry |
| the reported links: `url`, `account_url` | D1 `reports`, the report and every row merged into it | at closure (finalization); for a routed report at routing, at once |
| the report's other personal and content fields: `reporter_ref`, `link_hash`, `decided_by`, `rejection_reason` (an internal code), `broadcast_text`, `correction_text` (the retraction text), `link_mode`, `card_message_id`, `status_message_id`, `post_message_id` | D1 `reports`, the report and every row merged into it | at closure (finalization) |
| the report row itself, by then holding only its id, `status`, `platform`, `category`, `merged_into`, its times, `presses` and the state of its post and alerts (`posting_started_at`, `posted_at`, `alert_sent_at`, `needs_attention`, `data_deleted_at`, `closed_at`, `outcome`) | D1 `reports` | by the retention job once finalized (`data_deleted_at` set); a rejected row 30 days after the rejection and a routed row 30 days after the routing, both through finalization; a pending row expires 30 days after intake, finalized and deleted the same night; a merged row at its primary's finalization (and with its primary's row, the foreign key cascading) |
| the approval record: `approval_id` (a random id), `admin_id`, `approved_at`, `link_mode`, `recommended_comment`, `starts_at`, `voided_at` | D1 `approvals` | at finalization, and with its report row |
| a force-reply prompt awaiting an admin's or a keyholder's reply: `chat_id` (the admin venue, or the replier's own chat), `prompt_message_id`, `admin_id` (the replier's id), `report_id`, `kind`, `category` (the category the admin confirmed before the prompt), `link_mode`, `created_at`; with `approvals.admin_id` and `reports.decided_by`, the only Telegram ids stored, all of them the allowlisted admins' and keyholders' own ids (both deployment configuration) | D1 `admin_prompts` | when the reply is captured or refused (a fresh prompt replaces it), when its admin goes Back or opens another prompt for the report, at every decision of its report, by the retention job after 24 hours (its message deleted from its chat first when still within 48 hours), at finalization, and with its report row |
| a job of the one-minute cron and its `payload` (the post of an approved report, or the edit of that post at retraction or closure) | D1 `jobs` | on completion; at finalization; with its report row; abandoned by the retention job once it failed 20 times (its `attempts`), with an alert and nothing finalized |
| reporter counters: `reporter_ref`, `open_count`, `day`, `day_count`, `rejections_30d`, `blocked`, `last_seen` | D1 `reporter_stats` | after 90 days without activity (`last_seen`); a row with `blocked` set persists; a rejection counted in `rejections_30d` is counted off when its report is finalized, 30 days after the rejection |
| daily counts (the global non-member cap, the day's presses against `MARKS_PER_DAY`): `day`, `key`, `count` | D1 `counters` | rows older than 90 days |
| the post of an approved report | the broadcast channel | edited in place to the correction at retraction and to the outcome at closure or expiry, the button removed each time |
| the review card | the admin review venue | within 48 hours of its message (the Bot API's limit, which binds administrator bots as well); a decision older than that edits the card to the outcome without links (a pending report's at its expiry too, outside lockdown), and the venue's auto-delete covers the rest |
| a force-reply prompt's message and the reply to it | the admin venue, or the replier's own chat | when the reply is captured; within the same 48 hours otherwise |
| every message a reporter or member sends the bot in a private chat: each intake step, refused and misplaced messages and every command (a keyholder's own commands excepted) | the sender's chat | on receipt, outside lockdown, by the handler that took it, after the write that recorded it and before the reply, with one retry; if the delete still fails the reply asks the sender to delete it; no message id is kept; under lockdown nothing is read, stored or deleted |
| the intake acknowledgement | the reporter's chat | deletes itself at `min(handlerStart + 25 s, ackSent + 20 s)`; no message id is kept; the hotline message sent for a "sexual content involving a minor" label stays, and carries no URL |
| the keyholder's approval notice (the rendered post text with its Cancel and Lockdown buttons) | the keyholder's chat | edited to "posted" or "cancelled" without links once the outcome is known, by the isolate that sent it (the notices' message ids are kept in that isolate's memory only, never stored) or at the keyholder's own Cancel on it; a notice no isolate remembers keeps its text until its Cancel is pressed, and one whose approval was never recorded (a reply refused after a send that timed out yet arrived, or a failed approval batch whose outcome could not be read) keeps it until its Cancel is pressed more than five minutes after it was sent, which edits it to "cancelled" (a press before that answers that the approval is not recorded yet) |

The `meta` rows hold no personal data: the schema version, the halt flag,
the global pause, the lockdown flag and its once-only alert marker.

Every deletion path above gets a test (invariant 8).
`test/invariants/storage-retention.test.ts` is the storage-level guard: it
fails when the schema gains a subscriber, ledger or per-presser table or
any column that holds or could hold a Telegram id other than the admins'
and keyholders' own, when a column has no classified fate, when a field
this table nulls is not nullable, when a table or a personal column is
missing from this table, or when this table names a column the schema
does not have, or names it under another table; each path's own test
lands with the code that runs it.

## What survives

One aggregate row per report in D1 `stats`: category, platform, day-level
created, decided and closed dates, outcome, the "I reported it" count, and
the keyed link hash. The hash lets the admin's card for a
later report of the same target say "previously reported, outcome X"; the
reporter is never told.

## Chat hygiene

- Reporter side: outside lockdown every message the bot receives in a
  private chat, commands included (a keyholder's own commands excepted),
  is deleted by the handler that took it, after the write that recorded
  its content has committed and before the reply (one retry; then the
  reply asks the reporter to delete it themselves and the failure is
  logged by class), so an abandoned draft leaves no URL in the reporter's
  chat; the
  acknowledgement names the report by platform and date, never echoes the
  URL and deletes itself; no decision message ever arrives; `/start` says
  so.
- Admin side: the review venue is a private supergroup with the bot as an
  administrator holding `can_delete_messages` and auto-delete enabled;
  review cards, prompts and replies are deleted within 48 hours of their
  message (a decision older than that edits the card to the outcome
  without links); reported URLs in cards are rendered as non-tappable
  code text; `comment` and `affected_person` are nulled at the decision,
  so a seized admin account reads only the reports still open.
- Keyholder side: the approval notice is edited to the outcome without
  links, so no target URL stays in the keyholder's chat, but for the
  notices the table above names (one no isolate remembers, one whose
  approval was never recorded).

## Logs and third parties

Logs never contain URLs, comments or Telegram ids of anyone. A
redacting logger enforces this, and a regression test uses a real
GrammyError, whose payload carries the outgoing text and chat id, to prove
the boundary never leaks either. Workers observability and `wrangler tail`
are logs. No third-party error tracker, telemetry or AI service ever
receives report data. Open: whether Workers invocation logs record request
headers, which would put the webhook secret in a log if observability is
enabled.

## Backups, Time Travel and the emergency wipe

- No per-user table exists, so no backup can contain one. The MVP keeps
  no database dumps of its own. A monthly stats snapshot (aggregate rows
  only: the previous month's counts by outcome, category and platform) is
  sent to the keyholders and, unless the bot is locked down, to the admin
  review venue; it is the only export.
- D1 keeps a 30-day point-in-time history of every database (Time
  Travel), which the Cloudflare account holder can restore. Nothing the
  bot does removes it; with no plaintext ids in D1, the 30-day exposure
  is references, URLs and comments.
- The emergency wipe is a documented `wrangler d1 execute` script,
  `scripts/wipe.sh`, outside the Worker, that deletes every row of every
  table except `stats` and `meta` (the lockdown switch stays set), run by
  the keyholder at least a minute after setting lockdown, so that no
  handler writes after it; `test/invariants/wipe.test.ts` pins its
  statement list to every table but those two. It defends against the seized admins, not against a
  seized Cloudflare account: when the account itself is in doubt, the
  second step is `wrangler d1 delete` and recreate, which also removes
  the history and also works when D1 refuses queries (a daily cap
  exhausted). The procedure is in the
  [operations and security runbook](../guides/operations-and-security.md).
- The recovery story after a lost deployment is the re-submission of open
  reports, announced in the channel; nothing in it may depend on an
  account that is already suspended (see
  [ADR 0001](../architecture/adr-0001-runtime-and-hosting.md)).

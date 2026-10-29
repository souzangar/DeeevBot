---
type: adr
title: "ADR 0004: Storage, scheduling and the single post"
description: "D1 as the only store behind a SqlDb port with plain SQL migrations; no Durable Object, no delivery ledger, no pacing; a jobs table drained by a one-minute cron, the approval row as the schedule; each approved report posted once into the channel, at most once, through one claim statement, with the two failure classes and the verified /attach and /repost; edits at retraction and closure; finalization in one D1 batch; reconciliation; the cap contract; D1 Time Travel and the emergency wipe."
status: active
tags: [architecture, adr, storage, d1, scheduling, broadcast]
timestamp: 2026-10-28T00:00:00Z
---

# ADR 0004: Storage, scheduling and the single post

The file keeps its first name, `adr-0004-storage-and-delivery-ledger.md`,
so that every link to it still resolves; the delivery ledger it once
decided is gone.

## Context

The Free-plan meters in [ADR 0001](./adr-0001-runtime-and-hosting.md)
decide where state may live: D1 rows written are capped at 100,000 per
day with index rows and deletes counting; an invocation has 50
subrequests, D1 queries among them; Workers CPU is 10 ms per invocation;
Cron Triggers are limited to five per account. Catastrophic invariants 1
(approval record with a start time) and 8 (deletion at closure) bind the
design. On 2026-10-28, during unit U1b, the owner narrowed the scope: the
bot sends no direct-message broadcasts and stores no member or reporter
identity; an approved report is posted once into a configured channel
owned by the keyholder (`BROADCAST_CHAT_ID`), retraction and closure edit
that post, and "I reported it" is a counter, not a list; reporters get no
decision message. What a seizure of the deployment and of the admins
would yield is the reason (ADR 0001, "Threat model: seizure";
[Threat model: seizure](../product/threat-model-seizure.md)).

## Decision

### Storage

- Cloudflare D1 is the only store, behind the `SqlDb` port
  (`src/db/sql.ts`): `run`, `all`, `first`, and `batch`, the only
  multi-write primitive, one transaction (D1's `batch`; `BEGIN ... COMMIT`
  on node:sqlite). It holds `drafts`, `reports`, `approvals`,
  `admin_prompts`, `reporter_stats`, `counters`, `stats`, `jobs` and `meta`
  ([ADR 0006](./adr-0006-data-model-and-module-layout.md)). There is no
  Durable Object, no delivery ledger and no subscriber table.
- Plain SQL migrations in `migrations/`, applied by wrangler on Cloudflare
  and by `src/db/migrate.ts` on the Node port, each file once, inside a
  transaction with its record. The Node adapter runs the same SQL on
  node:sqlite ([ADR 0002](./adr-0002-language-and-framework.md)).
- No value is ever written into SQL text: a statement is `SqlText`, which
  only the `sql` tag mints and which refuses an interpolation, and every
  value is bound. Every adapter refuses, before running a statement, the
  shapes D1 refuses and node:sqlite would accept silently (a parameter
  count that differs from the placeholders, a second statement in one
  text, more than 100 parameters); the workers tier applies the
  migrations to D1 itself and checks that it builds the same tables.
- D1 keeps a 30-day point-in-time history of the database (Time Travel)
  that the account holder can restore; the MVP keeps no dumps of its own.
  The emergency wipe is a documented `wrangler d1 execute` script that
  deletes every row of every table except `stats` and `meta`, run by the
  keyholder at least a minute after setting lockdown (in-flight
  `waitUntil` handlers may write for up to 30 seconds); it defends
  against the seized admins, not against a seized Cloudflare account,
  whose answer is `wrangler d1 delete` and recreate, the one step that
  also removes the history. When D1 refuses queries (a daily cap
  exhausted, possibly by the attacker), the `LOCKDOWN` secret still stops
  all activity without a query and `wrangler d1 delete` still works. With
  no plaintext ids in D1, the 30-day exposure is references, URLs and
  comments
  ([Retention and minimisation](../product/retention-and-minimisation.md)).

### Scheduling

- One Cron Trigger fires every minute (set with the scheduling unit, U5):
  `tick()` drains the `jobs` table (the due jobs by due time, at most one
  `post` and a bounded number of `edit` jobs per run, each one Bot API
  call), then, by the minute, runs reconciliation every 15th minute, the
  retention job at 00:15 UTC and the monthly snapshot on the first day at
  06:00 UTC; 1,440 invocations a day, each a few subrequests. On the Node
  port an in-process timer runs the same function. Jobs are unique per
  kind and report, kinds `post` and `edit`; an enqueue never resets an
  existing job, which keeps its payload, attempts and due time.
- The approval row is the schedule. Approving writes the approval row,
  under a fresh random `approval_id` and with `starts_at` at the end of the
  grace period, and a `post` job due then, carrying that `approval_id`;
  the job posts only for a report that is still approved, whose approval
  is the job's own (by `approval_id`), is not voided and has reached
  `starts_at`, so rule 1 is a query, a Cancel within the grace (which voids
  the approval) leaves the job nothing to do, and a re-approval, which
  writes a new `approval_id`, is never posted by the cancelled approval's
  job. The schema itself refuses a status update into `approved` or
  `posting` while the report has no un-voided approval (a trigger).
- `meta.lockdown`, set by a keyholder's `/lockdown` and cleared only by
  `/unlock`, and the `LOCKDOWN` secret, the keyholder's override, stop
  every job but a keyholder's `/retract`; a locked-down tick alerts the
  keyholders once (`meta.lockdown_alerted_at`) and still runs retention,
  which reduces exposure, and `/lockdown` triggers an immediate retention
  pass. `meta.halted` (/halt) holds the posts and the closure edits;
  retraction edits still run, since they remove harm. `meta.paused_until`,
  the global 429 pause, holds every job send (post and edit) until it
  passes, because edits, alerts and intake share the bot's API limits;
  nothing is retried in the invocation.
- Reconciliation, every 15th minute: a `post` job past due by two periods
  with no progress (a `posting` row whose job is still present and within
  its window is in progress, not stuck), a `posting` row without an id
  past two minutes, and a `closing` or `retracting` row whose edit job is
  missing are re-enqueued or alerted; a terminal status with
  `data_deleted_at` null (only possible if the finalization batch itself
  failed after the edit) is finalized; `needs_attention` rows are alerted
  once (`alert_sent_at`). Reconciliation never finalizes a `closing` or
  `retracting` row. Every alert goes to the keyholders by direct message
  and, when not locked down, to the venue too; an alert counts as
  delivered once one keyholder got it (one delivered of several suffices,
  as for the approval notice), the misses logged by class with their
  counts, and one that reached no keyholder is sent again by the next
  reconciliation.
- There is no pacing and no batching: one post per approved report.

### The single post

- A report is posted at most once. The post job claims the report by one
  conditional update (`approved` to `posting`, exactly one row changed):
  the claim binds the approval's random id, the lockdown and halted keys
  and the pause in one statement, so two overlapping cron runs never post
  twice, and a run that read a since-cancelled approval, or that a
  lockdown overtook, claims nothing. It writes `posting_started_at` before
  the send and `post_message_id` with `posted_at` (status `posted`) after
  it; `post_message_id` is unique, so no two reports ever hold the same
  post, whether the id comes from the job's write or from a human after
  the alert below. Only unambiguous failures are retried: a 429 reverts
  the claim (`posting` to `approved`, `posting_started_at` cleared) in
  the same batch that reschedules the job for now plus `retry_after` and
  sets `meta.paused_until`; a 400 or 403 (no post rights, chat not found)
  reverts the claim the same way, abandons the job, sets
  `needs_attention` and alerts. A timeout, a network error or a 5xx is
  ambiguous (Telegram may have accepted the send): the report stays
  `posting` without an id, is never re-sent automatically, and is alerted
  once; so is a `posting_started_at` older than two minutes with no
  `post_message_id`, a run cut between the send and the write
  (`alert_sent_at`, `needs_attention`). A human then checks the channel:
  if the post is there, `/attach <id> <message id or t.me/c/... link of
  the broadcast channel>` records `post_message_id` and moves the report
  to `posted`, after verification (the bot calls `editMessageReplyMarkup`
  on that message with this report's own keyboard and accepts only if the
  returned message carries the callback data `mark:<this report id>`); if
  it is not, `/repost <id>` (admitted only while no `post_message_id`
  exists; admins only, never under lockdown) clears `posting_started_at`,
  returns the report to `approved` and re-enqueues. Admins and keyholders
  may `/attach`, under lockdown keyholders only. There is no blind "Post
  again".
- The post carries the reviewed links the category's routing allows and
  admin-authored text, with link previews disabled (rule 4), and an "I
  reported it" button. A press increments `reports.presses` and the day's
  count in `counters`, two D1 writes, at most `MARKS_PER_REPORT` presses per
  report and `MARKS_PER_DAY` a day; beyond either cap the button still
  answers and nothing is written. Nobody's id is kept.
- Retraction and closure each set the report to `retracting` or `closing`
  (the 90-day expiry too) and enqueue an `edit` job that edits the post in
  place: retraction to `reports.correction_text` (written before the
  status change, so a lost job is rebuilt from the row), closure to the
  outcome. Only the edit job's success writes the terminal status
  (`retracted`, `closed` or `expired`). "Message is not modified" and "message to edit not found" are
  non-errors; any other permanent failure is alerted, never swallowed.

### Finalization and the cap contract

- Finalization is one D1 batch: the aggregate row in `stats` (category,
  platform, day-level dates, outcome, presses, keyed link hash) is
  upserted, every personal field of the report and its merged rows is
  nulled, its approval, prompts and jobs are deleted, and
  `data_deleted_at` is set. It runs once the closure or retraction edit has
  succeeded; an edit that cannot be made is alerted, never swallowed, and
  leaves the report in `closing` or `retracting`. Pending expiry,
  rejection and routing finalize without an edit. The retention job deletes the finalized row afterwards.
- The cap contract: a cron run that meets a Free-plan cap error stops
  without writing; the next minute's run picks the due work up again once
  the 00:00 UTC reset has passed, and the keyholders (and the venue when
  not locked down) are alerted once. A cap
  error between a post's send and its id write is the alert case above,
  never a retry.

### The run as built (unit U5)

The scheduler is `src/broadcast/`; what follows is the code as it stands,
and where it refines the plan's wording it says so.

- The entry. `src/worker.ts`'s `scheduled` loads the configuration with
  `configFor(env)` before anything else (one that does not load, a `DEBUG`
  variable included, is logged by class and runs nothing), then
  `handleScheduled()` (`src/broadcast/tick.ts`) dispatches on the cron
  expression: `* * * * *`, wrangler.jsonc's one cron (it replaces the
  nightly `5 0 * * *` of the scaffold), runs `tick()` under the
  invocation's `waitUntil`; any other expression is logged `cron.unknown`
  and runs nothing. The run's Bot API client gives up on a request after
  `SEND_TIMEOUT_SECONDS`, 20 seconds. Nothing escapes the run, and the
  handler never throws, since a throwing cron handler could be retried by
  the platform.
- The order of a run at minute `now` (the scheduled time; the claim and
  every record take the clock's own time): the state of `meta` in one
  query (`lockdown`, `lockdown_alerted_at`, `halted`, `paused_until`, with
  the `LOCKDOWN` override); the lockdown alert; at most one post, unless
  locked down, halted or paused; at most `EDIT_JOBS_PER_TICK` (3) edit
  jobs, unless paused or the post met a 429, and under lockdown or `/halt`
  retractions only; then by the UTC minute reconciliation on every 15th
  minute, the retention job at 00:15 and the snapshot on the first day at
  06:00, under lockdown too.
- The post (`src/broadcast/post.ts`). The due job is the oldest whose
  report is approved under the live approval the job carries, that
  approval's start reached, so a job no claim could take is never picked
  and holds back no other. The stored post is checked again
  (`postProblems()`), then claimed by the statement of the report
  lifecycle, verbatim, then sent once to `BROADCAST_CHAT_ID` with the "I
  reported it" button (`mark:<id>`). By Telegram's answer, keyed on the
  error catalog's flags:

  | Answer | The claim | The job | The report | Alerts |
  |---|---|---|---|---|
  | a Message | kept: `posted` with `post_message_id` and `posted_at`, in one batch | deleted in that batch | attention flags cleared; the keyholders' remembered notices edited to "posted"; the status card to "posted"; the review card deleted (edited to the outcome when it cannot be) | none |
  | retryable (a 429) | reverted to `approved`, `posting_started_at` cleared | due at now + `retry_after` (60 s without one), attempts + 1, with `meta.paused_until` moved there, never earlier, one batch | unchanged | none |
  | a refusal, neither retryable nor ambiguous (a 400 or 403) | reverted the same way | deleted (abandoned), the same batch | `needs_attention` set; the status card says Telegram refused it | the keyholders in both locales and, unless locked down, the venue; `alert_sent_at` once a keyholder got it |
  | ambiguous, or no answer at all (a timeout, a network error, a 5xx, an unknown failure) | kept: `posting` without an id, never sent again | kept, and no run picks it (its report is not approved) | `needs_attention` set; the status card says the post may or may not be there | as above |
  | the send-time check refuses the stored text (before any claim) | none taken | deleted (abandoned) | stays `approved`, `needs_attention` set | as above |
  | a Message whose record fails (a storage failure) | `posting` without an id | kept | unchanged; the run stops | the keyholders only, with the message id, so `/attach` can record it |
  | a Message whose record changes no row (`/attach` recorded the post meanwhile) | none left | deleted | unchanged: posted under the attached message | the keyholders only, with the second message's id, to delete it |

- The edit jobs (`src/broadcast/edits.ts`). A job's payload names its
  action, `{"action": "close"}` or `{"action": "retract"}`; the closure and
  retraction unit registers one handler per action in `EDIT_HANDLERS`,
  empty until then. The runner takes only due jobs of a registered action,
  the oldest first; a handler that throws records the failure on its own
  job (attempts + 1, due again after one to fifteen minutes) and the next
  job runs; a 429 moves the job and the global pause to now plus
  `retry_after` and ends the run's edits; a storage failure stops the run.
  A due job whose row cannot be read (an action outside the two, or none)
  is never run and never silent: it is logged by class
  (`edit.unreadable`), its report flagged `needs_attention` for the alert,
  and the failure recorded on the job, so it comes back after the back-off
  until the retention job abandons it. The runner reads the due edit jobs
  on every run that is not paused, a handler registered or not.
- Reconciliation (`src/broadcast/reconcile.ts`), on every 15th minute: a
  report posting without an id once `POSTING_WINDOW_MS` (2 minutes) is
  over, and an approved report whose post job is overdue by
  `OVERDUE_POST_MS`, are flagged `needs_attention`. "Two periods" is read
  as two reconciliation periods, 30 minutes, so a queue of approvals that
  start together, which the run posts one a minute, is never taken for a
  stall; an overdue job is not flagged while the switch, the override,
  `/halt` or the pause explains it. A report closing or retracting whose
  edit job is missing gets it again (at most 10 a run); a closed,
  retracted or expired row with `data_deleted_at` null is handed to
  `finalize()` (at most 5 a run; rejected and routed rows keep their data
  for 30 days by design). Then ONE alert names the open reports flagged
  and not yet alerted, at most 5 (it fits Telegram in both locales at that
  bound, tested), to every keyholder in both locales and, unless locked
  down, to the venue; they are marked alerted once one keyholder got it
  (one delivered of several suffices, as for the approval notice; the
  misses are logged with their counts), so a keyholder who blocked the bot
  or never sent `/start` holds back no report after them, and an alert that
  reached no keyholder is sent again by the next run. A recorded post,
  `/attach` and `/repost` clear both flags, so a later problem is alerted
  again.
- The lockdown alert: under lockdown, once, to the keyholders only, on the
  run after a keyholder set the switch (within two minutes of its time)
  and otherwise on a 15th minute, the override's included, until a
  keyholder got it (`meta.lockdown_alerted_at`, set on one delivery as the
  other alerts are, cleared by `/unlock` with the switch, and forgotten by
  the run once neither layer holds the bot).
  Both lockdown entry points, `/lockdown` and the notice's Lockdown button,
  call the one `lockdownNow()` (`src/broadcast/maintenance.ts`): the switch,
  the log line, then the immediate retention pass, `runRetentionNow()`.
- A storage failure stops the run where it is, without another write, and
  alerts the keyholders: since that state cannot be kept in the store that
  failed, "once" is kept in the isolate's memory, at most once a UTC day per
  isolate and only on a 15th minute, so a store that stays down sends at
  most 96 alerts a day in the worst case (a fresh isolate for every run),
  and one in the usual case.
- `/attach <id> <message id or t.me/c/... link>` (`src/broadcast/attach.ts`)
  refines the plan's verification, which as worded could not tell the post
  from any message the bot can edit (Telegram returns the message as just
  edited) and refused the post itself (an edit to the keyboard the post
  already carries is answered "message is not modified"). Every decision
  rests on facts Telegram returns about the message, never on its keyboard,
  which the probe itself changes and a lost answer can leave behind:
  - a message held by another report is refused before any call, and
    `post_message_id` stays UNIQUE at the write;
  - the probe edits the message's keyboard to a probe keyboard whose button
    carries no press data (`probe:1`, `probe:2`: the presses parser's exact
    form refuses both, pinned), in one of two variants; "message is not
    modified" means the message carries that variant already, a probe's
    leftover, and only switches to the other variant, so it decides
    nothing and the probe always gets the message back;
  - the returned message is this report's post only when its text is the
    plain text of `reports.broadcast_text` (`plainText()` and
    `samePlainText()` in `src/review/render-post.ts`: the tags removed, the
    entities decoded, trimmed, compared on every visible character, format
    characters such as the bidi isolates left out on both sides since
    Telegram's own cleaning of them is not established offline; the
    deployed probe's fidelity check settles that against Telegram once), it
    was sent between 10 seconds before `posting_started_at` and 60 seconds
    after it (the claim's round trip and a send answered near the 20-second
    bound), and no other report was claimed in that window; the operator's
    answer and the log tell the two refusals apart, a text that is not this
    report's post (`attach.text_mismatch`) and a date outside the window or
    another claim in it (`attach.window_mismatch`), so a systematic text
    mismatch never passes for a mistyped id; a bot post whose text a human
    edited can therefore never be attached, and must not be re-posted;
  - verified, the post's own keyboard is put back (healing a relabelled or
    removed button) before the write, and a post it cannot be put back on
    is not recorded ("try again"); anything else, and a probe Telegram
    answered ambiguously, has the probe keyboard removed again, tried twice
    as the venue's deletions are, a removal that still fails logged by class;
  - the bot's own client gives up on a request after 10 seconds
    (`BOT_TIMEOUT_SECONDS`, `src/telegram/api.ts`, pinned by a test), so a
    probe and its removal fit inside the webhook's `waitUntil`, which the
    runtime ends about 30 seconds after the answer.
  The verification does not rest on the bot being unable to edit others'
  messages (a channel administrator holding `can_edit_messages` can). The
  residuals: a removal that is cut off (the runtime ending the handler, two
  failed tries) can leave a probe keyboard on a wrong message until the next
  `/attach` of it, which removes it, since the message's text and date, not
  its keyboard, decide; and a mistyped id that is another report's post,
  also posting without an id, loses its button to the removal, which that
  report's own `/attach` puts back.
- `/repost <id>` (`src/broadcast/repost.ts`) is admitted from `posting` only
  once `POSTING_WINDOW_MS` is over (inside it the send may not have ended,
  and a re-post could be a second post), and from `approved` with no post
  job; never with a message id, never under lockdown (the statement binds
  the switch). The job an ambiguous send left is kept, carrying the same
  approval.
- `/halt` and `/resume` set and clear `meta.halted` (admins in the venue;
  `/halt` also a keyholder's, in their own chat, under lockdown too);
  `/resume` binds the switch.
- The step budget, counted on the fakes: a quiet run issues 3 statements
  (the state, the due post, the due edit jobs) and no call; a run that
  posts, 5 statements and 3 calls (the send, the status card's edit, the
  card's deletion), plus one edit per remembered keyholder notice; a
  reconciliation run at its bounds stays under 30 subrequests of the
  invocation's 50.
- The slots the closure and retention unit fills, no-ops until then:
  `runRetention()`, `runRetentionNow()`, `runSnapshot()`, `finalize()` and
  `EDIT_HANDLERS`.

### The deployed probe (pending: an owner dependency)

The open measurement below is taken by a throwaway Worker, `src/probe.ts`
with `wrangler.probe.jsonc`: the Worker itself, with every D1 call and
every Bot API request of an invocation counted and logged once, as
`probe.invocation` with `queries` and `apiCalls`, through the redacting
logger. It also carries the one-time fidelity check of `/attach`'s text
comparison, which is validated offline only against a fake that keeps a
post's text by `plainText()` itself: a POST to `/<segment>/fidelity` with
the webhook's secret header sends each sample post (`fidelitySamples()`: a
rendered bilingual post, Persian first, with code lines, for an X report
and for a Telegram one) to the throwaway channel, probes it with
`editMessageReplyMarkup` as `/attach` does, checks `samePlainText()` of the
text Telegram returns against the rendered post, deletes it, and answers
the verdicts as JSON, numbers only. `npm run probe:dry-run` bundles it
offline. It was not run: it needs the owner's Cloudflare account through
the VPN. The procedure, from the keyholder's machine, logged in with
`npx wrangler login`:

1. Create a throwaway bot with @BotFather; never use the real bot's token,
   whose webhook the probe would move. Create a throwaway channel for
   `BROADCAST_CHAT_ID`, and make the throwaway bot its administrator with
   the rights to post and to delete messages.
2. `npx wrangler d1 create div-report-probe`, and put the printed id in
   `database_id` of wrangler.probe.jsonc on that machine only (never
   committed); then `npx wrangler d1 migrations apply div-report-probe
   --remote --config wrangler.probe.jsonc`.
3. `npx wrangler deploy --config wrangler.probe.jsonc`, then
   `npx wrangler secret put <NAME> --config wrangler.probe.jsonc` for each
   variable of the configuration: `BOT_TOKEN`, `BOT_ID` and `BOT_USERNAME`
   of the throwaway bot; a fresh random `WEBHOOK_SECRET`,
   `WEBHOOK_PATH_SEGMENT` and `REPORTER_REF_KEY`; `ADMIN_IDS=1` and
   `KEYHOLDER_IDS=2` (no admin or keyholder takes part); any non-zero
   `ADMIN_CHAT_ID` and `MEMBERSHIP_CHAT_ID`; the throwaway channel's
   `BROADCAST_CHAT_ID`. Never `DEBUG`.
4. Register the webhook, the token read with `read -rs TOKEN` so that it
   stays out of the shell's history: `curl -s
   "https://api.telegram.org/bot$TOKEN/setWebhook" --data-urlencode
   "url=https://div-report-probe.<account subdomain>.workers.dev/<segment>"
   --data-urlencode "secret_token=<secret>" --data-urlencode
   'allowed_updates=["message","callback_query"]'`.
5. `npx wrangler tail div-report-probe --format json` in a second terminal.
6. The fidelity check, once: `curl -s -X POST -H
   "X-Telegram-Bot-Api-Secret-Token: <secret>"
   "https://div-report-probe.<account subdomain>.workers.dev/<segment>/fidelity"`.
   It must answer 200 with `"samePlainText": true` for every sample; record
   the answer here with its date (its `checkedAt`). A `false` means
   Telegram keeps a post's text otherwise than `plainText()` renders it, and
   `/attach` would refuse every real post with `text_mismatch`: fix
   `plainText()` or `samePlainText()` (the sample's `firstDifference` says
   where the two texts part) and run the check again before `/attach` is
   relied on.
7. From the owner's own Telegram account, send the throwaway bot one link,
   `https://x.com/someone`: one webhook update through the real boundary,
   the configuration memo, the reporter reference's HMAC, grammY's parse,
   the draft's write, the deletion and the rendered reply. Wait for one cron
   minute that is no 15th minute: one run against an empty D1.
8. Record here, with the date and wrangler's version: the fidelity check's
   answer (step 6), and for the update and for the run the CPU time of the
   invocation (the Worker's metrics in the dashboard, or the tail event's
   CPU figure where it shows one) and the `queries` and `apiCalls` of its
   `probe.invocation` line, against the 10 ms CPU and the 50 subrequests of
   the Free plan.
9. Tear down: `curl -s "https://api.telegram.org/bot$TOKEN/deleteWebhook"`,
   `npx wrangler delete --config wrangler.probe.jsonc`,
   `npx wrangler d1 delete div-report-probe`, and revoke the throwaway
   bot's token with @BotFather.

Offline, the same counts are pinned by `src/probe.test.ts`: one link-free
update (`/start`) costs one D1 query and two Bot API calls, and a quiet
cron run three queries and no call.

## Consequences

- D1 writes per report stay small: a few dozen rows over its lifecycle
  (the report, its approval, its prompts and jobs, the aggregate row and
  the index rows), plus one row per "I reported it" press.
- No idempotency ledger is needed: the post is at most once by
  construction, and an edit repeated after a cut run is a "not modified"
  non-error.
- The Durable Object meters no longer apply; the Workers request meter
  (webhook updates, presses, 1,440 cron runs a day) and D1's are the ones
  that count.
- The Node port runs the same jobs function on a timer, over node:sqlite.
- Open measurement for the MVP plan: the per-update CPU of the webhook
  path (configuration memo, HMAC, grammY parse, render), confirmed once by
  a deployed probe; built in unit U5 and pending its run on the owner's
  account ("The deployed probe" above).

Tests this decision requires: the post job posts nothing for a pending,
cancelled or not-yet-started approval, nor under a re-approval for a job
of the cancelled approval (the claim binds the `approval_id`); a status
update into `approved` or `posting` without an un-voided approval is
refused; a post is never sent twice
(`posting_started_at` before the send, the alert for a missing id, no
automatic retry); an enqueue never resets a progressed job; retraction and
closure edit the post and never send a new message; finalization leaves
only the aggregate row; a press after closure writes nothing; a cap error
leaves the store unchanged; two ticks racing on one due job post once; a
timed-out send is never re-sent; a 429 reschedules without re-sending; a
locked-down tick sends nothing; an attach of another report's message id
is refused, as is an attach of a message the bot did not send; `/attach`
then `/retract` edits the attached message. The storage-level ones are
`test/invariants/approval-record.test.ts`,
`test/invariants/storage-retention.test.ts` and
`src/db/d1-schema.test.ts`; the rest land with the units that run them.

## Alternatives considered

- A broadcaster Durable Object with alarms, a delivery ledger, bucketed
  marks and a paced direct-message fan-out to subscribers: this record's
  first decision, built in unit U1b and removed the same day with the
  owner's scope change, because every one of those tables held member
  identities.
- Retrying a post whose message id was not stored, or a blind "Post
  again" command: rejected; the first send may have succeeded, so a
  second is a second post; the alert lets a human decide, with the
  verified `/attach` or `/repost`.
- Cloudflare Queues: not used; the Free tier allows 10,000 operations per
  day, and a minute cron over a D1 table needs none.
- Retrying 429 inside the invocation: rejected; it bursts against the
  flood limit and spends CPU; pausing every job is the defined behaviour.

## Status

Accepted 2026-10-28.

Amended 2026-10-28 (Phase 3, unit U1b): after the owner's scope change,
retitled in substance from "Storage and the delivery ledger" to "Storage,
scheduling and the single post": D1 only, no Durable Object, no ledger, no
pacing; the jobs table drained by a one-minute cron, the approval row as
the schedule; the single post made at most once and edited at retraction
and closure; finalization in one D1 batch; the cap contract; then, from
the plan's revision 8, the post claimed by a conditional update to
`posting` and the two lockdown layers; then, from the devil's round on the
plan, `closing` and `retracting`, the terminal status written only by the
edit job's success, the claim bound to the approval's random
`approval_id`, and `post_message_id` unique; then, from the domain audit
of the unit, the trigger that refuses an `approved` or `posting` status
without an un-voided approval; then, from the plan's closure (revisions
R10 and R11), the two failure classes with the 429 revert of the claim,
the verified `/attach` and `/repost`, reconciliation's scope, the
keyholder alerts, Time Travel and the emergency wipe.

Amended 2026-10-28 (Phase 3, unit U5): "The run as built": the cron's
dispatch and the run's order, the failure classes of the post as a table,
the edit jobs' registry, reconciliation's windows (two reconciliation
periods for an overdue job), the lockdown alert's cadence and the one
`lockdownNow()`, the storage alert kept per isolate, the verification of
`/attach` refined (Telegram's "message is not modified", the send window,
the probe undone), the window `/repost` waits for, and the step budget; and
"The deployed probe", built and pending the owner.

Amended 2026-10-29 (Phase 3, unit U5, after its domain audit): an alert
counts as delivered once one keyholder got it, in reconciliation and for the
lockdown alert as for the approval notice; `/attach` decides by the
message's text and date, never its keyboard, through a probe keyboard that
carries no press data, with the bot's client bounded at 10 seconds; a send
whose record changes no row alerts the keyholders with the second message's
id; an edit job whose row cannot be read is logged and its report flagged;
the scheduler client's bound pinned by a test.

Amended 2026-10-29 (Phase 3, unit U5, the audit's re-check): the deployed
probe's one-time fidelity check of the text comparison against Telegram
(step 6), and `/attach`'s two refusals, by text and by window, told apart
to the operator and in the log.

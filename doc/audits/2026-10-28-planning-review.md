---
type: audit
title: "Planning review (2026-10-28)"
description: "The angel's two review rounds on the Phase 1 decision brief (objections, suggestions and dispositions, the owner's answers, the research note's unverified items); the Phase 3 MVP plan review (four angel rounds and the codex devil's 21 objections with their dispositions, the devil's unverified scope, the open items carried into the units); and the scope reduction review of the same evening: the owner's threat statement and answers, the angel's rounds 5 to 7, the devil's 14 objections on R9 with their dispositions, closure at R11; and the implementation closing note: the MVP's commits, unit by unit, the decisions taken without the owner, to confirm, and the owner dependencies still open."
status: active
tags: [audit, planning, review, angel, devil]
timestamp: 2026-10-28T00:00:00Z
---

# Planning review (2026-10-28)

Two reviews of the same day. The first part covers the Phase 1 decision
brief (revisions R1 to R3 of 2026-10-28), reviewed by the angel on the
Claude lane in two rounds. The decisions themselves are in
[Planning decisions](../product/planning-decisions-2026-10-28.md). The
dispositions below are the brief's own record; the objection summaries
are derived from those dispositions because the review transcript is not
part of the bundle. The second part,
[MVP plan review](#mvp-plan-review-phase-3-2026-10-28), records the
Phase 3 review of the MVP implementation plan: four angel rounds and one
codex devil run.

## Round 1: twelve objections

| # | Objection (as derived from its disposition) | Disposition |
|---|---|---|
| 1 | a post-URL broadcast of a private-data report amplifies the leak | conceded: the owner chose an account-only default, post URL by admin opt-in, the affected-person flag, and no post URL ever for intimate images (Q2) |
| 2 | the trust roots and the blast radius of a wrong approval | conceded: the BotFather owner account as root of trust, mandatory 2-step verification, succession, the grace period with Cancel and /halt, no per-user backups, the reference key never exported (Q5, Q6, Q10) |
| 3 | the Cloudflare meters as first briefed did not hold | conceded: meters corrected, ledger and marks moved to DO storage, global 429 handling, quota-exhaustion behaviour, a per-day budget, DO CPU checked (30 s, no Free distinction stated), measurement still required (Q10) |
| 4 | rule 1 bound the wrong object | conceded: rule 1 reworded around the approval record |
| 5 | rule 5 promised "at most once" without a mechanism | conceded: scoped to direct messages, bound by construction, no number in the rule |
| 6 | rule 6 left platform logs and the other secrets out | conceded: rule 6 scoped; platform logs count as logs; the GrammyError test |
| 7 | retraction and closure had no mechanism, review cards lingered | conceded: edit-first retraction and closure; a supergroup venue with the bot as admin; the mirror message id stored |
| 8 | the CSAM path: what remains stored, what the admin sees, how doubt is resolved | adapted: URL and comment deleted at routing; the intake message deleted; doubt defined as doubt about the sexual nature; the admin decides from the description and non-media context and never opens media (accepted because hotline analysts triage anonymously and the alternative is opening the material); the reporter acknowledgement carries hotline links |
| 9 | reporter counters and duplicate handling re-identified people | conceded: counters pseudonymous and expiring, key never exported; severance after the decision notice; duplicates as merged rows; deletion paths covered by tests; no per-user backups |
| 10 | two admins could decide the same report | conceded: first decision wins by conditional update |
| 11 | the acknowledgement revealed whether a target was already reported | conceded: identical acknowledgements |
| 12 | rule 7's hotline reference and rule 3's scope | conceded: rule 7 points to the runbook; rule 3 scoped to the links |

Suggestions S1 to S12 were adopted. The brief records three
individually: S1 adapted (mirror chat recommended, the direct-message
fan-out stays as briefed); S6 (the defined quota-exhaustion behaviour:
persist, reschedule for 00:05 UTC plus jitter, alert once, stall
detector, per-day budget); S10 adapted to the owner's "anyone, stricter
limits for non-members". The others are folded into the decisions without
individual titles in the brief. Flags adopted: the re-evaluation trigger
for Telegram Serverless; the Bot Developer Terms paragraph on scope
changes (cited as 5.3 in round 1, corrected to 5.2 in round 2); the
weaponisation line kept; the random webhook path; the cursor skip
documented; the first-person reporting guidance from the research note.

## The owner's answers reflected in the dispositions

- Counsel: none. "we don't have official way to contact with the
  platforms and our government don't care about these things." Rule 7 was
  adopted after the hotline route was presented as the alternative.
- Private-data default: first "should be both account link and posts.";
  after the Bot Developer Terms 5.2(i) were put on the table, "Account
  link by default, post URL by admin opt-in" (#1).
- Who may report: "Anyone, with stricter limits for non-members" (S10).
- Approval grace period: 5 minutes, with Cancel and /halt (#2).

## Round 2: seven objections, all conceded

| # | Objection (as derived from its disposition) | Disposition |
|---|---|---|
| 1 | the bot as an admin of the NGO group | conceded: never an admin; membership checked as a plain member (verified at MVP) or anchored on a channel the bot administers; leaving the chat does not unsubscribe |
| 2 | the Bot Developer Terms citations | conceded: corrected to 5.2(i) and 5.2 |
| 3 | closure notices to people who had unsubscribed | conceded: only to pressers still subscribed; mirror-chat presses get the edited post; a regression test |
| 4 | the grace period was outside rule 1 | conceded: rule 1 binds the start time; Cancel voids the approval; the broadcaster re-reads status |
| 5 | a re-reported target's prior outcome shown to the reporter | conceded: shown on the admin card only |
| 6 | rule 1's audience | conceded: scoped to the broadcast audience (subscribers as such, or the mirror chat) |
| 7 | the meter table | conceded: amended (DO duration 13,000 GB-s; DO requests include "I reported it" presses; DO storage 10 GB per object; an admin bot's request cost) |

Suggestions adopted: S1, text-only intake with media refused and deleted;
S2, a global non-member cap; S3, one commit for docs and rules, with
CLAUDE.md's Error handling section filled from Q9 in that commit. Flags
adopted: double delivery to mirror-chat members who also subscribe is
stated; "unless they press" on the mirror chat's stored ids; retraction
within the hour; the brief's and the install audit's open lists updated
by doc-scribe. Rule 6 "storage" and rule 7 "admin review venue" wording
applied.

## Research note: unverified items that touch a decision

Section 10 of the research note of 2026-10-28 ("could not be confirmed
from a primary source"); a claim marked [S] or [W] there came only through
a search result or a summarising tool. Items 3, 4, 7, 10 and 12 are
research-side gaps that touch no decision.

- (1) Forwarded channel posts on Telegram: no source says a report is
  routed to the origin bot; the API and client code address the channel;
  moderator handling is undocumented. Decision touched: the Telegram
  instruction block says to report the channel, the post and the bot
  (Q7); the owner's observation is recorded as unverified moderator
  behaviour.
- (2) Telegram's live, server-driven report option tree, including
  whether a harassment option exists. Touched: the instructions use the
  static reasons; verify from a logged-in client before the fa/en copy is
  final.
- (5) How an NGO gains priority or accepted-sender status for
  abuse@telegram.org and stopCA@telegram.org; whether individuals may use
  stopCA@; "The brief's '@StopCA bot' is not supported: t.me/stopCA is a
  channel." Touched: the routing card lists the email for
  Telegram-hosted targets and assumes no priority.
- (6) Telegram deduplication, identical-text rules and the thresholds for
  automatic limits. Touched: the broadcast asks for one genuine report in
  one's own words.
- (8) Bot API: the exact 403 and 429 strings come from the Bot API server
  source, not core.telegram.org; the paid-broadcast Stars thresholds
  conflict between Telegram's own pages; "~30 messages per second" is
  stated as "about". Touched: the error classification, the 25 msg/s
  target, and paid broadcasts not being relied on (ADR 0004, ADR 0005).
- (9) No official Instagram sentence that report count does not decide
  removal (found only for Facebook). Touched: broadcasts never promise
  removal.
- (11), (13), (14) No public application route for Meta Trusted Partner,
  an X escalation programme or TikTok's Community Partner Channel.
  Touched: roadmap, see
  [Trusted-flagger programmes](../reference/trusted-flagger-programmes.md).
- (15) INHOPE's per-country entry was not verified ("country unknown" in
  the note; the country is Iran); EU trusted-flagger eligibility needs an
  EU entity. Touched: the routing card uses the global portals (NCMEC,
  IWF, ICMEC-IWF), see [CSAM hotlines](../reference/csam-hotlines.md).
- (16) The IWF, NCMEC and INTERPOL pages read carry no explicit "do not
  download / forward" sentence (INHOPE and the platform pages do).
  Touched: the runbook's rule rests on INHOPE and the platforms.

## Open after the review

- Measure in the MVP plan: the subrequest and CPU cost of a 35-send batch
  in a DO alarm on the Free plan; DO storage write plus `setAlarm`
  atomicity.
- Whether Workers invocation logs record request headers.
- The unverified items above, in particular (1), (2) and (5).

## MVP plan review (Phase 3, 2026-10-28)

Scope: the MVP plan brief of 2026-10-28 (revisions R1 to R6, marker
PLAN-R6), the implementation plan for units U1a to U8. The plan is not
restated here; the decisions it builds on are in
[Planning decisions](../product/planning-decisions-2026-10-28.md) and the
ADRs, and the docs it amends are listed under the open items. The
dispositions below are the brief's own record (its section 9); the
devil's objections are summarised from the lead sentence of each.

### Process

Four angel rounds on the Claude lane and one codex devil run. Angel round
1: fifteen objections, ten suggestions, ten flags; round 2: eleven, six,
five; round 3: seven, two, two. Their folds took the brief to revision
R4. Then ONE codex devil plan run, on revision R4 (`DEVIL_RUN: mode=plan
base=n/a critical=0 escalate=1 effort=xhigh model=gpt-6-astra`; session
`01a18382-a3ad-7662-b20f-ab30be3c66c3`; brief sha256
`11ebff61db360e4956515fad36f999ac7f822f973880739bc4845da44a9f29b8`;
`DEVIL_QUOTA: 7d[used=3% left=97% resets=2026-11-04 02:10]`). Verdict
FIX-FIRST ("Resolve the cross-store recovery, scheduler, retention, and
capacity defects before implementation is dispatched"), 21 objections,
all conceded with a fix in the text (revision R5). The devil re-ran the
premise's nine capability searches at commit 9f61dc7 and found three
existing constraints their scope missed: the configuration permitted 30
messages per second where the decided ceiling is 25
(`src/config/schema.ts`); the lease-holder regression was already
required by [Critical invariants](../architecture/critical-invariants.md)
(rule 5: "a runner without the lease cannot advance"); grammY's webhook
timeout rejects its wrapper without cancelling the handler. They surface
as objections 12, 1 and 21. The Phase 1 dispositions travelled in the
brief as claims for the critic to verify (its section 10); one of them,
the global 429 pause, was found to lack its mechanism (objection 12).
Angel round 4, on revision R5, verified the devil folds: ten objections
and two flag groups, all conceded and folded literally; the brief records
that three folds did not work as written and were rewritten. Closure was
declared by disposition completeness at revision R6 (every objection
conceded and folded, none rebutted, no verdict awaited), after which unit
U1a was dispatched.

### The devil's 21 objections and their dispositions

| # | Objection (the critique's lead sentence) | Disposition (the brief's "Devil round on R4" block) |
|---|---|---|
| 1 | The lease and stop protocol is missing: a `lease` column declared, but no acquisition, fencing or rejection of stale commits | conceded: the fencing token on `broadcast.lease`, `abort()`, conditional commits, the mid-await abort test |
| 2 | Reconciliation cannot reconstruct a lost retraction: the correction text lived only in the DO job payload, written after the D1 status change | conceded: `reports.correction_text` written before the status change; reconciliation re-enqueues from D1 |
| 3 | Final deletion has an unresolved transaction boundary: D1 and DO data deleted with no durable intermediate phase | conceded: the three D1-anchored finalization phases of the brief's section 4a, with fault tests between them |
| 4 | Routed CSAM reports retain links with no cleanup path: `account_url` and merged rows kept; `routed` outside reconciliation and retention | conceded: `account_url` and merged rows nulled at routing; `routed` rows deleted at 30 days |
| 5 | Decision-notice retries and severance have no durable representation | conceded: `notice_state`, attempts and next time; bounded retries by the crons; severance in the same batch as `sent` or `abandoned` |
| 6 | The minimum-alarm rule can spin on work that cannot run: a past `next_start_at` wins the minimum while a broadcast runs | conceded: `next_start_at` is a candidate only while nothing runs; the start phase runs when a broadcast finishes; `ensureAlarm` at the end of every handler |
| 7 | Reconciliation does not cover interrupted broadcasts, and its alert-once marker lived on the row whose absence triggers the alert | conceded: reconciliation re-creates a missing batch job, alerts on a missing `broadcast` row without restarting; the marker is `reports.alert_sent_at` in D1 |
| 8 | Quota recovery requires writes to the exhausted store: `setAlarm` is itself a billed write | conceded: the step stops without writing, the cron re-arms after the reset, the alert goes through the Worker; fault tests on `commit` and `setAlarm` |
| 9 | The Free-plan lifecycle arithmetic does not stand: 50k mark inserts and deletions are 100k row writes before anything else | conceded: bucketed marks (one write per press, 256 deletes), the daily mark cap, the corrected capacity statement in ADR 0001 |
| 10 | The subrequest test bounds the wrong execution unit: the handler drained what was due while the test bounded one step | conceded: one step per invocation; the budget test is per invocation |
| 11 | Cleanup is not bounded while queued: the 24-hour clock from `first_attempt_at`, notices behind broadcasts, `/halt` stopping every tick | conceded: closure and retraction preempt batches; the 24 hours count from `created_at`; `/halt` never stops retraction edits |
| 12 | The claimed global 429 pause remains job-local, and the configured maximum of 30 violated the decided 25 | conceded: `meta.paused_until` honoured by every step, tested across jobs; the pacing maximum lowered to 25 |
| 13 | The approval flow omits required review inputs: no final category, no durable "Other" instructions, the affected-person restriction untested | conceded: category confirmation, the restricted link-mode set, the "Other" instructions prompt, tests |
| 14 | Two decided abuse controls disappear: the three-rejections-in-30-days throttle and the exemption of blocked entries from counter expiry | conceded: the three-rejections throttle at intake; blocked rows exempt from counter expiry |
| 15 | The pure `tick()` contract cannot produce the declared commit: no send results among its inputs | conceded: `plan()`/`apply()` with the result transition and mixed-outcome tests |
| 16 | "Unique upsert" is weaker than the promised reconciliation idempotence: an upsert can reset progress and retry deadlines | conceded: `INSERT OR IGNORE`; the progressed job survives reconciliation |
| 17 | Marks can outlive the deletion they are supposed to obey: no uniqueness, no provenance, old buttons recreate rows after closure | conceded: bucket de-duplication, rejection after closure, the cap |
| 18 | Deletion failure is incorrectly equated with successful retraction | conceded: edit-first retraction; deletion failure never treated as removal; unaddressable edits counted and alerted |
| 19 | Chat cleanup lacks the identifiers and lifecycle needed to execute it: no intake message ids on drafts, no card deletion after decisions, the admin-rights 48-hour bypass unsupported | conceded: `drafts.message_ids`; the review card deleted after every decision with the edit fallback; the admin-rights deletion beyond 48 hours treated as unverified |
| 20 | The Node fallback omits periodic maintenance: retention, reconciliation and snapshots only on Worker cron | conceded: the Node port runs the three scheduled functions |
| 21 | Catching the webhook timeout does not contain the handler: grammY's timeout rejects the wrapper while the task keeps running | conceded: the handler continues under `waitUntil`, handlers idempotent per update, the test asserts 200 while running |

### The angel's structural outcomes, per round

Round 1 (fifteen objections, ten suggestions, ten flags; all conceded or
adapted):

- the data model completed: drafts, comment capture via
  `card_message_id`, `locale` on reports, `counters`, `source` on marks,
  the DO's `jobs` and `meta` (halt and budget), schema versioning;
- the ports-and-fakes unit: U1 defines every port with a fake, U4
  schedules through the port; the `useApi` seam and the fake's contract;
- the jobs table, the min-alarm and `ensureAlarm`; commands enqueue, the
  DO job sends and edits, deletion on completion, merged rows deleted
  with the primary, chunked IN lists;
- measurements turned into countable tests, one deployed probe, the
  owner's live membership probe at go-live, header logging recorded as a
  fact; the catch-all webhook boundary with its test; config memoised;
- the pure step (then `tick()`, split into `plan()`/`apply()` after the
  devil round); the eslint override for the two Node files;
- pending expiry and draft expiry with tests; the venue mandatory,
  "admin notes" removed, `/resume` defined; the command surface and the
  status card; the ask-the-reporter else-branch and `link_hash`; the i18n
  mechanism in U1, content in U3, parity test; grammY on Workers decided;
  the logger allow-list and the `HttpError` test;
- S1 to S10 adopted (among them 404 for unauthenticated requests,
  `node:sqlite`, the 4096 validation, notices never echo the URL, the
  budget in the DO, the `MEMBERSHIP_CHAT_ID` rename); flags adopted: the
  stale-alarm and block-mid-broadcast tests, three crons on distinct
  minutes, DO schema versioning, per-locale render tests with bidi
  isolation, mirror failure continues with an alert, the
  merge-after-decision notice, the anchor and the OKF gate per unit,
  `edited_message` stated.

Round 2 (eleven objections, six suggestions, five flags; all conceded):

- `broadcasting → retracted` with the batch jobs deleted and the
  broadcast row aborted;
- the approval row as the schedule (no start job, no `schedule`/`cancel`);
  one reconciliation function on the 15-minute cron and on every DO
  entry; jobs bounded at 20 attempts or 24 hours with deletion still run
  and one alert;
- `admin_prompts` keyed by the prompt's message id, the link mode stored
  there, a 24-hour deletion path;
- `commit(writes[])`, the adapter arming `min(due_at)` inside the
  transaction, no correctness claim resting on the alarm joining it, the
  lost-alarm test;
- `/open` and the status card, edited at closure to the outcome without
  links; mirror 429 and 5xx handled like any send, continue only on 400
  and 403; no Telegram id of anyone in logs; the test seam as a field set
  under `runInDurableObject`; `rejection_reason` internal and the notice
  neutral; closure does not sweep the delivered messages;
- S1 to S6 adopted (`timingSafeEqual` over digests, cached texts in the
  `broadcast` row, the Telegram-HTML parse test, the member definition);
  flags adopted: the probe as an owner dependency, `source` from the chat
  type, the "Block reporter" button, re-approval upserts over the voided
  row, job payloads deleted and listed in the retention table. U1 was
  split into U1a and U1b; the Bot API fake and the Broadcaster fake moved
  to U2.

Round 3 (seven objections, two suggestions, two flags; all conceded):

- `ensureAlarm()` on every entry, `reconcile()` on the cron only,
  `UNIQUE(kind, report_id)` with idempotent upsert, tests for both;
- `meta.next_start_at` written by `ensureAlarm(at)` and advanced by the
  start phase; the start phase runs whenever no broadcast is running;
- bounds by kind, `batch` never abandoned (the 24 hours from
  `first_attempt_at`, changed to `created_at` by the devil round);
- no `selective` flag; the reply matched on the allowlist plus the prompt,
  the replier is the approving admin, prompt and reply deleted after
  capture, the prompt key `(chat_id, prompt_message_id)`;
- a progress cursor in the job payload committed per step; the step-budget
  test covers edit steps;
- typed i18n keys (units add their keys); `starts_at` and state on the
  status card and `/open`; at most 50 "no decision" notices per retention
  run; `broadcast.alerted_at` (moved to `reports.alert_sent_at` in D1 by
  devil objection 7).

Round 4, on revision R5 (ten objections and two flag groups on the devil
folds; all conceded, folded literally):

- the Workers path calls `bot.handleUpdate` under `waitUntil` and never
  `webhookCallback`; the alarm handler catches everything after its sends
  and returns;
- the `deliveries` insert is unconditional; the fencing token guards the
  cursor, counters and enqueue; the sweep pages by `batch_no`;
- one row write per press through `appendMark`, no `meta` write, the day
  in the entry;
- the finalization discriminator (approval row present or absent) and
  D1-only finalization for rows without DO data;
- the preemption doc amendments listed in U6; drift removed (no
  `first_attempt_at`, no `cap_retry`, `needs_attention` added,
  reconciliation is a Worker function, re-arm due-now after the last
  batch);
- the approved notice goes out from the start phase and the reporter id
  is kept until then; the review card is deleted in the start phase with
  the edit fallback; the progressed-job test.

### The devil's unverified scope

Quoted from the critique:

> UNVERIFIED: Application behavior and proposed regression tests—the
> implementation does not exist; live Cloudflare CPU/quota/logging and
> Telegram deployment behavior—no deployment probes performed; full
> platform-reporting reference text—only targeted sections and searches
> reviewed.

### Open items carried into the units

- The deployed probe before U5 is marked done: a throwaway Worker with a
  DO alarm making 38 stub fetches and one webhook-path invocation doing
  the per-update work (config memo, HMAC, grammY parse, render), run on
  the owner's Cloudflare account through the VPN, confirms the production
  ceiling (50 subrequests, DO CPU) once; an owner dependency (account and
  VPN); the result is recorded in
  [ADR 0004](../architecture/adr-0004-storage-and-delivery-ledger.md) and
  the throwaway Worker is deleted afterwards. The DO row-write meter
  cannot be measured on fakes (objection 9), so the capacity statement
  stays arithmetic, recorded in
  [ADR 0001](../architecture/adr-0001-runtime-and-hosting.md) by U1b.
- The owner's live `getChatMember` probe at go-live: the bot added to the
  group as a plain member, `/subscribe` tried by a member; if it fails,
  `MEMBERSHIP_CHAT_ID` is set to the mirror channel (a value change, no
  code). U8's go-live checklist in
  [Operations and security](../guides/operations-and-security.md)
  carries the owner's live probes.
- Still unverified, by design: whether supergroup administrator rights
  bypass the 48-hour deletion limit (objection 19); retraction is
  edit-first and deletion failure is never treated as removal.
- Doc amendments scheduled per unit, each in the unit's own change with
  the OKF gate green:
  - U1a: the variable table in
    [Developer setup](../guides/developer-setup.md), the secrets table in
    the operations runbook and `.dev.vars.example` (the rename
    `NGO_GROUP_ID` → `MEMBERSHIP_CHAT_ID`, `BOT_ID`, `BOT_USERNAME`,
    `MARKS_PER_DAY`, the pacing maximum 25).
  - U1b: [ADR 0006](../architecture/adr-0006-data-model-and-module-layout.md)
    amended to the brief's data model; ADR 0004 (closure does not sweep
    delivered messages; D1 also holds `drafts`, `counters`,
    `admin_prompts`; the approval row as the schedule); ADR 0001's "D1
    holds" sentence and the capacity arithmetic;
    [ADR 0002](../architecture/adr-0002-language-and-framework.md)'s
    driver decision (`node:sqlite`; `better-sqlite3` dropped); the
    deletion schedule table in
    [Retention and minimisation](../product/retention-and-minimisation.md)
    (drafts, pending expiry, `counters`, `admin_prompts`, merged rows, job
    payloads, the new `reports` columns).
  - U2: the developer guide's webhook section.
  - U3: the intake steps in
    [Report lifecycle](../product/report-lifecycle.md).
  - U4: one venue, the DM fallback removed from
    [Review and abuse controls](../product/review-and-abuse-controls.md),
    the [Admin review runbook](../guides/admin-review-runbook.md) (4.6 and
    4.9 gain the force-reply prompt; "admin notes" replaced by the real
    fields; `rejection_reason` named as internal) and the lifecycle (the
    status card and pending expiry).
  - U5: the deployed probe's result in ADR 0004.
  - U6: the lifecycle's `broadcasting → retracted` transition and
    outcomes; the runbook's sections 7 and 8 (buttons, `/open`, retraction
    while broadcasting); `/resume` and the command surface in the
    operations runbook; the three crons; the preemption change ("notices
    queue behind a running broadcast" becomes "closure and retraction
    jobs preempt the running broadcast's batches") in
    [Broadcast consent policy](../product/broadcast-consent-policy.md),
    the lifecycle, ADR 0004 and the runbook's 7.4 and 8.3.
  - U7: the Node fallback drill doc.
  - U8: the per-rule test lists in Critical invariants (stale alarm,
    `HttpError`, reconciliation, lost alarm); the developer and operations
    docs reconciled with the code; the go-live checklist; the `setWebhook`
    note that `edited_message` is not subscribed.
- From the Phase 1 list above ("Open after the review"): the 35-send
  batch measurement became the deployed probe; DO storage write plus
  `setAlarm` atomicity was designed out by `commit` and the jobs table;
  header logging is recorded as a fact (Workers Logs and Tail Workers
  carry request headers; `observability.enabled: false` stays a rule in
  wrangler.jsonc and the operations runbook). The research note's
  unverified items (1), (2) and (5) are not addressed by the plan brief
  and stay open.
- Found while building U1b, each for the unit named. On 2026-10-28,
  during U1b, the owner narrowed the scope: no direct-message broadcasts,
  no member or reporter identity in storage, an approved report posted
  once into `BROADCAST_CHAT_ID`, retraction and closure editing that post,
  "I reported it" a counter, no decision message to reporters. The
  broadcaster Durable Object, its ledger and its bucketed marks were built
  and removed the same day, which retired the findings about them (the
  per-press read cost of the daily mark cap, the alarm rule, the batch
  step's row writes). What still stands:
  - the owner, in the three synced copies at once: rule 5 still governs
    direct-message broadcasts and rule 8 the reporter id's replacement
    after the decision notice; neither exists any more. CLAUDE.md's
    "Error handling" (a cap error "reschedules for 00:05 UTC plus jitter")
    and the module map's rules column follow them;
  - the product docs (the consent policy, the lifecycle, review and abuse
    controls), the runbooks and the threat model are being rewritten to
    the single-post model; until then they still describe subscriptions,
    the fan-out and the decision notices. The configuration moved to it in
    U1b's final pass (plan revision 8): `BROADCAST_CHAT_ID`,
    `KEYHOLDER_IDS`, `ALLOWED_LINK_HOSTS`, `LOCKDOWN` and
    `MARKS_PER_REPORT` added, the four direct-message variables removed,
    the grace period 30 minutes;
  - U2, U5: a press writes two D1 rows (the report's count and the day's
    in `counters`), capped by `MARKS_PER_REPORT` and `MARKS_PER_DAY`;
  - U5: the joined due query (approved, un-voided, `starts_at` reached)
    is driven by the planner from `reports_by_status`; `approvals_due`
    serves only approvals-side reads, so U5 confirms it or a later
    migration drops it;
  - U5, U6: the statuses are `posting` while the post is being made and
    `posted` once it is (renamed in U1b's final pass, plan revision 8);
    the lifecycle doc takes the names in its rewrite;
  - U6: the finalized report row (its personal fields nulled,
    `data_deleted_at` set) is deleted by the retention job, so that only
    the aggregate row then holds the report id, as rule 8's test expects;
  - U3: `drafts.draft_key`, `reporter_ref` and `link_hash` are 64
    lowercase hex characters (HMAC-SHA-256), which the schema enforces.

## Scope reduction review (2026-10-28, evening)

Scope: the MVP plan brief from its revision R7, the scope reduction the
owner decided after stating the seizure threat, to revision R11 (marker
PLAN-R11, closed). The design of R1 to R6 above (a direct-message fan-out
with a Durable Object ledger) was removed. The dispositions below are the
brief's own record (its section 9); the devil's objections are summarised
from the lead sentence of each and their dispositions quoted from the
brief's "Devil round on R9" block. The product-level result is
[Threat model: seizure](../product/threat-model-seizure.md); the
decisions are listed in
[Planning decisions](../product/planning-decisions-2026-10-28.md) ("Scope
reduction after the seizure threat").

### The owner's threat statement and answers

Verbatim: "imagine a situation where the admins get arrested because of
they are defending human rights and then use this platform to target or
identify users and their real IP. I only know with telegram inline bot
chats or telegram serverless server it's possible. or maybe having some
proxy in between. but still if they have access the account, they still
can change anything."

The answers the same evening: approved reports go to a channel or group
only, with no direct-message list, then (after round 5 showed that a
group's member list is readable by any member) a channel owned by the
keyholder; no decision message to reporters; outcomes by editing the post,
with counts only; a keyholder outside the country, "not yet, but I can
arrange it"; the grace period 30 minutes.

### Process

Revision R7 reduced the scope. Three angel rounds on the Claude lane and
one codex devil run followed. Angel round 5, on R7: ten objections and
three suggestions, all conceded, with two owner answers folded (the
channel, the 30-minute grace), giving R8. Round 6, on R8: six
sentence-level objections, all conceded, giving R9. Then ONE codex devil
plan run, on R9 (`DEVIL_RUN: mode=plan base=n/a critical=0 escalate=1
effort=xhigh model=gpt-6-astra`; `DEVIL_SESSION:
01a1842f-15eb-79c2-a351-da72f37591fb`; brief sha256
`2eb32c7c223aff2d317e21cdeea634319f5e9d1c169acf7f2ceb1210a3cbf802`;
`DEVIL_QUOTA: 7d[used=4% left=96% resets=2026-11-04 02:10] reading-age=0h`).
Verdict FIX-FIRST ("The seizure protections are overstated, and posting,
lockdown and finalization have concrete paths to premature sends or
irretractable harmful posts"), 14 objections, all conceded with a fix in
the text, giving R10. The devil re-ran the premise's capability searches
and found them incomplete: rendering helpers already existed in
`src/i18n/html.ts`, the `SqlDb` contract permits multi-write transactions
only through `batch`, and the "no hits" searches find API names in
`src/privacy/logger.ts`, as labels rather than implementations. Angel
round 7, on R10: one major and four minor objections, all conceded,
giving R11. Closure was declared by disposition completeness at R11
(every objection conceded and folded, none rebutted, no verdict awaited).

### The angel's rounds 5, 6 and 7

Round 5 (ten objections, three suggestions; all conceded; on R7):

1. a keyholder-owned channel, the bot its only posting administrator, the
   admins never chat administrators, hidden members on in the NGO group
   (the owner: yes);
2. the exact-host link policy, the Telegram path rules, the redirector
   list, the admin free-text validator, the "view only" line; rule 4
   states the mechanism;
3. Time Travel named; the wipe defends against the seized admins;
   `wrangler d1 delete` as the second step; the retention doc corrected;
4. the conditional claim of a post job; ambiguous failures never re-sent;
   the two tests;
5. lockdown covers intake and presses; `/lockdown` from `KEYHOLDER_IDS`
   in D1 plus the secret override; alerts to keyholders;
6. reporter messages deleted on receipt, `message_ids` dropped, the
   acknowledgement self-deletes, the reference's brute-force caveat and
   the admin-id exception stated in the threat model;
7. two writes per press stated, `MARKS_PER_REPORT`, the advisory label;
8. the CSAM-label acknowledgement with hotline links at intake; dead
   configuration removed; `my_chat_member` dropped;
9. the rule texts amended (the brief's section 10);
10. the owner: the grace period is 30 minutes.

Suggestions: S1 the schema scan in U1b; S2 alerts name the keyholder
path; S3 the "view only" line in both locales with a render test.

Round 6 (six sentence-level objections; all conceded; on R8):

1. `TRUSTED_HELP_HOSTS` fixed in code beside the configured target
   allowlist, both covered by the render scan; rule 4 amended;
2. the hotline links as a second persistent message; the
   acknowledgement's self-delete bounded by the handler's start; the draft
   write before the message deletion;
3. `/open` and `/stats` for keyholders under lockdown;
4. keyholders `/start` once at go-live; failed alerts retried;
5. the lockdown alert once; retention runs under lockdown and on
   `/lockdown`;
6. the wording items: "live database", "the channel" in rule 1, the rule
   7 test, the acceptance sentence, the button removed at closure too,
   keyholders are not admins.

Round 7 (one major, four minors; all conceded; on R10):

1. `/attach` verified through `editMessageReplyMarkup` and this report's
   callback data, `post_message_id` unique, authority stated for
   `/attach` and `/repost` in and out of lockdown, `/repost` admitted only
   without a message id;
2. lockdown wording: retraction edit jobs only; the keyholder buttons work
   under lockdown;
3. the keyholder notice edited to the outcome without links; a Lockdown
   button beside Cancel;
4. the claim binds a random `approval_id`, `halted` and `paused_until`; a
   `posting` row with its job present is in progress;
5. the pause not moot; terminal-by-edit scoped to posted reports; rule 4
   covers keyholder messages; the wipe a minute after lockdown.

### The devil's 14 objections and their dispositions

| # | Objection (the critique's lead sentence) | Disposition (the brief's "Devil round on R9" block) |
|---|---|---|
| 1 | Seized approvers still control a phishing surface: free instructions pass the URL, mention and phone checks, and the grace period supplies neither independent approval nor notification | conceded: no custom instructions; the comment bounded (300 characters) and labelled; the fixed warning line; every keyholder notified with a Cancel for the grace; the residual stated in the threat model |
| 2 | Reconciliation can permanently discard an unfinished retraction: the terminal status was written before the edit, then finalized | conceded: the `closing` and `retracting` states; the terminal status only by the edit's success; reconciliation never finalizes an unaddressed post |
| 3 | The specified claim can bypass a fresh approval's grace period: a stale tick claims `approved` after a Cancel and re-approval (reproduced against the schema) | conceded: the claim statement binds the approval and the start; the interleaving test (a random `approval_id`, from round 7) |
| 4 | Lockdown is a precondition check, not the promised execution barrier: a tick can pass its check before `/lockdown` and send after; intake can write after the wipe | conceded: the claim binds the lockdown state; the in-flight residual stated; the wipe after lockdown (a minute after, from round 7) |
| 5 | "Post again" defeats the unconditional at-most-once rule and leaves an unmanageable first copy | conceded: `/attach` and `/repost` replace "Post again" |
| 6 | Role separation explicitly permits its own bypass: an id in both lists could run `/unlock` | conceded: the schema refuses an admin and keyholder overlap |
| 7 | HMAC references do not make the retained reports anonymous: comment, URLs and the affected flag can identify the reporter by content | conceded: content versus metadata stated; comment guidance, bound, nulled at the decision |
| 8 | Hidden group membership does not protect participants visible in chat history | conceded: the group's history stated as outside the bot's control; the owner decides the group's future |
| 9 | The deletion guarantees have no failure-recovery path, and card deletion inherits the false "at any age" premise | conceded: deletion before the reply with a retry and a fallback; the 48-hour limit applied to cards |
| 10 | The emergency SQL wipe can fail precisely when an attacker exhausts storage quotas | conceded: the quota-exhausted incident path (the `LOCKDOWN` secret and `wrangler d1 delete`) |
| 11 | The universal outgoing-link rule contradicts supported intake and review: "other" reports with any host could not reach review | conceded: rule 4 scoped to the channel and reporters (and keyholders, from round 7); the card shows any URL as code |
| 12 | Rejecting `?startapp=` does not establish the claimed Mini App exclusion: query-free `t.me/<bot>/<short_name>` launches Mini Apps | conceded: Telegram targets rendered as code text, never links; the accepted intake grammar |
| 13 | 429 recovery is missing a state transition, and the shared pause is wrongly declared moot | conceded: the 429 revert of the claim; the pause honoured by every job send |
| 14 | Section 10 does not amend all the binding contracts it breaks: rule 1's states, the error rules' retry mandate, `src/platforms/` outside the critical globs | conceded: rule 1's states; the Error handling section amended (U8 reconciles CLAUDE.md); `src/platforms/` a critical glob |

### The devil's unverified scope

Quoted from the critique:

> UNVERIFIED: Live Telegram permissions and client behavior, deployed
> Worker timing and quota recovery, database-deletion guarantees, and
> U2–U8 implementation tests; those require deployment or unimplemented
> code. The working tree changed during inspection, so this is not
> certification of an immutable revision.

## Implementation (closing note, 2026-11-04)

The plan closed at R11 was built unit by unit, each unit by a delegated
implementer from its own brief, reviewed by the supervising session with a
domain-auditor pass on every critical-path diff, its findings folded in
before the commit. The commits, in order:

| Unit | Commit | Subject |
|---|---|---|
| Phase 1 | `7a488b3` | docs(planning): record decisions, confirm rules |
| Phase 2 | `9f61dc7` | build(toolchain): scaffold the stack, arm the kit |
| U1a | `5d59638` | feat(core): errors, config, logger, i18n, clock |
| U1b | `b305f86` | feat(storage): D1 port, adapters, migrations |
| U1b follow-up | `df7e252` | docs(threat-model): channel only, no identities (the threat model, the rules as amended at R11) |
| U2 | `2487f06` | feat(telegram): boundary, lockdown, bot, fakes |
| U3 | `e55f633` | feat(intake): drafts, link policy, limits |
| U4 | `3318972` | feat(review): cards, approve, cancel, route |
| U5 | `e25ea75` | feat(broadcast): the tick and the single post |
| U6 | `c3bd1a8` | feat(broadcast): closure, retention, wipe |
| U7 | `f0ef382` | feat(node): the fallback port on plain Node |
| U8 | this unit's commit | the go-live unit: the webhook registration script (`scripts/set-webhook.ts`), the single cron and observability pinned, the go-live, weekly, monthly and yearly checklists, the per-rule test lists of [Critical invariants](../architecture/critical-invariants.md), and every doc reconciled with the code |

Decisions the supervising session took without the owner during the units,
built and documented, for the owner to confirm or overturn:

- Notify-first approvals (U4): an approval is recorded only after its
  notice reached at least one keyholder, so a post nobody outside the
  admins' reach has seen is never approved; `KEYHOLDER_IDS` must be
  non-empty, and at least one keyholder must have sent `/start` before any
  approval can be recorded.
- `VENUE_LOCALE` defaults to `fa` (U4): every message the bot writes in the
  review venue is in that one language, whoever acts.
- A keyholder's `/halt` is lifted only by an admin's `/resume` (U5).
- A bot post is never edited by hand in the channel (U5): an edited post
  can no longer be attached by `/attach`, whose check compares its text.
- A report in `closing` cannot be retracted (U6).
- An abandoned edit job is queued again by reconciliation (U6), and the
  nightly abandon alert repeats while the cause persists.
- A due retraction edit runs under lockdown and `/halt` whoever ordered it
  (U6, confirmed at U8): an admin's retraction ordered before a lockdown
  still replaces the post with that admin's correction text, which passed
  the free-text policy (no link, mention or phone number, at most 300
  characters), because taking the reported links down is the
  harm-removing direction and the keyholder can see the result in the
  channel; the alternative, holding admin-ordered retractions until
  `/unlock`, keeps a wrong post up for the whole lockdown.

Owner dependencies still open, each on the go-live checklist of the
[operations and security runbook](../guides/operations-and-security.md),
section 9:

- The keyholder outside the country (the owner: "not yet, but I can
  arrange it"), holding the channel, the Cloudflare and BotFather accounts
  and the secrets; go-live is blocked until they exist.
- The deployed per-update probe, with its one-time fidelity check of
  `/attach`'s text comparison, run once on the owner's account (ADR 0004,
  "The deployed probe"): built in U5, not run.
- The two live go-live probes: the bot posts into the channel as its only
  posting administrator; `getChatMember` answers for the plain-member bot
  in the NGO group (or `MEMBERSHIP_CHAT_ID` becomes the channel).
- A native speaker's review of every Persian string of `src/i18n/fa.ts`,
  all of them drafts by the implementers.
- The NGO group's future: hidden members do not hide those who have
  written in its history ([Threat model: seizure](../product/threat-model-seizure.md)).

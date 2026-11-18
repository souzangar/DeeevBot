# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Project

**div-report** is a Telegram bot run by an NGO working on network & security
and on child & family safety. Members use it to report social-media accounts
and links that share people's private data, child abuse, bullying, and other
harmful behaviour. Bot admins review each report; once approved, the bot
posts the link once into a channel the members join, with instructions on
how to report it on the platform concerned (for example as child abuse, or
as a private-data violation) and the admin's recommended points. The bot
sends no direct-message broadcasts and stores no member or reporter
identity (`doc/product/threat-model-seizure.md`).

The owner's brief, as stated on 2026-10-28, is `doc/product/project-brief.md`.
Status: **MVP in progress, unit by unit** (2026-10-28). The ten open
questions are decided in `doc/product/planning-decisions-2026-10-28.md`;
the stack, hosting, transport, storage, error convention and module
layout are ADRs under `doc/architecture/`; the eight invariants below are
confirmed. Phase 2 scaffolded the toolchain and filled the kit's slots
(setup: `doc/guides/developer-setup.md`). Phase 3 lands the MVP in units
reviewed against the plan recorded in
`doc/audits/2026-10-28-planning-review.md`; the core modules (errors,
configuration, the redacting logger, i18n, the clock) and the storage
(the SQL port with its D1 and node:sqlite adapters, the D1 migrations)
exist, as do the Telegram wiring, the intake, the admin review, the
scheduler with its single post, the closure unit (closure, retraction,
retention, the monthly snapshot, the emergency wipe) and the Node
fallback port (long polling, the minute loop, SQLite, the Dockerfile and
the drill runbook) and the go-live unit (the webhook registration script,
the checklists, the per-rule test lists and the docs reconciled with the
code). The MVP's code is complete; go-live waits on the owner's steps
listed in the closing note of `doc/audits/2026-10-28-planning-review.md`. On 2026-10-28 the owner narrowed the scope: no
direct-message broadcasts and no member or reporter identity in storage;
an approved report is posted once into a configured group or channel
(ADR 0004, ADR 0006).

## Commands

```bash
npm ci                            # install from the committed lockfile (Node >= 22.18, npm)
npm run typecheck                 # tsc --noEmit
npm run lint                      # eslint . (typescript-eslint, type-checked)
npm run build                     # typecheck + lint (the gate's build step)
npm test                          # unit + workers projects (the gate's test step)
npm run test:unit                 # plain node, *.test.ts beside the module; no network, no infra
npm run test:workers              # Workers runtime via @cloudflare/vitest-plugin; local D1, no account
npm run test:invariants           # always-run "must never happen" specs (the gate runs them last)
npm run dev                       # wrangler dev; local secrets in .dev.vars (template .dev.vars.example)
npm run dry-run                   # bundle the Worker into .wrangler/dry-run, offline, no account
npm run probe:dry-run             # bundle the deployed probe (src/probe.ts, wrangler.probe.jsonc), offline
npm run migrate:local             # apply the D1 migrations in migrations/ to the local database
scripts/wipe.sh [--local]         # the keyholder's emergency wipe (every table but stats and meta); never run by the gate
npm run port                      # the Node fallback port from its TS sources (node --import ./src/node-hooks.ts src/node.ts); never with a real token outside the fallback
docker compose up -d --build      # the port in its container; the procedure is doc/guides/fallback-drill.md
npm run set-webhook -- <origin>   # the keyholder registers the webhook (origin + WEBHOOK_PATH_SEGMENT, secret_token, message + callback_query, max_connections 10, pending dropped) and prints the masked getWebhookInfo; never run by a test
npm run set-webhook:delete        # deleteWebhook, pending updates kept (the fallback drill's switch-back)
# Stack-independent:
bash selftest/run-all.sh          # kit tooling safety pins (devil.sh, hooks, statusline, globs completeness, tripwire patterns)
bash selftest-okf/run-all.sh      # OKF docs-gate contracts
node scripts/okf/check.mjs        # docs gate: frontmatter → links → refs → index staleness
node scripts/okf/build-index.mjs  # regenerate doc indexes after adding/moving/retitling a doc
.claude/hooks/rules-sync-check.sh   # the three catastrophic-rule copies must match (drift gate)
.claude/hooks/secret-shape-scan.sh  # stack-free first invariant: no secret-shaped string in the tree
```

## Architecture

Cloudflare Workers (Free plan) with a Node port as the fallback; TypeScript
strict ESM, grammY, zod, D1 as the only store (ADRs 0001, 0002, 0004 under
`doc/architecture/`). The Worker entry is `src/worker.ts` (HTTP handler,
cron handler); `src/probe.ts` is the deployed per-update probe, the same
Worker with its D1 calls and Bot API requests counted, deployed once by the
owner under `wrangler.probe.jsonc` and never with the bot's own
configuration (ADR 0004); the Node fallback port's entry is `src/node.ts`
(long polling through grammY's runner, a minute loop calling the same
`tick()`, node:sqlite; it runs the TypeScript sources through Node's type
stripping with the resolve hook `src/node-hooks.ts`:
`node --import ./src/node-hooks.ts src/node.ts`, Node 22.18 or later;
`doc/guides/fallback-drill.md`). `scripts/set-webhook.ts` is the operator's
webhook registration script, run the same way and never part of the
Worker; `scripts/wipe.sh` the keyholder's emergency wipe. Module map
(`doc/architecture/adr-0006-data-model-and-module-layout.md`); the
modules land unit by unit, `src/errors/`, `src/config/`, `src/privacy/`
(logger and reporter reference), `src/i18n/` and `src/clock.ts` first,
then `src/db/` and `migrations/`:

| Module | Holds | Critical path (rules) |
|---|---|---|
| `src/telegram/` | bot wiring, handlers, rendering with previews disabled, the webhook secret check, the port's long polling | yes (2, 4) |
| `src/auth/` | the allowlist gate, the membership check | yes (2, 4) |
| `src/review/` | report state machine, categories and routing table, approval records, grace and cancel | yes (1, 3, 7) |
| `src/broadcast/` | the single post of an approved report, its edits (retraction, closure), the jobs the minute cron drains (the port's minute loop), the finalization that leaves only the aggregate row, the counts | yes (1, 5, 8) |
| `src/privacy/` | HMAC references, the redacting logger, the retention job | yes (6, 8) |
| `src/config/` | the zod schema and loaders | yes (2, 3, 5, 6, 7, 8) |
| `src/db/` | the `SqlDb` port and its adapters | yes (1, 8) |
| `migrations/` | D1 SQL migrations (wrangler's `migrations_dir`) | yes (1, 8) |
| `src/errors/` | `AppError` and the catalog | no |
| `src/i18n/` | the `fa` and `en` catalogs | no |
| `src/platforms/` | URL parsing, per-platform instruction keys | yes (4) |

Critical paths are the globs in `.claude/devil/critical-globs.conf`
(`src/worker.ts`, `src/probe.ts`, `src/node.ts`, `src/node-hooks.ts`,
`scripts/set-webhook.ts` and `scripts/wipe.sh` included). Anchor convention: every file
on a critical path carries the comment line `// @critical-path` (TypeScript)
or `-- @critical-path` (SQL) near its top, and
`selftest/critical-globs-completeness.sh` fails when an anchored file under
`src/` or `migrations/` matches no glob, so a new critical module adds its
glob in the same change.

- **Report lifecycle** — a user submits a link (+ optional comment, for the
  admins) → the report waits for admin review → an admin approves or
  rejects → after a 30-minute grace period (every keyholder holds a Cancel
  and a Lockdown button for it) an approved report is posted once into the
  configured channel with per-platform reporting instructions and the
  admin's recommended points; closure and retraction edit that post; a
  report the admin categorises as suspected CSAM is routed instead and
  never posted (`doc/product/report-lifecycle.md`). Nothing skips review.
- **Three roles** — reporter (any bot user; known only by a keyed
  reference), admin (configured allowlist of numeric Telegram ids, never a
  channel or group administrator), keyholder (configured allowlist of
  numeric ids outside the country, never an admin; owns the channel and the
  accounts, receives the alerts, holds the lockdown and the wipe). Members
  receive posts by joining the channel; no subscriber list exists.
- **Docs** — `doc/` is an OKF bundle (see Documentation). `doc/product/`
  holds the brief and flows; `doc/reference/` holds the per-platform
  reporting instructions the broadcasts quote; `doc/guides/` the runbooks
  and the developer setup.

## Critical invariants

<!-- sync:catastrophic-invariants -->
1. No message about a report reaches the channel without a recorded
   approval. Every post, retraction edit or closure edit about a report
   derives from that report's approval record (the approving admin's
   numeric id, timestamp and start time); the post itself is made only
   while the report is in the approved or posting state and never before
   the approval record's start time; no code path leads from intake to
   any such message without that record.
2. Admin authority is decided server-side, on authentic updates. Admin
   status comes from the configured allowlist of numeric Telegram user ids
   (never usernames, which are reassignable), re-checked at every admin
   action; an update is acted on only if it provably came from Telegram
   (a webhook request carrying the configured secret token, or an update
   fetched by long polling); nothing the client sends (chat type, name,
   callback payload, forwarded message) ever grants authority; while the
   lockdown switch is set, by a keyholder's command or by the deployment's
   override, no admin action, intake, press or post is performed and
   alerts go to the keyholders.
3. Nobody is exposed by a broadcast's text. A broadcast carries only the
   reviewed links the category's routing allows and admin-authored text.
   The reporter's identity (id, username, name), the reporter's comment,
   the approving admin's identity, and personal data of the people involved
   beyond what the allowed links themselves carry never appear in the
   broadcast text or in any message to other users; the review flow shows
   admins an opaque reporter reference, never the reporter's Telegram id,
   username or name.
4. Reported content is hostile data, never content. The bot never fetches,
   downloads, previews, stores, or re-hosts what is behind a reported link;
   every outgoing message that contains a reported URL is sent with link
   previews disabled; URLs and comments are stored and shown as escaped
   plain text, never executed or auto-followed; the review view presents
   metadata (URL, platform, category, comment) with link previews disabled.
   Every link the bot sends to the channel, to a reporter or to a
   keyholder is parsed, https-only, free of userinfo, port, query and
   fragment, and its exact hostname is on the configured allowlist of the
   target platforms' own domains or on the code's fixed list of platform
   help and hotline hosts, with platform redirectors and
   Telegram invite, start and Mini App links rejected and admin-authored
   text checked for links, domains, mentions and phone numbers; the bot
   has no Mini App and no inline mode. How an admin verifies non-CSAM
   content before approving belongs to the review runbook, not to the bot.
5. Posts go only to the configured channel. An approved report is posted
   once to the configured channel (joining it is the consent, leaving it
   the opt-out); the bot sends a direct message only as a reply to a
   user's own message in their own chat or as an alert to a configured
   keyholder; no list of members or subscribers exists anywhere in the
   bot's storage.
6. Secrets and sensitive data stay out of code, VCS, logs, and telemetry.
   The bot token, the webhook secret, the reporter-reference key, database
   credentials and the admin allowlist come from the deployment's secret
   store or environment, never from VCS, and are never logged or echoed to
   a chat (secret-shape scan: `.claude/hooks/secret-shape-scan.sh`, a first
   step of the commit gate); reported URLs, comments, reporter ids and
   subscriber ids never go to logs (the hosting platform's invocation logs
   included), error trackers, telemetry, or any service other than the
   Telegram Bot API and the deployment's own storage.
7. Suspected child sexual abuse material is never re-broadcast. The routing
   input is the admin's categorisation at review; the reporter's label is a
   hint only. A report the admin categorises as suspected CSAM is routed
   only to the platform's own report channel and the hotlines listed in
   the review runbook, through the admin's routing card; its link is never
   sent to the user base or to any chat other than the admin review venue,
   and its review never requires opening the content.
8. No plaintext Telegram id of a reporter or member is ever stored (the
   allowlisted admins' and keyholders' own ids excepted, both deployment
   configuration), and reports leave only counts behind: intake state is
   keyed by the keyed reporter reference; at closure a report's links,
   comment, texts and per-report records are deleted and only the aggregate
   row (category, platform, day-level dates, outcome, counts, keyed link
   hash) remains; every stored personal field has a deletion path covered
   by a test, and the emergency wipe leaves only the aggregate rows in the
   live database.
<!-- /sync:catastrophic-invariants -->

This marked block lives, verbatim, in THREE places (deliberate redundancy —
each copy is native auto-context for a different reader): this section;
`AGENTS.md`'s "Catastrophic invariants" (what the codex critic reads);
`.claude/devil/critical-invariants.md` (what devil.sh injects into
critical-path critiques). `.claude/hooks/rules-sync-check.sh` diffs the
three copies and goes red on drift — edit all of them, verbatim, **in the
same commit** (it is the first step of the commit gate's `INVARIANT_CMD`).
And keep `.claude/devil/critical-globs.conf` covering every module where
these rules apply.

## Error handling

Decided 2026-10-28 (`doc/architecture/adr-0005-error-handling-convention.md`),
amended the same day for the single-post model:

- **Error surface shape.** Every error leaves the system as ONE shape: a
  typed `AppError` (`code`, an internal `message` that never contains
  report data, optional `cause`, optional `userMessageKey`, `retryable`)
  — never an ad-hoc string or a raw exception from a lower layer. A grammY
  error-boundary middleware maps an `AppError` to a localised reply;
  anything else gets a generic reply and a log line naming the error class
  only (never the update payload, never a `GrammyError` payload); the
  Worker answers Telegram with 200 as soon as the update is handed to
  `bot.handleUpdate` under `waitUntil`, so Telegram never redelivers
  because of a bug and every handler is idempotent per update (the one
  stated exception: a redelivered update counts its "I reported it" press
  again, a count and never a stored identity).
- **Where codes live.** New error codes are registered in ONE place,
  `src/errors/catalog.ts`, never inline at the throw site; each code maps
  to an i18n key, and user-facing text comes from that catalog.
- **Telegram API errors are classified, not guessed.** Only unambiguous
  failures are retried: a 429 on a job send reverts the post claim,
  reschedules the job for now + `retry_after` and sets the global pause
  every job send honours; a 400 or 403 on a job send (no post rights,
  chat not found) reverts the claim, sets `needs_attention` and alerts. A
  timeout, a network error or a 5xx on a send is AMBIGUOUS (Telegram may
  have accepted it) and is never retried blindly: the report stays
  `posting` without a message id, the keyholders are alerted, and a human
  runs `/attach` or `/repost` after checking the channel. A 403 "bot was
  blocked by the user" or a 400 "chat not found" on a reply is logged by
  class and ignored (there is no subscriber to remove). An edit job (a
  closure or retraction edit of the post) that meets a 429 is rescheduled
  and sets the global pause; one that meets a 400 or 403 flags the report,
  alerts once and retries with back-off until the retention job abandons
  it at 20 attempts; a post Telegram reports as gone concludes the job.
- **What is never swallowed.** No empty `catch`, no log-and-continue on a
  failure that changes state; a job failure is recorded on its job and
  never aborts the tick; a storage failure, a daily-cap error included,
  stops the tick WITHOUT writing (the next tick after the 00:00 UTC reset
  resumes from the committed state) and alerts the keyholders once (at most
  once a UTC day per isolate, on a 15th minute, since the failed store
  cannot hold the marker); reconciliation queues an edit job the retention
  job abandoned again, so a persistent cause alerts nightly. Every
  code path that maps an error has a unit test; "the boundary never leaks
  a URL or an id" is a regression test with a real `GrammyError`.

## Testing conventions

- Any stated "must not / never" invariant (especially safety or
  data-integrity) gets a **regression test in the same change** — refactor
  to make it testable rather than skipping.
- Every new logic file (service/repository/handler/util) gets a unit test.
- Three Vitest projects (`vitest.config.ts`): **unit** is `*.test.ts`
  beside the module under `src/` (and `scripts/`), plain node, no network,
  mocks at the boundary; **workers** is `test/workers/*.test.ts`, run in the Workers
  runtime by `@cloudflare/vitest-plugin` with the local D1 binding, for
  the Cloudflare adapters and the D1 parity of the atomic batches (the
  submit, the approval, the finalization); **invariants**
  is `test/invariants/*.test.ts`, the always-run specs the commit gate runs
  on every commit, one per stated "must not". Fixture values are never
  secret-shaped (the secret-shape scan reads test files too). No coverage
  gate. CI (`.github/workflows/ci.yml`, GitHub Actions) runs the commit
  gate's three steps and the two offline bundles on every push and pull
  request to `main`, on Node 22, with no secret and no deploy step.
- Tests are run, not just written — a claimed pass must be an observed pass.

## Commit style

Conventional Commits: `feat(scope): ...`, `fix(scope): ...`,
`docs(scope): ...`, `refactor(scope): ...` — scope matches the changed
module. Subject ≤ 50 chars; body wrapped at 72 explaining *why*, not what.
Compose the body in a file and use `git commit -F <file>` (multiple `-m`
flags don't wrap). The supervising session makes all commits (delegated
agents never do). Commit only when asked — or, during an explicitly
autonomous run, at the work-unit boundaries the run's ground rules
authorize.

## Documentation

Every new feature, command, or contract gets a doc entry (preferably before
the code, otherwise in the same change). Side-findings discovered out of
scope are written into the proper durable doc, never left only in a
transcript or scratch file.

Docs live in `doc/` as an **OKF bundle**: every concept doc sits under a
domain folder with YAML frontmatter (`type` required; vocabulary and naming
in `doc/okf-conventions.md`); `index.md` files and `doc/README.md` are
generated by `node scripts/okf/build-index.mjs` and gated by
`node scripts/okf/check.mjs` (frontmatter → links → prose refs → index
staleness). Use the **doc-scribe** agent for doc work; it leaves the gate
green.

## Claude Code automation (`.claude/`)

- Hooks (wired in `.claude/settings.json`): `git commit` is gated by
  `pre-commit-check.sh` (build + tests + always-run invariant specs;
  best-effort command matcher, validates the working tree — CI is the
  authority); Edit/Write trigger `critical-path-tripwire.sh` on files
  matched by `.claude/devil/critical-globs.conf`; ending a turn runs
  `okf-guard.sh` (Stop hook) whenever `doc/`, `scripts/okf/`, or the hook
  itself is dirty or touched by HEAD, and blocks until the docs gate is
  green. The gate runs `npm run build`, then `npm test`, then
  `INVARIANT_CMD`: the catastrophic-rules drift gate, the secret-shape
  scan, both selftest suites (the kit's includes the critical-globs
  completeness check and `selftest/tripwire-patterns.sh`, which pins the
  live tripwire pattern), the OKF gate, and `npm run test:invariants`. The
  tripwire's `BANNED_PATTERNS` flag logging and stringifying payloads or
  errors (rule 6), forwarding, copying or fetching reported content and
  link previews left on (rules 3 and 4). If a commit is unexpectedly blocked,
  read the hook output (and the gate log it names) — do not re-run the
  gate.
- Agents (`.claude/agents/`): run **domain-auditor** (read-only) on any
  critical-path diff before committing; **test-writer** writes tests to
  house conventions; **doc-scribe** writes and updates docs to the OKF
  conventions and regenerates the indexes.
- **Review runs on two lanes: the Claude lane is unlimited and goes
  first; the codex devil is scarce and goes LAST.** The devil spends a
  real, exhaustible quota, so everything the Claude lane can find it must
  find *before* codex is spent — the devil's run should buy residual
  cross-vendor risk, not a re-discovery of what a local critic already had.
  - **Claude lane (free of the codex quota — use it without rationing):**
    my own verification first (never let a critic do my discovery);
    `/angel` for counsel and for the *whole multi-round argument*; the
    built-in code-review / security-review passes the harness offers;
    **domain-auditor** on every critical-path diff; **test-writer** to turn
    each conceded finding into a regression test; search/fan-out subagents
    for discovery. The commit gate and the invariant tests are the cheapest
    critics of all — a conceded finding that is mechanically checkable
    becomes an invariant test so the class never needs a critic again.
  - This repository is local-only for now: no remote, no hosted PR surface.
    Do not propose cloud review paths (hosted PR reviews, remote sessions)
    until one exists.
- Devil's advocate (codex): `.claude/scripts/devil.sh` is the ONLY way
  codex is ever run here — a read-only adversarial critic (never a
  workhorse, never a writer). Codex reads `AGENTS.md`, which inlines the
  catastrophic invariants — **any rule change in this file must be checked
  against `AGENTS.md` in the same commit** (sync the inlined list or
  confirm no sync is needed). Use `/devil`, or launch it with
  `.claude/scripts/devil.sh --detach <mode> <args>` (prints
  `DEVIL_DETACHED_LOG:`; the log's first line is `DEVIL_PID:`), then wait
  with a Monitor until-loop until the log's last line is `DEVIL_LOG:` (done)
  or `DEVIL_FAILED:` (failed); cancel with `kill -TERM <DEVIL_PID>`; never a
  Bash timeout or run_in_background (the harness kills codex before it
  finishes). It no-ops cleanly when codex isn't installed. Reasoning effort
  escalates on **every** run (a run's cost is the repo re-read, not the
  thinking); `DEVIL_ESCALATE=0` opts a non-critical run back down and can
  never lower a critical one. The model follows what the run is worth: `plan`
  and critical-path runs take the strong lane, every other run the cheap
  lane (`DEVIL_MODEL` always wins; `DEVIL_MODEL_CRITICAL` /
  `DEVIL_MODEL_DEFAULT` re-point one lane); the pre-flight refuses a model
  codex doesn't offer and a run the weekly quota can't cover.
  - `budget` — **free** (reads codex's own session logs, never invokes
    codex). Check it before deciding to spend a run, and heed the
    `DEVIL_QUOTA:` line every run prints.
  - `plan <brief>` — the devil's highest-yield mode by a wide margin, and
    **mandated** before the first code edit of a critical-path design:
    write a self-contained plan brief to the scratchpad and attack it.
    Design rejection is what a same-vendor critic is least likely to raise.
    The brief opens with a **Premise** heading (the script refuses a plan
    brief without one): ONE claim about the current system the plan rests
    on, plus the existing mechanisms searched BY CAPABILITY with the grep
    used — the critic re-runs those first. Pass the marker the latest
    revision folded in as `--expect <marker>`, so a stale or unsaved brief
    is never attacked.
  - `diff [base] [-- <paths>]` — **discretionary**, not automatic: run it
    when the design was *not* devil-closed, or when the implementation
    departed from the closed plan. A critical diff whose design was already
    devil-closed is covered by my review + domain-auditor + the Claude
    lane; say in the commit body that the devil diff was skipped and why.
    Scope with `-- <paths>` whenever the change is wider than the risk.
  - `wrapup <summary> [base] [-- <paths>]` — at the end of a critical arc,
    not at the end of every agenda.
  - **One shot per decision point; `reply` is not the default.** A reply
    replays the whole session and costs about twice a fresh run. Answer
    every objection explicitly — concede-with-fix or rebut-with-evidence,
    never silently drop one — fold the concessions, and if a second round
    is genuinely needed run a **fresh** mode against the updated artifact
    with the prior objections and their dispositions carried in the brief
    (the critic treats them as claims to verify, which is more useful than
    a replayed argument). Keep `reply <DEVIL_SESSION:>` for the rare case
    where the answer itself needs attacking; never `--last`.
  - **Closure is disposition completeness, never a verdict.** The preamble
    forbids praise, so `PROCEED` is structurally near-unreachable — a loop
    that waits for it never terminates. The loop closes when every
    objection is conceded-and-folded or rebutted-with-evidence.
- **Plan → critic loop to closure → then dispatch.** On any nontrivial
  task, the plan's adversarial loop runs to CLOSURE — every objection
  conceded-and-folded or rebutted-with-evidence, or a declared closure
  with every objection dispositioned — **before** any
  implementation is dispatched (expert or in-session edits). While a critic
  still returns BLOCK, no part of the plan is settled, including parts the
  current round didn't name — don't parallelize implementation against an
  open loop. If a correction must reach an already-running implementer
  anyway, it routes to that same context-holding agent via SendMessage,
  never a respawn. **The rounds happen on the Claude lane** (angel via
  SendMessage, my own re-verification): the devil enters once, as the
  terminal check on the settled plan, not as a round-by-round sparring
  partner.
- Claude counsel & delegation: `/angel` spawns the read-only **angel**
  advisor (strongest model, max effort — pinned; modes
  `plan`/`diff`/`stuck`/`wrapup` or a freeform question) —
  recommendation-led, blunt, unrestricted: objections and flags welcome in
  any volume; complement to /devil (angel advises, devil attacks — run
  both on high-stakes work). They are NOT symmetric in cost: the angel is
  bounded only by this session's quota, the devil by a scarce external
  one — so the angel carries the multi-round argument and the devil enters
  once, last. `/expert` spawns the **expert** (strong
  model, max effort, full tools) to execute a delegated coding/discovery
  task from a self-contained brief — it never commits: the session reviews
  the full diff, runs the test suites (+ domain-auditor on critical-path
  diffs), makes the commit itself, and routes fixes back to the same agent
  via SendMessage.

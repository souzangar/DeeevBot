# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Project

**div-report** is a Telegram bot run by an NGO working on network & security
and on child & family safety. Members use it to report social-media accounts
and links that share people's private data, child abuse, bullying, and other
harmful behaviour. Bot admins review each report; once approved, the bot sends
the link to every subscribed user with instructions on how to report it on the
platform concerned (for example as child abuse, or as a private-data
violation) and a recommended comment to attach to the report.

The owner's brief, as stated on 2026-10-28, is `doc/product/project-brief.md`.
Status: **planned, no code yet** (2026-10-28). The ten open questions are
decided in `doc/product/planning-decisions-2026-10-28.md`; the stack,
hosting, transport, storage, error convention and module layout are ADRs
under `doc/architecture/`; the eight invariants below are confirmed. The
remaining EDIT-ME slots are filled when the toolchain is scaffolded (Phase
2), in the same change as the commands they describe.

## Commands

```bash
# EDIT-ME (planning): dev run, build, lint, and the test tiers with their
# infra requirements — undecided until the stack is chosen.
# Stack-independent and available now:
bash selftest/run-all.sh          # kit tooling safety pins (devil.sh, hooks, statusline)
bash selftest-okf/run-all.sh      # OKF docs-gate contracts
node scripts/okf/check.mjs        # docs gate: frontmatter → links → refs → index staleness
node scripts/okf/build-index.mjs  # regenerate doc indexes after adding/moving/retitling a doc
.claude/hooks/rules-sync-check.sh   # the three catastrophic-rule copies must match (drift gate)
.claude/hooks/secret-shape-scan.sh  # stack-free first invariant: no secret-shaped string in the tree
```

## Architecture

EDIT-ME (planning): a compact module map once the stack is chosen. The
brief's flow, pending planning — the open questions in
`doc/product/project-brief.md` can change it, category routing above all:

- **Report lifecycle** — a user submits a link (+ optional comment, for the
  admins) → the report waits for admin review → an admin approves or
  rejects → an approved report is broadcast to the opted-in subscribers
  with per-platform reporting instructions and an admin-authored
  recommended comment. Nothing skips review.
- **Three roles** — reporter (any bot user), admin (configured allowlist of
  numeric Telegram ids), subscriber (a user who explicitly opted in to
  broadcasts and has not opted out).
- **Docs** — `doc/` is an OKF bundle (see Documentation). `doc/product/`
  holds the brief and flows; `doc/reference/` will hold the per-platform
  reporting instructions the broadcasts quote.

## Critical invariants

<!-- sync:catastrophic-invariants -->
1. No message about a report reaches the broadcast audience (subscribers
   as such, or the mirror chat) without a recorded approval. Every
   broadcast, retraction notice or closure notice about a report derives
   from that report's approval record (the approving admin's numeric id,
   timestamp and start time); the report broadcast itself is sent only
   while the report is in the approved or broadcasting state and never
   before the approval record's start time; no code path leads from intake
   to any such message without that record.
2. Admin authority is decided server-side, on authentic updates. Admin
   status comes from the configured allowlist of numeric Telegram user ids
   (never usernames, which are reassignable), re-checked at every admin
   action; an update is acted on only if it provably came from Telegram
   (a webhook request carrying the configured secret token, or an update
   fetched by long polling); nothing the client sends (chat type, name,
   callback payload, forwarded message) ever grants authority.
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
   How an admin verifies non-CSAM content before approving belongs to the
   review runbook, not to the bot.
5. Direct-message broadcasts are consensual and idempotent. Only users who
   explicitly opted in and have not opted out receive broadcasts by direct
   message; a user who blocked the bot is unsubscribed; a resumed broadcast
   never re-sends to a subscriber the delivery ledger records as delivered,
   delivery progress and the next step are committed together after every
   batch, and only the runner holding a broadcast's lease advances it, so a
   retry after a partial failure resumes from the ledger and can repeat at
   most one batch.
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
8. Reports leave only counts behind. The reporter's Telegram id is replaced
   by a keyed reference once the decision notice is delivered or abandoned;
   at closure a report's links, comment, broadcast text, delivery ledger
   and per-user records are deleted, and only the aggregate row (category,
   platform, day-level dates, outcome, counts, keyed link hash) remains;
   every stored personal field has a deletion path covered by a test.
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

Decided 2026-10-28 (`doc/architecture/adr-0005-error-handling-convention.md`):

- **Error surface shape.** Every error leaves the system as ONE shape: a
  typed `AppError` (`code`, an internal `message` that never contains
  report data, optional `cause`, optional `userMessageKey`, `retryable`)
  — never an ad-hoc string or a raw exception from a lower layer. A grammY
  error-boundary middleware maps an `AppError` to a localised reply;
  anything else gets a generic reply and a log line naming the error class
  only (never the update payload, never a `GrammyError` payload); the
  webhook handler acknowledges Telegram with 200 after handling so Telegram
  does not redeliver.
- **Where codes live.** New error codes are registered in ONE place,
  `src/errors/catalog.ts`, never inline at the throw site; each code maps
  to an i18n key, and user-facing text comes from that catalog.
- **Telegram API errors are classified, not guessed.** 429 persists
  progress and reschedules the broadcast step for now + `retry_after` (no
  in-invocation retry burst); 403 "bot was blocked by the user", 400 "chat
  not found" and "user is deactivated" unsubscribe the user and are not
  errors; 5xx and network errors retry with bounded backoff, then are
  recorded as a failed delivery.
- **What is never swallowed.** No empty `catch`, no log-and-continue on a
  failure that changes state; the broadcast records failures per recipient
  and never aborts the batch; a storage failure (including a daily-cap
  error) stops the broadcast in a resumable state, reschedules the step for
  00:05 UTC plus jitter, and alerts the admin chat once. Every code path
  that maps an error has a unit test; "the boundary never leaks a URL or an
  id" is a regression test with a real `GrammyError`.

## Testing conventions

- Any stated "must not / never" invariant (especially safety or
  data-integrity) gets a **regression test in the same change** — refactor
  to make it testable rather than skipping.
- Every new logic file (service/repository/handler/util) gets a unit test.
  EDIT-ME (planning): naming/suffix conventions and coverage/CI gates once
  the stack is chosen.
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
  green. The gate's `INVARIANT_CMD` already runs the stack-independent
  checks (the catastrophic-rules drift gate, the secret-shape scan, both
  selftest suites, the OKF gate); its
  BUILD/TEST slots and the tripwire's patterns are filled in planning, and
  the gate says so at commit time. If a commit is unexpectedly blocked,
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

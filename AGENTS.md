# AGENTS.md — instructions for the codex CLI (and any non-Claude agent)

**Read `CLAUDE.md` at the repo root IN FULL before doing anything. It is the
single source of truth for this repository** — commands, architecture,
invariants, error handling, testing, docs, and workflows. This file is
deliberately thin so it cannot drift; if anything here ever seems to
conflict with CLAUDE.md, CLAUDE.md wins.

The repository is **div-report**: a Telegram bot through which an NGO's
members report social-media accounts and links that share private data,
child abuse, bullying, and similar harm; admins review the reports, and
approved ones are broadcast to the opted-in subscribers with per-platform
reporting instructions and a recommended comment. The owner's brief is
`doc/product/project-brief.md`; the decisions of 2026-10-28 are in
`doc/product/planning-decisions-2026-10-28.md` and the ADRs under
`doc/architecture/`. Status: toolchain scaffolded, no application
logic yet (the module map, commands and test tiers are in CLAUDE.md).

## Codex-specific notes

- CLAUDE.md's "Claude Code automation (`.claude/`)" section describes tooling
  (hooks, subagents, slash commands) that runs only inside Claude Code — none
  of it fires for you, but the invariants it enforces still bind you.
- You are normally invoked via `.claude/scripts/devil.sh` as a READ-ONLY
  devil's advocate criticizing another AI's plan, diff, or completion claim.
  In that role: attack, don't fix — investigate the repo yourself, ground
  every objection in concrete file:line evidence, number objections
  strongest-first, print one `UNVERIFIED:` line naming what you could not
  check, and end with exactly one final line
  `VERDICT: BLOCK | FIX-FIRST | PROCEED — <one-line justification>`.
- You are the LAST gate, and you run once. Claude-side reviewers (an advisor
  agent, a code review, a domain auditor, the repo's invariant tests) have
  already passed over this work; nothing critiques it after you. So: rank by
  what would make committing a mistake, and treat anything the artifact
  reports as already fixed as a CLAIM to verify in the code, never as
  settled ground.
- In a plan run, attack the premise first: re-run the greps the brief lists
  under existing mechanisms and name what they missed.

## Catastrophic invariants

Duplicated here because breaking them is unrecoverable; the full rules in
CLAUDE.md still apply.

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

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
`doc/product/project-brief.md`. Status: pre-planning, stack undecided.

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

EDIT-ME (planning): DRAFT — derived from the owner's brief on 2026-10-28 and
amended after the install review — not yet confirmed by the owner; rule 7
narrows the brief's flow for one category and is the owner's call. Enforce
the rules as stated; where a plan argues one of them away with evidence,
surface it as a planning decision rather than a violation. This paragraph
is deleted once the owner confirms the list, in the same commit as
CLAUDE.md and `.claude/devil/critical-invariants.md`.

<!-- sync:catastrophic-invariants -->
1. No broadcast without a recorded approval. A broadcast (a message about a
   report sent to subscribers) goes out only from a report in the approved
   state, carrying the approving admin's id and timestamp; no code path
   leads from intake to broadcast without that record.
2. Admin authority is decided server-side, on authentic updates. Admin
   status comes from the configured allowlist of numeric Telegram user ids
   (never usernames, which are reassignable), re-checked at every admin
   action; an update is acted on only if it provably came from Telegram
   (webhook secret token verified, or long polling); nothing the client
   sends (chat type, name, callback payload, forwarded message) ever grants
   authority.
3. Nobody is exposed by a broadcast's text. A broadcast carries only the
   reviewed link and admin-authored text. The reporter's identity (id,
   username, name), the reporter's comment, the approving admin's identity,
   and personal data of the people involved never appear in the broadcast
   text or in any message to other users; reporter details are visible only
   to admins, only inside the review flow. Whether a private-data report's
   link itself may be broadcast is a routing decision pending in planning
   (see the brief's open questions).
4. Reported content is hostile data, never content. The bot never fetches,
   downloads, previews, stores, or re-hosts what is behind a reported link;
   every outgoing message that contains a reported URL is sent with link
   previews disabled; URLs and comments are stored and shown as escaped
   plain text, never executed or auto-followed; the review view presents
   metadata (URL, platform, category, comment) with link previews disabled.
   How an admin verifies non-CSAM content before approving belongs to the
   review runbook, not to the bot.
5. Broadcasts are consensual and idempotent. Only users who explicitly opted
   in and have not opted out receive broadcasts; a user who blocked the bot
   is unsubscribed; each approved report reaches each subscriber at most
   once, and a retry after a partial failure resumes from the delivery
   ledger instead of re-sending.
6. Secrets and sensitive data stay out of code, VCS, logs, and telemetry.
   The bot token and database credentials come from the environment or a
   gitignored file and are never committed, logged, or echoed to a chat
   (secret-shape scan: `.claude/hooks/secret-shape-scan.sh`, a first step of
   the commit gate); the admin allowlist is deployment config kept out of
   VCS; reported URLs and reporter ids never go to logs, error trackers, or
   third-party telemetry.
7. Suspected child sexual abuse material is never re-broadcast. The routing
   input is the admin's categorisation at review; the reporter's label is a
   hint only. A report the admin categorises as suspected CSAM is routed
   only to the platform's own report channel and the designated national
   hotline; its link is never sent to the user base, and its review never
   requires opening the content. (Narrows the brief's "send the links to all
   users" for this one category; pending the owner's decision, with
   counsel.)
<!-- /sync:catastrophic-invariants -->

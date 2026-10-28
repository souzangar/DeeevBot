# Critical-path invariants — div-report

EDIT-ME (planning): DRAFT derived from the owner's brief on 2026-10-28 and
amended after the install review, not yet confirmed by the owner; rule 7
narrows the brief's flow for one category and is the owner's call. While
this paragraph exists, devil.sh does not inject this file and the commit
gate flags it as placeholder — both only once critical-globs.conf has
active globs; the domain-auditor still audits against these drafts. Confirm
or amend every rule in planning, mirror the result into CLAUDE.md and
AGENTS.md in the same commit, then delete this paragraph.

Apply maximum suspicion to any weakening of the following:

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

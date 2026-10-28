# Critical-path invariants — div-report

Apply maximum suspicion to any weakening of the following:

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

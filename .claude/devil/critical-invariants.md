# Critical-path invariants — div-report

Apply maximum suspicion to any weakening of the following:

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

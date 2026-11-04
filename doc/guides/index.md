<!-- generated-by: scripts/okf/build-index.mjs — do not edit by hand -->

# guides/

How-to guides and runbooks: operating the bot, admin procedures.

↑ [bundle index](../index.md)

- [Admin review runbook](./admin-review-runbook.md) — Step-by-step procedure for reviewing a report: account and workstation isolation, the suspected-CSAM gate, the decision checklist with the approve prompts and the free-text rules, the per-category routing table, the routing card with its hotline links, closure and retraction as edits of the channel post, reporter abuse and why nobody is messaged, what lockdown looks like to an admin, Telegram posts forwarded from bots, and the legal and safety notes for the Iranian context.
- [Developer setup](./developer-setup.md) — Working on the div-report code: prerequisites and install, the npm scripts and stack-independent checks, the commit gate, the three test tiers and the fake Bot API, lint and TypeScript settings, configuration and local secrets, wrangler and the webhook boundary, the Node port and why it runs through Node's type stripping, critical paths and the tripwire, and the toolchain's known issues.
- [Fallback deployment and the yearly drill](./fallback-drill.md) — Running the Node port of the bot when Cloudflare is out of reach: obtaining a host, deploying the Docker image with the keyholder's values, the webhook deleted by the port itself, verifying a /start and a posted report, announcing re-submission in the channel; operating it, lockdown included; switching back to the Worker; destroying the port's SQLite database; and the yearly drill's checklist, recorded in an audit doc.
- [Operations and security runbook](./operations-and-security.md) — Running the bot safely after the seizure threat: the keyholder outside the country as the root of trust (the BotFather owner account, the Cloudflare account, the channel, the secrets), admin accounts that administer nothing, the configuration, webhook registration, the chats the bot sits in and its role in each, the grace period with Cancel and /halt, the single post and its edits, lockdown and the emergency wipe, quota exhaustion, logs, the single cron with retention and the stats snapshot, the fallback deployment and the yearly drill, incident procedures, the risk register, and checklists.

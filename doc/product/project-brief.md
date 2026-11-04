---
type: spec
title: "Project brief"
description: "The owner's statement of what div-report is for, as given on 2026-10-28, verbatim and structured, plus the open questions planning must settle first."
status: active
tags: [product, brief, planning]
timestamp: 2026-10-28T00:00:00Z
---

# Project brief

Stated by the owner on 2026-10-28, when the repository was created. The
verbatim text is the anchor; the structured reading below it is a light
edit for readability, not a redesign. Anything beyond it is a planning
decision, not part of the brief.

## The owner's words, verbatim

> I want this dir as codebase for a telegram bot that is part of a NGO for
> network and security, child and family safty, and also as part of our job
> in this dir we want to report accounts in social media that share users
> private data, child abuse, bollying, and any other evil deeds. users
> should be able to report links and some optional comments to us, then bot
> admins will review the links and after approval, bot sends the links to
> all it's users to report with instructions of how to report, (e.g. child
> abuse or private data) and a recommanded comment to add to the report.
> there will be a lot more to add or make it robust, but it's good if you
> have these kit's first before we start planing and code:
> /home/azadi/Work/finowin/claude-project-kit.zip
> /home/azadi/Work/finowin/claude-okf-kit.zip

## Structured reading

### Who and why

The bot belongs to an NGO working on **network and security** and on
**child and family safety**. Part of that work is reporting social-media
accounts that share users' private data, child abuse, bullying, and other
harmful behaviour.

### What the bot does

1. **Intake.** Any user can send the bot a link to report, with an optional
   comment for the admins.
2. **Review.** Bot admins review the submitted links.
3. **Broadcast.** After approval, the bot sends the link to its users so
   they can report it too, together with:
   - instructions on how to report it (for example as child abuse, or as a
     private-data violation), and
   - a recommended comment to add to the report.

## Open questions for planning

The owner expects "a lot more to add or make it robust". The install review
(`doc/audits/2026-10-28-kit-install.md`) raised the questions below. All ten
were decided on 2026-10-28; the "Decided" line under each question points to
the document that holds the decision, and
[Planning decisions (2026-10-28)](./planning-decisions-2026-10-28.md) is the
record.

1. **Category routing for suspected child sexual abuse material: decide
   first, with counsel.** Re-sending such a link to every subscriber may
   itself amount to distributing access to the material, whatever the
   intent, and volunteer admins typically have no hotline-style safe
   harbour unless the NGO is a designated hotline. Mass reporting is not
   known to speed takedown (platforms and hotlines such as INHOPE members,
   IWF and NCMEC deduplicate), and coordinated reporting can trip
   brigading filters that sanction the members' own accounts. Draft
   invariant 7 proposes: never broadcast such links; one report to the
   platform plus the designated hotline; review on metadata only. The
   owner decides.
   Decided 2026-10-28: rule 7 stands, adopted by the owner without counsel; a
   report the admin categorises as suspected CSAM is routed to the platform
   and the hotlines through the admin's routing card and never broadcast; see
   [Report categories and routing](./report-categories-and-routing.md).
2. **Routing for private-data reports.** For a doxxing report the post URL
   is itself the leaked data, so broadcasting it amplifies the leak. Decide
   whether the broadcast carries the specific post URL, only the account
   handle, or platform-form instructions without the link (draft
   invariant 3 covers the broadcast text only and leaves this open).
   Decided 2026-10-28: account link by default, post URL by admin opt-in
   recorded with the approval, account-only when the reporter is the affected
   person, never the post URL for intimate images; see [Report categories and
   routing](./report-categories-and-routing.md).
3. **Verification standard, reporter abuse, and retraction.** What an admin
   must verify before approving a non-CSAM report, so that a malicious
   reporter cannot turn the user base against an innocent person; controls
   against repeat or false reporters (rate limits, reputation, blocking);
   and how a wrongly approved broadcast is retracted or corrected to
   subscribers.
   Decided 2026-10-28: a runbook checklist for the admin, membership-based
   limits, keyed-hash duplicate detection, a block list and rejection
   throttle, first decision wins, edit-first retraction; see [Review and abuse
   controls](./review-and-abuse-controls.md).
4. **Consent and Telegram's rules.** Who receives broadcasts: explicit
   opt-in and a `/stop` command, automatic unsubscribe when Telegram
   reports that the bot was blocked, and the bulk-messaging limits in the
   Bot API terms (unsolicited bulk messages can get bots banned, taking
   the NGO's channel with them).
   Decided 2026-10-28: explicit opt-in for members, /stop and block handling,
   25 messages per second with a global 429 pause and a per-day budget, three
   bulk message kinds, an optional mirror chat; see [Broadcast consent
   policy](./broadcast-consent-policy.md).
   Superseded the same evening by the scope reduction after the seizure
   threat: one post per approved report into a keyholder-owned channel,
   joining it the consent, no subscription and no direct-message broadcast;
   the consent policy holds the decision now.
5. **Retention and minimisation.** How long resolved reports are kept, when
   the reporter's identity is severed from a report (proposal: at decision
   time), and the rule that reported URLs and reporter ids never reach
   logs or third-party telemetry (draft invariant 6).
   Decided 2026-10-28: the reporter id becomes a keyed reference after the
   decision notice, report data is deleted at closure, only an aggregate row
   survives, nothing sensitive reaches logs or backups; see [Retention and
   minimisation](./retention-and-minimisation.md).
   Tightened the same evening by the scope reduction: no reporter's or
   member's Telegram id is ever stored, only the keyed reference, and no
   decision notice exists.
6. **The admin review runbook.** How admins verify content without the bot
   ever fetching it (an isolated browser, the platform's own view),
   including the path for a report labelled otherwise that looks like
   CSAM (never open; route per question 1), the platform report forms to
   use per category, and the legal basis for handling each category. A
   `runbook` doc under `doc/guides/`.
   Decided 2026-10-28: two runbooks; see the [admin review
   runbook](../guides/admin-review-runbook.md) and [operations and
   security](../guides/operations-and-security.md).
   Unit U7 added a third, the [fallback drill
   runbook](../guides/fallback-drill.md).
7. **Platform policies on coordinated reporting.** An identical recommended
   comment across hundreds of reports is a spam signal platforms discount;
   check each target platform's policy before writing the instructions
   under `doc/reference/`.
   Decided 2026-10-28: one reference doc per platform from the research of
   2026-10-28; the broadcast asks each member for one genuine report in their
   own words, never a text to paste, and never promises removal; see [Planning
   decisions](./planning-decisions-2026-10-28.md) (Q7) and the platform docs
   under `doc/reference/`.
8. **Update authenticity.** Webhook with a verified secret token, or long
   polling; the admin allowlist by numeric id only (draft invariant 2).
   Decided 2026-10-28: a webhook with a verified secret token on Cloudflare,
   long polling on a VPS, a numeric allowlist checked at every admin action;
   see [ADR
   0003](../architecture/adr-0003-update-transport-and-admin-authority.md).
9. **Error-handling convention.** AGENTS.md and the devil prompts reference
   error-handling rules that CLAUDE.md does not define yet.
   Decided 2026-10-28: one typed AppError, one code catalog, a boundary that
   never leaks report data, Telegram errors classified; see [ADR
   0005](../architecture/adr-0005-error-handling-convention.md).
10. **Stack, hosting, data model, module layout**, and with them the
    EDIT-ME slots in CLAUDE.md, the commit gate's build and test commands,
    the tripwire patterns, and the critical globs.
    Decided 2026-10-28: Cloudflare Workers Free with a Node fallback,
    TypeScript and grammY, D1 plus a broadcaster Durable Object, the module
    map and tripwire patterns; see [ADR
    0001](../architecture/adr-0001-runtime-and-hosting.md), [ADR
    0002](../architecture/adr-0002-language-and-framework.md), [ADR
    0004](../architecture/adr-0004-storage-and-delivery-ledger.md) and [ADR
    0006](../architecture/adr-0006-data-model-and-module-layout.md).
    Amended the same evening by the scope reduction: no Durable Object, D1
    the only store.

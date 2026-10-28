---
type: spec
title: "Review and abuse controls"
description: "What an admin verifies before approving, who may report and under which limits, duplicate detection, the block list and rejection throttle, first-decision-wins, retraction, closure, and the review venue."
status: active
tags: [product, review, abuse, moderation, retraction]
timestamp: 2026-10-28T00:00:00Z
---

# Review and abuse controls

Q3 of [Planning decisions](./planning-decisions-2026-10-28.md). The
realistic abuse case is state-aligned reporters trying to turn the user
base against dissidents, so a report with no visible violation is
rejected and that line is not eroded by any "when in doubt" rule.
Verification is the admin's duty and lives in the
[admin review runbook](../guides/admin-review-runbook.md); the bot
enforces the limits below.

## Verification checklist (summary)

Before approving a non-CSAM report the admin:

- (a) confirms the link resolves to the account or post described;
- (b) confirms the category from the platform's own view, in an isolated
  browser profile or on a dedicated device, over the NGO's usual VPN;
- (c) checks for weaponisation: the reported account may be the victim,
  and a report with no visible violation is rejected;
- (d) never opens suspected CSAM (routing in
  [categories and routing](./report-categories-and-routing.md));
- (e) writes the recommended comment in their own words, as points to
  make, never a text to paste;
- (f) picks the link mode the category allows.

## Who may report, and the limits

The owner's rule: "Anyone, with stricter limits for non-members".

- Intake is open to anyone. Membership of the configured membership chat
  is checked with `getChatMember`. The membership chat is the NGO's group
  with the bot as a plain member in privacy mode, never as an admin: an
  admin bot receives every group message, which would route members'
  chatter through the Worker and burn the request meter. The MVP verifies
  that `getChatMember` answers for a non-admin member bot; otherwise the
  membership anchor is a channel the bot administers, naturally the mirror
  channel.
- Membership is checked at subscription and at intake and cached per user.
  Leaving the chat does not end a direct-message subscription; only
  `/stop` or a block does.
- Members: 5 open reports, 20 per day. Non-members: 1 report per day, a
  global cap of 20 non-member reports per day (admin cards are the scarce
  resource), and no direct-message subscription.
- Intake is text-only. A message carrying media or a forwarded post is
  refused with a reply and deleted, never stored, forwarded or copied.

## Duplicate detection

A keyed hash of the normalised URL identifies a target. A second report of
the same open target becomes its own row merged into the first, so every
reporter is notified of the decision. The acknowledgement is identical for
new and merged reports, so nobody can probe whether an account was already
reported. For a target that was reported and closed before, the keyed
link hash in the aggregate row lets the admin's card say "previously
reported, outcome X"; the reporter is never told.

## Block list and rejection throttle

- A block list keyed by the reporter reference; blocks persist.
- A rejection counter per reference: 3 rejections in 30 days throttles the
  reporter to 1 report per day. Counters expire after 90 days without
  activity.

## First decision wins

A status change is a conditional update (`WHERE status = 'pending'`,
exactly one row changed). The losing admin's card is edited to show the
outcome. The 5-minute grace period, Cancel and `/halt` are in
[Report lifecycle](./report-lifecycle.md).

## Retraction

An admin command on a broadcast report edits every delivered message in
place to the correction text (`editMessageText` has no age limit for the
bot's own messages), deletes the message instead where it is younger than
48 hours, edits the mirror post, and marks the report retracted; the
aggregate row keeps "retracted". Notices queue behind a running broadcast
(one at a time), so a retraction completes within the hour, not at once.

## Closure

An admin marks a broadcast report "taken down" or "closed without result".
The outcome goes by direct message to the users who pressed "I reported
it" and are still subscribed at send time, the mirror post is edited, and
the report's data is deleted per
[Retention and minimisation](./retention-and-minimisation.md).

## Review venue

Review cards go to the configured private admin supergroup, where the bot
is an admin holding `can_delete_messages` so cards can be deleted after
the decision at any age and auto-delete is enabled; without a configured
venue, cards go to each admin's direct messages. A card shows the reporter
reference (never the id, username or name), the URL as non-tappable code
text with link previews disabled, the platform, the category, the comment
and the prior outcome for a re-reported target. The admin chat id is a
venue, never an authority: every admin action re-checks the numeric
allowlist (see
[ADR 0003](../architecture/adr-0003-update-transport-and-admin-authority.md)).

## Tests these controls require

- A non-member cannot subscribe; member and non-member limits and the
  global non-member cap are enforced per day.
- A media or forwarded intake message is refused and deleted, and the bot
  never calls `forwardMessage` or `copyMessage` on it.
- New and merged reports produce byte-identical acknowledgements.
- Two concurrent decisions on one pending report change exactly one row.
- Retraction deletes messages younger than 48 hours and edits older ones.

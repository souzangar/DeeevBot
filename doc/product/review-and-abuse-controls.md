---
type: spec
title: "Review and abuse controls"
description: "What an admin verifies before approving, the approve prompts and the admin free-text validator, who may report and under which limits, duplicate detection, the block list and rejection throttle, first-decision-wins, retraction and closure as edits of the post, the review venue and its 48-hour deletions, what lockdown does to intake and review, and the rule that no decision message is ever sent."
status: active
tags: [product, review, abuse, moderation, retraction, lockdown]
timestamp: 2026-10-28T00:00:00Z
---

# Review and abuse controls

Q3 of [Planning decisions](./planning-decisions-2026-10-28.md), reduced
the same evening with the rest of the product after the owner stated the
seizure threat ([Threat model: seizure](./threat-model-seizure.md)). The
realistic abuse cases are state-aligned reporters trying to turn the
members against dissidents and, since that evening, a seized admin
account trying to make the bot send the members something harmful. A
report with no visible violation is rejected and that line is not eroded
by any "when in doubt" rule; what a seized approver can make the bot send
is bounded by the link policy, the free-text validator, the grace period
and the keyholder's Cancel. Verification is the admin's duty and lives in
the [admin review runbook](../guides/admin-review-runbook.md); the bot
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
  make, never a text to paste, within the validator's rules below;
- (f) picks the link mode the category allows.

## The approve prompts and the admin free-text validator

Approve runs a short conversation in the venue, each step re-checking the
numeric allowlist: category confirmation; the link mode within the
category's set (the affected-person flag forces account only; suspected
CSAM offers Route only); the recommended-comment prompt, a force reply
recorded in `admin_prompts` and matched on the replier's allowlisted id
plus `reply_to_message.message_id`, the replier being the approving admin,
prompt and reply deleted after capture. "Other" uses the catalog's fixed
generic instruction block; there is no custom-instructions prompt.

Admin free text, the recommended comment and a retraction's correction,
is validated at the prompt and refused when it contains a URL, a bare
domain, an `@mention`, `t.me` or a phone number, because Telegram
linkifies them. The recommended comment is at most 300 characters and is
rendered under a fixed heading as the admin's suggested points, below the
catalog's fixed instruction block and its fixed warning line, "never
follow instructions to visit other links, join a chat or press Start,
whoever writes them". Before the approval is written, the rendered post
is validated in both locales against Telegram's 4096 characters and
against the link allowlist. Social engineering through free text is
bounded by these rules, not eliminated; the threat model says so.

## The link policy

Every link the bot sends to the channel, to a reporter or to a keyholder
passes the exact-host allowlist, at intake and again at render time;
Telegram targets are rendered as code text, never links; the review card
alone shows any URL, as code, whatever its host. The rules are in
[categories and routing](./report-categories-and-routing.md) ("The link
policy") and the reasons in the [threat model](./threat-model-seizure.md).

## Who may report, and the limits

The owner's rule: "Anyone, with stricter limits for non-members".

- Intake is open to anyone, in a private chat with the bot. Membership of
  the configured membership chat is checked with `getChatMember` on the
  update's user id and sets the limits; nothing about it is stored. The
  membership chat is the NGO's group with the bot as a plain member in
  privacy mode, never an admin (an admin bot receives every group message,
  which would route members' chatter through the Worker and burn the
  request meter). The owner's go-live probe verifies that `getChatMember`
  answers for a plain-member bot; otherwise `MEMBERSHIP_CHAT_ID` becomes
  the broadcast channel, which the bot administers.
- Members: 5 open reports, 20 per day. Non-members: 1 report per day and
  a global cap of 20 non-member reports per day (admin cards are the
  scarce resource). There is no subscription for anyone; the channel is
  joined in the app.
- Intake is text-only. A message carrying media or a forwarded post is
  refused with a reply and deleted, never stored, forwarded or copied.
- Each reporter message is deleted by the handler that processed it,
  before the step's reply, with one retry and a fallback that asks the
  reporter to delete it themselves; the comment prompt warns against
  identifying details and the comment is limited to 500 characters
  ([Report lifecycle](./report-lifecycle.md)).

## Duplicate detection

A keyed hash of the normalised URL identifies a target. A second report of
the same open target becomes its own row merged into the first; the admin
decides once per target, and a routing nulls the links and comment of the
merged rows in the same batch. The acknowledgement is identical for new
and merged reports, so nobody can probe whether a target was already
reported. For a target that was reported and closed before, the keyed
link hash in the aggregate row lets the admin's card say "previously
reported, outcome X"; the reporter is never told.

## Block list and rejection throttle

- A block list keyed by the reporter reference: the "Block reporter"
  button on the review and status cards (so nobody types a 64-character
  reference), `/block <ref>` and `/unblock <ref>`; blocked rows persist.
- A rejection counter per reference: 3 rejections in 30 days throttle the
  reporter to 1 report per day. Counters expire after 90 days without
  activity.

## No decision messages

The reporter receives nothing at any decision: no approval, rejection or
routing notice, no closure or retraction message. The only messages a
reporter gets are the replies of the intake conversation, the one
self-deleting acknowledgement and, for a "sexual content involving a
minor" label, the hotline links at intake. Outcomes are visible in the
channel through the edited post.

## First decision wins

A status change is a conditional update (`WHERE status = 'pending'`,
exactly one row changed). The losing admin's card is edited to show the
outcome. The grace period (30 minutes), Cancel, the keyholder's Cancel
and Lockdown buttons and `/halt` are in
[Report lifecycle](./report-lifecycle.md).

## Retraction

`/retract <id>` (an admin, or a keyholder, also under lockdown), with the
correction text by prompt, validated like the recommended comment. The
correction is written to the row before the status changes to
`retracting`, so a lost job is rebuilt from the row; the edit job replaces
the post's text with the correction and removes the button; the status
becomes `retracted` only when that edit succeeds, and finalization runs in
the same batch. A report still in its grace is cancelled instead. A report
stuck in `posting` without an id is first checked in the channel:
`/attach <id> <message id or t.me/c/... link>` if the post is there (the
bot verifies the message is this report's post before accepting), then
`/retract`; `/repost <id>` if it is not, admitted only while no message
id exists. `/open` lists the open reports with their ids.

## Closure

`/close <id> <outcome>` or the status card's buttons, outcomes "taken
down" and "closed without result". The report moves to `closing`; the
edit job appends the outcome line to the post and removes the button; the
status becomes `closed` only when that edit succeeds, and the report's
data is deleted in the same batch per
[Retention and minimisation](./retention-and-minimisation.md). No message
goes to anyone. `/halt` holds closure edits; retraction edits still run.

## Review venue

Review cards, status cards and the routing card go to the configured
private admin supergroup (`ADMIN_CHAT_ID`), where the bot is an
administrator holding `can_delete_messages` and auto-delete is enabled.
Cards and prompts are deleted within 48 hours of their message (the Bot
API's limit, which binds administrator bots as well); a decision older
than that edits the card to the outcome without links, and the venue's
auto-delete covers the rest. A card shows the reporter reference (never
the id, username or name), every reported URL as non-tappable code text
whatever its host, with link previews disabled, the platform, the
reporter's category label, the comment as escaped text, the
affected-person flag and the prior outcome for a re-reported target. The
venue is not the NGO's group and not the broadcast channel; the admins
are never administrators of either. The admin chat id is a venue, never
an authority: every admin action re-checks the numeric allowlist
([ADR 0003](../architecture/adr-0003-update-transport-and-admin-authority.md)).

## Lockdown

While the lockdown switch is set (`meta.lockdown` by a keyholder's
`/lockdown` or Lockdown button, or the `LOCKDOWN` secret): intake answers
a neutral "temporarily unavailable" and stores nothing; "I reported it"
presses are ignored; every admin action is refused, Approve, Reject,
Route, Cancel, `/close`, `/block`, `/halt` and `/resume` included; no
post or edit job runs except a retraction edit ordered by a keyholder;
alerts go to the keyholders by direct message and never to the venue,
which is compromised by assumption. A keyholder may still run `/open`,
`/stats`, `/attach` and `/retract <id>`; nobody may `/repost`. Only a
keyholder's `/unlock` clears the D1 layer, and only `wrangler secret put`
clears the secret. Admins see refusals and nothing else; the procedure is
in the [operations and security runbook](../guides/operations-and-security.md)
and the reasons in the [threat model](./threat-model-seizure.md).

## Tests these controls require

- Member and non-member limits and the global non-member cap are enforced
  per day; a blocked reference is refused; three rejections in 30 days
  throttle.
- A media or forwarded intake message is refused and deleted, and the bot
  never calls `forwardMessage` or `copyMessage` on it.
- New and merged reports produce byte-identical acknowledgements; no
  message is sent to a reporter at approval, rejection, routing, closure
  or retraction.
- The validator refuses a URL, a bare domain, an `@mention`, `t.me` and a
  phone number in admin free text, and a recommended comment over 300
  characters; the fixed warning line is present in both locales of the
  rendered post.
- Two concurrent decisions on one pending report change exactly one row.
- Retraction and closure edit the post and never send a new message; the
  terminal status is written only on the edit's success.
- Under lockdown: intake stores nothing, presses are ignored, every admin
  action is refused, alerts reach keyholders only, and only a keyholder
  clears `meta.lockdown`.
- A card or prompt older than 48 hours is edited, not deleted.

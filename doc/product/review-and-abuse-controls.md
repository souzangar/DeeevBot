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
numeric allowlist, the venue and the lockdown switch: category
confirmation (suspected CSAM offers Route only); when the report has no
account link, a force-reply prompt for it, which the link policy screens
and which must be an account on the report's platform; the link mode
within the category's set (the affected-person flag, or a flag a
cancelled approval cleared, forces account only, and so does a report
without a post URL of its own); the recommended-comment prompt, a force
reply recorded in `admin_prompts` with the confirmed category and the link
mode, and matched on the replier's allowlisted id plus
`reply_to_message.message_id`, the replier being the approving admin,
prompt and reply deleted after capture; a refused reply gets a fresh
prompt saying why. The keyholders' notice of the approval goes out before
the approval is written, and a reply whose notice reached no keyholder is
refused the same way, the fresh prompt saying that the keyholders must
send `/start` to the bot first
([Report lifecycle](./report-lifecycle.md)). "Other" uses the catalog's
fixed generic instruction block; there is no custom-instructions prompt.
The procedure, step by
step, is in the [admin review runbook](../guides/admin-review-runbook.md),
sections 2 and 4.

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
- Members: 5 open reports (pending a decision, counted from the reports
  at each submit), 20 per day. Non-members: 1 report per day and a global
  cap of 20 non-member reports per day (admin cards are the scarce
  resource). There is no subscription for anyone; the channel is
  joined in the app.
- Intake is text-only. A message carrying media or a forwarded post is
  refused with a reply and deleted, never stored, forwarded or copied.
- Outside lockdown every message the bot receives in a private chat is
  deleted on receipt, whatever it is (an intake step, a refused message, a
  command, `/start` and `/language` included; a keyholder's own commands
  excepted), before the reply, with one retry and a fallback that asks
  the sender to delete it themselves; under lockdown nothing is read,
  stored or deleted. The comment prompt warns against identifying details
  and the comment is limited to 500 characters
  ([Report lifecycle](./report-lifecycle.md)).

## Duplicate detection

A keyed hash of the normalised URL identifies a target. A second report of
the same open target (a report pending, approved, posting or posted)
becomes its own row merged into the first; the admin decides once per
target, and a routing nulls the links and comment of the merged rows in
the same batch. A merged report stores no comment and no affected-person
flag; when its reporter is the affected person and the target is still
pending, the target's flag is raised, so its post can carry the account
link only. A duplicate reported by the affected person after the approval
does not change the approved post; the admin's Cancel does. The
acknowledgement is identical for new and merged reports, so nobody can
probe whether a target was already reported. For a
target that was reported and closed before, the keyed link hash in the
aggregate row lets the admin's card say "previously reported, outcome X";
the reporter is never told.

## Block list and rejection throttle

- A block list keyed by the reporter reference: the "Block reporter"
  button on the review and status cards (so nobody types a 64-character
  reference), `/block <ref>` and `/unblock <ref>`; blocked rows persist.
  Only the primary report's reference is shown, so a merged report's
  reporter can be blocked only by `/block` with a reference taken from
  their own primary report.
- A rejection counter per reference: 3 rejections in 30 days throttle the
  reporter to 1 report per day. A rejection is counted on the reference of
  every report of the target when it is made, and counted off again when
  the rejected report is finalized, 30 days later
  (`src/broadcast/finalize.ts`), so the counter holds the last 30 days'
  rejections. Counters expire after 90 days without activity.

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
id exists and two minutes or more after the bot started the send. `/open`
lists the open reports with their ids.

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
private admin supergroup (`ADMIN_CHAT_ID`), and so do the admin commands,
`/open`, `/block`, `/unblock` and `/card <id>` (which posts a report's card
again when it is missing), typed there. Every admin command, these and
`/attach`, `/repost`, `/halt`, `/resume`, `/close`, `/retract`, `/stats`
and `/budget`, works in the venue only: typed by an admin in a private
chat it is no command, and gets the answer any unknown command gets and
is deleted on receipt. Everything the bot writes in the
venue, and every answer to a press there, is in one language,
`VENUE_LOCALE` (Persian by default), whoever acts, so a card never changes
language and the venue's text reveals no admin's client language; a
keyholder's notice is in both languages, and the answers in a keyholder's
own chat are in the keyholder's client language. The bot
is an
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
`/lockdown` or Lockdown button, or the `LOCKDOWN` secret, on the Node port
a line of its `.env` file): intake answers
a neutral "temporarily unavailable" and stores nothing; "I reported it"
presses are ignored; every admin action is refused, Approve, Reject,
Route, Cancel, `/close`, `/block`, `/halt` and `/resume` included; no
post or edit job runs except a retraction's edit (and under lockdown only
a keyholder can order a retraction);
alerts go to the keyholders by direct message and never to the venue,
which is compromised by assumption. A keyholder may still run `/open`,
`/stats`, `/attach`, `/halt` and `/retract <id>`; nobody may `/repost`. Only a
keyholder's `/unlock` clears the D1 layer, and only the keyholder clears
the override where it is set: `wrangler secret delete LOCKDOWN` on
Cloudflare, or the line removed from the Node port's `.env` and a restart.
Admins see refusals and nothing else; the procedure is
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

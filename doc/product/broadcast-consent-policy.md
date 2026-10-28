---
type: rule
title: "Broadcast consent policy"
description: "Where an approved report goes and on what terms: one post into the keyholder-owned channel, joining it as the consent and leaving as the opt-out; retraction and closure as edits of that post; the I-reported-it counter with its two caps and its advisory label; no direct message to anyone except a reply in their own chat or a keyholder alert; the Bot Developer Terms; the tests."
status: active
tags: [product, rule, consent, broadcast, channel, telegram]
timestamp: 2026-10-28T00:00:00Z
---

# Broadcast consent policy

Binding rule for every message the bot sends about a report to anyone but
the admins. It is the product side of catastrophic invariant 5 ("Posts go
only to the configured channel") and of invariant 1 (no message about a
report reaches the channel without a recorded approval). Decided on
2026-10-28, first as Q4 of
[Planning decisions](./planning-decisions-2026-10-28.md), then reduced
the same evening after the owner stated the seizure threat
([Threat model: seizure](./threat-model-seizure.md)): there is no
direct-message broadcast, no subscription and no subscriber list. The
Telegram facts it rests on are in
[Telegram Bot API notes](../reference/telegram-bot-api-notes.md).

## The channel

- Every approved report is posted once into the configured broadcast
  chat, `BROADCAST_CHAT_ID`. It is a channel (a negative chat id) owned by
  the keyholder; the bot is its only posting administrator and the human
  admins are never its administrators. A channel hides its subscribers
  from non-administrators, which a group never does; that is why the
  owner's first answer, a channel or group, became a channel.
- Joining the channel is the consent. Leaving it is the opt-out. The bot
  keeps no list of who is in it and learns nothing when someone joins or
  leaves: there is no subscriber table, no `my_chat_member` handling and
  no per-user record of any kind.
- Membership of the NGO's group plays no part here; it only sets a
  reporter's intake limits
  ([Review and abuse controls](./review-and-abuse-controls.md)).

## One post per approved report

- The post is sent by the one-minute cron after the approval's grace
  period, only from a report in the `approved` state with an un-voided
  approval row whose `starts_at` has come, and at most once: the post job
  claims the report by one conditional update that binds the current
  approval (its random `approval_id`), the lockdown switch, `/halt` and
  the global 429 pause in the same statement, so a stale tick, a Cancel
  followed by a re-approval, or a lockdown set after the eligibility read
  all claim nothing ([Report lifecycle](./report-lifecycle.md),
  [ADR 0004](../architecture/adr-0004-storage-and-delivery-ledger.md)).
- The post is bilingual (Persian first, then English) and carries only
  the links the category's routing allows, each checked against the link
  policy and rendered as code with previews disabled, the platform's
  fixed instruction block with its fixed warning line, the admin's
  recommended comment under its fixed heading, and the "I reported it"
  button ([Report categories and routing](./report-categories-and-routing.md)).
- Retraction and closure never send a new message: each edits the post in
  place (retraction replaces the text with the correction and removes the
  button; closure appends the outcome line and removes the button), and
  expiry 90 days after posting runs the closure edit with the outcome
  `expired`. The only messages the channel ever receives about a report
  are its post and the edits of that post.
- Nothing is sent to the channel under lockdown or `/halt`
  ([Threat model: seizure](./threat-model-seizure.md)); a 429 on any job
  send sets `meta.paused_until`, which every job send honours.

## "I reported it"

Each post carries an "I reported it" button. A press answers the callback
and increments the report's `presses` and the day's `counters` row (two
D1 writes) while the report is `posted`, the day's total is under
`MARKS_PER_DAY` (20,000 by default) and the report's total is under
`MARKS_PER_REPORT` (5,000 by default); beyond either cap the button still
answers and nothing is written. Nothing about the presser is stored, so
presses count presses, not people: one account can inflate a report to
its cap, and `/stats` labels the figure advisory. A keyed filter would
stop inflation but would be a membership oracle for the key holder; it is
not a default and would be an owner decision. The count survives in the
aggregate row.

## No direct messages

The bot sends a direct message only:

- as a reply to a user's own message, in that user's own chat: the
  intake conversation, its one self-deleting acknowledgement, the hotline
  links sent for a "sexual content involving a minor" label, and command
  replies;
- as an alert to a configured keyholder (`KEYHOLDER_IDS`): the approval
  notice with its Cancel and Lockdown buttons, the lockdown alert, the
  reconciliation alerts.

No decision message goes to a reporter, no closure or retraction message
to anyone, no message to a member who did not write to the bot. The
acknowledgement tells the reporter that outcomes appear in the channel.
Links in a keyholder's messages pass the same link policy as the post.

## Webhook registration

The webhook is registered with `allowed_updates` set to `message` and
`callback_query` only, a low `max_connections`, and
`drop_pending_updates` on re-registration; the authenticity check is in
[ADR 0003](../architecture/adr-0003-update-transport-and-admin-authority.md).

## Telegram's Bot Developer Terms

The only bulk message kind is the post of an approved report, with its
edits. Adding a bulk message kind, or any direct-message broadcast, is a
product decision and, per Telegram's Bot Developer Terms 5.2 on
"significant changes pertaining to the operational scope", requires
informing users with an opt-out.

## Tests this rule requires

- The only message to the channel per report is the post plus its edits;
  retraction and closure edit and never send a new message to the
  channel.
- No direct message is sent to anyone but as a reply in their own chat or
  as an alert to a keyholder id (the fake Bot API records every send's
  chat id).
- Two ticks racing on one due job post once; a Cancel followed by a
  re-approval leaves a stale job nothing to claim; a locked-down tick
  sends nothing.
- A press after closure, past `MARKS_PER_DAY` or past `MARKS_PER_REPORT`
  writes nothing and still answers the callback.
- No table holds a subscriber, ledger or per-presser row (the schema scan
  in `test/invariants/storage-retention.test.ts`).

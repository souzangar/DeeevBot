---
type: rule
title: "Broadcast consent policy"
description: "Who may receive a direct-message broadcast and on what terms: explicit opt-in, /stop and block handling, pacing and the per-day budget, the three bulk message kinds, and the mirror chat."
status: active
tags: [product, rule, consent, broadcast, telegram]
timestamp: 2026-10-28T00:00:00Z
---

# Broadcast consent policy

Binding rule for every message the bot sends to more than one person. It
is the product side of catastrophic invariant 5 (direct-message broadcasts
are consensual and idempotent) and invariant 1 (no message about a report
reaches the broadcast audience without a recorded approval); decided on
2026-10-28, Q4 in [Planning decisions](./planning-decisions-2026-10-28.md).
The Telegram facts it rests on are collected in
[Telegram Bot API notes](../reference/telegram-bot-api-notes.md).

## Opt-in

- `/start` explains the bot and offers "Subscribe" (a button or
  `/subscribe`). Subscription is available to members of the NGO group;
  non-members may report but get no direct-message subscription (see
  [Review and abuse controls](./review-and-abuse-controls.md)).
- Nothing is sent to anyone who did not subscribe, except replies to their
  own messages.
- Membership is checked at subscription and at intake and cached per user.
  Leaving the group does not end a subscription; only `/stop` or a block
  does.
- A subscriber row holds the chat id, locale, `subscribed_at` and
  `member_checked_at`, nothing else.

## Opt-out and blocks

- `/stop` unsubscribes at once, with one confirmation.
- The bot subscribes to `my_chat_member` updates and unsubscribes a user
  the moment Telegram reports the block.
- A 403 "bot was blocked by the user", a 400 "chat not found" or a "user
  is deactivated" response to any send also unsubscribes the user; these
  are not errors (see
  [ADR 0005](../architecture/adr-0005-error-handling-convention.md)).
- Unsubscribing deletes the subscriber row; each deletion path has a test.

## Webhook registration

The webhook is registered with `allowed_updates` set to `message`,
`callback_query` and `my_chat_member`, a low `max_connections`, and
`drop_pending_updates` on re-registration; the authenticity check is in
[ADR 0003](../architecture/adr-0003-update-transport-and-admin-authority.md).

## Pacing and the daily budget

- Direct-message broadcasts run at no more than 25 messages per second in
  total. Telegram documents the bulk limit as "about 30" messages per
  second, with 429 errors beyond it.
- A 429 `retry_after` pauses the whole broadcast: the step is rescheduled
  for now plus `retry_after`, with no in-invocation retry burst.
- A configured per-day recipient budget is never exceeded. It is checked
  before a broadcast starts and shown on the approval card. When the
  hosting platform's own daily cap is hit instead, the broadcaster
  persists, reschedules for 00:05 UTC plus jitter and alerts the admin chat
  once (see [ADR 0004](../architecture/adr-0004-storage-and-delivery-ledger.md)).
- One broadcast runs at a time; retraction and closure notices queue
  behind it, so a retraction completes within the hour, not at once.

## The three bulk message kinds

1. Approved reports: the broadcast itself, sent only from a report in the
   approved or broadcasting state and never before the approval record's
   start time.
2. Retractions: the correction text, applied by editing each delivered
   message in place (deleted instead where the message is younger than 48
   hours).
3. Closure outcomes: sent by direct message only to users who pressed "I
   reported it" on that report and are still subscribed at send time,
   checked against the subscribers table, so a mark left behind by `/stop`
   never produces a message. A press made from the mirror chat earns no
   direct message; the outcome reaches the mirror chat through the edited
   post.

Adding a bulk message kind is a product decision and, per Telegram's Bot
Developer Terms 5.2 on "significant changes pertaining to the operational
scope", requires informing users with an opt-out.

### "I reported it"

Each broadcast carries an "I reported it" button. A press stores a mark
(report id, chat id, time) in the broadcaster's storage, counts towards
the report's aggregate "reported" figure, and, for a subscriber, opts the
presser into that report's closure outcome. Marks are deleted at closure
with the rest of the report's data.

## Mirror chat

When a mirror chat id is configured (the NGO's existing group, or a
channel), each approved broadcast is posted there first: one message, no
pacing, no per-recipient ledger. Joining the chat is the consent, and the
bot stores no ids for its readers unless they press "I reported it". The
direct-message fan-out to subscribers follows. The mirror post's message
id is stored so that retraction and closure edit it.

- Recommended on; off by default until a chat id is configured.
- Members who are in the mirror chat and also subscribed receive every
  broadcast twice; subscribing is the opt-in to the direct-message copy.
- In the NGO group the bot stays a plain member in privacy mode, never an
  admin (an admin bot receives every group message); a mirror channel is
  one the bot administers.

## Tests this rule requires

- `/stop`, a `my_chat_member` block, and the 403/400 send responses each
  delete the subscriber row (one test per path).
- A closure outcome is never sent to a chat id that is not in the
  subscribers table at send time, even when a mark exists.
- A resumed broadcast never re-sends to a chat id the ledger records as
  delivered (the idempotency half of invariant 5, tested in the broadcast
  engine).

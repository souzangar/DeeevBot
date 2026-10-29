---
type: reference
title: "Telegram Bot API notes"
description: "The Bot API facts the bot's design relies on, as verified on 2026-10-28: broadcast rate limits, 429 retry_after, the 403 and 400 texts, link_preview_options, the webhook secret token, setWebhook parameters and delivery rules, my_chat_member, deleteMessage and editMessageText limits, getChatMember's administrator guarantee, and paid broadcasts."
status: active
tags: [reference, telegram, bot-api, limits, webhook]
timestamp: 2026-10-28T00:00:00Z
---

# Telegram Bot API notes

Lookup material for the broadcast engine, the webhook handler and the
privacy rules. Facts were fetched from core.telegram.org on 2026-10-28,
when the current version was Bot API 10.3 of August 24, 2026; the exact
error strings come from the Bot API server source on GitHub, as marked.
Items marked "verified 2026-10-28 from the downloaded Bot API page" or
"from the downloaded server source" were checked on that date against
local copies of https://core.telegram.org/bots/api and of
`telegram-bot-api/Client.cpp`, by line number.
The design decisions that use these facts are in
[adr-0003-update-transport-and-admin-authority.md](../architecture/adr-0003-update-transport-and-admin-authority.md)
and
[adr-0004-storage-and-delivery-ledger.md](../architecture/adr-0004-storage-and-delivery-ledger.md);
the consent rules in
[broadcast-consent-policy.md](../product/broadcast-consent-policy.md).

How to read the tags: [H] raw HTTP fetch, text read verbatim; [G] source
code fetched from GitHub; [S] seen only in a search result, not read;
[INF] inference, not a Telegram statement.

## Broadcast rate limits

From the Bot FAQ [H] https://core.telegram.org/bots/faq:

- Entry "My bot is hitting limits, how do I avoid this?": "In a single
  chat, avoid sending more than one message per second. We may allow short
  bursts that go over this limit, but eventually you'll begin receiving 429
  errors." / "In a group, bots are not be able to send more than 20
  messages per minute." (sic) / "For bulk notifications, bots are not able
  to broadcast more than about 30 messages per second, unless they enable
  paid broadcasts to increase the limit."
- Entry "How can I message all of my bot's subscribers at once?": "If you
  do not wish to enable paid broadcasts, consider spreading them over
  longer intervals (e.g. 8-12 hours) to avoid hitting the limit. The API
  will not allow bulk notifications to more than ~30 users per second – if
  you go over that, you'll start getting 429 errors."
- The Bot API page, section "Paid Broadcasts" [H]
  https://core.telegram.org/bots/api#paid-broadcasts, repeats: "By default,
  all bots are able to broadcast up to 30 messages per second to their
  users."

Project use: since the scope reduction of 2026-10-28 the bot sends no
direct-message broadcast: one post per approved report goes to the channel,
and a 429 on any job send pauses every job send
([ADR 0004](../architecture/adr-0004-storage-and-delivery-ledger.md)). The
limits still bound the bot's replies, alerts and edits, which share them.

## 429 and retry_after

- [H] https://core.telegram.org/bots/api#responseparameters: the field
  `retry_after` is "Optional. In case of exceeding flood control, the
  number of seconds left to wait before the request can be repeated".
- Error envelope [H] https://core.telegram.org/bots/api#making-requests:
  "In case of an unsuccessful request, 'ok' equals False and the error is
  explained in the 'description'. An Integer 'error_code' field is also
  returned, but its contents are subject to change in the future. Some
  errors may also have an optional field 'parameters' of the type
  ResponseParameters, which can help to automatically handle the error."
- The literal 429 shape is not on core.telegram.org. The Bot API server
  source [G] https://github.com/tdlib/telegram-bot-api
  (`telegram-bot-api/Query.cpp`) builds it as HTTP 429 with the description
  "Too Many Requests: retry after N" and `parameters: {"retry_after": N}`.

Project use: a 429 is classified `TELEGRAM_RATE_LIMITED`, with Telegram's
`retry_after` when it gives a usable one (`src/telegram/errors.ts`). On a
job send it reverts the post's claim, reschedules the job for now plus
`retry_after` and sets the global pause; nothing is retried inside the
invocation (ADR 0004,
[ADR 0005](../architecture/adr-0005-error-handling-convention.md)).

## 403 "bot was blocked by the user" and related texts

- The string "bot was blocked by the user" is not documented on
  core.telegram.org (the research searched /bots/api, /bots/faq,
  /bots/features, /bots/webhooks, /bots and /api/errors).
- Documented signals: the Bot API update `my_chat_member` is "The bot's
  chat member status was updated in a chat. For private chats, this update
  is received only when the bot is blocked or unblocked by the user." The
  MTProto errors page https://core.telegram.org/api/errors, section "403
  FORBIDDEN": "Privacy violation. For example, an attempt to write a
  message to someone who has blacklisted the current user."
- Exact texts from the Bot API server source [G]
  `telegram-bot-api/Client.cpp`: the MTProto error `USER_IS_BLOCKED`
  becomes error_code 403 with the message "bot was blocked by the user",
  rendered with the prefix "Forbidden", so the final description is
  "Forbidden: bot was blocked by the user"; similar: "Forbidden: user is
  deactivated".
- The 400 texts, verified 2026-10-28 from the downloaded server source
  [G] `telegram-bot-api/Client.cpp`: line 7266 builds
  `fail_query(400, "Bad Request: chat not found", ...)` and line 8810
  builds `fail_query(400, "Bad Request: private chat not found", ...)`.
  Line 8807 of the same file builds
  `fail_query(403, "Forbidden: user is deactivated", ...)` for a deleted
  user, which corroborates the text above.

Project use: there is no subscriber to remove, and the webhook does not
receive `my_chat_member`. A 403 "bot was blocked by the user" is classified
`TELEGRAM_BLOCKED`; a 403 "user is deactivated" and a 400 "chat not found" or
"private chat not found" are `TELEGRAM_CHAT_GONE` (`src/telegram/errors.ts`,
matching the code first, then these texts). On a reply each is logged by
class and ignored; on a keyholder alert it is counted as failed, and an
alert that reached no keyholder at all is sent again by the next
reconciliation (one keyholder reached suffices). A keyholder who never sent `/start`
answers 403 "bot can't initiate conversation with a user", an ordinary
`TELEGRAM_PERMANENT`. The regression test for the log boundary uses a real
GrammyError, whose payload carries the outgoing text and chat id.

## Link previews

- [H] https://core.telegram.org/bots/api#sendmessage: the parameter
  `link_preview_options` (LinkPreviewOptions) is "Link preview generation
  options for the message". LinkPreviewOptions fields: `is_disabled` "True,
  if the link preview is disabled", `url`, `prefer_small_media`,
  `prefer_large_media`, `show_above_text`.
- Changelog [H] https://core.telegram.org/bots/api-changelog, December 29,
  2023 (Bot API 7.0): "Added the class LinkPreviewOptions and replaced the
  parameter disable_web_page_preview with link_preview_options in the
  methods sendMessage and editMessageText." `disable_web_page_preview` no
  longer appears on the current API page.

Project use: every outgoing message that contains a reported URL is sent
with `link_preview_options = {"is_disabled": true}` (critical invariant 4).
The one API transformer (`src/telegram/api.ts`) sets exactly that, with
`parse_mode` HTML, on every `sendMessage` and `editMessageText`, a
retraction's or a closure's edit of the post included, whatever the caller
passed.

## Webhook secret token and delivery rules

- [H] https://core.telegram.org/bots/api#setwebhook: "If you'd like to make
  sure that the webhook was set by you, you can specify secret data in the
  parameter secret_token. If specified, the request will contain a header
  “X-Telegram-Bot-Api-Secret-Token” with the secret token as content." The
  parameter: "A secret token to be sent in a header
  “X-Telegram-Bot-Api-Secret-Token” in every webhook request, 1-256
  characters. Only characters A-Z, a-z, 0-9, _ and - are allowed. The
  header is useful to ensure that the request comes from a webhook set by
  you." Added in Bot API 6.1 (June 20, 2022, changelog).
- Delivery [H] https://core.telegram.org/bots/webhooks: non-2XY responses
  are retried ("we will repeat the request and give up after a reasonable
  amount of attempts"); the accepted ports are 443, 80, 88 and 8443;
  Telegram's source ranges are "149.154.160.0/20 and 91.108.4.0/22".
- `setWebhook` parameters, verified 2026-10-28 from the downloaded Bot API
  page [H]: `url` "HTTPS URL to send updates to. Use an empty string to
  remove webhook integration."; `max_connections` "The maximum allowed
  number of simultaneous HTTPS connections to the webhook for update
  delivery, 1-100. Defaults to 40. Use lower values to limit the load on
  your bot's server, and higher values to increase your bot's
  throughput."; `allowed_updates` "A JSON-serialized list of the update
  types you want your bot to receive. For example, specify ["message",
  "edited_channel_post", "callback_query"] to only receive updates of these
  types. See Update for a complete list of available update types. Specify
  an empty list to receive all update types except chat_member,
  message_reaction, and message_reaction_count (default). If not
  specified, the previous setting will be used." and "Please note that
  this parameter doesn't affect updates created before the call to the
  setWebhook, so unwanted updates may be received for a short period of
  time."; `drop_pending_updates` "Pass True to drop all pending updates".
- Webhook and polling are exclusive, same page: `setWebhook` note 1, "You
  will not be able to receive updates using getUpdates for as long as an
  outgoing webhook is set up."; `getUpdates` note 1, "This method will not
  work if an outgoing webhook is set up."; `deleteWebhook`: "Use this
  method to remove webhook integration if you decide to switch back to
  getUpdates. Returns True on success." The page's own port list: "Ports
  currently supported for webhooks: 443, 80, 88, 8443."

Project use: the Worker rejects any request whose
`X-Telegram-Bot-Api-Secret-Token` header does not equal the configured
secret (constant-time compare) before reading the body, with a 404 and an
empty body; the webhook path carries a random segment to keep scanner
traffic off the daily request budget, but the path is not itself the check;
an authentic update is handed to the bot under `waitUntil` and answered 200
at once, so Telegram does not redeliver (decisions Q8, Q9;
`src/telegram/webhook.ts`). The IP ranges are not used as the check (they
can change; the secret is the contract). The webhook is registered with
`allowed_updates = [message, callback_query]`, a low `max_connections` and
`drop_pending_updates` on every re-registration
([ADR 0003](../architecture/adr-0003-update-transport-and-admin-authority.md));
the Node fallback calls `deleteWebhook` before it polls.

## Message deletion and editing

Verified 2026-10-28 from the downloaded Bot API page [H].

- `deleteMessage`: "Use this method to delete a message, including service
  messages, with the following limitations:" and, among the listed
  limitations: "A message can only be deleted if it was sent less than 48
  hours ago."; "Bots can delete outgoing messages in private chats, groups,
  and supergroups."; "Bots can delete incoming messages in private
  chats."; "If the bot is an administrator of a group, it can delete any
  message there."; "If the bot has can_delete_messages administrator right
  in a supergroup or a channel, it can delete any message there." The list
  carries further bullets about service messages, dice messages, channels
  and direct-messages chats, not reproduced here.
- `editMessageText`: "Use this method to edit text, rich and game
  messages." The only age limit on the page concerns business messages:
  "Note that business messages that were not sent by the bot and do not
  contain an inline keyboard can only be edited within 48 hours from the
  time they were sent." The bot's own messages carry no stated age limit.
- `editMessageReplyMarkup`, same page: "Use this method to edit only the
  reply markup of messages. On success, if the edited message is not an
  inline message, the edited Message is returned, otherwise True is
  returned." The Message returned is the message as just edited, so its
  keyboard is the one the call set. In the downloaded server source [G]
  `telegram-bot-api/Client.cpp` (lines 110 to 113, verified 2026-10-28) the
  error `MESSAGE_NOT_MODIFIED` becomes the 400 "message is not modified:
  specified new message content and reply markup are exactly the same as a
  current content and reply markup of the message": an edit to the keyboard
  a message already carries is answered so.
- `can_edit_messages`, same page, ChatAdministratorRights: "Optional. True,
  if the administrator can edit messages of other users and can pin
  messages; for channels only". A channel administrator holding it can edit
  other users' posts, so "the bot cannot edit a message it did not send" is
  no guarantee in a channel.

Project use for `/attach` (ADR 0004, "The run as built"): since the
returned Message shows the keyboard the call just set and the bot's rights
may let it edit other users' posts, the verification never rests on a
keyboard. It edits the message with a probe keyboard of no press data, in
one of two variants so that "message is not modified" only ever switches
the variant, and accepts the message Telegram returns only by its text (the
stored post's plain text) and its date (inside the report's send window),
then puts the post's own keyboard back; a refused probe has its keyboard
removed again.

Project use: the 48-hour limit binds an administrator bot as well, so
review cards and prompts are deleted within 48 hours of their message; a
decision older than that edits the card to the outcome without links, and
the venue's auto-delete covers the rest (the earlier "at any age" reading is
withdrawn). Retraction and closure edit the channel post in place, by its
stored message id; there is no direct-message delivery to edit or delete
([Report lifecycle](../product/report-lifecycle.md)).

## getChatMember and the membership check

- Verified 2026-10-28 from the downloaded Bot API page [H]: "Use this
  method to get information about a member of a chat. The method is only
  guaranteed to work for other users if the bot is an administrator in the
  chat. Returns a ChatMember object on success."

Project use: membership of the NGO's group is checked with
`getChatMember` while the bot is a plain member in privacy mode, never an
administrator (an administrator bot receives every group message and
burns the request meter). Because the page guarantees the method only for
an administrator bot, the MVP verifies that it answers for a non-admin
member bot; if it does not, membership is anchored on the broadcast
channel, which the bot administers (a change of `MEMBERSHIP_CHAT_ID`'s
value). Membership is checked at intake only and never stored: the answer is
cached in memory, per isolate, for ten minutes under the keyed reporter
reference, and a failed call answers "not a member" (`src/auth/membership.ts`).

Methods never called on reported targets: `forwardMessage`,
`copyMessage`, `getChat` and `getFile` are tripwire patterns of Phase 2;
the bot never fetches what is behind a reported link (critical invariant
4).

## Paid broadcasts

- `allow_paid_broadcast` on the send methods (added in Bot API 7.11,
  October 31, 2024): "Pass True to allow up to 1000 messages per second,
  ignoring broadcasting limits for a fee of 0.1 Telegram Stars per message.
  The relevant Stars will be withdrawn from the bot's balance."
- Conditions, Bot FAQ: "Enabling paid broadcasts in @BotFather allows a bot
  to broadcast up to 1000 messages per second. Each message broadcasted
  over the free amount of 30 per second incurs a cost of 0.1 Stars per
  message, paid with Telegram Stars from the bot's balance. In order to
  enable this feature, a bot must have at least 100,000 Stars on its
  balance and at least 100,000 monthly active users." and "Bots with
  increased limits are only charged for messages that are broadcasted
  successfully."
- Discrepancy inside core.telegram.org: the Bot API page says "In order to
  use this feature, a bot must have at least 10,000 Stars on its balance."
  with no user-count condition. Which is current is unknown.

Project use: none. The NGO has no payment path, and one post per
approved report needs no broadcast limit at all.

## Unverified

- The exact 403, 400 and 429 strings are from the Bot API server source
  on GitHub, not from core.telegram.org.
- The Stars thresholds for paid broadcasts conflict between the Bot FAQ
  (100,000 Stars and 100,000 monthly active users) and the Bot API page
  (10,000 Stars); which is current is unknown.
- "~30 messages per second" is stated as "about".
- Whether `getChatMember` answers for a non-admin member bot in the NGO's
  group: the page guarantees it only for an administrator bot; measured in
  the MVP.

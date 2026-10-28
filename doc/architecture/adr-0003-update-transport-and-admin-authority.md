---
type: adr
title: "ADR 0003: Update transport and admin authority"
description: "A webhook with a verified secret token on Cloudflare, long polling on a VPS, and admin authority from a numeric allowlist re-checked at every action; the admin chat is a venue, never an authority."
status: active
tags: [architecture, adr, webhook, authentication, admin]
timestamp: 2026-10-28T00:00:00Z
---

# ADR 0003: Update transport and admin authority

## Context

Q8 of [Planning decisions](../product/planning-decisions-2026-10-28.md)
and catastrophic invariant 2. The owner: "if cloudflare, it can be webhook
and if VPS it can be pulls." Telegram's `setWebhook` accepts a
`secret_token` and then sends it in the `X-Telegram-Bot-Api-Secret-Token`
header of every webhook request, "useful to ensure that the request comes
from a webhook set by you" (see
[Telegram Bot API notes](../reference/telegram-bot-api-notes.md)). On the
Free plan every request to the Worker, including scanner traffic, costs
one of 100,000 daily requests
([ADR 0001](./adr-0001-runtime-and-hosting.md)).

## Decision

Both transports, one rule.

- Cloudflare: the webhook is registered with a `secret_token`. The Worker
  rejects any request whose `X-Telegram-Bot-Api-Secret-Token` header does
  not equal the configured secret, compared in constant time, before
  parsing the body. The webhook path carries a random segment to keep
  scanner traffic off the daily request budget; the path is not itself
  the check. Registration uses `allowed_updates` of `message`,
  `callback_query` and `my_chat_member`, a low `max_connections`, and
  `drop_pending_updates` on re-registration. The handler acknowledges
  Telegram with 200 after handling so Telegram does not redeliver
  ([ADR 0005](./adr-0005-error-handling-convention.md)).
- VPS: long polling with `getUpdates`, no inbound port.
- Admin authority: `ADMIN_IDS`, numeric Telegram user ids, come from the
  secret store, are parsed at startup by the configuration schema, and
  are checked at every admin action through one `isAdmin(userId)` gate.
  The admin chat id is a venue, never an authority; nothing the client
  sends (chat type, name, callback payload, forwarded message) ever
  grants authority; usernames are never consulted because they are
  reassignable.
- Membership is not authority. The NGO-group membership check
  (`getChatMember`, the bot as a plain member in privacy mode, never a
  group admin) only selects limits and the right to subscribe
  ([Review and abuse controls](../product/review-and-abuse-controls.md)).

## Consequences

- `src/telegram/` owns the secret check and `src/auth/` the allowlist
  gate and the membership check; both are critical globs
  ([ADR 0006](./adr-0006-data-model-and-module-layout.md)).
- The webhook secret and the allowlist are secrets under invariant 6:
  never in VCS, never logged, never echoed to a chat. Whether Workers
  invocation logs record request headers (which would log the secret when
  observability is enabled) is an open item.
- A rejected request still costs one Workers request; the random path
  keeps the bulk of scanners away, and anyone who messages the bot can
  burn the meter (accepted risk; the Paid plan is the fix).
- The two transports share every handler; only the update source differs,
  so the fallback port needs no second authority model.

Tests this decision requires: a webhook request with a missing or wrong
header is rejected before the body is parsed; the compare is constant
time; a callback pressed in the admin chat by a non-allowlisted id is
refused; a forwarded message from an admin grants nothing; `ADMIN_IDS`
rejects usernames at startup.

## Alternatives considered

- Filtering on Telegram's published source IP ranges: not the check; the
  secret token is what Telegram documents for proving the sender, and a
  range filter would add an operational dependency without replacing it.
- A secret path as the check: rejected; the random segment only reduces
  scanner traffic, the header check decides.
- Authority by presence in the admin supergroup: rejected; the venue is
  configurable and membership of a chat is something the client side
  influences.
- Usernames in the allowlist: rejected, reassignable.

## Status

Accepted 2026-10-28.

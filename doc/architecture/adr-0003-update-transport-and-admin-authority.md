---
type: adr
title: "ADR 0003: Update transport and admin authority"
description: "A webhook with a verified secret token on Cloudflare, long polling on a VPS; admin authority from a numeric allowlist re-checked at every action, the admin chat a venue and never an authority; the keyholder allowlist that never overlaps it; and the two-layer lockdown switch that refuses every admin action without a code deploy."
status: active
tags: [architecture, adr, webhook, authentication, admin, keyholder, lockdown]
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
([ADR 0001](./adr-0001-runtime-and-hosting.md)). On the evening of
2026-10-28 the owner stated the seizure threat
([Threat model: seizure](../product/threat-model-seizure.md)): the
admins' accounts may be taken, so invariant 2 gained a second allowlist,
the keyholders, and a switch that stops every admin action without a
code deploy.

## Decision

Both transports, one rule.

- Cloudflare: the webhook is registered with a `secret_token`. The
  Worker's `fetch` checks the path, then compares the
  `X-Telegram-Bot-Api-Secret-Token` header with the configured secret in
  constant time (`timingSafeEqual` over SHA-256 digests) before any bot
  object exists; an off-path or failed request gets a 404 with an empty
  body. Then it parses the body, runs `bot.handleUpdate(update)` under
  `executionCtx.waitUntil` with the error class logged on failure, and
  answers 200 (no `webhookCallback`), so Telegram does not redeliver
  ([ADR 0005](./adr-0005-error-handling-convention.md)); handlers are
  idempotent per update. The webhook path carries a random segment to
  keep scanner traffic off the daily request budget; the path is not
  itself the check. Registration uses `allowed_updates` of `message` and
  `callback_query` only, a low `max_connections`, and
  `drop_pending_updates` on re-registration.
- VPS: long polling with `getUpdates`, no inbound port.
- Admin authority: `ADMIN_IDS`, numeric Telegram user ids, come from the
  secret store, are parsed at startup by the configuration schema, and
  are checked at every admin action through one `isAdmin(userId)` gate.
  The admin chat id is a venue, never an authority; nothing the client
  sends (chat type, name, callback payload, forwarded message) ever
  grants authority; usernames are never consulted because they are
  reassignable. Admin commands are accepted in an admin's private chat
  with the bot or in the venue, and refused under lockdown.
- Keyholder authority: `KEYHOLDER_IDS`, the numeric Telegram ids of the
  keyholders (at least one), checked through one `isKeyholder(userId)`
  gate. A keyholder may run `/lockdown`, `/unlock`, `/retract <id>`,
  `/attach <id> ...`, `/open` and `/stats`, and press the Cancel and
  Lockdown buttons on the approval notices; keyholder commands are
  accepted only in the keyholder's private chat with the bot. A keyholder
  id is never also an admin id: the configuration schema refuses a load
  whose `KEYHOLDER_IDS` and `ADMIN_IDS` overlap, so no single seized
  account can both approve and unlock. Admins have no Cloudflare access
  and cannot override a keyholder.
- Lockdown, two layers: `meta.lockdown` in D1, set by `/lockdown` (or the
  Lockdown button) from a keyholder id, from any device, within seconds,
  and cleared only by `/unlock` from a keyholder, never by `/resume` or an
  admin; and the `LOCKDOWN` secret, which the keyholder sets with
  `wrangler secret put` (a secret change is itself a new deployment,
  global within about a minute, with no code deploy) and which no
  Telegram command clears. Under either: intake answers a neutral
  "temporarily unavailable" and stores nothing, presses are ignored,
  every admin action is refused, no post or edit job runs except a
  keyholder's retraction edit, and alerts go to the keyholders by direct
  message, never to the venue, which is compromised by assumption; the
  tick alerts the keyholders once (`meta.lockdown_alerted_at`) and still
  runs retention. The post claim binds the lockdown state in the same
  statement as the approval, so a lockdown set after a tick's eligibility
  read claims nothing
  ([ADR 0004](./adr-0004-storage-and-delivery-ledger.md)). The Node port
  reads the same `meta` row.
- Keyholder alerts: a bot cannot start a private chat, so every keyholder
  sends `/start` once at go-live and the bot confirms "you will receive
  alerts"; a failed alert is logged by class and retried by the next
  reconciliation, never dropped.
- Membership is not authority. The NGO-group membership check
  (`getChatMember` on the update's user id, the bot as a plain member in
  privacy mode, never a group admin) only selects a reporter's intake
  limits ([Review and abuse controls](../product/review-and-abuse-controls.md));
  its answer is never stored.

## Consequences

- `src/telegram/` owns the secret check and `src/auth/` the two
  allowlist gates, the membership check and the lockdown check; all are
  critical globs ([ADR 0006](./adr-0006-data-model-and-module-layout.md)).
- The webhook secret, the two allowlists and the `LOCKDOWN` secret are
  secrets under invariant 6: never in VCS, never logged, never echoed to
  a chat. Whether Workers invocation logs record request headers (which
  would log the secret when observability is enabled) is an open item.
- A rejected request still costs one Workers request; the random path
  keeps the bulk of scanners away, and anyone who messages the bot can
  burn the meter (accepted risk; the Paid plan is the fix).
- The two transports share every handler; only the update source differs,
  so the fallback port needs no second authority model.
- The `LOCKDOWN` secret works when D1 refuses queries (a daily cap
  exhausted, possibly by the attacker), which is why it exists beside the
  D1 row.

Tests this decision requires: a webhook request with a missing or wrong
header is answered 404 before the body is parsed and before any Bot API
call; the compare is constant time; a callback pressed in the admin chat
by a non-allowlisted id is refused; a forwarded message from an admin
grants nothing; `ADMIN_IDS` and `KEYHOLDER_IDS` reject usernames at
startup and the schema refuses an id present in both; a keyholder command
sent outside the keyholder's private chat is ignored; under lockdown
every admin action is refused, intake stores nothing, presses are
ignored, alerts reach keyholders only, and only a keyholder's `/unlock`
clears `meta.lockdown`.

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
- Letting an id be both admin and keyholder: rejected; a seized account
  in both lists could approve and unlock.
- A lockdown an admin can clear: rejected; the admins are the seized
  party in the threat model.

## Status

Accepted 2026-10-28.

Amended 2026-10-28 (evening, the seizure threat): `allowed_updates`
reduced to `message` and `callback_query`; the keyholder allowlist and
its commands; the two-layer lockdown; the exact shape of the webhook
boundary.

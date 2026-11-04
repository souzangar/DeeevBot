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
  Worker's `fetch` checks the path (a POST to the webhook's path, exactly),
  then compares the `X-Telegram-Bot-Api-Secret-Token` header with the
  configured secret in constant time (`timingSafeEqual` over SHA-256
  digests) before any bot object exists and before the body is read; an
  off-path or failed request gets a 404 with an empty body. Then it parses
  the body, runs `bot.handleUpdate(update)` under `executionCtx.waitUntil`
  with the error class logged on failure, and answers 200 (no
  `webhookCallback`), so Telegram does not redeliver
  ([ADR 0005](./adr-0005-error-handling-convention.md)); handlers are
  idempotent per update, the "I reported it" counter excepted (a
  redelivered press counts again: telling it from a second press would take
  a record per press, which nothing keeps). A body that is not an update is logged by class
  and answered 200, never handed to the bot; a configuration that does not
  load is logged by class and answered 500, with no bot and no body read, so
  Telegram keeps the update until the deployment is fixed. The boundary is
  `src/telegram/webhook.ts`, described for developers in the
  [developer setup](../guides/developer-setup.md), section 7. The webhook path carries a random segment to
  keep scanner traffic off the daily request budget; the path is not
  itself the check. Registration is the operator script
  `scripts/set-webhook.ts` (`npm run set-webhook -- <Worker origin>`), run
  with Node from the keyholder's machine and never part of the Worker: it
  loads the whole configuration as the Worker does (`configFor`), refusing
  one that does not load, calls `setWebhook` with the URL
  `<origin>/<WEBHOOK_PATH_SEGMENT>`, `secret_token` the configured
  `WEBHOOK_SECRET`, `allowed_updates` of `message` and `callback_query`
  only, `max_connections` 10 (the Free plan's burst is small) and
  `drop_pending_updates` true on every registration, then prints
  `getWebhookInfo` with the URL's path masked; `--delete`
  (`npm run set-webhook:delete`) calls `deleteWebhook` and keeps the
  pending updates. Any failure is one class-only log line and exit code 1.
- VPS: long polling with `getUpdates`, no inbound port. As built (the Node
  port, unit U7: `src/node.ts`, `src/telegram/polling.ts`), the port
  deletes the webhook at every start, without dropping the pending updates,
  since Telegram refuses `getUpdates` while a webhook is set, then polls
  for `message` and `callback_query` only and hands each update to the bot
  composed exactly as the Worker's; an update fetched under the bot's token
  came from Telegram by construction. A webhook set while it polls ends
  polling (Telegram's 409 "webhook is active"): the keyholders are alerted
  and the port exits with code 0 and stays stopped, yielding the bot to the
  Worker. Switching back is still to stop the port for good first, then
  register the webhook again, since a port started later deletes the
  webhook at its start. A 401, or another poller's 409, ends polling as a
  failure (exit code 1).
- Admin authority: `ADMIN_IDS`, numeric Telegram user ids, come from the
  secret store, are parsed at startup by the configuration schema, and
  are checked at every admin action through one `isAdmin(userId)` gate,
  against the update's own `from.id`.
  The admin chat id is a venue, never an authority; nothing the client
  sends (chat type, name, callback payload, forwarded message) ever
  grants authority; usernames are never consulted because they are
  reassignable. Admin commands are accepted in the venue only (since
  unit U4, below; at first an admin's private chat with the bot as well),
  typed there (a forwarded message is never a command), and refused under
  lockdown; from anyone else, or anywhere else, an admin command is not a
  command at all and gets the answer an unknown command gets, while a
  press of an admin button by an id outside `ADMIN_IDS`, or on a message
  outside the venue, is refused.
  Every command and button handler is registered behind the gates of
  `src/telegram/guards.ts`.
- Keyholder authority: `KEYHOLDER_IDS`, the numeric Telegram ids of the
  keyholders (at least one), checked through one `isKeyholder(userId)`
  gate. A keyholder may run `/lockdown`, `/unlock`, `/retract <id>` (and
  answer its prompt), `/attach <id> ...`, `/halt` (which only an admin's
  `/resume` lifts), `/open` and `/stats`, and press the Cancel and
  Lockdown buttons on the approval notices; keyholder commands are
  accepted only in the keyholder's private chat with the bot, typed there,
  and from anyone else `/lockdown` and `/unlock` are answered exactly as an
  unknown command is, so nothing hints that they exist. A keyholder
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
  Telegram command clears; it is read before any query, so it locks the
  bot when D1 refuses queries. On the Node port the override is the
  `LOCKDOWN` line of its `.env` file, read once at start, so setting or
  lifting it there takes a restart (`src/node.ts`). `/lockdown` writes the switch with the time
  it was set (a second `/lockdown` keeps the first time); `/unlock` clears
  it together with the once-only alert marker, so the next lockdown alerts
  again, and says so when the override still holds the bot locked. Under either: intake answers a neutral
  "temporarily unavailable" and stores nothing, presses are ignored,
  every admin action is refused, no post or edit job runs except a
  retraction's edit (under lockdown only a keyholder can order a
  retraction; one an admin ordered before the switch still runs, as
  built: `RUN_WHEN_HELD` in `src/broadcast/edits.ts`), and alerts go to the keyholders by direct
  message, never to the venue, which is compromised by assumption; the
  tick alerts the keyholders once (`meta.lockdown_alerted_at`) and still
  runs retention. The post claim binds the lockdown state in the same
  statement as the approval, so a lockdown set after a tick's eligibility
  read claims nothing
  ([ADR 0004](./adr-0004-storage-and-delivery-ledger.md)). The Node port
  reads the same `meta` row.
- Keyholder alerts: a bot cannot start a private chat, so every keyholder
  sends `/start` once at go-live and the bot confirms "you will receive
  alerts"; a failed alert is logged by class and counted: an alert counts
  as delivered once one keyholder got it (one delivered of several
  suffices, as for the approval notice), and one that reached no keyholder
  is sent again by the next reconciliation.
- Membership is not authority. The NGO-group membership check
  (`getChatMember` on the update's user id, the bot as a plain member in
  privacy mode, never a group admin) only selects a reporter's intake
  limits ([Review and abuse controls](../product/review-and-abuse-controls.md));
  its answer is never stored: it is cached in memory, per isolate, for ten
  minutes, under the keyed reporter reference and never the id, and a
  failed call answers "not a member" without throwing.

## Consequences

- `src/telegram/` owns the secret check and the gates commands and
  buttons are registered behind, and `src/auth/` the two allowlist gates,
  the membership check and the lockdown check; all are critical globs
  ([ADR 0006](./adr-0006-data-model-and-module-layout.md)).
- The webhook secret, the two allowlists and the `LOCKDOWN` secret are
  secrets under invariant 6: never in VCS, never logged, never echoed to
  a chat. Whether Workers invocation logs record request headers (which
  would log the secret when observability is enabled) is an open item;
  observability stays off meanwhile (`wrangler.jsonc`, pinned by
  `src/worker.test.ts`).
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
clears `meta.lockdown`. They are `test/invariants/webhook-authenticity.test.ts`
and `test/invariants/lockdown.test.ts`, with the unit tests beside
`src/telegram/webhook.ts`, `src/telegram/guards.ts`, `src/auth/` and
`src/config/schema.ts`, and the Worker's own boundary in the Workers
runtime, `test/workers/webhook.test.ts`; the Node port's update source is
`test/invariants/polling-authenticity.test.ts`, with the unit tests beside
`src/telegram/polling.ts`, and the registration's exact parameters are
pinned by `scripts/set-webhook.test.ts`.

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

Amended 2026-10-28 (Phase 3, unit U4, the review): the admin commands are
accepted in the review venue only, typed there by an id on `ADMIN_IDS`
(`isVenueAdminCommand`): since unit U3 every message the bot receives in a
private chat is deleted on receipt, so an admin's command typed in their
private chat with the bot falls to the intake's unknown-command answer and
is deleted, like anyone's; a keyholder's own commands, `/open` among them,
stay in their private chat and are kept. Every admin command, admin button,
admin reply to a prompt and keyholder command or button of the review is
registered through one helper, `src/telegram/registry.ts`, which applies
these gates (and, for an admin's button, the venue), and the always-run
lockdown spec drives every registration it records.

Amended 2026-10-28 (Phase 3, unit U2, the implementation): the boundary
takes a POST only, never reads the body before both checks, answers a body
that is not an update 200 without the bot and a configuration that does not
load 500; a forwarded message is never a command, and a non-admin's admin
command or a non-keyholder's keyholder command gets the unknown command's
answer; `/unlock` also clears the once-only alert marker; the membership
answer is cached in memory under the reporter reference; the gates live in
`src/telegram/guards.ts`; the tests named.

Amended 2026-11-04 (Phase 3, units U7 and U8): the Node port's long
polling as built (the webhook deleted at every start without dropping the
pending updates, the yield to a webhook set meanwhile) and its `LOCKDOWN`
override, read at start; the registration by `scripts/set-webhook.ts`,
with `max_connections` 10 in place of "a low `max_connections`" and the
pending updates dropped on every registration; `/halt` among the keyholder
commands; the venue-only admin commands of unit U4 in the decision's own
text; the tests named.

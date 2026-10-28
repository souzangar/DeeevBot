---
type: runbook
title: "Operations and security runbook"
description: "Running the bot safely: the BotFather owner account as root of trust, admin accounts and succession, secrets, webhook registration, the chats the bot sits in and its role in each, the grace period, Cancel and /halt, pacing and the daily budget, quota exhaustion, the mirror chat, logs, retention jobs and the stats snapshot, the fallback deployment and the yearly drill, incident procedures, and checklists."
status: active
tags: [runbook, operations, security, cloudflare, telegram, succession, iran]
timestamp: 2026-10-28T00:00:00Z
---

# Operations and security runbook

For the owner, the admins and whoever holds the succession credentials.
This runbook applies the decisions of 2026-10-28 (Q4, Q6, Q8 and Q10 in
[planning-decisions-2026-10-28.md](../product/planning-decisions-2026-10-28.md))
and the architecture records
([adr-0001-runtime-and-hosting.md](../architecture/adr-0001-runtime-and-hosting.md),
[adr-0003-update-transport-and-admin-authority.md](../architecture/adr-0003-update-transport-and-admin-authority.md),
[adr-0004-storage-and-delivery-ledger.md](../architecture/adr-0004-storage-and-delivery-ledger.md)).
The meters it refers to are tabulated in
[cloudflare-free-plan-limits.md](../reference/cloudflare-free-plan-limits.md);
the Bot API facts in
[telegram-bot-api-notes.md](../reference/telegram-bot-api-notes.md). The
review procedure itself is the
[admin review runbook](./admin-review-runbook.md).

## 1. Roots of trust

### 1.1 The @BotFather owner account

The Telegram account that owns the bot in @BotFather is the root of trust:
whoever controls it can re-issue the token, change the bot, or transfer
it. Requirements:

- [ ] 2-step verification (cloud password) is mandatory, with a recovery
      email the owner controls.
- [ ] The account is used only for @BotFather: no chats, no groups, no
      review work. It is a different account from every admin's.
- [ ] A non-Iranian number where possible. SIM swap is the realistic
      takeover path for Iranian numbers.
- [ ] The credentials (number, cloud password, recovery email access) are
      held by the owner and by the succession holder (1.3), nowhere else.

### 1.2 Admin accounts

- [ ] One dedicated Telegram account per admin, used only for review;
      2-step verification mandatory; recovery email set; never the personal
      account.
- [ ] `ADMIN_IDS` holds numeric Telegram user ids only, lives in the secret
      store, is parsed at startup and checked at every admin action through
      one `isAdmin(userId)` gate. Usernames are reassignable and grant
      nothing. The admin venue's chat id is a venue, never an authority.
- [ ] Adding or removing an admin is a configuration change: edit
      `ADMIN_IDS` in the secret store, redeploy, and add or remove the
      person in the review supergroup. A removed admin's buttons stop
      working at their next press.

### 1.3 Succession

- [ ] At least two allowlisted admin ids at all times, so no single
      account's loss stops review.
- [ ] A second trusted person, preferably outside the country, holds the
      Cloudflare account recovery codes and the BotFather owner credentials,
      and knows where this runbook is.
- [ ] Once a year (with the fallback drill, section 6) the holder proves
      they can still reach both.

### 1.4 Secrets and configuration

| Value | Where it lives | Never |
|---|---|---|
| Bot token | the deployment's secret store (Workers secrets; on the Node port, the environment or a gitignored file) | VCS, logs, any chat message |
| Webhook `secret_token` | same | same; re-issued whenever the token is re-issued |
| Reporter-reference HMAC key | same; never exported; the only thing that could re-identify a reporter reference | VCS, logs, exports, backups; note that changing it severs every existing counter and block from its reference |
| `ADMIN_IDS` | same (deployment configuration kept out of VCS) | VCS |
| Chat ids: the admin review venue (`ADMIN_CHAT_ID`), the membership chat (`MEMBERSHIP_CHAT_ID`), the mirror chat (`MIRROR_CHAT_ID`, optional) | deployment configuration validated by the zod schema | VCS |
| The bot's numeric id and username (`BOT_ID`, `BOT_USERNAME`), which spare every update a `getMe` call; set again if the bot is ever re-created | deployment configuration validated by the zod schema | |
| Per-day recipient budget, retention days (90 by default), the grace period (5 minutes), the daily cap on recorded "I reported it" presses (`MARKS_PER_DAY`, 20,000 by default) | deployment configuration validated by the zod schema | |
| Database | Cloudflare D1 through a binding (no credentials); on the Node port, a local SQLite file | copied into any backup containing per-user tables |

The commit gate's secret-shape scan (`.claude/hooks/secret-shape-scan.sh`)
is the last line of defence against a token in the tree; it is not a
substitute for keeping secrets out of it.

## 2. Deployment on Cloudflare Workers (Free plan)

### 2.1 Webhook registration

Register with `setWebhook` and these settings (decisions Q4 and Q8):

1. The Worker URL whose path carries a random segment. The segment keeps
   scanner traffic off the daily request budget; it is not the check.
2. `secret_token`: 1 to 256 characters from A-Z, a-z, 0-9, `_` and `-`.
   The Worker rejects any request whose `X-Telegram-Bot-Api-Secret-Token`
   header does not equal the configured secret, by constant-time compare,
   before parsing the body.
3. `allowed_updates = ["message", "callback_query", "my_chat_member"]`.
4. A low `max_connections`.
5. `drop_pending_updates = true` on every re-registration.

After a token re-issue: set the new token and a new secret in the secret
store, redeploy, re-register. On the Node fallback there is no webhook:
long polling with `getUpdates` and no inbound port; delete the webhook
before polling (the two are mutually exclusive).

### 2.2 The chats the bot sits in, and its role in each

| Chat | The bot's role | Why |
|---|---|---|
| Admin review venue (a private supergroup) | administrator holding `can_delete_messages`; auto-delete enabled | review cards are deleted after the decision at any age |
| The NGO's membership group | a plain member in privacy mode, never an administrator | an administrator bot receives every group message, which would route the members' chatter through the Worker and burn the request meter; membership is checked with `getChatMember`. The MVP verifies that `getChatMember` answers for a non-admin member bot; if it does not, membership is anchored on a channel the bot administers, naturally the mirror channel |
| Mirror chat (the NGO's existing group, or a channel; optional) | able to post there (for a channel, an administrator with the right to post) | one post per approved broadcast, no pacing, no per-recipient ledger; joining is the consent; the bot stores no ids for readers unless they press "I reported it" |
| Reporters' and subscribers' private chats | ordinary private chats | intake, acknowledgements, decision notices, broadcasts, retractions, closure outcomes |

Membership is checked at subscription and at intake and cached per user.
Leaving the membership chat does not end a direct-message subscription;
only `/stop` or a block does. Members who are in the mirror chat and also
subscribed receive every broadcast twice; subscribing is the opt-in to the
direct-message copy.

### 2.3 Dashboard access

- The Cloudflare dashboard and API may be blocked from Iranian IPs; the NGO
  works through its VPN. Keep the recovery codes with the succession holder
  (1.3).
- Deploys and D1 migrations run through wrangler from a machine on the
  VPN; nothing in day-to-day operation requires the dashboard.

## 3. Daily operation

### 3.1 The approval grace period, Cancel and /halt

- Approval starts a 5-minute grace period. The card shows Cancel; pressing
  it returns the report to pending and voids the approval record. The
  broadcaster re-reads the report's status at its start alarm instead of
  trusting a cleared alarm, so a cancelled report is never sent.
- `/halt` pauses all sending for every broadcast at once, until an admin
  lifts it. Use it when a retraction is coming, when the admin chat shows a
  cap alert you do not understand, or when anything about a running
  broadcast looks wrong. The lifting command is defined with the lifecycle
  ([report-lifecycle.md](../product/report-lifecycle.md)).
- No message about a report reaches subscribers or the mirror chat without
  an approval record carrying the approving admin's id, the timestamp and
  the start time (critical invariant 1); the grace period is that start
  time.

### 3.2 Pacing and the per-day recipient budget

- Direct-message broadcasts run at no more than 25 messages per second in
  total (Telegram's documented limit is "about 30"), in batches of about
  35 sends per step inside the broadcaster Durable Object.
- A 429 with `retry_after` pauses the whole broadcast; progress is
  persisted and the step rescheduled for now plus `retry_after`, with no
  retry burst inside an invocation.
- A configured per-day recipient budget is checked before a broadcast
  starts and shown on the approval card. The bot never exceeds it; when
  the subscribers do not fit, the fan-out waits for budget.
- Capacity on the Free plan at 50,000 subscribers is a few report
  lifecycles per day with heavy engagement. The Paid plan (minimum 5 USD
  per month as of 2026-10-02) removes the daily caps if the NGO ever has a
  payment path.

### 3.3 Quota exhaustion

On the Free plan an operation that hits a daily cap fails until 00:00 UTC.
The defined behaviour:

1. On a cap error the broadcaster persists its progress, reschedules the
   step for 00:05 UTC plus jitter, and alerts the admin chat once.
2. A stall-detector cron re-alerts if a broadcast has not advanced.
3. The admin does nothing destructive: no re-approval, no restart. The
   ledger resumes from where it stopped and never re-sends to a subscriber
   recorded as delivered (critical invariant 5).
4. Repeated cap alerts mean the budget is set too high for the plan, or
   someone is burning the request meter by messaging the bot; lower the
   budget, and consider the Paid plan when a payment path exists.

The meters that matter day to day (from the decision record, sourced from
developers.cloudflare.com pages dated 2026-10-12, 2026-06-01 and
2026-10-02; the full table is in cloudflare-free-plan-limits.md):

- Workers requests: 100,000 per day; every webhook update and callback
  press is one; burnable by anyone who messages the bot (accepted risk).
- Durable Object requests: 100,000 per day, a separate meter; broadcast
  steps are alarms, about 1,430 per 50,000-recipient broadcast, plus one
  per "I reported it" press.
- Durable Object duration: 13,000 GB-s per day; a broadcaster resident for
  a one-hour 50,000 run is about 460 GB-s.
- D1 rows written and Durable Object SQLite rows written: 100,000 per day
  each (indexes and deletes count; each `setAlarm` is one write).
- Cron Triggers: 5 per account (the nightly retention job and the stall
  detector use two).

### 3.4 The mirror chat

- Recommended on; default off until a chat id is configured.
- Each approved broadcast is posted there first, one message, then the
  direct-message fan-out follows for subscribers.
- Joining the chat is the consent; the bot stores no ids for readers unless
  they press "I reported it". A press from the mirror chat earns no direct
  message; the outcome reaches the mirror chat through the edited post.
- Retractions and closures edit the mirror post in place (the message id
  is stored for that).
- The mirror channel is also the natural membership anchor if
  `getChatMember` does not answer for a plain-member bot in the group
  (2.2).

### 3.5 Bulk message kinds and the Bot Developer Terms

The only bulk message kinds are: approved reports, retractions, and
closure outcomes (sent by direct message only to users who pressed "I
reported it" on that report and are still subscribed at send time, checked
against the subscribers table so that a mark left behind by `/stop` never
produces a message). Adding a bulk message kind is a product decision and,
per Telegram's Bot Developer Terms section 5.2 on "significant changes
pertaining to the operational scope", requires informing users with an
opt-out. Nothing is ever sent to anyone who did not subscribe except
replies to their own messages
([broadcast-consent-policy.md](../product/broadcast-consent-policy.md)).

### 3.6 Subscriptions

- `/start` explains the bot and offers Subscribe (a button or
  `/subscribe`), available to members of the NGO's group. `/stop`
  unsubscribes at once, with one confirmation.
- The bot subscribes to `my_chat_member` and unsubscribes a user the
  moment Telegram reports the block; a 403 "bot was blocked by the user",
  a 400 "chat not found" or a "user is deactivated" error on any send also
  unsubscribes, and none is an error.
- New subscribers whose chat id is below a running broadcast's cursor are
  skipped for that report; this is deterministic and documented, not a
  bug.

### 3.7 Intake limits

Anyone may report; membership sets the limits: members 5 open reports and
20 per day; non-members 1 report per day, a global cap of 20 non-member
reports per day across all non-members (admin cards are the scarce
resource), and no direct-message subscription. Intake is text-only: media
and forwarded posts are refused with a reply and deleted, never stored,
forwarded or copied. A reference with 3 rejections in 30 days is throttled
to 1 report per day; blocks persist.

## 4. Logs and telemetry

- Logs never contain reported URLs, comments, reporter ids or subscriber
  ids. Workers observability and `wrangler tail` are logs. A redacting
  logger and a regression test with a real GrammyError (whose payload
  carries the outgoing text and chat id) pin this.
- No third-party error tracker, telemetry or AI service ever receives
  report data; the only external services are the Telegram Bot API and the
  deployment's own storage (critical invariant 6).
- Open item: whether Workers invocation logs record request headers, which
  would put the webhook secret in a log when observability is enabled.
  Until settled, treat the observability setting as sensitive and keep it
  off unless debugging.
- Unknown errors produce a log line with the error class only, never the
  update payload.

## 5. Retention jobs, the stats snapshot, backups

- A nightly cron runs the retention job: rejected reports deleted 30 days
  after rejection; reports expired 90 days (configurable) after the
  broadcast; reporter counters expired after 90 days without activity;
  everything a closure deletes (links, comment, broadcast text, admin
  notes, delivery ledger, "I reported it" marks). Routed CSAM reports lose
  their URL and comment at routing, not at night.
- What survives: one aggregate row per report (category, platform,
  day-level dates, outcome, recipients count, "I reported it" count, keyed
  link hash) and the subscribers table (chat id, locale, subscribed_at,
  member_checked_at), each row deleted on `/stop` or a block.
- A monthly stats snapshot (aggregate rows only) is posted to the admin
  chat. It is the only export that exists.
- Backups: none that contain per-user tables, ever. The MVP keeps no
  database dumps. The recovery story is re-subscription (announced in the
  mirror chat) plus re-submission of open reports.

## 6. Fallback deployment and the yearly drill

The fallback is the Node port of the same code: Docker, long polling, the
same SQL on a local SQLite file, deployed with an empty database. Nothing
in the recovery story may depend on a Cloudflare account that is already
suspended.

Recovery procedure:

1. Obtain a host: a foreign VPS needs a payment path; an Iranian VPS needs
   a tunnel to api.telegram.org. Both are the owner's operational choices at
   that time.
2. Deploy the port with the secrets from the secret store (1.4); the
   reporter-reference key may be new, since no per-user data is carried
   over.
3. If a Cloudflare webhook is still registered, delete it; the port polls.
4. Announce re-subscription in the mirror chat; ask reporters to re-submit
   open reports.

The yearly drill proves the port starts and receives updates, and that the
succession holder can reach the Cloudflare recovery codes and the BotFather
credentials. Record the date and outcome in an audit doc under
`doc/audits/`.

## 7. Incident procedures

- **Token compromise or suspicion of it.** Re-issue the token in
  @BotFather from the owner account, set it and a new webhook secret in the
  secret store, redeploy, re-register the webhook (2.1). The old token
  stops working the moment the new one is issued.
- **Admin account compromise.** Remove the id from `ADMIN_IDS`, redeploy,
  remove the account from the review venue, and have the admin recover the
  account through Telegram's 2-step verification and recovery email. Review
  the last decisions made from that account; retract where needed
  (admin review runbook, section 8).
- **BotFather owner account compromise.** The succession holder's copy of
  the credentials is the recovery path; if the account is lost, the bot is
  lost with it, which is why section 1.1 exists.
- **Cloudflare account suspended, or the dashboard unreachable for
  longer than the VPN explains.** Run the fallback procedure (section 6).
  Do not wait for an appeal to conclude.
- **The bot restricted or banned by Telegram.** Appeals for banned bots
  and channels go to abuse@telegram.org (Telegram FAQ). Before appealing,
  check that nothing bulk was sent outside the three message kinds (3.5)
  and that no reported media was ever relayed.
- **A wrong broadcast.** Admin review runbook, section 8 (retraction
  completes within the hour).
- **Cap alerts.** Section 3.3.

## 8. Risk register

Recorded in the hosting decision; kept here for operators:

- Account suspension under US sanctions. Cloudflare has stated that
  sanctions constrain its Iran operations; OFAC General License D-2
  authorises certain communication-related services, which is not legal
  advice. Mitigation: the fallback (section 6) and minimisation (section 5).
- The Cloudflare dashboard and API blocked from Iranian IPs. Mitigation:
  the VPN; recovery codes with the succession holder.
- Hard daily caps on the Free plan. Mitigation: section 3.3; the Paid plan
  if a payment path appears.
- Data on a US provider. Mitigation: nothing personal survives closure; no
  backups with per-user tables.
- Telegram Serverless was rejected for now; re-evaluate when it documents
  timers or background execution, limits, and an export path.

## 9. Checklists

Go-live:

- [ ] BotFather owner account hardened (1.1); admin accounts hardened (1.2);
      succession holder briefed and holding the credentials (1.3)
- [ ] Secrets in the secret store, none in the tree (1.4)
- [ ] Review venue created as a private supergroup, bot an administrator
      with `can_delete_messages`, auto-delete on (2.2)
- [ ] Bot added to the membership group as a plain member in privacy mode,
      never an administrator; `getChatMember` verified to answer, or the
      membership anchor switched to the mirror channel (2.2)
- [ ] Mirror chat configured and the bot able to post (3.4)
- [ ] Webhook registered with secret token, random path, allowed updates,
      low max_connections, pending updates dropped (2.1)
- [ ] Per-day recipient budget set for the plan (3.2)
- [ ] Retention cron and stall detector scheduled (5, 3.3)
- [ ] Observability off unless debugging (4)

Weekly:

- [ ] Admin chat read for cap or stall alerts (3.3)
- [ ] Open reports older than their reasonable time closed (admin review
      runbook, section 7)

Monthly:

- [ ] Stats snapshot received in the admin chat (5)
- [ ] `ADMIN_IDS` still lists at least two live accounts (1.3)

Yearly:

- [ ] Fallback drill run and recorded (6)
- [ ] Succession holder's access to the recovery codes and the BotFather
      credentials proven (1.3)
- [ ] Platform reference pages re-verified against the live platforms
      (`doc/reference/platform-reporting-*.md`)

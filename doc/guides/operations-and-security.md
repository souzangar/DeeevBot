---
type: runbook
title: "Operations and security runbook"
description: "Running the bot safely after the seizure threat: the keyholder outside the country as the root of trust (the BotFather owner account, the Cloudflare account, the channel, the secrets), admin accounts that administer nothing, the configuration, webhook registration, the chats the bot sits in and its role in each, the grace period with Cancel and /halt, the single post and its edits, lockdown and the emergency wipe, quota exhaustion, logs, the single cron with retention and the stats snapshot, the fallback deployment and the yearly drill, incident procedures, the risk register, and checklists."
status: active
tags: [runbook, operations, security, cloudflare, telegram, keyholder, lockdown, iran]
timestamp: 2026-10-28T00:00:00Z
---

# Operations and security runbook

For the owner, the keyholder and the admins. This runbook applies the
decisions of 2026-10-28 (Q4, Q6, Q8 and Q10 in
[planning-decisions-2026-10-28.md](../product/planning-decisions-2026-10-28.md)),
the scope reduction of the same evening and its threat model
([threat-model-seizure.md](../product/threat-model-seizure.md)), and the
architecture records
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

### 1.1 The keyholder

The design assumes the admins can be arrested and their accounts and
phones used against the members (the threat model). The keyholder is the
person outside the admins' reach, preferably outside the country (the
owner: "not yet, but I can arrange it"), who holds everything the admins
must not: the @BotFather owner account (1.2), the Cloudflare account and
its recovery codes (2.3), the broadcast channel (2.2), and the secrets
(1.4). Requirements:

- [ ] Listed by numeric Telegram id in `KEYHOLDER_IDS` (at least one id).
      An id in `KEYHOLDER_IDS` is never in `ADMIN_IDS`; the configuration
      refuses to load otherwise, so no single seized account can both
      approve and unlock.
- [ ] A dedicated Telegram account with 2-step verification and a
      recovery email, on a non-Iranian number where possible.
- [ ] Has sent `/start` to the bot once and received "you will receive
      alerts" (a bot cannot start a private chat). Keyholder commands work
      only in that private chat.
- [ ] Knows the actions: Cancel on an approval notice (3.1); `/lockdown`,
      or the Lockdown button on a notice (3.6); `wrangler secret put
      LOCKDOWN` with the value `1` (3.6, when D1 or the bot cannot be
      trusted); the emergency wipe and `wrangler d1 delete` (7); the token
      re-issue (7).
- [ ] Reads every alert: the approval notices with their Cancel and
      Lockdown buttons, the `needs_attention` alerts from reconciliation,
      the lockdown alert, the cap alerts.
- [ ] Is not in the review venue and does not review; the status cards
      sit in the venue, so `/open` is how the keyholder finds a report's
      id, and `/stats` shows the counts.

### 1.2 The @BotFather owner account

The Telegram account that owns the bot in @BotFather is the root of trust
for the bot's identity: whoever controls it can re-issue the token, change
the bot, or transfer it. Held by the keyholder. Requirements:

- [ ] 2-step verification (cloud password) is mandatory, with a recovery
      email the keyholder controls.
- [ ] The account is used only for @BotFather: no chats, no groups, no
      review work. It is a different account from every admin's and from
      the keyholder's alert account.
- [ ] A non-Iranian number where possible. SIM swap is the realistic
      takeover path for Iranian numbers.
- [ ] The credentials (number, cloud password, recovery email access) are
      held by the keyholder and the owner, nowhere else, never by an
      admin.

### 1.3 Admin accounts and succession

- [ ] One dedicated Telegram account per admin, used only for review;
      2-step verification mandatory; recovery email set; never the personal
      account.
- [ ] `ADMIN_IDS` holds numeric Telegram user ids only, lives in the secret
      store, is parsed at startup and checked at every admin action through
      one `isAdmin(userId)` gate. Usernames are reassignable and grant
      nothing. The admin venue's chat id is a venue, never an authority.
- [ ] Admins administer nothing: not the broadcast channel, not the NGO's
      group, not the Cloudflare account (no access, no persistent dashboard
      session), not the BotFather account. What a seized admin account can
      do is what the bot grants an admin, and that is bounded (the threat
      model).
- [ ] Adding or removing an admin is a configuration change: edit
      `ADMIN_IDS` in the secret store, redeploy, and add or remove the
      person in the review supergroup. A removed admin's buttons stop
      working at their next press.
- [ ] At least two allowlisted admin ids at all times, so no single
      account's loss stops review.
- [ ] At least one keyholder at all times; a second keyholder, or the
      owner, holds a copy of the Cloudflare recovery codes and the
      BotFather owner credentials, and knows where this runbook is.
- [ ] Once a year (with the fallback drill, section 6) the keyholder
      proves they can still reach the Cloudflare account, the BotFather
      account and the channel.

### 1.4 Secrets and configuration

| Value | Where it lives | Never |
|---|---|---|
| Bot token | the deployment's secret store (Workers secrets; on the Node port, the environment or a gitignored file) | VCS, logs, any chat message |
| Webhook `secret_token` | same | same; re-issued whenever the token is re-issued |
| Reporter-reference HMAC key | same; never exported; the only thing that could re-identify a reporter reference | VCS, logs, exports, backups; note that changing it severs every existing counter and block from its reference |
| `ADMIN_IDS` | same (deployment configuration kept out of VCS) | VCS |
| `KEYHOLDER_IDS`, the keyholders' numeric Telegram ids (alerts, `/lockdown`, `/unlock`, `/retract`); never an admin's id, which the configuration refuses | same (deployment configuration kept out of VCS), set by the keyholder | VCS |
| `LOCKDOWN`, the keyholder's override (the value `1`; a secret change is itself a new deployment, global within about a minute, with no code deploy); no Telegram command clears it | the secret store, set by the keyholder with `wrangler secret put LOCKDOWN` (value `1`) and cleared with `wrangler secret delete LOCKDOWN` | VCS; never set or cleared by an admin |
| Chat ids: the admin review venue (`ADMIN_CHAT_ID`), the membership chat (`MEMBERSHIP_CHAT_ID`), the broadcast channel (`BROADCAST_CHAT_ID`, a channel the keyholder owns, with the bot as its only posting administrator) | deployment configuration validated by the zod schema | VCS |
| The bot's numeric id and username (`BOT_ID`, `BOT_USERNAME`), which spare every update a `getMe` call; set again if the bot is ever re-created | deployment configuration validated by the zod schema | |
| The exact link hosts a post may carry (`ALLOWED_LINK_HOSTS`, the platforms' own hosts by default), retention days (90 by default), the grace period (`APPROVAL_GRACE_MINUTES`, 30 minutes by default), the caps on recorded "I reported it" presses (`MARKS_PER_DAY`, 20,000 a day by default; `MARKS_PER_REPORT`, 5,000 per report by default) | deployment configuration validated by the zod schema | |
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
   before parsing the body, with a 404 and an empty body.
3. `allowed_updates = ["message", "callback_query"]`, nothing else.
4. A low `max_connections`.
5. `drop_pending_updates = true` on every re-registration.

After a token re-issue: set the new token and a new secret in the secret
store, redeploy, re-register. On the Node fallback there is no webhook:
long polling with `getUpdates` and no inbound port; delete the webhook
before polling (the two are mutually exclusive).

### 2.2 The chats the bot sits in, and its role in each

| Chat | The bot's role | Why |
|---|---|---|
| The broadcast channel (`BROADCAST_CHAT_ID`, a channel, negative id) | the only posting administrator; the keyholder owns the channel; no human admin is among its administrators | one post per approved report, edited at retraction and closure; joining is the consent and leaving the opt-out; a channel hides its subscribers from non-administrators, which a group never does, so a seized admin phone lists nobody; the bot stores no ids for its readers |
| Admin review venue (`ADMIN_CHAT_ID`, a private supergroup) | administrator holding `can_delete_messages`; auto-delete enabled | review cards, prompts and replies are deleted within 48 hours of their message (the Bot API's limit); the keyholder is not in it |
| The NGO's membership group (`MEMBERSHIP_CHAT_ID`) | a plain member in privacy mode, never an administrator; hidden members on; the admins out of its administrator list | an administrator bot receives every group message, which would route the members' chatter through the Worker and burn the request meter; membership is checked with `getChatMember` on the update's user id to set a reporter's limits, and never stored. The owner's go-live probe verifies that `getChatMember` answers for a plain-member bot; if it does not, `MEMBERSHIP_CHAT_ID` becomes the channel (a value change). Hidden members protect only people who never write: the group's history exposes its authors, which is outside the bot's control and the owner's decision |
| Keyholders' private chats | ordinary private chats, opened by the keyholder's `/start` | alerts, the approval notices with Cancel and Lockdown, `/lockdown`, `/unlock`, `/retract`, `/attach`, `/open`, `/stats` |
| Reporters' private chats | ordinary private chats | intake, its one self-deleting acknowledgement, the hotline links for a "sexual content involving a minor" label; nothing else, ever |

There are no subscriptions and no direct-message broadcasts; members read
the channel.

### 2.3 Dashboard access

- The Cloudflare account is the keyholder's. Admins have no access and no
  persistent dashboard session. The dashboard and API may be blocked from
  Iranian IPs; the keyholder works through a VPN.
- Deploys, secrets (`wrangler secret put`), D1 migrations, the emergency
  wipe and `wrangler d1 delete` run through wrangler from the keyholder's
  machine; nothing in day-to-day operation requires the dashboard.
- The keyholder keeps the recovery codes (1.3).

## 3. Daily operation

### 3.1 The approval grace period, Cancel and /halt

- Approval starts a grace period of `APPROVAL_GRACE_MINUTES`, 30 minutes
  by the owner's decision (1 to 1440). The card shows Cancel; pressing it
  returns the report to pending and voids the approval record.
- Every keyholder receives, by direct message, the rendered post text
  with a Cancel button that works for the whole grace and a Lockdown
  button beside it: someone outside the admins' reach sees each post
  before it goes out. Once the outcome is known the notice is edited to
  "posted" or "cancelled" without links.
- The post job is claimed by one conditional update that binds the
  approval it was enqueued for (a random `approval_id`), the lockdown
  switch, `/halt` and the global pause, so a cancelled approval, a
  re-approval after a Cancel, or a lockdown set after the eligibility
  read never lets a stale tick post.
- `/halt` holds every post and every closure edit for every report until
  an admin's `/resume`; retraction edits still run, since they remove
  harm. Use it when a retraction is coming, when an alert is not
  understood, or when anything about a post looks wrong. Neither command
  touches a lockdown.
- No message about a report reaches the channel without an approval
  record carrying the approving admin's id, the timestamp and the start
  time (critical invariant 1); the grace period is that start time.

### 3.2 The single post and its edits

- An approved report is posted once, by the one-minute cron, at most
  once. Only unambiguous failures are retried: a 429 reverts the claim
  and reschedules the job for now plus `retry_after`, setting a global
  pause that every job send honours; a 400 or 403 (no post rights, chat
  not found) reverts the claim, abandons the job, sets `needs_attention`
  and alerts the keyholders: check the bot's rights in the channel.
- A timeout, a network error or a 5xx is ambiguous and is never retried:
  the report stays `posting` without a message id and is alerted once. A
  human checks the channel: if the post is there, `/attach <id> <message
  id or t.me/c/... link of the broadcast channel>` (the bot verifies the
  message is this report's own post before accepting); if it is not,
  `/repost <id>` (admins only, never under lockdown, and only while no
  message id exists). There is no blind "post again".
- Retraction and closure edit the post in place; the terminal status is
  written only when the edit succeeds; an edit that cannot be made leaves
  the report in `closing` or `retracting` and alerts (admin review
  runbook, sections 7 and 8).
- "I reported it" presses are counted, never listed, capped by
  `MARKS_PER_DAY` and `MARKS_PER_REPORT`; `/stats` labels the figure
  advisory.

### 3.3 Quota exhaustion

On the Free plan an operation that hits a daily cap fails until 00:00
UTC. The defined behaviour:

1. A cron run that meets a cap error stops without writing; the next
   minute's run picks the due work up again once the reset has passed;
   the keyholders (and the venue, when not locked down) are alerted once.
   Nothing is rescheduled to a fixed time of day.
2. A cap error between a post's send and its id write is the ambiguous
   case of 3.2: an alert, never a retry.
3. Nobody does anything destructive: no re-approval, no restart.
4. Repeated cap alerts mean someone is burning the request meter by
   messaging the bot or pressing the button, possibly on purpose; lower
   `MARKS_PER_DAY`, and consider the Paid plan when a payment path
   exists.
5. When D1 refuses queries, the bot cannot read `meta.lockdown` either:
   the `LOCKDOWN` secret still stops all activity without a query, and
   `wrangler d1 delete` still works (section 7).

The meters that matter day to day (the full table is in
cloudflare-free-plan-limits.md):

- Workers requests: 100,000 per day; every webhook update, every button
  press and each of the 1,440 cron runs is one; burnable by anyone who
  messages the bot (accepted risk).
- D1 rows written: 100,000 per day (indexes and deletes count); a report
  costs a few dozen over its lifecycle; a press costs two, so
  `MARKS_PER_DAY` at 20,000 is at most 40,000.
- Cron Triggers: 5 per account; the bot uses one.

### 3.4 The channel

- `BROADCAST_CHAT_ID` is a channel owned by the keyholder; the bot is its
  only posting administrator; the human admins are never its
  administrators (2.2).
- Each approved report is posted there once after its grace; retraction
  and closure edit the post (the message id is stored for that);
  outcomes are visible through the edited post and nowhere else.
- Joining the channel is the consent, leaving it the opt-out; the bot
  stores no ids for readers and learns nothing when someone joins or
  leaves
  ([broadcast-consent-policy.md](../product/broadcast-consent-policy.md)).
- The channel is also the membership anchor if `getChatMember` does not
  answer for a plain-member bot in the group (2.2).

### 3.5 Bulk message kinds and the Bot Developer Terms

The only bulk message kind is the post of an approved report, with its
edits. Adding a bulk message kind, or any direct-message broadcast, is a
product decision and, per Telegram's Bot Developer Terms section 5.2 on
"significant changes pertaining to the operational scope", requires
informing users with an opt-out. The bot sends a direct message only as a
reply to a user's own message in their own chat or as an alert to a
keyholder
([broadcast-consent-policy.md](../product/broadcast-consent-policy.md)).

### 3.6 Lockdown

Two layers, either of which locks the bot:

- `meta.lockdown` in D1: a keyholder sends `/lockdown` in their private
  chat with the bot, or presses the Lockdown button on an approval
  notice; it takes effect within seconds, from any device. Only a
  keyholder's `/unlock` clears it; never `/resume`, never an admin.
- The `LOCKDOWN` secret: the keyholder runs `wrangler secret put
  LOCKDOWN` and enters `1`. A secret change is itself a new deployment,
  global within about a minute, with no code deploy; it works when D1
  refuses queries. No Telegram command clears it; the keyholder removes
  the secret with wrangler when the incident is over.

Under either layer: intake answers reporters "temporarily unavailable"
and stores nothing; presses are ignored; every admin action is refused;
no post or edit job runs except a keyholder's retraction edit; the tick
alerts the keyholders once and still runs retention, and `/lockdown`
triggers an immediate retention pass, which reduces exposure; alerts go
to the keyholders by direct message, never to the venue, which is
assumed compromised. A keyholder may still run `/open`, `/stats`,
`/attach` and `/retract <id>`. The Node port reads the same `meta` row.
The admins see refusals and nothing else (admin review runbook, section
10).

### 3.7 Intake limits

Anyone may report, in a private chat with the bot; membership of the NGO
group sets the limits: members 5 open reports and 20 per day;
non-members 1 report per day, a global cap of 20 non-member reports per
day across all non-members (admin cards are the scarce resource). There
is no subscription for anyone. Intake is text-only: media and forwarded
posts are refused with a reply and deleted, never stored, forwarded or
copied; every reporter message is deleted on receipt and the
acknowledgement deletes itself. A reference with 3 rejections in 30 days
is throttled to 1 report per day; blocks persist.

## 4. Logs and telemetry

- Logs never contain reported URLs, comments or Telegram ids of anyone.
  Workers observability and `wrangler tail` are logs. A redacting
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
- The bot refuses to start with a `DEBUG` variable or secret, whatever its
  value. Under `nodejs_compat` at the project's compatibility date the
  runtime copies every variable and secret into `process.env` (observed
  2026-10-28), and grammY's bundled `debug` package reads `DEBUG` there and
  then writes its own lines to the console, outside the redacting logger
  (method names and update ids, among others). So the configuration fails
  with `CONFIG_INVALID` naming `DEBUG`, the Worker answers every request 500
  (Telegram keeps the updates), and the fix is `wrangler secret delete
  DEBUG`.

## 5. The single cron: jobs, reconciliation, retention, the snapshot

- One Cron Trigger, every minute (`* * * * *` in wrangler.jsonc). Each
  run drains the due jobs (at most one post and a bounded number of
  edits), then, by the minute: reconciliation every 15th minute, the
  retention job at 00:15 UTC, the monthly stats snapshot on the first day
  at 06:00 UTC. The Node port runs the same function on a timer.
- Reconciliation re-enqueues a missing edit job, alerts a `posting` row
  without an id past two minutes and every `needs_attention` row once,
  finalizes a terminal row whose finalization batch failed, and never
  finalizes a report whose post is unaddressed. Alerts go to the
  keyholders and, when not locked down, to the venue too.
- The retention job: drafts older than 24 hours; prompts older than 24
  hours; pending reports older than 30 days (expired, no decision);
  rejected and routed rows 30 days after the decision; posted reports 90
  days after posting, through the closure edit (outcome `expired`);
  reporter counters after 90 days without activity, blocked ones
  excepted; daily counters older than 90 days; jobs abandoned at 20
  attempts; finalized report rows. Routed CSAM reports lose their links
  and comment at routing, not at night
  ([retention-and-minimisation.md](../product/retention-and-minimisation.md)).
- What survives: one aggregate row per report (category, platform,
  day-level dates, outcome, "I reported it" count, keyed link hash).
  Nothing else; no subscriber table exists.
- The monthly stats snapshot (aggregate rows only) is posted to the admin
  chat. It is the only export that exists.
- Backups: none of our own, ever. D1 keeps a 30-day point-in-time history
  (Time Travel) that the account holder can restore; the wipe cannot
  remove it, `wrangler d1 delete` can (section 7). The recovery story is
  re-submission of open reports, announced in the channel.

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
4. Announce in the channel that open reports must be re-submitted. There
   is nothing to re-subscribe.

The yearly drill proves the port starts and receives updates, and that the
keyholder can reach the Cloudflare account, the BotFather credentials and
the channel. Record the date and outcome in an audit doc under
`doc/audits/`.

## 7. Incident procedures

- **An admin arrested, or an admin account or phone seized, or the
  suspicion of it.** The keyholder locks down at once (3.6): `/lockdown`
  from their phone, and `wrangler secret put LOCKDOWN` if the bot or D1
  cannot be trusted. Then: remove the id from `ADMIN_IDS` and redeploy;
  remove the account from the review venue; review the last decisions
  made from that account and retract where needed (`/retract` works for
  a keyholder under lockdown); decide whether to wipe (below). What the
  seized account yields is bounded by design (the threat model): no
  reporter or member identity, only the open reports' links and
  comments. `/unlock` only when the keyholder is satisfied.
- **The emergency wipe.** At least a minute after setting lockdown
  (in-flight handlers may write for up to 30 seconds), the keyholder runs
  the documented `wrangler d1 execute` script, which deletes every row of
  every table except `stats` and `meta`. It defends against the seized
  admins, not against a seized Cloudflare account: D1's Time Travel
  history keeps 30 days that the account holder can restore. When the
  account itself is in doubt: `wrangler d1 delete` and recreate, which
  also removes the history, and re-issue the token (below). Both work
  when D1 refuses queries.
- **Token compromise or suspicion of it.** Re-issue the token in
  @BotFather from the owner account, set it and a new webhook secret in the
  secret store, redeploy, re-register the webhook (2.1). The old token
  stops working the moment the new one is issued, which also disarms any
  deployment running under it.
- **Cloudflare account compromise.** The keyholder's failure domain:
  `wrangler d1 delete` from whatever access remains, then the token
  re-issue from the BotFather owner account, which makes the seized
  deployment's token dead; what runs afterwards is the owner's call (the
  fallback of section 6 needs no Cloudflare account).
- **BotFather owner account compromise.** The second copy of the
  credentials (1.3) is the recovery path; if the account is lost, the bot
  is lost with it, which is why section 1.2 exists.
- **Cloudflare account suspended, or the dashboard unreachable for
  longer than the VPN explains.** Run the fallback procedure (section 6).
  Do not wait for an appeal to conclude.
- **The bot restricted or banned by Telegram.** Appeals for banned bots
  and channels go to abuse@telegram.org (Telegram FAQ). Before appealing,
  check that nothing bulk was sent outside the one message kind (3.5)
  and that no reported media was ever relayed.
- **A wrong post.** Admin review runbook, section 8: the post is edited
  to the correction at the next tick; a keyholder can retract under
  lockdown.
- **A post without a stored message id, or a stuck closure or
  retraction.** Section 3.2: `/attach` or `/repost`; never a second
  send.
- **Cap alerts, or D1 refusing queries.** Section 3.3.

## 8. Risk register

Recorded in the hosting decision and the threat model; kept here for
operators:

- Account suspension under US sanctions. Cloudflare has stated that
  sanctions constrain its Iran operations; OFAC General License D-2
  authorises certain communication-related services, which is not legal
  advice. Mitigation: the fallback (section 6) and minimisation (section 5).
- The Cloudflare dashboard and API blocked from Iranian IPs. Mitigation:
  the keyholder's VPN; recovery codes with the keyholder (1.3).
- Hard daily caps on the Free plan, exhaustible on purpose. Mitigation:
  section 3.3; the `LOCKDOWN` secret and `wrangler d1 delete` need no D1
  query; the Paid plan if a payment path appears.
- Data on a US provider. Mitigation: nothing personal survives closure;
  no plaintext id of any member or reporter at any time; no backups of
  our own.
- D1 Time Travel: a 30-day point-in-time history outside the wipe's
  reach. Mitigation: no plaintext ids in it, so the exposure is
  references, URLs and comments; the wipe defends against the seized
  admins; the account is the keyholder's, and `wrangler d1 delete`
  removes the history.
- The seizure of the admins. Mitigation: the threat model's controls, the
  keyholder outside the country, lockdown.
- Telegram Serverless was rejected for now; re-evaluate when it documents
  timers or background execution, limits, and an export path.

## 9. Checklists

Go-live (blocked until the keyholder exists):

- [ ] A keyholder outside the country exists, holds the BotFather owner
      account (1.2), the Cloudflare account (2.3) and the channel (2.2),
      and is listed in `KEYHOLDER_IDS` with no id in common with
      `ADMIN_IDS` (1.1)
- [ ] Every keyholder has sent `/start` and received the confirmation (1.1)
- [ ] Admin accounts hardened and administering nothing, the second copy
      of the credentials held (1.3)
- [ ] Secrets in the secret store, none in the tree (1.4)
- [ ] Review venue created as a private supergroup, bot an administrator
      with `can_delete_messages`, auto-delete on (2.2)
- [ ] Broadcast channel created and owned by the keyholder, bot its only
      posting administrator, no human admin among its administrators; the
      owner's probe: the bot posts into it (2.2, 3.4)
- [ ] Bot added to the membership group as a plain member in privacy mode,
      never an administrator; hidden members on; the admins out of the
      group's administrator list; the owner's probe: `getChatMember`
      answers, or `MEMBERSHIP_CHAT_ID` switched to the channel (2.2)
- [ ] Webhook registered with secret token, random path, `message` and
      `callback_query` only, low max_connections, pending updates dropped
      (2.1)
- [ ] The single cron scheduled (5)
- [ ] Observability off unless debugging (4)
- [ ] The lockdown and wipe procedures read by the keyholder (3.6, 7)

Weekly:

- [ ] Keyholder's alerts read: `needs_attention`, cap alerts (3.2, 3.3)
- [ ] Open reports older than their reasonable time closed (admin review
      runbook, section 7)

Monthly:

- [ ] Stats snapshot received in the admin chat (5)
- [ ] `ADMIN_IDS` still lists at least two live accounts; `KEYHOLDER_IDS`
      at least one reachable keyholder (1.3)

Yearly:

- [ ] Fallback drill run and recorded (6)
- [ ] The keyholder's access to the Cloudflare account, the BotFather
      credentials and the channel proven (1.3)
- [ ] Platform reference pages re-verified against the live platforms
      (`doc/reference/platform-reporting-*.md`)

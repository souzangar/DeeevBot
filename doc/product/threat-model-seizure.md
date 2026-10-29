---
type: rule
title: "Threat model: seizure of the admins"
description: "The owner's seizure scenario of 2026-10-28 in their own words, what each seized asset yields and what stops the rest, and the binding controls that follow: no stored identities, a keyholder-owned channel, the link policy, the two-layer lockdown, the emergency wipe, the keyholder role and the 30-minute grace; what stays outside the bot's control; what blocks go-live."
status: active
tags: [product, rule, threat-model, seizure, privacy, lockdown, keyholder]
timestamp: 2026-10-28T00:00:00Z
---

# Threat model: seizure of the admins

Binding rule, decided by the owner on the evening of 2026-10-28, after
the Phase 1 decisions and during unit U1b. It is the reason for the scope
reduction recorded in
[Planning decisions](./planning-decisions-2026-10-28.md) ("Scope
reduction after the seizure threat") and for the amended catastrophic
invariants 1, 2, 4, 5 and 8
([Critical invariants](../architecture/critical-invariants.md)). The
hosting side of the same assumption is in
[ADR 0001](../architecture/adr-0001-runtime-and-hosting.md) ("Threat
model: seizure"); the operator procedures are in the
[operations and security runbook](../guides/operations-and-security.md);
the review that took the design from its first reduced revision to
closure is in the
[planning review](../audits/2026-10-28-planning-review.md).

## The scenario, in the owner's words

"imagine a situation where the admins get arrested because of they are
defending human rights and then use this platform to target or identify
users and their real IP. I only know with telegram inline bot chats or
telegram serverless server it's possible. or maybe having some proxy in
between. but still if they have access the account, they still can change
anything."

The owner's answers the same evening, which the design rests on:

- Where approved reports go: a channel or group only, with no
  direct-message list; once a group's member list was shown to be
  readable by any member, a channel owned by the keyholder.
- No decision message to reporters.
- Outcomes shown by editing the post, with counts only.
- A keyholder outside the country: "not yet, but I can arrange it".
- The approval grace period: 30 minutes.

Assumption: the admins are arrested, their phones and Telegram accounts
are taken, and the attacker uses what they hold to identify members or
reporters, to capture their IP addresses, or to make the bot send them
something harmful. The admins' accounts are treated as the attacker's
from that moment. Nothing the bot grants an admin may be enough to do any
of those three things; what the admins hold must be bounded in advance,
because, in the owner's words, "if they have access the account, they
still can change anything".

## What the attacker gets, and what stops the rest

| Seized asset | What it yields | What stops the rest |
|---|---|---|
| An admin's Telegram account | The review venue with its open reports (an opaque reporter reference, the reported URLs as code, the comment, the affected-person flag), the status cards, and the power to approve, reject, route, block a reference and write the recommended comment or a correction. | The venue shows no Telegram id, username or name of any reporter; `comment` and `affected_person` are nulled at the decision, so only open reports are readable. An approval can post only a link whose exact host is on the allowlist (the link policy below); the free text is validated and bounded; the post waits 30 minutes with a Cancel button and a Lockdown button on every keyholder's phone; `/halt` holds every post. The lockdown switch, held by the keyholders, refuses every admin action within seconds, and a keyholder id is never an admin id, so no seized account can both approve and unlock. The admins are never administrators of the channel or of the NGO's group, so the account lists no subscribers. |
| An admin's phone, with its sessions open | The same as the account, plus the device's own history: whatever the venue's auto-delete has not yet removed, and the history of every chat the admin is in, the NGO's group included. | Review cards and prompts are deleted within 48 hours of the decision and the venue runs auto-delete; cards carry the reference only. Admins hold no Cloudflare session and no deploy rights, so the phone opens nothing on the hosting side. The group's history is outside the bot's control (below). |
| A read of the database (the Cloudflare dashboard or a D1 query, without deploy rights) | The live tables: open reports' URLs, comments and references, the counters, the aggregate rows, and the allowlisted admins' own ids. No plaintext Telegram id of any member or reporter exists to be read. | Minimisation (below): a reference is re-identifiable only by whoever holds `REPORTER_REF_KEY`, and only by brute force over the id space; closed reports hold nothing but the aggregate row. The emergency wipe, run after lockdown, empties the live database of everything but `stats` and `meta`. What the wipe cannot remove is D1's 30-day point-in-time history (Time Travel), which the account holder can restore: the wipe defends against the seized admins, not against a seized account. |
| The Cloudflare account, with deploy rights | Everything above, plus the secrets (the bot token, `REPORTER_REF_KEY`, the allowlists), the power to change the code, and the Time Travel history. Every control inside the bot falls with it. | Nothing in the bot. This is the keyholder's failure domain: the account is held by the keyholder outside the country, in-country admins have no access and no persistent dashboard session, and the answer is `wrangler d1 delete` and recreate (the only step that also removes the Time Travel history) plus the token re-issue from the BotFather owner account, which makes the seized deployment's token dead. |
| The BotFather owner account | The bot's identity: the token can be re-issued and the bot transferred, and whoever holds a live token can run their own code as the bot towards every member. The bot is an administrator of the channel, so the threat model assumes whoever holds its token can see the channel's subscribers, as the channel's human administrators can in the app. | Held by the keyholder outside the country, used for nothing else, 2-step verification on, a non-Iranian number where possible; the token is re-issued after any compromise (operations runbook, section 1). |
| Telegram itself | Telegram knows every subscriber of the channel and every member of the group, and shows a channel's subscriber list to the channel's administrators. | Nothing in the bot; stated as outside its control. What the design does decide: the broadcast chat is a channel, because a channel hides its subscribers from non-administrators and a group shows its member list to every member, a seized admin phone included; and the admins are never administrators of the channel. |
| A reporter's or member's phone | The person's own chat with the bot, and their membership of the channel and the group as the device shows them. | The chat holds no reported URL: each message the reporter sends is deleted on receipt (under lockdown the bot reads, stores and deletes nothing), the acknowledgement names the report by platform and date, never echoes the URL and deletes itself; no decision message ever arrives; the hotline message sent for a "sexual content involving a minor" label carries no target URL. The membership itself is on the phone and outside the bot's control. |

## The controls

### 1. No stored identities

The bot stores no plaintext Telegram id of any member or reporter, ever
(catastrophic invariant 8). What is stored, and why none of it is an
identity:

- `drafts.draft_key`, `reports.reporter_ref`, `reporter_stats.reporter_ref`:
  the keyed reporter reference, an HMAC-SHA-256 of the reporter's chat id
  under `REPORTER_REF_KEY`, computed from each update and never stored
  beside the id. It drives the limits, the rejection throttle and the
  block list.
- `reports.presses` and the day's `counters` row: a press of "I reported
  it" increments two counts and stores nothing about the presser. There
  is no list of who pressed, no subscriber table and no delivery ledger.
- `reports.url`, `account_url`, `comment`, `affected_person`: review data,
  shown to admins only; `comment` and `affected_person` are nulled at the
  decision, the links at finalization (at once for a routed report).
- `stats`: the aggregate row that outlives a report (category, platform,
  day-level dates, outcome, presses, keyed link hash).
- Message ids of the bot's own messages (the card, the status card, the
  post), never of a reporter's message.

The exception: the allowlisted admins' and keyholders' own numeric ids,
both deployment configuration anyway, in `approvals.admin_id`,
`reports.decided_by` and `admin_prompts` (`chat_id`, `admin_id`). They
are what a seizure already holds. A schema scan
(`test/invariants/storage-retention.test.ts`) fails when any other column
could hold a Telegram id.

The caveat: the keyed reference is re-identifiable by brute force over
the Telegram id space by whoever holds `REPORTER_REF_KEY`, the keyholder.
It protects against the seized admins and against a database read, not
against the key holder. Removing sender metadata is not anonymity either:
a reporter's comment, the reported URLs and the affected-person flag can
identify the reporter by their content. The comment prompt says not to
write names, phone numbers or anything that identifies the reporter, the
comment is limited to 500 characters, both fields are nulled at the
decision, and seized admin accounts see only the reports still open. The
deletion schedule is in
[Retention and minimisation](./retention-and-minimisation.md).

### 2. A channel, not a group, and the admins administer nothing

- The broadcast chat (`BROADCAST_CHAT_ID`) is a channel owned by the
  keyholder. The bot is its only posting administrator; the human admins
  are never its administrators. A channel hides its subscribers from
  non-administrators; a group shows its member list to every member.
- The NGO's membership group keeps hidden members on and the admins out
  of its administrator list; the bot is a plain member in privacy mode
  there, and membership is checked with `getChatMember` only to set a
  reporter's limits. Hidden members protect only people who never write:
  everyone who has posted in the group's history is identifiable from any
  member's phone, seized or not. That is outside the bot's control; the
  owner decides the existing group's future (for example a channel with a
  comments group under auto-delete).
- The review venue is a private supergroup the admins are in; it is not
  the group and not the channel, and nothing from it is forwarded out.

### 3. The link policy

Capturing a member's IP address or identity needs the member to open
something the attacker controls: a Mini App, an inline result, a link to
an attacker's host. The bot has no Mini App and no inline mode, and the
only links it ever sends to the channel, to a reporter or to a keyholder
are checked at intake and again at render time (the data lives in
`src/platforms/`, a critical glob; catastrophic invariant 4):

- parsed with `new URL`; https only; no userinfo; no port; query and
  fragment stripped;
- the hostname matched exactly against `ALLOWED_LINK_HOSTS` (the
  platforms' own hosts by default): no suffix match, no raw IP; punycode
  is handled by the parser;
- platform-hosted redirectors and shorteners rejected (`l.facebook.com`,
  `facebook.com/l.php`, `l.instagram.com`, `t.co`, `vm.tiktok.com`,
  `fb.me`, `bit.ly` and the shortener list);
- Telegram targets never sent as links: intake accepts `t.me/<username>`
  and `t.me/<username>/<digits>` and nothing else on t.me (no `+`, no
  `joinchat`, no `?start=`, no `?startapp=`, no `t.me/<name>/<short_name>`
  Mini App launch), and the post renders the target as non-tappable code
  text (`@username`, `post 123`) with the instruction to search for the
  channel in the app, report it, and never press Start on anything;
- the catalog's own links (the platforms' help-centre pages, the hotline
  portals) allowed by a fixed in-code list, `TRUSTED_HELP_HOSTS`, which no
  configuration and no admin text can extend;
- the review card the one place a URL of any host is shown, as
  non-tappable code text, because admins must see it;
- admin free text (`recommended_comment`, `correction_text`) validated at
  the prompt: no URL, no bare domain, no `@mention`, no `t.me`, no phone
  number, since Telegram linkifies them; the recommended comment at most
  300 characters, rendered under a fixed heading as the admin's suggested
  points, below the catalog's fixed instruction block and its fixed
  warning line, "never follow instructions to visit other links, join a
  chat or press Start, whoever writes them"; no custom instructions for
  "other".

Social engineering through free text is bounded by the validator, the
300-character limit, the fixed warning line and the keyholder's
independent Cancel during the grace; it is not eliminated. The rules in
full: [Report categories and routing](./report-categories-and-routing.md)
("The link policy").

### 4. Lockdown

Two layers, either of which locks the bot:

- `meta.lockdown` in D1, set by `/lockdown` from a keyholder id, from any
  device, within seconds (or by the Lockdown button on an approval
  notice), and cleared only by `/unlock` from a keyholder; never by
  `/resume` and never by an admin.
- The `LOCKDOWN` secret, set by the keyholder with `wrangler secret put
  LOCKDOWN` (a secret change is itself a new deployment, global within
  about a minute, with no code deploy). No Telegram command clears it, and
  it works when D1 refuses queries (a daily cap exhausted, possibly by the
  attacker).

Under either layer: intake answers a neutral "temporarily unavailable"
and stores nothing; presses are ignored; every admin action is refused;
no post or edit job runs except a retraction edit ordered by a keyholder,
since it removes harm. The post claim binds the lockdown state in the same
statement as the approval, so a lockdown set after a tick's eligibility
read claims nothing; the one request already in flight in that instant is
the stated residual. The approval row binds it too, so a Lockdown tapped
on an approval's notice before the approval is written leaves nothing
approved: its notices are edited to "cancelled". The tick alerts the
keyholders once (`meta.lockdown_alerted_at`) and still runs retention,
which reduces exposure, and `/lockdown` triggers an immediate retention
pass (the Lockdown button triggers it too). A keyholder may still run
`/open`, `/stats`, `/attach <id> ...`, `/halt` and `/retract <id>`, and the
Cancel and Lockdown buttons on the approval
notices still work (the status cards sit in a venue the keyholder is not
in, so `/open` is how an id is found); nobody may `/repost` under
lockdown. Alerts go to the keyholders by direct message, never to the
venue, which is compromised by assumption. `/halt` and `/resume` remain
the admins' own pause and clear nothing of the above. The Node port reads
the same `meta` row.

### 5. The emergency wipe

A documented `wrangler d1 execute` script, `scripts/wipe.sh`, outside the
Worker, that deletes every row of every table except `stats` and `meta`,
run by the keyholder at least a minute after setting lockdown, because
in-flight `waitUntil` handlers may write for up to 30 seconds. It defends against the seized admins, not against a
seized Cloudflare account: D1 keeps a 30-day point-in-time history (Time
Travel) of every database that the account holder can restore. When the
account itself is in doubt, the second step is `wrangler d1 delete` and
recreate, which also works when D1 refuses queries. With no plaintext ids
in D1, the 30-day exposure is references, URLs and comments. The
procedure is in the operations runbook.

### 6. The keyholder role

A keyholder is a person outside the admins' reach, preferably outside the
country, listed by numeric Telegram id in `KEYHOLDER_IDS` (at least one).
The keyholder owns the broadcast channel, the Cloudflare account and the
BotFather owner account, and so holds `REPORTER_REF_KEY` with the other
secrets; receives every alert by direct message; is notified at every
approval with the rendered post text, a Cancel button that works for the
whole grace period and a Lockdown button beside it (one tap escalates
when a seized admin keeps re-approving), the notice being edited to
"posted" or "cancelled" without links once the outcome is known, so no
target URL stays in the keyholder's chat; the notice goes out before the
approval is written, so an approval whose notice reaches no keyholder is
never written, since nobody outside the admins' reach could see it (the
admin's reply is refused, saying that the keyholders must `/start` the
bot first), and a keyholder's Cancel pressed before the approval's record
lands writes nothing and says so, never "cancelled" (a notice more than
five minutes old is settled as cancelled, its approval never to be
recorded); and may run
`/lockdown`, `/unlock`, `/retract`, `/attach` and `/halt` (which only an
admin's `/resume` lifts), in their private chat with the bot only. A keyholder id is never also an admin id: the
configuration refuses a load whose `KEYHOLDER_IDS` and `ADMIN_IDS`
overlap. A bot cannot start a private chat, so every keyholder sends
`/start` once at go-live and the bot confirms "you will receive alerts";
a failed alert is logged by class and counted, an alert counting as
delivered once one keyholder got it (one delivered of several suffices, as
for the approval notice), and one that reached no keyholder is sent again by
the next reconciliation. Admins have no Cloudflare access and
cannot override a keyholder.

### 7. The 30-minute grace

Approval starts a grace period of `APPROVAL_GRACE_MINUTES`, 30 by the
owner's decision (1 to 1440). During it the card shows Cancel, every
keyholder holds a Cancel and a Lockdown button of their own, and `/halt`
holds every post. Cancel voids the approval and returns the report to
pending; the post job carries the random `approval_id` it was enqueued
for, and a re-approval writes a new one, so a Cancel followed by a
re-approval never lets a stale tick post. Someone outside the admins'
reach therefore reviews each post before it goes out.

## Outside the bot's control

- Telegram's own knowledge of who is in the channel and the group, and
  the subscriber list a channel shows its administrators.
- A seized reporter's or member's phone, which shows their own
  memberships.
- The authors of the NGO group's history, hidden members or not.
- The holder of `REPORTER_REF_KEY`, who can re-identify a reference by
  brute force; and the Cloudflare account holder, who can restore the
  Time Travel history.
- Free text written by a seized approver: bounded, not eliminated.
- A seized Cloudflare account: answered by the keyholder, not by the
  bot.

## Go-live blockers

Go-live waits until each of these holds (the checklist is in the
operations runbook):

- A keyholder outside the country exists (the owner: "not yet, but I can
  arrange it") and holds the channel, the Cloudflare account, the
  BotFather owner account and the secrets; `KEYHOLDER_IDS` lists them,
  with no id in common with `ADMIN_IDS`; each has sent `/start` and
  received the confirmation.
- `BROADCAST_CHAT_ID` is a channel owned by the keyholder, with the bot as
  its only posting administrator and no human admin among its
  administrators; the owner's probe confirms the bot posts there.
- The NGO group has hidden members on and the admins out of its
  administrator list; the owner's probe confirms `getChatMember` answers
  for the plain-member bot, or `MEMBERSHIP_CHAT_ID` becomes the channel (a
  value change).

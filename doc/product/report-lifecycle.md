---
type: spec
title: "Report lifecycle"
description: "The report state machine after the scope reduction of 2026-10-28: the statuses from pending to the aggregate row, the transitions with what each records, the intake steps, the at-most-once post with its one claim statement, the ambiguous-failure path with a verified /attach and /repost, closure and retraction as edits of the post, and the one self-deleting acknowledgement the reporter gets."
status: active
tags: [product, lifecycle, state-machine, review, post, channel]
timestamp: 2026-10-28T00:00:00Z
---

# Report lifecycle

The states a report passes through, from intake to the aggregate row that
outlives it. Decided on 2026-10-28 (Q3, Q4, Q5 and Q10 in
[Planning decisions](./planning-decisions-2026-10-28.md)) and reduced the
same evening after the owner stated the seizure threat
([Threat model: seizure](./threat-model-seizure.md)): no direct-message
broadcast, no decision message to reporters, one post per approved report
into the keyholder-owned channel. The storage and the jobs behind it are
in [ADR 0004](../architecture/adr-0004-storage-and-delivery-ledger.md),
the tables in
[ADR 0006](../architecture/adr-0006-data-model-and-module-layout.md).

## Statuses

| Status | Meaning |
|---|---|
| `pending` | submitted, waiting for an admin decision |
| `approved` | approved; the grace period (`APPROVAL_GRACE_MINUTES`, 30 by default) runs; Cancel is available on the card and on every keyholder's notice |
| `posting` | a tick has claimed the report and the post is being sent |
| `posted` | the post is in the channel and its message id is stored; waiting for closure |
| `closing` | closure (by an admin, or by expiry) was ordered; the edit of the post has not yet succeeded |
| `retracting` | an admin or a keyholder retracted it; the edit of the post has not yet succeeded |
| `closed` | the post shows "taken down" or "closed without result"; finalized |
| `retracted` | the post shows the correction; finalized |
| `expired` | 90 days (configurable) passed since the post and the closure edit succeeded; or a pending report reached 30 days without a decision (outcome `no_decision`) |
| `rejected` | an admin rejected it |
| `routed` | the admin categorised it as suspected CSAM and routed it |
| `merged` | a second report of a target that is already open |

Transitions: `pending` to `approved` (grace, cancellable) to `posting` to
`posted` to `closing` or `retracting` to `closed`, `retracted` or
`expired`; `pending` to `rejected`; `pending` to `routed`; `pending` to
`merged`; `pending` to `expired` with no decision at 30 days. Cancel
during the grace returns an approved report to `pending`. For a posted
report a terminal status is written only by the success of the edit job,
so a report whose post is unaddressed is never finalized; rejected,
routed and pending-expired reports have no post and finalize in D1 alone.

## Transitions

| From | To | Trigger | Recorded |
|---|---|---|---|
| intake | `pending` | the reporter completes the intake conversation (below) | the report row: platform, category, URL, account URL, comment, affected-person flag, the keyed reporter reference (never the chat id), the keyed link hash, `created_at` |
| intake | `merged` | the keyed hash of the normalised URL matches an open target (pending, approved, posting or posted) | its own row with `merged_into` the oldest such report, holding no comment and no affected-person flag (nobody reads them: the admins decide on the target's card); when its reporter is the affected person and the target is still pending, the target's flag is raised in the same batch, so its post can carry the account link only; the acknowledgement is identical to a new report's |
| `pending` | `approved` | an allowlisted admin presses Approve, confirms the category (suspected CSAM leads to the routing card instead), enters the account link when the report has none, picks the link mode and replies to the recommended-comment prompt; the allowlist, the venue and the lockdown switch are re-checked at every step, and only the admin who was prompted can answer the prompt; the rendered post is validated in both locales, together with the keyholders' notice that carries it, against 4096 characters and the link allowlist before anything is written; then, still before anything is written, every keyholder is sent the notice by direct message under the new approval's id: the rendered post text, a Cancel button for the whole grace and a Lockdown button beside it. An approval whose notice reaches no keyholder (every send failed, a timeout included) is never written: the reply is refused like any other, by a fresh prompt saying that the keyholders must send `/start` to the bot before the admin replies again; one delivered notice of several suffices | in one batch, every statement bound to the new approval: the approval row (a random `approval_id`, `admin_id`, `approved_at`, `link_mode`, `recommended_comment`, `starts_at`, now plus the grace), written only while the report is pending and the lockdown switch is not set (the switch bound in the statement itself, since the notices and their Lockdown button go out after the gates read it), and over a voided row only; the conditional status change, with the admin's category, the link mode and the rendered post (`broadcast_text`); a `post` job due at `starts_at` carrying that `approval_id` (the plan's `INSERT OR IGNORE`, as `ON CONFLICT (kind, report_id) DO NOTHING`, so a refused row fails rather than vanishes); `comment` and `affected_person` nulled on the report and its merged rows; the report's prompts deleted. Then the card edited to show Cancel; a status card saying how many keyholders got the notice; the prompts and the reply deleted from the venue. When the batch loses (another decision won after the notices went out, or a keyholder locked the bot down meanwhile, when the batch writes nothing but the answered prompt's deletion), the notices are edited to "cancelled" without links, and the prompt is ended in the venue unless the bot is locked down. When it fails, a read decides: the approval did not land, and the notices are edited so; it landed after all, and the failure is logged by class and the approval goes on as if the batch had answered, since a live approval's notice never says "cancelled"; the read fails too, and the notices are left as they are |
| `approved` | `pending` | an admin presses Cancel on the card or the status card, or a keyholder presses Cancel on the notice, before the tick claims the report; the button names its approval's id, so a stale one cancels nothing; under lockdown only a keyholder's Cancel works; a keyholder's Cancel on a notice whose approval is not recorded (the notice goes out before the batch, which has not landed yet or never will) changes nothing, leaves the notice and its buttons as they are and answers that the approval is not recorded yet, until the notice is more than five minutes old (no approval's batch takes that long on Workers): then the notice is edited to "cancelled" and the answer says so | in one batch: `voided_at` set on the approval, the post job deleted, the status back to `pending` with the rendered post, the link mode and the status card's id cleared; then the keyholder notices edited to "cancelled" without links, the card back to its review state and the status card deleted (under lockdown only the notices are edited, never the venue) |
| `approved` | `posting` | the tick finds the due `post` job and claims the report with one conditional update (below) | `posting_started_at`; the send follows in the same invocation |
| `posting` | `posted` | the send succeeded | `post_message_id` (unique), `posted_at`, the job deleted, in one batch; the keyholder notice edited to "posted" without links |
| `posting` | `approved` | an unambiguous failure of the send: a 429 (the job rescheduled for now plus `retry_after`, `meta.paused_until` set), or a 400 or 403 such as no post rights or chat not found (`needs_attention` set, the keyholders alerted, the job abandoned) | the claim reverted and `posting_started_at` cleared in the same batch |
| `posting` | `posted` | `/attach <id> <message id or t.me/c/... link of the broadcast channel>` by an admin or a keyholder (under lockdown a keyholder only) who found the post in the channel after an ambiguous failure; the bot verifies the message first (below) | `post_message_id`, `posted_at` |
| `posting` | `approved` | `/repost <id>` by an admin (never under lockdown) who found no post in the channel; admitted only while no `post_message_id` exists | `posting_started_at` cleared; the job re-enqueued |
| `posted` | `closing` | `/close <id> <outcome>` or a status-card button; the outcomes "taken down" and "closed without result" | `outcome`; an `edit` job |
| `posted` (or `posting` once `/attach` supplied the id) | `retracting` | `/retract <id>` by an admin, or by a keyholder (also under lockdown), with the correction by prompt | `correction_text`, written before the status change; an `edit` job |
| `closing` | `closed` | the edit job appended the outcome line and removed the button | the terminal status and the finalization batch together: the aggregate row upserted, every personal and content field nulled, `approvals`, `admin_prompts`, merged rows and the job deleted, `data_deleted_at` set |
| `retracting` | `retracted` | the edit job replaced the post's text with the correction and removed the button | the same batch; the aggregate row keeps `retracted` |
| `posted` | `closing`, then `expired` | the retention job, 90 days (configurable) after the post | the closure edit with the outcome `expired`, then the same finalization |
| `pending` | `rejected` | an admin presses Reject and picks a reason code (internal) | in one batch: `decided_by`, `decided_at`, `rejection_reason`; `comment` and `affected_person` nulled on the report and its merged rows; the rejection counted once on the reference of every report of the target; the report's prompts deleted; then the card deleted (edited to the outcome when older than 48 hours); the row finalized 30 days later |
| `pending` | `routed` | the admin categorises as suspected CSAM and confirms on the routing card | in one batch: `decided_by`, `decided_at`, the category suspected CSAM; `url`, `account_url`, `comment` and `affected_person` nulled on the report and its merged rows; the report's prompts deleted; then the card deleted (edited to the outcome when older than 48 hours); the row finalized 30 days later; see [categories and routing](./report-categories-and-routing.md) |
| `pending` | `expired` | the retention job, 30 days after intake with no decision | outcome `no_decision`; finalized in D1 |

A `/repost` is also admitted from `approved` when no job exists after an
abandoned 400 or 403, again only while no `post_message_id` exists.

### The claim statement

A `post` job is claimed by one conditional update that binds eligibility
to the current approval, the lockdown switch, `/halt` and the global 429
pause in the same statement:

```sql
UPDATE reports SET status = 'posting', posting_started_at = ?
WHERE id = ? AND status = 'approved'
  AND EXISTS (SELECT 1 FROM approvals a WHERE a.report_id = reports.id
              AND a.voided_at IS NULL AND a.starts_at <= ?
              AND a.approval_id = ?)
  AND NOT EXISTS (SELECT 1 FROM meta WHERE key IN ('lockdown', 'halted'))
  AND NOT EXISTS (SELECT 1 FROM meta WHERE key = 'paused_until' AND value > ?)
```

with exactly one row changed, the job carrying the random `approval_id`
it was enqueued for (a re-approval writes a new `approval_id`, so a
timestamp is never the key). A stale tick that read an old approval, a
Cancel plus a re-approval with a new start, or a lockdown set after the
eligibility read all claim nothing; the Cancel-and-re-approve
interleaving is a test. The send follows the claim within the same
invocation; the one request already in flight between the claim and a
lockdown set in that instant is the stated residual.

### Ambiguous and unambiguous failures

Only unambiguous failures are retried. A 429, a 400 or a 403 means
Telegram did not accept the send, so the claim is reverted as in the table
above. A timeout, a network error or a 5xx is ambiguous: Telegram may have
accepted the send, so the report stays `posting` without an id, is never
re-sent automatically, and is alerted once; so is a tick that died between
the send and the second write (reconciliation finds a `posting` row older
than two minutes with no id; a `posting` row whose job is still present
and within its window is in progress, not stuck). A human then checks the
channel:

- If the post is there, `/attach <id> <message id or t.me/c/... link of
  the broadcast channel>` records `post_message_id` and moves the report
  to `posted`, after verification: the bot calls `editMessageReplyMarkup`
  on that message with this report's own keyboard and accepts the attach
  only if the returned message carries the callback data
  `mark:<this report id>` (a message the bot did not send fails to edit;
  another report's post carries another id). `post_message_id` is
  unique, and `/attach` is the only way a message id enters the row other
  than the bot's own write.
- If it is not, `/repost <id>` clears `posting_started_at`, returns the
  report to `approved` and re-enqueues the job.

Authority: admins and keyholders may `/attach`; admins may `/repost`;
under lockdown only keyholders may `/attach` and nobody may `/repost`.
There is no blind "Post again". Tests: two ticks racing on one due job
post once; a timed-out send is never re-sent; an attach of another
report's message id is refused; an attach of a message the bot did not
send is refused; `/attach` then `/retract` edits the attached message.

### First decision wins

With one or two admins a status change is a conditional update
(`WHERE status = 'pending'`, exactly one row changed), and every other
statement of the decision's batch is bound to the same condition (or, for
an approval, to its new approval id), so a losing decision writes nothing
(a losing approval only removes the prompt it answered).
The losing admin's press is answered "already decided" with the report's
state, and its card is edited to that state. The same conditional update
guards Cancel, the claim of the post, closure and retraction.

### Grace period, Cancel and /halt

Approval starts the grace period of `APPROVAL_GRACE_MINUTES`, 30 minutes
by the owner's decision (1 to 1440). The card carries Cancel, and every
keyholder receives the rendered post with a Cancel button that works for
the whole grace and a Lockdown button beside it, so someone outside the
admins' reach reviews each post before it goes out; the notice goes out
before the approval is written, so an approval whose notice reaches no
keyholder is never written, and it is edited to the outcome, without
links, once that is known. `/halt` holds every post
and closure edit for every report until `/resume`; retraction edits still
run, since they remove harm. Both are in the
[operations and security runbook](../guides/operations-and-security.md);
lockdown, which overrides all of this, is in the
[threat model](./threat-model-seizure.md).

## Intake

Private chats only, behind the lockdown gate; text only: a message
carrying anything but text (a photo, a document, a sticker, a voice note,
a location, a poll and the like), a forward, a message sent through an
inline bot and a reply quoting another chat are refused with a reply and
deleted, never read. The draft (`drafts`) is keyed by the reporter
reference computed from the update's chat id, which is never stored in
plaintext; its locale is the reporter's resolved one, or the choice of
`/language`, which the draft keeps. The steps (`drafts.step`):

1. `url`: one link, as text: the message itself when it is one token (an
   address without a scheme, `instagram.com/name`, is read as https),
   else the one token with `://`. It passes the link policy of
   [categories and routing](./report-categories-and-routing.md), and a
   refusal says why: not a link, more than one, a shortener or redirect,
   a Telegram link outside `t.me/<username>` and
   `t.me/<username>/<digits>`, a page that is no account or post, any
   other refused link. The draft is written with the normalised link, its
   platform and the account it names, if it names one;
2. `account`: the account's link, asked for only when the URL does not
   name it (an Instagram `/p/` link, a Facebook share link, reel or group
   post, a site other than the five platforms); it must be an account on
   the same platform. The "I don't know" button skips it, and the admin
   finds the account;
3. `category`: seven buttons, the categories of the routing table, the
   suspected-CSAM one labelled "sexual content involving a minor";
4. `affected`: "I am the affected person", yes or no, as buttons;
5. `comment`: optional, at most 500 characters, `/skip` for none; the
   prompt says not to write names, phone numbers or anything that
   identifies the reporter. The comment, or `/skip`, submits the report.

A button press is answered (`answerCallbackQuery`) and edits the prompt
it sat on into the next one, so a press never causes a new message. A
message at a step a press answers repeats that step's prompt, and a press
on an old prompt is answered "already answered"; neither changes
anything. Every draft write is conditional on the step it leaves, so a
double press or a message sent twice moves a draft on once. `/cancel`
deletes the draft at any step. A command the intake does not know is
deleted like every other message, and nothing is stored; it gets the
answer every unknown command gets.

Outside lockdown every message the bot receives in a private chat is
deleted on receipt, whatever it is: every intake step, a refused or
misplaced message, `/cancel`, `/skip`, a command the bot does not know,
`/start` and `/language`. The only exceptions are a keyholder's own
commands (`/start` from a keyholder, `/lockdown`, `/unlock`), whose chat
is an operations log the keyholder keeps, and the lockdown path, which
reads, stores and deletes nothing. Each message is deleted by the handler
that took it, after the write that recorded its content has committed
and before the reply is sent; a refused or misplaced message records
nothing and is deleted at once. The delete is awaited and
retried once, a message already gone counts as deleted, and if it still
fails the reply asks the reporter to delete that message themselves and
the failure is logged by class. If anything fails before the message was
deleted (a read, the membership check, the write), it is deleted all the
same before the error reply. So an abandoned draft leaves no URL in the
reporter's chat and the draft needs no message ids.

The submit is one D1 batch: the draft deleted, from the comment step only
(a second submit of the same draft writes nothing); the reference's
`reporter_stats` row, written only if the limits hold; the report; the
day's non-member count. Members of the NGO group (`getChatMember` on the
update's user id, cached in memory, never stored) may have 5 open
reports, open meaning pending a decision, and submit 20 a day;
non-members 1 a day, and 20 a day all together; three rejections in 30
days throttle a reference to 1 a day; a blocked reference is refused. The
open count is read from `reports` at each submit, so no decision has to
keep a counter right; `reporter_stats.open_count` holds it as of the
reference's last submit. A refused submit gets the neutral
`error.rate_limited`, a blocked reference included, and keeps nothing:
the draft is deleted. The report is `merged` into the oldest open target
with the same keyed link hash (the HMAC of the normalised URL under the
reporter-reference key, `src/privacy/link-hash.ts`), open meaning
pending, approved, posting or posted: a report in `closing` or
`retracting` is leaving the channel, so a new report of its target is
reviewed afresh; otherwise it is `pending`. A merged report stores no
comment and no affected-person flag, since the admins decide once, on the
target's card, so a duplicate of a target already decided leaves nothing
of them behind; when its reporter is the affected person and the target
is still pending, the target's flag is raised in the same batch, so the
review offers the account link alone. Under lockdown intake answers
"temporarily unavailable" to a message and to a button press alike, and
stores and deletes nothing.

## What the reporter is told

- At intake, one acknowledgement, identical for a new and a merged report
  so nobody can probe whether a target was already reported. It names the
  report by platform and date, never echoes the URL, says that outcomes
  appear in the channel, and deletes itself from inside the same
  `waitUntil` at `min(handlerStart + 25 s, ackSent + 20 s)`, so the
  runtime's 30-second lifetime after the response is never exceeded; no
  message id is stored for it. The handler waits for it on the clock
  port, so on the Node port's long polling updates must be handled
  concurrently. The replies before it echo nothing the reporter sent.
- When the reporter's label is "sexual content involving a minor", a
  second, persistent message carries the public hotline links and nothing
  else (no target URL), so the reporter can report directly whatever the
  admin later decides.
- Nothing at any decision: no approval, rejection or routing notice, no
  closure or retraction message. The bot holds no way to reach the
  reporter about the report, by design. The prior outcome of a
  re-reported target is shown on the admin's card only.

## Closure outcomes

An admin closes a posted report as "taken down" or "closed without
result", or retracts it; the retention job expires it 90 days after the
post. Every path edits the post (the button is removed in each case),
writes the terminal status only when that edit succeeds, and finalizes in
the same batch: the report's links, comment, texts, approval, prompts,
merged rows and job are deleted or nulled and the aggregate row remains
([Retention and minimisation](./retention-and-minimisation.md)). An edit
job that fails past its bound, or is blocked, leaves the report in
`closing` or `retracting` with `post_message_id` and `correction_text`
intact, sets `needs_attention` and alerts; reconciliation re-enqueues a
missing edit job and never finalizes a `closing` or `retracting` row.
"Message is not modified" and "message to edit not found" are non-errors.

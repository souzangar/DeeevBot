---
type: runbook
title: "Admin review runbook"
description: "Step-by-step procedure for reviewing a report: account and workstation isolation, the suspected-CSAM gate, the decision checklist with the approve prompts and the free-text rules, the per-category routing table, the routing card with its hotline links, closure and retraction as edits of the channel post, reporter abuse and why nobody is messaged, what lockdown looks like to an admin, Telegram posts forwarded from bots, and the legal and safety notes for the Iranian context."
status: active
tags: [runbook, admin, review, moderation, csam, safety, iran, lockdown]
timestamp: 2026-10-28T00:00:00Z
---

# Admin review runbook

For the one or two allowlisted admins, on every pending report. This
runbook applies the decisions of 2026-10-28 (Q1, Q3, Q6 and Q7 in
[planning-decisions-2026-10-28.md](../product/planning-decisions-2026-10-28.md))
and the scope reduction of the same evening
([threat-model-seizure.md](../product/threat-model-seizure.md)): an
approved report is posted once into the channel, reporters get no
decision message, and your account is assumed to be seizable, so what it
can make the bot do is bounded in advance. The bot enforces what can be
enforced in code (approval records, link modes, the link policy, limits,
deletion); this runbook covers what the bot cannot do: verification,
categorisation, routing judgement, and the admin's own safety. The policy
itself lives in the product docs
([report-categories-and-routing.md](../product/report-categories-and-routing.md),
[report-lifecycle.md](../product/report-lifecycle.md),
[review-and-abuse-controls.md](../product/review-and-abuse-controls.md),
[retention-and-minimisation.md](../product/retention-and-minimisation.md));
where this runbook and a product doc disagree, the product doc wins and
this runbook is corrected. Account hardening, the keyholder, lockdown and
the deployment are in
[operations-and-security.md](./operations-and-security.md).

## 1. Before you start

### 1.1 Your admin account

- [ ] A dedicated Telegram account for admin work, never your personal
      account. 2-step verification (cloud password) enabled, with a
      recovery email. SIM-swap is the realistic takeover path for Iranian
      numbers; see the operations runbook for hardening and succession.
- [ ] Your numeric Telegram id is in the `ADMIN_IDS` allowlist. Usernames
      grant nothing, and membership of the review venue grants nothing: the
      venue's chat id is a venue, never an authority. An admin id is never
      a keyholder id; the configuration refuses the overlap.
- [ ] You are not an administrator of the broadcast channel and not an
      administrator of the NGO's group. The bot is the channel's only
      posting administrator and the keyholder owns it.
- [ ] You know what to do if the account is compromised, or if you are at
      risk of arrest: tell the keyholder at once, who runs `/lockdown`;
      then the other admin and the operator; the id is removed from
      `ADMIN_IDS` and the deployment updated (operations runbook, incident
      procedures).

### 1.2 Your workstation

- [ ] An isolated browser profile, or a dedicated device, used only for
      review and logged out of every personal account.
- [ ] Always over the NGO's usual VPN.
- [ ] Reported URLs arrive as non-tappable code text with link previews
      disabled. Copy them by hand into the isolated profile. Never open
      them in a chat client, a personal browser, or anything that generates
      previews.
- [ ] You never download, save, screenshot, bookmark, forward or copy
      reported content anywhere. What you need to decide is visible on the
      platform's own page, and the decision is recorded by the bot. No
      private notes with URLs.
- [ ] Suspected child sexual abuse material is never opened (section 3).

### 1.3 The review venue

- The venue is a private supergroup with the bot as an administrator
  holding `can_delete_messages` and with auto-delete enabled. Review
  cards, prompts and replies are deleted within 48 hours of their message
  (the Bot API's limit, which binds administrator bots as well; see
  [telegram-bot-api-notes.md](../reference/telegram-bot-api-notes.md)); a
  decision older than that edits the card to the outcome without links,
  and auto-delete removes the rest. Decide cards promptly.
- The venue is not the NGO's group and not the broadcast channel. Nothing
  about a report is posted anywhere else, and nothing from the venue is
  forwarded out of it. The keyholder is not in the venue; alerts reach
  them by direct message.

## 2. What a review card shows

The bot posts one review card per report into the venue as soon as the
reporter submits it. A second report of the same open target is merged
into the first and gets no card of its own: you decide once per target.
The card shows:

- The report's id, the one `/open` lists and the later commands take, and
  the platform.
- The reporter's category label, marked as a hint only. After an approval
  that was cancelled, the card shows that approval's category instead,
  marked as a cancelled approval's, and the reporter's original label is
  no longer shown (the approval wrote the admin's category over it); the
  category step then marks that category ✓.
- The reported URL, and the account's link when it differs, as
  non-tappable code text whatever their host; a URL longer than 1,000
  characters is cut short and marked. The account's link is "not given"
  when the reporter answered "I don't know": if you approve, the bot asks
  you for it; find it from the post while you verify it.
- The URLs are normalised at intake: the platform's canonical host (for
  example `www.instagram.com`, `x.com`, `t.me`), no query, no tracking
  parameters, no fragment. The account's link is derived from the post's
  URL where it names the account (X, TikTok, Telegram, an Instagram link
  with the username); otherwise the reporter was asked for it.
- The reporter's comment, as code text so that nothing written in it can
  become a link, and the "I am the affected person" flag. Both exist for
  your review only: the bot nulls both at your decision, on this report and
  on every report merged into it. After a cancelled approval the flag reads
  "cleared", and the post can then carry the account link only.
- A reporter reference (an opaque keyed value, 64 characters), never the
  reporter's id, username or name. You cannot identify the reporter from it
  and must not try; the key that could re-identify it is never exported
  from the secret store.
- "Previously reported: <outcome>" when an earlier report of the same
  target was decided, from the keyed link hash: rejected or routed (shown
  at once), or taken down, closed without result, retracted or expired
  (shown from the aggregate row once that report was finalized). This line
  is on the admin card only; the reporter is never told.
- Buttons: Approve, Reject, Route as suspected CSAM, Block reporter. After
  an approval, the card shows when the post goes out and a Cancel button
  for the 30-minute grace period, and a status card for the report follows
  it: its id, platform, category and state, how many keyholders received
  the approval notice, and the buttons Cancel and Block reporter. Once the
  report is posted, the status card carries Taken down, Closed without
  result and Retract instead of Cancel (sections 7 and 8); once it is
  concluded, it shows the outcome and no button.

How the card behaves:

- Everything the bot writes in the venue (the card and its steps, the
  prompts and their refusals, the routing card, the status card, the
  answers to the venue's commands) and every answer to a press there is in
  one language, the deployment's `VENUE_LOCALE`, Persian unless it is set
  to English, whatever the language of your own Telegram app: a card never
  changes language, and the venue reveals nobody's app language. Outside
  the venue, a keyholder's approval notice is in both languages, and the
  answers to a keyholder's presses and commands in their own chat are in
  the keyholder's own app language.
- Every press is checked on its own: your numeric id must be on
  `ADMIN_IDS`, the press must sit on the report's current card (or its
  status card) in the venue, and the bot must not be locked down. A press
  on an older card of the report is answered "This card is out of date".
- If a report has no card (`/open` marks it "no card", say because the
  venue refused the first one), `/card <id>` posts it again; the old card,
  if there is one, is deleted, or marked out of date when it is older than
  Telegram's 48 hours. A card the report could not take (decided while
  the card went out, or its id not stored) is deleted at once, or edited to
  the outcome without links or buttons, so no card with live buttons stays
  that its report does not know of.
- The admin commands, `/open`, `/block <ref>`, `/unblock <ref>` and
  `/card <id>`, are typed in the venue, as are the scheduler's (`/attach`,
  `/repost`, `/halt`, `/resume`) and the closure's: `/close <id>
  taken_down|no_result`, `/retract <id>`, `/stats [YYYY-MM]` (the counts
  of the reports concluded this month, or in the month given, from the
  aggregate rows alone, the "I reported it" presses labelled advisory) and
  `/budget` (the day's counted presses against `MARKS_PER_DAY` and the
  day's reports from non-members against their cap). Typed in your private chat with
  the bot, a command is no command: the bot deletes it and answers as it
  answers any unknown command.
- Intake is text-only. A reporter's message carrying media or a forwarded
  post is refused with a reply and deleted at intake, never stored,
  forwarded or copied; you never receive media through the bot. A reporter
  who wants to point at a post sends its link.
- First decision wins. If both admins act on the same card, exactly one
  decision goes through (a conditional update), and the other admin's press
  is answered "Already decided" with the report's state, its card edited to
  that state. Do not re-decide a card that shows an outcome.
- Duplicate reports of the same open target are merged automatically into
  the first report, keeping no comment and no flag of their own; when a
  duplicate's reporter says they are the affected person while the report
  is still pending, the first report's flag is raised, and the card shows
  it at your next step. A duplicate arriving after your approval changes
  nothing of the approved post: if it should, Cancel. No reporter is told
  anything at any decision.

## 3. Step 0: the suspected-CSAM gate

Do this first, on every card, from the description and from context that
does not require opening media.

1. Read the reporter's label and comment. The label "sexual content
   involving a minor" is a hint; it decides nothing by itself, in either
   direction.
2. Look only at what is visible without opening images or videos: the
   account's name and bio, the post caption, the channel description, the
   platform's own warnings or interstitials. Do not open media "to check".
3. Apply the definition of doubt. Doubt means doubt about whether the
   material is sexual, not about whether a minor appears. A child's public
   photo with insults is child safety or harassment and goes through the
   normal flow (section 4). When the doubt is about the sexual nature of
   material involving a minor, route: the hotlines' analysts assess the
   URL, and a wrong routing costs analyst time, while opening the material
   would be a crime and a harm.
4. If the description or the context indicates sexual content involving a
   minor, or you are in doubt about its sexual nature: press Route as
   suspected CSAM and follow section 6. Open nothing further.
5. If, while verifying any other category, what you see turns out to be
   sexual content involving a minor: stop at once, do not scroll, do not
   screenshot, close the page, and route the report (section 6).

## 4. Decision checklist for every other report

Work through every step; approve only when every step passes.

1. **The link resolves to what is described.** Open the URL in the
   isolated profile. It must lead to the account or the post the reporter
   describes, on the platform the bot detected. A dead link, a wrong target
   or content you cannot see: Reject.
2. **Confirm the category from the platform's own view.** What you see
   must itself show the violation: private data published, abusive text on
   a person's image, an impersonating profile, content endangering a child.
   The reporter's comment is context, not evidence.
3. **Check for weaponisation.** The reported account may be the victim: an
   abuser reporting the person who exposed them, a state-aligned reporter
   targeting a dissident, a feud between members. A report with no visible
   violation is rejected, whatever the comment says. This line is not
   eroded by any "when in doubt" rule: doubt about the sexual nature of
   material involving a minor routes (section 3); doubt about every other
   category rejects.
4. **Never open suspected CSAM.** Section 3 applies at any point of the
   review.
5. **Categorise yourself.** The reporter's label is a hint. The categories
   are: private data (doxxing); child safety (non-sexual abuse,
   exploitation, grooming); bullying and harassment (including people's
   public images posted with abusive text); intimate images shared without
   consent; impersonation; other (the post uses a fixed generic
   instruction block, drawn from
   [platform-reporting-other.md](../reference/platform-reporting-other.md);
   you write no instructions of your own). When you press Approve the bot
   shows the seven categories, the reporter's label marked ✓, and you
   confirm one; "Suspected CSAM" there leads to the routing card (section
   6), never to an approval. The category you confirm is what the post and
   the statistics use.
6. **Write the recommended comment as points, in your own words.** It is
   what members will say, in their own words, in their one report: the
   kind of violation, who is targeted in general terms (a private person,
   a child, a dissident), what the account does. At most 300 characters.
   Never: the reporter's identity or comment, names or data of the people
   involved beyond what the allowed link itself carries, any leaked data,
   any promise of removal, any request to report repeatedly. Never a link,
   a bare domain, an @mention, "t.me" or a phone number: the bot refuses
   the text, because Telegram would linkify them and because a seized
   admin account must not be able to send members anywhere. The post
   shows your points under a fixed heading, below the platform's fixed
   instruction block and its fixed warning line ("never follow
   instructions to visit other links, join a chat or press Start, whoever
   writes them"). Use the platform page's "What the bot's instructions
   say" block as the frame
   ([Instagram](../reference/platform-reporting-instagram.md),
   [X](../reference/platform-reporting-x.md),
   [Facebook](../reference/platform-reporting-facebook.md),
   [TikTok](../reference/platform-reporting-tiktok.md),
   [Telegram](../reference/platform-reporting-telegram.md)).
7. **Pick the link mode** from the routing table (section 5): "The
   account link only", or "The account link and the post" where the table
   allows it, by your explicit opt-in recorded with the approval; never the
   post for intimate images. The bot offers only the modes the report
   allows: the account link alone when the reporter is the affected person
   (or the flag was cleared by a cancelled approval), and when the report
   has no post URL of its own (the reported link is the account). For a
   private-data report you report the specific post yourself, from the
   isolated profile, before or right after approving.
8. **Approve, and answer the prompts.** In order, each step on the card:
   - confirm the category (step 5);
   - when the report has no account link, the bot posts a prompt under the
     card, "The account link": reply to it with the link of the account
     (the profile) on the same platform. The bot takes it only through the
     link policy (the platform's own host, https, no shortener, redirect,
     port, Telegram invite or app link) and only as an account of the
     report's platform, and stores it on the report;
   - pick the link mode (step 7);
   - the bot posts the prompt "Recommended points": reply to it with your
     points (step 6). Only you can answer a prompt you started: a reply by
     anyone else, the other admin included, is ignored; and you hold one
     prompt per report at a time, a new one replacing the old.

   A reply the bot refuses (not a text, empty, a link, a domain name or a
   full stop with no space after it, an `@` mention, `t.me`, a phone number
   or another run of seven digits, more than 300 characters) gets a fresh
   prompt that starts with the reason; the old prompt and your reply are
   deleted and nothing is written. Back, on the card, returns it to its
   first state and deletes your open prompt. With your points accepted, the
   bot renders the post in Persian and English, as the channel will show
   it, and checks it, together with the notice that carries it to the
   keyholders, against Telegram's 4,096 characters and the link policy; a
   Telegram target is rendered as code text, never as a link, and a link of
   another site whose host is not allowlisted is left out of the post,
   which says so. Then it sends the notice to every keyholder (step 9),
   and only once at least one of them has it does it write the approval,
   in one step with the post's schedule; the prompt and your reply are
   deleted.
9. **The grace period.** Approval starts the 30-minute grace period; the
   card and the status card show Cancel, and the status card says how many
   keyholders received the notice ("Keyholders notified: 2 of 2"). Cancel
   returns the report to pending, voids the approval record and deletes the
   scheduled post; the card returns to review, the status card is deleted.
   Every keyholder receives the rendered post with a Cancel button and a
   Lockdown button of their own, so someone outside the admins' reach sees
   each post before it goes out; a keyholder's Cancel works like yours, and
   the notices are edited to "Cancelled" without links. Cancel works until
   the bot starts sending the post; after that it is too late, and a wrong
   post is retracted (section 8). An approval after a Cancel is a new
   approval, under a new approval id. `/halt` holds every post and closure
   edit for every report until `/resume` (operations runbook). After the
   grace period the bot posts once into the channel.

   If the notice reached no keyholder (each send failed: a keyholder who
   never sent `/start`, one who blocked the bot, a timeout), nothing is
   approved, since nobody outside your reach could see the post: the bot
   writes nothing and answers your reply as it answers any refused one, by
   a fresh prompt that starts "Refused: no keyholder could be notified, so
   nothing was approved". Ask the keyholders to send `/start` to the bot,
   then reply to the fresh prompt again. One keyholder reached of several
   is enough; the status card then says how many were. If another admin's
   decision landed while the notices went out, the notices are edited to
   "Cancelled" and your prompt ends; so are they when a keyholder taps
   Lockdown in that moment, and then nothing is approved and the venue
   gets nothing more. A keyholder who presses Cancel in the moment between
   the notice and the approval's record is told that the approval is not
   recorded yet, and presses again once it is; a notice more than five
   minutes old whose approval was never recorded is settled as
   "Cancelled" instead.
10. **Reject** with one of the reasons the bot offers, internal codes
    shown to nobody: "No visible violation", "Dead link or wrong target",
    "The reported account may be the victim", "Another reason". The card
    is deleted (edited to "rejected" when it is older than 48 hours). The
    reporter gets no message. Rejections feed the reporter's throttle (3
    rejections in 30 days limit that reference to 1 report per day); a
    rejection counts once on the reference of every report of the target,
    the merged ones included.

## 5. Per-category routing table

The authoritative table is
[report-categories-and-routing.md](../product/report-categories-and-routing.md);
this copy is for use at the keyboard.

| Category (your decision at step 5) | Posted? | Links the post carries | Instruction block | Notes |
|---|---|---|---|---|
| Private data (doxxing) | yes | account link by default; the post URL only by your explicit opt-in recorded with the approval, when you judge it necessary and safe; the affected-person flag forces account only | platform page, "Private information" (key `private-information`) | you report the specific post yourself; the affected person is told to file the platform's first-person report |
| Child safety: non-sexual abuse, exploitation, grooming | yes | account link by default; the post URL by your opt-in at step 7 | platform page, "Child safety, non-sexual" (key `child-safety`) | a child's public photo with insults belongs here or under harassment; doubt about the sexual nature routes (section 3) |
| Suspected child sexual abuse material | never | none; routed from your card | none, by design (card key `csam-routing`) | section 6; nothing reaches the channel or anyone else |
| Bullying and harassment (incl. public images with abusive text) | yes | account link by default; the post URL by your opt-in at step 7 | platform page, "Bullying and harassment" (key `harassment`) | where the platform wants to hear from the targeted person, the instructions say so |
| Intimate images shared without consent | yes | account only, never the post URL (a routing rule, not a default) | platform page, "Intimate images shared without consent" (key `intimate-images`) | the affected person files the first-person report |
| Impersonation | yes | account link by default; the post URL by your opt-in at step 7 | platform page, "Impersonation" (key `impersonation`) | the account is the target |
| Other | yes | account link by default; the post URL by your opt-in at step 7; no link at all unless its host is in the configured allowlist | the fixed generic block, drawn from platform-reporting-other.md | no reason label you did not see yourself; you write no instructions |

For a Telegram target the "account" is the channel (and the bot the post
was forwarded from, when the header shows one), named in the post as
code text, never as a link; see section 11.

## 6. Suspected CSAM: the routing card

When you press Route as suspected CSAM on the card, or confirm the
category "Suspected CSAM" after Approve, the bot replaces the review card
with a routing card, an edit of the card in the review venue and never a
message anywhere else. It carries the reported URL, and the account's
link when it differs, as code text; the platform's own path; the hotline
links from [csam-hotlines.md](../reference/csam-hotlines.md); the wording
for your hotline report; and the buttons Confirm routing and Back (which
returns the review card). It does not show the reporter's comment. Work
through the routes in order, then confirm.

1. **The platform's own child-exploitation path, one report by you.**
   Platforms deduplicate; volume buys nothing. Instagram and Facebook:
   the in-app Report path; X: the child sexual exploitation form
   (https://help.x.com/en/forms/safety-and-sensitive-content/cse); TikTok:
   in-app, "Violence, abuse, and criminal exploitation", then
   "Exploitation and abuse of people under 18"; Telegram: Report with the
   reason "Child Abuse" on the channel and the post. File it without
   opening the media: the URL and the reporter's description are enough,
   and X says "We do not require you to provide evidence of the potential
   violation in your report."
2. **One hotline report per URL.** INHOPE: "Please submit each report only
   once."; ICMEC and IWF: "Do report only once for each web address or
   URL." Pick one portal: NCMEC's CyberTipline, https://report.cybertip.org/
   (anyone, anywhere; names optional); the ICMEC-IWF portal,
   report.icmec.org ("anyone, anywhere"); the IWF portal,
   https://report.iwf.org.uk/en (anonymous, contact details optional); or
   the national hotline found in the INHOPE directory,
   https://www.inhope.org/what-we-do/how-to-report, where one exists (the
   entry for Iran was not verified; the portals that take reports from
   anywhere are the default). Submit only the URL, no files, no
   screenshots. State in the report: "unverified member report, content
   not opened". If a form asks where you are located, NCMEC asks "so we
   can make sure the information is made available to the right law
   enforcement agency"; what you disclose is your decision, with section 12
   in mind.
3. **Telegram-hosted target: also email stopCA@telegram.org** with the
   t.me link and, when the post shows "Forwarded from <bot>", the bot's
   @username. Use an NGO address, not a personal one.
4. **Confirm the routing on the card** (Confirm routing). The bot then
   records your admin id and the timestamp and the category "suspected
   CSAM", nulls the report's URL, account URL, comment and affected-person
   flag at once, in one step, on the report and on every report merged
   into it (only the aggregate fields and the keyed link hash remain), and
   deletes the card from the venue (edits it to "routed" without links
   when it is older than 48 hours). Neither you nor the bot messages the
   reporter at routing: a reporter who used the label "sexual content
   involving a minor" already received the public hotline links at intake,
   so they can report directly too. The report's status becomes routed;
   there is no closure step for you later, and no approval can exist for
   it.
5. **Nothing else, ever.** Not to the channel, not to the other admin's
   direct messages, not to the NGO's group, not to a contact in law
   enforcement or another NGO. INHOPE: "never share links or files with
   anyone outside the official reporting channels. Sharing is illegal and
   can further harm the child." Forwarding to alert someone is still
   distribution (the IWF case in csam-hotlines.md).

## 7. Closure

When to close: the reported account or content is gone ("taken down"),
nothing happened after a reasonable time ("closed without result"), or
the post was wrong ("retracted", section 8). Ninety days after the post
the report expires on its own, through the same edit.

1. Check the target in the isolated profile. Do not do this for routed
   reports; they are already closed at routing and you no longer have the
   URL.
2. Run `/close <id> taken_down` or `/close <id> no_result` in the venue,
   or press Taken down or Closed without result on the report's status
   card. `/open` lists the open reports with their ids. There is no
   confirmation step: the press closes the report.
3. What the bot does: moves the report to `closing`, and the status card
   says so; at the next minute's run it edits the channel post, appending
   the outcome line in both languages and removing the "I reported it"
   button; only when that edit succeeds does it write `closed` and, in the
   same batch, keep the aggregate row (category, platform, day-level
   dates, outcome, "I reported it" count, keyed link hash) and delete the
   report's links, comment, texts, approval, prompts, jobs and merged
   duplicates; the status card then shows the outcome without buttons, and
   the rest of the report's row goes the next night. Nobody is messaged,
   not the reporter and not the members: the edited post is the outcome.
   If the post with its outcome line would be too long for Telegram's 4096
   characters, the post is replaced by the outcome line alone.
4. If the edit cannot be made, the report stays in `closing` with the post
   untouched and keeps its data: the bot sets `needs_attention`, alerts the
   keyholders (and the venue when not locked down) once, the status card
   says so, and the edit is tried again every few minutes; after 20 failed
   tries the nightly job drops it with an alert, and reconciliation queues
   it again at the next quarter hour, so once the cause is fixed (usually
   the bot's right to edit in the channel, which the keyholder restores)
   it concludes by itself. Nothing is finalized while the post is
   unaddressed. `/halt` holds closure edits, and under lockdown none runs.
5. A report being closed cannot be retracted any more, and a closed one has
   no message id left to edit: if a closed post turns out wrong, the
   keyholder deletes it by hand in the channel.

## 8. Retraction

When to retract: the approval was wrong (the reported account was the
victim, the category was wrong in a way that harms, the link pointed at
the wrong target), or the owner asks. The harm grows with every member who
acts on a wrong post, so decide fast.

1. If the report is still in its grace period: press Cancel; the report
   returns to pending and the approval record is voided. A keyholder can
   do the same from their notice.
2. If it is posted: write the correction text, neutral, no blame, no
   identity of anyone, no leaked data, and within the same rules as the
   recommended comment (no link, bare domain, @mention, "t.me" or phone
   number); it must also fit, with the fixed retraction heading in both
   languages, in Telegram's 4096 characters. It replaces the post's text in
   the channel.
3. Run `/retract <id>` in the venue, or press Retract on the status card,
   and reply to the correction prompt the bot posts; only your own reply
   to your own prompt counts. A refused text gets a fresh prompt saying
   why; reply to that one. What the bot does: writes the correction to the
   report first, moves it to `retracting`, and the status card says so; at
   the next minute's run it replaces the post's text with the fixed
   heading, the warning line and your correction, removes the button, and,
   when the post is younger than 48 hours, deletes it as well; only when
   the edit succeeds (or the post is gone) does it write `retracted` and
   finalize as in section 7; the aggregate row keeps "retracted", and the
   keyholders' approval notices the bot remembers say "retracted". The
   prompt and your reply are deleted from the venue. `/halt` never holds a
   retraction edit, and a keyholder can run `/retract` in their own chat
   with the bot, even under lockdown: the prompt and the reply are then in
   that chat.
4. A report shown as `posting` with no message id (an ambiguous send: a
   timeout, a network error or a 5xx; the bot never re-sends on its own):
   look in the channel. If the post is there, `/attach <id> <message id or
   t.me/c/... link of the broadcast channel>`, typed in the venue; the bot
   verifies that the message is this report's own post before accepting
   (a message that is not is refused and left as it was, the answer saying
   whether its text or its date did not fit), and then you can
   `/retract`. A bot post must never be edited by a human: an edited post
   cannot be attached and must not be re-posted. If it is not there, `/repost <id>` returns the report to
   `approved` and the bot posts at the next minute's run; `/repost` is
   admitted only while no message id exists, only two minutes or more
   after the bot started the send (the status card says when it needs
   you), and never under lockdown. There is no blind "post again".
5. If the edit cannot be made, the report stays in `retracting` with its
   correction and its message id, alerted and retried as in section 7,
   step 4.
6. Tell the other admin. If the retraction follows a weaponised report,
   apply section 9 (block the reporter reference).
7. Retraction closes the report; its data is deleted as in section 7.

## 9. Reporter abuse handling, and why nobody is messaged

What the bot enforces (you see the effects; you do not operate them):

- Anyone may submit. Membership of the NGO's group is checked with
  `getChatMember` at intake (the bot is a plain member of that group in
  privacy mode, never an administrator) and sets the limits; nothing
  about it is stored. Members: 5 open reports and 20 per day.
  Non-members: 1 report per day, a global cap of 20 non-member reports
  per day across all non-members (your cards are the scarce resource).
  There are no subscriptions; members read the channel.
- Duplicate detection by a keyed hash of the normalised URL merges a second
  report of the same open target into the first. The acknowledgement is
  identical for new and merged reports, so nobody can probe whether an
  account was already reported.
- A block list keyed by the reporter reference (the Block reporter button
  on the review and status cards, `/block <ref>`, `/unblock <ref>`); a
  rejection counter per reference (3 rejections in 30 days throttle that
  reference to 1 report per day); counters expire after 90 days without
  activity; blocks persist.
- Text-only intake: media and forwarded posts are refused and deleted
  before anything reaches you; every message a reporter sends the bot is
  deleted from the reporter's chat as soon as it is processed, commands
  included (under lockdown the bot reads, stores and deletes nothing).
- No decision notices. The reporter receives one acknowledgement at
  intake, which names the report by platform and date, never echoes the
  URL, says that outcomes appear in the channel, and deletes itself; a
  reporter who used the label "sexual content involving a minor" also
  receives the public hotline links. Nothing follows an approval, a
  rejection, a routing, a closure or a retraction: the bot holds no way to
  reach the reporter, by design, so that nothing in its storage or in a
  seized admin's hands leads back to anyone.

What you do:

1. Reject every report with no visible violation (section 4, step 3).
   Every rejection feeds the throttle on its own.
2. Block a reporter reference when the pattern is deliberate: repeated
   reports against one person or group without violations, a comment that
   is itself harassment or carries someone's data, a visible campaign.
3. Treat a wave of similar reports against one account as a reason to look
   harder at step 3 of the checklist, not as corroboration. The realistic
   abuse case is state-aligned reporters targeting dissidents; a wrong
   approval exposes a victim to the whole channel.
4. Never tell any reporter whether a target was reported before, by whom,
   or what happened; the "previously reported" line exists for you only.
5. Never try to identify a reporter; the reference is all you have, by
   design. A comment can still identify its author by its content; that
   is one more reason it is nulled at your decision and never leaves the
   venue.

## 10. Lockdown: what you see

The keyholder can lock the bot down at any moment (`/lockdown`, the
Lockdown button on an approval notice, or the `LOCKDOWN` secret set with
wrangler); it is the answer to an admin's arrest or a seized admin
account. While it is set:

- every admin action is refused: every button of the review card, the
  routing card and the status card (Approve, Reject, Route, Cancel, Block
  reporter, Taken down, Closed without result, Retract and every step
  between), your replies to the prompts, the correction prompt's included,
  and the commands `/open`, `/block`, `/unblock`, `/card`, `/close`,
  `/retract`, `/stats`, `/budget`, `/attach`, `/repost`, `/halt`,
  `/resume`; you see "This action is refused right now." and nothing else,
  and nothing is written;
- a keyholder's Cancel on an approval notice still works, and so does the
  Lockdown button beside it; under lockdown it edits only the keyholders'
  own chats, never the venue, so the card may still show the approval
  after a keyholder cancelled it: your next press on it, after the
  lockdown is lifted, brings it to the report's real state; a keyholder
  also finds the open reports with `/open` and the counts with `/stats` in
  their own chat;
- intake answers reporters "temporarily unavailable" and stores nothing;
  "I reported it" presses are ignored; no post goes out and no closure
  edit runs; a keyholder's `/retract` still works in their own chat, and
  its edit still runs, since it removes harm, but the status cards in the
  venue are left as they were;
- the nightly retention job still runs (and once at the lockdown itself),
  deleting what is due, without touching the venue; the monthly snapshot
  goes to the keyholders only;
- alerts go to the keyholders by direct message, never to the venue,
  which is assumed compromised;
- only a keyholder's `/unlock` clears it (never `/resume`, never an
  admin), and the `LOCKDOWN` secret is cleared only by the keyholder with
  wrangler.

If you believe an admin account or phone has been taken, tell the
keyholder at once so they can lock down; the review can wait. The
keyholder's side, the emergency wipe included, is in the operations
runbook; the reasons in
[threat-model-seizure.md](../product/threat-model-seizure.md).

## 11. Telegram targets and posts forwarded from bots

The owner's own cases are Telegram channels fed by throwaway public bots.
Full detail, with verification tags, in
[platform-reporting-telegram.md](../reference/platform-reporting-telegram.md).

- What members are told: the post names the channel as code text
  (`@username`, and `post 123` for a specific post), never as a t.me link,
  and tells members to find it through the app's search, report it from
  its profile menu (Report) with "Child Abuse", "Personal Details" or
  "Fake Account" as the post names, also report the specific post, and,
  if the post shows "Forwarded from <bot>", tap the header, open the bot
  and use Report, "Report bot"; and never to press Start on anything. For
  harassment there is no reason in Telegram's static list; the post names
  the closest option or "Other" with a comment, and that mapping is
  unverified until checked on a real device.
- What you do in addition: email abuse@telegram.org with the
  t.me/<channel>/<post> link and the bot's @username (and
  stopCA@telegram.org only from the routing card, section 6).
- The redirect claim: nothing public says a report on a forwarded post is
  redirected to the origin bot. The documented API and the client code
  address the channel; the forward header is not a parameter of the
  report. What the moderators do with the header is undocumented. Treat
  the owner's observation as unverified moderator behaviour; ask members to
  report the channel, the post and the bot, which covers both readings.
- "Forwarded from <bot>" shows that the bot sent the media; it does not
  show who uploaded it to the bot. The header can be absent (forwarded
  without the author, copied, protected content, or a privacy setting);
  then the channel and the post are the targets.
- The bot never forwards or copies anything, and you never receive a post
  through it, only its link; `forwardMessage` and `copyMessage` are tripwire
  patterns in the code base.

## 12. Legal and safety notes for the Iranian context

Not legal advice; the NGO has no counsel, and this section records the
facts the decisions rest on.

- **No state channel.** The owner, verbatim: "we don't have official way
  to contact with the platforms and our government don't care about these
  things." No route in this runbook goes through the state or the police.
  The routes are the platforms' own report paths, the international CSAM
  hotlines, and Telegram's abuse addresses. The INHOPE entry for Iran was
  not verified; the portals that accept reports from anywhere are the
  default.
- **Seizure.** The design assumes your account and your phone can be
  taken and used against the members: "imagine a situation where the
  admins get arrested because of they are defending human rights and then
  use this platform to target or identify users and their real IP", in
  the owner's words. What a seized account can make the bot do is bounded
  in advance (the link policy, the free-text rules, the grace period with
  the keyholder's Cancel), the keyholder can lock the bot down from
  outside the country, and the bot stores nothing that identifies a
  reporter or a member. The threat model:
  [threat-model-seizure.md](../product/threat-model-seizure.md).
- **Personal risk.** You act under your own identity only where a form
  requires it (NCMEC and the IWF: names and contact details optional; X's
  child sexual exploitation form: an email address; Telegram's EU form:
  name and contact details). Use the dedicated account and NGO addresses,
  and decide per case what to disclose. The realistic abuse case is a
  state-aligned reporter trying to turn the members against a dissident;
  the weaponisation step exists for that, and a wrong approval is
  retracted by editing the post (section 8). Account takeover by SIM swap
  and succession are covered in the operations runbook.
- **Opening the material is a crime.** Possessing or viewing child sexual
  abuse material is a criminal offence almost everywhere, including for
  the person who opens it to verify a report. The routing decision is made
  without opening it; so is the hotline report ("unverified member report,
  content not opened").
- **Minimal data.** Everything the bot keeps about a report is deleted at
  closure; the reporter's Telegram id is never stored, only a keyed
  reference; the reporter's messages are deleted from their chat as they
  are processed and the acknowledgement deletes itself; no decision
  message exists. Keep nothing yourself: no screenshots, notes, exports or
  forwards; let auto-delete run in the venue. Data sits on a US provider
  under sanctions risk, which is one more reason nothing personal survives
  closure.
- **VPN.** All review browsing goes over the NGO's usual VPN. You have no
  Cloudflare access; the keyholder reaches the dashboard, through a VPN
  as well.
- **A dedicated Telegram account for admin work**, with 2-step
  verification, never the personal account; the BotFather owner account is
  a separate account again, held by the keyholder outside the country
  (operations runbook).

## 13. Per-report checklist

- [ ] CSAM gate done from the description and non-media context; routed
      if indicated, or if in doubt about the sexual nature
- [ ] Link resolves to the described target
- [ ] Violation visible on the platform's own view (isolated profile, VPN)
- [ ] Weaponisation considered; no visible violation means Reject
- [ ] Final category chosen by me; the reporter's label was a hint
- [ ] Recommended comment: points, own words, at most 300 characters, no
      identities, no leaked data, no link, domain, mention or phone number,
      no promise of removal, no "report again"
- [ ] Link mode per the routing table; affected-person flag respected;
      intimate images never carry the post
- [ ] Approve (30-minute Cancel window; the keyholder sees it too), Reject,
      or Route
- [ ] Nothing saved, screenshotted or forwarded

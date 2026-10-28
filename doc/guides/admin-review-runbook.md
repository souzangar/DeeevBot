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

- A reporter reference (an opaque keyed value), never the reporter's id,
  username or name. You cannot identify the reporter from it and must not
  try; the key that could re-identify it is never exported from the secret
  store.
- The platform, the reporter's category label (a hint only), the reported
  URL or URLs as non-tappable code text whatever their host, the
  reporter's comment as escaped plain text, and the "I am the affected
  person" flag. The comment and the flag exist for your review only; the
  bot nulls both at your decision.
- "Previously reported, outcome X" when the keyed link hash matches an
  earlier aggregate row. This line is on the admin card only; the reporter
  is never told.
- Buttons: Approve, Reject, Route as suspected CSAM, Block reporter. After
  Approve, a Cancel button during the 30-minute grace period, and a status
  card for the report with its id and outcome buttons.
- Intake is text-only. A reporter's message carrying media or a forwarded
  post is refused with a reply and deleted at intake, never stored,
  forwarded or copied; you never receive media through the bot. A reporter
  who wants to point at a post sends its link.
- First decision wins. If both admins act on the same card, exactly one
  decision goes through (a conditional update) and the other admin's card
  is edited to show the outcome. Do not re-decide a card that shows an
  outcome.
- Duplicate reports of the same open target are merged automatically into
  the first report. You decide once per target; no reporter is told
  anything at the decision.

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
   you write no instructions of your own). The bot asks you to confirm the
   category when you press Approve.
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
7. **Pick the link mode** from the routing table (section 5): account
   only, or account and post where the table allows it by your explicit
   opt-in recorded with the approval; never the post for intimate images.
   The affected-person flag forces account only. For a private-data report
   you report the specific post yourself, from the isolated profile, before
   or right after approving.
8. **Approve, and answer the prompts.** Approve asks you to confirm the
   category, to pick the link mode, and to reply to the recommended-comment
   prompt (a force reply; the bot matches your reply by your allowlisted
   id and the prompt it answers, then deletes both). The bot validates the
   rendered post in both languages against Telegram's length limit and the
   link allowlist before it writes anything; a Telegram target is rendered
   as code text, never as a link, and a link whose host is not allowlisted
   is dropped from an "other" post.
9. **The grace period.** Approval starts the 30-minute grace period; the
   card and the status card show Cancel. Cancel returns the report to
   pending and voids the approval record. Every keyholder receives the
   rendered post with a Cancel button and a Lockdown button of their own,
   so someone outside the admins' reach sees each post before it goes out;
   a keyholder's Cancel works like yours. `/halt` holds every post and
   closure edit for every report until `/resume` (operations runbook).
   After the grace period the bot posts once into the channel.
10. **Reject** with the reason code the bot offers (internal, shown to
    nobody). The reporter gets no message. Rejections feed the reporter's
    throttle (3 rejections in 30 days limit that reference to 1 report per
    day).

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

When you press Route as suspected CSAM, the bot replaces the review card
with a routing card, visible only in the review venue. It carries the
reported URL as code text and the routes from
[csam-hotlines.md](../reference/csam-hotlines.md). Work through them in
order, then confirm.

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
4. **Confirm the routing on the card.** The bot then records your admin id
   and the timestamp, nulls the report's URL, account URL and comment at
   once, on the report and on every report merged into it (only the
   aggregate row and the keyed link hash remain), and deletes the card
   from the venue. Neither you nor the bot messages the reporter at
   routing: a reporter who used the label "sexual content involving a
   minor" already received the public hotline links at intake, so they
   can report directly too. The report's status becomes routed; there is
   no closure step for you later.
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
(configurable) the report expires on its own, through the same edit.

1. Check the target in the isolated profile. Do not do this for routed
   reports; they are already closed at routing and you no longer have the
   URL.
2. Run `/close <id> <outcome>` with "taken down" or "closed without
   result", or press the outcome button on the report's status card.
   `/open` lists the open reports with their ids.
3. What the bot does: moves the report to `closing`, then edits the
   channel post to append the outcome line and remove the "I reported it"
   button; only when that edit succeeds does it write `closed` and, in the
   same batch, delete the report's links, comment, texts, approval and
   prompts and keep the aggregate row (category, platform, day-level
   dates, outcome, "I reported it" count, keyed link hash). Nobody is
   messaged, not the reporter and not the members: the edited post is the
   outcome.
4. If the edit cannot be made, the report stays in `closing` with the post
   untouched, the bot sets `needs_attention` and alerts the keyholders
   (and the venue when not locked down). Nothing is finalized while the
   post is unaddressed. `/halt` holds closure edits.

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
   number; the bot refuses the text otherwise). It replaces the post's
   text in the channel.
3. Run `/retract <id>` and reply to the correction prompt. What the bot
   does: writes the correction to the report first, moves it to
   `retracting`, then edits the channel post to the correction and removes
   the button; only when that edit succeeds does it write `retracted` and
   finalize as in section 7; the aggregate row keeps "retracted". `/halt`
   never holds a retraction edit, and a keyholder can run `/retract` even
   under lockdown.
4. A report shown as `posting` with no message id (an ambiguous send: a
   timeout, a network error or a 5xx; the bot never re-sends on its own):
   look in the channel. If the post is there, `/attach <id> <message id or
   t.me/c/... link of the broadcast channel>`; the bot verifies that the
   message is this report's own post before accepting, and then you can
   `/retract`. If it is not there, `/repost <id>` returns the report to
   `approved` and the bot posts at the next tick; `/repost` is admitted
   only while no message id exists and never under lockdown. There is no
   blind "post again".
5. Tell the other admin. If the retraction follows a weaponised report,
   apply section 9 (block the reporter reference).
6. Retraction closes the report; its data is deleted as in section 7.

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
  before anything reaches you; every reporter message is deleted from the
  reporter's chat as soon as it is processed.
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

- every admin action is refused: Approve, Reject, Route, Cancel, Block,
  `/close`, `/retract`, `/repost`, `/halt`, `/resume`; you see a refusal
  and nothing else;
- intake answers reporters "temporarily unavailable" and stores nothing;
  "I reported it" presses are ignored; no post goes out and no closure
  edit runs; a keyholder's retraction edit still runs;
- alerts go to the keyholders by direct message, never to the venue,
  which is assumed compromised;
- only a keyholder's `/unlock` clears it (never `/resume`, never an
  admin), and the `LOCKDOWN` secret is cleared only by the keyholder with
  wrangler.

If you believe an admin account or phone has been taken, tell the
keyholder at once so they can lock down; the review can wait. The
keyholder's side is in the operations runbook; the reasons in
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

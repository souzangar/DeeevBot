---
type: runbook
title: "Admin review runbook"
description: "Step-by-step procedure for reviewing a report: account and workstation isolation, the suspected-CSAM gate, the decision checklist, the per-category routing table, the routing card with its hotline links, closure and retraction, reporter abuse, Telegram posts forwarded from bots, and the legal and safety notes for the Iranian context."
status: active
tags: [runbook, admin, review, moderation, csam, safety, iran]
timestamp: 2026-10-28T00:00:00Z
---

# Admin review runbook

For the one or two allowlisted admins, on every pending report. This
runbook applies the decisions of 2026-10-28 (Q1, Q3, Q6 and Q7 in
[planning-decisions-2026-10-28.md](../product/planning-decisions-2026-10-28.md)).
The bot enforces what can be enforced in code (approval records, link
modes, limits, deletion); this runbook covers what the bot cannot do:
verification, categorisation, routing judgement, and the admin's own
safety. The policy itself lives in the product docs
([report-categories-and-routing.md](../product/report-categories-and-routing.md),
[report-lifecycle.md](../product/report-lifecycle.md),
[review-and-abuse-controls.md](../product/review-and-abuse-controls.md),
[retention-and-minimisation.md](../product/retention-and-minimisation.md));
where this runbook and a product doc disagree, the product doc wins and
this runbook is corrected. Account hardening, succession and the
deployment are in
[operations-and-security.md](./operations-and-security.md).

## 1. Before you start

### 1.1 Your admin account

- [ ] A dedicated Telegram account for admin work, never your personal
      account. 2-step verification (cloud password) enabled, with a
      recovery email. SIM-swap is the realistic takeover path for Iranian
      numbers; see the operations runbook for hardening and succession.
- [ ] Your numeric Telegram id is in the `ADMIN_IDS` allowlist. Usernames
      grant nothing, and membership of the review venue grants nothing: the
      venue's chat id is a venue, never an authority.
- [ ] You know what to do if the account is compromised: tell the other
      admin and the operator at once; the id is removed from `ADMIN_IDS`
      and the deployment updated (operations runbook, incident procedures).

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
  holding `can_delete_messages`, so cards are deleted after the decision at
  any age, and with auto-delete enabled for everything else. If no
  supergroup is configured, cards go to each admin's direct messages;
  there the bot cannot delete older cards (the 48-hour rule in
  [telegram-bot-api-notes.md](../reference/telegram-bot-api-notes.md)), so
  enable auto-delete in your chat with the bot and decide cards promptly.
- The venue is not the NGO's group and not the mirror chat. Nothing about
  a report is posted anywhere else, and nothing from the venue is forwarded
  out of it.

## 2. What a review card shows

- A reporter reference (an opaque keyed value), never the reporter's id,
  username or name. You cannot identify the reporter from it and must not
  try; the key that could re-identify it is never exported from the secret
  store.
- The platform, the reporter's category label (a hint only), the reported
  URL or URLs as code text, the reporter's comment as escaped plain text,
  and the "I am the affected person" flag.
- "Previously reported, outcome X" when the keyed link hash matches an
  earlier aggregate row. This line is on the admin card only; the reporter
  is never told.
- The day's remaining recipient budget.
- Buttons: Approve (with the link mode), Reject, Route as suspected CSAM.
  After Approve, a Cancel button during the 5-minute grace period.
- Intake is text-only. A reporter's message carrying media or a forwarded
  post is refused with a reply and deleted at intake, never stored,
  forwarded or copied; you never receive media through the bot. A reporter
  who wants to point at a post sends its link.
- First decision wins. If both admins act on the same card, exactly one
  decision goes through (a conditional update) and the other admin's card
  is edited to show the outcome. Do not re-decide a card that shows an
  outcome.
- Duplicate reports of the same open target are merged automatically into
  the first report, and every reporter of a merged report gets the decision
  notice. You decide once per target.

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
   consent; impersonation; other (you write the instructions yourself,
   following
   [platform-reporting-other.md](../reference/platform-reporting-other.md)).
6. **Write the recommended comment as points, in your own words.** It is
   what members will say, in their own words, in their one report: the
   kind of violation, who is targeted in general terms (a private person,
   a child, a dissident), what the account does. Never: the reporter's
   identity or comment, names or data of the people involved beyond what
   the allowed link itself carries, any leaked data, any promise of
   removal, any request to report repeatedly. Use the platform page's
   "What the bot's instructions say" block as the frame
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
8. **Check the budget.** The card shows the day's remaining recipient
   budget. The bot never exceeds it; if the subscribers do not fit, the
   direct-message fan-out waits (operations runbook, quota section). Decide
   whether the report can wait or whether the mirror post and a partial
   fan-out serve for now.
9. **Approve.** The 5-minute grace period starts and the card shows Cancel.
   Cancel returns the report to pending and voids the approval record.
   `/halt` pauses all sending for every broadcast (operations runbook).
   After the grace period the mirror post goes out first, then the
   direct-message fan-out, paced.
10. **Reject** with the reason the bot offers. The reporter gets a neutral
    decision notice. Rejections feed the reporter's throttle (3 rejections
    in 30 days limit that reference to 1 report per day).

## 5. Per-category routing table

The authoritative table is
[report-categories-and-routing.md](../product/report-categories-and-routing.md);
this copy is for use at the keyboard.

| Category (your decision at step 5) | Broadcast? | Links the broadcast carries | Instruction block | Notes |
|---|---|---|---|---|
| Private data (doxxing) | yes | account link by default; the post URL only by your explicit opt-in recorded with the approval, when you judge it necessary and safe; the affected-person flag forces account only | platform page, "Private information" (key `private-information`) | you report the specific post yourself; the affected person is told to file the platform's first-person report |
| Child safety: non-sexual abuse, exploitation, grooming | yes | account link by default; the post URL by your opt-in at step 7 | platform page, "Child safety, non-sexual" (key `child-safety`) | a child's public photo with insults belongs here or under harassment; doubt about the sexual nature routes (section 3) |
| Suspected child sexual abuse material | never | none; routed from your card | none, by design (card key `csam-routing`) | section 6; nothing reaches subscribers, the mirror chat or anyone else |
| Bullying and harassment (incl. public images with abusive text) | yes | account link by default; the post URL by your opt-in at step 7 | platform page, "Bullying and harassment" (key `harassment`) | where the platform wants to hear from the targeted person, the instructions say so |
| Intimate images shared without consent | yes | account only, never the post URL (a routing rule, not a default) | platform page, "Intimate images shared without consent" (key `intimate-images`) | the affected person files the first-person report |
| Impersonation | yes | account link by default; the post URL by your opt-in at step 7 | platform page, "Impersonation" (key `impersonation`) | the account is the target |
| Other | yes | account link by default; the post URL by your opt-in at step 7 | written by you, per platform-reporting-other.md | no reason label you did not see yourself |

For a Telegram target the "account" is the channel (and the bot the post
was forwarded from, when the header shows one); see section 10.

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
   enforcement agency"; what you disclose is your decision, with section 11
   in mind.
3. **Telegram-hosted target: also email stopCA@telegram.org** with the
   t.me link and, when the post shows "Forwarded from <bot>", the bot's
   @username. Use an NGO address, not a personal one.
4. **Confirm the routing on the card.** The bot then records your admin id
   and the timestamp, deletes the report's URL and comment at once (only
   the aggregate row and the keyed link hash remain), deletes the card from
   the venue, and sends the reporter a neutral acknowledgement carrying the
   public hotline links so they can report directly too. The report's
   status becomes routed; there is no closure step for you later.
5. **Nothing else, ever.** Not to subscribers, not to the mirror chat, not
   to the other admin's direct messages, not to the NGO's group, not to a
   contact in law enforcement or another NGO. INHOPE: "never share links or
   files with anyone outside the official reporting channels. Sharing is
   illegal and can further harm the child." Forwarding to alert someone is
   still distribution (the IWF case in csam-hotlines.md).

## 7. Closure

When to close: the reported account or content is gone ("taken down"),
nothing happened after a reasonable time ("closed without result"), or
the broadcast was wrong ("retracted", section 8). Ninety days after the
broadcast (configurable) the report expires on its own.

1. Check the target in the isolated profile. Do not do this for routed
   reports; they are already closed at routing and you no longer have the
   URL.
2. Run the closure command on the report with the outcome: taken down, or
   closed without result.
3. What the bot does: sends the outcome by direct message only to the
   users who pressed "I reported it" on that report and are still
   subscribed at send time (a press made from the mirror chat earns no
   direct message; the mirror post is edited to show the outcome); deletes
   the report's links, comment, broadcast text, admin notes, delivery
   ledger and "I reported it" marks; keeps the aggregate row (category,
   platform, day-level dates, outcome, recipients count, "I reported it"
   count, keyed link hash).
4. Notices queue behind a running broadcast (one at a time), so closure
   notices can take up to an hour to go out.

## 8. Retraction

When to retract: the approval was wrong (the reported account was the
victim, the category was wrong in a way that harms, the link pointed at
the wrong target), or the owner asks. The harm grows with every member who
acts on a wrong broadcast, so decide fast.

1. If the report is still in its grace period: press Cancel; the report
   returns to pending and the approval record is voided. If it is
   broadcasting: `/halt`, then retract.
2. Write the correction text: neutral, no blame, no identity of anyone,
   no leaked data. It replaces the broadcast message for every recipient
   who still has it.
3. Run the retraction command on the report. What the bot does: edits
   every delivered message in place to the correction text (no age limit
   for the bot's own messages), deletes instead where the message is
   younger than 48 hours, edits the mirror post, and marks the report
   retracted; the aggregate row keeps "retracted". Notices queue behind a
   running broadcast, so a retraction completes within the hour, not at
   once.
4. Tell the other admin. If the retraction follows a weaponised report,
   apply section 9 (block the reporter reference).
5. Retraction closes the report; its data is deleted as in section 7.

## 9. Reporter abuse handling

What the bot enforces (you see the effects; you do not operate them):

- Anyone may submit. Membership of the NGO's group is checked with
  `getChatMember` at subscription and at intake (the bot is a plain member
  of that group in privacy mode, never an administrator). Members: 5 open
  reports and 20 per day. Non-members: 1 report per day, a global cap of
  20 non-member reports per day across all non-members (your cards are the
  scarce resource), and no direct-message subscription.
- Duplicate detection by a keyed hash of the normalised URL merges a second
  report of the same open target into the first. The acknowledgement is
  identical for new and merged reports, so nobody can probe whether an
  account was already reported.
- A block list keyed by the reporter reference; a rejection counter per
  reference (3 rejections in 30 days throttle that reference to 1 report
  per day); counters expire after 90 days without activity; blocks
  persist.
- Text-only intake: media and forwarded posts are refused and deleted
  before anything reaches you.

What you do:

1. Reject every report with no visible violation (section 4, step 3).
   Every rejection feeds the throttle on its own.
2. Block a reporter reference when the pattern is deliberate: repeated
   reports against one person or group without violations, a comment that
   is itself harassment or carries someone's data, a visible campaign.
3. Treat a wave of similar reports against one account as a reason to look
   harder at step 3 of the checklist, not as corroboration. The realistic
   abuse case is state-aligned reporters targeting dissidents; a wrong
   approval exposes a victim to the whole user base.
4. Never tell any reporter whether a target was reported before, by whom,
   or what happened; the "previously reported" line exists for you only.
5. Never try to identify a reporter; the reference is all you have, by
   design.

## 10. Telegram targets and posts forwarded from bots

The owner's own cases are Telegram channels fed by throwaway public bots.
Full detail, with verification tags, in
[platform-reporting-telegram.md](../reference/platform-reporting-telegram.md).

- What members are told: report the channel from its profile menu
  (Report) with "Child Abuse", "Personal Details" or "Fake Account" as the
  broadcast names; also report the specific post; if the post shows
  "Forwarded from <bot>", tap the header, open the bot and use Report,
  "Report bot". For harassment there is no reason in Telegram's static
  list; the broadcast names the closest option or "Other" with a comment,
  and that mapping is unverified until checked on a real device.
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

## 11. Legal and safety notes for the Iranian context

Not legal advice; the NGO has no counsel, and this section records the
facts the decisions rest on.

- **No state channel.** The owner, verbatim: "we don't have official way
  to contact with the platforms and our government don't care about these
  things." No route in this runbook goes through the state or the police.
  The routes are the platforms' own report paths, the international CSAM
  hotlines, and Telegram's abuse addresses. The INHOPE entry for Iran was
  not verified; the portals that accept reports from anywhere are the
  default.
- **Personal risk.** You act under your own identity only where a form
  requires it (NCMEC and the IWF: names and contact details optional; X's
  child sexual exploitation form: an email address; Telegram's EU form:
  name and contact details). Use the dedicated account and NGO addresses,
  and decide per case what to disclose. The realistic abuse case is a
  state-aligned reporter trying to turn the user base against a dissident;
  the weaponisation step exists for that, and a wrong approval is
  retracted within the hour. Account takeover by SIM swap and succession
  are covered in the operations runbook.
- **Opening the material is a crime.** Possessing or viewing child sexual
  abuse material is a criminal offence almost everywhere, including for
  the person who opens it to verify a report. The routing decision is made
  without opening it; so is the hotline report ("unverified member report,
  content not opened").
- **Minimal data.** Everything the bot keeps about a report is deleted at
  closure; the reporter's id is replaced by a keyed reference as soon as
  the decision notice is delivered; the reporter's intake message is
  deleted from their chat and `/start` says so. Keep nothing yourself: no
  screenshots, notes, exports or forwards; let auto-delete run in the
  venue. Data sits on a US provider under sanctions risk, which is one
  more reason nothing personal survives closure.
- **VPN.** All review browsing goes over the NGO's usual VPN, and the
  Cloudflare dashboard is reached the same way.
- **A dedicated Telegram account for admin work**, with 2-step
  verification, never the personal account; the BotFather owner account is
  a separate account again, on a non-Iranian number where possible
  (operations runbook).

## 12. Per-report checklist

- [ ] CSAM gate done from the description and non-media context; routed
      if indicated, or if in doubt about the sexual nature
- [ ] Link resolves to the described target
- [ ] Violation visible on the platform's own view (isolated profile, VPN)
- [ ] Weaponisation considered; no visible violation means Reject
- [ ] Final category chosen by me; the reporter's label was a hint
- [ ] Recommended comment: points, own words, no identities, no leaked
      data, no promise of removal, no "report again"
- [ ] Link mode per the routing table; affected-person flag respected;
      intimate images never carry the post
- [ ] Budget checked
- [ ] Approve (5-minute Cancel window), Reject, or Route
- [ ] Nothing saved, screenshotted or forwarded

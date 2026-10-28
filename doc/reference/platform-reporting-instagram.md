---
type: reference
title: "Platform reporting: Instagram"
description: "How to report child sexual exploitation, private information, bullying and impersonation on Instagram, Meta's documented posture on report volume and false reports, and the points the bot's broadcast instructions make."
status: active
tags: [reference, platform, instagram, meta, reporting]
timestamp: 2026-10-28T00:00:00Z
---

# Platform reporting: Instagram

This page is the English source for the Instagram instructions the bot
quotes in a broadcast, and the admins' lookup page when they file their own
report. It was compiled on 2026-10-28 from the research note of that date.
Every URL below was fetched or rendered on 2026-10-28 unless it is tagged
[S] or marked "not fetched". Policy text is quoted exactly as the research
note quotes it; nothing here has been re-verified since. The project's own
routing decisions are in
[report-categories-and-routing.md](../product/report-categories-and-routing.md);
this page records what Instagram documents.

How to read the tags: [H] raw HTTP fetch, text read verbatim; [R] public
page rendered in a headless browser without login, text read verbatim;
[W] read only through a summarising fetch tool, needs confirmation before
it is relied on; [P] PDF converted to text; [G] source code fetched from
GitHub; [S] seen only in a search result, not read; [INF] the researcher's
inference, not a platform statement. The same legend applies to every
`platform-reporting-*.md` page and to [csam-hotlines.md](./csam-hotlines.md).

## How to report

### The in-app path (any category)

- "Report a post or profile on Instagram" [R] https://help.instagram.com/192435014247952:
  "If you have an Instagram account, you can report a profile or content on
  Instagram that doesn't follow our Community Standards." The documented
  steps are Options on the post (or Options next to the username on a
  profile), then Report, then follow the prompts. The post reasons the page
  lists are "I just don't like it", "Bullying or unwanted contact",
  "Suicide, self-injury or eating disorders", "Violence, hate or
  exploitation", "Selling or promoting restricted items", "Nudity or sexual
  activity", "Scam, fraud or spam", "False information" and "Intellectual
  property". A profile can be reported "for posting content it shouldn't
  be, pretending to be someone else, or for being a child under the age of
  13".
- Anonymity, same page: "Keep in mind that your report is anonymous, except
  if you're reporting an intellectual property infringement. The account
  you reported won't see who reported them."
- Hub of report types, "Report content on Instagram" [R]
  https://help.instagram.com/2922067214679225, lists harassment or bullying,
  impersonation, threats to share private images or personal info, sexually
  exploitative images of children, a user under the minimum age, and sex
  offenders.
- Without an account, or when blocked by the account [R]
  https://help.instagram.com/967386582228551: ask a friend to report.
  Instagram adds: "we won't be able to take action on your report until we
  can find the content you're reporting. In your report, please provide us
  with as much detail as possible, including links and screenshots of the
  content you're reporting."
- After a report [R] https://help.instagram.com/478796623912131: "we will
  take action to hide or remove that content from Instagram if we find that
  it goes against our Community Guidelines." If the content is not removed
  [R] https://help.instagram.com/861685284411197: the reporter may "Request
  review", reviewed "usually within 24 hours"; a second upheld decision may
  go to the Oversight Board.

### Child sexual exploitation

Project rule first: this category is never broadcast (critical invariant 7).
The admin files one report through the in-app path from the routing card,
plus one hotline report; see [csam-hotlines.md](./csam-hotlines.md) and the
[admin review runbook](../guides/admin-review-runbook.md). What follows is
what Instagram documents.

- No dedicated public web form was found for the rest of the world.
- Help article [R] https://help.instagram.com/423234141135444: "Posting,
  sharing or downloading images that sexually exploit children for any
  reason can be criminal. We report all apparent child pornography to the
  National Center for Missing and Exploited Children." Its steps: "Don't
  share it or comment on it." / "Report it to us by using the built-in
  reporting options." / "Notify the National Center for Missing & Exploited
  Children using the CyberTipline." / "Important: Never download or save
  this content for any reason. You will not be asked to provide a copy of
  the image or video in any report."
- A second article, https://help.instagram.com/887610179483853 [R],
  answered "This content isn't available in your region." from the
  researcher's European IP.
- Meta hub "How to report child sexual exploitation, abuse and nudity
  content" [R] https://www.meta.com/help/policies/1035211502617243/: "If you
  believe that a child is in immediate danger, call 999 or contact your
  local law enforcement agency immediately." (the emergency number is
  localised to the viewer's region); the page links to each app's "Report
  content" page.
- A California-only form exists [W]
  https://help.instagram.com/contact/1141853830778488 ("Reporting specific
  harms in California"); read only through the summarising tool.

### Private information (doxxing)

- "Exposed Private Information" [R] https://help.instagram.com/122717417885747:
  "Posting private and confidential information is a violation of our
  Terms of Use."
- Image-privacy form [R] https://help.instagram.com/contact/512241091300432,
  titled "Report a Violation of your Privacy on Instagram or Threads" (the
  same title appears under [W]
  https://help.instagram.com/contact/1024543072377373). The form needs the
  URL, and "we require minors 13 years or older to submit the request
  through this form themselves."
- First-person requirement, same form: "Photos or videos involving anyone
  else will need to be reported by the individual themselves." and "we can
  only take action on private information if it's associated with the
  person reporting it or we receive documentation that the reporter is
  authorized to act on behalf of the person whose private information has
  been posted."
- Consequence for the project (decision Q2 of 2026-10-28): a third party's
  report goes through the in-app Report path; the affected person is told to
  file the first-person form; the broadcast never promises removal.

### Bullying and harassment

- "Reporting harassment or bullying on Instagram" [R]
  https://help.instagram.com/547601325292351: use the report link near the
  content, then consider blocking. Meta page "Report bullying and
  harassment" [R] https://www.meta.com/help/policies/630029231963649/.
- In-app reason: "Bullying or unwanted contact".

### Impersonation

- "Report an account for impersonation" [R]
  https://help.instagram.com/1291391774792379: in the app, Options, Report,
  Report Account, "It's pretending to be someone else". "If you're being
  impersonated on Instagram but don't have an Instagram account, you can
  fill out this form" (https://help.instagram.com/contact/636276399721841,
  linked on that page, not fetched). Hub [R]
  https://help.instagram.com/446663175382270.

## Policy pages

- Community Guidelines, help.instagram.com/477434105621119 [R], has the
  canonical https://transparency.meta.com/policies/community-standards/
  (the Community Standards for "Facebook, Instagram, Messenger and
  Threads"). The sections used, all [R], with the latest change-log date
  seen on 2026-10-28:
  - Child Sexual Exploitation, Abuse, and Nudity,
    https://transparency.meta.com/policies/community-standards/child-sexual-exploitation-abuse-nudity/
    (Jul 31, 2025). Rationale: "When we become aware of apparent child
    exploitation, we report it to the National Center for Missing and
    Exploited Children (NCMEC), in compliance with applicable law." Also:
    "We may remove imagery depicting the aftermath of non-sexual child
    abuse when reported by news media partners, NGOs, or other trusted
    safety partners." and "We may remove content created for the purpose of
    identifying a private minor if there is a risk to the minor's safety,
    when requested by Law Enforcement, Government, Trusted Partner, or the
    content is self-reported by the minor or the minor's parent/legal
    guardian".
  - Bullying and Harassment,
    https://transparency.meta.com/policies/community-standards/bullying-harassment/
    (Sep 23, 2026).
  - Privacy Violations,
    https://transparency.meta.com/policies/community-standards/privacy-violations-image-privacy-rights/
    (Apr 30, 2026). Rationale: "We remove content that shares, offers, or
    solicits personally identifiable information or other private
    information that could lead to physical or financial harm, including
    financial, residential, and medical information".
  - Authentic Identity Representation (impersonation),
    https://transparency.meta.com/policies/community-standards/authentic-identity-representation/
    (Sep 11, 2026).
  - Inauthentic Behavior,
    https://transparency.meta.com/policies/community-standards/inauthentic-behavior/
    (Dec 11, 2025).
  - Also Additional Protection of Minors (`.../additional-protection-minors/`)
    and User Requests (`.../user-requests/`) under the same root.
- Terms of Use [R] https://help.instagram.com/581066165581870 (effective
  1 January 2025; the page announces updated terms effective January 20,
  2027, which were not read).
- Review prioritisation [R]
  https://transparency.meta.com/policies/improving/prioritizing-content-review/
  (updated Nov 12, 2024) names three factors: "SEVERITY", "VIRALITY",
  "LIKELIHOOD OF VIOLATING".

## Posture on volume, duplicates and false reports

- Report count: no Instagram help page read states whether the number of
  reports matters. Third-party sites claim an Instagram sentence to that
  effect; it is unconfirmed (see Unverified). Facebook's own sentence is on
  [platform-reporting-facebook.md](./platform-reporting-facebook.md).
- Misuse of reporting, Terms of Use: "You can't do anything to interfere
  with or impair the intended operation of the Service. This includes
  misusing any reporting, dispute, or appeals channel, such as by making
  fraudulent or groundless reports or appeals."
- Community Standards, Inauthentic Behavior, lead-in "We do not allow: The
  creation, use, or claimed use of Inauthentic Meta Assets (Accounts, Pages,
  Groups, etc.) in order to:" followed by three list items: "Deceive Meta
  or our users about the identity, or origin of an audience or the entity
  that they represent", "To Evade enforcement under the Community
  Standards." and "Misuse Meta reporting systems to harass, intimidate or
  silence others."
- EU DSA transparency report for Instagram, 29 Aug 2025 [P]
  https://transparency.meta.com/sr/dsa-transparency-report-aug2025-instagram:
  "All Article 16 DSA notices are processed using manual review. Instances
  of duplicate submissions are handled by applying the original manual
  decision, to avoid conflicting decisions." That is reuse of one decision,
  not discarding, and it concerns DSA notices only; deduplication of in-app
  reports is undocumented. On frequent unfounded notices: "In line with
  Article 23(2) DSA, we may suspend the processing of notices and complaints
  submitted through our notice and complaints mechanisms, for a limited
  period of time, where individuals and entities have, after being warned,
  frequently submitted notices and complaints that are manifestly
  unfounded. We do not have any volumes to report for this reporting
  period". Median time to act: 29.0 hours for Article 16 notices, 10.3
  hours for trusted-flagger notices.
- No sanction table exists. The words "brigading", "report bombing" and
  "mass reporting" appear on none of the Meta pages read; the closest
  wording is "fraudulent or groundless reports".
- Trusted Partner programme and DSA trusted flaggers: see
  [trusted-flagger-programmes.md](./trusted-flagger-programmes.md).
- [INF] A broadcast asking every subscriber to file a report is not
  forbidden by any Meta text read; what is forbidden is fraudulent or
  groundless reporting and reporting through inauthentic accounts. Nothing
  documented makes a reported item faster to review because more people
  report it.

## What the bot's instructions say

The points below are what a member makes, in their own words, in one
Instagram report. They are the English source for the i18n catalogs (the
Persian copy is written from them later). They apply the decision of
2026-10-28 (Q7): one genuine report per member, no template text to paste,
no promise of removal, and first-person reporting by the affected person
where Instagram requires it.

Common frame, every category:

- Report once, from your own account, through the Report option on the
  post or profile the broadcast names. Do not report the same item again
  and do not use a second account to report.
- Choose the reason that matches what you see, and say in your own words
  what the account or post does.
- Do not repeat anyone's private data in your report, do not download or
  re-share the content, and do not engage with the account.
- Instagram reviews against its Community Standards; it says it will hide
  or remove content "if we find that it goes against our Community
  Guidelines", and it may not tell you the outcome. The broadcast never
  promises removal.

Private information (doxxing):

- Routing (decision Q2): the broadcast carries the account link by default
  and the admins have reported the specific post themselves; the post URL
  appears only by the admin's recorded opt-in, and never when the reporter
  is the affected person.
- Report the account (Options next to the username, Report) and pick the
  reason about private information; the hub names "threats to share
  private images or personal info", and the exact label in the live menu
  was not verified.
- Points to make: the account publishes a private person's personal
  information (say which kind: home address, phone number, identity
  documents, workplace, family members) without consent; this is the kind
  of information Meta's standard says "could lead to physical or financial
  harm"; mention if it is part of a campaign against the person.
- If you are the person affected: file the privacy form yourself
  (https://help.instagram.com/contact/512241091300432). Instagram acts on
  private information only when it is "associated with the person reporting
  it" or when the reporter is documented as authorised.

Bullying and harassment (including a person's public image posted with
abusive text):

- Reason: "Bullying or unwanted contact".
- Points to make: who is targeted (a private person, a child), what the
  post does (degrading remarks, threats, a photo posted to mock or shame
  the person), and whether it is repeated.
- If the image is of you: also file the privacy form (first-person).

Impersonation:

- Report Account, then "It's pretending to be someone else".
- Points to make: whom the account imitates (name, photos, bio) and what it
  does with the identity (scam, harassment, defamation).
- The impersonated person without an Instagram account uses the form
  Instagram links for that case (not fetched; see above).

Child safety, non-sexual (abuse, exploitation, grooming):

- The in-app reason list includes "Violence, hate or exploitation"; mapping
  non-sexual child abuse to that reason is an inference [INF]. Meta's
  child-safety standard also covers imagery of the aftermath of non-sexual
  child abuse and content identifying a private minor (quoted above).
- Points to make: that the person is a child, what the post does, and why
  it endangers the child. Do not name the child.
- If what you see turns out to be sexual: do not interact with it, do not
  forward it to anyone, report it through Instagram's built-in reporting as
  child sexual exploitation, and report it once to a hotline listed in
  [csam-hotlines.md](./csam-hotlines.md).

Intimate images shared without consent:

- Routing: never the post URL; the broadcast carries the account link.
- Members report the account; the affected person files the privacy form
  (first-person).

Suspected child sexual abuse material: never broadcast. No member
instruction exists for this category by design; the admin's routing card is
described in the runbook.

## Unverified

Items from the research note's "Unverified" section that concern this page:

- An official Instagram sentence that report count does not decide removal
  was not found (only Facebook's). Third-party sites claim one.
- https://help.instagram.com/887610179483853 was region-restricted ("This
  content isn't available in your region."). Instagram's non-user
  impersonation form (https://help.instagram.com/contact/636276399721841)
  and the updated Terms of Use effective January 20, 2027 were not opened.
  Forms 1024543072377373 and 1141853830778488 were read through the
  summarising tool only [W]; the first also appears in rendered form as
  512241091300432.
- How an NGO becomes a Meta Trusted Partner and where the dedicated channel
  lives: no public route found.
- Whether Meta deduplicates in-app (non-DSA) reports; the DSA sentence
  covers Article 16 notices only.
- The live in-app reason labels for private information and child safety
  were not observed on a logged-in client; the mappings marked [INF] above
  need a check on a real device before the Persian copy is written.

---
type: reference
title: "Platform reporting: TikTok"
description: "How to report child sexual exploitation, personal information, bullying and impersonation on TikTok, TikTok's documented posture on unfounded reports, and the points the bot's broadcast instructions make."
status: active
tags: [reference, platform, tiktok, reporting]
timestamp: 2026-10-28T00:00:00Z
---

# Platform reporting: TikTok

This page is the English source for the TikTok instructions the bot quotes
in a broadcast, and the admins' lookup page when they file their own
report. It was compiled on 2026-10-28 from the research note of that date.
Every URL below was fetched or rendered on 2026-10-28 unless it is tagged
[S] or marked "not fetched". Policy text is quoted exactly as the research
note quotes it. The project's own routing decisions are in
[report-categories-and-routing.md](../product/report-categories-and-routing.md);
this page records what TikTok documents.

How to read the tags: [H] raw HTTP fetch, text read verbatim; [R] public
page rendered in a headless browser without login, text read verbatim;
[W] read only through a summarising fetch tool, needs confirmation; [P] PDF
converted to text; [G] source code fetched from GitHub; [S] seen only in a
search result, not read; [INF] the researcher's inference, not a platform
statement.

## How to report

### The in-app path and the web forms (any category)

- The Help Center index [R] https://support.tiktok.com/en/safety-hc/report-a-problem
  lists what can be reported: a post, an account, a LIVE, a direct message,
  an underage account, an impersonation account, a comment, a LIVE comment,
  a suggested search, a hashtag, a sound, a TikTok Sticker, a Series,
  another issue, a technical problem.
- A post [R] https://support.tiktok.com/en/safety-hc/report-a-problem/report-a-video.
  In the app: "Go to the post and tap the Share button, or press and hold
  the post.", then "Tap Report and select a reason. If prompted, select a
  subtopic.", then "Tap Submit." On the web: "Go to the video and hover
  over the More options ... button at the top.", then "Click Report and
  select a reason. If prompted, select a subtopic.", then "Click Submit."
- An account [R] https://support.tiktok.com/en/safety-hc/report-a-problem/report-a-user:
  open the profile, Share, Report, Report account, then the reason. For
  impersonating accounts the page links two web forms: "Accounts in the
  USA" https://www.tiktok.com/legal/report/submit-requests and "Accounts
  outside the USA" https://www.tiktok.com/legal/report/feedback; the second
  is also the "online reporting form" named in the help FAQ [R]
  https://www.tiktok.com/support/faq_detail?id=7581820702655978040.
- Who may report, and anonymity: "Anyone can report illegal content. It
  does not need to be about you or someone you know." (the illegal-content
  page below); "Anyone can report an account they believe belongs to
  someone who’s too young to have an account—either in the app or online."
  (the youth-safety guideline; "online" links
  https://www.tiktok.com/legal/report/privacy); "TikTok will not disclose
  your identity to the person you report." [R]
  https://www.tiktok.com/safety/en/tools-and-guides/reporting. Report
  status is shown under Settings > Support > Safety Center > Report
  records.
- EEA illegal-content route [R]
  https://www.tiktok.com/legal/page/global/reporting-illegal-content/en:
  "Select Report and then select Report illegal content from the list".

### Child sexual exploitation

Project rule first: this category is never broadcast (critical invariant 7).
The admin files one report from the routing card, plus one hotline report;
see [csam-hotlines.md](./csam-hotlines.md) and the
[admin review runbook](../guides/admin-review-runbook.md). What follows is
what TikTok documents.

- In-app category: "Exploitation and abuse of people under 18" under
  "Violence, abuse, and criminal exploitation". Safety Center [R]
  https://www.tiktok.com/safety/en/policies-and-engagement/combating-csea:
  "We make it easy to report suspected CSEA by adding the option to choose
  'Exploitation and abuse of people under 18' under the "Violence, abuse,
  and criminal exploitation" category of reporting."
- Community Guidelines [R] https://www.tiktok.com/community-guidelines/en/safety-civility:
  "If you ever come across suspected CSAM, report it immediately in the app
  or on our website. Never download, record, or share this kind of
  content."
- EEA route, category "Child sexual exploitation": "If you encounter this
  type of illegal content, do not download, save, comment on, share or
  interact with this content. Please report it via our illegal content
  reporting channels. Additionally, you can report to a trusted
  organisation or your local law enforcement." The page links INHOPE
  (https://www.inhope.org/EN#hotlineReferral), the IWF
  (https://report.iwf.org.uk/en) and NCMEC (https://report.cybertip.org/).
- No CSAM-specific web form was found: the in-app category plus the generic
  online forms only.

### Personal information (doxxing)

- Community Guidelines "Personal Information" [R]
  https://www.tiktok.com/community-guidelines/en/privacy-security: "we
  don't allow content with personal information that could lead to
  stalking, identity theft, fraud, or other harm". The page says "If you
  think your privacy has been violated, you can report it here", linking
  the web Privacy portal [R] https://www.tiktok.com/legal/report/privacy.
- EEA category "Illegal privacy-related violations" asks the reporter to
  identify the personal data, the person, and whether the sharer had
  consent.
- No first-person requirement for third-party reports was found on the
  pages read ("Anyone can report illegal content", above). Whether the
  privacy portal accepts a report filed by someone other than the affected
  person was not verified [INF].

### Bullying and harassment

- Community Guidelines "Harassment and Bullying" (on the safety-civility
  page); the guidelines' overview describes the policy as covering
  "...including degrading remarks about appearance, doxing, sexual
  harassment, or coordinated abuse".
- Privacy portal option: "I am being bullied or harassed on TikTok".
- EEA category "Harassment or threats" asks the reporter to show
  persistence: "it is not a one-off".

### Impersonation

- [R] https://support.tiktok.com/en/safety-hc/report-a-problem/report-an-impersonation-account:
  open the profile, Share (or More options), Report, Report account,
  "Pretending to Be Someone", then "Me" or "Celebrity".
- Web forms: the U.S. form asks for "valid identification" and an
  electronic signature; outside the U.S. the form
  https://www.tiktok.com/legal/report/feedback (Topic "Report a potential
  violation", Category "Account violation", Reason "Impersonation").
- Privacy portal option: "Someone is pretending to be me on TikTok".

## Policy pages

All [R]:

- Community Guidelines https://www.tiktok.com/community-guidelines/en
  (released August 25, 2026; effective September 24, 2026). Sections used:
  "Youth Sexual and Physical Abuse" and "Harassment and Bullying"
  (https://www.tiktok.com/community-guidelines/en/safety-civility),
  "Personal Information"
  (https://www.tiktok.com/community-guidelines/en/privacy-security),
  "Deceptive Behavior & Fake Engagement"
  (https://www.tiktok.com/community-guidelines/en/integrity-authenticity),
  and https://www.tiktok.com/community-guidelines/en/youth-safety.
- Safety Center, "Combating child sexual exploitation and abuse"
  https://www.tiktok.com/safety/en/policies-and-engagement/combating-csea:
  "we submit detailed information to the National Center for Missing and
  Exploited Children (NCMEC)'s CyberTipline"; hash lists from NCMEC and the
  IWF; the IWF URL database.
- Safety Center reporting guide
  https://www.tiktok.com/safety/en/tools-and-guides/reporting.
- Reporting illegal content (EEA)
  https://www.tiktok.com/legal/page/global/reporting-illegal-content/en.
- Terms of Service, EEA, UK and Switzerland
  https://www.tiktok.com/legal/page/eea/terms-of-service/en (Last updated:
  July 2026); rest of world
  https://www.tiktok.com/legal/page/row/terms-of-service/en.

## Posture on volume, duplicates and false reports

- Report count and duplicates: nothing documented. The documented review
  model (Safety Center reporting guide): "If a report is submitted, we'll
  review the reported content to check if it violates our policies. If it
  does, we'll take action against it, including removal." and "our
  automated moderation systems may send posts with a high number of views
  to our moderators for further review".
- Illegal-content reports (EEA page): "Reporting content as illegal may
  have serious consequences. When you report content as illegal, you must
  be specific and provide supporting evidence to allow us to make an
  informed decision. If the report does not contain enough information for
  TikTok to clearly assess whether the content is illegal, we will reject
  the report."
- Terms of Service (EEA, UK and Switzerland), section 4.5 "What you can't
  do on the Platform": "you must not use the Platform to: ... submit
  appeals, reports, notices or complaints which are clearly unfounded;" and
  section 6.2: "We might temporarily suspend, permanently restrict or
  terminate your account, or impose limits on, or restrict your access to
  features of the Platform if: we determine that you are in material or
  repeated breach of these Terms or our Community Guidelines". The
  rest-of-world terms contain no such clause (searched for "unfounded",
  "false report" and "bad faith"); the US terms were not checked.
- DSA transparency report, January to June 2025 [P] (the PDF linked from
  https://www.tiktok.com/safety/en/transparency/dsa-transparency):
  "Separate to the rejection of incomplete or materially unsubstantiated
  illegal content reports, TikTok did not suspend the processing of illegal
  content reports or complaints due to individuals frequently submitting
  manifestly unfounded notices or manifestly unfounded complaints."
- Community Partner Channel Program (Safety Center combating-csea page):
  "Through our Community Partner Channel Program, participating safety and
  civil society organizations with a broad range of expertise across
  content safety and youth safety issues can report potentially violative
  content to us directly for review." How an organisation applies is not
  documented; see
  [trusted-flagger-programmes.md](./trusted-flagger-programmes.md).
- [INF] Nothing documented makes a reported item faster to review because
  more people report it. What is forbidden in the EEA terms is "clearly
  unfounded" reporting, and a thin illegal-content report is rejected. One
  genuine, specific report per member is the documented-safe pattern.

## What the bot's instructions say

The points below are what a member makes, in their own words, in one
TikTok report. They are the English source for the i18n catalogs (the
Persian copy, written from them, is a draft awaiting a native speaker's
review). They apply the decision of 2026-10-28 (Q7): one genuine report
per member, no template text to paste, no promise of removal, and
first-person reporting by the affected person where TikTok offers a
first-person route.

Common frame, every category:

- Report once, from your own account: on a post, Share (or press and
  hold), Report, the reason and, if prompted, a subtopic, then Submit; on
  an account, the profile's Share, Report, Report account, then the
  reason. Do not report the same item again and do not use a second
  account to report.
- Choose the reason that matches what you see, and when a form asks for
  details, be specific in your own words; TikTok rejects an illegal-content
  report that "does not contain enough information".
- Do not repeat anyone's private data in your report, do not download or
  re-share the content, and do not engage with the account.
- TikTok says it reviews a reported item against its policies and acts
  "if it does" violate them; the broadcast never promises removal. TikTok
  does not disclose your identity to the person you report, and you can
  follow the status under Settings > Support > Safety Center > Report
  records.

Personal information (doxxing):

- Routing (decision Q2): the broadcast carries the account link by default
  and the admins have reported the specific post themselves; the post URL
  appears only by the admin's recorded opt-in, and never when the reporter
  is the affected person.
- Report the account and choose the reason about personal information; the
  exact label in the live menu was not verified.
- Points to make: the account posts a private person's personal
  information (say which kind: home address, phone number, identity
  documents, workplace, family members) without consent; TikTok's rule is
  against information "that could lead to stalking, identity theft, fraud,
  or other harm"; mention if it is part of a campaign against the person.
- If you are the person affected: use the Privacy portal
  (https://www.tiktok.com/legal/report/privacy) yourself as well.

Bullying and harassment (including a person's public image posted with
abusive text):

- Report the post or account under harassment and bullying; say whether it
  is repeated (TikTok's EEA form asks to show "it is not a one-off").
- Points to make: who is targeted (a private person, a child), what the
  post does (degrading remarks, threats, a photo posted to mock or shame
  the person), and whether it is part of coordinated abuse.
- If you are the person targeted: the Privacy portal has the option "I am
  being bullied or harassed on TikTok".

Impersonation:

- Report the account, "Pretending to Be Someone", then "Me" if it is you,
  otherwise "Celebrity" where that applies; outside the USA the web form
  (Topic "Report a potential violation", Category "Account violation",
  Reason "Impersonation") is the alternative.
- Points to make: whom the account imitates (name, photos, bio) and what it
  does with the identity (scam, harassment, defamation).

Child safety, non-sexual (abuse, exploitation, grooming):

- Report under "Violence, abuse, and criminal exploitation" and choose
  "Exploitation and abuse of people under 18" where the behaviour is
  exploitation or abuse of a minor; mapping other non-sexual child-safety
  cases to a reason is an inference [INF].
- Points to make: that the person is a child, what the post does, and why
  it endangers the child. Do not name the child.
- If what you see turns out to be sexual: follow TikTok's own instruction,
  "Never download, record, or share this kind of content"; report it in
  the app at once, and once to a hotline listed in
  [csam-hotlines.md](./csam-hotlines.md).

Intimate images shared without consent:

- Routing: never the post URL; the broadcast carries the account link.
- Members report the account; the affected person uses the Privacy portal.

Suspected child sexual abuse material: never broadcast. No member
instruction exists for this category by design; the admin's routing card is
described in the runbook.

## Unverified

Items from the research note's "Unverified" section that concern this page:

- How an organisation joins the Community Partner Channel; report-count and
  deduplication rules; whether the "clearly unfounded" clause exists in
  TikTok's US terms (the EEA, UK and Switzerland terms have it; a keyword
  search of the rest-of-world terms found nothing); TikTok's DSA reports
  after H1 2025 (the transparency page rendered lists H1 2025 as the latest
  PDF, while the newsroom mentions a seventh report for January to June
  2026); no CSAM-specific web form was found.
- Whether the Privacy portal accepts a third party's report, and the live
  in-app reason labels for personal information, harassment and
  child-safety reports; check on a real device before the Persian copy,
  now a draft for native review, is final.

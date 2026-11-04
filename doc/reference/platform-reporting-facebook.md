---
type: reference
title: "Platform reporting: Facebook"
description: "How to report child sexual exploitation, privacy violations, bullying and imposter accounts on Facebook, Meta's statement that report count does not decide removal, and the points the bot's broadcast instructions make."
status: active
tags: [reference, platform, facebook, meta, reporting]
timestamp: 2026-10-28T00:00:00Z
---

# Platform reporting: Facebook

This page is the English source for the Facebook instructions the bot
quotes in a broadcast, and the admins' lookup page when they file their own
report. It was compiled on 2026-10-28 from the research note of that date.
Every URL below was fetched or rendered on 2026-10-28 unless it is tagged
[S] or marked "not fetched". Policy text is quoted exactly as the research
note quotes it. Facebook shares its Community Standards with Instagram; the
policy pages are listed on
[platform-reporting-instagram.md](./platform-reporting-instagram.md) and
only named here. The project's own routing decisions are in
[report-categories-and-routing.md](../product/report-categories-and-routing.md).

How to read the tags: [H] raw HTTP fetch, text read verbatim; [R] public
page rendered in a headless browser without login, text read verbatim;
[W] read only through a summarising fetch tool, needs confirmation; [P] PDF
converted to text; [G] source code fetched from GitHub; [S] seen only in a
search result, not read; [INF] the researcher's inference, not a platform
statement.

## How to report

### The in-app path (any category)

- "Report Content on Facebook" [R] https://www.facebook.com/help/1380418588640631:
  "The best way to report abusive content or spam on Facebook is by using
  the Report link near the content itself."
- "Report something on Facebook" [R] https://www.facebook.com/help/263149623790594
  is the index of report types. Among them: "Report a Facebook profile or
  Page pretending to be you or someone else", "If you see images of a child
  being physically abused or sexually exploited on Facebook", "How do I
  report something on Facebook if I don't have an account or can't see
  it?", "Report someone under the minimum age on Facebook", "Report
  convicted sex offenders on Facebook".
- "Reporting Abuse" [R] https://www.facebook.com/help/1753719584844061.
- After a report [R] https://www.facebook.com/help/103796063044734: "Please
  keep in mind that reporting something to Facebook doesn't guarantee that
  it will be removed. You may see something you don't like on Facebook that
  doesn't violate the Facebook Terms." If the content is not removed,
  https://www.facebook.com/help/134552198624586 describes requesting
  another review.

### Child sexual exploitation

Project rule first: this category is never broadcast (critical invariant 7).
The admin files one report from the routing card, plus one hotline report;
see [csam-hotlines.md](./csam-hotlines.md) and the
[admin review runbook](../guides/admin-review-runbook.md). What follows is
what Facebook documents.

- No dedicated public web form was found.
- Help article [R] https://www.facebook.com/help/189165674568397: "Images
  and videos of children being physically abused or sexually exploited are
  against Facebook policies." Its page description: "Please contact your
  local law enforcement immediately if you see images that contain child
  abuse."
- The step-by-step article https://www.facebook.com/help/6972490769485629
  answered "This content isn't available in your region." from the
  researcher's European IP.
- The Transparency Centre's child-safety standard sends users to
  https://www.facebook.com/help/263149623790594 ("Get help with child
  sexual exploitation, abuse and nudity ... Visit our Help Center"). The
  Meta hub [R] https://www.meta.com/help/policies/1035211502617243/ points
  to https://www.facebook.com/help/1380418588640631.

### Privacy violations (doxxing)

- "Reporting a Privacy Violation" [R] https://www.facebook.com/help/1561472897490627.
  For a photo or video that violates your privacy: "please fill out this
  form", which is https://www.facebook.com/help/contact/954059743194940
  (not opened). For a child under 13:
  https://www.facebook.com/help/contact/516343134409068 (not opened).
- First-person limit on the same page: "If your child is between 13 and 17
  years old: ... unfortunately we can't take action on behalf of your child
  if they are over 13, unless they are mentally or physically unable to
  report this to us themselves."
- Text-based personal information (addresses, phone numbers): no separate
  form was found. The Privacy Violations Community Standard applies to
  reported content [INF: through the normal Report link]. The standard
  itself says "We also provide people ways to report imagery that people
  believe to be in violation of their privacy rights."

### Bullying and harassment

- "How to handle bullying, harassment, or personal attack on Facebook" [R]
  https://www.facebook.com/help/116326365118751 ("If you feel you're in
  immediate danger, contact your local authorities for help.").
- Meta page "Report bullying and harassment" [R]
  https://www.meta.com/help/policies/630029231963649/ (Instagram and
  Facebook tabs).

### Impersonation

- "Imposter Accounts" [R] https://www.facebook.com/help/1412710646726348:
  "You can report impersonating Facebook profiles or Pages even if you
  don't have a Facebook account."

## Policy pages

- Meta Community Standards (the same pages as Instagram, all [R]): Child
  Sexual Exploitation, Abuse, and Nudity; Bullying and Harassment; Privacy
  Violations; Authentic Identity Representation; Inauthentic Behavior. URLs,
  change-log dates and the quoted rationales are on
  [platform-reporting-instagram.md](./platform-reporting-instagram.md).
- Facebook Terms of Service [R] https://www.facebook.com/terms (effective
  January 1, 2025).

## Posture on volume, duplicates and false reports

- Report count, the one explicit platform statement found [R]
  https://www.facebook.com/help/408181689281891, titled "Does the number of
  times something gets reported determine whether or not that content is
  removed?": "We take something down from Facebook if it goes against our
  Community Standards, which are designed to encourage expression and
  create a safe environment. The number of times something is reported
  doesn't determine whether or not it's removed from Facebook. We use the
  same guidelines each time we review whether a profile goes against our
  Community Standards."
- Terms of Service: "You may not misuse any reporting, flagging, dispute,
  or appeals channel, such as by making fraudulent, duplicative, or
  groundless reports or appeals." and "We can remove or restrict access to
  content that is in violation of these provisions. We can also suspend or
  disable your account for conduct that violates these provisions, as
  provided in Section 4.2." This is the only platform text read that uses
  the word "duplicative".
- Inauthentic Behavior Community Standard: "Misuse Meta reporting systems
  to harass, intimidate or silence others." (the full lead-in is quoted on
  the Instagram page).
- EU DSA transparency report for Facebook, 29 Aug 2025 [P]
  https://transparency.meta.com/sr/dsa-transparency-report-aug2025-facebook:
  "Instances of duplicate submissions are handled by applying the original
  manual decision, to avoid conflicting decisions."; the Article 23(2)
  suspension sentence is identical to the Instagram report's; "This
  mechanism is available directly from the piece of content and is easily
  accessible. It is also available from Help Center."; median time to act
  9.2 hours for Article 16 notices, 8.4 hours for trusted-flagger notices.
- [S] The European Commission has issued preliminary findings that Meta's
  reporting tools are hard to use (reported by Yahoo and others,
  https://www.yahoo.com/news/article/eu-charges-meta-tiktok-over-121533540.html);
  preliminary, and disputed by Meta; seen in search results only.
- Trusted Partner programme and DSA trusted flaggers: see
  [trusted-flagger-programmes.md](./trusted-flagger-programmes.md). The
  Facebook DSA report's wording: "Trusted flaggers (as designated by the
  Digital Services Coordinator of the Member State in which the applicant
  is established) can file a notice within that notice mechanism in line
  with Article 22 DSA."
- [INF] Nothing documented makes a reported item faster to review because
  more people report it; Facebook says the count does not decide removal.
  What is forbidden is fraudulent, duplicative or groundless reporting and
  reporting through inauthentic accounts. One genuine report per member is
  the documented-safe pattern.

## What the bot's instructions say

The points below are what a member makes, in their own words, in one
Facebook report. They are the English source for the i18n catalogs (the
Persian copy, written from them, is a draft awaiting a native speaker's
review). They apply the decision of 2026-10-28 (Q7): one genuine report
per member, no template text to paste, no promise of removal, and
first-person reporting by the affected person where Facebook requires it.

Common frame, every category:

- Report once, from your own account, through the Report link near the
  content the broadcast names. Do not report the same item again and do not
  use a second account to report; Facebook's terms forbid "fraudulent,
  duplicative, or groundless reports".
- Choose the reason that matches what you see, and say in your own words
  what the profile, Page or post does.
- Do not repeat anyone's private data in your report, do not download or
  re-share the content, and do not engage with the account.
- Facebook says "The number of times something is reported doesn't
  determine whether or not it's removed" and "reporting something to
  Facebook doesn't guarantee that it will be removed". The broadcast never
  promises removal; your one accurate report is what counts.

Privacy violations (doxxing):

- Routing (decision Q2): the broadcast carries the account link by default
  and the admins have reported the specific post themselves; the post URL
  appears only by the admin's recorded opt-in, and never when the reporter
  is the affected person.
- Report the profile or Page through the Report link and pick the reason
  about private information; the exact label in the live menu was not
  verified.
- Points to make: the profile or Page publishes a private person's personal
  information (say which kind: home address, phone number, identity
  documents, workplace, family members) without consent; this is the kind
  of information Meta's standard says "could lead to physical or financial
  harm"; mention if it is part of a campaign against the person.
- If a photo or video of you is the problem: fill out Facebook's privacy
  form yourself (linked from "Reporting a Privacy Violation"). A parent can
  use the under-13 form for a child under 13; for a child aged 13 to 17
  Facebook says it "can't take action on behalf of your child" unless the
  child cannot report themselves.

Bullying and harassment (including a person's public image posted with
abusive text):

- Use the Report link on the post or profile and choose the bullying or
  harassment reason.
- Points to make: who is targeted (a private person, a child), what the
  post does (degrading remarks, threats, a photo posted to mock or shame
  the person), and whether it is repeated.
- If the image is of you: also file the privacy form (first-person).

Impersonation:

- Report the profile or Page as pretending to be someone; this works "even
  if you don't have a Facebook account".
- Points to make: whom the profile or Page imitates (name, photos, bio) and
  what it does with the identity (scam, harassment, defamation).

Child safety, non-sexual (abuse, exploitation, grooming):

- Report through the Report link; Meta's child-safety standard covers
  imagery of the aftermath of non-sexual child abuse and content
  identifying a private minor (quoted on the Instagram page). The in-app
  reason label was not verified [INF].
- Points to make: that the person is a child, what the post does, and why
  it endangers the child. Do not name the child.
- If what you see turns out to be sexual: do not interact with it, do not
  forward it to anyone, report it to Facebook at once, and report it once
  to a hotline listed in [csam-hotlines.md](./csam-hotlines.md).

Intimate images shared without consent:

- Routing: never the post URL; the broadcast carries the account link.
- Members report the account; the affected person files the privacy form
  (first-person).

Suspected child sexual abuse material: never broadcast. No member
instruction exists for this category by design; the admin's routing card is
described in the runbook.

## Unverified

Items from the research note's "Unverified" section that concern this page:

- https://www.facebook.com/help/6972490769485629 (the child-safety
  step-by-step article) was region-restricted; the privacy forms
  `.../contact/954059743194940` and `.../contact/516343134409068` were not
  opened.
- How an NGO becomes a Meta Trusted Partner and where the dedicated channel
  lives: no public route found. Critical coverage of the Trusted Partner
  channel (Rest of World, 2023; an Internews report) and the Commission's
  preliminary findings on Meta's reporting tools were seen only in search
  results; one Internews URL returned 404.
- Whether Meta deduplicates in-app (non-DSA) reports; the DSA sentence
  covers Article 16 notices only.
- The live in-app reason labels for private information and child safety
  were not observed on a logged-in client; check on a real device before
  the Persian copy, now a draft for native review, is final.

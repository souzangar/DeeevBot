---
type: reference
title: "Platform reporting: X"
description: "How to report child sexual exploitation, private information, abuse and impersonation on X, X's rule against duplicate or false reports in large numbers, and the points the bot's broadcast instructions make."
status: active
tags: [reference, platform, x, twitter, reporting]
timestamp: 2026-10-28T00:00:00Z
---

# Platform reporting: X

This page is the English source for the X (formerly Twitter) instructions
the bot quotes in a broadcast, and the admins' lookup page when they file
their own report. It was compiled on 2026-10-28 from the research note of
that date. Every URL below was fetched or rendered on 2026-10-28 unless it
is tagged [S] or marked "not fetched". Policy text is quoted exactly as the
research note quotes it. The project's own routing decisions are in
[report-categories-and-routing.md](../product/report-categories-and-routing.md);
this page records what X documents.

How to read the tags: [H] raw HTTP fetch, text read verbatim; [R] public
page rendered in a headless browser without login, text read verbatim;
[W] read only through a summarising fetch tool, needs confirmation; [P] PDF
converted to text; [G] source code fetched from GitHub; [S] seen only in a
search result, not read; [INF] the researcher's inference, not a platform
statement.

## How to report

### The in-app path and the Help Center forms (any category)

- Post, List or direct message [R]
  https://help.x.com/en/safety-and-security/report-a-post: "Navigate to the
  post you'd like to report. Tap the icon located at the top of the post.
  Select Report post and follow through the steps". Same page: "Depending
  on the type of issue you're reporting, you may or may not hear back from
  us with an outcome." and "Reporting a post or List does not automatically
  result in the account being suspended."
- Overview [R] https://help.x.com/en/rules-and-policies/x-report-violation:
  on a profile, the overflow icon, Report, then the issue type. For
  "They're being abusive or harmful" X asks for more detail and "may also
  ask you to select additional posts from the account you're reporting".
  "You can report violations on behalf of another person." On timing:
  "X acknowledges properly submitted reports within twenty-four hours.
  Although reports are typically resolved within a few days, resolution
  times vary and may take thirtydays to reach resolution" (sic). On
  sharing: "When reporting potential violations ... through the Help
  Center, you may be asked to allow us to share parts of your report with
  third parties, such as the affected account."
- Web-form hub [R] https://help.x.com/en/forms and
  https://help.x.com/forms/safety-and-sensitive-content ("Staying safe on X
  and sensitive content"). Its issue picker lists: "Private content is
  being posted", "Someone is showing intentions of self-harm or suicide",
  "I'd like to report a child sexual exploitation issue", "I'd like to
  report an underage user", "I'd like to report an ad on X", "I'd like to
  report a Community", "I'd like to report illegal and regulated
  behaviors", "I'd like to submit a US Take It Down Act Report".
- EU illegal-content route [R] https://help.x.com/forms/dsa ("European
  Union Reporting": "Report Illegal Content in the EU", "Appeal a Content
  Decision in the EU", and more).

### Child sexual exploitation

Project rule first: this category is never broadcast (critical invariant 7).
The admin files one report from the routing card, plus one hotline report;
see [csam-hotlines.md](./csam-hotlines.md) and the
[admin review runbook](../guides/admin-review-runbook.md). What follows is
what X documents.

- Form [R] https://help.x.com/en/forms/safety-and-sensitive-content/cse.
  Fields: an email address ("This is where we'll contact you."), "Username
  of the account you are reporting (required)", links to the content,
  details, and the statement "To the best of my knowledge, the above
  information is true and accurate." EU users are pointed to the DSA form
  (hub https://help.x.com/forms/dsa) to report "as illegal in your country
  or the EU".
- Policy [R] https://help.x.com/en/rules-and-policies/sexual-exploitation-policy
  (page title "Child Safety Policy", dated May 2024; The X Rules link it as
  `/en/rules-and-policies/child-safety`): "Anyone can report violations of
  this policy using our dedicated in-app reporting flow or via our Help
  Center. An X account is not needed to report potential violations." And:
  "...after reporting potential violations of our Child Sexual Exploitation
  policy to us, you can also notify the National Center for Missing &
  Exploited Children (NCMEC) by using their CyberTipline portal or calling
  1-800-843-5678." And: "Note: it can be illegal to engage with content
  that violates our Child Sexual Exploitation policy. Please be sure to
  report the content right away and do not like, reply to, quote-post,
  screenshot, follow accounts who distribute, or otherwise engage with the
  content; We do not require you to provide evidence of the potential
  violation in your report."
- Same policy: "anyone viewing, sharing, linking, or engaging with any kind
  of child sexual exploitation material contributes to the re-victimization
  of the depicted children"; the prohibited conduct includes "links to
  third-party sites that host child sexual exploitation materials of any
  kind"; accounts sharing such links "will be reported to the National
  Center for Missing & Exploited Children (NCMEC)".

### Private information (doxxing)

- "Private information policy" [R]
  https://help.x.com/en/rules-and-policies/personal-information (March
  2024): "X prohibits sharing someone's private information or media
  without their consent, a practice known as doxxing."
- Report through the in-app flow or the Help Center forms listed on the
  overview page: https://help.x.com/en/forms/safety-and-sensitive-content/private-information
  and https://help.x.com/en/forms/privacy.html (both linked there, not
  fetched).
- Who can report, same policy: "Anyone can report violations of this policy
  using our dedicated reporting flow when the private information has been
  shared in a clearly abusive way. When this isn't the case, we may need to
  hear directly from the owner of the private information (or an authorized
  representative, such as a lawyer) before taking action." For private
  media: "we need a first person report in order to make the determination
  that the image or video has been shared without their permission."
- Consequence for the project (decision Q2 of 2026-10-28): the affected
  person is told to file the first-person report; the broadcast never
  promises removal.

### Bullying and harassment (X calls it abuse)

- "Abusive behavior" [R] https://help.x.com/en/rules-and-policies/abusive-behavior
  (March 2024): "Anyone can report violations of this policy using our
  dedicated reporting flow. However, we sometimes need to hear directly from
  the person being targeted to ensure that we have the information needed
  prior to taking any enforcement action."
- Form (linked on the overview page, not fetched):
  https://help.x.com/en/forms/safety-and-sensitive-content/abuse.

### Impersonation

- Forms hub [R] https://help.x.com/forms/authenticity ("Authenticity on X":
  "I'd like to report impersonation on X"). The policy is "Misleading and
  Deceptive Identities" in The X Rules. The URL
  `.../rules-and-policies/impersonation-policy` returned 404 on 2026-10-28.

## Policy pages

- The X Rules [R] https://help.x.com/en/rules-and-policies/x-rules. Under
  Safety: "Child Safety", "Abuse/Harassment"; under Privacy: "Private
  Information"; under Authenticity: "Platform Manipulation and Spam",
  "Misleading and Deceptive Identities".
- Child Safety Policy, Private information policy and Abusive behavior:
  the URLs above.
- Authenticity policy (April 2025) [R]
  https://help.x.com/en/rules-and-policies/authenticity, and the
  enforcement philosophy page
  https://help.x.com/en/rules-and-policies/enforcement-philosophy (not read
  in detail).

## Posture on volume, duplicates and false reports

X is the only platform read whose rules name duplicate reports and
coordinated reporting directly. All quotes are from the Authenticity policy
[R] https://help.x.com/en/rules-and-policies/authenticity, section
"Engagement Spam".

- Not allowed: "engaging with X report features or forms, whether manually
  or through the use of automation, in order to submit duplicate or false
  reports in large numbers, including repeatedly reporting the same post(s)
  or accounts; and" / "coordinating and/or encouraging others to misuse X
  reporting features to harass others under false pretenses or hope to
  cause their account(s) or post(s) to be restricted or removed."
- Allowed: "Obtaining prior consent from X if you are a Law Enforcement
  Organizations ("LEO") or Non-Governmental Organizations ("NGO") to use
  automation to submit reports, provided you identify as such
  organizations, either by submitting reports through their official email
  domain or in the application through a verified account representing
  their affiliated entity." / "manually submitting reports in good faith
  that you believe may violate our policies" / "encouraging others to
  engage in good faith with X reporting features for customer support
  queries."
- How X enforces, same page: "Anti-spam challenges", "Restricting Reach",
  "Temporary loss of access to X features or products", "Suspension: For
  severe violations, accounts will be permanently suspended at first
  detection." No report-specific penalty is named.
- The "Copypasta" rule ("repeatedly posting identical or nearly identical
  posts in a duplicative manner popularly known as “Copypasta”") covers
  posts and direct messages, not reports.
- Deduplication of reports and weighting by report count: not documented.
- EU DSA data, H1 2026 [H]
  https://transparency.x.com/content/dam/transparency-twitter/dsa/transparency-report/DSA-Transparency-Report-H1-2026.zip
  (CSV tables): "Number of suspensions enacted for the provision of
  manifestly unfounded notices ... Total number | 0"; notices received
  548,233 (corrected file), of which 2,087 from trusted flaggers.
- NGO automation needs X's prior consent (quote above); no route to request
  it is documented. See
  [trusted-flagger-programmes.md](./trusted-flagger-programmes.md).
- [INF] A broadcast asking every subscriber to file the same report is not
  forbidden by the text read, but on X it could fall under "coordinating
  and/or encouraging others to misuse X reporting features" if the reports
  are not genuine, good-faith reports; nothing documented makes a report
  faster because more people file it. This is why the bot asks each member
  for one report in their own words and never for repeated reports of the
  same post.

## What the bot's instructions say

The points below are what a member makes, in their own words, in one X
report. They are the English source for the i18n catalogs (the Persian copy
is written from them later). They apply the decision of 2026-10-28 (Q7):
one genuine report per member, no template text to paste, no promise of
removal, and first-person reporting by the affected person where X requires
it.

Common frame, every category:

- Report once, from your own account, through Report post (or Report on
  the profile) and follow the steps. Do not report the same post or
  account again and do not ask others to repeat your report. X allows
  "manually submitting reports in good faith that you believe may violate
  our policies" and prohibits "duplicate or false reports in large
  numbers".
- When X asks for more detail, describe in your own words what the account
  or post does. When X asks you to "select additional posts from the
  account you're reporting", pick the ones you actually saw.
- Do not repeat anyone's private data in your report, do not download or
  re-share the content, and do not engage with the account.
- X may not tell you the outcome ("you may or may not hear back from us
  with an outcome") and "Reporting a post or List does not automatically
  result in the account being suspended." The broadcast never promises
  removal.
- You can report "on behalf of another person", and an X account is not
  needed for a child-safety report.

Private information (doxxing):

- Routing (decision Q2): the broadcast carries the account link by default
  and the admins have reported the specific post themselves; the post URL
  appears only by the admin's recorded opt-in, and never when the reporter
  is the affected person.
- Report the account, choose the private-information issue; the Help
  Center form for private information is linked from the overview page.
- Points to make: the account shares a private person's information or
  media without consent (say which kind), and it is "shared in a clearly
  abusive way" (name the threat, the campaign, or the intent to harass),
  because that is when X acts on a third party's report.
- If you are the person affected, or their lawyer: file the report
  yourself. For private media X requires "a first person report"; for
  private information X "may need to hear directly from the owner" unless
  the sharing is clearly abusive.

Abuse and harassment (including a person's public image posted with abusive
text):

- Report the post or account under "They're being abusive or harmful" and
  answer X's follow-up questions.
- Points to make: who is targeted (a private person, a child), what the
  posts do (degrading remarks, threats, an image posted to mock or shame),
  and whether it is repeated.
- X "sometimes need[s] to hear directly from the person being targeted";
  if that is you, file your own report.

Impersonation:

- Use the authenticity form ("I'd like to report impersonation on X") or
  the in-app flow.
- Points to make: whom the account imitates (name, photos, bio) and what it
  does with the identity (scam, harassment, defamation).

Child safety, non-sexual (abuse, exploitation, grooming):

- X's Child Safety Policy is the policy page; which in-app reason a
  non-sexual child-safety report takes was not verified [INF].
- Points to make: that the person is a child, what the post does, and why
  it endangers the child. Do not name the child.
- If what you see turns out to be sexual: follow X's own instruction, "do
  not like, reply to, quote-post, screenshot, follow accounts who
  distribute, or otherwise engage with the content"; report it to X at
  once, and once to a hotline listed in [csam-hotlines.md](./csam-hotlines.md).

Intimate images shared without consent:

- Routing: never the post URL; the broadcast carries the account link.
- Members report the account; the affected person files the first-person
  report X requires for private media.

Suspected child sexual abuse material: never broadcast. No member
instruction exists for this category by design; the admin's routing card is
described in the runbook.

## Unverified

Items from the research note's "Unverified" section that concern this page:

- Any NGO or partner escalation programme at X (none found); how to request
  the "prior consent" for automated NGO reporting; the X blog post on child
  sexual exploitation partnerships returned 403 or an empty render.
- Whether X deduplicates reports or weights them by count (not documented).
- The private-information and abuse form pages (linked from the overview
  page) were not opened.
- [S] Twitter disbanded its Trust and Safety Council in December 2022 (CNN,
  seen in search results only).
- The in-app reason a non-sexual child-safety report takes was not observed
  on a logged-in client.

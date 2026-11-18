---
type: spec
title: "Report categories and routing"
description: "The categories offered at intake and confirmed at review, what each category's post may carry (account link, post URL by admin opt-in, or nothing), the affected-person flag, the link policy every outgoing link passes, the hotline message a CSAM label earns at intake, and the suspected-CSAM routing card."
status: active
tags: [product, categories, routing, csam, doxxing, link-policy]
timestamp: 2026-10-28T00:00:00Z
---

# Report categories and routing

A reporter picks a category at intake; the admin confirms or changes it at
review. The admin's categorisation is the routing input for every
category; the reporter's label is a hint. Decided with the owner on
2026-10-28, see [Planning decisions](./planning-decisions-2026-10-28.md)
(Q1 and Q2), and amended the same evening by the scope reduction
([Threat model: seizure](./threat-model-seizure.md)): a report is posted
once into the channel instead of broadcast by direct message, "other" has
no admin-written instructions, and every link passes the link policy
below. The admin-side procedure is in the
[admin review runbook](../guides/admin-review-runbook.md).

## Categories

The owner asked for "all of possible" categories and gave two examples:
"we have some cases that they share public images of people with some
nasty words. or many doxxing way that even for the devil it's new." The
MVP offers:

1. Private data (doxxing).
2. Child safety: non-sexual abuse, exploitation, grooming.
3. Suspected CSAM, labelled for the reporter as "sexual content involving
   a minor".
4. Bullying and harassment, including people's public images posted with
   abusive text.
5. Intimate images shared without consent.
6. Impersonation.
7. Other: the post uses a fixed generic instruction block; the admin
   writes no instructions (the recommended comment is the only admin
   text, as for every category).

## Routing table

Link mode is what the post carries: the account link, or the account link
plus the specific post URL. The admin picks the link mode at approval
within what the category allows, and the choice is recorded with the
approval. Instruction keys name the per-platform instruction block the
post quotes (data in `src/platforms/`; the English source text lives in
the platform reference docs). Every link in the post is subject to the
link policy below; a Telegram target is rendered as code text, never as a
link.

| Category | Posted? | Link mode | Instruction key |
|---|---|---|---|
| Private data (doxxing) | yes | account link by default; post URL by explicit admin opt-in, recorded with the approval | `private-information` |
| Child safety | yes | account link by default; post URL by admin opt-in | `child-safety` |
| Suspected CSAM | never | no link leaves the admin review venue; routing card instead | none: the routing card's own text, the catalog's `review.route.*` keys (`src/review/card.ts`) |
| Bullying and harassment | yes | account link by default; post URL by admin opt-in | `harassment` |
| Intimate images shared without consent | yes | account link only; the post URL is never included (a rule of this table, not a default) | `intimate-images` |
| Impersonation | yes | account link by default; post URL by admin opt-in | `impersonation` |
| Other | yes | account link by default; post URL by admin opt-in; posted without any link unless the host is in `ALLOWED_LINK_HOSTS` | the fixed generic block |

Two rows are decisions of the owner and are not amendable without a new
decision: doxxing (Q2) and suspected CSAM (Q1, rule 7). The "never the
post" row for intimate images and the account-only default for the
remaining categories follow the same reasoning as Q2 and are amendable by
the owner in a later planning round.

### The affected-person flag

At intake the reporter can mark "I am the affected person". The flag
forces account-only for any category, and the instructions tell the
affected person to file the platform's own first-person report. The
research note (section 9) records why: Instagram says "Photos or videos
involving anyone else will need to be reported by the individual
themselves", and X says "we need a first person report" for private media
and "we may need to hear directly from the owner" for private
information, so a third party's report may not be acted on. The post
never promises removal. The flag serves the review only and is nulled at
the decision, with the comment. The rule is checked again in the
approval's own write, so a flag a duplicate raises while the keyholders'
notices are out refuses a post-URL approval
([Report lifecycle](./report-lifecycle.md)).

## The link policy

Catastrophic invariant 4, as amended on 2026-10-28: every link the bot
sends to the channel, to a reporter or to a keyholder is parsed,
https-only, free of userinfo, port, query and fragment, and its exact
hostname is on the configured allowlist of the target platforms' own
domains or on the code's fixed list of platform help and hotline hosts.
The rules, applied at intake and again at render time, with one test per
bypass class:

- Parse with `new URL`; https only; no userinfo; no port; query and
  fragment stripped. The hostname is matched exactly against
  `ALLOWED_LINK_HOSTS` (the platforms' hosts by default): no suffix match,
  no raw IP; punycode is handled by the parser.
- Platform-hosted redirectors and shorteners are rejected:
  `l.facebook.com`, `facebook.com/l.php`, `l.instagram.com`, `t.co`,
  `vm.tiktok.com`, `fb.me`, `bit.ly` and the shortener list.
- Telegram targets are never sent as links. At intake the bot accepts
  `t.me/<username>` and `t.me/<username>/<digits>` and nothing else on
  t.me: no `+`, no `joinchat`, no `?start=`, no `?startapp=`, no
  `t.me/<name>/<short_name>` Mini App launch. The post renders the target
  as non-tappable code text (`@username`, `post 123`) with the instruction
  to search for the channel in the app, report it, and never press Start
  on anything, in both locales; the rendered post is the test.
- "Other" may carry any public host at intake, but is posted without a
  link unless the host is in `ALLOWED_LINK_HOSTS`.
- The review card in the admin venue always shows the reported URL as
  non-tappable code text whatever its host, because admins must see it;
  the allowlist governs the messages sent to the channel, to reporters
  and to keyholders.
- The catalog's own links (the platforms' help-centre pages in the
  instruction blocks, the hotline portals in the hotline message and the
  routing card) are allowed by a fixed in-code list, `TRUSTED_HELP_HOSTS`
  (exact hosts: help.instagram.com, help.x.com, www.facebook.com/help
  paths on the Facebook host, support.tiktok.com, www.tiktok.com legal
  paths, telegram.org, report.cybertip.org, report.iwf.org.uk,
  www.iwf.org.uk, report.icmec.org, www.icmec.org, www.inhope.org,
  t.me/stopCA), which no configuration and no admin text can extend.
- The render-time scan checks every link in every outgoing message
  against the two lists. Admin free text is validated separately (no
  URL, bare domain, mention, `t.me` or phone number;
  [Review and abuse controls](./review-and-abuse-controls.md)).
- The bot has no Mini App and no inline mode.

Why: a seized admin account's approval must not be able to send the
members a link that identifies them or captures their IP addresses; the
threat model holds the reasons.

## Private data: the owner's revised decision (Q2)

The owner's first answer was "should be both account link and posts."
After Telegram's Bot Developer Terms 5.2(i) were put on the table the
answer became "Account link by default, post URL by admin opt-in". The
decision:

- The post carries the account link and the platform's
  private-information report path; the admins report the specific post
  themselves.
- The admin may include the post URL for one report by an explicit opt-in
  recorded with the approval, when they judge it necessary and safe.
- The affected-person flag forces account-only (above).
- Link previews are disabled on every message carrying a reported URL, and
  the post's text never repeats leaked data.

Why: Bot Developer Terms 5.2(i) forbid a bot to "facilitate the spread of
... personal information or media belonging to unconsenting third
parties", enforced "at Telegram's sole discretion" on "credible reports
from users"; and every member must open the post to report it, so a
post-URL post multiplies views of the leaked data by the channel's
readership.

## Suspected CSAM: routing, never posted (Q1)

Rule 7 stands, adopted by the owner on 2026-10-28 without counsel.

- The admin categorises from the reporter's description and the context
  visible without opening media (account bio, captions, the platform's own
  warnings), never by opening media.
- "Doubt" means doubt about whether the material is sexual, not whether a
  minor appears: a child's public photo with insults is child safety or
  harassment and goes through the normal flow. When the doubt is about the
  sexual nature, the admin routes to the hotlines, whose analysts assess
  the URL; NCMEC and IWF take anonymous reports and a wrong routing costs
  analyst time, while opening the material would be a crime and a harm.
- A report categorised as suspected CSAM is never posted and never sent
  to any chat other than the admin review venue; no approval row can
  exist for it (Approve offers Route only).

### The hotline message at intake

When the reporter's own label is "sexual content involving a minor", the
bot sends, after the self-deleting acknowledgement, a second and
persistent message that carries the public hotline links and nothing
else: no target URL, no echo of the report. It is a reply in the
reporter's own chat, allowed under invariant 5, and it is sent at intake
because no message follows any decision: a reporter who labels a report
this way can report directly whatever the admin later decides.

### The routing card

The routing card the bot sends the admin, in the review venue only, lists:

- the platform's child-exploitation report path (one report by the admin;
  platforms deduplicate);
- the hotlines listed in the runbook and in
  [CSAM hotlines](../reference/csam-hotlines.md): NCMEC CyberTipline at
  report.cybertip.org, which accepts reports from anyone anywhere; the IWF
  portal at report.iwf.org.uk and the ICMEC-IWF portal at
  report.icmec.org for "anyone, anywhere"; the INHOPE directory at
  inhope.org/what-we-do/how-to-report, which says to report once and never
  share the link outside official channels;
- for Telegram-hosted targets, stopCA@telegram.org.

The admin's hotline report states "unverified member report, content not
opened". On confirmation the bot records the admin id and timestamp, nulls
`url`, `account_url`, `comment` and `affected_person` on the report and on
its merged rows in the same batch (the aggregate fields and the keyed link
hash remain, until the row is finalized into its aggregate row 30 days
later), and deletes the review card from the venue. No message goes to
the reporter at routing; the hotline links went out at intake when the
reporter's label asked for them.

Why not post it, recorded for the owner: platforms deduplicate reports,
so volume buys no speed (research note section 0); every member who opens
the link accesses CSAM, a crime for them almost everywhere and a harm; a
bot that distributes such links distributes access and will be banned by
Telegram, taking the NGO's channel with it; and the hotlines hold direct
escalation lines the NGO cannot get.

## Telegram targets

Telegram's static report reasons include "Child Abuse", "Personal Details"
and "Fake Account" but no harassment or bullying reason (research note
section 9), so the Telegram instruction block maps bullying reports to the
closest reason and to the email routes; the per-category paths and the
"Forwarded from <bot>" guidance are in
[Telegram reporting](../reference/platform-reporting-telegram.md). The
post names the target as code text, `@username` or `post 123`, never as a
t.me link, and tells the member to find the channel through the app's
search, report it, and never press Start on anything.

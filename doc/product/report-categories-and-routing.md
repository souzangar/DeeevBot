---
type: spec
title: "Report categories and routing"
description: "The categories offered at intake and confirmed at review, what each category's broadcast may carry (account link, post URL by admin opt-in, or nothing), the affected-person flag, and the suspected-CSAM routing card."
status: active
tags: [product, categories, routing, csam, doxxing]
timestamp: 2026-10-28T00:00:00Z
---

# Report categories and routing

A reporter picks a category at intake; the admin confirms or changes it at
review. The admin's categorisation is the routing input for every
category; the reporter's label is a hint. Decided with the owner on
2026-10-28, see [Planning decisions](./planning-decisions-2026-10-28.md)
(Q1 and Q2); the admin-side procedure is in the
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
7. Other: the admin writes the instructions for this report.

## Routing table

Link mode is what the broadcast carries: the account link, or the account
link plus the specific post URL. The admin picks the link mode at approval
within what the category allows, and the choice is recorded with the
approval. Instruction keys name the per-platform instruction block that
the broadcast quotes (the keys are provisional names for `src/platforms/`;
the English source text lives in the platform reference docs).

| Category | Broadcast? | Link mode | Instruction key |
|---|---|---|---|
| Private data (doxxing) | yes | account link by default; post URL by explicit admin opt-in, recorded with the approval | `private-information` |
| Child safety | yes | account link by default; post URL by admin opt-in | `child-safety` |
| Suspected CSAM | never | no link leaves the admin review venue; routing card instead | `csam-routing` (card, not broadcast) |
| Bullying and harassment | yes | account link by default; post URL by admin opt-in | `harassment` |
| Intimate images shared without consent | yes | account link only; the post URL is never included (a rule of this table, not a default) | `intimate-images` |
| Impersonation | yes | account link by default; post URL by admin opt-in | `impersonation` |
| Other | yes | account link by default; post URL by admin opt-in | admin-written text |

Two rows are decisions of the owner and are not amendable without a new
decision: doxxing (Q2) and suspected CSAM (Q1, rule 7). The "never the
post" row for intimate images and the account-only default for the
remaining categories follow the same reasoning as Q2 and are amendable by
the owner in a later planning round.

### The affected-person flag

At intake the reporter can mark "I am the affected person". The flag
forces account-only for any category, and the acknowledgement and the
instructions tell the affected person to file the platform's own
first-person report. The research note (section 9) records why: Instagram
says "Photos or videos involving anyone else will need to be reported by
the individual themselves", and X says "we need a first person report" for
private media and "we may need to hear directly from the owner" for
private information, so a third party's report may not be acted on. The
broadcast never promises removal.

## Private data: the owner's revised decision (Q2)

The owner's first answer was "should be both account link and posts."
After Telegram's Bot Developer Terms 5.2(i) were put on the table the
answer became "Account link by default, post URL by admin opt-in". The
decision:

- The broadcast carries the account link and the platform's
  private-information report path; the admins report the specific post
  themselves.
- The admin may include the post URL for one report by an explicit opt-in
  recorded with the approval, when they judge it necessary and safe.
- The affected-person flag forces account-only (above).
- Link previews are disabled on every message carrying a reported URL, and
  the broadcast text never repeats leaked data.

Why: Bot Developer Terms 5.2(i) forbid a bot to "facilitate the spread of
... personal information or media belonging to unconsenting third
parties", enforced "at Telegram's sole discretion" on "credible reports
from users"; and every subscriber must open the post to report it, so a
post-URL broadcast multiplies views of the leaked data by the subscriber
count.

## Suspected CSAM: routing, never broadcast (Q1)

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
- A report categorised as suspected CSAM is never broadcast and never
  posted to any chat other than the admin review venue.

The routing card the bot sends the admin lists:

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
opened". At routing the bot records the admin id and timestamp, deletes
the report's URL and comment at once (the aggregate row and a keyed link
hash remain), deletes the review card from the admin chat, and sends the
reporter a neutral acknowledgement that carries the public hotline links
so the reporter can also report directly.

Why not broadcast, recorded for the owner: platforms deduplicate reports,
so volume buys no speed (research note section 0); every member who opens
the link accesses CSAM, a crime for them almost everywhere and a harm; a
bot that bulk-sends such links distributes access and will be banned by
Telegram, taking the NGO's channel with it; and the hotlines hold direct
escalation lines the NGO cannot get.

## Telegram targets

Telegram's static report reasons include "Child Abuse", "Personal Details"
and "Fake Account" but no harassment or bullying reason (research note
section 9), so the Telegram instruction block maps bullying reports to the
closest reason and to the email routes; the per-category paths and the
"Forwarded from <bot>" guidance are in
[Telegram reporting](../reference/platform-reporting-telegram.md).

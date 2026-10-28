---
type: audit
title: "Planning review (2026-10-28)"
description: "The angel's two review rounds on the Phase 1 decision brief: every objection and suggestion with its disposition, the owner's answers reflected in them, and the research note's unverified items that touch a decision."
status: active
tags: [audit, planning, review, angel]
timestamp: 2026-10-28T00:00:00Z
---

# Planning review (2026-10-28)

Scope: the Phase 1 decision brief (revisions R1 to R3 of 2026-10-28),
reviewed by the angel on the Claude lane in two rounds. The decisions
themselves are in
[Planning decisions](../product/planning-decisions-2026-10-28.md). The
dispositions below are the brief's own record; the objection summaries
are derived from those dispositions because the review transcript is not
part of the bundle.

## Round 1: twelve objections

| # | Objection (as derived from its disposition) | Disposition |
|---|---|---|
| 1 | a post-URL broadcast of a private-data report amplifies the leak | conceded: the owner chose an account-only default, post URL by admin opt-in, the affected-person flag, and no post URL ever for intimate images (Q2) |
| 2 | the trust roots and the blast radius of a wrong approval | conceded: the BotFather owner account as root of trust, mandatory 2-step verification, succession, the grace period with Cancel and /halt, no per-user backups, the reference key never exported (Q5, Q6, Q10) |
| 3 | the Cloudflare meters as first briefed did not hold | conceded: meters corrected, ledger and marks moved to DO storage, global 429 handling, quota-exhaustion behaviour, a per-day budget, DO CPU checked (30 s, no Free distinction stated), measurement still required (Q10) |
| 4 | rule 1 bound the wrong object | conceded: rule 1 reworded around the approval record |
| 5 | rule 5 promised "at most once" without a mechanism | conceded: scoped to direct messages, bound by construction, no number in the rule |
| 6 | rule 6 left platform logs and the other secrets out | conceded: rule 6 scoped; platform logs count as logs; the GrammyError test |
| 7 | retraction and closure had no mechanism, review cards lingered | conceded: edit-first retraction and closure; a supergroup venue with the bot as admin; the mirror message id stored |
| 8 | the CSAM path: what remains stored, what the admin sees, how doubt is resolved | adapted: URL and comment deleted at routing; the intake message deleted; doubt defined as doubt about the sexual nature; the admin decides from the description and non-media context and never opens media (accepted because hotline analysts triage anonymously and the alternative is opening the material); the reporter acknowledgement carries hotline links |
| 9 | reporter counters and duplicate handling re-identified people | conceded: counters pseudonymous and expiring, key never exported; severance after the decision notice; duplicates as merged rows; deletion paths covered by tests; no per-user backups |
| 10 | two admins could decide the same report | conceded: first decision wins by conditional update |
| 11 | the acknowledgement revealed whether a target was already reported | conceded: identical acknowledgements |
| 12 | rule 7's hotline reference and rule 3's scope | conceded: rule 7 points to the runbook; rule 3 scoped to the links |

Suggestions S1 to S12 were adopted. The brief records three
individually: S1 adapted (mirror chat recommended, the direct-message
fan-out stays as briefed); S6 (the defined quota-exhaustion behaviour:
persist, reschedule for 00:05 UTC plus jitter, alert once, stall
detector, per-day budget); S10 adapted to the owner's "anyone, stricter
limits for non-members". The others are folded into the decisions without
individual titles in the brief. Flags adopted: the re-evaluation trigger
for Telegram Serverless; the Bot Developer Terms paragraph on scope
changes (cited as 5.3 in round 1, corrected to 5.2 in round 2); the
weaponisation line kept; the random webhook path; the cursor skip
documented; the first-person reporting guidance from the research note.

## The owner's answers reflected in the dispositions

- Counsel: none. "we don't have official way to contact with the
  platforms and our government don't care about these things." Rule 7 was
  adopted after the hotline route was presented as the alternative.
- Private-data default: first "should be both account link and posts.";
  after the Bot Developer Terms 5.2(i) were put on the table, "Account
  link by default, post URL by admin opt-in" (#1).
- Who may report: "Anyone, with stricter limits for non-members" (S10).
- Approval grace period: 5 minutes, with Cancel and /halt (#2).

## Round 2: seven objections, all conceded

| # | Objection (as derived from its disposition) | Disposition |
|---|---|---|
| 1 | the bot as an admin of the NGO group | conceded: never an admin; membership checked as a plain member (verified at MVP) or anchored on a channel the bot administers; leaving the chat does not unsubscribe |
| 2 | the Bot Developer Terms citations | conceded: corrected to 5.2(i) and 5.2 |
| 3 | closure notices to people who had unsubscribed | conceded: only to pressers still subscribed; mirror-chat presses get the edited post; a regression test |
| 4 | the grace period was outside rule 1 | conceded: rule 1 binds the start time; Cancel voids the approval; the broadcaster re-reads status |
| 5 | a re-reported target's prior outcome shown to the reporter | conceded: shown on the admin card only |
| 6 | rule 1's audience | conceded: scoped to the broadcast audience (subscribers as such, or the mirror chat) |
| 7 | the meter table | conceded: amended (DO duration 13,000 GB-s; DO requests include "I reported it" presses; DO storage 10 GB per object; an admin bot's request cost) |

Suggestions adopted: S1, text-only intake with media refused and deleted;
S2, a global non-member cap; S3, one commit for docs and rules, with
CLAUDE.md's Error handling section filled from Q9 in that commit. Flags
adopted: double delivery to mirror-chat members who also subscribe is
stated; "unless they press" on the mirror chat's stored ids; retraction
within the hour; the brief's and the install audit's open lists updated
by doc-scribe. Rule 6 "storage" and rule 7 "admin review venue" wording
applied.

## Research note: unverified items that touch a decision

Section 10 of the research note of 2026-10-28 ("could not be confirmed
from a primary source"); a claim marked [S] or [W] there came only through
a search result or a summarising tool. Items 3, 4, 7, 10 and 12 are
research-side gaps that touch no decision.

- (1) Forwarded channel posts on Telegram: no source says a report is
  routed to the origin bot; the API and client code address the channel;
  moderator handling is undocumented. Decision touched: the Telegram
  instruction block says to report the channel, the post and the bot
  (Q7); the owner's observation is recorded as unverified moderator
  behaviour.
- (2) Telegram's live, server-driven report option tree, including
  whether a harassment option exists. Touched: the instructions use the
  static reasons; verify from a logged-in client before the fa/en copy is
  final.
- (5) How an NGO gains priority or accepted-sender status for
  abuse@telegram.org and stopCA@telegram.org; whether individuals may use
  stopCA@; "The brief's '@StopCA bot' is not supported: t.me/stopCA is a
  channel." Touched: the routing card lists the email for
  Telegram-hosted targets and assumes no priority.
- (6) Telegram deduplication, identical-text rules and the thresholds for
  automatic limits. Touched: the broadcast asks for one genuine report in
  one's own words.
- (8) Bot API: the exact 403 and 429 strings come from the Bot API server
  source, not core.telegram.org; the paid-broadcast Stars thresholds
  conflict between Telegram's own pages; "~30 messages per second" is
  stated as "about". Touched: the error classification, the 25 msg/s
  target, and paid broadcasts not being relied on (ADR 0004, ADR 0005).
- (9) No official Instagram sentence that report count does not decide
  removal (found only for Facebook). Touched: broadcasts never promise
  removal.
- (11), (13), (14) No public application route for Meta Trusted Partner,
  an X escalation programme or TikTok's Community Partner Channel.
  Touched: roadmap, see
  [Trusted-flagger programmes](../reference/trusted-flagger-programmes.md).
- (15) INHOPE's per-country entry was not verified ("country unknown" in
  the note; the country is Iran); EU trusted-flagger eligibility needs an
  EU entity. Touched: the routing card uses the global portals (NCMEC,
  IWF, ICMEC-IWF), see [CSAM hotlines](../reference/csam-hotlines.md).
- (16) The IWF, NCMEC and INTERPOL pages read carry no explicit "do not
  download / forward" sentence (INHOPE and the platform pages do).
  Touched: the runbook's rule rests on INHOPE and the platforms.

## Open after the review

- Measure in the MVP plan: the subrequest and CPU cost of a 35-send batch
  in a DO alarm on the Free plan; DO storage write plus `setAlarm`
  atomicity.
- Whether Workers invocation logs record request headers.
- The unverified items above, in particular (1), (2) and (5).

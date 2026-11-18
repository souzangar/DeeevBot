---
type: audit
title: "Security audit remediation (2026-11-11)"
description: "The four findings of the security audit of 2026-11-11 (a link mode the approval's batch could commit after the report stopped allowing it, a review venue the configuration let be the channel or the membership chat, a webhook secret and a reporter key with no length floor and no independence, a development-only minimatch advisory), how each was reproduced, the change and its regression tests, the residuals, the rollout for a deployment made before the change, the review record, and what the owner is asked to confirm."
status: active
tags: [audit, security, approval, configuration, secrets, dependencies, review]
timestamp: 2026-11-11T00:00:00Z
---

# Security audit remediation (2026-11-11)

A security audit of commit `950e817` (the MVP with its code complete, the
tree clean), made on 2026-11-11 by Codex, which supervised the
remediation, reported four findings, each with a reproduction or an
observation, and asked for each to be verified independently before it
was fixed. All four were confirmed. This document records the findings as
the audit stated them, how each was verified, the disposition and the
change, the regression tests, the residuals, the rollout for a deployment
made before the change, and the review the plan went through: it was
closed at its revision R4 (two angel rounds on the Claude lane, then one
codex devil run) before any code was written. None of the eight
[critical invariants](../architecture/critical-invariants.md) changed its
wording, so CLAUDE.md and AGENTS.md need no sync: the change makes rules
3, 5 and 7 hold where findings 1 and 2 showed they could break, and
strengthens the secrets behind rules 2, 6 and 8 (finding 3: the webhook
secret authenticates the updates, and the reporter-reference key is the
key of every reference and link hash); finding 4 touches no rule.

## Summary

| # | The audit's severity | Finding | Verified | Disposition |
|---|---|---|---|---|
| 1 | high | the approval's batch could commit a link mode the report no longer allowed: a duplicate by the affected person, submitted while the keyholders' notices went out, did not stop a post-URL approval, and the run posted the post URL | reproduced, and a second interleaving found | fixed: the approval's first statement re-checks the mode and the links inside the batch; the losing and stale paths show the card again from the report as it stands |
| 2 | high, conditional on a misconfiguration | the configuration let the review venue be the broadcast channel or the membership chat, so review cards reached the members before any approval | reproduced | fixed: `ADMIN_CHAT_ID` negative and never equal to `BROADCAST_CHAT_ID` or `MEMBERSHIP_CHAT_ID`, or nothing starts; an id comparison, so the go-live checklist stays the control for any other readable chat |
| 3 | medium, configuration hardening | `WEBHOOK_SECRET` and `REPORTER_REF_KEY` had no length floor and no independence | reproduced | fixed: 32-character floors, four pairs that must differ, a generation command in the docs |
| 4 | moderate upstream, limited exposure in the repository | `npm audit` lists a minimatch advisory in the development tools | observed | residual: no supported remedy, no override; a re-check on the go-live checklist |

## Finding 1: the approval could commit a link mode the report no longer allowed

### What the audit stated

"Victim protection can lose a race at approval" (high). In
`src/review/approve.ts`, `capturePoints()` checks the allowed link modes
(`allowedModes(report, category)`), renders the post from the report it
read, then awaits the keyholders' notices before `writeApproval()`; the
approval's statements re-checked only `status = 'pending'` and the
lockdown switch, not the affected-person flag nor the links the post was
rendered from; meanwhile the intake's flag raise (`RAISE_TARGET_FLAG`,
`src/review/drafts.ts`) can set a pending target's flag when a duplicate's
reporter is the affected person. The audit's reproduction, on the
in-memory harness with the real intake, review and run: a private-data
report with the flag off; the admin picks the post-URL mode; a real
duplicate by the affected person is submitted just before the approval's
batch; the target is then pending with its flag raised, yet the approval
commits the post mode and clears the flag, and the run posts the post URL.
It asked for an atomic fix (no approval record, approved status or post
job for a mode no longer allowed: "a read immediately before the
transaction alone is insufficient"), for the losing and stale paths to
refresh the review and withdraw the stale keyholder notices, and for
regression tests covering the real concurrent update with a final
assertion on what reaches the channel, with SQL and D1 parity for the new
guard.

### How it was verified

The reproduction ran on the in-memory harness at `950e817` before any
change: just before the approval's batch the target was pending with its
flag raised; the batch committed the post mode under a live approval; the
run sent one channel message carrying the post URL. The writers of the
fields the mode rule reads were searched, for a report that is pending:
the intake's flag raise (from no to yes, pending targets only); the
account link, set once from none to a value (the reply's pre-check needs
it set); nothing that writes the URL; and Cancel, which returns an
approved report to `pending` with the flag the approval had already
cleared. A merged duplicate does not refresh the target's card (only a
pending report gets a card at intake), so nothing in the venue showed the
change either.

The search found a second interleaving to the same stale write, which the
angel executed against the old code: a second admin's approval (which
clears the flag) followed by a keyholder's Cancel returns the report to
`pending` with its flag cleared, after which the first admin's stale
post-mode batch won over the voided approval row (its `ON CONFLICT DO
UPDATE`), and the run put the post URL in the channel.

### The change

In `src/review/approve.ts`, a critical path:

- The approval row's statement, the batch's first, now holds the mode rule
  of `allowedModes()` (`src/review/card.ts`) in SQL, bound to the links the
  post was rendered from: the row is written only while the report is
  `pending`, the lockdown switch is not set, the report's URL and account
  link are exactly those the post was rendered from, and, for any mode but
  the account link alone, the affected-person flag is exactly "no" and the
  post URL differs from the account's. A cleared flag or a missing URL
  refuses the post mode: the rule fails closed. The approval's input
  carries the links the post was rendered from (`ApprovalInput.links`).
- A refused row writes nothing else: no row is inserted, so the `ON
  CONFLICT DO UPDATE` over a voided approval cannot fire; the batch's
  other statements are bound to the new approval id and change nothing
  (the schema's trigger also refuses `approved` without a live approval);
  only the answered prompt's deletion runs, as for a lost status race.
- The category's own routing stays in TypeScript: suspected CSAM is
  refused by the reply's pre-check and by the post renderer; intimate
  images in the post mode by two layers before the batch, the press-time
  refusal of the mode and the reply-time pre-check, which suffice because
  the category and the mode are fixed in the prompt's row, the same two
  values the batch writes, so no window opens for them. A test pins each
  layer: the forged press, and a reply to a prompt that records intimate
  images with the post mode.
- The losing path: the keyholders' notices are edited to "cancelled"
  without links and forgotten, as before; under lockdown nothing else
  happens and the venue gets nothing; otherwise the report is read again.
  Still `pending`, it changed under the approval: the prompt and the reply
  are deleted and the card is shown at the category step from the report
  as it now stands, whose flag line says why. Taken by another decision,
  the prompt ends and the card shows the outcome, as before. Both card
  edits go through the edit that logs its failure, since the batch has
  run: a failed one is logged by class and sends no generic error into
  the venue. No new message text.
- A press of a mode the report does not allow, for a category that is
  posted and a report whose account is known, shows the card's modes
  again as the report allows them now, then answers "not allowed" as
  before. That covers the stale press (the report changed under the open
  card: an affected duplicate raised its flag) and a forged one, which may
  name another posted category: the card then shows that category's
  modes, a view an admin could reach by pressing that category. The card
  is shown through the edit that logs its failure instead of throwing, so
  a failed edit never keeps the answer from going. A press for a category
  that is never posted (suspected CSAM) is only answered "not allowed", as
  before. The gates (the venue, the admin allowlist, lockdown) run first,
  so the refresh only ever edits the report's own card in the venue
  outside lockdown.
- Unchanged: the reply's own pre-check, which already caught a flag raised
  before the admin replied and restarted the approval silently at the
  category step, sending nothing to the keyholders. No test reached that
  path before; one does now.
- Not changed: a duplicate that arrives after the approval was written
  (see Residuals).

### Regression tests

- `src/review/approve.test.ts` (node:sqlite):
  - the parity table: for the harassment category and a known account,
    each mode (account, post) against each flag (0, 1, cleared) and each
    post URL (other than the account's, the account's own, none), 18
    cells: the approval's write wins exactly when `allowedModes()` of the
    report as `readReport()` returns it allows the mode, which happens in
    ten cells, the account mode in all nine and the post mode only with
    the flag 0 and a URL other than the account's; each win writes its
    approval row, its status and its post job, and a refused cell writes
    nothing but the answered prompt's deletion;
  - a report that no longer holds the links the post was rendered from
    (another post URL, another account, no post URL where the report has
    one, a post URL where it has none): approved in neither mode, nothing
    written;
  - over a voided approval with the flag cleared, the post mode refused
    and the voided row left as it was (its approval id, admin, mode and
    voiding time), the account mode written over it.
- `test/workers/review.test.ts` (D1):
  - the same 18 cells on D1, with the same ten approvals, each with its
    approval row's link mode and a post job carrying its approval id, and
    every refusal leaving no approval row, no job and the report pending;
  - a real duplicate's submit batch on D1 raising the pending target's
    flag (the target pending with the flag 1, the duplicate merged with no
    flag of its own), after which the post mode is refused and the account
    mode approved;
  - the voided row with the flag cleared, and links that moved (three
    cases, both modes).
- `src/telegram/review.test.ts`, the composed bot over the fakes:
  - the affected-duplicate race: a real duplicate by the affected person,
    submitted through the intake once the notices are out, just before
    the batch: no approval row, no job, the report pending with its flag 1
    and a merged row; both keyholders' notices edited to the cancelled
    text without buttons; the prompt and the reply deleted, no prompt row
    left; the card at the category step showing the flag; approving again
    offers the account link alone and takes it; no error logged. The same
    race when the card's edit then fails once: the lost approval ends all
    the same, the one error logged is `review.message_not_edited`, by
    class, with no `update.failed`, and no generic error reaches the venue
    in either language. Its control: a duplicate that is not the affected
    person's leaves the post-mode approval winning;
  - the second interleaving: a second admin's real approval in the account
    mode and a keyholder's real Cancel, pressed on that approval's own
    notice (id 2 in the keyholder's chat; id 1 is the first admin's, on its
    way), run before the first admin's post-mode batch: the approvals
    table holds only the second admin's voided row, as the Cancel left it;
    no job; the report pending with its flag cleared; the first admin's
    notices withdrawn; the card at the category step showing the cleared
    flag; the prompt and the reply deleted;
  - the reply-time pre-check: a post-mode prompt open, a real affected
    duplicate, then the reply: no call to any keyholder's chat, no
    approval, no job, no prompt row, the prompt and the reply deleted, the
    card at the category step showing the flag;
  - the stale press: the modes step offering the post mode with "not the
    affected person", a real affected duplicate (which leaves the open card
    as it was), then the post press: answered "not allowed", the card
    showing the modes step again with the account mode alone and the flag,
    no prompt, nothing written; and the same press when the card's edit
    fails: still answered "not allowed", the failure logged by class
    (`review.message_not_edited`);
  - the forged press: on a report that is not the affected person's, the
    post mode pressed for intimate images: answered "not allowed", no
    prompt, nothing written, the card offering that category's account
    mode alone;
  - the reply-time routing check: on a report that would allow the post
    (not the affected person's, a post URL other than the account's), a
    prompt row recording intimate images with the post mode, which no flow
    writes since the press is refused, and a valid reply to it: nothing to
    any keyholder, no approval, no job, the report pending with no link
    mode or post text, no prompt row, the prompt and the reply deleted,
    the card at the category step.
- `test/invariants/review.test.ts` (rule 3, always run): the scheduler's
  harness, its review over a store whose approval batch lets a real
  duplicate by the affected person land first, once: the keyholders'
  notices carried the post URL when the batch ran; no approval is written;
  past the grace the stale approval would have had, the run makes no call
  of any method to the channel, and no keyholder's chat still holds the
  post URL; approved again in the account mode and past its grace, the run
  sends the channel exactly one message, which carries the account's URL
  and not the post URL.

## Finding 2: the review venue could be the channel or the membership chat

### What the audit stated

"Review/broadcast destination overlap" (high, conditional on a
misconfiguration). `loadConfig()` accepted `ADMIN_CHAT_ID` equal to
`BROADCAST_CHAT_ID` (its only rule across variables was the disjointness
of the admin and keyholder lists), and the review cards, sent to the
configured venue (`src/review/venue.ts`), would then reach the channel's
members before any approval, with the reported URLs, the comment and the
reporter reference. The audit's reproduction: the harness with the venue
set to the channel and one report labelled as suspected CSAM: no approval,
one pending report, one channel message carrying the URL and the comment.
It asked for the start to fail on a venue equal to the channel or to the
membership chat, and for a negative venue id (the configured private
supergroup), leaking no value, through the existing `CONFIG_INVALID` and
variable names only; the membership chat equal to the channel stays
supported, as the documented fallback; and for tests that an unsafe
configuration can neither build nor run the bot, and that the fallback
still works.

### How it was verified

Reproduced: a venue equal to the channel, a venue equal to the membership
chat, a positive venue id (a user's private chat) and a membership chat
equal to the channel all loaded; with the venue set to the channel, a
report labelled "sexual content involving a minor" put its card, with its
URL and its comment, into the channel with no approval. Every sender to
the venue (the venue module, the alerts, the replies, the bot's wiring)
reads the one configured id, so the configuration's refusal is the one
layer that covers them all; the Worker, the Node port and the webhook
script each refuse a configuration that does not load.

### The change

In `src/config/schema.ts`, a critical path:

- `ADMIN_CHAT_ID` is a negative integer, as the broadcast channel's id
  already was (the channel's schema reused under a neutral name,
  `negativeChatId`), with the requirement "a negative integer chat id, the
  private admin supergroup's: never the broadcast channel's or the
  membership chat's". `MEMBERSHIP_CHAT_ID` is unchanged, and may still
  equal `BROADCAST_CHAT_ID`, the supported fallback.
- The rules across variables became one list, `CROSS_FIELD_RULES`, checked
  only once every variable holds on its own: a variable that breaks its
  own rule is reported alone, "`<NAME>` must be" followed by its
  requirement. Every rule of the list that fails goes into one
  `CONFIG_INVALID`, whose message is "invalid configuration: " followed by
  the failed rules' sentences, joined by "; " in the list's order, and
  whose `variables` are those the failed rules bind, sorted and each once;
  no value, no cause. The list, verbatim:
  - "ADMIN_IDS and KEYHOLDER_IDS must not share an id: a keyholder is
    never an admin" (the existing rule, its text and variables kept);
  - "WEBHOOK_SECRET and WEBHOOK_PATH_SEGMENT must differ: the path segment
    is in the webhook's URL, which getWebhookInfo and request logs show";
  - "REPORTER_REF_KEY and WEBHOOK_SECRET must differ: Telegram holds the
    webhook secret";
  - "REPORTER_REF_KEY and WEBHOOK_PATH_SEGMENT must differ: the path
    segment is in the webhook's URL";
  - "REPORTER_REF_KEY and BOT_TOKEN must differ: Telegram holds the bot
    token";
  - "ADMIN_CHAT_ID and BROADCAST_CHAT_ID must differ: the review venue is
    never the broadcast channel";
  - "ADMIN_CHAT_ID and MEMBERSHIP_CHAT_ID must differ: the review venue is
    never the membership chat".

  The last two are this finding's, the four before them finding 3's.
- A refused configuration builds no bot: the Worker answers every request
  500 with no Bot API call and its cron runs nothing; the Node port
  refuses before it opens its database; the webhook script exits 1. Each
  logs the one class-only line, `config.invalid`.

What the check cannot do: it compares ids and nothing else. It refuses a
positive venue and a venue equal to `BROADCAST_CHAT_ID` or
`MEMBERSHIP_CHAT_ID`, and nothing more: under the supported fallback,
where the membership chat is the channel, the NGO group's id is
configured nowhere, so a venue set to that group would load, and no
comparison of ids can stop another chat the members can read. The
go-live checklist's item, the venue a private supergroup the keyholder is
not in, stays the real control (see Residuals).

What a venue change means for a deployment that already holds reports
(the stored card ids carry no chat id) is under Residuals, and the
procedure is in the
[operations and security runbook](../guides/operations-and-security.md),
section 7.

### Regression tests

- `src/config/schema.test.ts`: the venue takes a negative id only (`-1`
  and a supergroup's id loaded; `1`, `777`, a supergroup's id without its
  minus sign and an id beyond the safe-integer range refused), the refusal
  giving the requirement and no value; the membership chat still takes a
  positive or a negative id; a venue equal to the channel, to the
  membership chat, or to both when they are one chat, refused, naming
  `ADMIN_CHAT_ID` with the other variables and saying every broken rule,
  no value, no cause; a membership chat equal to the channel loads; every
  broken rule across variables in one error, the names once each and
  sorted, the sentences in the list's order; and the rules across
  variables checked only once every variable holds on its own (a variable
  that does not is the one named).
- `test/invariants/config-redaction.test.ts`: nine new refusals echo no
  value: a positive venue, the venue equal to the channel and to the
  membership chat, and finding 3's two short keys and four pairs.
- `test/invariants/review.test.ts` (rules 3, 5 and 7, always run): no bot
  is built with the venue set to the channel or to the membership chat
  (`CONFIG_INVALID`, naming `ADMIN_CHAT_ID`); with the membership chat set
  to the channel, the supported fallback, a member of the channel reports
  twice in a day, a non-member's second report of the day is refused, the
  membership check (`getChatMember`) asks the channel, the card goes to
  the venue and the review runs there to an approval, and of the more than
  ten sends, edits and deletions none reaches the channel.
- `src/worker.test.ts`: a venue equal to the channel is answered 500 with
  an empty body, no Bot API call and the class-only `config.invalid` line,
  and the cron runs nothing (no store touched, no post, no call).
  `src/node.test.ts`: the port refuses to start on it, with no database
  opened, no Bot API call and one class-only line.

## Finding 3: the webhook secret and the reporter key had no floor and no independence

### What the audit stated

"Weak webhook and reporter-reference secrets" (medium, configuration
hardening). `WEBHOOK_SECRET` accepted 1 to 256 characters and
`REPORTER_REF_KEY` any value that was not blank: a configuration with
`WEBHOOK_SECRET` `a`, `REPORTER_REF_KEY` `b` and `WEBHOOK_PATH_SEGMENT` `c`
loaded, and the secret `a` authenticated a request. The audit asked for
adequate lengths for the webhook's authentication and for the reporter
HMAC; documented, independent, cryptographically random generation (for
example 32 random bytes as base64url), without claiming that a length
check proves randomness; Telegram's alphabet and maximum kept; a careful
decision on the path segment, which is a scanner-budget measure and not
authentication; no production token format imposed on test tokens or
unrelated values; the fixtures and boundary tests updated; and the
rollout documented: old short values make the start fail, a new
`REPORTER_REF_KEY` changes the references and the link hashes, and no
deployment state is rotated silently or migrated by an invented
migration.

### How it was verified

One-character values loaded, and the secret `a` matched
(`secretMatches`). A `WEBHOOK_SECRET` equal to `REPORTER_REF_KEY` loaded,
and so did a `WEBHOOK_PATH_SEGMENT` equal to `WEBHOOK_SECRET`. The key's
bytes are the UTF-8 encoding of the string; the reporter reference and
the keyed link hash share the key, domain-separated. The path segment
"only keeps scanners off the daily request budget, it is not the check"
(the boundary's own comment, `src/telegram/webhook.ts`): an off-path
request and a wrong secret are both answered 404 before the body is read.

### The change

In `src/config/schema.ts`:

- `WEBHOOK_SECRET`: `^[A-Za-z0-9_-]{32,256}$`, Telegram's `secret_token`
  alphabet and maximum kept, with the requirement "32 to 256 characters
  from A-Z, a-z, 0-9, _ and -, equal to neither WEBHOOK_PATH_SEGMENT nor
  REPORTER_REF_KEY".
- `REPORTER_REF_KEY`: the non-blank secret refined to `value.length >= 32`,
  with no alphabet imposed and the requirement "a non-blank secret of at
  least 32 characters, equal to none of BOT_TOKEN, WEBHOOK_SECRET and
  WEBHOOK_PATH_SEGMENT". `.length` counts UTF-16 code units, on purpose:
  zod's own `min()` counts code points. Each unit encodes to at least one
  UTF-8 byte, so the key has at least 32 bytes: the length of SHA-256's
  output, below which RFC 2104 calls an HMAC key "strongly discouraged".
- Four pairs that must differ, by exact equality, as four rules of
  `CROSS_FIELD_RULES` (their sentences are quoted under finding 2):
  `WEBHOOK_SECRET` and `WEBHOOK_PATH_SEGMENT` (the secret would sit in the
  webhook's URL, which `getWebhookInfo` and request logs show);
  `REPORTER_REF_KEY` and each of `WEBHOOK_SECRET`, `WEBHOOK_PATH_SEGMENT`
  and `BOT_TOKEN` (each of those is disclosed beyond the keyholder:
  Telegram holds the secret and the token, and the segment is in URLs).
  These are the pairs a disclosure can reach. Equality catches a value
  pasted twice, not a weak or a related one, and a length floor rejects a
  short value but proves no randomness: the strength comes from
  generating each value on its own, which the
  [developer setup](../guides/developer-setup.md), section 6, gives as a
  command (32 random bytes as base64url, 43 characters).
- Out of scope, by decision: a floor for `WEBHOOK_PATH_SEGMENT`, which is
  not an authentication factor (see Residuals), and any format for
  `BOT_TOKEN`.
- The webhook boundary's comment that said the secret has "1 to 256
  characters" now says 32 to 256 (`src/telegram/webhook.ts`).
- The test fixtures were lengthened to synthetic values of at least 32
  characters, never secret-shaped (`test/support/variables.ts` and the
  workers project's bindings in `vitest.config.ts`, which a workers test
  keeps equal; `src/config/schema.test.ts`, `src/config/memo.test.ts`,
  `test/invariants/config-redaction.test.ts`); no golden digest was keyed
  to the old test key. `.dev.vars.example` and `.env.example` gained
  comments only, stating the floors and the values each key must differ
  from: every secret in them stays empty, and no generated key is anywhere
  in the tree.

### Regression tests

- `src/config/schema.test.ts`: the secret loaded at 32 and at 256
  characters (one of 32 using every class of the alphabet), and refused at
  31 and at 257, with a space, a semicolon, a slash or a letter outside
  the alphabet, its requirement in the message and no value; the key
  loaded at 32 characters of any alphabet (spaces and punctuation, or 32
  non-ASCII letters), and refused at 31 (31 non-ASCII letters included)
  and when blank; each of the four pairs refused when its two variables
  hold one value that each takes alone, naming both, the message opening
  with the rule's sentence, no value, no cause; all four pairs broken at
  once in one error.
- `test/invariants/webhook-authenticity.test.ts` (rule 2, always run): a
  secret of 31 characters refused and one of 32 loaded; a secret equal to
  the path segment refused, naming both; and the test secret itself above
  the floor and not the segment, so the checks are not vacuous.
- `test/invariants/config-redaction.test.ts`: the two short keys and the
  four pairs among the nine new refusals that echo no value (finding 2).

## Finding 4: the development-only minimatch advisory

### What the audit stated

"Development minimatch advisory" (moderate upstream, limited exposure in
the repository). `npm audit` listed 9 moderate entries, all one advisory,
GHSA-g3hv-75wg-m249 (CVE-2026-118764): the lockfile's minimatch 10.2.6, a development dependency that eslint,
`@eslint/config-array` and typescript-eslint bring, is affected, and
11.0.1 is patched; the vulnerable path preprocesses an attacker-controlled
glob when `optimizationLevel` is 2 or more. `npm audit --omit=dev` found
nothing. The audit asked that the issue not be portrayed as remotely
exploitable through the bot; for the smallest supported, safe and
compatible remedy, its compatibility with Node 22.18 or later checked, the
lockfile updated with install scripts disabled, and the audit run again;
never `npm audit fix --force`, an indiscriminate downgrade or an
unvalidated major-version override; an override or a toolchain change
explained and validated for its API and its engines; and, if no safe
compatible remedy exists, the evidence and the residual stated rather
than any check weakened.

### How it was verified

`npm audit`: 9 moderate entries, the one advisory, under a range of npm's
own that is wider than the advisory's, `>=7.0.0 <11.0.1` (CWE-405). The
fixes it offers are none: `npm audit fix --force` installs eslint 9.39.5,
a breaking downgrade; and `npm audit --json` also offers typescript-eslint
8.36.0, a semver-major downgrade from 8.72.1 whose typescript-estree
requires minimatch ^9.0.4, itself inside that range. Both were rejected.
`npm audit --omit=dev`: 0 vulnerabilities, so the Node port's image,
which installs the production dependencies alone, holds none of it. The
lockfile has one minimatch, 10.2.6, development only, required by
`@eslint/config-array` (^10.2.4), `@typescript-eslint/typescript-estree`
(^10.2.2) and eslint (^10.2.5). The registry (`npm view`) gave the
release facts below.

The advisory itself, read on its GitHub page the same day: affected
"10.2.6", patched "11.0.1", CVE-2026-118764, severity Moderate, with no
CVSS score shown and no workaround section. In its words, "minimatch
10.2.6 contains an attacker-controlled pattern amplification in
firstPhasePreProcess() when optimizationLevel >= 2": the `**/../`
transformation clones the parsed pattern's parts inside a fixpoint loop,
and `secondPhasePreProcess()` then compares them in pairs, a quadratic
cost, so "an attacker who can supply a glob pattern" causes excessive CPU
and memory use.

minimatch's changelog, section 11.0, read the same day: each path portion
is matched with a `Matcher` from `@isaacs/nonrecursive-glob-match` instead
of a RegExp, and `Minimatch.set` holds strings, `Matcher` objects or
`GLOBSTAR`; removed are `makeRe()`, `Minimatch#regexp` and `MMRegExp`, the
`AST` class, the `debug` option and `debug()`, `matchOne()`, `slashSplit()`
and `levelTwoFileOptimize()`, and the `maxExtglobRecursion` option; the
`normalize` option is new; and one behaviour changes: "An empty path
portion, such as the last one in `a/b/`, only matches an empty pattern
portion" (Windows' handling of `..` changes too). The changelog has no
entry per release after 11.0 but one fix in 11.0.6, and states no
engines.

### Disposition: no supported remedy, no override, a residual

1. No supported remedy exists. minimatch has no 10.x release after 10.2.6
   (2026-07-27), and the three consumers' latest stable releases still
   declare ^10: eslint 10.14.0 (^10.2.6), `@eslint/config-array` 0.23.5
   (^10.2.4), typescript-eslint 8.72.2 through typescript-estree 8.72.2
   (^10.2.2); only typescript-estree's canary, 8.72.3-alpha.7, declares
   ^11.0.1. npm audit's two offers are no fixes (above): `npm audit fix
   --force` is the eslint 9 downgrade, which the audit forbids, and
   typescript-eslint 8.36.0 would bring a minimatch inside the affected
   range. A typescript-eslint bump alone would not clear the audit, since
   eslint and `@eslint/config-array` still require 10.x.
2. An override to minimatch 11 is the only candidate, and a static review
   finds no incompatibility. Its engines fit Node 22.18 or later (11.0.1:
   `18 || 20 || >=22`; 11.0.8: `20 || >=22`). The consumers call a narrow
   API and none of what 11.0 removed: `@eslint/config-array`,
   `new Minimatch(pattern, { dot: true, ... })` and `.match(path)`, with
   `flipNegate` for negations; eslint's helpers,
   `new Minimatch(pattern, { dot: true })`, `.match(path)`,
   `.match(path, true)` and `.pattern`; typescript-estree,
   `minimatch(file, pattern, { dot: true })`, only under
   `allowDefaultProject`. The one behaviour change is on a path they do
   exercise: `@eslint/config-array` checks a directory against the ignores
   with a trailing slash, an empty final path portion. This repository's
   ignore patterns all end in `/` (`eslint.config.js`: `node_modules/`,
   `dist/`, `coverage/`, `.wrangler/`, `.claude/`, `scripts/okf/`,
   `selftest/`, `selftest-okf/`; eslint's defaults `**/node_modules/` and
   `.git/`), so their final pattern portion is empty as well: the case the
   new rule keeps matching. The consumers' declared ranges, which exclude
   11, prove nothing either way.
3. Its validation is still incomplete: a static review is not the
   behavioural check that would settle it (below), which needs the
   override installed, and this change installs nothing (no `npm pack`, no
   override tried). The audit forbids an unvalidated major-version
   override.
4. And it is not needed. The vulnerable branch runs only with
   `optimizationLevel` 2 or more (minimatch's default is 1), which no
   consumer's call sets: `@eslint/config-array` and eslint's helpers pass
   `{ dot: true }`, with `flipNegate` where they need it; typescript-estree
   calls minimatch only under `allowDefaultProject`, which
   `eslint.config.js` does not set (it uses `projectService: true` alone).
   The patterns are the repository's own (`eslint.config.js`) and the
   command line's; it is a development dependency, and the production
   audit finds nothing.
5. Supply-chain caution points the same way: minimatch 11 had nine
   releases in fifteen days (11.0.0 on 2026-10-27 to 11.0.8 on 2026-11-11,
   the day of this audit), and 11.x adds a dependency,
   `@isaacs/nonrecursive-glob-match`, created on 2026-10-26.

Decision: no override, since it is not needed, the consumers do not
declare minimatch 11, and supply-chain caution weighs against it; the
residual is documented here and in the
[developer setup](../guides/developer-setup.md), section 10; the
override's validation is reported as incomplete, not as impossible.
wrangler's own bundled copy of minimatch, inside `wrangler-dist/cli.js`,
is outside `npm audit`'s view and any override's reach.

The behavioural check, for whoever validates an override later: before
the override, record ESLint's computed configuration
(`calculateConfigForFile`) for every tracked file and the list of files
`eslint .` lints; add the override, install, and record both again: they
must be identical, and the commit gate must pass. Read the changelog
again first for any release after the ones reviewed here.

The watch item is on the go-live checklist of the
[operations and security runbook](../guides/operations-and-security.md),
section 9: run `npm audit` and `npm audit --omit=dev` again, and once
stable releases declare minimatch ^11, bump typescript-eslint, then
eslint.

## Residuals

- The development-only minimatch advisory (finding 4).
- A duplicate by the affected person after the approval was written. Once
  the approval's batch has committed, the report is no longer pending: a
  duplicate whose reporter is the affected person is merged, raises no
  flag and changes nothing of the approved post, and a merged report sends
  nothing to the venue, so no admin learns of it. The admin review runbook
  said "if it should, Cancel", which nobody can act on without a signal;
  it now says that the bot does not tell the admin. Whether such a
  duplicate should reach the admins, during the grace or after the post,
  and how, is the owner's decision, to take before go-live; it is not part
  of this change.
- The `config.invalid` line names no variable. Every refusal of the
  configuration is one class-only log line, `config.invalid` (`errorClass`
  `AppError`, `errorCode` `CONFIG_INVALID`); the error's message and its
  list of variables never reach a log. A refusal is therefore diagnosed
  against the list of rules, and since a variable that breaks its own rule
  is reported before any rule across variables is checked, a second run
  can refuse what the first did not. Every doc that explains the line now
  gives the rules in full: the [developer setup](../guides/developer-setup.md),
  section 6; the [operations and security
  runbook](../guides/operations-and-security.md), sections 2.1 and 2.4;
  the [fallback drill runbook](../guides/fallback-drill.md), section 3. A
  side-finding, not changed here: the line could carry the closed set of
  the failing variables' names, never a value, to make a refusal
  diagnosable.
- The venue check compares ids only. It refuses a positive venue id and
  one equal to `BROADCAST_CHAT_ID` or `MEMBERSHIP_CHAT_ID`, and nothing
  else: it cannot tell any other chat the members can read, and under the
  supported fallback (the membership chat set to the channel) the NGO
  group's id is configured nowhere, so a venue set to that group loads.
  The go-live checklist's item, the venue a private supergroup the
  keyholder is not in, is the real control, and every doc that describes
  the check says so.
- The path segment has no length floor. `WEBHOOK_PATH_SEGMENT` is not an
  authentication factor: the secret header is the check, and an off-path
  request and a wrong secret are both answered 404 before the body is
  read; the segment only keeps scanner traffic off the Free plan's daily
  request budget. It is generated like the secrets all the same, and it
  must differ from the secret and the key.
- Stored card ids carry no chat id. `reports.card_message_id` and
  `reports.status_message_id` hold message ids alone, and every later
  operation on them (`/card`, the decisions, the closures, the retention
  job) addresses the configured venue, so after any change of
  `ADMIN_CHAT_ID` on a deployment that holds reports they address
  whatever messages carry the same ids in the new venue. The operations
  runbook, section 7, gives the procedure. A side-finding, not changed
  here: storing the venue's chat id with each card id would remove the
  hazard.

## Rollout for a deployment made before this change

Go-live still waits on the owner's checklist, and a deployment configured
from the start to the rules above needs none of this. One made before
this change may hold values the new code refuses, and the new code
refuses the configuration whole: the Worker answers every request 500 and
its cron runs nothing (no post, no retention pass, no alert) until it is
fixed. The order, in full in the
[operations and security runbook](../guides/operations-and-security.md),
section 2.4:

1. Prepare the complete configuration (new secrets, each generated on its
   own; chat ids that pass the venue rules) in the owner-only registration
   file, and check it without calling Telegram: the new commit's webhook
   script, run with that file and no argument, loads the configuration
   before it reads its arguments and calls nothing before both pass:
   `webhook.usage` means the configuration loads, `config.invalid` that a
   value breaks a rule.
2. If the venue must change on a deployment that holds reports, the venue
   procedure first (the runbook, section 7).
3. Put each changed value with `wrangler secret put` (the running code
   accepts them), register the webhook with the checked file right after,
   back to back (updates Telegram sends in between carry the old secret,
   are answered 404, and are dropped by the registration's
   `drop_pending_updates`), then deploy the new code.

A Workers secret is write-only: a value the new code refuses is fixed by
putting it again, never by reading it back. A new `REPORTER_REF_KEY`
severs every reporter reference and every keyed link hash: open drafts are
orphaned (they expire within 24 hours); the reporters' counters,
throttles and blocks no longer match (a blocked reporter is unblocked); a
new report of an open target no longer merges into it; "previously
reported" loses its history. No migration exists and none was invented:
the key is replaced only where the old one breaks a rule, best before
go-live. This change touches no deployment state.

## Review record

- Verification: all four findings were reproduced before any change, the
  first three on the synthetic in-memory harness (finding 1: the target
  pending with its flag raised just before the approval's batch, the batch
  committing the post mode and the run posting the post URL; finding 2: a
  venue configured as the broadcast channel loading, and a report labelled
  as suspected CSAM putting its card, with its URL and private comment,
  into the channel with no approval; finding 3: one-character secrets
  loading and authenticating), the fourth with `npm audit` (9 moderate
  entries from one advisory; `npm audit --omit=dev`, none). The audit's
  own baseline before the change: `npm run build` passed; `npm test`, 92
  files and 1,801 tests, passed; `npm run test:invariants`, 16 files and
  296 tests, passed; the secret-shape scan and the rules-sync check
  passed.
- The plan, revisions R1 to R4, rested on one premise, re-checked by each
  critic: the approval's single batch is the only path from `pending` to
  `approved`; it re-checked only the status and the lockdown switch; and
  the mode it commits was validated, and the post rendered, from a report
  read before the keyholders' notices go out (up to 10 seconds a
  keyholder), so a change of the report inside that window was overwritten
  by the batch.
- The angel (the Claude lane's advisor, the strongest model at maximum
  effort), round 1, on R1: two blocking objections, both conceded and
  folded into R2. The rollout claimed that the refusal names the failing
  variables, when the log line is class-only: corrected, with the rules
  listed under every entry that explains `config.invalid` and on the
  go-live checklist, the rollout order, "put it again, never inspect it",
  the logger unchanged and the side-finding recorded. Two must-not paths
  had no regression test, the reply-time pre-check and the
  cancelled-approval interleaving: tests added at the unit, D1 and
  conversation levels. Four minor objections, all conceded: the
  distinctness narrowed to the four reachable pairs; the stale mode press
  refreshed; the D1 test raising the flag through the real submit batch
  instead of planting it; finding 4's reasons reordered (the tools denied
  at the time stated apart, the checklist's re-check, one bump not
  clearing the audit). Its suggestions were adopted, among them the parity table, which
  exposed that the first guard lacked the mode rule's "post URL other than
  the account's" condition, then added to the SQL; the fixtures changed
  first; the channel's schema reused for the venue; the always-run extras;
  the floor's always-run test.
- The angel, round 2, on R2: no blocking objection; the plan closed with
  corrections, all folded into R3. The guard was evaluated against
  `allowedModes()` over the 18 cells with no mismatch, and the parity
  test's domain set (the URL's "none" column, a known account, the input
  from `readReport()`); the stale-press refresh goes through the logging
  edit, so "not allowed" is always answered; the second interleaving's
  test, which the angel also executed against the old code (a second
  admin's approval followed by a keyholder's Cancel let the stale
  post-mode approval win), sets its once-flag before the nested approval
  and presses Cancel on the second approval's own notice; the
  intimate-images sentence was corrected (the pre-check alone, the
  category and the mode being constants of the prompt) and the
  forged-press test added; the membership-equals-channel test avoids its
  traps (message methods only, `getChatMember` expected, the member set on
  the channel itself); the rollout puts and registers back to back; the
  D1 helpers are shared or copied; and the owner-confirm list below.
- The codex devil, one plan run on R3, the terminal cross-vendor check
  (`DEVIL_RUN: mode=plan base=n/a critical=0 escalate=1 effort=xhigh
  model=gpt-6-astra`; session `01a1cb3c-b436-7870-9e66-07eda7ec98db`; the
  R3 brief's sha256
  `4cbe6912de41f0a4bc410c52c08180bf638cc831ce4c25c32a682653b58f1914`;
  `DEVIL_QUOTA: 7d[used=36% left=64% resets=2026-11-12 00:57]`):
  verdict FIX-FIRST, four objections, all conceded and folded into R4.
  (1) A venue change leaves the stored card ids pointing into the old
  chat, so an overlapping venue needs an incident procedure: documented,
  the general hazard recorded as a side-finding, the code unchanged.
  (2) The webhook script loads the whole configuration first, so the
  complete configuration must be prepared and checked before the secret
  is switched: the no-argument check, then put, register back to back,
  deploy. (3) Finding 4 must not claim an override is forbidden or
  impossible: no supported remedy exists, an override's validation is
  incomplete, and it is not needed; reframed, the decision unchanged, the
  check's recipe recorded. (4) The D1 tests must show a successful
  post-mode approval too: the parity table runs on D1 as well. Closure by
  disposition completeness: every objection conceded and folded, none
  rebutted; none changed the code design of findings 1 to 3; no second
  devil run.
- Finding 4's primary sources: the plan closed with the advisory and
  minimatch's changelog unread, the tools to fetch them being denied then.
  They were read once those tools were allowed, before this record was
  written, and the record above rests on them: the static review found no
  incompatibility, the behavioural check was not run, and the decision did
  not change.
- The domain-auditor's pass, read-only, on the critical-path diff.
  Verdict: nothing must be fixed, and no invariant is weakened. It found
  the guard equal to `allowedModes()` for a posted category with a known
  account, NULL-safe on D1 and on node:sqlite, with 11 placeholders for 11
  parameters, and any future mode other than the account link failing
  closed; no bypass (the batch is the only writer of approval rows, its
  statements are bound to the approval id, the schema's trigger stands,
  and a SELECT that yields no row updates no voided row); the losing path
  withdrawing the notices first and doing nothing in the venue under
  lockdown; the stale press running behind the gates and writing nothing,
  a suspected-CSAM press getting no refresh; and the configuration's
  refusal one `CONFIG_INVALID` that names variables only, with no cause,
  the membership chat equal to the channel still loading. Its own runs:
  unit 86 files and 1,790 tests, invariants 16 files and 312 tests,
  workers 6 files and 41 tests, typecheck and lint clean, the docs gate
  green; the secret-shape and rules-sync scripts were denied to it, and
  the supervising session ran both. Four should-fix items, all low, all
  conceded:
  1. The losing path's card edit could throw (the step editor throws on a
     failed edit), so the error boundary would have logged `update.failed`
     and sent the generic error into the venue after the notices were
     withdrawn: fixed, the pending branch now uses the logging edit, with
     a test in which the card edit fails once (only
     `review.message_not_edited` logged, by class; no `update.failed`; no
     generic error in the venue).
  2. Intimate images in the post mode rested at the reply on the
     pre-check alone, the one layer before the batch, and no test reached
     it (a gap older than this change): a reply-level test added, and
     this record names both layers, the press-time refusal and the
     reply-time pre-check.
  3. Stale comments on the logging edits (`src/review/flow.ts`,
     `src/review/venue.ts`), on `endPrompt` (`src/review/approve.ts`) and
     in the header of `src/config/schema.ts`, which called the webhook
     secret a value not disclosed beyond the keyholder although Telegram
     holds it: fixed, comments only.
  4. The docs overstated the venue rule, which compares ids only: fixed in
     the docs pass (the developer setup, review and abuse controls, the
     threat model, the operations runbook, the admin review runbook and
     this record now say what the check refuses, what it cannot, and that
     the go-live checklist is the real control).

  And two notes: the affected duplicate after the approval commits, a
  residual to decide before go-live (Residuals, and the list below); and
  whether the new tests fail on the old code, which the auditor could not
  run (its scratch copy was denied) and argued by analysis.
- Mutation checks, observed by the implementer, who undid each fix in turn
  and ran the tests: the old guard failed 5 unit tests, 4 D1 tests and 1
  invariant test; a guard refusing every post-mode approval failed the D1
  parity table; the stale press without its refresh failed 2 tests; the
  old losing path failed 2; a throwing card edit on the losing path failed
  the failing-edit test (`update.failed` logged); and the pre-check without
  its routing check failed the new reply test, both keyholders receiving a
  notice that carried the post URL.
- The module map: the supervising session changed CLAUDE.md's row for
  `src/config/` to `yes (2, 3, 5, 6, 7, 8)`, the rules the schema's
  header now cites. The row lies outside the synced invariants block, and
  AGENTS.md has no module map, so no sync was needed; the
  [developer setup](../guides/developer-setup.md), sections 6 and 9, says
  the same.
- Final validation, observed by the supervising session on the final
  tree: `npm run build` clean (typecheck and lint); `npm test`, 92 files
  and 1,833 tests (1,792 unit and 41 workers), passed;
  `npm run test:invariants`, 16 files and 312 tests, passed. Re-run on the
  final tree with the same results as before the domain audit's fixes:
  `.claude/hooks/secret-shape-scan.sh` exit 0 with no output;
  `.claude/hooks/rules-sync-check.sh` "3 copies in sync";
  `bash selftest/run-all.sh`, 380 assertions ok, the critical-globs
  completeness and the tripwire patterns included;
  `bash selftest-okf/run-all.sh` passed (42 and 15);
  `node scripts/okf/check.mjs` green; `npm audit --omit=dev`, 0
  vulnerabilities; `npm audit`, 9 moderate entries, the one advisory. The
  three original reproductions, run again on the fixed tree before the
  domain audit's fixes: no approval and no channel message (finding 1);
  the three unsafe venues refused, the membership chat equal to the channel
  loading, and no bot buildable with the venue equal to the channel
  (finding 2); one-character secrets refused (finding 3).

## For the owner to confirm

Decisions this change took without the owner, built and documented, for
the owner to confirm or overturn:

- The silent restart at the category step: when a report changes under an
  approval (a duplicate by the affected person raises its flag, or a
  keyholder cancels another admin's approval and the flag reads cleared),
  the admin's approval is refused and starts again at the category step,
  the prompt and the reply deleted, with no message saying why: the card's
  own flag line shows it. A message would need a new catalog string in
  both languages.
- The four pairs that must differ: the webhook secret and the path
  segment; the reporter-reference key and each of the webhook secret, the
  path segment and the bot token.
- The two 32-character floors: `WEBHOOK_SECRET` 32 to 256 characters,
  `REPORTER_REF_KEY` at least 32.
- The negative-only venue: `ADMIN_CHAT_ID` must be a negative id (a user's
  private chat is refused), never the channel's or the membership chat's.
- The two residuals: no minimatch override while the stable consumers
  declare ^10 (finding 4); and no signal to the admins of a duplicate by
  the affected person that arrives after the approval was written, to
  decide before go-live.

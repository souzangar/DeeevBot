---
type: audit
title: "Kit install audit (2026-10-28)"
description: "What the claude-project-kit and claude-okf-kit install verified on this machine, the selftest fixture bug found in both kits and patched, the angel's review with its dispositions, and what is still open."
status: active
tags: [audit, tooling, kit, install]
timestamp: 2026-10-28T00:00:00Z
---

# Kit install audit (2026-10-28)

Both kits were installed as their INSTALL.md files prescribe (the kit docs
are copied to `.claude/kit-docs/`): the core `claude-project-kit`
(devil/angel/expert, commit gate, tripwire, statusline bridge, selftests,
memory seed) and the `claude-okf-kit` docs overlay (this bundle, its gates,
the Stop hook, the doc-scribe agent). Sources:
`~/Work/finowin/claude-project-kit.zip` and `~/Work/finowin/claude-okf-kit.zip`.

## Verified on this machine

| Check | Result |
|---|---|
| Prerequisites | git 2.56.0, bash 5.3, jq 1.8.1, node v22.22.3, codex-cli 0.164.0 |
| Exec bits on every `.sh` | preserved through the zip transfer |
| `bash selftest/run-all.sh` | green: devil-sh-invariants 59, hooks-behavior 28, statusline-smoke 6; the globs-completeness check is inert until `ANCHOR_PATTERN` is set |
| `bash selftest-okf/run-all.sh` | green after the fixture patch below: okf-gates 42, guard-behavior 15 |
| `node scripts/okf/check.mjs` | green (frontmatter, links, prose refs, index staleness) |
| `.claude/hooks/secret-shape-scan.sh` (the kit's, installed from its example) | exit 0 on the tree; exit 1 with path and count only on a planted token in a fixture; exit 2 outside a work tree |
| Commit gate on `git commit`, `INVARIANT_CMD` wired | "pre-commit gate passed" running the secret-shape scan, both selftest suites and the OKF gate (22 s after the re-sync); notes: no active globs, untracked files. Silent on non-commit commands |
| `DEVIL_DRY_RUN=1 devil.sh diff` | composes `codex exec --sandbox read-only --color never --json -C <repo> -c model_reasoning_effort="xhigh" -o <file> -`; notes "no active globs" (expected) |
| `devil.sh budget` | reads the live weekly window from codex's own logs (1% used); only the 7d window appears, see Open |
| Stop hook `okf-guard.sh` | exit 0 with the bundle implicated and the gate green |
| Angel wrapup review, two rounds | ran on the angel's model at max effort with the agent definition inlined (the agent file was not yet registered when it started); objections and dispositions below |
| Pinned agent spawns by name | `angel` runs as claude-fable-5-1 at max effort; `expert` as claude-opus-5-5 at max effort; `doc-scribe` reports the bundle configured, lists the conventions and leaves the gate green; all three read-only |
| Re-sync to the rebuilt kits (project kit zip of 2026-10-28 05:04) | only the gate's `INVARIANT_CMD` line and the OKF Stop block differ from the kit; core selftests 355 assertions green (devil-sh-invariants 259, hooks-behavior 41, statusline-smoke 55); OKF 42 and 15; the installed devil.sh refuses `diff` on the unborn HEAD as designed |
| Second re-sync (project kit zip of 2026-10-28 05:37, the live-run folds) | devil.sh, its selftest and the kit README/INSTALL updated; core selftests 356 assertions green; the kit's pristine baseline is 359 because three starter-file cases cannot run once the starters are consumed by the install, and the zip of the same evening prints a loud `skip:` line for them; the pre-flight now prints its quota rule above the readings; gate chain 24 s |
| Rule layout ruling applied (owner, 2026-10-28) | the three-copy layout stays; the seven rules sit between `<!-- sync:catastrophic-invariants -->` markers as identical plain text in CLAUDE.md, AGENTS.md and the devil's invariants file; `.claude/hooks/rules-sync-check.sh` is the first commit-gate step: "3 copies in sync" on the tree, red with the differing pair named on a one-word canary edit; core selftests 362 assertions green with the three expected starter skips; gate chain 22 s |
| First live devil round on codex-cli 0.164.0 | `devil.sh --detach plan --expect KITSYNC-R1` on the re-install brief, strong lane (gpt-6-astra): pre-flight, brief stamp, codex start, session-id capture and the audit footer all worked; no directory trust prompt; about 7 min; verdict FIX-FIRST with two objections, both conceded (Round 3 below) |

## Finding 1: both kits' selftests assume the as-shipped EDIT-ME state

- `selftest/hooks-behavior.sh` ran the INSTALLED hooks and expected their
  shipped state: the gate's "not configured" notice in 8 assertions and an
  empty `BANNED_PATTERNS` in 5 more (it derives its armed tripwire with a
  `sed` that only matches the empty slot, and the gate's `config_notes`
  greps the sibling for the empty slot). After INSTALL step 3 the suite
  goes red: verified on isolated copies, 8 of 28 failed with
  `INVARIANT_CMD="true"`, 5 of 28 with `BANNED_PATTERNS='fetch\('`. The
  go-live checklist's own item, wiring `bash selftest/run-all.sh` into
  `INVARIANT_CMD`, was therefore unreachable.
- `selftest-okf/okf-gates.sh` copied the INSTALLED manifest and expected the
  shipped template's refusal in cases 1 and 1b. After INSTALL step 3 sets
  `template: false`, both cases fail unconditionally, so step 6 of the same
  INSTALL can never go green. Observed here: 2 of 42 failed.

Patched, test-only, in this repository's copies:

- `hooks-behavior.sh` now runs every case against copies of both hooks
  with their EDIT-ME slots blanked (gate: the three command slots;
  tripwire: `BANNED_PATTERNS`), the tripwire copy placed beside the gate
  copy so the gate's `config_notes` finds its sibling. It is the sed
  technique the suite already used for `cfg_fail`, `cfg_pass` and `armed`.
- `okf-gates.sh` resets the copied manifest to `template: true` before
  cases 1 and 1b (a no-op on a pristine kit). The kit's maintenance session
  shipped the same fix in a rebuilt `claude-okf-kit.zip` on 2026-10-28; the
  installed copy, the kit README and INSTALL now match that zip.

Re-verified: hooks-behavior 28/28 against the pristine hooks and against a
copy with both `INVARIANT_CMD` and `BANNED_PATTERNS` configured; okf-gates
42/42. Both patches were sent, with the other findings below, to the kit's
maintenance session on 2026-10-28; it shipped equivalent fixes in rebuilt
zips the same day, and the installed selftests are now the kits' own.

## Review round: angel wrapup (2026-10-28)

Objections raised by the angel and what was done with each:

- The hooks-behavior patch covered only the gate half: adopted, see
  Finding 1.
- `INVARIANT_CMD` left empty on the false premise "stack undecided" while
  CLAUDE.md itself lists stack-independent commands: adopted; wired with
  the token scan, both selftest suites and the OKF gate (8 s per commit).
- The planned real codex round would run against an unborn HEAD, so the
  diff/wrapup prompts open with three failing git commands: adopted;
  deferred until the owner's first commit (see Open).
- The EDIT-ME paragraphs misdescribed the mechanics: with no active globs
  neither devil.sh nor the gate reaches the placeholder check, codex reads
  AGENTS.md regardless, and the domain-auditor audits against concrete
  rules even while the marker stands: adopted; reworded in all three files.
- Seven "must not" rules with no regression tests: adopted in part. Rule 6
  has the kit's `.claude/hooks/secret-shape-scan.sh` (first a bespoke token
  scan, replaced by the kit's scan at the re-sync); rules 1 to 5 and 7 need
  code and are deferred to the change that implements them (recorded in
  Open).
- Domain objections (broadcasting suspected-CSAM links; reporter text and
  victim data reaching the user base; update authenticity; retention;
  consent; the review runbook; coordinated-reporting policies; the admin
  allowlist is config, not a secret): adopted as amendments to draft rules
  2 to 7 and as the open questions in `doc/product/project-brief.md`.
  Nothing is decided on the owner's behalf; rule 7 is marked as narrowing
  the brief for one category.
- Suggestions adopted: the owner's brief quoted verbatim; the settings
  recipe below carries the two OKF permission lines; "fixed by the brief"
  wording in CLAUDE.md replaced by "pending planning".

Round 2, after the fixes: the angel re-verified the three fixes in the tree
(suites, gate run, token script on fixtures, kit-file drift against the
zips, rule text identical across the three files, EDIT-ME wording against
the scripts) and raised seven wording defects in the draft rules, all
adopted: rule 1 scoped to broadcasts (not every message); rule 3 limited to
the broadcast text, with the routing of a private-data report's link made
an open question; rule 4 binds the bot, admin verification of non-CSAM
content moved to the review runbook (metadata-only review would have made
approval a rubber stamp and the bot a brigading tool against innocents);
rule 6's test claim narrowed to the token scan; rule 7 routes on the
admin's categorisation, the reporter's label being a hint only; the
AGENTS.md intro line aligned with rule 5; the brief's legal statements
hedged. Two open questions were added (private-data routing; verification
standard, reporter abuse and retraction). The token script got a header
note on its deliberately unanchored pattern and a clean failure outside a
git repository.

Round 3, the devil (codex) on the kit re-install plan, 2026-10-28: two
objections, both conceded and folded before the re-install ran. The install
manifest omitted the scan's `.example` sibling, which the rebuilt
hooks-behavior selftest executes, so it is installed beside the scan. The
brief's premise listed a grep result from memory instead of running it and
missed the rule-6 references in AGENTS.md and the devil's invariants file;
all three synced files were repointed together. Audit footer:
`DEVIL_RUN: mode=plan base=n/a critical=0 escalate=1 effort=xhigh model=gpt-6-astra`,
`DEVIL_QUOTA: 7d[used=1% left=99%]`, session 01a181cc-4321-72d3-8ab2-20d0979b9e3c,
brief sha256 d0ad9d795e25fc46db781948cee062c24127ca66129613f0b6eedf4ef91379ad.

Layout ruling, 2026-10-28: the owner kept the three-copy layout over a
CLAUDE.md import, a symlink, or a pointer-plus-injection scheme (a devil
round on the import recommendation found its context-neutrality premise
false: codex reads CLAUDE.md in full but does not expand an import line,
and plan runs inject no invariants). Hand-sync drift, the recorded failure
mode, is now mechanical: the kit ships the marker-fenced block and the
`rules-sync-check.sh` gate, applied here the same day.

Findings sent to the kit's maintenance session for the kit sources: the
two selftest patches; INSTALL's real-round step presuming a commit (and a
devil.sh guard for an unborn HEAD); the 5h window missing from `budget` on
codex-cli 0.164.0; the two OKF permission lines missing from the settings
example and the classifier refusing a session-written settings file; the
undefined error-handling convention; agents registering only in a fresh
session; invariant scripts outside `selftest/` not syntax-checked; the
secret-shape scan as a kit pattern.

## Open

- `.claude/settings.local.json` (statusline wiring and the least-privilege
  permission starters) has to be created by hand: Claude Code's auto-mode
  classifier refuses to let a session write its own permission config.
  Copy `.claude/settings.local.json.example` (it now carries
  `refreshInterval: 30` for the prompt-cache countdown), replace
  `<ABSOLUTE-PATH-TO-REPO>` with `/home/azadi/Work/daeva/div-report`, and
  add `Bash(bash selftest-okf/*.sh)` and `Bash(node scripts/okf/*.mjs)` to
  the allow list.
- INSTALL's `diff HEAD sanity check` plus one `reply` still wait for the
  owner's initial commit: the rebuilt devil.sh refuses `diff` and `wrapup`
  on an unborn HEAD. The launch protocol, pre-flight, lanes and session-id
  capture are verified live in plan mode (table above); `codex exec` needed
  no trust entry for this directory.
- Pre-flight quota observation: the pre-flight reports the weekly window
  from an older, more pessimistic unexpired rollout (88% left, 17 h old)
  while `DEVIL_QUOTA` reports the newest reading (99% left). Conservative
  direction; reported to the kit's maintenance session.
- The five kit agents were registered by the harness only mid-session
  (verified afterwards: pinned spawns work, see the table). The hooks still
  need the one-time approval under `/hooks` (possibly a fresh `claude`
  session) before they fire inside Claude Code.
- Regression tests for draft rules 1 to 5 and 7 are deferred to the code
  that implements them, per the "must not ⇒ test in the same change" duty.
- CLAUDE.md now carries the kit's EDIT-ME "Error handling" section (AGENTS.md
  and the devil prompts judge work against it); planning fills it (open
  question 9 in the brief).
- Stack-dependent EDIT-MEs (commands, architecture map, build and test
  gate commands, tripwire patterns, critical globs, test conventions) and
  the owner's confirmation of the seven draft invariants are planning
  outputs. Confirming or amending a rule means editing the marked block in
  all three files verbatim in the same commit; the drift gate goes red
  otherwise, and each file's draft paragraph (outside the block) is deleted
  once the owner confirms.
- No CI exists yet. The hooks are convenience; CI running the same
  `INVARIANT_CMD` chain is the authority.
- Settled on 2026-10-28: the planning items in this list (the
  error-handling convention, the stack-dependent EDIT-MEs, and the owner's
  confirmation of the draft invariants) were decided in Phase 1 planning;
  see [Planning decisions (2026-10-28)](../product/planning-decisions-2026-10-28.md).
- Settled on 2026-11-18: CI now runs that chain. `.github/workflows/ci.yml`
  (GitHub Actions) runs the commit gate's build and test steps, then the
  same `INVARIANT_CMD` chain in the gate's order, on a push and on a pull
  request to `main`. It was rehearsed locally that day, before its first
  push; see
  [Developer setup](../guides/developer-setup.md), section 3, "Continuous
  integration".

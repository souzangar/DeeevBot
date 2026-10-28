# claude-project-kit

The portable core of a battle-tested Claude Code working setup, extracted
from a production backend so a new, unrelated project can start with the
same discipline: **adversarial planning (/devil), strongest-model counsel
(/angel), supervised delegation (/expert), commit gating, critical-path
tripwires, and a seeded memory of hard-won working rules.**

The critics are deliberately asymmetric: the Claude-side ones are bounded
only by your session quota and carry the argument, while the codex devil
spends a scarce external quota and is kept as **one terminal shot** — the
measured reason why is in `WORKFLOW.md` ("Spending the devil").

Everything project-specific was stripped; what remains is the machinery and
the operating model. The kit is **inert until configured** — nothing blocks
or fires until you fill in the EDIT-ME slots — but it is *loudly* inert:
the commit gate and devil.sh tell you what is still unconfigured.

- `INSTALL.md` — copy, configure, verify (step by step, new machine included)
- `WORKFLOW.md` — the operating model the pieces implement
- `selftest/` — run `bash selftest/run-all.sh` after copying; it pins the
  safety invariants of the scripts (read-only sandbox, uuid-only reply,
  option-injection safety, clean no-ops, the `DEVIL_FAILED` failure marker,
  the `--detach` launch, the pre-flight, the model lanes, the status line).
  It pins the SHIPPED contract of the hooks against blanked copies, so it
  stays green after you fill in the hooks' slots (it is meant to stay in the
  commit gate)
- the **Synced 2026-10-28** note at the end of this file — what the last
  sync from the source project ported, folded in and deliberately skipped

## Inventory

| Piece | Path | What it is |
|---|---|---|
| /devil command | `.claude/commands/devil.md` | Summon the codex devil's advocate; the detached launch recipe (`--detach`, the log's last line decides, TERM cancels), `--expect` briefs, what a pre-flight refusal means; objection-answering protocol |
| devil.sh | `.claude/scripts/devil.sh` | The ONLY codex entrypoint: read-only critic; plan/diff/wrapup/reply modes + a free `budget` readout; `--detach` launch (own session, log, `DEVIL_PID`, TERM cancels); `DEVIL_FAILED:` on every failure path; a pre-flight before anything is spent (model offered by codex? weekly window ≥ the run's cost + 1?); model lanes (strong for plan/critical-path runs, cheap otherwise, `DEVIL_MODEL*` override); `--expect`-checked, premise-checked, hash-stamped briefs; refuses diff/wrapup in a repo with no commit; session continuity; escalation by default; `-- <paths>` review scoping; every run ends with an audit footer (`DEVIL_RUN` config record + `DEVIL_QUOTA` remaining budget) |
| /angel command + agent | `.claude/commands/angel.md`, `.claude/agents/angel.md` | Blunt strongest-model advisor (plan/diff/stuck/wrapup); plan briefs lead with a premise it re-checks; 1h prompt cache (resumed agent) |
| /expert command + agent | `.claude/commands/expert.md`, `.claude/agents/expert.md` | Strong-model implementer; never commits; supervised by the session; 1h prompt cache (resumed agent) |
| domain-auditor agent | `.claude/agents/domain-auditor.md` | Read-only auditor of critical-path diffs against your declared invariants |
| test-writer agent | `.claude/agents/test-writer.md` | Writes tests to house conventions; owns the "must not ⇒ regression test" duty |
| Commit gate hook | `.claude/hooks/pre-commit-check.sh` | Gates `git commit` on your build/tests/invariant specs; log-to-file, compact failure summary. Best-effort command matcher; validates the working tree (drift is reported, not prevented) — CI is the authority |
| Critical-path tripwire | `.claude/hooks/critical-path-tripwire.sh` | Authoring-time reminder when added lines in critical files match banned patterns |
| Critical-path config | `.claude/devil/critical-globs.conf.example`, `critical-invariants.md.example` | ONE data file scopes both devil escalation and the tripwire; one invariants file feeds critic prompts |
| Day-one invariant | `.claude/hooks/secret-shape-scan.sh.example` | Stack-free, fail-closed scan for secret-shaped strings in tracked and untracked-not-ignored files (`git grep -E`; prints paths and counts, never the secret). The recommended FIRST `INVARIANT_CMD` step of a brand-new repo |
| Rules drift gate | `.claude/hooks/rules-sync-check.sh` | The catastrophic invariants live, deliberately, in THREE native-context copies (CLAUDE.md, AGENTS.md, `.claude/devil/critical-invariants.md`); this check diffs the marked block across them and goes red on drift — the hand-sync duty made mechanical. Wire into `INVARIANT_CMD` |
| Statusline + quota bridge | `.claude/scripts/statusline-quota.sh` | Status line that mirrors the real 5h/7d rate-limit budget to `.claude/state/quota.json` for quota-aware long runs, plus the per-model weekly floor (`≥NN%`), the prompt-cache countdown, effort, the active-model tag and fast/>200k markers — all mirrored |
| Hook wiring | `.claude/settings.json` | PreToolUse commit gate + PostToolUse tripwire |
| Per-user settings | `.claude/settings.local.json.example` | Statusline wiring (with the `refreshInterval` the countdown needs) + least-privilege permission starters; a HUMAN creates it (a fresh install saw Claude Code refuse a session writing its own permission/statusline file; the file is strict JSON, so it carries no comments) |
| Rules starter | `CLAUDE.md.starter` | The portable rules (plan→critic closure, delegation, commit style, testing duties) + EDIT-ME slots, including the Error handling section the critics' prompts refer to |
| Codex mirror starter | `AGENTS.md.starter` | Thin pointer to CLAUDE.md + inlined catastrophic invariants (what the critic reads) |
| Memory seed | `memory-seed/` | 17 genericized working-rule memories + index, ready to drop into the new project's Claude memory |
| Self-tests | `selftest/` | Regression guard for the scripts' safety invariants + hook behavior (pinned against blanked copies, so green before AND after you configure the slots) + statusline render/mirror + the secret scan. `selftest/run-all.sh` syntax-sweeps `.claude/` and `selftest/`; list your own invariant-script directories in its `EXTRA_SYNTAX_DIRS`. The TOTAL varies by machine — unhostable cases print loud `skip:` lines |
| Gitignore additions | `gitignore.snippet` | `.claude/state` (a symlink to tmpfs — no trailing slash), `settings.local.json` |

## What was deliberately left behind

The source repo's domain rules are not portable, but each is a **pattern
worth re-creating** for your own domain:

- **Domain invariants** (there: money-safety rules) → write yours into
  `CLAUDE.md` + `AGENTS.md` + `.claude/devil/critical-invariants.md`; the
  shipped `domain-auditor` is the generic form of what was a specialized
  money auditor.
- **Always-run invariant test suite** — tests that FS-walk the tree and pin
  global "must never happen" rules, run on every commit via the gate's
  `INVARIANT_CMD` slot (changed-file test selection never picks them up).
- **Coverage-completeness test** — the globs file keeps devil.sh and the
  tripwire in agreement, but only an anchor test ("every file importing
  <critical helper> must be matched by the globs") proves the globs cover
  everything. Skeleton: `selftest/critical-globs-completeness.sh`.
- **Docs-as-deliverable culture** — every feature ships with its doc; keep
  the rule, choose your own docs system. The source repo *enforced* it with
  a Stop hook (a script that blocks ending the turn while the docs gate
  fails) — a pattern worth copying once you have a docs check to run.
- **One tripwire per critical domain** — the source repo ran TWO PostToolUse
  tripwires (different domains, different patterns and reminders). The
  shipped hook holds ONE pattern set; to guard a second unrelated domain,
  duplicate the hook file under a new name and add a matching entry in
  `.claude/settings.json` rather than cramming both into one regex.

## Security notes (read before trusting the labels)

- **devil (codex) is sandbox-ENFORCED read-only** — `--sandbox read-only`
  is hardcoded in devil.sh; no env var or mode widens it. The selftest pins
  this.
- **angel / domain-auditor are read-only BY INSTRUCTION** — their agent
  definitions restrict tools to Read/Grep/Glob/Bash and instruct
  non-mutation, but Bash is not a sandbox. Treat "read-only" for Claude
  subagents as a convention you audit, not a guarantee.
- **The expert's "never commits" is also instruction-only** — it runs with
  FULL tools, making it the highest-risk by-instruction guarantee in the
  kit. The supervising session reviewing every diff and making every commit
  is the actual control; keep that duty real.
- The two `.claude/devil/*` config files are **data, never executed** —
  read line-by-line and pattern-matched.
- `.claude/state/` contains session ids and usage telemetry — keep it
  gitignored (INSTALL step 1 appends the rules; in the kit they live in
  `gitignore.snippet`).
- **The commit gate is a convenience, not an authority** — its command
  matcher is best-effort and it validates the working tree (tree≠commit
  drift is reported, not prevented). Run the same gates in CI as the
  backstop.

## Sync log

### Synced 2026-10-28 (from finowin commit `fc8ab1a4`; the previous sync was 2026-08-31 from `e59a8949`)

Ported, in upstream order:

1. **Model lanes replace the sniffing rungs** (`12d0e406`). `DEVIL_RUN` no
   longer resolves the model through the explicit knob, then the event
   stream, then `~/.codex/config.toml` — those rungs were dead once the
   script chooses and were a forgery surface. `devil.sh` now picks the model
   by what the run is worth: `plan` and any critical-path diff/wrapup take
   the strong lane (`gpt-6-astra`), every other run the cheap lane
   (`gpt-5.6-terra`); `DEVIL_MODEL` always wins; the `DEVIL_RUN` line prints
   the choice (the effort still resolves knob → codex config). Upstream
   hardcodes the two slugs, so the kit adds `DEVIL_MODEL_CRITICAL` /
   `DEVIL_MODEL_DEFAULT` to re-point one lane each. The Pro re-baseline (a
   plan run ≈ one point of the weekly cap) is in `WORKFLOW.md`, with the
   2026-08 Plus figures kept as what the older findings rest on.
2. **Detach + the `DEVIL_FAILED` protocol** (`89f42427`). `devil.sh --detach
   <mode> <args>` validates in the foreground (dry run; a refusal creates
   nothing), starts the run in its own session through a portable double
   fork, prints `DEVIL_DETACHED_LOG:` and returns once the child's `DEVIL_PID:`
   line exists (a child silent for 10 s, or a launcher that is TERMed
   meanwhile, stops it). Every failure path prints one sanitised
   `DEVIL_FAILED: <reason>` line on stdout as the LAST line — the codex
   non-zero exit included, with codex's own reason — `DEVIL_START:` marks the
   moment codex is invoked, TERM is forwarded to codex (exit 143), relayed
   codex output is indented so it cannot forge a machine line, and the log's
   last line decides (`DEVIL_LOG:` = done, `DEVIL_FAILED:` = failed). The old
   "generous timeout or run_in_background" launch advice is gone from every
   text — it killed runs.
3. **Pre-flight + stamped briefs** (`2ae9e1be`). After the model is chosen and
   before anything is spent: the slug must be in codex's own
   `models_cache.json` (hidden = warn, absent = refuse, unreadable = not
   checked) and the freshest unexpired reading of each rate-limit window must
   leave the run's cost + 1 point (plan 1, critical diff 2, reply 4; a spent
   5h window refuses; a reading's age never un-refuses; unknown is "not
   headroom"); `DEVIL_FORCE=1` skips both, a dry run only prints, `--detach`
   validation and real runs refuse. The newest rollout is picked by mtime;
   `CODEX_HOME` is honoured on the session-id fallback. Briefs:
   `--expect <marker>` (plan/wrapup) refuses a stale file, a plan brief needs
   a Premise heading, a NUL byte is refused, and `DEVIL_BRIEF:` records the
   sha256, size and mtime of the bytes attacked.
4. **Status line** (`3ff2d827`, `a3de5289`). Per-model weekly floor read from
   the CLI's own usage cache in `~/.claude.json` (`≥NN%` with its age, `?`
   past the cached window's reset), mirrored into `quota.json` as
   `model_weekly[]` plus the generic `model_pct` / `model_name` /
   `model_age_s` of the row matching the ACTIVE model (upstream's
   `fable_*` keys are policy-specific; the mechanism is identical), with the
   sub-second-mtime cache stamp and 60 s ceiling; the prompt-cache countdown
   from the stdin `prompt_cache` object, effort, the model tag (yellow when
   it differs from the user settings), fast mode, the >200k marker and ctx
   painted at 60/80 — all mirrored. `statusLine.refreshInterval` (30) added to
   `settings.local.json.example`.
5. **1h prompt cache** (`7a9b6164`) on `angel` and `expert` only (both are
   resumed after a devil wait); one-shot agents must not get it.
6. **Texts.** `/devil` (detach recipe, `--expect`, what a refusal means),
   `/angel` (premise-first plan briefs, on-disk-brief verification), the angel
   agent (premise attack), `CLAUDE.md.starter` and `AGENTS.md.starter`
   (detach recipe, premise-first), `WORKFLOW.md` (cost table + Pro note).

**First-install field report folded** (a real fresh install of the 08-31 kit):

- `selftest/hooks-behavior.sh` was red after INSTALL's own configure step (it
  expected the hooks' empty slots); it now pins the SHIPPED contract against
  blanked copies, green before and after.
- `devil.sh diff`/`wrapup` on a repo with no commit died rc=128 inside a paid
  run; they now refuse up front (`DEVIL_FAILED: this repository has no commit
  yet`). INSTALL's real round says "after the initial commit".
- Pre-flight/budget fixtures cover codex-cli 0.164's snapshot (a single
  primary weekly window, `limit_id`/`limit_name`, `secondary: null`) and the
  old two-window shape; an absent 5h window neither refuses nor errors.
- INSTALL: a HUMAN creates `.claude/settings.local.json`; agents register at
  session start (start a new session after copying).
- `CLAUDE.md.starter` gains the Error handling section the prompts refer to.
- `selftest/run-all.sh`: `EXTRA_SYNTAX_DIRS` for project invariant scripts
  (and `*.sh.example` templates are swept).
- New `.claude/hooks/secret-shape-scan.sh.example` — the stack-free first
  invariant, with selftest cases.

Resolved differently from upstream, or beyond it:

- The kit fork had relaxed the plan/wrapup file check from `-f && -r` to `-r`;
  restored (a directory is refused).
- Portability: one helper per GNU/BSD split (`file_mtime`, `fmt_when`,
  `sha256_hex`, `mk_tmp`); array handling safe for bash 3.2 under `set -u`; perl's
  `POSIX::setsid` where there is no `setsid`; the status line parses ISO
  reset times in jq and avoids `mapfile`/`date -d <iso>`. Not exercised on
  macOS or bash 3.2 itself — the selftest covers a BSD-style `mktemp` and a
  setsid-less PATH by stand-ins only.
- A `reply` is not critical by itself, so it takes the cheap lane unless
  `DEVIL_MODEL` names the model its session started on (upstream behaviour,
  now stated).
- `refreshInterval` carries no inline comment: JSON has none, so INSTALL step 4
  explains it.
- The 08-31 scarcity framing (devil = one terminal shot) is kept; upstream's
  later Pro-plan policy (devil as a per-round critic, mandatory money diff) is
  an owner ruling about one account, not part of the portable core.
- Live-verified 2026-10-28 on codex-cli 0.164.0 (first real install): a
  detached `plan` round ran end to end — pre-flight (model offered, 7d gate),
  `DEVIL_BRIEF`/`--expect`, `DEVIL_START`, critique, `DEVIL_RUN`/`DEVIL_QUOTA`
  footer, session id captured from the event stream, `DEVIL_LOG:` as the last
  line, launcher returned at once. Same install confirmed the unborn-HEAD
  refusal and that `codex exec` needs no `trust_level` entry (TUI-only).
- The selftest TOTAL varies by machine and by install state: a case the host
  can't run (no setsid, no perl, …) and a case whose subject file is gone (the
  `.starter` files are consumed by INSTALL step 2; a project may drop the
  angel) print a loud `skip:` line instead of silently passing — compare skip
  lines, not totals. Pristine kit on a full host: 365, zero skips.
- **Ruling 2026-10-28 (owner, after a FIX-FIRST devil round on the
  alternatives): the catastrophic rules stay in THREE copies on purpose** —
  CLAUDE.md body (Claude's auto-context; an `@`-import was rejected because
  the codex prompt reads CLAUDE.md directly on plan runs and codex does not
  expand imports), AGENTS.md inline (the critic's auto-context) and
  `.claude/devil/critical-invariants.md` (prompt-injected on critical runs).
  A symlink was rejected (zip materializes it into a silently drifting copy);
  always-inject-plus-pointer was rejected (empties the critic's auto-context
  for no saving). The one recorded failure mode — hand-sync drift — is now
  mechanical: the block is marker-fenced in all three files and
  `.claude/hooks/rules-sync-check.sh` diffs them (six selftest cases).

Deliberately NOT ported (drift from the source project): its governance
easy/strict modes; the Fable lane gate and budget nudge hooks (and the
`fable_pct` budget reads in `/angel`); the jest guard; memory-guard and
memory-lint; local-doc; box-rehearsal; the vendor-docs machinery; the
Review-trailer / stamp commit ceremonies in `pre-commit-check.sh` (the kit's
hook template stays as it is); the money-integrity auditor's additions (the
kit's `domain-auditor` is its own generic template); the easy-mode "unpinned"
notes on agents; and the Persian-copy `copy` mode of `devil.sh` (no mode or
code path of it remains; `devil.sh copy` is an unknown mode).

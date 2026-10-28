# INSTALL — bringing the kit into a new project

Target: a fresh git repository on a machine that may never have run any of
this before. Follow in order; nothing here requires the source project.

**Who does what.** A Claude session can carry out every step below itself,
with two exceptions: step 4 (a fresh install showed Claude Code refusing a
session that writes its own permission/statusline file, so a **human**
creates `.claude/settings.local.json`) and the account steps (`codex login`, starting
`claude` once). Agents and hooks register at **session start**: after
copying the kit (step 1), start a NEW session before you check `/angel`,
`/expert` or the commit gate.

> **Synced 2026-10-28** (from finowin commit `fc8ab1a4`). What changed for an
> installer, in short — the full note is at the end of `README.md`:
> - **devil.sh**: launch with `--detach` and read the log's last line
>   (`DEVIL_LOG:` = done, `DEVIL_FAILED:` = failed); every failure prints one
>   `DEVIL_FAILED: <reason>` line; a pre-flight refuses a model codex does not
>   offer and a weekly window below the run's cost + 1 *before* anything is
>   spent; the model follows the run (strong lane for plan/critical-path,
>   cheap lane otherwise — re-point it with `DEVIL_MODEL_CRITICAL` /
>   `DEVIL_MODEL_DEFAULT`); a plan brief needs a **Premise** heading and can
>   be pinned with `--expect <marker>`; `diff`/`wrapup` refuse a repo with no
>   commit yet.
> - **Status line**: per-model weekly floor, prompt-cache countdown, effort,
>   model tag — add `statusLine.refreshInterval` (step 4).
> - **Agents**: 1h prompt cache on `angel` and `expert` only.
> - **Selftest**: pins the hooks' *shipped* contract against blanked copies, so
>   it is green before AND after step 3; `EXTRA_SYNTAX_DIRS` in
>   `selftest/run-all.sh` extends its syntax sweep to your own scripts.
> - **New**: `.claude/hooks/secret-shape-scan.sh.example` — the stack-free
>   first invariant (step 3).
> - Deliberately left out (source-project-only): its process-governance
>   modes, per-model lane gates and budget nudges, jest/memory guards, doc
>   builders, deploy rehearsal, vendor-docs machinery, commit-trailer
>   ceremonies, the money auditor's rules and the Persian-copy `copy` mode.

## 0. Prerequisites

Required:
- **git**, **bash**, **jq** (the hooks and devil.sh parse JSON with jq;
  without it the commit gate degrades loudly and the tripwire silently
  skips — install it).
- **Claude Code** signed in on the new machine. The status line's
  prompt-cache countdown needs 2.1.251+, the agents' 1h prompt cache 2.1.248+;
  an older version simply ignores both (nothing breaks).

Optional but recommended:
- **codex CLI** (the devil): install it, run `codex login`, and set your
  default model/effort in `~/.codex/config.toml`, e.g.
  ```toml
  model = "<your strongest codex model>"
  model_reasoning_effort = "high"
  ```
  On first INTERACTIVE run the codex TUI may ask to trust the new repo
  directory — accept, or pre-add a `[projects."<abs-path>"]
  trust_level = "trusted"` entry. `codex exec`, which devil.sh uses, runs
  without a trust entry (verified on codex-cli 0.164), so a missing entry
  never blocks the devil.
  Without codex, `/devil` is a clean no-op that says so.
  `devil.sh` launches long runs with `--detach`, which needs `nohup` and
  `setsid` (util-linux or BusyBox) — or perl, whose `POSIX::setsid` does the
  same call where there is no `setsid` (macOS). The pre-flight checks the
  chosen model against the list codex keeps in `~/.codex/models_cache.json`
  (until codex has run once and written it, that check is skipped — not
  failed).
- **Claude Pro/Max** — the statusline's 5h/7d quota numbers only exist on
  those plans; otherwise the statusline still renders context %.

## 1. Copy the files

From the kit into the new repo root:

```bash
cp -r  kit/.claude            <repo>/
cp     kit/CLAUDE.md.starter  <repo>/CLAUDE.md
cp     kit/AGENTS.md.starter  <repo>/AGENTS.md
cp -r  kit/selftest           <repo>/selftest   # must live at the repo root —
                                                # the tests resolve the .claude
                                                # tree from their own location
mkdir -p <repo>/.claude/kit-docs
cp     kit/README.md kit/INSTALL.md kit/WORKFLOW.md  <repo>/.claude/kit-docs/
cat    kit/gitignore.snippet >> <repo>/.gitignore
```

The `kit-docs` copy matters: the installed scripts point at
`.claude/kit-docs/INSTALL.md` in their notices, so the seeded repo stays
self-contained. Keep `memory-seed/` aside for step 5. Verify executable bits survived the
transfer: `find <repo>/.claude <repo>/selftest -name '*.sh' ! -perm -u+x`
must print nothing (if it does: `chmod +x` them — this happens when the kit
traveled through a zip tool that dropped modes).

**Then start a new Claude Code session in the repo.** Slash commands appear
almost at once, but agents under `.claude/agents/` register only at session
start (one was observed to take ~20 minutes to show up when added
mid-session), so a spawn check made in the copying session proves nothing.

## 2. Declare the project's rules

1. `CLAUDE.md` — fill every EDIT-ME: commands, architecture map, the
   **Critical invariants** section, and the **Error handling** section (the
   critics' prompts and AGENTS.md judge work against "error-handling rules",
   so they must be written down there).
2. `AGENTS.md` — inline the same catastrophic invariants, self-contained.
3. `.claude/devil/critical-globs.conf` — copy from the `.example`, list the
   globs of your critical modules.
4. `.claude/devil/critical-invariants.md` — copy from the `.example`, write
   the invariants as instructions to a hostile reviewer.

These four MUST stay in sync — CLAUDE.md's rules section states the
same-commit sync duty; the devil critiques against AGENTS.md, so a rule
missing there is invisible to the critic.

## 3. Configure the hooks

1. `.claude/hooks/pre-commit-check.sh` — fill `BUILD_CMD`, `TEST_CMD`,
   `INVARIANT_CMD` (leave a slot empty to skip it; keep each value on ONE
   line — put a longer command in a script and call that). Until configured,
   every commit prints a "not configured" notice and passes.
2. `.claude/hooks/critical-path-tripwire.sh` — fill `BANNED_PATTERNS` and
   the `REMINDER` text with your domain's forbidden shapes. Inert until
   both this and the globs file exist.
3. **Recommended first invariant — needs no stack, works on day one.** No
   secret-shaped string may sit in the tree:
   ```bash
   cp .claude/hooks/secret-shape-scan.sh.example .claude/hooks/secret-shape-scan.sh
   chmod +x .claude/hooks/secret-shape-scan.sh
   # keep the .example beside the installed copy — the selftest executes the
   # .example (shipped shapes), so deleting it sends hooks-behavior red
   # edit SHAPES (grep -E regexes of your secrets' SHAPES: a bot token, an API
   # key prefix ...), then make it the first step of the gate:
   #   INVARIANT_CMD=".claude/hooks/secret-shape-scan.sh"
   ```
   It is `git grep -E` over tracked files and untracked-not-ignored files,
   fail-closed (a scan that cannot run blocks, it never reads as clean), and
   prints paths and counts — never the secret. When your stack's specs
   arrive, chain them behind it: `INVARIANT_CMD="<scan> && <your specs>"`. A
   hit means the secret is already in your history: move it to the
   environment and rotate it.
4. **The catastrophic-rules drift gate** — `.claude/hooks/rules-sync-check.sh`
   needs no configuration. The same marked block
   (`<!-- sync:catastrophic-invariants -->` … `<!-- /sync… -->`) lives in
   CLAUDE.md, AGENTS.md and `.claude/devil/critical-invariants.md`; when you
   write your real rules, edit all three copies verbatim in the same commit —
   the check diffs them and goes red on drift (a deleted marker counts as
   drift; a consumed/absent file does not). **Upgrading an existing install:**
   fence the block in your live CLAUDE.md, AGENTS.md and
   `.claude/devil/critical-invariants.md` (copy it verbatim from any kit
   file) BEFORE re-running the selftest — the gate case runs on the
   installed files, and a present file without markers reads as drift.
   Chain it with the scan:
   ```bash
   #   INVARIANT_CMD=".claude/hooks/rules-sync-check.sh && .claude/hooks/secret-shape-scan.sh"
   ```

`bash selftest/run-all.sh` stays green whether these slots are filled or not:
it pins the hooks' shipped contract against blanked copies of them.

## 4. Per-user settings (statusline, permissions) — a HUMAN does this

Claude Code was seen refusing a session that writes its own
permission/statusline file, so do this one yourself: copy `.claude/settings.local.json.example` to
`.claude/settings.local.json` (it is gitignored) and replace
`<ABSOLUTE-PATH-TO-REPO>` with the real absolute path. The permission entries
are least-privilege starters for the devil script and quota reads; extend as
the project's real needs appear rather than pre-granting broadly. (Wildcard
matching in permission rules varies across Claude Code versions — if one
doesn't take effect you'll simply be prompted; re-add it in the form the
prompt offers.)

`"refreshInterval": 30` in the `statusLine` block is deliberate. (Settings
files are strict JSON — a `//` comment is a Settings Error — so the example
carries no comment and it is explained here.) Status-line renders are event-driven (a
new message, a mode change) and go quiet while a session idles, so the
prompt-cache countdown only ticks if Claude Code also re-runs the line on a
timer. Drop it if you do not want the countdown.

## 5. Seed the project memory

Claude Code keeps per-project memory at
`~/.claude/projects/<encoded-path>/memory/`. Do NOT derive `<encoded-path>`
by hand — the encoding dashes every non-alphanumeric character of the
absolute path (not just `/`; a repo at `.../my_app.web` gets its `.` and `_`
dashed too), and a guessed-wrong directory fails silently forever.

1. Start `claude` once inside the new repo, then exit — this creates the
   project directory.
2. Find the directory Claude just created (the newest entry):
   `ls -t ~/.claude/projects/ | head -1`
3. Copy `memory-seed/*.md` (including `MEMORY.md`) into `memory/` inside
   THAT directory (create only the `memory/` subdirectory, never the
   project directory itself).
4. On the next session, the memories load. Review them once — they encode
   the owner's working rules (delegation, critic protocol, quota habits) and
   should be edited if your preferences differ.

## 6. Verify

```bash
cd <repo>
bash selftest/run-all.sh          # pins the scripts' safety invariants; green before AND after step 3
# The TOTAL varies by machine AND install state: a case the host can't run
# (no setsid, no perl, …) or whose subject file is gone (the .starter files
# are consumed by step 2) prints a loud "skip:" line instead of silently
# passing — compare the skip lines, not the totals, when two runs disagree.
.claude/scripts/devil.sh budget   # reads codex's own logs; spends nothing
```

`budget` prints `DEVIL_QUOTA: unknown ...` plus `DEVIL_PREFLIGHT: quota
unknown — not headroom` until codex has run at least once on this machine —
the reading comes from codex's session logs, not from an API call. That is
expected on a fresh install, not a failure. Once a reading exists it shows
the weekly window (`7d[used=… left=… resets=…]`) and, on plans that have one,
the 5h window too; a window whose reset time has passed is stamped `EXPIRED
(assume refreshed)` — `codex /status` is the authoritative live view.

**After the initial commit** (`diff` and `wrapup` compare against HEAD and
refuse a repository with no commit yet — `DEVIL_FAILED: this repository has no
commit yet ...` — as do all real rounds below):

```bash
git add -A && git commit -m "chore: add the claude tooling kit"
DEVIL_DRY_RUN=1 .claude/scripts/devil.sh diff   # composes prompt+argv and prints the DEVIL_PREFLIGHT: lines; spends nothing
```

Then one REAL round on the destination (codex versions drift; the argv
ordering, session-id capture, and the rate-limit shape devil.sh reads were
verified against codex-cli 0.145.0 / 0.148.0, and the pre-flight's readers
against the files codex-cli 0.164.0 writes):

```bash
.claude/scripts/devil.sh --detach diff HEAD sanity check
```

It prints `DEVIL_DETACHED_LOG: <log>` and returns at once; `cat` that log. The
log runs `DEVIL_PID: <pid>`, the `DEVIL_PREFLIGHT:` lines, `DEVIL_START:` (codex
was invoked), then the critique and the footer `DEVIL_RUN:` + `DEVIL_QUOTA:` +
`DEVIL_SESSION: <uuid>` + `DEVIL_LOG:`. The log's LAST line decides: `DEVIL_LOG:`
= done, `DEVIL_FAILED: <reason>` = failed (`kill -TERM <pid>` cancels a run).

```bash
echo "test reply" > /tmp/rebuttal.md
.claude/scripts/devil.sh --detach reply <that-uuid> /tmp/rebuttal.md
```

A refusal prints one `DEVIL_FAILED: <reason>` line on stdout, exits 1 and
starts nothing. The usual ones: `model gpt-… not offered; listed: …` (your codex
account lacks a default lane model — set `DEVIL_MODEL_CRITICAL` /
`DEVIL_MODEL_DEFAULT`, step 7); `codex 7d quota left N% < the M% a … run needs`
(wait for the reset, or `DEVIL_FORCE=1` — say so when you use it); `… has no
commit yet`; `plan brief has no premise heading` / `… lacks the expected marker`
(fix the brief). That one real round is also the cheapest way to confirm the
budget wiring: after it, `devil.sh budget` reports the windows instead of
`unknown`.

In a **new** Claude session (agents register at session start — step 1): run
`/angel` with a trivial question (verifies the agent + model pin), and make a
throwaway commit to see the gate run. Note: on a fresh machine Claude Code may
require a one-time approval of the project's hooks before they fire — if the
throwaway commit shows no gate output at all, approve the hooks (check
`/hooks`) and retry rather than assuming the gate works.

## 7. Model pins

`.claude/agents/angel.md` pins `model: fable`; `.claude/agents/expert.md`
pins `model: opus`. If the destination account's plan doesn't offer a
pinned model, edit the frontmatter to the strongest available tier — keep
the intent: **angel = strongest model you have; expert = strong implementer
tier; both at max effort.** The commands deliberately forbid ad-hoc model
overrides at spawn time, so the frontmatter is the single place to change.
Verify the `effort: max` pin is honored on your Claude Code version too
(spawn /angel and check the reported model/effort); if the key is ignored
there, the pin is decorative — note it and rely on the model pin alone.

Both agents also carry `experimental: cacheTtl: "1h"` — a 1-hour prompt cache,
because both are resumed with SendMessage after a devil wait that a 5-minute
cache does not survive. It needs Claude Code 2.1.248+, is ignored on older
versions and while your subscription is drawing on usage credits, and belongs
on resumed agents ONLY: never add it to a one-shot agent (`domain-auditor`,
`test-writer`), where it only makes every run dearer.

The codex side has the same two-lane idea: `devil.sh` gives `plan` and
critical-path runs `gpt-6-astra` (`DEVIL_MODEL_CRITICAL`) and every other run
`gpt-5.6-terra` (`DEVIL_MODEL_DEFAULT`) — the source project's choice on a
ChatGPT Pro account. List what your account offers with
`jq -r '.models[] | "\(.slug) \(.visibility)"' ~/.codex/models_cache.json`
and re-point the lanes in the environment Claude Code runs in (your shell
profile, or the `env` map of `.claude/settings.local.json`). `DEVIL_MODEL` beats
both lanes for a single run.

## Go-live checklist

- [ ] CLAUDE.md + AGENTS.md invariants written and mirrored; the Error
      handling section of CLAUDE.md filled
- [ ] `critical-globs.conf` + `critical-invariants.md` in place (devil.sh
      stops printing its "unconfigured" note)
- [ ] Commit gate commands filled; a failing test actually blocks a commit
- [ ] The secret-shape scan wired as the first `INVARIANT_CMD` step; a planted
      token blocks a commit
- [ ] Tripwire patterns filled; a planted banned line triggers the reminder
- [ ] Real catastrophic rules written into ALL THREE marked blocks
      (CLAUDE.md, AGENTS.md, `.claude/devil/critical-invariants.md`) and
      `rules-sync-check.sh` green — wire it into `INVARIANT_CMD` so drift
      blocks commits
- [ ] `selftest/run-all.sh` green on the destination machine
- [ ] The initial commit made (the real devil rounds need it)
- [ ] One real `/devil` round-trip incl. `reply` on the destination, launched
      with `--detach`
- [ ] A NEW session started after copying; `/angel` and `/expert` spawn with
      their pinned models
- [ ] `.claude/settings.local.json` created by a human (statusline +
      `refreshInterval`)
- [ ] Memory seeded and reviewed
- [ ] `.gitignore` covers `.claude/state` + `.claude/settings.local.json`
- [ ] `bash selftest/run-all.sh` wired into the gate's `INVARIANT_CMD` (or
      CI) so the tooling's own safety pins re-run on every commit, not just
      once at install (it takes about 20 s: it exercises detach, cancellation
      and the launcher's 10 s deadline — drop it from the per-commit gate and
      run it in CI if that is too slow)
- [ ] CI runs the same build/test/invariant gates as the hook — the hook is
      a best-effort convenience (matcher can be slipped, tree≠commit drift
      is only reported); CI is the authority
- [ ] Your own shell invariant scripts' directory listed in
      `EXTRA_SYNTAX_DIRS` of `selftest/run-all.sh`
- [ ] (Later, as the domain solidifies) an anchor-based completeness test
      proves the globs cover every critical file — skeleton in
      `selftest/critical-globs-completeness.sh`

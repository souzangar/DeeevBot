---
description: Summon the codex devil's advocate (read-only critic) against a plan, the working diff, or a completion claim — then answer every objection.
argument-hint: "[budget|plan|diff|wrapup|reply <session-id>|free-text focus]"
---

Run an adversarial codex critique via `.claude/scripts/devil.sh` — the ONLY way
codex is ever invoked in this repo (read-only, never writes). Codex takes
minutes, so launch every mode except `budget` with `--detach`, from the repo
root (no `&`, no `setsid`: the script detaches itself and returns at once):

    .claude/scripts/devil.sh --detach <mode> <args...>

It checks codex, jq, the arguments and the pre-flight before anything
starts. "codex CLI not found" is a clean no-op, not an error (say so and
continue); a refusal (e.g. text passed where a file is required, a model the
codex cache does not list, a weekly quota below the run's cost plus one
point, a repository with no commit yet) prints `DEVIL_FAILED: <reason>` and
exits 1 with nothing running — fix the cause and relaunch (`DEVIL_FORCE=1`
overrides a pre-flight refusal; say so when you use it). Otherwise it prints
`DEVIL_DETACHED_LOG: <log>` and returns once the log's first line,
`DEVIL_PID: <pid>`, exists.
Read the log's first lines right after the launch: the `DEVIL_PREFLIGHT:`
lines, then `DEVIL_START:` (codex is running) and, for plan and wrapup,
`DEVIL_BRIEF:` (the hash of the bytes under attack). Then wait with a Monitor
until-loop (re-arm it if the Monitor expires first):

    log=<log>; until tail -n1 "$log" | grep -qE '^DEVIL_(LOG|FAILED):' || ! kill -0 "$(sed -n 's/^DEVIL_PID: //p' "$log")" 2>/dev/null; do sleep 20; done; tail -n 5 "$log"

The last line decides: `DEVIL_LOG:` = done, `DEVIL_FAILED:` = failed. Never
grep the whole log for them — a critique may quote a marker mid-log. A run
whose process is gone while its last line is neither died without a word
(e.g. killed by the system): treat it as failed. Cancel a run with
`kill -TERM <DEVIL_PID>`: codex stops and the log ends with
`DEVIL_FAILED: terminated by signal`. Never a Bash timeout or
run_in_background: the harness kills codex before it finishes.

**The devil is scarce and terminal.** It spends a real, exhaustible codex
quota, so the Claude lane runs FIRST and in full (own verification, /angel,
the harness's code-review/security-review passes, domain-auditor, the
invariant tests), and codex is the single last gate on top of it. Check
`devil.sh budget` before spending — it reads codex's own logs and costs
nothing. `plan` is the mandated pass on critical-path designs; `diff` and
`wrapup` are discretionary — skip the devil diff when the design was already
devil-closed, and note the skip in the commit body. Policy + cost model:
`.claude/kit-docs/WORKFLOW.md`.

Model/effort: the script picks the model itself — `DEVIL_MODEL` always wins;
with it unset, `plan` and any critical-path run take the strong lane
(`DEVIL_MODEL_CRITICAL`, default `gpt-6-astra`) and every other run the cheap
lane (`DEVIL_MODEL_DEFAULT`, default `gpt-5.6-terra`); the `DEVIL_RUN:` line
prints the choice. If your codex account does not offer those slugs the
pre-flight refuses and lists the ones it does — point the lanes at them.
Reasoning effort escalates on EVERY run (a run's cost is the repo re-read,
not the thinking); `DEVIL_ESCALATE=0` opts a non-critical run back down and
can never lower a critical-path run.

Arguments: $ARGUMENTS

Pick the mode:
- First word `budget`, `plan`, `diff`, `wrapup`, or `reply` selects the mode;
  remaining words are the focus (for `reply`: the session id).
- Anything else (or nothing) means `diff` mode against HEAD, with the free
  text passed as focus arguments.

`diff` and `wrapup` compare against HEAD, so both refuse a repository with no
commit yet: make the initial commit first (or pass a base rev that exists).

Prepare the artifact, then run:
- **budget** — no artifact, no spend: `.claude/scripts/devil.sh budget`.
  Report the `DEVIL_QUOTA:` line (and the `DEVIL_PREFLIGHT: quota` lines)
  before proposing to spend a run.
- **plan** — write a SELF-CONTAINED brief to your scratchpad directory (never
  into the repo): the premise first, then the task as you understand it,
  intended file-by-file changes, invariants you will touch, test plan, open
  questions. The premise sits under a heading that contains `Premise`, in
  any case (e.g. `## 0. Premise`; the script refuses a plan brief without
  one): ONE claim about the current system the plan rests on, plus the
  existing mechanisms searched BY CAPABILITY (what already does this job,
  whatever it is called), each with the grep used. Codex reads the repo
  itself, so keep the brief about intent, not code dumps. Then:
  `.claude/scripts/devil.sh --detach plan --expect <marker> <brief-file> [focus...]`
- **diff** — no artifact. Choose the base (default HEAD; if the agenda spans
  commits, the rev before your first commit). Then:
  `.claude/scripts/devil.sh --detach diff [base] [focus...] [-- <paths...>]`
  Scope with `-- <paths>` whenever the change is wider than the risk: codex
  reads less, which is the cheapest saving available. Critical-path detection
  still sees the whole diff. If the diff touches critical paths
  (`.claude/devil/critical-globs.conf`), ALSO launch the domain-auditor
  agent — independent critics, ideally in parallel.
- **wrapup** — write a completion summary to your scratchpad: the agenda as a
  checklist, per-item status, and evidence pointers (files, tests, docs).
  Then: `.claude/scripts/devil.sh --detach wrapup <summary-file> [base] [-- <paths...>]`
- **reply** — NOT the default second round: a reply replays the whole session
  and costs about twice a fresh run. Prefer folding the concessions and, if
  another round is truly needed, running a fresh mode against the updated
  artifact with the prior objections + dispositions carried in the brief (the
  critic verifies them as claims, which is stronger than a replayed
  argument). When a reply is genuinely right, it requires the exact id
  printed earlier as `DEVIL_SESSION: <uuid>` (never `--last`). Write the
  rebuttal to a scratchpad file, then:
  `.claude/scripts/devil.sh --detach reply <uuid> <rebuttal-file>`

Whatever the mode, the brief must carry (a) the exact files and invariants at
risk, so codex spends its reading where the risk is, and (b) a section listing
what the Claude-lane reviewers already found and how it was fixed — framed as
claims to verify, not as settled ground; a `plan` brief also carries (c) its
premise as one claim about the current system plus the existing mechanisms
searched BY CAPABILITY with the grep used — codex re-runs those greps first.

Briefs are files a critic reads, so each revision is verified before it is
named. Write the revision in the foreground, then `test -r <file>` and grep
the marker it folded in (a version tag, a new section title) before any
launch or SendMessage names the file; better, pass that marker as
`--expect <marker>` right after the mode (plan, wrapup; repeatable), and the
script refuses a file that lacks it. Never chain a brief patch with a critic
launch in one command. Assemble briefs with assert-guarded edits (Edit, or a
script that fails unless its anchor matched exactly once), never with sed
ranges derived from a grep. The log's
`DEVIL_BRIEF: sha256=… bytes=… mtime=…` line records which bytes the run
attacked.

After the critique, answer EVERY numbered objection explicitly — none may be
silently absorbed or dropped. For each, output one of:
- `CONCEDE — #n: <the concrete fix, then apply it (or add it to the plan)>`
- `REBUT — #n: <evidence: file:line or command output proving it wrong>`

Closure is disposition completeness, NOT a verdict: the preamble forbids
praise, so `PROCEED` is near-unreachable and a loop waiting for it never
terminates. Resolve the conceded points before continuing the underlying
task; if no `VERDICT:` line appears, treat the result as FIX-FIRST. Report
the `DEVIL_QUOTA:` line and the `DEVIL_SESSION:` id in your response (or the
`DEVIL_FAILED:` line, verbatim, when the run failed), and if you skipped a
mandated pass to save budget, say so and record it in the commit body.

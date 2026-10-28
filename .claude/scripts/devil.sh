#!/usr/bin/env bash
# .claude/scripts/devil.sh — the ONLY sanctioned way to run the OpenAI codex
# CLI in this repo: an adversarial, READ-ONLY devil's advocate that critiques
# Claude's plans, diffs, and completion claims. --sandbox read-only is
# hardcoded; no mode, flag, or env var may widen it. Codex never writes.
#
# Modes:
#   devil.sh plan   [--expect m] <brief-file> [focus...]  attack a plan before coding
#   devil.sh diff   [base] [focus...] [-- paths]  attack the diff vs base (default HEAD)
#   devil.sh wrapup [--expect m] <summary-file> [base] [-- paths]  attack a "done" claim
#   devil.sh reply  <session-id> [rebuttal-file]  continue the SAME codex session
#   devil.sh budget                               print the codex quota; spends nothing
#   devil.sh --detach <mode> <args...>            launch a mode detached (see below)
#
# Every mode but budget first runs the pre-flight (see "Pre-flight" in the
# usage text), which prints 'DEVIL_PREFLIGHT: <check>' lines, a dry run's
# included. Every run that actually invokes codex prints 'DEVIL_START:
# mode=<m> model=<m> events=<path>' just before codex starts (plan and wrapup
# follow it with 'DEVIL_BRIEF: sha256=<hex> bytes=<n> mtime=<iso>', the
# record of the brief codex was handed: the hash equals `sha256sum <file>` of
# the brief as it was read), and ends its stdout with:
#   DEVIL_RUN: <one line>     audit record: mode/base/critical/escalate/effort/model
#   DEVIL_QUOTA: <one line>   what the run left in the codex rate-limit windows
#   DEVIL_SESSION: <uuid>     pass to 'reply' to continue the argument
#   DEVIL_LOG: <path>         raw JSONL event stream (debug)
# (the codex-not-installed no-op prints its skip notice instead.)
# A run that fails prints one 'DEVIL_FAILED: <reason>' line on stdout instead,
# as its last line: a refusal, a codex error exit, or a TERM (the
# cancellation signal).
#
# --detach: the Claude Code harness kills a long foreground command, so a run
# is launched as 'devil.sh --detach <mode> <args...>'. codex, jq, the
# arguments and the pre-flight are checked first (a refusal prints
# DEVIL_FAILED and creates nothing); the mode then runs in a new session with
# stdout and stderr in a log, and the launcher prints 'DEVIL_DETACHED_LOG:
# <log>' and returns once the log's first line, 'DEVIL_PID: <pid>', exists.
# The log's LAST line decides: DEVIL_LOG: = done, DEVIL_FAILED: = failed.
# Cancel with 'kill -TERM <pid>'. budget is never detached, and reply only
# with a rebuttal file (the detached child has no stdin). It needs nohup and
# setsid (util-linux or BusyBox; where there is none, perl's POSIX::setsid
# does the same call, as on macOS).
#
# BUDGET: codex spends a real, exhaustible quota, so how it is spent matters
# as much as that it runs. Measured over 184 runs in the origin project
# (see .claude/kit-docs/WORKFLOW.md): a run's cost is dominated by codex
# RE-READING the repository, not by its thinking — so reasoning effort is
# nearly free (escalation is the DEFAULT here), a `reply` replays the whole
# session and costs about twice a fresh run, and a `-- <paths>` review scope
# is the cheapest lever there is. Run the Claude-side critics first and keep
# codex as one scarce terminal check.
#
# Project configuration (both files are DATA — read line by line, never
# executed/sourced):
#   .claude/devil/critical-globs.conf     one glob per line; a diff touching a
#                                         matching path auto-escalates codex
#                                         reasoning effort, takes the strong
#                                         model lane and injects the
#                                         invariants file into the prompt
#   .claude/devil/critical-invariants.md  the project's catastrophic invariants,
#                                         injected verbatim on critical diffs
# Missing or placeholder config is a loud no-op: the run still works, a
# one-line note on stderr says escalation/injection is disabled (also when
# the globs file has no active lines or the invariants file still carries
# EDIT-ME placeholders).
#
# Model: follows what the run is WORTH. A critical run — plan mode, or a
# diff/wrapup that touches a critical path — takes the strong lane
# (gpt-6-astra), every other run the cheap lane (gpt-5.6-terra); DEVIL_MODEL
# overrides both. The two default slugs are the origin project's choice on a
# ChatGPT Pro account: point the lanes at what your codex account offers with
# DEVIL_MODEL_CRITICAL / DEVIL_MODEL_DEFAULT (or edit the two defaults in the
# model-selection block below). A reply is not critical by itself, so it
# takes the cheap lane unless DEVIL_MODEL names the model its session started
# on. The model is always the one THIS script chose: the DEVIL_RUN line
# prints it, and neither the event stream nor ~/.codex/config.toml is
# consulted for it. Effort resolves best-effort from the explicit knob, then
# the codex config file (honoring CODEX_HOME, exactly as codex itself
# resolves), and prints as 'inherit' when neither yields one.
# EVERY mode escalates reasoning effort to DEVIL_EFFORT_MAX (default xhigh)
# by default — note a model's OWN default reasoning level may be low, which
# is why escalation here does not rely on it; DEVIL_ESCALATE=0 opts a
# non-critical run back down to the config baseline and CANNOT lower a
# critical-path run; DEVIL_EFFORT beats both.
# DEVIL_DRY_RUN=1 prints the composed prompt + argv without invoking codex.
# DEVIL_FORCE=1 skips the pre-flight's model and quota checks.
#
# Verified end to end against codex-cli 0.145.0 / 0.148.0 (argv, session id,
# event stream); the on-disk shapes the pre-flight and budget read — the
# models cache and the rollouts' rate-limit snapshots, two-window and
# single-window alike — were checked against the files written by 0.164.0.
# Known version-sensitive spots (re-check after codex upgrades;
# selftest/devil-sh-invariants.sh covers the rest):
#   - clap argv ordering for `exec resume` (see comment at the argv block)
#   - session-id key name in the --json event stream
#   - $CODEX_HOME/models_cache.json: .models[].slug / .visibility
#   - rollouts: rate_limits windows carrying used_percent + window_minutes
# Known limitation: the newest-rollout fallback for session-id capture can
# misattribute if another codex session runs concurrently; the primary
# event-stream extraction is race-free.
set -uo pipefail

# --- failure marker --------------------------------------------------------
# Every failure prints exactly one 'DEVIL_FAILED: <reason>' line on STDOUT, so
# a watcher (or the session reading a detached log) can tell a dead run from a
# live one. The reason can carry caller or codex text, so control characters
# become spaces (a newline would forge a second machine line such as
# DEVIL_QUOTA:) and it is cut to 300 characters. The marker is always a
# failed run's LAST line: a detached log holds both streams, and a watcher
# classifies a run by its last line (DEVIL_LOG: = done), because a critique
# may quote a marker mid-log. So die() prints the same sanitized text on
# stderr first and the marker after it.
one_line() { local t="$*"; printf '%s' "${t//[[:cntrl:]]/ }"; }
fail_marker() {
  local t
  t=$(one_line "$*")
  printf 'DEVIL_FAILED: %s\n' "${t:0:300}"
}
die() {
  local msg
  msg=$(one_line "$*")
  echo "devil.sh: $msg" >&2
  fail_marker "$msg"
  exit 1
}

# --- cancellation ------------------------------------------------------------
# TERM is THE cancellation signal ('kill -TERM <DEVIL_PID>'). codex runs as a
# background job under 'wait' (see the codex call), so the trap runs at once:
# it stops codex, prints the marker and exits 143, so no success footer can
# follow and the critic stops spending quota. A detached child leads its own
# session and process group, so it signals that whole group (codex and what
# codex spawned); a foreground run signals codex alone, because its group is
# the caller's. HUP and INT are not trapped: a detached run starts with both
# ignored (nohup, background launch) and bash cannot restore them, which is
# what lets it outlive the launching shell; a foreground run keeps bash's
# default INT. A --detach launcher that is TERMed while it waits for its child
# stops that child first (abort_launch), so cancelling the launch cannot leave
# a run going unobserved.
codex_pid=""
DETACHED_CHILD=0
launch_pid=""
launch_log=""
on_term() {
  trap '' TERM
  [ "$DETACHED_CHILD" = 1 ] && kill -TERM -- "-$$" 2>/dev/null
  [ -n "$codex_pid" ] && kill -TERM "$codex_pid" 2>/dev/null
  [ -n "$launch_log" ] && abort_launch
  fail_marker "terminated by signal"
  exit 143
}
trap on_term TERM

# Undoes a --detach launch whose child never named itself, whatever stage the
# child reached: its pid (setsid, nohup and bash exec in place, so it is one
# process throughout) and, once setsid has run, the group it leads. The log
# goes too: it holds no run.
abort_launch() {
  if [ -n "$launch_pid" ]; then
    kill -TERM -- "-$launch_pid" 2>/dev/null
    kill -TERM "$launch_pid" 2>/dev/null
  fi
  rm -f "$launch_log"
  launch_pid=""
  launch_log=""
}

codex_missing_noop() {
  echo "devil.sh: codex CLI not found on PATH — devil's advocate pass skipped (clean no-op; fine for teammates without codex)."
  exit 0
}

# A unique temp file in $TMPDIR named <stem>XXXXXX<suffix>, its path on stdout.
# GNU mktemp takes the suffix inside the template; BSD/macOS replaces only
# TRAILING X's (it fails, or creates the literal name), so there a plain
# template is made and renamed to carry the suffix.
mk_tmp() { # $1 = stem (e.g. devil-plan-), $2 = suffix (e.g. .jsonl; may be empty)
  local dir=${TMPDIR:-/tmp} f="" g
  if f=$(mktemp "$dir/${1}XXXXXX${2:-}" 2>/dev/null) && [ -n "$f" ] && [[ "$f" != *XXXXXX* ]]; then
    printf '%s' "$f"; return 0
  fi
  [ -n "$f" ] && rm -f "$f" 2>/dev/null
  f=$(mktemp "$dir/${1}XXXXXX" 2>/dev/null) || return 1
  if [ -n "${2:-}" ]; then
    g="$f$2"
    mv "$f" "$g" 2>/dev/null || { rm -f "$f"; return 1; }
    f=$g
  fi
  printf '%s' "$f"
}

usage() {
  cat <<'USAGE'
devil.sh — codex as a read-only devil's advocate (only sanctioned codex entrypoint)

Usage:
  .claude/scripts/devil.sh plan   [--expect <marker>]... <brief-file> [focus...]
  .claude/scripts/devil.sh diff   [base] [focus...] [-- <paths...>]
  .claude/scripts/devil.sh wrapup [--expect <marker>]... <summary-file> [base] [-- <paths...>]
  .claude/scripts/devil.sh reply  <session-id> [rebuttal-file]
  .claude/scripts/devil.sh budget
  .claude/scripts/devil.sh --detach <mode> <args...>

Modes:
  plan     Attack a self-contained plan brief before any code is written.
           The brief states its premise under a heading (a line matching
           '^#+ .*premise' in any case, outside fenced code blocks, e.g.
           '## 0. Premise'): ONE claim about the current system, plus the
           existing mechanisms searched BY CAPABILITY, each with the grep
           used. A brief without one is refused; the prompt has codex attack
           the premise first.
  diff     Attack the diff vs <base> (default HEAD). A first arg that parses
           as a git rev is the base; anything else is focus text. If a focus
           word collides with a real rev name, pass the base explicitly:
           .claude/scripts/devil.sh diff HEAD fee
           Everything after `--` scopes the review to those paths, which is
           the cheapest way to cut a run's cost (codex reads less).
           Critical-path detection still runs on the WHOLE diff, so a scoped
           review of a critical change keeps its invariant block, its strong
           model lane and its escalation.
  wrapup   Attack the claim that an agenda is complete: summary file + diff
           vs [base] (default HEAD). Accepts the same `-- <paths...>` scope.
  budget   Print the codex rate-limit windows read from codex's own session
           logs — the 5h AND the weekly window (an account may have only
           the weekly one), used/left/reset each, plus how stale the reading
           is; a window whose reset time has passed is stamped EXPIRED
           (assume refreshed) — plus the pre-flight's reading of each window
           (DEVIL_PREFLIGHT: lines) and the measured per-mode run cost. Reads
           files only — it never invokes codex and spends nothing. Run it
           BEFORE deciding to spend a critique; `codex /status` is the
           authoritative live view.
  reply    Continue the SAME codex session with a rebuttal (file or stdin).
           Requires the exact uuid printed as DEVIL_SESSION: by an earlier
           run. --last is deliberately unsupported: parallel or resumed
           Claude conversations would resume the wrong codex session.

diff and wrapup compare against HEAD by default, so both refuse a repository
with no commit yet (make the initial commit, or pass a base rev that exists).

Options (--detach goes before the mode, --expect after it):
  --detach How every run but budget is launched from Claude Code (the
           harness kills a long foreground command). Checks codex, jq, the
           arguments and the pre-flight first (a refusal prints DEVIL_FAILED:
           and creates nothing), then runs the mode in a new session with
           stdout+stderr in a log, prints DEVIL_DETACHED_LOG: <log> and
           returns once the log's first line, DEVIL_PID: <pid>, exists. The
           log's LAST line decides: DEVIL_LOG: = done, DEVIL_FAILED: =
           failed. Cancel with kill -TERM <pid>. Refused for budget; reply
           needs a rebuttal file.
  --expect <marker>, --expect=<marker>
           (after plan or wrapup, before the file; repeatable) Refuse the
           run unless the file contains <marker> literally. Name the marker
           the latest revision folded in, so a stale or unsaved brief is
           never attacked. Anywhere else --expect is refused, never read as
           focus text. A brief holding a NUL byte is refused too.

Pre-flight (every mode but budget, before codex starts; DEVIL_PREFLIGHT: lines):
  model    The chosen model must be listed in $CODEX_HOME/models_cache.json
           (default ~/.codex): absent is refused, hidden is warned about; a
           cache that is missing, does not parse or lists no usable slug is
           not checked.
  quota    Per window, the highest unexpired reading in the codex rollouts,
           read newest first until 5 that carry one (never past the 50
           written last). Refused when the 7d window shows less left than the
           run's cost + 1 (plan 2%, diff/wrapup 2%, critical diff/wrapup 3%,
           reply 5%) or a PRESENT 5h window less than 1%. A window is told by
           its span (window_minutes), never by its primary/secondary slot: an
           account with a single weekly window is budgeted on the 7d gate
           alone, and an absent 5h window never refuses. A reading is a floor
           however old; no reading is unknown, not headroom.
  DEVIL_DRY_RUN=1 prints the lines and refuses nothing; DEVIL_FORCE=1 skips
  both checks.

Environment:
  DEVIL_DRY_RUN=1     print composed prompt + codex argv; spend nothing
  DEVIL_FORCE=1       skip the pre-flight (model + quota checks)
  DEVIL_ESCALATE=0    drop a NON-critical run back to the codex config
                      baseline (escalation is the default; a critical-path
                      run ignores this)
  DEVIL_EFFORT_MAX=t  escalation tier (default: xhigh)
  DEVIL_EFFORT=t      force baseline effort (beats auto-escalation)
  DEVIL_MODEL=m       use this model for the run (beats both lanes)
  DEVIL_MODEL_CRITICAL=m  the strong lane: plan mode and critical-path runs
                      (default: gpt-6-astra)
  DEVIL_MODEL_DEFAULT=m   the cheap lane: every other run, replies included
                      (default: gpt-5.6-terra)
USAGE
}

UUID_RE='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
DRY="${DEVIL_DRY_RUN:-0}"

# Absolute path of this script, resolved before the cd below: --detach runs it
# again (once as a dry run to validate, once as the detached child).
SELF="$(cd "$(dirname "$0")" 2>/dev/null && pwd -P)/$(basename "$0")"

DETACH=0
DETACH_VALIDATE=0
case "${1:-}" in
  --detach) DETACH=1; shift ;;
  # Internal: the process --detach starts. Its first line names its pid: the
  # pid a watcher polls and 'kill -TERM' cancels.
  --detached-child) DETACHED_CHILD=1; shift; echo "DEVIL_PID: $$" ;;
  # Internal: the dry run --detach validates with. Unlike an explicit
  # DEVIL_DRY_RUN=1 it ENFORCES the pre-flight, so a run the child would
  # refuse is refused before anything is spawned.
  --detach-validate) DETACH_VALIDATE=1; shift ;;
esac

mode="${1:-}"
case "$mode" in
  plan|diff|wrapup|reply|budget) shift ;;
  -h|--help) usage; exit 0 ;;
  "") usage >&2; die "a mode is required" ;;
  *) usage >&2; die "unknown mode: $mode" ;;
esac

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || die "not inside a git repository"
cd "$REPO_ROOT" || die "cannot cd to repo root"

# --- --detach (see the header) -----------------------------------------------
# The launcher validates, starts the child and returns; it never runs codex.
# The command that moves the child into a session of its own: setsid, else —
# where there is none, as on macOS — perl's POSIX::setsid, which is the same
# call and execs in place just as setsid does, so $! stays the child's pid.
SETSID_CMD=()
pick_setsid() {
  if command -v setsid >/dev/null 2>&1; then
    SETSID_CMD=(setsid)
  elif command -v perl >/dev/null 2>&1; then
    SETSID_CMD=(perl -e 'use POSIX (); POSIX::setsid() or die "setsid: $!\n"; exec @ARGV or die "exec: $!\n"' --)
  else
    die "--detach requires setsid (or perl) and nohup on PATH"
  fi
  command -v nohup >/dev/null 2>&1 || die "--detach requires setsid (or perl) and nohup on PATH"
}

detach() {
  local out rc=0 deadline
  # The presence checks a dry run skips, made before anything starts: no codex
  # is the same clean no-op as in the foreground (no log), no jq a refusal, so
  # a started child never dies for want of a tool.
  command -v codex >/dev/null 2>&1 || codex_missing_noop
  command -v jq >/dev/null 2>&1 || die "jq is required"
  pick_setsid
  # 1. The same arguments as a foreground dry run that enforces the
  #    pre-flight: every refusal the child could hit surfaces here, before
  #    anything is spawned or created. Its stderr passes straight through; its
  #    stdout (the prompt) is kept only to relay a refusal's lines.
  { out=$(DEVIL_DRY_RUN=1 "$BASH" "$SELF" --detach-validate "$mode" "$@" 2>&3 </dev/null) || rc=$?; } 3>&2
  if [ "$rc" -ne 0 ]; then
    [ -n "$out" ] && printf '%s\n' "$out"
    [[ $'\n'"$out" == *$'\n''DEVIL_FAILED: '* ]] || fail_marker "argument validation failed (rc=$rc)"
    exit 1
  fi
  # 2. The log, under a prefix of its own: the footer's DEVIL_LOG: names the
  #    codex events file.
  launch_log=$(mk_tmp "devil-${mode}-" .log) || die "mktemp failed"
  echo "DEVIL_DETACHED_LOG: $launch_log"
  # 3. A portable double fork plus a new session: the command substitution's
  #    subshell starts the child and exits at once, so the child is
  #    re-parented away from the caller's process tree, and setsid moves it
  #    out of the caller's session and process group. The backgrounded command
  #    is not a group leader, so util-linux and BusyBox setsid both do that
  #    without forking ('setsid --fork' is util-linux only); setsid, nohup and
  #    bash exec in place, so $! is the child's pid for its whole life.
  launch_pid=$("${SETSID_CMD[@]}" nohup "$BASH" "$SELF" --detached-child "$mode" "$@" >"$launch_log" 2>&1 </dev/null & echo "$!")
  # 4. Return only once the child has named itself, so a watcher never reads
  #    an empty pid. A child that has not done so in 10 s is stopped, never
  #    left to start a run nobody watches.
  deadline=$((SECONDS + 10))
  until grep -q '^DEVIL_PID: ' "$launch_log" 2>/dev/null; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      head -n 20 "$launch_log" >&2 2>/dev/null
      abort_launch
      die "detached child did not start"
    fi
    sleep 0.1 2>/dev/null || sleep 1
  done
  launch_pid=""
  launch_log=""
  exit 0
}

if [ "$DETACH" = 1 ]; then
  [ "$mode" = "budget" ] && die "budget cannot be detached: it reads files only and returns at once"
  [ "$mode" = "reply" ] && [ $# -lt 2 ] &&
    die "reply --detach requires a rebuttal file: a detached run has no stdin"
  # A dry run stays in the foreground and forks nothing.
  [ "$DRY" = "1" ] || detach "$@"
fi

# --- portable helpers --------------------------------------------------------
# GNU and BSD/macOS userlands differ on stat, date and the sha256 tool; every
# use below goes through one of these so a run behaves the same on both.

# A file's mtime in epoch seconds on stdout, status 1 when it cannot be read:
# GNU `date -r FILE`, GNU stat, then BSD stat. (On BSD, `date -r` takes an
# EPOCH, not a file — which is exactly what fmt_when relies on, so the two
# uses must not be conflated.)
file_mtime() {
  local m
  m=$(date -r "$1" +%s 2>/dev/null); [[ "$m" =~ ^[0-9]+$ ]] && { printf '%s' "$m"; return 0; }
  m=$(stat -c %Y "$1" 2>/dev/null);  [[ "$m" =~ ^[0-9]+$ ]] && { printf '%s' "$m"; return 0; }
  m=$(stat -f %m "$1" 2>/dev/null);  [[ "$m" =~ ^[0-9]+$ ]] && { printf '%s' "$m"; return 0; }
  return 1
}

# An epoch rendered as 'YYYY-MM-DD HH:MM' (local time): GNU `date -d @N`, then
# BSD `date -r N`, else the bare epoch.
fmt_when() {
  date -d "@$1" '+%F %H:%M' 2>/dev/null || date -r "$1" '+%F %H:%M' 2>/dev/null || printf 'epoch %s' "$1"
}

# A file's mtime as an ISO-8601 UTC timestamp (to the second), or 'unknown'.
file_mtime_iso() {
  local m
  m=$(file_mtime "$1") || { printf 'unknown'; return 0; }
  date -u -d "@$m" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date -u -r "$m" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || printf 'unknown'
}

# The hex sha256 of stdin: sha256sum (GNU, BusyBox), shasum (macOS, perl), or
# openssl; prints nothing when none exists.
sha256_hex() {
  local d=""
  if command -v sha256sum >/dev/null 2>&1; then d=$(sha256sum)
  elif command -v shasum >/dev/null 2>&1; then d=$(shasum -a 256)
  elif command -v openssl >/dev/null 2>&1; then d=$(openssl dgst -sha256 -r)
  fi
  printf '%s' "${d%% *}"
}

# --- codex quota readout (free: codex writes it to its own session logs) ----
# Every codex run records the account's rate-limit window in its JSONL stream
# and rollout. Reading that back costs nothing, so the budget is knowable
# BEFORE deciding to spend a critique — and every real run reports where it
# left the budget. Spending an exhaustible critic blind is how a week's
# budget disappears into rounds nobody weighed.
CODEX_DIR="${CODEX_HOME:-${HOME:-}/.codex}"
NUM_RE='^[0-9]+(\.[0-9]+)?$'

# The codex session log written last. The window is account-wide, so the most
# recent codex run of any kind holds the freshest reading. Picked by mtime, as
# the pre-flight picks its readings (newest_rollouts, below), never by name:
# a name records when its session STARTED.
newest_rollout() { newest_rollouts 1; }

# Every reading a codex JSONL file holds, in file order: one '<n> <used_percent>
# <window_minutes> <resets_at>' row per rate-limit window (up to two per
# snapshot: codex writes a 5h and a weekly window side by side, or — newer
# codex, some plans — a single weekly one), <n> numbering the reading lines.
# Given NOW (epoch seconds) as $2, a window whose reset time is not after NOW
# is left out: it measured a window that is over. A line that does not parse
# — a concurrent writer's half-written last line — is skipped alone, never the
# file. Every field must be a plain number or that window's row is discarded:
# a rollout embeds our own prompt text verbatim, so an unvalidated value could
# otherwise forge an audit line.
quota_rows() {
  [ -n "${1:-}" ] && [ -r "$1" ] || return 1
  local rows n used win reset out=""
  rows=$(grep -h '"used_percent"' "$1" 2>/dev/null | jq -R -r -n --argjson now "${2:-null}" '
    foreach inputs as $raw (0; . + 1;
      . as $n
      | ($raw | fromjson?)
      | [.. | objects | select(.used_percent != null and .window_minutes != null)][:2][]
      | select($now == null or (.resets_at // 0) > $now)
      | "\($n) \(.used_percent) \(.window_minutes) \(.resets_at // 0)")' 2>/dev/null)
  while read -r n used win reset; do
    [[ "${n:-}" =~ ^[0-9]+$ ]] || continue
    [[ "${used:-}" =~ $NUM_RE ]] || continue
    [[ "${win:-}" =~ $NUM_RE ]] || continue
    [[ "${reset:-}" =~ $NUM_RE ]] || continue
    out+="$n $used $win $reset"$'\n'
  done <<<"$rows"
  [ -n "$out" ] || return 1
  printf '%s' "$out"
}

# The windows of the LAST reading in a codex JSONL file, one '<used_percent>
# <window_minutes> <resets_at>' row each; status 1 when the file holds none.
quota_from() {
  local rows n used win reset rest last="" out=""
  rows=$(quota_rows "${1:-}") || return 1
  while read -r n rest; do last=$n; done <<<"$rows"
  while read -r n used win reset; do
    [ "$n" = "$last" ] && out+="$used $win $reset"$'\n'
  done <<<"$rows"
  printf '%s' "$out"
}

# On success prints the source file on line 1, then quota_from's window rows —
# from the preferred file ($1, this run's own event stream) or else the newest
# rollout.
quota_resolve() {
  local f q
  for f in "${1:-}" "$(newest_rollout)"; do
    [ -n "$f" ] || continue
    q=$(quota_from "$f") || continue
    printf '%s\n%s' "$f" "$q"
    return 0
  done
  return 1
}

# A window's span as `codex /status` labels it: 300 minutes -> 5h, 10080 -> 7d.
span_of() {
  awk -v w="$1" 'BEGIN{ if (w%1440==0) printf "%dd", w/1440; else if (w%60==0) printf "%dh", w/60; else printf "%dm", w }'
}

# One line, never fails: each window as <span>[used/left/resets] (5h and/or
# 7d, in the order the snapshot lists them), plus how old the reading is. A
# window whose reset time has already PASSED is stamped EXPIRED: its numbers
# describe a window that has since reset, not the current state — quoting
# such a stale reading as the live weekly budget is the misread this stamp
# exists to prevent. `codex /status` is the authoritative live view.
quota_line() {
  local src rows used win reset span left when marker out="" now mtime age
  { read -r src; rows=$(cat); } <<<"$(quota_resolve "${1:-}")"
  if [ -z "${src:-}" ] || [ -z "${rows:-}" ]; then
    printf 'unknown (no rate-limit record under %s/sessions)' "$CODEX_DIR"
    return 0
  fi
  now=$(date +%s 2>/dev/null || echo 0)
  while read -r used win reset; do
    span=$(span_of "$win")
    left=$(awk -v u="$used" 'BEGIN{printf "%.0f", 100-u}')
    when=$(fmt_when "$reset")
    marker=""
    if [ "$now" != 0 ] && awk -v r="$reset" -v n="$now" 'BEGIN{exit !(r>0 && r<=n)}'; then
      marker=" EXPIRED (assume refreshed)"
    fi
    out+="$(printf '%s[used=%.0f%% left=%s%% resets=%s%s]' "$span" "$used" "$left" "$when" "$marker") "
  done <<<"$rows"
  mtime=$(file_mtime "$src") || mtime=0
  age="?"
  [ "$mtime" != 0 ] && [ "$now" != 0 ] && age=$(( (now - mtime) / 3600 ))
  printf '%s reading-age=%sh' "${out% }" "$age"
}

# The (at most) $1 codex rollouts written LAST, newest first. By mtime, not by
# name: a name records when its session STARTED, and a session can keep
# writing for hours after a newer one has started, so the newest name is not
# always the freshest reading. The order comes from bash's own -nt test,
# because a BusyBox find has no -printf. The array is only ever grown element
# by element (never sliced empty), which older bash (macOS's 3.2) needs under
# `set -u`.
newest_rollouts() {
  local n="${1:-5}" f i k top=()
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    i=${#top[@]}
    while [ "$i" -gt 0 ] && [ "$f" -nt "${top[$((i - 1))]}" ]; do i=$((i - 1)); done
    [ "$i" -lt "$n" ] || continue
    k=${#top[@]}
    while [ "$k" -gt "$i" ]; do top[$k]=${top[$((k - 1))]}; k=$((k - 1)); done
    top[$i]=$f
    while [ "${#top[@]}" -gt "$n" ]; do unset "top[$((${#top[@]} - 1))]"; done
  done < <(find "$CODEX_DIR/sessions" -type f -name 'rollout-*.jsonl' 2>/dev/null)
  [ "${#top[@]}" -eq 0 ] || printf '%s\n' "${top[@]}"
}

# The pre-flight's numeric accessor: one '<span> <used_percent> <age_h>
# <resets_at> <file>' line per rate-limit window, holding the HIGHEST
# unexpired reading of that window (age: hours since its file was last
# written). Inside one window usage only rises, so every unexpired reading is
# a floor, however old, and the highest is the tightest: the maximum is taken
# over EVERY reading of every file scanned, so neither a newer file holding
# an older reading nor a half-written line can hide one. Files are read
# newest first (by mtime) until 5 that carry an unexpired reading, and never
# past the 50 written last, so rollouts without a reading cannot push an
# older one that has it out of view. A window is told by its span, never by
# its primary/secondary slot: on some plans the weekly window is the primary
# one, and on some it is the only one. Returns 1 when nothing qualifies.
quota_freshest() {
  local now f rows mtime n used win reset age carried=0 all=""
  [ -d "$CODEX_DIR/sessions" ] || return 1
  now=$(date +%s 2>/dev/null) || return 1
  [[ "$now" =~ ^[0-9]+$ ]] || return 1
  while IFS= read -r f; do
    rows=$(quota_rows "$f" "$now") || continue
    mtime=$(file_mtime "$f") || mtime="-"
    while read -r n used win reset; do
      all+="$win $used $reset $mtime $f"$'\n'
    done <<<"$rows"
    carried=$((carried + 1))
    [ "$carried" -lt 5 ] || break
  done < <(newest_rollouts 50)
  [ -n "$all" ] || return 1
  # Per window the highest reading, compared as a number and printed as read;
  # the file is what follows the four space-free fields.
  while read -r win used age reset f; do
    [ -n "$f" ] || continue
    printf '%s %s %s %s %s\n' "$(span_of "$win")" "$used" "$age" "$reset" "$f"
  done < <(awk -v now="$now" '
    NF >= 5 { if (!($1 in best) || $2 + 0 > best[$1] + 0) {
        best[$1] = $2; rs[$1] = $3; mt[$1] = $4
        file[$1] = substr($0, length($1) + length($2) + length($3) + length($4) + 5)
      } }
    END { for (w in best)
        print w, best[w], (mt[w] == "-" ? "?" : int((now - mt[w]) / 3600)), rs[w], file[w] }' <<<"$all" |
    sort -n -k1,1)
}

# The quota half of the pre-flight: one DEVIL_PREFLIGHT: line per window.
# $1 = the left% the weekly window must show for this run and $2 what the run
# is ("a plan run"); budget passes neither and only prints. A refusal is
# queued in PREFLIGHT_REFUSALS, never raised here, so every line prints first.
PREFLIGHT_REFUSALS=()
preflight_quota() {
  local need="${1:-}" what="${2:-}" rows span used left age reset file when have7=0
  if ! rows=$(quota_freshest); then
    echo "DEVIL_PREFLIGHT: quota unknown — not headroom; check codex /status"
    return 0
  fi
  # One header so the two quota views can't confuse a reader: these lines take
  # the HIGHEST unexpired reading per window (a floor — usage only rises inside
  # a window), while the DEVIL_QUOTA footer shows the NEWEST file's snapshot,
  # which can read fresher and looser. Disagreement in that direction is expected.
  echo "DEVIL_PREFLIGHT: quota rule — highest unexpired reading per window (floor); DEVIL_QUOTA shows the newest file, which may read looser"
  while read -r span used age reset file; do
    file=$(one_line "$file")
    # Displayed rounded DOWN, so the line never shows more headroom than the
    # reading; every decision below compares the raw percentage.
    left=$(awk -v u="$used" 'BEGIN{ l = 100 - u; f = int(l); if (f > l) f--; print f }')
    when=$(fmt_when "$reset")
    case "$span" in
      7d)
        have7=1
        if [ -z "$need" ]; then
          echo "DEVIL_PREFLIGHT: quota 7d left=${left}% age=${age}h file=$file"
        else
          echo "DEVIL_PREFLIGHT: quota 7d left=${left}% age=${age}h file=$file — $what needs >= ${need}%"
          if awk -v u="$used" -v n="$need" 'BEGIN{ exit !(100 - u < n) }'; then
            PREFLIGHT_REFUSALS+=("codex 7d quota left ${left}% < the ${need}% $what needs; resets $when")
          fi
        fi
        ;;
      5h)
        echo "DEVIL_PREFLIGHT: quota 5h left=${left}% age=${age}h file=$file — WARN: the per-run 5h cost is unmeasured; only an exhausted window (left < 1%) refuses"
        if awk -v u="$used" 'BEGIN{ exit !(100 - u < 1) }'; then
          PREFLIGHT_REFUSALS+=("codex 5h quota exhausted (left ${left}%); resets $when")
        fi
        ;;
      *) echo "DEVIL_PREFLIGHT: quota $span left=${left}% age=${age}h file=$file" ;;
    esac
  done <<<"$rows"
  [ "$have7" = 1 ] || echo "DEVIL_PREFLIGHT: quota 7d unknown — not headroom; check codex /status"
}

if [ "$mode" = "budget" ]; then
  [ $# -eq 0 ] || die "budget takes no arguments (got: $*)"
  command -v jq >/dev/null 2>&1 || die "jq is required"
  echo "DEVIL_QUOTA: $(quota_line)"
  preflight_quota
  cat <<'COST'
Measured cost per run in the origin project, in points of the weekly cap
(your absolute numbers will differ, the shape will not):
  ChatGPT Pro (n=7):    plan ~1 (strong lane, 6-7 min)   critical diff ~2
                        (a cheap-lane run was not measured on its own)
  ChatGPT Plus (n=80):  plan ~2.9   diff ~4.3   reply ~8.2
A reply replays the whole session, so it costs ~2x a fresh run of the same
mode; scoping diff/wrapup with `-- <paths>` is the cheapest lever there is.
Reasoning effort is ~free next to the repo read, which is why every run
escalates by default. The pre-flight refuses a run when the 7d reading above
shows less left than the run's cost + 1: plan 2%, diff/wrapup 2% (critical
3%), reply 5%; the 5h window refuses only below 1%; DEVIL_FORCE=1 skips it.
Spend policy: .claude/kit-docs/WORKFLOW.md
COST
  exit 0
fi

if [ "$DRY" != "1" ]; then
  command -v codex >/dev/null 2>&1 || codex_missing_noop
  command -v jq >/dev/null 2>&1 || die "jq is required"
fi

GLOBS_CONF=".claude/devil/critical-globs.conf"
INVARIANTS_FILE=".claude/devil/critical-invariants.md"

# Loud no-op when unconfigured OR semantically empty: the run proceeds, but
# say what is disabled — a readable-but-empty conf and an unedited template
# disable protection just as thoroughly as a missing file.
warn_unconfigured() {
  if [ ! -r "$GLOBS_CONF" ]; then
    echo "devil.sh: note: no $GLOBS_CONF — critical-path detection/escalation disabled (see .claude/kit-docs/INSTALL.md)" >&2
  elif [ "$(grep -cvE '^[[:space:]]*(#|$)' "$GLOBS_CONF" 2>/dev/null)" = "0" ]; then
    echo "devil.sh: note: $GLOBS_CONF has no active globs — critical-path detection/escalation disabled (see .claude/kit-docs/INSTALL.md)" >&2
  elif [ ! -r "$INVARIANTS_FILE" ]; then
    echo "devil.sh: note: no $INVARIANTS_FILE — critical-path invariant injection disabled (see .claude/kit-docs/INSTALL.md)" >&2
  elif ! grep -qE '[^[:space:]]' "$INVARIANTS_FILE" 2>/dev/null; then
    echo "devil.sh: note: $INVARIANTS_FILE is empty — critical-path invariant injection disabled (see .claude/kit-docs/INSTALL.md)" >&2
  elif grep -q "EDIT-ME" "$INVARIANTS_FILE" 2>/dev/null; then
    echo "devil.sh: note: $INVARIANTS_FILE still contains EDIT-ME placeholders — invariant injection disabled until real invariants are written (see .claude/kit-docs/INSTALL.md)" >&2
  fi
}

# Critical scope — the SAME globs file drives the critical-path tripwire hook
# (.claude/hooks/critical-path-tripwire.sh), so script and hook cannot drift.
# NOTE this only guarantees the two consumers agree, not that the globs cover
# every critical file — pin completeness with your own anchor test (skeleton:
# selftest/critical-globs-completeness.sh).
diff_touches_critical() { # $1 = base rev/range
  local files f pat
  [ -r "$GLOBS_CONF" ] || return 1
  files=$( { git diff --name-only "$1" -- 2>/dev/null; \
             git ls-files --others --exclude-standard 2>/dev/null; } )
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    while IFS= read -r pat || [ -n "$pat" ]; do
      pat=${pat%$'\r'}
      case "$pat" in ''|'#'*) continue ;; esac
      # shellcheck disable=SC2254  # unquoted on purpose: $pat must glob-match
      case "$f" in $pat) return 0 ;; esac
    done < "$GLOBS_CONF"
  done <<EOF
$files
EOF
  return 1
}

# A repository with no commit has no HEAD. diff and wrapup compare against
# HEAD by default, and both prompts have codex run `git diff <base>` and
# `git log <base>..HEAD`: against an unborn HEAD those die (rc=128) INSIDE a
# run that is already paid for. So it is refused here, before the pre-flight
# and before anything starts.
require_head() {
  git rev-parse --verify --quiet 'HEAD^{commit}' >/dev/null 2>&1 ||
    die "this repository has no commit yet, so HEAD does not resolve (diff and wrapup compare against it): make the initial commit first, or pass a base rev that exists"
}

# Splits a mode's argv at the first literal `--`: everything after it scopes
# the review to those paths. Each is validated as a plain repo path, so a
# scope can neither smuggle an option into the prompt nor forge a second
# machine line with an embedded newline.
PRE_ARGS=()
SCOPE_PATHS=()
split_scope() {
  local seen=0 a
  PRE_ARGS=()
  SCOPE_PATHS=()
  for a in "$@"; do
    if [ "$seen" = 0 ] && [ "$a" = "--" ]; then seen=1; continue; fi
    if [ "$seen" = 1 ]; then
      case "$a" in
        -*) die "invalid scope path (option-shaped): $a" ;;
        *$'\n'*) die "invalid scope path (embedded newline)" ;;
        "") die "empty scope path" ;;
      esac
      SCOPE_PATHS+=("$a")
    else
      PRE_ARGS+=("$a")
    fi
  done
  [ "$seen" = 0 ] || [ "${#SCOPE_PATHS[@]}" -gt 0 ] || die "-- given with no paths"
  scope=""
  [ "${#SCOPE_PATHS[@]}" -gt 0 ] && scope=" -- ${SCOPE_PATHS[*]}"
  return 0
}

# --expect <marker> (plan, wrapup; right after the mode, repeatable): the run
# is refused unless its file contains every marker literally, so a critic is
# never pointed at a brief whose latest revision has not landed. Leading pairs
# go to EXPECTS; the rest of the argv to REST. An --expect anywhere else is
# refused, never read as focus text: a marker that silently goes unchecked is
# worse than none.
EXPECTS=()
REST=()
take_expects() {
  local m
  REST=("$@")
  while [ "${#REST[@]}" -gt 0 ]; do
    case "${REST[0]}" in
      --expect)
        [ "${#REST[@]}" -ge 2 ] || die "--expect requires a marker"
        m=${REST[1]}
        REST=("${REST[@]:2}")
        ;;
      --expect=*)
        m=${REST[0]#--expect=}
        REST=("${REST[@]:1}")
        ;;
      *) break ;;
    esac
    case "$m" in
      "") die "--expect requires a non-empty marker" ;;
      *$'\n'*|*$'\r'*) die "--expect marker must be a single line" ;;
    esac
    EXPECTS+=("$m")
  done
  refuse_expect ${REST[@]+"${REST[@]}"}
}

refuse_expect() { # $@ = arguments where --expect has no meaning
  local a
  for a in "$@"; do
    case "$a" in
      --expect|--expect=*)
        die "--expect goes right after plan or wrapup, before the file" ;;
    esac
  done
  return 0
}

# A brief is read ONCE, into BRIEF_TEXT: the prompt, the premise and --expect
# checks and the DEVIL_BRIEF record all see the same bytes, so a brief
# rewritten while a run starts cannot be checked in one version and attacked
# in another. `read -d ''` keeps the trailing newlines a command substitution
# would drop, so the record's hash equals the sha256 of the file. It stops at
# a NUL, though: its status is 0 when it met one and 1 at end of file, so a
# brief holding a NUL byte is refused rather than silently cut there (a
# brief is text). The mtime is taken at the same moment, and only by a run
# that prints the record.
BRIEF_TEXT=""
BRIEF_PATH=""
BRIEF_MTIME=""
read_brief() {
  local rc=0
  { IFS= read -r -d '' BRIEF_TEXT || rc=$?; } <"$1" || die "cannot read $1"
  [ "$rc" -ne 0 ] ||
    die "$1 holds a NUL byte: a brief is text, and everything after the NUL would be dropped"
  BRIEF_PATH=$1
  [ "$DRY" = 1 ] && return 0
  BRIEF_MTIME=$(file_mtime_iso "$1")
}

# A plan rests on a claim about the current system; a brief that never states
# one hands the critic nothing to attack first. The heading is an ATX one,
# matched in any case, and never inside a fenced code block: a quoted example
# is not the brief's own premise.
has_premise_heading() {
  awk '
    { s = $0; sub(/^ ? ? ?/, "", s) }
    fence != "" { if (index(s, fence) == 1) fence = ""; next }
    index(s, "```") == 1 { fence = "```"; next }
    index(s, "~~~") == 1 { fence = "~~~"; next }
    tolower($0) ~ /^#+ .*premise/ { found = 1; exit }
    END { exit !found }' <<<"$BRIEF_TEXT"
}

check_expects() { # $1 = what the file is, for the refusal
  local m
  for m in ${EXPECTS[@]+"${EXPECTS[@]}"}; do
    [[ "$BRIEF_TEXT" == *"$m"* ]] || die "$1 lacks the expected marker '$m' ($BRIEF_PATH)"
  done
}

PREAMBLE=$(cat <<'EOF'
You are the DEVIL'S ADVOCATE for this repository. You run in a read-only
sandbox inside the repository: you cannot change anything, and your only job
is to attack the work presented below and find what is wrong, risky, missing,
or untested.

Ground rules:
- First read AGENTS.md and CLAUDE.md at the repo root in full (if present).
  They are repo law; judge everything against them.
- Investigate the repository yourself (read files, run read-only git
  commands). Do NOT trust the artifact's claims — verify against actual code.
- Adversarial only: no praise, no balance, no restating what is fine.
- Numbered objections, strongest first. Every objection cites concrete
  evidence — file path plus line (file:line) or a specific diff hunk — and
  one or two lines on why it is wrong or dangerous here.
- Attack, don't fix: you may state what a fix must achieve, never write it.
- You are the LAST gate. The Claude-side reviewers have already run; this
  work commits or dispatches on the strength of your answer and nothing
  critiques it afterwards. Rank by what would make that a mistake — a defect
  that costs data, money, or a contract first; stylistic preference never.
- Anything the artifact reports as already found and fixed (by another
  reviewer, an auditor, or the agent itself) is a CLAIM, not settled ground.
  Verify each such fix is real and complete in the code, and say so when it
  is not — a fix that only looks applied is worse than an open finding.
- Immediately before the verdict, print one `UNVERIFIED:` line listing what
  you could not check and why (files not read, behavior not derivable from
  the repo). An empty list is itself a claim you are making.
- End with exactly one final line:
  VERDICT: BLOCK | FIX-FIRST | PROCEED — <one-line justification>
  (BLOCK = approach fundamentally wrong; FIX-FIRST = named issues must be
  fixed before continuing; PROCEED = nothing material found.)
EOF
)

# Injected on critical-path diffs/wrapups: header + the project's own
# invariants file, verbatim. An empty file or an unedited template is NOT
# injected — nothing or template shapes would only add noise
# (warn_unconfigured surfaces both states).
CRITICAL_BLOCK=""
if [ -r "$INVARIANTS_FILE" ] && grep -qE '[^[:space:]]' "$INVARIANTS_FILE" 2>/dev/null \
   && ! grep -q "EDIT-ME" "$INVARIANTS_FILE" 2>/dev/null; then
  CRITICAL_BLOCK="CRITICAL-PATH ALERT: this change touches files matched by $GLOBS_CONF.
Apply maximum suspicion to the project's declared invariants below; verify
each against the actual code, and treat any weakening of them as a top
objection:

$(cat "$INVARIANTS_FILE")"
fi

base=""
critical=0
focus=""
scope=""
prompt=""
session_arg=""

SCOPE_NOTE=$(cat <<'EOF'
SCOPE: the review is deliberately narrowed to the paths named in the git
commands above. Changes outside them are out of scope and are NOT findings —
but a change INSIDE the scope that breaks something outside it still is, so
follow callers and contracts wherever they lead.
EOF
)

case "$mode" in
  plan)
    take_expects "$@"
    set -- ${REST[@]+"${REST[@]}"}
    [ $# -ge 1 ] || die "plan mode requires a brief file: devil.sh plan [--expect <marker>] <brief-file> [focus...]"
    brief_file="$1"; shift
    [ -f "$brief_file" ] && [ -r "$brief_file" ] || die "plan mode requires a readable brief file (got: $brief_file)"
    read_brief "$brief_file"
    has_premise_heading ||
      die "plan brief has no premise heading (no line matching '^#+ .*premise', any case, outside code fences): $brief_file"
    check_expects "plan brief"
    focus="$*"
    section=$(cat <<'EOF'
TASK: Attack the implementation plan below before any code is written. It was
written by another AI agent (Claude) that is about to implement it in this
repository.

Attack the premise first: re-run the greps the brief lists under existing
mechanisms and name what they missed.

Hunt for:
- requirements the plan misreads, skips, or quietly narrows
- violations of repo law (CLAUDE.md / AGENTS.md): declared invariants,
  testing duties, error-handling rules, documentation/contract duties
- architectural mistakes: wrong module or layer, reimplementing something
  that already exists in this repo, missing transaction/concurrency/
  idempotency handling where state changes, contract drift
- hidden complexity, unhandled edge cases, untestable design
- deliverables the plan omits: docs the house rules require, tests for
  changed invariants, API-contract/changelog updates
EOF
    )
    prompt="$PREAMBLE"$'\n\n'"$section"
    [ -n "$focus" ] && prompt+=$'\n\n'"Caller's focus (weigh these heavily): $focus"
    prompt+=$'\n\n'"=== PLAN BRIEF (verbatim from $brief_file) ==="$'\n'"$(printf '%s' "$BRIEF_TEXT")"$'\n'"=== END PLAN BRIEF ==="
    ;;

  diff)
    warn_unconfigured
    refuse_expect "$@"
    split_scope "$@"
    set -- ${PRE_ARGS[@]+"${PRE_ARGS[@]}"}
    base="HEAD"
    # Leading-dash args are never a base: git diff would parse them as OPTIONS
    # (e.g. --output=<path> WRITES that path during the probe itself).
    if [ $# -ge 1 ] && [ "${1#-}" = "$1" ] && git diff --name-only "$1" -- >/dev/null 2>&1; then
      base="$1"; shift
    fi
    [ "$base" = "HEAD" ] && require_head
    focus="$*"
    # Critical detection reads the WHOLE diff, never the scope: narrowing the
    # review of a critical change must not quietly drop the invariant block.
    diff_touches_critical "$base" && critical=1
    tpl=$(cat <<'EOF'
TASK: Attack the work-in-progress changes in this repository.

Diff base: __BASE__
Run these yourself inside your sandbox (you have read access):
    git diff __BASE__ --stat__SCOPE__
    git diff __BASE____SCOPE__
Also run `git status --porcelain` and read untracked files — brand-new files
do not appear in the diff.

Hunt for:
- bugs, broken edge cases, and logic errors in the changed hunks
- violations of repo law in CLAUDE.md / AGENTS.md (declared invariants,
  error handling, testing conventions, documentation/contract duties)
- breakage of callers/contracts elsewhere in the repo — search for usages,
  do not assume the diff is self-contained
- missing or weakened tests for changed behavior (every "must not / never"
  invariant change needs a regression test in the same change)
- half-done work: TODOs, dead code, debug leftovers, unwired modules
EOF
    )
    tpl="${tpl//__BASE__/$base}"
    prompt="$PREAMBLE"$'\n\n'"${tpl//__SCOPE__/$scope}"
    [ -n "$scope" ] && prompt+=$'\n\n'"$SCOPE_NOTE"
    [ -n "$focus" ] && prompt+=$'\n\n'"Caller's focus (weigh these heavily): $focus"
    [ "$critical" = 1 ] && [ -n "$CRITICAL_BLOCK" ] && prompt+=$'\n\n'"$CRITICAL_BLOCK"
    ;;

  wrapup)
    warn_unconfigured
    take_expects "$@"
    split_scope ${REST[@]+"${REST[@]}"}
    set -- ${PRE_ARGS[@]+"${PRE_ARGS[@]}"}
    [ $# -ge 1 ] || die "wrapup mode requires a summary file: devil.sh wrapup [--expect <marker>] <summary-file> [base]"
    summary_file="$1"; shift
    [ -f "$summary_file" ] && [ -r "$summary_file" ] || die "wrapup mode requires a readable summary file (got: $summary_file)"
    read_brief "$summary_file"
    check_expects "wrapup summary"
    base="HEAD"
    if [ $# -ge 1 ]; then
      # Reject option-shaped args BEFORE probing: git diff would parse them as
      # OPTIONS (e.g. --output=<path> WRITES that path during the probe).
      case "$1" in -*) die "wrapup: invalid base rev: $1" ;; esac
      [ "$1" = "HEAD" ] && require_head
      git diff --name-only "$1" -- >/dev/null 2>&1 || die "wrapup: invalid base rev: $1"
      base="$1"; shift
    fi
    [ $# -eq 0 ] || die "wrapup: unexpected extra args: $*"
    [ "$base" = "HEAD" ] && require_head
    diff_touches_critical "$base" && critical=1
    tpl=$(cat <<'EOF'
TASK: An AI agent (Claude) claims the agenda summarized below is COMPLETE.
Attack that claim: your job is to find what is NOT actually done.

Diff base for the whole agenda: __BASE__
Run these yourself: `git diff __BASE__ --stat__SCOPE__`, `git diff __BASE____SCOPE__`,
`git status --porcelain` (untracked files), and `git log --oneline __BASE__..HEAD`
if the work spans commits.

Hunt specifically for incompleteness:
- promises in the summary the diff does not deliver — and undeclared changes
  in the diff the summary hides
- changed invariants with no regression test
- missing repo-law deliverables: required docs, changelog/API-contract
  entries, error-catalog or config registrations the house rules demand
- contract gaps: API shapes, error codes, serialization rules
- anything half-wired: unregistered modules, unreferenced files, TODOs
EOF
    )
    tpl="${tpl//__BASE__/$base}"
    prompt="$PREAMBLE"$'\n\n'"${tpl//__SCOPE__/$scope}"
    [ -n "$scope" ] && prompt+=$'\n\n'"$SCOPE_NOTE"
    [ "$critical" = 1 ] && [ -n "$CRITICAL_BLOCK" ] && prompt+=$'\n\n'"$CRITICAL_BLOCK"
    prompt+=$'\n\n'"=== COMPLETION SUMMARY (verbatim from $summary_file) ==="$'\n'"$(printf '%s' "$BRIEF_TEXT")"$'\n'"=== END SUMMARY ==="
    ;;

  reply)
    [ $# -ge 1 ] || die "reply requires the explicit codex session id. Every devil.sh run prints it as its final 'DEVIL_SESSION: <uuid>' line — pass that uuid. '--last' is deliberately unsupported: parallel or resumed Claude conversations would resume the wrong codex session."
    [ "$1" = "--last" ] && die "'--last' is deliberately unsupported: parallel or resumed Claude conversations would resume the wrong codex session. Pass the uuid printed as 'DEVIL_SESSION:' by the run you are replying to."
    printf '%s' "$1" | grep -qE "$UUID_RE" || die "session id must be the UUID printed as DEVIL_SESSION: (got: $1)"
    session_arg="$1"; shift
    rebuttal=""
    if [ $# -ge 1 ]; then
      [ -r "$1" ] || die "reply: rebuttal file not readable: $1"
      rebuttal=$(cat "$1"); shift
      [ $# -eq 0 ] || die "reply: unexpected extra args: $*"
    else
      [ -t 0 ] && die "reply: no rebuttal file given and stdin is a terminal (pass a file or pipe text)"
      rebuttal=$(cat)
    fi
    [ -n "$rebuttal" ] || die "empty rebuttal (pass a file or pipe text on stdin)"
    section=$(cat <<'EOF'
The agent you are criticizing replies below. It must answer every one of your
objections with either a concession (plus its fix) or a rebuttal (plus
evidence). Hold the line:
- re-verify its claims against the repository yourself; accept nothing
  without file:line evidence
- drop an objection ONLY if genuinely refuted; otherwise restate it sharpened
- raise new objections if the reply exposes new problems
- flag any of your objections the reply silently ignored
End again with exactly one final line:
VERDICT: BLOCK | FIX-FIRST | PROCEED — <one-line justification>
EOF
    )
    prompt="$section"$'\n\n'"=== AGENT REBUTTAL ==="$'\n'"$rebuttal"$'\n'"=== END REBUTTAL ==="
    ;;
esac

# Audit-integrity guard: the env knobs are echoed into the DEVIL_RUN
# transcript line and passed to the codex argv — a stray newline would forge
# extra DEVIL_RUN:/DEVIL_QUOTA:/DEVIL_SESSION: records. [[ =~ ]] anchors over
# the WHOLE value, so an embedded newline fails the match (grep -q would pass
# it line by line).
valid_token() { [[ "$1" =~ ^[A-Za-z0-9._-]+$ ]]; }
for knob in DEVIL_MODEL DEVIL_MODEL_CRITICAL DEVIL_MODEL_DEFAULT DEVIL_EFFORT DEVIL_EFFORT_MAX; do
  v="${!knob:-}"
  [ -z "$v" ] || valid_token "$v" || die "invalid $knob (expected a single token of [A-Za-z0-9._-])"
done

# --- model selection: the model follows what the run is WORTH. Plan mode and
# any critical-path run get the strong lane, because design rejection and
# critical-path reasoning are the findings most expensive to find late; every
# other run (a reply included — the script cannot see its session's mode) gets
# the cheap lane. An explicit DEVIL_MODEL always wins (validated above with
# every other knob); the lane defaults below are the only slugs this script
# hardcodes, and each lane has an env override of its own.
if [ -n "${DEVIL_MODEL:-}" ]; then
  model="$DEVIL_MODEL"
elif [ "$mode" = "plan" ] || [ "$critical" = 1 ]; then
  model="${DEVIL_MODEL_CRITICAL:-gpt-6-astra}"
else
  model="${DEVIL_MODEL_DEFAULT:-gpt-5.6-terra}"
fi
valid_token "$model" || die "invalid model"

# --- pre-flight ---------------------------------------------------------------
# A run against a model codex no longer offers dies at codex with a 400, one
# into a spent window dies on the quota, and both recur once the fix is only
# written down in prose. So both are checked HERE, once the model is chosen
# and before anything starts (no temp file, no codex), and every check prints
# a DEVIL_PREFLIGHT: line — a dry run's too:
# - model: the chosen slug must be listed in codex's own model cache,
#   $CODEX_DIR/models_cache.json. Absent is refused; listed but hidden
#   (visibility "hide") is warned about and run, because DEVIL_MODEL always
#   wins; an unreadable cache is not checked, and the line says so.
# - quota: preflight_quota over quota_freshest. The weekly (7d) window refuses
#   below the run's cost + 1 point (run_cost); the 5h window — when the
#   account has one — only when exhausted, its per-run cost being unmeasured.
#   A reading is a floor however old, so age never lifts a refusal; no reading
#   is "unknown", which is neither headroom nor a refusal.
# An explicit DEVIL_DRY_RUN=1 prints what a real run would refuse and refuses
# nothing; the dry run --detach validates with, and every real run, refuse.
# DEVIL_FORCE=1 skips both checks.

# Points of the weekly cap a run of this mode costs (see budget). A reply
# replays its session at ~2x a fresh run of that session's mode, which the
# script cannot see, so it is priced at 2x the dearest fresh run.
run_cost() {
  case "$mode" in
    plan) echo 1 ;;
    diff|wrapup) if [ "$critical" = 1 ]; then echo 2; else echo 1; fi ;;
    reply) echo 4 ;;
    *) echo 0 ;;
  esac
}

preflight_model() {
  local cache="$CODEX_DIR/models_cache.json" listing="" s v found=0 vis="" slugs=""
  # @tsv escapes tabs and newlines inside a value, so one entry is one line.
  [ -f "$cache" ] && [ -r "$cache" ] && listing=$(jq -r '.models
      | if type == "array" then .[] else error("no models array") end
      | select(type == "object" and (.slug | type) == "string" and .slug != "")
      | [.slug, ((.visibility // "") | tostring)] | @tsv' "$cache" 2>/dev/null) || listing=""
  while IFS=$'\t' read -r s v; do
    valid_token "$s" || continue
    slugs+="${slugs:+ }$s"
    if [ "$s" = "$model" ]; then found=1; vis=$v; fi
  done <<<"$listing"
  # One rule: a cache that is missing, does not parse or lists no usable slug
  # proves nothing about the model, so it is not checked, never refused.
  if [ -z "$slugs" ]; then
    echo "DEVIL_PREFLIGHT: model cache unreadable (${cache//[[:cntrl:]]/ }) — not checked"
    return 0
  fi
  if [ "$found" = 0 ]; then
    echo "DEVIL_PREFLIGHT: model $model not offered by codex"
    PREFLIGHT_REFUSALS+=("model $model not offered; listed: $slugs")
  elif [ "$vis" = "hide" ]; then
    echo "DEVIL_PREFLIGHT: model $model listed but hidden (visibility: hide) — WARN: proceeding"
  else
    echo "DEVIL_PREFLIGHT: model $model offered"
  fi
}

preflight() {
  local what r reason=""
  if [ "${DEVIL_FORCE:-0}" = 1 ]; then
    echo "DEVIL_PREFLIGHT: skipped (DEVIL_FORCE=1)"
    return 0
  fi
  # A real run has proved jq by now; only a dry run can get here without it.
  if ! command -v jq >/dev/null 2>&1; then
    echo "DEVIL_PREFLIGHT: jq missing — model and quota not checked"
    return 0
  fi
  preflight_model
  what="a $mode run"
  case "$mode" in diff|wrapup) [ "$critical" = 1 ] && what="a critical $mode run" ;; esac
  preflight_quota "$(( $(run_cost) + 1 ))" "$what"
  [ "${#PREFLIGHT_REFUSALS[@]}" -gt 0 ] || return 0
  for r in "${PREFLIGHT_REFUSALS[@]}"; do reason+="${reason:+; }$r"; done
  if [ "$DRY" = 1 ] && [ "$DETACH_VALIDATE" != 1 ]; then
    echo "DEVIL_PREFLIGHT: a real run would be refused: $reason"
    return 0
  fi
  echo "devil.sh: the pre-flight refuses this run; DEVIL_FORCE=1 runs it anyway" >&2
  die "$reason"
}
preflight

# --- effort selection (caller-overridable; escalation never widens the sandbox)
# Escalation is the DEFAULT: a run's cost is dominated by codex re-reading
# the repository, so the extra reasoning tokens are noise next to it — paying
# for the read and then thinking at the config baseline is the worst
# available trade. DEVIL_ESCALATE=0 opts a non-critical run back down; it can
# never lower a critical-path run.
escalate=1
[ "${DEVIL_ESCALATE:-1}" = "0" ] && escalate=0
[ "$critical" = 1 ] && escalate=1
effort=""
if [ -n "${DEVIL_EFFORT:-}" ]; then
  effort="$DEVIL_EFFORT"
elif [ "$escalate" = 1 ]; then
  effort="${DEVIL_EFFORT_MAX:-xhigh}"
fi

if [ "$DRY" = "1" ]; then
  LAST_MSG_FILE="<last-msg-file>"
else
  LAST_MSG_FILE=$(mk_tmp "devil-${mode}-last-" .md) || die "mktemp failed"
  EVENTS_FILE=$(mk_tmp "devil-${mode}-" .jsonl) || die "mktemp failed"
  ERR_FILE=$(mk_tmp "devil-${mode}-err-" .log) || die "mktemp failed"
  MARKER=$(mk_tmp "devil-marker-" "") || die "mktemp failed"
fi

# clap quirk: --sandbox/--color/-C are exec-level options the resume subcommand
# does not accept — they must precede the `resume` token; --json/-o/-m/-c are
# valid on resume itself and go after it, before the positionals.
if [ "$mode" = "reply" ]; then
  argv=(codex exec --sandbox read-only --color never -C "$REPO_ROOT" resume --json)
else
  argv=(codex exec --sandbox read-only --color never --json -C "$REPO_ROOT")
fi
[ -n "$model" ] && argv+=(-m "$model")
[ -n "$effort" ] && argv+=(-c "model_reasoning_effort=\"$effort\"")
argv+=(-o "$LAST_MSG_FILE")
[ "$mode" = "reply" ] && argv+=("$session_arg")
argv+=(-)

if [ "$DRY" = "1" ]; then
  echo "=== DEVIL_DRY_RUN: mode=$mode base=${base:-n/a} critical=$critical escalate=$escalate effort=${effort:-inherit} model=$model ==="
  echo "=== DEVIL_DRY_RUN: codex argv ==="
  printf '  %s\n' "${argv[@]}"
  echo "=== DEVIL_DRY_RUN: prompt (fed via stdin) ==="
  printf '%s\n' "$prompt"
  exit 0
fi

# Why codex failed, in one line. Quota exhaustion, an unsupported model and a
# revoked login arrive as 'error' / 'turn.failed' events in the JSONL stream
# while codex's stderr stays EMPTY, so the stream's last error message comes
# first, unwrapping an API error body that is itself JSON; the first non-empty
# stderr line is the fallback (a crash, a CLI usage error). The caller's
# fail_marker sanitizes whatever this returns.
codex_failure_reason() {
  local r
  r=$(jq -rR 'fromjson? | select(type == "object" and (.type == "turn.failed" or .type == "error"))
      | (.error.message? // .message? // empty) | strings
      | . as $raw | ((try (fromjson | (.error.message? // .message?)) catch null) | strings) // $raw
      | gsub("[\\r\\n]+"; " ")' "$EVENTS_FILE" 2>/dev/null | tail -n 1)
  [ -n "$r" ] || r=$(grep -m 1 -v '^[[:space:]]*$' "$ERR_FILE" 2>/dev/null)
  printf '%s' "$r"
}

# A watcher can tell "started" from "validating": the events file named here
# grows once codex streams.
echo "DEVIL_START: mode=$mode model=$model events=$EVENTS_FILE"
# The record of exactly what codex is handed (plan, wrapup): the hash and size
# of the bytes read once at the start, and the file's mtime at that read.
if [ -n "$BRIEF_PATH" ]; then
  brief_sha=$(printf '%s' "$BRIEF_TEXT" | sha256_hex)
  [[ "$brief_sha" =~ ^[0-9a-f]{64}$ ]] || brief_sha=unknown
  echo "DEVIL_BRIEF: sha256=$brief_sha bytes=$(( $(printf '%s' "$BRIEF_TEXT" | wc -c) )) mtime=$BRIEF_MTIME"
fi
# codex runs as a background job under 'wait', not in the foreground: bash
# defers a trap until a foreground child exits, so a TERM would otherwise wait
# out the whole critique. The subshell resets INT, which bash ignores in a
# background job, so a foreground Ctrl-C still reaches codex as it always did;
# a detached run started with INT ignored, and that cannot be reset.
rc=0
( trap - INT; exec "${argv[@]}" ) <<<"$prompt" >"$EVENTS_FILE" 2>"$ERR_FILE" &
codex_pid=$!
wait "$codex_pid" || rc=$?
codex_pid=""
if [ "$rc" -ne 0 ]; then
  {
    echo "devil.sh: codex exited with rc=$rc"
    # Relayed codex output is indented (and carriage returns flattened), so
    # no relayed line can start a machine line such as DEVIL_QUOTA: in the
    # stream or in a detached log.
    echo "--- codex stderr (tail) ---"
    tail -n 20 "$ERR_FILE" 2>/dev/null | cut -c1-300 | tr '\r' ' ' | sed 's/^/  /'
    echo "--- last events (tail) ---"
    tail -n 20 "$EVENTS_FILE" 2>/dev/null | cut -c1-300 | tr '\r' ' ' | sed 's/^/  /'
    echo "If this mentions authentication, run: codex login"
    echo "Full event log: $EVENTS_FILE"
    echo "Full codex stderr: $ERR_FILE"
  } >&2
  # Keep exactly the two disclosed forensics files (events, stderr); remove
  # the rest.
  rm -f "$MARKER" "$LAST_MSG_FILE" 2>/dev/null
  reason=$(codex_failure_reason)
  fail_marker "codex exited $rc${reason:+: $reason}"
  exit 1
fi

# Session id: primary = this run's own event stream (race-free; key name varies
# across codex versions). Fallback = newest rollout file created after MARKER.
session_id=$(jq -r '.. | objects | (.session_id? // .thread_id? // .conversation_id?) // empty' \
  "$EVENTS_FILE" 2>/dev/null | grep -m1 -E "$UUID_RE" || true)
if [ -z "$session_id" ] && [ -n "$session_arg" ]; then
  session_id="$session_arg"
fi
if [ -z "$session_id" ]; then
  newest=$(find "$CODEX_DIR/sessions" -type f -name 'rollout-*.jsonl' -newer "$MARKER" 2>/dev/null | sort | tail -n 1)
  if [ -n "$newest" ]; then
    session_id=$(basename "$newest" .jsonl | grep -oE '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' || true)
  fi
fi

if [ -s "$LAST_MSG_FILE" ]; then
  cat "$LAST_MSG_FILE"
else
  echo "devil.sh: warning: last-message file is empty; recovering text from the event stream" >&2
  jq -r '.. | objects | (.item.text? // .message? // empty) | strings' "$EVENTS_FILE" 2>/dev/null | tail -n 60
fi
echo
# Audit record: which configuration produced this verdict. Best-effort
# resolution — never fails the run. The model is always the one THIS script
# chose (lane or DEVIL_MODEL), so the record never consults the event stream
# or the config file for it — no external text can influence what it says was
# run. The effort falls back to the codex config file, exactly what codex
# itself uses when no override is passed, read from CODEX_HOME (the config
# DIRECTORY, default ~/.codex) so this follows codex's own resolution order.
# config_val is best-effort — first top-level occurrence; profile overrides
# are not modeled. The config value is validated: one that is not a single
# token is discarded rather than printed, so no external text can forge a
# record in this line (env knobs are rejected at entry).
config_val() { sed -n "s/^$1 *= *\"\([^\"]*\)\".*/\1/p" "$CODEX_DIR/config.toml" 2>/dev/null | head -n 1; }
run_model="$model"
run_effort="$effort"
if [ -z "$run_effort" ]; then
  run_effort=$(config_val model_reasoning_effort)
  valid_token "$run_effort" || run_effort=""
fi
echo "DEVIL_RUN: mode=$mode base=${base:-n/a} critical=$critical escalate=$escalate effort=${run_effort:-inherit} model=${run_model:-inherit}"
# What this run left in the tank, from codex's own telemetry (this run's event
# stream first, else the newest rollout), validated as plain numbers and
# unable to fail the run — the same discipline as DEVIL_RUN.
echo "DEVIL_QUOTA: $(quota_line "$EVENTS_FILE")"
if [ -n "$session_id" ]; then
  echo "DEVIL_SESSION: $session_id"
else
  echo "devil.sh: warning: session-id extraction failed (see DEVIL_LOG)" >&2
  echo "DEVIL_SESSION: unknown (id extraction failed — reply unavailable for this run)"
fi
echo "DEVIL_LOG: $EVENTS_FILE"
# Success-path hygiene: the critique was printed and the event log is the
# disclosed artifact — remove the other temp files (kept on failure, where
# the error handler points at them for forensics).
rm -f "$LAST_MSG_FILE" "$ERR_FILE" "$MARKER" 2>/dev/null
exit 0

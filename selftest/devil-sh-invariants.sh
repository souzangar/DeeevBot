#!/usr/bin/env bash
# Regression guard for devil.sh's contract. Mirrors the invariant spec the
# source project ran on every commit. Port these into the target project's
# test suite when one exists; until then run via selftest/run-all.sh.
#
# Pins:
#   - --sandbox read-only hardcoded in EVERY mode (no env may widen it)
#   - reply refuses --last and malformed ids; exact uuid becomes the resume positional
#   - option-shaped args are never treated as a diff/wrapup base (git --output
#     write primitive) and never create files; env knobs that are not a single
#     token (newline = transcript forgery) are refused
#   - clean no-op when codex is absent; no copy mode exists
#   - critical-globs config: missing -> detection off + loud note; present ->
#     detection + escalation; DEVIL_EFFORT beats escalation; comments ignored;
#     invariants file injected on critical diffs, never when empty
#   - reasoning effort escalates by DEFAULT, and DEVIL_ESCALATE=0 can never
#     de-escalate a CRITICAL-path run; a `-- <paths>` scope reaches only the
#     prompt, is refused when option-shaped or newline-bearing, and never
#     narrows critical detection
#   - MODEL LANES: plan and any critical-path run take the strong lane, every
#     other run (a reply included) the cheap lane; DEVIL_MODEL beats both,
#     DEVIL_MODEL_CRITICAL / DEVIL_MODEL_DEFAULT move one lane each; the
#     DEVIL_RUN line prints the model the SCRIPT chose and never consults the
#     event stream or the codex config for it
#   - FAILURE MARKER: every failure path prints exactly one DEVIL_FAILED: line
#     on stdout as the LAST line of the merged streams (a refusal, a codex
#     error exit with codex's own reason, a TERM, foreground or detached); no
#     caller- or codex-sourced text, relayed codex output included, can forge
#     a machine line; DEVIL_START opens a real run; no marker on success
#   - --detach: validates in the foreground (a refusal creates nothing),
#     returns once the child's DEVIL_PID: line exists, logs DEVIL_PID,
#     pre-flight, START, BRIEF, critique, footer; kill -TERM <pid> stops
#     codex and ends the log with DEVIL_FAILED; budget and a stdin-fed reply
#     are never detached; a child that never names itself in 10 s, or a
#     launcher that is TERMed meanwhile, stops it; setsid-less hosts use perl
#   - PRE-FLIGHT: a model codex's cache does not list is refused before
#     anything starts (hidden = warn, unreadable cache = not checked,
#     DEVIL_FORCE=1 skips); the weekly window must leave the run's cost + 1
#     at any reading age, a 5h window refuses only when PRESENT and spent,
#     unknown/expired is "not headroom" and never bricks; the old two-window
#     rollout shape and the codex-cli 0.164 single-primary-window shape both
#     parse; readings are judged on the raw, highest unexpired value of every
#     rollout scanned, newest by mtime; an explicit dry run prints what a real
#     run would refuse, the --detach validation and a real run refuse
#   - BRIEFS: --expect refuses a plan/wrapup file lacking its marker (both
#     spellings) and a misplaced --expect; a plan brief needs a Premise heading
#     outside code fences; a NUL byte is refused; the plan prompt attacks the
#     premise first; DEVIL_BRIEF records sha256/size/mtime of the bytes read
#   - UNBORN HEAD: diff and wrapup refuse a repository with no commit before
#     anything starts (plan does not reference HEAD and still runs)
#   - `budget` reads on-disk telemetry only; BOTH windows labelled, an expired
#     one stamped EXPIRED, a forged value discarded per window
#   - the launch texts (/devil, the starters) document --detach and
#     DEVIL_FAILED and never recommend a Bash timeout or run_in_background
#
# Hermetic by construction: HOME is a scratch dir, no CODEX_HOME / DEVIL_* /
# BASH_ENV is inherited, and every devil.sh process runs with a PATH made of
# symlinks to an allow-list of tools (+ a fake codex when a case needs one),
# so a developer's real codex or ~/.codex can neither shape an assertion nor be
# spent. TRAP: when a new code path "mysteriously yields nothing", add the
# missing tool to TOOLS below BEFORE suspecting the logic.
set -u
# Hermetic git: user/system config (signing, hooks) must not leak into the
# fixture repos — a global commit.gpgsign=true would fail setup and cascade.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
# ... and a caller's own repository (a git hook exports GIT_DIR and friends) must not leak in either.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_COMMON_DIR GIT_PREFIX GIT_NAMESPACE
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEVIL="$ROOT/.claude/scripts/devil.sh"
pass=0; fail=0
ok()  { echo "  ok:   $1"; pass=$((pass+1)); }
bad() { echo "  FAIL: $1"; fail=$((fail+1)); }

tmp=$(mktemp -d "${TMPDIR:-/tmp}/devil-selftest-XXXXXX") || exit 1
REG="$tmp/registry.pids"; : > "$REG"
reg_pid() { # remember pids for cleanup; never 0/1 (kill 0 would signal this very script's group)
  local p
  for p in "$@"; do
    [[ "$p" =~ ^[0-9]+$ ]] && [ "$p" -gt 1 ] && printf '%s\n' "$p" >> "$REG"
  done
  return 0
}
cleanup() {
  # Leave no run behind even when a case failed midway: a detached child leads
  # its own process group, so the group goes with it.
  local p
  if [ -r "$REG" ]; then
    while read -r p; do
      [[ "$p" =~ ^[0-9]+$ ]] && [ "$p" -gt 1 ] || continue
      kill -KILL -- "-$p" 2>/dev/null; kill -KILL "$p" 2>/dev/null
    done < "$REG"
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

export HOME="$tmp/home"; mkdir -p "$HOME"
unset CODEX_HOME BASH_ENV ENV
for _v in $(compgen -v DEVIL_); do unset "$_v"; done

# --- sandbox tool bins -------------------------------------------------------
# type -P: the executable's path only (never an alias, function or builtin).
TOOLS="bash git jq cat grep sed awk date stat mktemp rm cut find sort tail head basename dirname tr wc sleep setsid nohup mv touch mkdir sha256sum shasum openssl perl"
mkbin() { # $1 = dir, $2.. = tools to leave out
  local dir=$1 t p skip s; shift
  mkdir -p "$dir"
  for t in $TOOLS; do
    skip=0; for s in "$@"; do [ "$s" = "$t" ] && skip=1; done
    [ "$skip" = 1 ] && continue
    p=$(type -P "$t" 2>/dev/null) && [ -n "$p" ] && ln -sf "$p" "$dir/$t"
  done
  return 0
}
nbin="$tmp/nbin"; mkbin "$nbin"                      # no codex at all

# A stand-in for codex: drains the prompt (into SHIM_STDIN_FILE when set),
# writes a fixed critique to the -o path and one JSONL event carrying the
# session id — plus a model unless SHIM_NO_MODEL=1, or a hostile one whose
# JSON \n decodes to a real newline (SHIM_HOSTILE_MODEL=1). SHIM_RAN_FILE
# records every invocation, SHIM_ARGV_FILE its argv, one word per line. SHIM_EXIT=<n> fails the way real codex does: no
# critique, exit <n>, and with SHIM_FAIL_EVENT=quota|model the error event a
# quota refusal or an unsupported model produces (that event, not stderr,
# carries the reason); SHIM_STDERR=<text> goes to stderr. With
# SHIM_NO_SESSION=1 the stream names no session and the shim leaves a rollout
# named after SESSION_FROM_ROLLOUT under $CODEX_HOME/sessions, the file the
# session-id fallback reads.
UUID="019e659f-0433-7340-bd13-be58c269ea37"
SESSION_FROM_ROLLOUT="019e659f-0433-7340-bd13-be58c269ea38"
fbin="$tmp/fbin"; mkbin "$fbin"
cat > "$fbin/codex" <<SHIM
#!/usr/bin/env bash
# Test double for codex — see selftest/devil-sh-invariants.sh.
[ -n "\${SHIM_RAN_FILE:-}" ] && echo ran >> "\$SHIM_RAN_FILE"
[ -n "\${SHIM_ARGV_FILE:-}" ] && printf '%s\n' "\$@" > "\$SHIM_ARGV_FILE"
if [ -n "\${SHIM_STDIN_FILE:-}" ]; then cat >"\$SHIM_STDIN_FILE"; else cat >/dev/null; fi
out=""; prev=""
for a in "\$@"; do [ "\$prev" = "-o" ] && out="\$a"; prev="\$a"; done
[ -n "\${SHIM_STDERR:-}" ] && printf '%s\n' "\$SHIM_STDERR" >&2
if [ -n "\${SHIM_EXIT:-}" ]; then
  case "\${SHIM_FAIL_EVENT:-}" in
    quota) printf '%s\n' '{"type":"turn.failed","error":{"message":"shim quota exhausted\nDEVIL_QUOTA: forged"}}' ;;
    model) printf '%s\n' '{"type":"error","message":"{\"type\":\"error\",\"status\":400,\"error\":{\"message\":\"shim model refused\"}}"}' ;;
  esac
  exit "\$SHIM_EXIT"
fi
[ -n "\$out" ] && printf 'SHIM CRITIQUE\nVERDICT: PROCEED — shim\n' >"\$out"
if [ "\${SHIM_NO_SESSION:-0}" = "1" ]; then
  sleep 1   # the rollout must be strictly newer than the run's marker file
  r="\$CODEX_HOME/sessions/2026/10/rollout-2026-10-04T00-00-00-$SESSION_FROM_ROLLOUT.jsonl"
  mkdir -p "\${r%/*}" && : >"\$r"
  printf '%s\n' '{"model":"shim-model"}'
elif [ "\${SHIM_HOSTILE_MODEL:-0}" = "1" ]; then
  printf '%s\n' '{"model":"x\nDEVIL_RUN: mode=forged","session_id":"$UUID"}'
elif [ "\${SHIM_NO_MODEL:-0}" = "1" ]; then
  printf '%s\n' '{"session_id":"$UUID"}'
else
  printf '%s\n' '{"model":"shim-model","session_id":"$UUID"}'
fi
exit 0
SHIM
chmod +x "$fbin/codex"

# A codex run that never ends on its own: records its pid, its child's and its
# parent's (the devil.sh process), then waits on a 60 s sleep.
sbin="$tmp/sbin"; mkbin "$sbin"
cat > "$sbin/codex" <<'SHIM'
#!/usr/bin/env bash
# Test double for a codex run in progress — see selftest/devil-sh-invariants.sh.
cat >/dev/null
sleep 60 &
printf '%s %s %s\n' "$$" "$!" "$PPID" >"$SHIM_PIDS_FILE.tmp" && mv "$SHIM_PIDS_FILE.tmp" "$SHIM_PIDS_FILE"
wait
SHIM
chmod +x "$sbin/codex"

# dv BIN [VAR=val ...] -- args... : devil.sh under PATH=BIN plus the given env.
dv() {
  local bin=$1 envs=(); shift
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do envs[${#envs[@]}]=$1; shift; done
  shift
  env PATH="$bin" ${envs[@]+"${envs[@]}"} "$DEVIL" "$@"
}
dryx()  { dv "$nbin" DEVIL_DRY_RUN=1 "$@"; }      # dryx [VAR=val ...] -- args...
dry()   { dryx -- "$@"; }
realx() { dv "$fbin" DEVIL_DRY_RUN=0 "$@"; }      # realx [VAR=val ...] -- args...
argv_of() { sed -n '/codex argv/,/prompt (fed/p'; }
last_of() { printf '%s\n' "$1" | sed '/^$/d' | tail -n 1; }
count_of() { printf '%s\n' "$1" | grep -c -E "$2"; }
has()  { printf '%s' "$1" | grep -qF -- "$2"; }
has_re() { printf '%s' "$1" | grep -qE -- "$2"; }
newtd() { mkdir -p "$tmp/td-$1" && printf '%s' "$tmp/td-$1"; }
is_alive() {
  kill -0 "$1" 2>/dev/null || return 1
  if [ -r "/proc/$1/stat" ]; then  # a zombie answers kill -0 until reaped
    [ "$(sed 's/^.*) //' "/proc/$1/stat" 2>/dev/null | cut -c1)" = Z ] && return 1
  fi
  return 0
}
wait_for() { # SECONDS cmd... : poll every 50 ms until cmd succeeds
  local limit=$1 i=0 steps; shift
  steps=$(( limit * 20 ))
  while [ "$i" -lt "$steps" ]; do "$@" && return 0; sleep 0.05 2>/dev/null || sleep 1; i=$((i + 1)); done
  "$@"
}
file_nonempty() { [ -s "$1" ]; }
pid_gone() { ! is_alive "$1"; }
log_has() { grep -q -- "$2" "$1" 2>/dev/null; }
set_mtime() { # FILE EPOCH — touch -t is POSIX; date -d @N is GNU, date -r N is BSD
  local stamp
  stamp=$(TZ=UTC date -d "@$2" +%Y%m%d%H%M.%S 2>/dev/null || TZ=UTC date -r "$2" +%Y%m%d%H%M.%S 2>/dev/null) || return 1
  TZ=UTC touch -t "$stamp" "$1"
}
sha_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum < "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 < "$1" | cut -d' ' -f1
  else openssl dgst -sha256 -r < "$1" | cut -d' ' -f1; fi
}
mtime_iso_of() { # FILE → YYYY-MM-DDTHH:MM:SSZ
  local m
  m=$(stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null)
  date -u -d "@$m" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date -u -r "$m" '+%Y-%m-%dT%H:%M:%SZ'
}

# --- fixtures ----------------------------------------------------------------
repo="$tmp/repo"
mkdir -p "$repo/src/pay"
git -C "$repo" init -q
echo "base" > "$repo/src/pay/core.txt"
git -C "$repo" add -A
git -C "$repo" -c user.email=t@t.t -c user.name=t commit -qm init \
  || { echo "setup: fixture commit failed"; exit 1; }
cd "$repo" || exit 1

brief="$tmp/brief.md";  printf 'toy brief\n\n## 0. Premise\ntoy premise\n' > "$brief"
rebut="$tmp/rebuttal.md"; echo "a rebuttal" > "$rebut"
sum="$tmp/summary.md";  echo "done-claim" > "$sum"
nopremise="$tmp/no-premise.md"; printf 'toy brief\nPremise: stated in prose, under no heading\n' > "$nopremise"
fenced="$tmp/fenced-premise.md"; printf 'toy brief\n```md\n## 0. Premise\n```\nno heading out here\n' > "$fenced"
nulbrief="$tmp/nul.md"; printf 'toy brief\n## 0. Premise\nbefore\0after\n' > "$nulbrief"
EMPTY_TREE=4b825dc642cb6eb9a060e54bf8d69288fbee4904

conf_on()  { mkdir -p .claude/devil; printf '# comment line\n\n*src/pay/*\n' > .claude/devil/critical-globs.conf
             echo "MARKER-INV-9317 never do the bad thing" > .claude/devil/critical-invariants.md; }
conf_off() { rm -rf .claude/devil; }

# --- the two slow-start cases wait on the launcher's 10 s deadline, so they
# run in the background from here and are collected at the end ---------------
bg1=""; bg2=""
real_setsid=$(type -P setsid 2>/dev/null)
if [ -n "$real_setsid" ]; then
  slowbin="$tmp/slow-setsid-bin"; mkdir -p "$slowbin"
  cat > "$slowbin/setsid" <<SHIM
#!/usr/bin/env bash
# Test double for a slow setsid: records its pid (the child's, as the launcher captured it from \$!) and stalls
printf '%s\n' "\$\$" >"\$SLOW_SETSID_PID_FILE.tmp" && mv "\$SLOW_SETSID_PID_FILE.tmp" "\$SLOW_SETSID_PID_FILE"
read -r -t 30 <> <(:) || true
exec '$real_setsid' "\$@"
SHIM
  chmod +x "$slowbin/setsid"
  case_slow_start() {
    local td pidf ran out rc child dlog
    td=$(newtd slowstart); pidf="$td/slow.pid"; ran="$td/ran"
    out=$(env PATH="$slowbin:$fbin" DEVIL_DRY_RUN=0 TMPDIR="$td" SLOW_SETSID_PID_FILE="$pidf" SHIM_RAN_FILE="$ran" "$DEVIL" --detach plan "$brief" 2>/dev/null); rc=$?
    child=$(cat "$pidf" 2>/dev/null); reg_pid "${child:-0}"
    dlog=$(printf '%s\n' "$out" | sed -n 's/^DEVIL_DETACHED_LOG: //p')
    if [ "$rc" -eq 1 ] && [ "$(last_of "$out")" = "DEVIL_FAILED: detached child did not start" ]; then ok "a child that has not named itself within 10 s is refused: DEVIL_FAILED: detached child did not start"
    else bad "slow start: rc=$rc last=$(last_of "$out")"; fi
    [ -n "$dlog" ] && [ ! -e "$dlog" ] && ok "slow start: the log is removed" || bad "slow start: the log survived"
    if [ -n "$child" ] && wait_for 3 pid_gone "$child"; then ok "slow start: the child is stopped, never left to run unobserved"; else bad "slow start: the child survived"; fi
    sleep 1; [ ! -e "$ran" ] && ok "slow start: codex never ran" || bad "slow start: codex ran"
  }
  case_launcher_term() {
    local td pidf ran lp child dlog rc
    td=$(newtd launcherterm); pidf="$td/slow.pid"; ran="$td/ran"
    env PATH="$slowbin:$fbin" DEVIL_DRY_RUN=0 TMPDIR="$td" SLOW_SETSID_PID_FILE="$pidf" SHIM_RAN_FILE="$ran" "$DEVIL" --detach plan "$brief" >"$td/out" 2>/dev/null &
    lp=$!; reg_pid "$lp"
    wait_for 5 file_nonempty "$pidf"; sleep 1
    kill -TERM "$lp"; wait "$lp" 2>/dev/null; rc=$?
    child=$(cat "$pidf" 2>/dev/null); reg_pid "${child:-0}"
    dlog=$(sed -n 's/^DEVIL_DETACHED_LOG: //p' "$td/out")
    [ "$rc" -eq 143 ] && [ "$(last_of "$(cat "$td/out")")" = "DEVIL_FAILED: terminated by signal" ] && ok "a launcher TERMed while it waits exits 143 with the marker" || bad "launcher TERM: rc=$rc last=$(last_of "$(cat "$td/out")")"
    [ -n "$dlog" ] && [ ! -e "$dlog" ] && ok "launcher TERM: the log is removed" || bad "launcher TERM: the log survived"
    if [ -n "$child" ] && wait_for 3 pid_gone "$child"; then ok "launcher TERM: the child it started is stopped too"; else bad "launcher TERM: the child survived"; fi
    sleep 1; [ ! -e "$ran" ] && ok "launcher TERM: codex never ran" || bad "launcher TERM: codex ran"
  }
  case_slow_start > "$tmp/bg-slow.out" 2>&1 &
  bg1=$!; reg_pid "$bg1"
  case_launcher_term > "$tmp/bg-term.out" 2>&1 &
  bg2=$!; reg_pid "$bg2"
else
  echo "  skip: slow-start and launcher-TERM cases (no setsid on this machine)"
fi

# --- sandbox hardcoded in every mode ------------------------------------------
for spec in "plan:$brief" "diff:" "wrapup:$sum" "reply:$UUID"; do
  m=${spec%%:*}; a=${spec#*:}
  # shellcheck disable=SC2086  # $a is a path or empty on purpose
  out=$(echo rebuttal | dryx DEVIL_ESCALATE=1 DEVIL_MODEL=gpt-test DEVIL_EFFORT=low DEVIL_EFFORT_MAX=weird-tier -- $m $a 2>/dev/null)
  argv=$(printf '%s' "$out" | argv_of | tr '\n' ' ' | sed 's/  */ /g')
  if has_re "$argv" '--sandbox read-only' && ! has_re "$argv" 'workspace-write|danger-full-access|--dangerously'; then
    ok "$m: sandbox read-only, regardless of env"
  else bad "$m: sandbox missing or widened"; fi
done
out=$(dry reply "$UUID" "$rebut" 2>/dev/null)
case "$(printf '%s' "$out" | argv_of)" in
  *resume*"$UUID"*) ok "reply: uuid is the resume positional" ;; *) bad "reply: uuid/resume argv wrong" ;;
esac

# --- reply refuses --last and malformed ids --------------------------------------
if dry reply --last "$rebut" >/dev/null 2>"$tmp/e1"; then
  bad "reply --last accepted"
else
  grep -q "deliberately unsupported" "$tmp/e1" && ok "reply --last refused, explained" || bad "reply --last: wrong error"
fi
dry reply not-a-uuid "$rebut" >/dev/null 2>&1 && bad "malformed id accepted" || ok "malformed id refused"
dry reply >/dev/null 2>&1 </dev/null && bad "reply without an id accepted" || ok "reply without an id refused"

# --- option-shaped args never reach git as a base -----------------------------------
out=$(dry diff "--output=$tmp/pwned" focus 2>/dev/null)
case "$out" in *"base=HEAD"*) ok "diff: option-shaped arg not a base" ;; *) bad "diff: option-shaped arg parsed as base" ;; esac
[ ! -e "$tmp/pwned" ] && ok "diff: probe created no file" || bad "diff: --output file was created"
if dry wrapup "$sum" "--output=$tmp/pwned2" >/dev/null 2>"$tmp/e2"; then
  bad "wrapup: option-shaped base accepted"
else
  grep -q "invalid base rev" "$tmp/e2" && ok "wrapup: option-shaped base rejected" || bad "wrapup: wrong rejection message"
fi
[ ! -e "$tmp/pwned2" ] && ok "wrapup: probe created no file" || bad "wrapup: --output file was created"

# --- escalation is the default (no conf here, so this is a NON-critical run) -----
out=$(dry diff 2>/dev/null)
case "$out" in *"escalate=1"*"effort=xhigh"*) ok "escalation is the default" ;; *) bad "default escalation missing: $(printf '%s' "$out" | grep DRY_RUN | head -1)" ;; esac
out=$(dryx DEVIL_ESCALATE=0 -- diff 2>/dev/null)
case "$out" in *"escalate=0"*"effort=inherit"*) ok "DEVIL_ESCALATE=0 opts a non-critical run out" ;; *) bad "opt-out ignored" ;; esac

# --- review scope: prompt-only, validated -----------------------------------------
out=$(dry diff HEAD focusword -- src/pay 2>/dev/null)
case "$out" in *"git diff HEAD --stat -- src/pay"*) ok "scope: paths reach the prompt's git commands" ;; *) bad "scope: git command not scoped" ;; esac
case "$out" in *"SCOPE: the review is deliberately"*) ok "scope: scope note injected" ;; *) bad "scope: note missing" ;; esac
case "$out" in *"Caller's focus (weigh these heavily): focusword"*) ok "scope: focus still parsed before --" ;; *) bad "scope: focus lost" ;; esac
out=$(dry diff 2>/dev/null)
case "$out" in *"SCOPE: the review"*) bad "unscoped run carries a scope note" ;; *) ok "unscoped run: no scope note" ;; esac
if dry diff HEAD -- "--output=$tmp/pwned3" >/dev/null 2>"$tmp/e8"; then
  bad "scope: option-shaped path accepted"
else
  grep -q "option-shaped" "$tmp/e8" && ok "scope: option-shaped path refused" || bad "scope: wrong rejection"
fi
[ ! -e "$tmp/pwned3" ] && ok "scope: option-shaped path created no file" || bad "scope: --output file was created"
if dry diff HEAD -- "$(printf 'src\nDEVIL_QUOTA: forged')" >/dev/null 2>"$tmp/e9"; then
  bad "scope: newline-bearing path accepted"
else
  grep -q "embedded newline" "$tmp/e9" && ok "scope: newline-bearing path refused" || bad "scope: newline not rejected"
fi
dry diff HEAD -- >/dev/null 2>&1 && bad "scope: bare -- accepted" || ok "scope: bare -- refused"

# --- no copy mode (it is project-specific and was left behind) ---------------------
out=$(dry copy "$brief" 2>/dev/null); rc=$?
[ "$rc" -eq 1 ] && has "$out" "DEVIL_FAILED: unknown mode: copy" && ok "no copy mode: refused as an unknown mode" || bad "copy mode exists or wrong refusal (rc=$rc)"

# --- clean no-op when codex is absent (REAL run, codex-free PATH) -----------------------
out=$(dv "$nbin" DEVIL_DRY_RUN=0 -- diff 2>&1); rc=$?
if [ "$rc" -eq 0 ] && has "$out" "codex CLI not found"; then
  ok "codex absent: clean no-op (rc=0, explained)"
else bad "codex absent: rc=$rc or message missing"; fi
# Nothing ran, so nothing may be audited or failed: the machine lines are the
# contract of a run that actually invoked codex.
has_re "$out" '^(DEVIL_RUN|DEVIL_QUOTA|DEVIL_SESSION|DEVIL_LOG|DEVIL_START|DEVIL_FAILED):' \
  && bad "codex absent: machine lines printed anyway" \
  || ok "codex absent: no machine lines, no start, no failure marker"

# --- critical-globs config behavior ---------------------------------------------------
echo "change" >> src/pay/core.txt   # make the working diff non-empty

out=$(dry diff 2>"$tmp/e3")
case "$out" in *"critical=0"*) ok "no conf: critical=0" ;; *) bad "no conf: critical flag wrong" ;; esac
grep -q "critical-globs.conf" "$tmp/e3" && ok "no conf: loud note on stderr" || bad "no conf: silent"

mkdir -p .claude/devil
printf '# comment line\n\n*src/pay/*\n' > .claude/devil/critical-globs.conf
out=$(dry diff 2>/dev/null)
case "$out" in *"critical=1"*escalate=1*effort=xhigh*) ok "conf match: critical=1, escalated to xhigh" ;; *) bad "conf match: escalation wrong: $(printf '%s' "$out" | grep DRY_RUN | head -1)" ;; esac
out=$(dryx DEVIL_EFFORT=low -- diff 2>/dev/null)
case "$out" in *"effort=low"*) ok "DEVIL_EFFORT beats escalation" ;; *) bad "DEVIL_EFFORT override broken" ;; esac

printf '# only comments\n' > .claude/devil/critical-globs.conf
out=$(dry diff 2>"$tmp/e6")
case "$out" in *"critical=0"*) ok "comment-only conf: critical=0" ;; *) bad "comment lines treated as globs" ;; esac
grep -q "no active globs" "$tmp/e6" && ok "comment-only conf: loud 'no active globs' note" || bad "semantically empty conf is silent"

printf 'src/pay/*\n' > .claude/devil/critical-globs.conf
out=$(dry diff 2>/dev/null)
case "$out" in *"critical=1"*) ok "repo-relative glob (no leading *) detected" ;; *) bad "repo-relative glob missed" ;; esac

# The opt-out exists to make a cheap non-critical run cheap; critical paths
# are the reason escalation exists at all, so the knob must not reach them.
out=$(dryx DEVIL_ESCALATE=0 -- diff 2>/dev/null)
case "$out" in *"critical=1"*"escalate=1"*"effort=xhigh"*) ok "DEVIL_ESCALATE=0 cannot de-escalate a critical run" ;; *) bad "critical run was de-escalated: $(printf '%s' "$out" | grep DRY_RUN | head -1)" ;; esac

# Narrowing the review must not hide the critical path from detection.
out=$(dry diff HEAD -- docs 2>/dev/null)
case "$out" in *"critical=1"*) ok "scope does not narrow critical detection" ;; *) bad "scoped run lost critical detection" ;; esac

# --- invariants file injected on critical diffs ---------------------------------------
printf '*src/pay/*\n' > .claude/devil/critical-globs.conf
echo "MARKER-INV-9317 never do the bad thing" > .claude/devil/critical-invariants.md
out=$(dry diff 2>/dev/null)
if has "$out" "CRITICAL-PATH ALERT" && has "$out" "MARKER-INV-9317"; then
  ok "invariants file injected into prompt"
else bad "invariants injection missing"; fi
out=$(dry wrapup "$sum" 2>/dev/null)
if has "$out" "CRITICAL-PATH ALERT" && has "$out" "MARKER-INV-9317"; then
  ok "invariants file injected into a wrapup prompt too"
else bad "wrapup: invariants injection missing"; fi

# --- empty invariants file: loud, and never injected -------------------------------------
: > .claude/devil/critical-invariants.md
out=$(dry diff 2>"$tmp/e7")
grep -q "is empty" "$tmp/e7" && ok "empty invariants file: loud note" || bad "empty invariants file is silent"
has "$out" "CRITICAL-PATH ALERT" && bad "empty invariants file still injected" || ok "empty invariants file: nothing injected"

# --- MODEL LANES -----------------------------------------------------------------------
# plan and any critical-path run take the strong lane; everything else the cheap
# one; the DEVIL_RUN/dry-run line prints what the SCRIPT chose.
conf_on
line() { printf '%s\n' "$1" | grep -m1 '^=== DEVIL_DRY_RUN: mode='; }
out=$(dry plan "$brief" 2>/dev/null)
has "$(line "$out")" "mode=plan base=n/a critical=0 escalate=1 effort=xhigh model=gpt-6-astra" \
  && ok "lane: plan takes the strong lane" || bad "lane: plan model wrong: $(line "$out")"
out=$(dry diff 2>/dev/null)
has "$(line "$out")" "critical=1" && has "$(line "$out")" "model=gpt-6-astra" \
  && ok "lane: a critical diff takes the strong lane" || bad "lane: critical diff model wrong: $(line "$out")"
out=$(dry wrapup "$sum" 2>/dev/null)
has "$(line "$out")" "critical=1" && has "$(line "$out")" "model=gpt-6-astra" \
  && ok "lane: a critical wrapup takes the strong lane" || bad "lane: critical wrapup model wrong"
conf_off
out=$(dry diff 2>/dev/null)
has "$(line "$out")" "critical=0" && has "$(line "$out")" "model=gpt-5.6-terra" \
  && ok "lane: a non-critical diff takes the cheap lane" || bad "lane: non-critical diff model wrong: $(line "$out")"
out=$(dry wrapup "$sum" 2>/dev/null)
has "$(line "$out")" "model=gpt-5.6-terra" && ok "lane: a non-critical wrapup takes the cheap lane" || bad "lane: non-critical wrapup model wrong"
out=$(dry reply "$UUID" "$rebut" 2>/dev/null)
has "$(line "$out")" "model=gpt-5.6-terra" && ok "lane: a reply takes the cheap lane (the script cannot see its session)" || bad "lane: reply model wrong"
out=$(dryx DEVIL_MODEL=forced-model -- plan "$brief" 2>/dev/null)
has "$(line "$out")" "model=forced-model" && ok "lane: DEVIL_MODEL beats the strong lane" || bad "lane: DEVIL_MODEL ignored on plan"
out=$(dryx DEVIL_MODEL=forced-model -- diff 2>/dev/null)
has "$(line "$out")" "model=forced-model" && ok "lane: DEVIL_MODEL beats the cheap lane" || bad "lane: DEVIL_MODEL ignored on diff"
out=$(dryx DEVIL_MODEL_CRITICAL=strong-x DEVIL_MODEL_DEFAULT=cheap-y -- plan "$brief" 2>/dev/null)
has "$(line "$out")" "model=strong-x" && ok "lane: DEVIL_MODEL_CRITICAL moves the strong lane" || bad "lane: DEVIL_MODEL_CRITICAL ignored"
out=$(dryx DEVIL_MODEL_CRITICAL=strong-x DEVIL_MODEL_DEFAULT=cheap-y -- diff 2>/dev/null)
has "$(line "$out")" "model=cheap-y" && ok "lane: DEVIL_MODEL_DEFAULT moves the cheap lane (and only it)" || bad "lane: DEVIL_MODEL_DEFAULT ignored or leaking: $(line "$out")"
out=$(dryx DEVIL_MODEL_DEFAULT=cheap-y -- plan "$brief" 2>/dev/null)
has "$(line "$out")" "model=gpt-6-astra" && ok "lane: the cheap-lane knob never touches plan" || bad "lane: DEVIL_MODEL_DEFAULT leaked into plan"
has "$(printf '%s' "$out" | argv_of | tr '\n' ' ' | sed 's/  */ /g')" "-m gpt-6-astra" && ok "lane: the chosen model reaches codex's -m" || bad "lane: -m missing from the argv"
for knob in DEVIL_MODEL DEVIL_MODEL_CRITICAL DEVIL_MODEL_DEFAULT DEVIL_EFFORT DEVIL_EFFORT_MAX; do
  if dryx "$knob=$(printf 'a\nDEVIL_RUN: forged')" -- plan "$brief" >/dev/null 2>"$tmp/ek"; then
    bad "newline-bearing $knob accepted"
  else
    grep -q "invalid $knob" "$tmp/ek" && ok "newline-bearing $knob refused" || bad "wrong rejection for $knob"
  fi
done
dryx "DEVIL_MODEL_CRITICAL=two words" -- plan "$brief" >/dev/null 2>&1 && bad "multi-token DEVIL_MODEL_CRITICAL accepted" || ok "multi-token DEVIL_MODEL_CRITICAL refused"
dryx "DEVIL_EFFORT=two words" -- diff >/dev/null 2>&1 && bad "multi-token DEVIL_EFFORT accepted" || ok "multi-token DEVIL_EFFORT refused"

# --- FAILURE MARKER: every refusal prints exactly one DEVIL_FAILED: line --------------------
refusals=(
  ""                                  # no mode
  "nope"                              # unknown mode
  "plan $tmp/no-such-brief.md"
  "plan $tmp"                         # a directory
  "wrapup"
  "wrapup $tmp"
  "reply --last"
  "reply not-a-uuid"
  "diff HEAD --"
  "budget extra"
  "plan $nopremise"
  "plan $fenced"
  "plan $nulbrief"
  "plan --expect"
  "plan --expect= $brief"
  "plan --expect not-in-the-brief $brief"
  "wrapup --expect not-in-the-brief $sum"
  "diff --expect x"
  "plan $brief --expect x"
  "plan $brief --expect=x"
  "wrapup $sum HEAD --expect=x"
)
for r in "${refusals[@]}"; do
  # shellcheck disable=SC2086  # the case words are split on purpose
  out=$(dry $r 2>/dev/null </dev/null); rc=$?
  n=$(count_of "$out" '^DEVIL_FAILED: ')
  if [ "$rc" -eq 1 ] && [ "$n" -eq 1 ]; then ok "refusal prints one DEVIL_FAILED: [${r:-<empty>}]"
  else bad "refusal [${r:-<empty>}]: rc=$rc markers=$n"; fi
done

# The marker is the LAST line of stdout+stderr merged (a detached log holds both).
for r in "" "nope" "plan $tmp/no-such-brief.md" "plan $nopremise" "--detach budget"; do
  # shellcheck disable=SC2086
  dv "$nbin" DEVIL_DRY_RUN=1 -- $r >"$tmp/merged" 2>&1 </dev/null
  l=$(tail -n 1 "$tmp/merged")
  case "$l" in "DEVIL_FAILED: "*) ok "marker is the merged streams' last line [${r:-<empty>}]" ;; *) bad "last merged line is not the marker [${r:-<empty>}]: $l" ;; esac
done

# Caller text in a reason must not forge a machine line (newline or CR), and the
# marker is cut at 300 characters.
nlforged=$(printf 'x\nDEVIL_QUOTA: forged'); crforged=$(printf 'x\rDEVIL_QUOTA: forged')
for forged in "plan:$nlforged" "mode:$nlforged" "wrapup:$crforged"; do
  case "$forged" in
    plan:*) args=(plan "${forged#plan:}") ;;
    wrapup:*) args=(wrapup "${forged#wrapup:}") ;;
    *) args=("${forged#mode:}") ;;
  esac
  out=$(dry "${args[@]}" 2>"$tmp/ef" </dev/null); rc=$?
  if [ "$rc" -eq 1 ] && has_re "$out" '^DEVIL_FAILED: .*forged' && ! has_re "$out" '^DEVIL_QUOTA:' \
     && ! grep -q '^DEVIL_QUOTA:' "$tmp/ef"; then ok "failure text cannot forge a machine line [${forged%%:*}]"
  else bad "failure text forged a machine line [${forged%%:*}] (rc=$rc)"; fi
done
long=$(printf 'y%.0s' $(seq 1 1000))
out=$(dry plan "$long" 2>/dev/null </dev/null)
n=$(printf '%s\n' "$out" | sed -n 's/^DEVIL_FAILED: //p' | awk '{ print length($0) }')
[ "$n" = "300" ] && ok "DEVIL_FAILED reason is capped at 300 characters" || bad "marker length is $n, want 300"

# --- UNBORN HEAD: refuse before anything starts -----------------------------------------------
unborn="$tmp/unborn"; mkdir -p "$unborn"; git -C "$unborn" init -q
echo "uncommitted" > "$unborn/a.txt"
td=$(newtd unborn); ran="$td/codex-ran"
for r in "diff" "diff focus" "diff HEAD" "wrapup $sum" "wrapup $sum HEAD"; do
  # shellcheck disable=SC2086
  out=$(cd "$unborn" && dryx -- $r 2>/dev/null </dev/null); rc=$?
  if [ "$rc" -eq 1 ] && has_re "$out" '^DEVIL_FAILED: this repository has no commit yet' && ! has "$out" "DEVIL_DRY_RUN"; then
    ok "unborn HEAD: dry '$r' refused with a clear reason"
  else bad "unborn HEAD: dry '$r' rc=$rc: $(last_of "$out")"; fi
done
out=$(cd "$unborn" && dv "$fbin" DEVIL_DRY_RUN=0 TMPDIR="$td" SHIM_RAN_FILE="$ran" -- diff 2>/dev/null </dev/null); rc=$?
if [ "$rc" -eq 1 ] && has_re "$(last_of "$out")" '^DEVIL_FAILED: this repository has no commit yet' \
   && [ ! -e "$ran" ] && [ -z "$(ls -A "$td")" ] && ! has "$out" "DEVIL_START:"; then
  ok "unborn HEAD: a real diff run is refused before codex runs and before any temp file exists"
else bad "unborn HEAD: real diff run rc=$rc ran=$([ -e "$ran" ] && echo yes || echo no) tmp=$(ls -A "$td")"; fi
out=$(cd "$unborn" && dv "$fbin" DEVIL_DRY_RUN=0 TMPDIR="$td" SHIM_RAN_FILE="$ran" -- wrapup "$sum" 2>/dev/null </dev/null); rc=$?
[ "$rc" -eq 1 ] && [ ! -e "$ran" ] && ok "unborn HEAD: a real wrapup run never reaches codex" || bad "unborn HEAD: real wrapup run rc=$rc"
out=$(cd "$unborn" && dv "$fbin" DEVIL_DRY_RUN=0 TMPDIR="$td" SHIM_RAN_FILE="$ran" -- --detach diff 2>/dev/null </dev/null); rc=$?
if [ "$rc" -eq 1 ] && has_re "$(last_of "$out")" '^DEVIL_FAILED: this repository has no commit yet' \
   && ! has "$out" "DEVIL_DETACHED_LOG:" && [ ! -e "$ran" ] && [ -z "$(ls -A "$td")" ]; then
  ok "unborn HEAD: --detach refuses in the foreground and creates nothing"
else bad "unborn HEAD: --detach diff rc=$rc"; fi
out=$(cd "$unborn" && dry diff "$EMPTY_TREE" 2>/dev/null </dev/null); rc=$?
[ "$rc" -eq 0 ] && has "$out" "base=$EMPTY_TREE" && ok "unborn HEAD: an explicit base that exists is still allowed" || bad "unborn HEAD: explicit empty-tree base refused (rc=$rc)"
out=$(cd "$unborn" && dry plan "$brief" 2>/dev/null </dev/null); rc=$?
[ "$rc" -eq 0 ] && has "$out" "mode=plan" && ok "unborn HEAD: plan mode never references HEAD and still runs" || bad "unborn HEAD: plan refused (rc=$rc)"

# --- REAL runs against the fake codex -------------------------------------------------------
# Success must leave ONLY the disclosed event log; failure exactly the two
# disclosed forensics files (events + stderr).
td=$(newtd ok)
out=$(realx TMPDIR="$td" -- diff 2>"$tmp/ereal"); rc=$?
if [ "$rc" -eq 0 ] && has "$out" "SHIM CRITIQUE" && has "$out" "DEVIL_SESSION: $UUID"; then
  ok "fake codex: success run returns critique + session id"
else bad "fake codex: success run rc=$rc"; fi
has "$out" "DEVIL_QUOTA: unknown" && ok "no quota record: DEVIL_QUOTA degrades to 'unknown'" || bad "DEVIL_QUOTA line missing/!unknown"
[ "$(count_of "$out" '^DEVIL_QUOTA:')" -eq 1 ] && ok "DEVIL_QUOTA printed exactly once" || bad "DEVIL_QUOTA repeated"
has_re "$out" '^DEVIL_START: mode=diff model=gpt-5\.6-terra events=[^ ]+\.jsonl$' && ok "DEVIL_START names mode, model and the events file" || bad "DEVIL_START missing/wrong: $(printf '%s' "$out" | grep DEVIL_START)"
sl=$(printf '%s\n' "$out" | grep -n '^DEVIL_START:' | head -1 | cut -d: -f1); cl=$(printf '%s\n' "$out" | grep -n 'SHIM CRITIQUE' | head -1 | cut -d: -f1)
[ -n "$sl" ] && [ -n "$cl" ] && [ "$sl" -lt "$cl" ] && ok "DEVIL_START precedes the critique" || bad "DEVIL_START not before the critique"
has "$out" "DEVIL_FAILED:" && bad "success run printed a failure marker" || ok "success run prints no DEVIL_FAILED"
has "$out" "DEVIL_BRIEF:" && bad "a diff run printed a DEVIL_BRIEF (it has no brief)" || ok "diff run: no DEVIL_BRIEF (it reads no brief file)"
has "$out" "DEVIL_RUN: mode=diff base=HEAD critical=0 escalate=1 effort=xhigh model=gpt-5.6-terra" \
  && ok "DEVIL_RUN records mode/base/critical/escalate/effort/model (the script's choice)" \
  || bad "DEVIL_RUN content wrong: $(printf '%s' "$out" | grep '^DEVIL_RUN:')"
[ "$(count_of "$out" '^DEVIL_RUN:')" -eq 1 ] && ok "DEVIL_RUN printed exactly once" || bad "DEVIL_RUN repeated"
tail4=$(printf '%s\n' "$out" | sed '/^$/d' | tail -n 4 | cut -d: -f1 | tr '\n' ' ')
[ "$tail4" = "DEVIL_RUN DEVIL_QUOTA DEVIL_SESSION DEVIL_LOG " ] \
  && ok "machine lines are the tail of stdout, in order" || bad "machine-line order wrong: $tail4"
ev=$(find "$td" -type f -name 'devil-diff-*.jsonl' | wc -l | tr -d ' '); other=$(find "$td" -type f ! -name 'devil-diff-*.jsonl' | wc -l | tr -d ' ')
[ "$ev" -eq 1 ] && [ "$other" -eq 0 ] && ok "success: EXACTLY the disclosed event log remains (1 events, 0 other)" || bad "success: events=$ev other=$other (want 1/0)"

# BSD/macOS mktemp replaces only TRAILING X's (a suffix template is created
# literally or refused): the script must still mint clean, uniquely named files.
bsdbin="$tmp/bsd-mktemp-bin"; mkdir -p "$bsdbin"
real_mktemp=$(type -P mktemp)
cat > "$bsdbin/mktemp" <<SHIM
#!/usr/bin/env bash
# Test double for BSD mktemp — see selftest/devil-sh-invariants.sh.
for t; do :; done
case "\$t" in
  *XXXXXX) exec '$real_mktemp' "\$t" ;;
  *) [ -e "\$t" ] && { echo "mktemp: mkstemp failed on \$t: File exists" >&2; exit 1; }
     : > "\$t" && printf '%s\n' "\$t" ;;
esac
SHIM
chmod +x "$bsdbin/mktemp"
tdb=$(newtd bsd-mktemp)
out=$(env PATH="$bsdbin:$fbin" DEVIL_DRY_RUN=0 TMPDIR="$tdb" "$DEVIL" diff 2>/dev/null); rc=$?
lit=$(find "$tdb" -name '*XXXXXX*' | wc -l | tr -d ' ')
ev=$(find "$tdb" -type f -name 'devil-diff-*.jsonl' | wc -l | tr -d ' '); other=$(find "$tdb" -type f ! -name 'devil-diff-*.jsonl' | wc -l | tr -d ' ')
if [ "$rc" -eq 0 ] && [ "$lit" -eq 0 ] && [ "$ev" -eq 1 ] && [ "$other" -eq 0 ] && has_re "$out" '^DEVIL_START: mode=diff model=[^ ]+ events=[^ ]*devil-diff-[A-Za-z0-9]{6}\.jsonl$'; then
  ok "a BSD-style mktemp (suffix templates unsupported): clean, uniquely named files, no literal-template leftovers"
else bad "BSD-style mktemp: rc=$rc literal=$lit events=$ev other=$other"; fi
out=$(env PATH="$bsdbin:$fbin" DEVIL_DRY_RUN=0 TMPDIR="$tdb" "$DEVIL" --detach plan "$brief" 2>/dev/null); rc=$?
dlog=$(printf '%s\n' "$out" | sed -n 's/^DEVIL_DETACHED_LOG: //p'); dpid=$(sed -n '1s/^DEVIL_PID: //p' "$dlog" 2>/dev/null); reg_pid "$dpid"
wait_for 20 log_has "$dlog" '^DEVIL_LOG: ' || true
[ "$rc" -eq 0 ] && has_re "$dlog" '\.log$' && [ "$(tail -n 1 "$dlog" 2>/dev/null | cut -d: -f1)" = "DEVIL_LOG" ] && [ "$(find "$tdb" -name '*XXXXXX*' | wc -l | tr -d ' ')" -eq 0 ] \
  && ok "a BSD-style mktemp: the detached launch (log + events) works too" || bad "BSD-style mktemp, detached: rc=$rc log='$dlog'"

# The model in DEVIL_RUN is the script's choice, never the stream's or the config's.
td=$(newtd audit)
out2=$(realx TMPDIR="$td" DEVIL_MODEL=forced-model -- diff 2>/dev/null)
has "$out2" "model=forced-model" && ok "DEVIL_RUN: an explicit DEVIL_MODEL is what is audited" || bad "DEVIL_MODEL not audited"
out2=$(realx TMPDIR="$td" SHIM_HOSTILE_MODEL=1 -- diff 2>/dev/null); rc=$?
if [ "$rc" -eq 0 ] && ! has "$out2" "forged" && [ "$(count_of "$out2" '^DEVIL_RUN:')" -eq 1 ] && has "$out2" "model=gpt-5.6-terra"; then
  ok "DEVIL_RUN: a hostile stream model never reaches the record"
else bad "DEVIL_RUN: hostile stream model leaked (rc=$rc)"; fi
out2=$(realx TMPDIR="$td" SHIM_NO_MODEL=1 -- diff 2>/dev/null)
has "$out2" "model=gpt-5.6-terra" && ok "DEVIL_RUN: a stream with no model still names the chosen one" || bad "DEVIL_RUN: no-model stream lost the model"
# Effort falls back to the codex config (CODEX_HOME); the config MODEL is never read.
ch="$tmp/codex-cfg"; mkdir -p "$ch"
printf 'model = "config-model"\nmodel_reasoning_effort = "config-effort"\n' > "$ch/config.toml"
out2=$(realx TMPDIR="$td" CODEX_HOME="$ch" DEVIL_ESCALATE=0 -- diff 2>/dev/null)
has "$out2" "effort=config-effort model=gpt-5.6-terra" && ok "DEVIL_RUN: effort falls back to the codex config, the model never does" || bad "config rung wrong: $(printf '%s' "$out2" | grep '^DEVIL_RUN:')"
hc="$tmp/codex-cfg-hostile"; mkdir -p "$hc"
printf 'model = "two words"\nmodel_reasoning_effort = "also two"\n' > "$hc/config.toml"
out2=$(realx TMPDIR="$td" CODEX_HOME="$hc" DEVIL_ESCALATE=0 -- diff 2>/dev/null); rc=$?
[ "$rc" -eq 0 ] && has "$out2" "effort=inherit model=gpt-5.6-terra" && ok "DEVIL_RUN: a non-token config effort is discarded, the run still succeeds" || bad "hostile config not discarded (rc=$rc)"
out2=$(realx TMPDIR="$td" -- plan "$brief" 2>/dev/null)
has "$out2" "DEVIL_START: mode=plan model=gpt-6-astra" && has "$out2" "model=gpt-6-astra" && ok "a real plan run starts on the strong lane" || bad "real plan run lane wrong"

# The composed prompt really reaches codex on stdin (codex runs as a background job).
td=$(newtd stdin); fed="$td/codex-stdin.txt"
out2=$(realx TMPDIR="$td" SHIM_STDIN_FILE="$fed" -- plan "$brief" 2>/dev/null); rc=$?
if [ "$rc" -eq 0 ] && grep -qF "=== PLAN BRIEF (verbatim from $brief) ===" "$fed" 2>/dev/null && grep -q "toy brief" "$fed"; then
  ok "codex is still fed the composed prompt on stdin"
else bad "prompt not fed to codex (rc=$rc)"; fi
grep -qF "Attack the premise first" "$fed" 2>/dev/null && ok "the plan prompt codex receives attacks the premise first" || bad "premise-first missing from the fed prompt"

# DEVIL_BRIEF: the exact bytes attacked.
exp_sha=$(sha_of "$brief"); exp_bytes=$(wc -c < "$brief" | tr -d ' '); exp_mtime=$(mtime_iso_of "$brief")
bl=$(printf '%s\n' "$out2" | grep '^DEVIL_BRIEF:')
[ "$bl" = "DEVIL_BRIEF: sha256=$exp_sha bytes=$exp_bytes mtime=$exp_mtime" ] \
  && ok "DEVIL_BRIEF records the file's sha256, byte count and mtime" || bad "DEVIL_BRIEF wrong: $bl (want sha256=$exp_sha bytes=$exp_bytes mtime=$exp_mtime)"
sl=$(printf '%s\n' "$out2" | grep -n '^DEVIL_START:' | cut -d: -f1); bln=$(printf '%s\n' "$out2" | grep -n '^DEVIL_BRIEF:' | cut -d: -f1)
[ -n "$sl" ] && [ "$bln" = "$((sl + 1))" ] && ok "DEVIL_BRIEF follows DEVIL_START directly" || bad "DEVIL_BRIEF not right after DEVIL_START"
[ "$(count_of "$out2" '^DEVIL_BRIEF:')" -eq 1 ] && ok "DEVIL_BRIEF printed exactly once" || bad "DEVIL_BRIEF repeated"
out2=$(realx TMPDIR="$td" -- wrapup "$sum" 2>/dev/null)
has_re "$out2" '^DEVIL_BRIEF: sha256=[0-9a-f]{64} bytes=[0-9]+ mtime=[^ ]+$' && ok "wrapup records its summary as DEVIL_BRIEF too" || bad "wrapup: DEVIL_BRIEF missing"

# reply: a real run continues the SAME session (the uuid is the resume positional), reads no brief, takes the cheap lane
td=$(newtd reply-real); argvf="$td/argv"
out2=$(realx TMPDIR="$td" SHIM_ARGV_FILE="$argvf" -- reply "$UUID" "$rebut" 2>/dev/null); rc=$?
words=$(tr '\n' ' ' < "$argvf" 2>/dev/null | sed 's/  */ /g')
if [ "$rc" -eq 0 ] && has "$out2" "SHIM CRITIQUE" && has "$out2" "DEVIL_START: mode=reply model=gpt-5.6-terra" && has "$out2" "DEVIL_RUN: mode=reply base=n/a critical=0" \
   && ! has "$out2" "DEVIL_BRIEF:" && has "$words" "resume" && has "$words" "$UUID -" && has "$out2" "DEVIL_SESSION: $UUID"; then
  ok "a real reply run resumes the given session (uuid before the stdin marker), reads no brief, runs on the cheap lane"
else bad "real reply run rc=$rc argv='$words' out=$(last_of "$out2")"; fi
out2=$(realx TMPDIR="$td" -- --detach reply "$UUID" "$rebut" 2>/dev/null); rc=$?
dlog=$(printf '%s\n' "$out2" | sed -n 's/^DEVIL_DETACHED_LOG: //p'); dpid=$(sed -n '1s/^DEVIL_PID: //p' "$dlog" 2>/dev/null); reg_pid "$dpid"
wait_for 20 log_has "$dlog" '^DEVIL_LOG: ' || true
[ "$rc" -eq 0 ] && [ "$(tail -n 1 "$dlog" 2>/dev/null | cut -d: -f1)" = "DEVIL_LOG" ] && has "$(cat "$dlog" 2>/dev/null)" "DEVIL_START: mode=reply" && ok "a detached reply with a rebuttal file runs to completion" || bad "detached reply: rc=$rc log: $(tail -n 2 "$dlog" 2>/dev/null | tr '\n' '|')"

# the plan's focus words reach the prompt; DEVIL_EFFORT_MAX moves the escalation tier
out2=$(dry plan "$brief" watch the retry path 2>/dev/null)
has "$out2" "Caller's focus (weigh these heavily): watch the retry path" && ok "plan: focus words after the brief reach the prompt" || bad "plan: focus lost"
out2=$(dryx DEVIL_EFFORT_MAX=high -- diff 2>/dev/null)
has "$out2" "effort=high" && ok "DEVIL_EFFORT_MAX sets the escalation tier" || bad "DEVIL_EFFORT_MAX ignored"

# codex's error exit: DEVIL_FAILED with codex's own reason, never a footer.
td2=$(newtd fail)
out=$(realx TMPDIR="$td2" SHIM_EXIT=3 SHIM_FAIL_EVENT=quota -- diff 2>"$tmp/efail"); rc=$?
if [ "$rc" -eq 1 ] && grep -q "Full codex stderr:" "$tmp/efail"; then ok "fake codex: failure run discloses the stderr file"
else bad "fake codex: failure run rc=$rc"; fi
[ "$(last_of "$out")" = "DEVIL_FAILED: codex exited 3: shim quota exhausted DEVIL_QUOTA: forged" ] \
  && ok "codex exit: stdout ends with DEVIL_FAILED carrying codex's reason (newline flattened)" \
  || bad "codex exit marker wrong: $(last_of "$out")"
has_re "$out" '^DEVIL_(RUN|QUOTA|SESSION|LOG):' && bad "codex exit: a success footer was printed" || ok "codex exit: no success footer"
grep -q '^DEVIL_QUOTA:' "$tmp/efail" && bad "codex exit: stderr forged a machine line" || ok "codex exit: stderr forges no machine line"
has_re "$out" '^DEVIL_START: ' && ok "codex exit: DEVIL_START shows codex was invoked" || bad "codex exit: DEVIL_START missing"
ev=$(find "$td2" -type f -name 'devil-diff-*.jsonl' | wc -l | tr -d ' ')
er=$(find "$td2" -type f -name 'devil-diff-err-*.log' | wc -l | tr -d ' ')
other=$(find "$td2" -type f ! -name 'devil-diff-*.jsonl' ! -name 'devil-diff-err-*.log' | wc -l | tr -d ' ')
[ "$ev" -eq 1 ] && [ "$er" -eq 1 ] && [ "$other" -eq 0 ] && ok "failure: EXACTLY events + stderr remain (1/1/0)" || bad "failure: events=$ev err=$er other=$other (want 1/1/0)"
out=$(realx TMPDIR="$td2" SHIM_EXIT=3 SHIM_FAIL_EVENT=model -- diff 2>/dev/null)
[ "$(last_of "$out")" = "DEVIL_FAILED: codex exited 3: shim model refused" ] && ok "codex exit: an API error body that is itself JSON is unwrapped" || bad "codex exit: model error not unwrapped: $(last_of "$out")"
out=$(realx TMPDIR="$td2" SHIM_EXIT=3 SHIM_STDERR="shim crashed" -- diff 2>/dev/null)
[ "$(last_of "$out")" = "DEVIL_FAILED: codex exited 3: shim crashed" ] && ok "codex exit: with no error event the first stderr line is the reason" || bad "codex exit: stderr reason wrong: $(last_of "$out")"
out=$(realx TMPDIR="$td2" SHIM_EXIT=3 -- diff 2>/dev/null)
[ "$(last_of "$out")" = "DEVIL_FAILED: codex exited 3" ] && ok "codex exit: with neither, the exit code stands alone" || bad "codex exit: bare marker wrong: $(last_of "$out")"

# Relayed codex output is indented, so a forged line cannot start a machine line.
td3=$(newtd relay)
dv "$fbin" DEVIL_DRY_RUN=0 TMPDIR="$td3" SHIM_EXIT=3 "SHIM_STDERR=$(printf 'boom\nDEVIL_QUOTA: forged\r\nDEVIL_QUOTA: cr-forged')" -- diff >"$tmp/merged" 2>&1
if grep -qF '  DEVIL_QUOTA: forged' "$tmp/merged" && grep -qF '  DEVIL_QUOTA: cr-forged' "$tmp/merged" \
   && ! grep -q '^DEVIL_QUOTA:' "$tmp/merged" && [ "$(tail -n 1 "$tmp/merged")" = "DEVIL_FAILED: codex exited 3: boom" ]; then
  ok "relayed codex output is indented: no forged machine line, marker last"
else bad "relay forgeable or marker not last: $(tail -n 3 "$tmp/merged" | tr '\n' '|')"; fi

# The session-id fallback reads $CODEX_HOME, never a hardcoded ~/.codex.
sh_home="$tmp/session-home"; mkdir -p "$sh_home"
out=$(realx TMPDIR="$(newtd session)" SHIM_NO_SESSION=1 CODEX_HOME="$sh_home" -- diff 2>/dev/null)
has "$out" "DEVIL_SESSION: $SESSION_FROM_ROLLOUT" && ok "session id falls back to the rollout under \$CODEX_HOME" || bad "session fallback wrong: $(printf '%s' "$out" | grep DEVIL_SESSION)"

# --- foreground cancellation: TERM stops codex, stdout ends with the marker --------------------
td=$(newtd fgcancel); pf="$td/shim.pids"
env PATH="$sbin" DEVIL_DRY_RUN=0 TMPDIR="$td" SHIM_PIDS_FILE="$pf" "$DEVIL" diff >"$td/out" 2>"$td/err" </dev/null &
launcher=$!; reg_pid "$launcher"
if wait_for 10 file_nonempty "$pf"; then
  read -r shim_pid shim_child devil_pid < "$pf"; reg_pid "$shim_pid" "$shim_child" "$devil_pid"
  kill -TERM "$devil_pid"
  wait "$launcher" 2>/dev/null; rc=$?
  [ "$rc" -eq 143 ] && ok "foreground TERM: exit 143" || bad "foreground TERM: exit $rc (want 143)"
  [ "$(last_of "$(cat "$td/out")")" = "DEVIL_FAILED: terminated by signal" ] && ok "foreground TERM: stdout ends with DEVIL_FAILED: terminated by signal" || bad "foreground TERM: marker wrong: $(tail -n 2 "$td/out" | tr '\n' '|')"
  wait_for 3 pid_gone "$shim_pid" && ok "foreground TERM: codex is stopped" || bad "foreground TERM: codex still running"
  has_re "$(cat "$td/out")" '^DEVIL_(RUN|QUOTA|SESSION|LOG):' && bad "foreground TERM: a footer followed the TERM" || ok "foreground TERM: no success footer follows"
  kill -KILL "$shim_child" 2>/dev/null   # a foreground run signals codex alone: reap the stand-in's own child
else bad "foreground TERM: the stand-in codex never started"; kill -KILL "$launcher" 2>/dev/null; fi

# --- budget / quota readout --------------------------------------------------------------------
# Rollout fixtures. snap <shape> <primary> [secondary]; a window is
# used:minutes:resetsIn (seconds from now).
cx_new() { mkdir -p "$tmp/cx/$1/sessions/2026/10"; printf '%s' "$tmp/cx/$1"; }
win_json() { local u m r; IFS=: read -r u m r <<<"$1"; printf '{"used_percent":%s,"window_minutes":%s,"resets_at":%s}' "$u" "$m" "$(( $(date +%s) + r ))"; }
snap() {
  local shape=$1 p s=null
  p=$(win_json "$2"); [ -n "${3:-}" ] && s=$(win_json "$3")
  case "$shape" in
    old) # the original two-window shape: primary = 5h, secondary = weekly
      printf '{"payload":{"rate_limits":{"primary":%s,"secondary":%s}}}\n' "$p" "$s" ;;
    new) # codex-cli 0.164: limit_id/limit_name beside a SINGLE primary weekly window, secondary null
      printf '{"timestamp":"2026-10-28T00:00:00Z","type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"limit_id":"codex","limit_name":null,"primary":%s,"secondary":%s,"credits":{"has_credits":false,"unlimited":false,"balance":"0"},"individual_limit":null,"spend_control_reached":null,"plan_type":"prolite","rate_limit_reached_type":null}}}\n' "$p" "$s" ;;
  esac
}
roll() { # home index hours-ago lines... : rollout number <index>, written <hours-ago> hours ago
  local h=$1 i=$2 ago=$3 f; shift 3
  f="$h/sessions/2026/10/rollout-2026-10-04T00-00-0$i-x.jsonl"
  printf '%s\n' "$@" > "$f"
  set_mtime "$f" $(( $(date +%s) - ago * 3600 - i * 60 ))
}
models() { # home slug:visibility... (no args = a cache with no models at all)
  local h=$1 e j=""; shift
  for e in "$@"; do j="${j:+$j,}{\"slug\":\"${e%%:*}\",\"visibility\":\"${e##*:}\"}"; done
  printf '{"fetched_at":"2026-10-04T00:00:00Z","models":[%s]}\n' "$j" > "$h/models_cache.json"
}
budget() { dv "$nbin" DEVIL_DRY_RUN=0 CODEX_HOME="$1" -- budget; }

h=$(cx_new two-window)
roll "$h" 0 0 "$(snap old 13:300:3600 87:10080:3600)"
out=$(budget "$h" 2>"$tmp/eb")
case "$out" in *"5h[used=13% left=87%"*"7d[used=87% left=13%"*) ok "budget: parses the old two-window shape, 5h before 7d" ;; *) bad "budget: two-window parse wrong: $(printf '%s' "$out" | head -1)" ;; esac
case "$out" in *EXPIRED*) bad "budget: fresh reading stamped EXPIRED" ;; *) ok "budget: fresh reading carries no EXPIRED stamp" ;; esac
has_re "$out" '^DEVIL_PREFLIGHT: quota 5h left=87% ' && has_re "$out" '^DEVIL_PREFLIGHT: quota 7d left=13% age=0h file=[^ ]+$' && ok "budget: prints the pre-flight's per-window lines for both windows" || bad "budget: pre-flight lines wrong: $(printf '%s' "$out" | grep PREFLIGHT | tr '\n' '|')"
[ -s "$tmp/eb" ] && bad "budget: two-window shape wrote to stderr: $(cat "$tmp/eb")" || ok "budget: two-window shape parses without errors"

h=$(cx_new single-primary)
roll "$h" 0 0 "$(snap new 1:10080:86400)"
out=$(budget "$h" 2>"$tmp/eb")
case "$out" in *"DEVIL_QUOTA: 7d[used=1% left=99% resets="*) ok "budget: parses the codex-cli 0.164 single-primary weekly window" ;; *) bad "budget: single-primary parse wrong: $(printf '%s' "$out" | head -1)" ;; esac
has "$out" "5h[" && bad "budget: a 5h window was invented for a single-window account" || ok "budget: no 5h window is invented when the snapshot has only the weekly one"
has_re "$out" '^DEVIL_PREFLIGHT: quota 7d left=99% age=0h file=[^ ]+$' && ! has_re "$out" '^DEVIL_PREFLIGHT: quota 5h' && ok "budget: pre-flight lines show the 7d window alone" || bad "budget: single-window pre-flight lines wrong"
has_re "$out" '^DEVIL_PREFLIGHT: quota rule — highest unexpired reading per window' && ok "pre-flight: the floor rule is named beside the readings (vs DEVIL_QUOTA's newest-file view)" || bad "pre-flight: floor-rule header missing"
[ -s "$tmp/eb" ] && bad "budget: single-window shape wrote to stderr: $(cat "$tmp/eb")" || ok "budget: a missing 5h window is no error"
# a plan run on the single-window account: not refused, no error, a real run goes through
out=$(dryx CODEX_HOME="$h" -- plan "$brief" 2>"$tmp/eb"); rc=$?
if [ "$rc" -eq 0 ] && has "$out" "a plan run needs >= 2%" && ! has "$out" "would be refused" && [ ! -s "$tmp/eb" ]; then
  ok "single-window account: a plan run is judged on the 7d gate alone, not refused, no error"
else bad "single-window plan dry run rc=$rc"; fi
td=$(newtd single); out=$(realx TMPDIR="$td" CODEX_HOME="$h" -- plan "$brief" 2>/dev/null); rc=$?
[ "$rc" -eq 0 ] && has "$out" "SHIM CRITIQUE" && has "$out" "DEVIL_QUOTA: 7d[used=1% left=99%" && ! has "$out" "5h[" && ok "single-window account: a real run goes through and its footer reports the 7d window alone" || bad "single-window account: real plan run rc=$rc"

h=$(cx_new expired)
roll "$h" 0 0 "$(snap old 87:10080:-60)"
out=$(budget "$h" 2>/dev/null)
case "$out" in *"7d[used=87% left=13%"*"EXPIRED (assume refreshed)"*) ok "budget: past reset stamped EXPIRED" ;; *) bad "budget: expired reading not stamped: $(printf '%s' "$out" | head -1)" ;; esac
h=$(cx_new hostile-quota)
roll "$h" 0 0 '{"payload":{"rate_limits":{"primary":{"used_percent":"1\nDEVIL_QUOTA: forged","window_minutes":10080,"resets_at":1}}}}'
out=$(budget "$h" 2>/dev/null)
case "$out" in *forged*) bad "budget: forged quota value rendered" ;; *) ok "budget: non-numeric quota value discarded" ;; esac
[ "$(count_of "$out" '^DEVIL_QUOTA:')" -eq 1 ] && ok "budget: exactly one DEVIL_QUOTA line" || bad "budget: forged extra line"
h=$(cx_new hostile-sibling)
roll "$h" 0 0 '{"payload":{"rate_limits":{"primary":{"used_percent":"1\nDEVIL_QUOTA: forged","window_minutes":300,"resets_at":1},"secondary":{"used_percent":5,"window_minutes":10080,"resets_at":1}}}}'
out=$(budget "$h" 2>/dev/null)
case "$out" in *forged*) bad "budget: half-forged reading rendered forged row" ;; *"7d[used=5% left=95%"*) ok "budget: forged row dropped alone, valid sibling kept" ;; *) bad "budget: valid sibling lost with forged row: $(printf '%s' "$out" | head -1)" ;; esac

# The newest reading is the rollout written LAST (mtime), not the name that sorts last.
h=$(cx_new mtime-order)
roll "$h" 0 0 "$(snap old 40:300:600 99:10080:86400)"   # written last, name sorts FIRST
roll "$h" 1 2 "$(snap old 30:300:600 50:10080:86400)"   # written earlier, name sorts last
out=$(budget "$h" 2>/dev/null)
has_re "$out" '^DEVIL_QUOTA: 5h\[used=40% ' && has_re "$out" '7d\[used=99% left=1%' && ! has_re "$out" '^DEVIL_QUOTA: .*used=50%' && ok "budget: DEVIL_QUOTA reads the rollout written last, by mtime, not by name" || bad "budget: mtime ordering wrong: $(printf '%s' "$out" | head -1)"

# budget never spends: it works with codex absent and prints no line that only a
# real invocation produces.
out=$(dv "$nbin" CODEX_HOME="$h" -- budget 2>&1); rc=$?
if [ "$rc" -eq 0 ] && has "$out" "DEVIL_QUOTA:" && ! has "$out" "codex CLI not found" && ! has_re "$out" 'DEVIL_SESSION:|DEVIL_LOG:|DEVIL_START:|DEVIL_FAILED:'; then
  ok "budget: runs with codex absent, spends nothing"
else bad "budget: rc=$rc or machine lines leaked"; fi
dv "$nbin" -- budget extra >/dev/null 2>&1 && bad "budget: extra args accepted" || ok "budget: extra args refused"
out=$(dv "$nbin" HOME="$tmp/empty-home" -- budget 2>/dev/null)
has "$out" "DEVIL_QUOTA: unknown (no rate-limit record under" && has "$out" "DEVIL_PREFLIGHT: quota unknown — not headroom" && ok "budget: no record at all prints 'unknown — not headroom', no error" || bad "budget: empty state wrong"

# --- PRE-FLIGHT: model ----------------------------------------------------------------------------
h=$(cx_new models); models "$h" gpt-6-astra:list gpt-5.6-terra:list gpt-reserve:hide
td=$(newtd pf-model); ran="$td/ran"
out=$(realx TMPDIR="$td" CODEX_HOME="$h" DEVIL_MODEL=gpt-nope SHIM_RAN_FILE="$ran" -- diff 2>/dev/null </dev/null); rc=$?
if [ "$rc" -eq 1 ] && [ "$(last_of "$out")" = "DEVIL_FAILED: model gpt-nope not offered; listed: gpt-6-astra gpt-5.6-terra gpt-reserve" ] \
   && ! has "$out" "DEVIL_START:" && [ ! -e "$ran" ] && [ -z "$(ls -A "$td")" ]; then
  ok "pre-flight: a model the codex cache does not list is refused before anything starts"
else bad "pre-flight: absent model rc=$rc: $(last_of "$out")"; fi
out=$(realx TMPDIR="$td" CODEX_HOME="$h" -- diff 2>/dev/null); rc=$?
[ "$rc" -eq 0 ] && has_re "$out" '^DEVIL_PREFLIGHT: model gpt-5\.6-terra offered$' && ok "pre-flight: a listed model runs and says so" || bad "pre-flight: listed model rc=$rc"
out=$(realx TMPDIR="$td" CODEX_HOME="$h" DEVIL_MODEL=gpt-reserve -- diff 2>/dev/null); rc=$?
[ "$rc" -eq 0 ] && has_re "$out" '^DEVIL_PREFLIGHT: model gpt-reserve listed but hidden .*WARN' && ok "pre-flight: a hidden model is warned about, then run" || bad "pre-flight: hidden model rc=$rc"
out=$(realx TMPDIR="$td" CODEX_HOME="$h" DEVIL_MODEL=gpt-nope DEVIL_FORCE=1 -- diff 2>/dev/null); rc=$?
[ "$rc" -eq 0 ] && has_re "$out" '^DEVIL_PREFLIGHT: skipped \(DEVIL_FORCE=1\)$' && ok "pre-flight: DEVIL_FORCE=1 skips the checks and runs" || bad "pre-flight: DEVIL_FORCE=1 rc=$rc"
out=$(dryx CODEX_HOME="$h" DEVIL_MODEL=gpt-nope -- diff 2>/dev/null); rc=$?
[ "$rc" -eq 0 ] && has_re "$out" '^DEVIL_PREFLIGHT: a real run would be refused: model gpt-nope not offered' && ok "pre-flight: an explicit dry run prints the refusal and refuses nothing" || bad "pre-flight: dry run rc=$rc"
h=$(cx_new strong-lane-missing); models "$h" gpt-5.6-terra:list
out=$(dryx CODEX_HOME="$h" -- plan "$brief" 2>/dev/null)
has "$out" "DEVIL_PREFLIGHT: a real run would be refused: model gpt-6-astra not offered" && ok "pre-flight: the lane's slug is what is checked (the strong lane here)" || bad "pre-flight: lane slug not checked"
out=$(dryx CODEX_HOME="$h" DEVIL_MODEL_CRITICAL=gpt-5.6-terra -- plan "$brief" 2>/dev/null)
has "$out" "model gpt-5.6-terra offered" && ! has "$out" "would be refused" && ok "pre-flight: DEVIL_MODEL_CRITICAL re-points the lane at a model the account has" || bad "pre-flight: lane override not honoured"
n=0
for bad_cache in '' '{"models": 7' '{"models": []}' '{"models": [{"slug": 7}, {"slug": "two words"}, {"slug": ""}]}'; do
  n=$((n + 1)); h=$(cx_new "badcache$n")
  [ -n "$bad_cache" ] && printf '%s' "$bad_cache" > "$h/models_cache.json"
  out=$(realx TMPDIR="$(newtd badcache$n)" CODEX_HOME="$h" DEVIL_MODEL=gpt-nope -- diff 2>/dev/null); rc=$?
  if [ "$rc" -eq 0 ] && has "$out" "DEVIL_PREFLIGHT: model cache unreadable ($h/models_cache.json) — not checked"; then
    ok "pre-flight: an unusable model cache is 'not checked', never a refusal [$n]"
  else bad "pre-flight: bad cache [$n] rc=$rc"; fi
done

# --- PRE-FLIGHT: quota ----------------------------------------------------------------------------
week() { local h; h=$(cx_new "week-$1"); roll "$h" 0 0 "$(snap new $((100 - $1)):10080:86400)"; printf '%s' "$h"; }
for pair in "0 refused" "1 refused" "2 ok" "3 ok"; do
  left=${pair%% *}; want=${pair#* }
  out=$(dryx CODEX_HOME="$(week "$left")" -- plan "$brief" 2>/dev/null); rc=$?
  got=ok; has "$out" "a real run would be refused" && got=refused
  if [ "$rc" -eq 0 ] && has_re "$out" "^DEVIL_PREFLIGHT: quota 7d left=${left}% age=0h file=[^ ]+ — a plan run needs >= 2%\$" && [ "$got" = "$want" ]; then
    ok "pre-flight: a plan run with ${left}% of the week left -> $want"
  else bad "pre-flight: plan with ${left}% left: rc=$rc got=$got want=$want"; fi
done
# what each run needs: its cost + 1
half=$(week 50)
needs() { dryx CODEX_HOME="$half" -- "$@" 2>/dev/null </dev/null | sed -n 's/^DEVIL_PREFLIGHT: quota 7d .* — \(.*\) needs >= \([0-9]*\)%$/\1|\2/p'; }
[ "$(needs plan "$brief")" = "a plan run|2" ] && ok "pre-flight: plan needs 2%" || bad "pre-flight: plan need: $(needs plan "$brief")"
[ "$(needs diff)" = "a diff run|2" ] && ok "pre-flight: a non-critical diff needs 2%" || bad "pre-flight: diff need: $(needs diff)"
[ "$(needs wrapup "$sum")" = "a wrapup run|2" ] && ok "pre-flight: a non-critical wrapup needs 2%" || bad "pre-flight: wrapup need: $(needs wrapup "$sum")"
[ "$(needs reply "$UUID" "$rebut")" = "a reply run|5" ] && ok "pre-flight: a reply needs 5%" || bad "pre-flight: reply need: $(needs reply "$UUID" "$rebut")"
conf_on
[ "$(needs diff)" = "a critical diff run|3" ] && ok "pre-flight: a critical diff needs 3%" || bad "pre-flight: critical diff need: $(needs diff)"
[ "$(needs wrapup "$sum")" = "a critical wrapup run|3" ] && ok "pre-flight: a critical wrapup needs 3%" || bad "pre-flight: critical wrapup need: $(needs wrapup "$sum")"
conf_off
# refusal on the real path and on the --detach validation; nothing is created; FORCE runs
one=$(week 1); td=$(newtd pf-quota); ran="$td/ran"
out=$(realx TMPDIR="$td" CODEX_HOME="$one" SHIM_RAN_FILE="$ran" -- plan "$brief" 2>/dev/null); rc=$?
if [ "$rc" -eq 1 ] && has_re "$(last_of "$out")" '^DEVIL_FAILED: codex 7d quota left 1% < the 2% a plan run needs; resets [0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}$' \
   && [ ! -e "$ran" ] && ! has "$out" "DEVIL_START:"; then
  ok "pre-flight: a real run below cost + 1 is refused before codex runs"
else bad "pre-flight: real refusal rc=$rc: $(last_of "$out")"; fi
[ -z "$(ls -A "$td")" ] && ok "pre-flight: a refusal creates no temp file" || bad "pre-flight: refusal left files: $(ls -A "$td")"
out=$(realx TMPDIR="$td" CODEX_HOME="$one" SHIM_RAN_FILE="$ran" -- --detach plan "$brief" 2>/dev/null); rc=$?
if [ "$rc" -eq 1 ] && has_re "$out" '^DEVIL_PREFLIGHT: quota 7d left=1% ' && has_re "$(last_of "$out")" '^DEVIL_FAILED: codex 7d quota left 1%' \
   && ! has "$out" "DEVIL_DETACHED_LOG:" && [ ! -e "$ran" ] && [ -z "$(ls -A "$td")" ]; then
  ok "pre-flight: the --detach validation refuses too, relays the lines, forks and creates nothing"
else bad "pre-flight: detach validation rc=$rc: $(last_of "$out")"; fi
out=$(realx TMPDIR="$td" CODEX_HOME="$one" DEVIL_FORCE=1 -- plan "$brief" 2>/dev/null); rc=$?
[ "$rc" -eq 0 ] && has "$out" "SHIM CRITIQUE" && ok "pre-flight: DEVIL_FORCE=1 runs it anyway" || bad "pre-flight: FORCE rc=$rc"

# A reading is a floor however old; an expired or missing one is unknown, never headroom.
plan_dry() { dryx CODEX_HOME="$1" -- plan "$brief" 2>/dev/null; }
refused_in() { has "$1" "a real run would be refused"; }
h=$(cx_new old); roll "$h" 0 30 "$(snap new 99:10080:259200)"
out=$(plan_dry "$h"); has_re "$out" '^DEVIL_PREFLIGHT: quota 7d left=1% age=30h ' && refused_in "$out" && ok "pre-flight: a 30-hour-old reading still refuses (age never un-refuses)" || bad "pre-flight: old reading did not refuse"
h=$(cx_new expired2); roll "$h" 0 0 "$(snap new 100:10080:-60)"
out=$(plan_dry "$h"); has_re "$out" '^DEVIL_PREFLIGHT: quota unknown — not headroom; check codex /status$' && ! refused_in "$out" && ok "pre-flight: an expired reading is 'unknown — not headroom', not a refusal" || bad "pre-flight: expired reading mishandled"
out=$(plan_dry "$(cx_new none)"); has_re "$out" '^DEVIL_PREFLIGHT: quota unknown — not headroom' && ! refused_in "$out" && ok "pre-flight: no reading at all is 'unknown', not a refusal" || bad "pre-flight: no-reading case wrong"
five() { local h; h=$(cx_new "five-$1"); roll "$h" 0 0 "$(snap old $((100 - $1)):300:600)"; printf '%s' "$h"; }
out=$(plan_dry "$(five 0)")
has_re "$out" '^DEVIL_PREFLIGHT: quota 5h left=0% .* refuses$' && has_re "$out" '^DEVIL_PREFLIGHT: quota 7d unknown — not headroom; check codex /status$' \
  && has_re "$out" '^DEVIL_PREFLIGHT: a real run would be refused: codex 5h quota exhausted \(left 0%\)' && ok "pre-flight: a PRESENT 5h window that is spent refuses (7d unknown alongside)" || bad "pre-flight: spent 5h window: $(printf '%s' "$out" | grep PREFLIGHT | tr '\n' '|')"
out=$(plan_dry "$(five 50)")
has_re "$out" '^DEVIL_PREFLIGHT: quota 5h left=50% .*WARN: the per-run 5h cost is unmeasured' && ! refused_in "$out" && ok "pre-flight: a half-spent 5h window only warns" || bad "pre-flight: 5h at 50% mishandled"
# per window, the highest reading over the rollouts scanned
h=$(cx_new mixed)
roll "$h" 0 0 "$(snap new 99:10080:86400)"
roll "$h" 1 2 "$(snap old 40:300:600 50:10080:86400)"
out=$(plan_dry "$h")
has_re "$out" '^DEVIL_PREFLIGHT: quota 7d left=1% age=0h ' && has_re "$out" '^DEVIL_PREFLIGHT: quota 5h left=60% age=2h ' && refused_in "$out" \
  && ok "pre-flight: per window the highest unexpired reading wins (a 5h reading only an older rollout holds is kept)" || bad "pre-flight: mixed fixture: $(printf '%s' "$out" | grep PREFLIGHT | tr '\n' '|')"
chatter='{"type":"event_msg","payload":{"type":"agent_message"}}'
h=$(cx_new concurrent); roll "$h" 0 0 "$(snap new 10:10080:86400)" "$chatter"; roll "$h" 1 1 "$(snap new 99:10080:86400)"
out=$(plan_dry "$h"); has_re "$out" '^DEVIL_PREFLIGHT: quota 7d left=1% age=1h ' && refused_in "$out" && ok "pre-flight: a newer file holding an OLDER reading hides nothing" || bad "pre-flight: concurrent-writer case wrong"
h=$(cx_new torn); roll "$h" 0 0 "$(snap new 99:10080:86400)" '{"payload":{"rate_limits":{"primary":{"used_percent":5'
out=$(plan_dry "$h"); has_re "$out" '^DEVIL_PREFLIGHT: quota 7d left=1% age=0h ' && refused_in "$out" && ok "pre-flight: a half-written last line is skipped alone" || bad "pre-flight: torn line case wrong"
h=$(cx_new quiet); for i in 0 1 2 3 4; do roll "$h" "$i" 0 "$chatter"; done; roll "$h" 5 3 "$(snap new 99:10080:86400)"
out=$(plan_dry "$h"); has_re "$out" '^DEVIL_PREFLIGHT: quota 7d left=1% age=3h ' && refused_in "$out" && ok "pre-flight: readingless newer rollouts cannot push the reading out of view" || bad "pre-flight: quiet-rollouts case wrong"
h=$(cx_new raw); roll "$h" 0 0 "$(snap new 98.0000001:10080:86400)"
out=$(plan_dry "$h"); has_re "$out" '^DEVIL_PREFLIGHT: quota 7d left=1% age=0h ' && refused_in "$out" && ok "pre-flight: shown rounded down, decided on the raw percentage" || bad "pre-flight: raw-percentage case wrong"

# --- BRIEFS: --expect, premise, NUL, directories -------------------------------------------------------
for m in plan wrapup; do
  for flag in "--expect v9-folded" "--expect=v9-folded"; do
    # shellcheck disable=SC2086
    out=$(dry $m $flag "$brief" 2>/dev/null); rc=$?
    what="plan brief"; [ "$m" = wrapup ] && what="wrapup summary"
    if [ "$rc" -eq 1 ] && [ "$(last_of "$out")" = "DEVIL_FAILED: $what lacks the expected marker 'v9-folded' ($brief)" ]; then
      ok "--expect: $m refuses a file lacking the marker ($flag)"
    else bad "--expect: $m $flag rc=$rc: $(last_of "$out")"; fi
  done
  out=$(dry $m --expect "toy brief" "--expect=## 0. Premise" "$brief" 2>/dev/null); rc=$?
  [ "$rc" -eq 0 ] && ok "--expect: $m accepts a file holding every marker (repeatable, both spellings)" || bad "--expect: $m with present markers rc=$rc"
  for flag in "--expect x" "--expect=x"; do
    # shellcheck disable=SC2086
    out=$(dry $m "$brief" $flag 2>/dev/null)
    [ "$(last_of "$out")" = "DEVIL_FAILED: --expect goes right after plan or wrapup, before the file" ] && ok "--expect: a misplaced marker is refused, not read as focus ($m $flag)" || bad "--expect: misplaced $m $flag: $(last_of "$out")"
  done
done
out=$(dry plan --expect "" "$brief" 2>/dev/null)
[ "$(last_of "$out")" = "DEVIL_FAILED: --expect requires a non-empty marker" ] && ok "--expect: an empty marker is refused" || bad "--expect: empty marker: $(last_of "$out")"
out=$(dry wrapup --expect "toy brief" "$brief" HEAD -- doc 2>/dev/null)
has "$out" "git diff HEAD --stat -- doc" && ok "--expect: markers come off the front; base and scope keep their places" || bad "--expect: wrapup base/scope lost"
out=$(dry plan "$nopremise" 2>/dev/null)
[ "$(last_of "$out")" = "DEVIL_FAILED: plan brief has no premise heading (no line matching '^#+ .*premise', any case, outside code fences): $nopremise" ] && ok "premise: a plan brief with no heading is refused" || bad "premise: no-heading case: $(last_of "$out")"
out=$(dry plan "$fenced" 2>/dev/null)
has "$(last_of "$out")" "DEVIL_FAILED: plan brief has no premise heading" && ok "premise: a heading inside a fenced code block is an example, not the premise" || bad "premise: fenced heading accepted"
shouting="$tmp/shouting.md"; printf 'toy brief\n~~~\n## Premise\n~~~\n### 0.1 PREMISE and prior art\nx\n' > "$shouting"
dry plan "$shouting" >/dev/null 2>&1 && ok "premise: matched in any case, after a closed fence too" || bad "premise: upper-case heading after a fence refused"
out=$(dry plan "$nulbrief" 2>/dev/null)
[ "$(last_of "$out")" = "DEVIL_FAILED: $nulbrief holds a NUL byte: a brief is text, and everything after the NUL would be dropped" ] && ok "a brief holding a NUL byte is refused by name" || bad "NUL brief: $(last_of "$out")"
dry plan "$tmp" >/dev/null 2>&1 && bad "plan accepted a directory" || ok "plan refuses a readable DIRECTORY as its brief"
dry wrapup "$tmp" >/dev/null 2>&1 && bad "wrapup accepted a directory" || ok "wrapup refuses a readable DIRECTORY as its summary"
prompt=$(dry plan "$brief" 2>/dev/null | tr '\n' ' ' | sed 's/  */ /g')
pf_at=${prompt%%Attack the premise first: re-run the greps the brief lists under existing mechanisms and name what they missed.*}
hf_at=${prompt%%Hunt for:*}
if [ "${#pf_at}" -lt "${#prompt}" ] && [ "${#pf_at}" -lt "${#hf_at}" ]; then ok "the plan prompt has codex attack the premise first, before its hunt list"
else bad "plan prompt: premise-first clause missing or after the hunt list"; fi

# --- --detach -------------------------------------------------------------------------------------------
td=$(newtd detach)
t0=$SECONDS
out=$(realx TMPDIR="$td" -- --detach plan "$brief" 2>"$tmp/ed"); rc=$?
el=$((SECONDS - t0))
if [ "$rc" -eq 0 ] && [ "$el" -lt 12 ] && [ "$(count_of "$out" '^DEVIL_DETACHED_LOG: ')" -eq 1 ] && ! has_re "$out" '^DEVIL_LOG:'; then
  ok "--detach returns at once with exactly one DEVIL_DETACHED_LOG: and no footer"
else bad "--detach launch rc=$rc elapsed=${el}s out=$out"; fi
dlog=$(printf '%s\n' "$out" | sed -n 's/^DEVIL_DETACHED_LOG: //p')
head -n 1 "$dlog" 2>/dev/null | grep -qE '^DEVIL_PID: [0-9]+$' && ok "--detach returned only after the child named itself (log line 1 is DEVIL_PID:)" || bad "--detach: log line 1 is not DEVIL_PID: $(head -n 1 "$dlog" 2>/dev/null)"
dpid=$(sed -n '1s/^DEVIL_PID: //p' "$dlog"); reg_pid "$dpid"
wait_for 20 log_has "$dlog" '^DEVIL_LOG: ' || true
wait_for 10 pid_gone "${dpid:-0}" && ok "--detach: the child exits when the run is done" || bad "--detach: the child lingers"
dl=$(cat "$dlog")
start=$(printf '%s\n' "$dl" | grep -n '^DEVIL_START: mode=plan model=gpt-6-astra events=[^ ]*$' | cut -d: -f1)
mid=$(printf '%s\n' "$dl" | sed -n "2,$((${start:-2} - 1))p")
want=$(printf 'DEVIL_PREFLIGHT: model cache unreadable (%s/.codex/models_cache.json) — not checked\nDEVIL_PREFLIGHT: quota unknown — not headroom; check codex /status' "$HOME")
[ -n "$start" ] && [ "$mid" = "$want" ] && ok "--detach log: DEVIL_PID, the pre-flight lines, then DEVIL_START" || bad "--detach log structure wrong: $(printf '%s' "$dl" | head -6 | tr '\n' '|')"
has_re "$(printf '%s\n' "$dl" | sed -n "$((${start:-0} + 1))p")" '^DEVIL_BRIEF: sha256=[0-9a-f]{64} bytes=[0-9]+ mtime=[^ ]+$' && ok "--detach log: DEVIL_BRIEF follows DEVIL_START" || bad "--detach log: DEVIL_BRIEF missing"
tail4=$(printf '%s\n' "$dl" | sed '/^$/d' | tail -n 4 | cut -d: -f1 | tr '\n' ' ')
[ "$tail4" = "DEVIL_RUN DEVIL_QUOTA DEVIL_SESSION DEVIL_LOG " ] && ok "--detach log: ends with the footer; the LAST line (DEVIL_LOG:) says done" || bad "--detach log tail: $tail4"
[ "$(count_of "$dl" '^DEVIL_PID:')" -eq 1 ] && ! has "$dl" "DEVIL_FAILED:" && ok "--detach log: one DEVIL_PID, no failure marker" || bad "--detach log: duplicate pid line or stray failure marker"

# cancel a detached run: kill -TERM <DEVIL_PID> stops codex and ends the log with the marker
td=$(newtd dcancel); pf="$td/shim.pids"
out=$(dv "$sbin" DEVIL_DRY_RUN=0 TMPDIR="$td" SHIM_PIDS_FILE="$pf" -- --detach diff 2>/dev/null); rc=$?
dlog=$(printf '%s\n' "$out" | sed -n 's/^DEVIL_DETACHED_LOG: //p'); dpid=$(sed -n '1s/^DEVIL_PID: //p' "$dlog"); reg_pid "$dpid"
if [ "$rc" -eq 0 ] && [ -n "$dpid" ] && wait_for 10 file_nonempty "$pf"; then
  read -r shim_pid shim_child _ < "$pf"; reg_pid "$shim_pid" "$shim_child"
  log_has "$dlog" '^DEVIL_START: ' && ok "detached cancel: codex is running (DEVIL_START logged) before the cancel" || bad "detached cancel: no DEVIL_START before the cancel"
  kill -TERM "$dpid"
  if wait_for 3 pid_gone "$shim_pid" && wait_for 3 pid_gone "$shim_child" && wait_for 3 pid_gone "$dpid"; then ok "detached cancel: TERM stops the run, codex and codex's own child (the whole group)"
  else bad "detached cancel: something survived the TERM"; fi
  [ "$(tail -n 1 "$dlog")" = "DEVIL_FAILED: terminated by signal" ] && ok "detached cancel: the log's last line is DEVIL_FAILED: terminated by signal" || bad "detached cancel: last line is $(tail -n 1 "$dlog")"
  log_has "$dlog" '^DEVIL_QUOTA:' && bad "detached cancel: a footer followed the TERM" || ok "detached cancel: no footer follows the TERM"
else bad "detached cancel: the stand-in never started (rc=$rc)"; fi

# a bad brief is refused in the foreground; no log
td=$(newtd drefuse)
out=$(realx TMPDIR="$td" -- --detach plan "$td/no-such-brief.md" 2>/dev/null); rc=$?
if [ "$rc" -eq 1 ] && has_re "$out" '^DEVIL_FAILED: plan mode requires a readable brief file' && ! has "$out" "DEVIL_DETACHED_LOG:" && [ -z "$(ls -A "$td")" ]; then
  ok "--detach refuses a bad brief in the foreground and creates no log"
else bad "--detach bad brief rc=$rc"; fi
# budget and a stdin-fed reply are never detached, dry or not
td=$(newtd undetachable)
for r in "--detach budget" "--detach reply $UUID"; do
  for d in 0 1; do
    # shellcheck disable=SC2086
    out=$(dv "$fbin" DEVIL_DRY_RUN=$d TMPDIR="$td" -- $r 2>/dev/null </dev/null); rc=$?
    if [ "$rc" -eq 1 ] && has_re "$out" '^DEVIL_FAILED: ' && ! has_re "$out" '^DEVIL_(QUOTA|DETACHED_LOG|PID):'; then ok "never detached: '$r' (dry=$d)"
    else bad "'$r' dry=$d rc=$rc"; fi
  done
done
[ -z "$(ls -A "$td")" ] && ok "never-detached refusals create nothing" || bad "never-detached refusals left files"
td=$(newtd drydetach)
out=$(dv "$nbin" DEVIL_DRY_RUN=1 TMPDIR="$td" -- --detach plan "$brief" 2>/dev/null); rc=$?
if [ "$rc" -eq 0 ] && has "$out" "=== DEVIL_DRY_RUN: codex argv ===" && ! has_re "$out" '^DEVIL_(DETACHED_LOG|PID|START):' && [ -z "$(ls -A "$td")" ]; then
  ok "a --detach dry run stays in the foreground and forks nothing"
else bad "--detach dry run rc=$rc"; fi
# presence checks before any fork: no codex = the clean no-op, no jq = a refusal; neither leaves a log
td=$(newtd presence)
out=$(dv "$nbin" DEVIL_DRY_RUN=0 TMPDIR="$td" -- --detach diff 2>/dev/null); rc=$?
[ "$rc" -eq 0 ] && has "$out" "codex CLI not found" && ! has_re "$out" '^DEVIL_(DETACHED_LOG|FAILED):' && ok "--detach without codex is the clean no-op" || bad "--detach no-codex rc=$rc"
nojq="$tmp/nojqbin"; mkbin "$nojq" jq; cp "$fbin/codex" "$nojq/codex"
out=$(dv "$nojq" DEVIL_DRY_RUN=0 TMPDIR="$td" -- --detach plan "$brief" 2>/dev/null); rc=$?
[ "$rc" -eq 1 ] && [ "$(last_of "$out")" = "DEVIL_FAILED: jq is required" ] && [ -z "$(ls -A "$td")" ] && ok "--detach without jq is a refusal that leaves no log" || bad "--detach no-jq rc=$rc: $(last_of "$out")"
# no setsid: perl's POSIX::setsid does the same call (macOS); neither: a clear refusal
if [ -n "$(type -P perl 2>/dev/null)" ]; then
  pbin="$tmp/perlbin"; mkbin "$pbin" setsid; cp "$fbin/codex" "$pbin/codex"
  td=$(newtd perlsetsid)
  out=$(dv "$pbin" DEVIL_DRY_RUN=0 TMPDIR="$td" -- --detach plan "$brief" 2>/dev/null); rc=$?
  dlog=$(printf '%s\n' "$out" | sed -n 's/^DEVIL_DETACHED_LOG: //p'); dpid=$(sed -n '1s/^DEVIL_PID: //p' "$dlog" 2>/dev/null); reg_pid "$dpid"
  wait_for 20 log_has "$dlog" '^DEVIL_LOG: ' || true
  if [ "$rc" -eq 0 ] && [ -n "$dpid" ] && [ "$(tail -n 1 "$dlog" | cut -d: -f1)" = "DEVIL_LOG" ]; then ok "--detach without setsid falls back to perl's POSIX::setsid and the run completes"
  else bad "--detach perl fallback rc=$rc log: $(tail -n 2 "$dlog" 2>/dev/null | tr '\n' '|')"; fi
else
  echo "  skip: --detach perl fallback (no perl on this machine)"
fi
npbin="$tmp/nosetsidbin"; mkbin "$npbin" setsid perl; cp "$fbin/codex" "$npbin/codex"
td=$(newtd nosetsid)
out=$(dv "$npbin" DEVIL_DRY_RUN=0 TMPDIR="$td" -- --detach plan "$brief" 2>/dev/null); rc=$?
[ "$rc" -eq 1 ] && [ "$(last_of "$out")" = "DEVIL_FAILED: --detach requires setsid (or perl) and nohup on PATH" ] && [ -z "$(ls -A "$td")" ] && ok "--detach with neither setsid nor perl is a clear refusal" || bad "--detach no-setsid rc=$rc: $(last_of "$out")"

# a failure only the CHILD meets (here: a temp file it cannot create) ends the log with the marker
cm="$tmp/failing-mktemp-bin"; mkdir -p "$cm"
real_mktemp=$(type -P mktemp)
cat > "$cm/mktemp" <<SHIM
#!/usr/bin/env bash
case "\$*" in *-last-*) echo "mktemp: simulated failure" >&2; exit 1 ;; esac
exec '$real_mktemp' "\$@"
SHIM
chmod +x "$cm/mktemp"
td=$(newtd childrefusal)
out=$(env PATH="$cm:$fbin" DEVIL_DRY_RUN=0 TMPDIR="$td" "$DEVIL" --detach plan "$brief" 2>/dev/null); rc=$?
dlog=$(printf '%s\n' "$out" | sed -n 's/^DEVIL_DETACHED_LOG: //p'); dpid=$(sed -n '1s/^DEVIL_PID: //p' "$dlog" 2>/dev/null); reg_pid "$dpid"
wait_for 10 pid_gone "${dpid:-0}" || true
[ "$rc" -eq 0 ] && [ "$(tail -n 1 "$dlog" 2>/dev/null)" = "DEVIL_FAILED: mktemp failed" ] && ok "a child-only failure ends the detached log with DEVIL_FAILED as the last line" || bad "child refusal: rc=$rc last=$(tail -n 1 "$dlog" 2>/dev/null)"

# --- launch texts (kit tree + installed commands) --------------------------------------------------------
# The launch advice is read on every devil run, so it is pinned like code: a
# Bash timeout or run_in_background got codex killed mid-run, and a stale
# brief or a missing premise cost whole rounds. These pins cover the SHIPPED
# command/starter files (the starters only where present, i.e. in the kit
# tree); if you rewrite /devil or /angel, keep these rules or edit the pins.
devilmd="$ROOT/.claude/commands/devil.md"
negated_only() { # file : every mention of timeout / run_in_background has a negation within the 80 characters before it
  tr '\n' ' ' < "$1" | awk '{
    t = tolower($0); n = length(t); pos = 1; bad = 0
    while (pos <= n) {
      rest = substr(t, pos)
      if (!match(rest, /run_in_background|timeout/)) break
      at = pos + RSTART - 1
      s = substr(t, (at > 80 ? at - 80 : 1), (at > 80 ? 80 : at - 1))
      if (s !~ /(^|[^a-z])(never|not|no)([^a-z]|$)/) bad = 1
      pos = at + RLENGTH
    }
    exit bad }'
}
if [ -r "$devilmd" ]; then
  d=$(cat "$devilmd")
  has "$d" "--detach" && has "$d" "DEVIL_FAILED" && has "$d" "DEVIL_DETACHED_LOG:" && has "$d" "kill -TERM <DEVIL_PID>" && ok "/devil documents the detached launch, DEVIL_FAILED and TERM cancellation" || bad "/devil lacks the detach recipe"
  has "$d" "--expect <marker>" && ok "/devil teaches --expect" || bad "/devil does not teach --expect"
  has "$d" "until tail -n1 \"\$log\" | grep -qE '^DEVIL_(LOG|FAILED):'" && has "$d" 'The last line decides: `DEVIL_LOG:` = done, `DEVIL_FAILED:` = failed.' && ok "/devil decides a run by its log's LAST line" || bad "/devil watcher/last-line rule missing"
  has_re "$d" "until grep -qE? '\\^DEVIL_" && bad "/devil greps the whole log for a marker" || ok "/devil never greps the whole log for a marker"
  has_re "$d" "setsid --fork nohup|generous Bash|timeout \\(600000" && bad "/devil still carries the retired launch advice" || ok "/devil carries no retired launch advice"
  negated_only "$devilmd" && ok "/devil never recommends a Bash timeout or run_in_background" || bad "/devil recommends a timeout or run_in_background"
  has_re "$(tr '\n' ' ' < "$devilmd" | sed 's/  */ /g')" "Premise" && ok "/devil asks for a premise in plan briefs" || bad "/devil does not mention the premise"
  has_re "$d" '(^|[^a-z])copy( mode|\b.*Persian)' && bad "/devil still mentions the copy mode" || ok "/devil mentions no copy mode"
else bad "/devil command missing at $devilmd"; fi
if [ -r "$ROOT/CLAUDE.md.starter" ]; then
  sed -n "/^- Devil's advocate (codex)/,/^- \*\*Plan/p" "$ROOT/CLAUDE.md.starter" > "$tmp/c.txt"
  c=$(cat "$tmp/c.txt")
  has "$c" "--detach" && has "$c" "DEVIL_FAILED" && has "$c" "kill -TERM" && ok "CLAUDE.md.starter's devil bullet documents --detach, DEVIL_FAILED and TERM" || bad "CLAUDE.md.starter devil bullet lacks the detach recipe"
  negated_only "$tmp/c.txt" && ok "CLAUDE.md.starter never recommends a timeout or run_in_background" || bad "CLAUDE.md.starter recommends a timeout/run_in_background"
else
  # Installed repos consumed the starter (INSTALL step 2) — say so, never skip silently.
  echo "  skip: 2 CLAUDE.md.starter cases (file absent — normal after install)"
fi
if [ -r "$ROOT/AGENTS.md.starter" ]; then
  tr '\n' ' ' < "$ROOT/AGENTS.md.starter" | sed 's/  */ /g' | grep -qF "In a plan run, attack the premise first: re-run the greps the brief lists under existing mechanisms and name what they missed." \
    && ok "AGENTS.md.starter has codex attack the plan premise first" || bad "AGENTS.md.starter lacks the premise-first clause"
else
  echo "  skip: 1 AGENTS.md.starter case (file absent — normal after install)"
fi
if [ -r "$ROOT/.claude/agents/angel.md" ]; then
  tr '\n' ' ' < "$ROOT/.claude/agents/angel.md" | sed 's/  */ /g' | grep -qF "Attack the premise first: re-run the greps the brief lists under existing mechanisms and name what they missed." \
    && ok "the angel agent attacks a plan's premise first" || bad "angel agent lacks the premise-first rule"
else
  echo "  skip: 1 angel-agent case (file absent — a project may drop the angel)"
fi
for a in angel expert; do
  f="$ROOT/.claude/agents/$a.md"
  [ -r "$f" ] || { echo "  skip: 1 $a cacheTtl case (agent file absent)"; continue; }
  grep -q '^experimental:$' "$f" && grep -q '^  cacheTtl: "1h"$' "$f" \
    && ok "$a: experimental.cacheTtl is \"1h\" (nested under experimental, as the docs require)" || bad "$a: cacheTtl not nested under experimental"
done
for a in domain-auditor test-writer; do
  f="$ROOT/.claude/agents/$a.md"
  [ -r "$f" ] || { echo "  skip: 1 $a cacheTtl case (agent file absent)"; continue; }
  grep -q 'cacheTtl' "$f" && bad "$a is a one-shot agent and must NOT get the 1h prompt cache (it only makes it dearer)" || ok "$a (one-shot): no 1h prompt cache"
done
if [ -r "$ROOT/.claude/commands/angel.md" ]; then
  a=$(tr '\n' ' ' < "$ROOT/.claude/commands/angel.md" | sed 's/  */ /g')
  has "$a" "the premise first" && has "$a" "BY CAPABILITY" && ok "/angel's plan brief leads with the premise (one claim + mechanisms searched by capability)" || bad "/angel plan brief lacks the premise-first clause"
  has "$a" 'test -r <file>' && has "$a" "--expect <marker>" && has "$a" "assert-guarded" && ok "/angel verifies an on-disk brief before naming it" || bad "/angel lacks the on-disk-brief verification clause"
else
  echo "  skip: 2 /angel command cases (file absent — a project may drop the angel)"
fi

# collect the background cases
for pair in "$bg1:$tmp/bg-slow.out" "$bg2:$tmp/bg-term.out"; do
  p=${pair%%:*}; f=${pair#*:}
  [ -n "$p" ] || continue
  wait "$p" 2>/dev/null
  cat "$f"
  pass=$((pass + $(grep -c '^  ok:' "$f"))); fail=$((fail + $(grep -c '^  FAIL:' "$f")))
done

echo "devil-sh-invariants: $pass ok, $fail failed"
[ "$fail" -eq 0 ]

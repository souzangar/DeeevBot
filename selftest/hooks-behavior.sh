#!/usr/bin/env bash
# Regression guard for the two hooks' contracts:
#   pre-commit-check.sh: gates only `git commit`; loud pass-through while
#     unconfigured; SKIP_COMMIT_GATE honored; blocks (exit 2) on a failing
#     step; harmless without jq.
#   critical-path-tripwire.sh: silent no-op without config; exit 2 + reminder
#     when an added line in a critical file matches a banned pattern; skips
#     non-critical and test files.
#   secret-shape-scan.sh.example: the stack-free first invariant — catches a
#     secret-shaped string in a tracked or untracked-not-ignored file, never
#     prints it, passes a clean tree, skips gitignored and binary files, and
#     fails CLOSED when it cannot scan.
#
# This suite pins the SHIPPED contract of the hooks, whatever state an installer
# has put them in: GATE_SRC / TRIP_SRC are the installed files, and every case
# runs against BLANKED copies of them (the EDIT-ME slots emptied below). So
# INSTALL step 3 — filling BUILD_CMD / TEST_CMD / INVARIANT_CMD and
# BANNED_PATTERNS — cannot turn this suite red, and it stays green on the
# pristine kit and on a configured one alike. (The blanking is line-wise: keep
# each slot on ONE line; put a longer command in a script and call that.)
set -u
# Hermetic git: user/system config (signing, hooks) must not leak into the
# fixture repo — a global commit.gpgsign=true would fail setup and cascade.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
# ... and a caller's own repository (a git hook exports GIT_DIR and friends) must not leak in either.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_COMMON_DIR GIT_PREFIX GIT_NAMESPACE
ROOT=$(cd "$(dirname "$0")/.." && pwd)
GATE_SRC="$ROOT/.claude/hooks/pre-commit-check.sh"
TRIP_SRC="$ROOT/.claude/hooks/critical-path-tripwire.sh"
SCAN_SRC="$ROOT/.claude/hooks/secret-shape-scan.sh.example"
pass=0; fail=0
ok()  { echo "  ok:   $1"; pass=$((pass+1)); }
bad() { echo "  FAIL: $1"; fail=$((fail+1)); }

tmp=$(mktemp -d "${TMPDIR:-/tmp}/hooks-selftest-XXXXXX") || exit 1
trap 'rm -rf "$tmp"' EXIT

# The blanked copies. The tripwire copy sits BESIDE the gate copy: the gate's
# config_notes greps that sibling (by its own directory) for an empty
# BANNED_PATTERNS.
GATE="$tmp/gate-blank.sh"
TRIP="$tmp/critical-path-tripwire.sh"
sed -e 's|^BUILD_CMD=.*|BUILD_CMD=""|' -e 's|^TEST_CMD=.*|TEST_CMD=""|' -e 's|^INVARIANT_CMD=.*|INVARIANT_CMD=""|' "$GATE_SRC" > "$GATE"
sed "s|^BANNED_PATTERNS=.*|BANNED_PATTERNS=''|" "$TRIP_SRC" > "$TRIP"
chmod +x "$GATE" "$TRIP"

proj="$tmp/proj"
mkdir -p "$proj/src/pay"
git -C "$proj" init -q
echo base > "$proj/src/pay/core.txt"
git -C "$proj" add -A
git -C "$proj" -c user.email=t@t.t -c user.name=t commit -qm init \
  || { echo "setup: fixture commit failed"; exit 1; }
export CLAUDE_PROJECT_DIR="$proj"

commit_json='{"tool_input":{"command":"git commit -m x"}}'
ls_json='{"tool_input":{"command":"ls -la"}}'

# --- pre-commit gate --------------------------------------------------------
out=$(printf '%s' "$ls_json" | "$GATE" 2>&1); rc=$?
[ "$rc" -eq 0 ] && [ -z "$out" ] && ok "gate: non-commit passes silently" || bad "gate: non-commit rc=$rc out='$out'"

out=$(printf '{"tool_input":{"command":"git log --oneline"}}' | "$GATE" 2>&1); rc=$?
[ "$rc" -eq 0 ] && [ -z "$out" ] && ok "gate: non-commit git passes silently" || bad "gate: git log rc=$rc out='$out'"

out=$(printf '%s' "$commit_json" | "$GATE" 2>&1); rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "not configured"; then
  ok "gate: unconfigured → allowed with notice"
else bad "gate: unconfigured behavior rc=$rc"; fi
printf '%s' "$out" | grep -q "critical-globs.conf missing" \
  && ok "gate: surfaces missing critical-path config" \
  || bad "gate: silent about missing critical-path config"

for variant in 'git -c user.name=x commit -m y' 'git -C . commit -m y' 'command git commit'; do
  out=$(printf '{"tool_input":{"command":"%s"}}' "$variant" | "$GATE" 2>&1); rc=$?
  [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "not configured" \
    && ok "gate: matcher catches: $variant" || bad "gate: matcher misses: $variant"
done

out=$(printf '{"tool_input":{"command":"SKIP_COMMIT_GATE=1 git commit -m x"}}' | "$GATE" 2>&1); rc=$?
[ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "SKIPPED" \
  && ok "gate: inline SKIP prefix in the command string honored" || bad "gate: inline skip broken"

out=$(printf '%s' "$commit_json" | SKIP_COMMIT_GATE=1 "$GATE" 2>&1); rc=$?
[ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "SKIPPED" && ok "gate: exported SKIP_COMMIT_GATE honored" || bad "gate: skip hatch broken"

# The skip flag must be scoped to the env-prefix position: appearing inside a
# commit message or an unrelated chained word must NOT bypass the gate.
out=$(printf '{"tool_input":{"command":"git commit -m \\"docs: mention SKIP_COMMIT_GATE=1\\""}}' | "$GATE" 2>&1); rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "not configured" && ! printf '%s' "$out" | grep -q "SKIPPED"; then
  ok "gate: flag inside commit message does not skip"
else bad "gate: message-text flag skipped the gate (rc=$rc)"; fi
out=$(printf '{"tool_input":{"command":"echo SKIP_COMMIT_GATE=1 && git commit -m x"}}' | "$GATE" 2>&1); rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "not configured" && ! printf '%s' "$out" | grep -q "SKIPPED"; then
  ok "gate: flag in unrelated chained word does not skip"
else bad "gate: chained-word flag skipped the gate (rc=$rc)"; fi
for evade in 'SKIP_COMMIT_GATE=1 git status && git commit -m x' 'SKIP_COMMIT_GATE=1 git diff; git commit -m x'; do
  out=$(printf '{"tool_input":{"command":"%s"}}' "$evade" | "$GATE" 2>&1); rc=$?
  if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "not configured" && ! printf '%s' "$out" | grep -q "SKIPPED"; then
    ok "gate: flag on a NON-committing git invocation does not skip: $evade"
  else bad "gate: flag on unrelated git invocation skipped the gate: $evade (rc=$rc)"; fi
done

cfg_fail="$tmp/gate-fail.sh"
sed 's|^BUILD_CMD=""|BUILD_CMD="false"|' "$GATE" > "$cfg_fail"; chmod +x "$cfg_fail"
out=$(printf '%s' "$commit_json" | "$cfg_fail" 2>&1); rc=$?
[ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q "FAILED" && ok "gate: failing step blocks (exit 2)" || bad "gate: failing step rc=$rc"

cfg_pass="$tmp/gate-pass.sh"
sed 's|^BUILD_CMD=""|BUILD_CMD="true"|' "$GATE" > "$cfg_pass"; chmod +x "$cfg_pass"
out=$(printf '%s' "$commit_json" | "$cfg_pass" 2>&1); rc=$?
[ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "passed" && ok "gate: passing step allows" || bad "gate: passing step rc=$rc"

bin="$tmp/bin"; mkdir -p "$bin"
for t in bash grep sed git cat; do
  p=$(command -v "$t" 2>/dev/null) && ln -s "$p" "$bin/$t"
done
out=$(printf '%s' "$commit_json" | PATH="$bin" "$GATE" 2>&1); rc=$?
[ "$rc" -eq 0 ] && printf '%s' "$out" | grep -qi "jq not installed" && ok "gate: no jq → harmless, explained" || bad "gate: no-jq rc=$rc out='$out'"

# --- tripwire ---------------------------------------------------------------
mkjson() { printf '{"tool_input":{"file_path":"%s"}}' "$1"; }
critical="$proj/src/pay/new-code.txt"
echo "forbiddenCall(1)" > "$critical"

out=$(mkjson "$critical" | "$TRIP" 2>&1); rc=$?
[ "$rc" -eq 0 ] && [ -z "$out" ] && ok "tripwire: no conf → silent no-op" || bad "tripwire: no-conf rc=$rc"

# Repo-relative glob form — the form the conf example documents. This is the
# style that once armed devil.sh but silently disarmed the tripwire (which
# used to match the absolute path); both consumers must fire on it.
mkdir -p "$proj/.claude/devil"
printf 'src/pay/*\n' > "$proj/.claude/devil/critical-globs.conf"
out=$(mkjson "$critical" | "$TRIP" 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok "tripwire: conf but no patterns → no-op" || bad "tripwire: empty-patterns rc=$rc"

out=$(printf '%s' "$commit_json" | "$GATE" 2>&1); rc=$?
[ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "BANNED_PATTERNS" \
  && ok "gate: conf present + empty patterns → half-configured note" \
  || bad "gate: half-configured state silent (rc=$rc)"
printf '%s' "$out" | grep -q "untracked files present" \
  && ok "gate: untracked files surface as validated-vs-committed drift" \
  || bad "gate: untracked drift silent"

armed="$tmp/tripwire-armed.sh"
sed "s|^BANNED_PATTERNS=''|BANNED_PATTERNS='forbiddenCall'|" "$TRIP" > "$armed"; chmod +x "$armed"
out=$(mkjson "$critical" | "$armed" 2>&1); rc=$?
[ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q "tripwire" && ok "tripwire: repo-relative glob fires on critical file" || bad "tripwire: relative-glob hit rc=$rc"

printf '*src/pay/*\n' > "$proj/.claude/devil/critical-globs.conf"
out=$(mkjson "$critical" | "$armed" 2>&1); rc=$?
[ "$rc" -eq 2 ] && ok "tripwire: leading-star glob fires too" || bad "tripwire: star-glob hit rc=$rc"

out=$(mkjson "$critical" | PATH="$bin" "$armed" 2>&1); rc=$?
[ "$rc" -eq 0 ] && [ -z "$out" ] && ok "tripwire: no jq → silent skip (documented)" || bad "tripwire: no-jq rc=$rc out='$out'"

other="$proj/src/other.txt"; echo "forbiddenCall(2)" > "$other"
out=$(mkjson "$other" | "$armed" 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok "tripwire: non-critical file ignored" || bad "tripwire: non-critical rc=$rc"

spec="$proj/src/pay/thing.spec.js"; echo "forbiddenCall(3)" > "$spec"
out=$(mkjson "$spec" | "$armed" 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok "tripwire: test file skipped" || bad "tripwire: test file rc=$rc"

# Tracked-file diff path: only ADDED lines count. Old banned content must not
# be resurrected by a deletion-only edit, and added content starting with
# "++" must not be mistaken for a diff header.
tracked="$proj/src/pay/tracked.txt"
printf 'forbiddenCall(old)\nkeepme\n' > "$tracked"
git -C "$proj" add -A
git -C "$proj" -c user.email=t@t.t -c user.name=t commit -qm tracked
printf 'forbiddenCall(old)\n' > "$tracked"   # deletion-only edit
out=$(mkjson "$tracked" | "$armed" 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok "tripwire: deletion-only edit ignores OLD banned content" || bad "tripwire: resurrected old content rc=$rc"
printf 'forbiddenCall(old)\n++forbiddenCall(new)\n' > "$tracked"
out=$(mkjson "$tracked" | "$armed" 2>&1); rc=$?
[ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q 'forbiddenCall(new)' \
  && ok "tripwire: added ++-prefixed line still caught (header filter is space-anchored)" \
  || bad "tripwire: ++-content add rc=$rc"

# Configured gate + half-configured critical path: notes must be visible on
# the PASS path too (systemMessage), not only when wholly unconfigured.
out=$(printf '%s' "$commit_json" | "$cfg_pass" 2>&1); rc=$?
[ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "passed" && printf '%s' "$out" | grep -q "BANNED_PATTERNS" \
  && ok "gate: configured pass still surfaces half-configured tripwire" \
  || bad "gate: pass-path note missing rc=$rc"

# --- secret-shape-scan.sh.example: the stack-free first invariant ---------------
# Run the shipped example as-is (SHAPES unedited), from inside a fixture repo.
scan() { ( cd "$1" && bash "$SCAN_SRC" ); }
sec="$tmp/sec"; mkdir -p "$sec"; git -C "$sec" init -q
echo "hello" > "$sec/clean.txt"
# a Telegram-bot-token-shaped string (8-10 digits, a colon, 35 token characters)
tok="123456789:$(printf 'A%.0s' $(seq 1 35))"
out=$(scan "$sec" 2>&1); rc=$?
[ "$rc" -eq 0 ] && [ -z "$out" ] && ok "scan: a clean tree passes, silently (even with no commit yet)" || bad "scan: clean tree rc=$rc out='$out'"
echo "TOKEN=$tok" > "$sec/planted.txt"
out=$(scan "$sec" 2>&1); rc=$?
[ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q 'planted.txt:1' && ok "scan: a token planted in an untracked file is caught, with file and line count" || bad "scan: untracked token rc=$rc out='$out'"
printf '%s' "$out" | grep -qF "$tok" && bad "scan: the secret itself was printed" || ok "scan: the matched secret is never printed (paths and counts only)"
rm "$sec/planted.txt"; printf 'planted.txt\n' > "$sec/.gitignore"; echo "TOKEN=$tok" > "$sec/planted.txt"
out=$(scan "$sec" 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok "scan: a token in a gitignored file is not flagged" || bad "scan: gitignored file flagged rc=$rc out='$out'"
printf 'bin\0%s\n' "$tok" > "$sec/blob.bin"
out=$(scan "$sec" 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok "scan: a binary file is skipped" || bad "scan: binary file flagged rc=$rc"
git -C "$sec" add clean.txt .gitignore; git -C "$sec" -c user.email=t@t.t -c user.name=t commit -qm init
echo "TOKEN=$tok" > "$sec/tracked.txt"; git -C "$sec" add tracked.txt
out=$(scan "$sec" 2>&1); rc=$?
[ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q 'tracked.txt' && ok "scan: a token in a tracked file is caught" || bad "scan: tracked token rc=$rc out='$out'"
git -C "$sec" rm -q -f tracked.txt
printf "key = '%s%s'\n" AKIA ABCDEFGHIJKLMNOP > "$sec/aws.txt"   # built at run time: this file must not match the shapes itself
out=$(scan "$sec" 2>&1); rc=$?
[ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q 'aws.txt' && ok "scan: the shipped shapes cover more than the Telegram example (AWS key id)" || bad "scan: AWS shape missed rc=$rc"
rm "$sec/aws.txt"
out=$(scan "$sec" 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok "scan: clean again once the planted files are gone" || bad "scan: still failing after cleanup rc=$rc out='$out'"
# the kit's own shipped files must never trip the shipped shapes (a scan wired as INVARIANT_CMD
# scans the project's copy of them too, and would block every commit)
own="$tmp/own"; mkdir -p "$own/.claude" && git -C "$own" init -q
for d in scripts hooks commands agents; do cp -R "$ROOT/.claude/$d" "$own/.claude/$d" 2>/dev/null; done
cp -R "$ROOT/selftest" "$own/selftest"
out=$(scan "$own" 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok "scan: the kit's own shipped scripts, hooks, commands, agents and selftests match none of the shipped shapes" || bad "scan: a shipped kit file matches the shipped shapes (it would block every commit): $out"
# fail-closed: outside a git work tree, or with a broken regex, it must BLOCK
mkdir -p "$tmp/not-a-repo"
out=$(cd "$tmp/not-a-repo" && GIT_CEILING_DIRECTORIES="$tmp" bash "$SCAN_SRC" 2>&1); rc=$?
[ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q 'not inside a git work tree' && ok "scan: outside a git work tree it fails CLOSED (exit 2), saying why" || bad "scan: not-a-repo rc=$rc out='$out'"
sed "s|'AKIA\[0-9A-Z\]{16}'|'['|" "$SCAN_SRC" > "$tmp/scan-broken.sh"
out=$(cd "$sec" && bash "$tmp/scan-broken.sh" 2>&1); rc=$?
[ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q 'fail' && ok "scan: a broken regex fails CLOSED (exit 2), never reads as clean" || bad "scan: broken regex rc=$rc out='$out'"
# wired as INVARIANT_CMD it blocks a commit with a planted token (through the real gate)
sed -e 's|^BUILD_CMD=.*|BUILD_CMD=""|' -e 's|^TEST_CMD=.*|TEST_CMD=""|' -e "s|^INVARIANT_CMD=.*|INVARIANT_CMD=\"bash $SCAN_SRC\"|" "$GATE_SRC" > "$tmp/gate-scan.sh"; chmod +x "$tmp/gate-scan.sh"
echo "TOKEN=$tok" > "$sec/oops.txt"
out=$(cd "$sec" && printf '%s' "$commit_json" | CLAUDE_PROJECT_DIR="$sec" "$tmp/gate-scan.sh" 2>&1); rc=$?
[ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q 'FAILED (invariants)' && ok "scan as INVARIANT_CMD: the commit gate blocks a commit with a planted token" || bad "scan via the gate: rc=$rc out='$out'"
rm "$sec/oops.txt"
out=$(cd "$sec" && printf '%s' "$commit_json" | CLAUDE_PROJECT_DIR="$sec" "$tmp/gate-scan.sh" 2>&1); rc=$?
[ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q 'passed' && ok "scan as INVARIANT_CMD: a clean tree lets the commit through" || bad "scan via the gate (clean): rc=$rc out='$out'"

# --- rules-sync-check.sh: the catastrophic-rules drift gate ------------------
# State- and text-independent: fixtures are built from whichever spelling this
# repo has (installed CLAUDE.md or the shipped .starter), normalized to the
# starter names, and mutations insert a canary line instead of editing rule
# text an installer may have rewritten.
SYNC_SRC="$ROOT/.claude/hooks/rules-sync-check.sh"
sync_resolve() { # $1 installed, $2 fallback -> echoes the existing one, if any
  if [ -f "$ROOT/$1" ]; then echo "$ROOT/$1"; elif [ -f "$ROOT/$2" ]; then echo "$ROOT/$2"; fi
}
SY_C=$(sync_resolve "CLAUDE.md" "CLAUDE.md.starter")
SY_A=$(sync_resolve "AGENTS.md" "AGENTS.md.starter")
SY_I=$(sync_resolve ".claude/devil/critical-invariants.md" ".claude/devil/critical-invariants.md.example")
mk_sync_root() { # $1 = fixture dir, seeded from the resolved real copies
  mkdir -p "$1/.claude/devil" "$1/.claude/hooks"
  cp "$SY_C" "$1/CLAUDE.md.starter"
  cp "$SY_A" "$1/AGENTS.md.starter"
  cp "$SY_I" "$1/.claude/devil/critical-invariants.md.example"
}
canary() { # $1 file: insert a drift line right after the open marker
  awk '{ print } /<!-- sync:catastrophic-invariants -->/ && !done { print "DRIFT-CANARY"; done = 1 }' "$1" > "$1.tmp" && mv "$1.tmp" "$1"
}
# 1. this repo's own copies are in sync (however many exist — the gate's job)
out=$("$SYNC_SRC" "$ROOT" 2>&1); rc=$?
[ "$rc" -eq 0 ] && printf '%s' "$out" | grep -Eq 'in sync|nothing to compare' && ok "rules-sync: this repo's catastrophic-rules copies are in sync" || bad "rules-sync on this repo: rc=$rc out='$out'"
if [ -n "$SY_C" ] && [ -n "$SY_A" ] && [ -n "$SY_I" ]; then
  # 2. one edited copy = drift, named pair, nonzero exit
  s="$tmp/sync-drift"; mk_sync_root "$s"; canary "$s/AGENTS.md.starter"
  out=$("$SYNC_SRC" "$s" 2>&1); rc=$?
  [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q 'DIFFER between CLAUDE' && ok "rules-sync: an edited copy fails, naming the differing pair" || bad "rules-sync drift: rc=$rc out='$out'"
  # 3. deleting the markers from a present file is drift, not an exemption
  s="$tmp/sync-nomark"; mk_sync_root "$s"
  grep -v 'sync:catastrophic-invariants' "$s/CLAUDE.md.starter" > "$s/C.tmp" && mv "$s/C.tmp" "$s/CLAUDE.md.starter"
  out=$("$SYNC_SRC" "$s" 2>&1); rc=$?
  [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q 'no intact' && ok "rules-sync: a file whose markers were removed fails loudly" || bad "rules-sync no-markers: rc=$rc out='$out'"
  # 4. a single present copy passes with a notice (nothing to compare)
  s="$tmp/sync-one"; mk_sync_root "$s"; rm "$s/CLAUDE.md.starter" "$s/AGENTS.md.starter"
  out=$("$SYNC_SRC" "$s" 2>&1); rc=$?
  [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q 'nothing to compare' && ok "rules-sync: a lone copy passes with a notice" || bad "rules-sync single: rc=$rc out='$out'"
  # 5. trailing whitespace and blank-line padding are not drift
  s="$tmp/sync-ws"; mk_sync_root "$s"
  awk '/<!-- \/sync:catastrophic-invariants -->/ { inside = 0 }
       inside { print $0 "  "; next }
       { print } /<!-- sync:catastrophic-invariants -->/ { inside = 1; print "" }' \
    "$s/CLAUDE.md.starter" > "$s/C.tmp" && mv "$s/C.tmp" "$s/CLAUDE.md.starter"
  out=$("$SYNC_SRC" "$s" 2>&1); rc=$?
  [ "$rc" -eq 0 ] && ok "rules-sync: trailing spaces / blank-line padding are not drift" || bad "rules-sync whitespace: rc=$rc out='$out'"
  # 6. an installed CLAUDE.md outranks the starter beside it
  s="$tmp/sync-installed"; mk_sync_root "$s"
  cp "$s/CLAUDE.md.starter" "$s/CLAUDE.md"; canary "$s/CLAUDE.md"
  out=$("$SYNC_SRC" "$s" 2>&1); rc=$?
  [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q 'CLAUDE ('"$s"'/CLAUDE.md)' && ok "rules-sync: the installed CLAUDE.md is read, not the starter beside it" || bad "rules-sync precedence: rc=$rc out='$out'"
else
  echo "  skip: 5 rules-sync mutation cases (fewer than three rule-file copies in this repo)"
fi

echo "hooks-behavior: $pass ok, $fail failed"
[ "$fail" -eq 0 ]

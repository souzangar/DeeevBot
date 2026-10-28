#!/usr/bin/env bash
# Pins the LIVE critical-path tripwire pattern: BANNED_PATTERNS in
# .claude/hooks/critical-path-tripwire.sh as this project configured it.
#
# hooks-behavior.sh pins the hook's contract on BLANKED copies, so nothing
# else notices when the project's own pattern stops compiling (the hook runs
# `grep -nE "$BANNED_PATTERNS" || true`, so an invalid regex turns it into a
# silent no-op) or stops matching the shapes the critical invariants ban.
#   (a) BANNED_PATTERNS is set, in its one-line '...' form, and compiles as a
#       grep -E regex;
#   (b) the UNMODIFIED hook, run through its stdin contract inside a temporary
#       git work tree holding copies of the hook and the globs file, exits 2 on
#       each banned shape in a critical-path file, and 0 on the look-alikes, on
#       a test file and on a non-critical file.
set -u
# Hermetic git, as in hooks-behavior.sh: no user/system config, and no
# caller's repository variables leaking into the fixture.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_COMMON_DIR GIT_PREFIX GIT_NAMESPACE
ROOT=$(cd "$(dirname "$0")/.." && pwd)
HOOK_SRC="$ROOT/.claude/hooks/critical-path-tripwire.sh"
CONF_SRC="$ROOT/.claude/devil/critical-globs.conf"
pass=0; fail=0
ok()  { echo "  ok:   $1"; pass=$((pass+1)); }
bad() { echo "  FAIL: $1"; fail=$((fail+1)); }

command -v jq >/dev/null 2>&1 || { echo "tripwire-patterns: jq is required (the hook parses its payload with it)"; exit 1; }
[ -r "$HOOK_SRC" ] && [ -r "$CONF_SRC" ] || { echo "tripwire-patterns: hook or globs file missing"; exit 1; }

# --- (a) the live pattern ----------------------------------------------------
pat=$(sed -n "s/^BANNED_PATTERNS='\(.*\)'\$/\1/p" "$HOOK_SRC")
[ -n "$pat" ] && ok "BANNED_PATTERNS is set, on one line, single-quoted" \
  || bad "BANNED_PATTERNS is empty or not in the one-line '...' form (the tripwire is inert)"
grep -E "$pat" </dev/null >/dev/null 2>&1; rc=$?
[ "$rc" -ne 2 ] && ok "BANNED_PATTERNS compiles as a grep -E regex" \
  || bad "BANNED_PATTERNS is not a valid grep -E regex: the hook would be a silent no-op"
grep -E '(' </dev/null >/dev/null 2>&1; rc=$?
[ "$rc" -eq 2 ] && ok "control: the compile check detects an invalid regex" \
  || bad "control: grep -E did not report an invalid regex (rc=$rc)"

# --- (b) the unmodified hook on fixtures -------------------------------------
tmp=$(mktemp -d "${TMPDIR:-/tmp}/tripwire-patterns-XXXXXX") || exit 1
trap 'rm -rf "$tmp"' EXIT
proj="$tmp/proj"
mkdir -p "$proj/.claude/hooks" "$proj/.claude/devil"
cp "$HOOK_SRC" "$proj/.claude/hooks/critical-path-tripwire.sh"
cp "$CONF_SRC" "$proj/.claude/devil/critical-globs.conf"
HOOK="$proj/.claude/hooks/critical-path-tripwire.sh"
cmp -s "$HOOK_SRC" "$HOOK" && ok "fixture runs a byte-identical copy of the live hook" \
  || bad "fixture hook differs from the live hook"
git -C "$proj" init -q
echo base > "$proj/README"
git -C "$proj" add -A
git -C "$proj" -c user.email=t@t.t -c user.name=t commit -qm init \
  || { echo "setup: fixture commit failed"; exit 1; }
export CLAUDE_PROJECT_DIR="$proj"

n=0
# $1 = expected exit code, $2 = repo-relative path under the fixture, $3 = the
# file's single line. Each case writes its own new (untracked) file, so the
# hook scans the whole file.
check() {
  n=$((n+1))
  local path="$proj/$2"
  mkdir -p "$(dirname "$path")"
  printf '%s\n' "$3" > "$path"
  printf '{"tool_input":{"file_path":"%s"}}' "$path" | bash "$HOOK" >/dev/null 2>"$tmp/stderr.$n"
  local rc=$?
  if [ "$rc" -eq "$1" ]; then ok "exit $rc for $2: $3"; else bad "expected exit $1, got $rc, for $2: $3"; fi
}

# Banned shapes in a critical-path file (*src/telegram/*): the hook fires.
check 2 src/telegram/console.ts 'console.log(update);'
console_case=$n
check 2 src/telegram/forward.ts 'await bot.api.forwardMessage(chat, from, id);'
check 2 src/telegram/bare-fetch.ts 'const r = await fetch(reportedUrl);'
check 2 src/telegram/line-start-fetch.ts 'fetch(reportedUrl);'
check 2 src/telegram/globalthis-fetch.ts 'await globalThis.fetch(reportedUrl);'
check 2 src/telegram/self-fetch.ts 'await self.fetch(reportedUrl);'
check 2 src/telegram/window-fetch.ts 'await window.fetch(reportedUrl);'
check 2 src/telegram/preview.ts 'await ctx.reply(text, { link_preview_options: { is_disabled: false } });'
grep -q 'critical-path tripwire' "$tmp/stderr.$console_case" && grep -q 'rule 6' "$tmp/stderr.$console_case" \
  && ok "a hit feeds back the reminder naming the rule" || bad "a hit did not feed back the reminder"

# Look-alikes, a test file and a non-critical file: the hook stays silent.
check 0 src/telegram/member.ts 'const m = await bot.api.getChatMember(groupId, userId);'
check 0 src/telegram/stub.ts 'const res = await stub.fetch(request);'
check 0 src/telegram/handler.test.ts 'console.log(update);'
check 0 src/i18n/parse.ts 'console.log(update);'
# src/platforms/ holds the link policy (rule 4): a critical path.
check 2 src/platforms/links.ts 'console.log(update);'

echo "tripwire-patterns: $pass ok, $fail failed"
[ "$fail" -eq 0 ]

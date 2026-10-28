#!/usr/bin/env bash
# Run the kit's self-tests: syntax-check every shell file, then the behavior
# suites. Green here = the safety invariants of the shipped scripts hold on
# THIS machine. Run after copying the kit anywhere, and after editing any
# shipped script. Port the invariant assertions into the target project's
# own test suite once it has one.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
overall=0

command -v git >/dev/null 2>&1 || { echo "run-all: git is required"; exit 1; }
command -v jq  >/dev/null 2>&1 || { echo "run-all: jq is required (the hooks and devil.sh parse JSON with it)"; exit 1; }

# EDIT-ME (after install): directories, relative to the project root, that hold
# the PROJECT's own shell scripts — invariant checks, extra hooks, e.g.
#   EXTRA_SYNTAX_DIRS="scripts/invariants scripts/hooks"
# They join the `bash -n` sweep below; the kit's own scripts (.claude/, selftest/)
# are always swept, and nothing else is (see the note on $ROOT).
EXTRA_SYNTAX_DIRS=""

echo "== syntax check (bash -n) =="
# Deliberately scoped to the kit's own scripts (plus EXTRA_SYNTAX_DIRS) —
# post-install, $ROOT is the whole project and walking it would sweep
# vendored/third-party shell files. `*.sh.example` templates are swept too.
bad=0
sweep=("$ROOT/.claude" "$HERE")
for d in $EXTRA_SYNTAX_DIRS; do
  if [ -d "$ROOT/$d" ]; then sweep[${#sweep[@]}]="$ROOT/$d"; else echo "  note: EXTRA_SYNTAX_DIRS entry '$d' is not a directory under $ROOT — skipped"; fi
done
while IFS= read -r f; do
  bash -n "$f" 2>/dev/null || { echo "  SYNTAX FAIL: $f"; bad=1; }
done < <(find "${sweep[@]}" \( -name '*.sh' -o -name '*.sh.example' \) -type f 2>/dev/null | sort)
if [ "$bad" -eq 0 ]; then echo "  all shell files parse."; else overall=1; fi

total_ok=0; total_fail=0
log=$(mktemp "${TMPDIR:-/tmp}/selftest-suite-XXXXXX") || exit 1
trap 'rm -f "$log"' EXIT
for t in devil-sh-invariants hooks-behavior statusline-smoke critical-globs-completeness tripwire-patterns; do
  echo "== $t =="
  bash "$HERE/$t.sh" 2>&1 | tee "$log"
  [ "${PIPESTATUS[0]}" -eq 0 ] || overall=1
  counts=$(sed -n 's/^[A-Za-z-]*: \([0-9][0-9]*\) ok, \([0-9][0-9]*\) failed.*/\1 \2/p' "$log" | tail -n 1)
  if [ -n "$counts" ]; then
    total_ok=$((total_ok + ${counts% *})); total_fail=$((total_fail + ${counts#* }))
  fi
done

echo "TOTAL: $total_ok assertions ok, $total_fail failed"
if [ "$overall" -eq 0 ]; then
  echo "ALL SELF-TESTS PASSED"
else
  echo "SELF-TEST FAILURES — see above"
fi
exit "$overall"

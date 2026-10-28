#!/usr/bin/env bash
# rules-sync-check.sh — the catastrophic-rules drift gate.
#
# The same invariants live, deliberately, in THREE places (owner ruling
# 2026-10-28: keep the triplication — redundant native context beats a
# pointer — and make the sync mechanical instead):
#   1. CLAUDE.md          "## Critical invariants"      (Claude's auto-context)
#   2. AGENTS.md          "## Catastrophic invariants"  (the codex critic's auto-context)
#   3. .claude/devil/critical-invariants.md             (devil.sh injects on critical runs)
# Each copy sits between these exact marker lines:
#   <!-- sync:catastrophic-invariants -->
#   <!-- /sync:catastrophic-invariants -->
# This script extracts the marked block from every copy that exists and
# requires the blocks to be IDENTICAL (after stripping trailing spaces and
# leading/trailing blank lines — edit all copies verbatim, in the same
# commit). A present file whose markers are missing FAILS: deleting or
# renaming the section is drift, not an exemption. Fewer than two copies
# present is reported and passes (nothing to compare; the selftest already
# says which files an install consumed).
#
# Wire it as an INVARIANT_CMD step in .claude/hooks/pre-commit-check.sh,
# e.g.:  INVARIANT_CMD=".claude/hooks/rules-sync-check.sh && <the rest>"
# Exit: 0 in sync (or <2 copies), 1 on drift or missing markers, 2 on misuse.
set -u

MARK_OPEN='<!-- sync:catastrophic-invariants -->'
MARK_CLOSE='<!-- /sync:catastrophic-invariants -->'

# Repo root: $1 if given, else two levels above this script (.claude/hooks/).
if [ $# -gt 1 ]; then
  echo "rules-sync-check: usage: rules-sync-check.sh [repo-root]" >&2
  exit 2
fi
if [ $# -eq 1 ]; then
  root=$1
else
  root=$(cd "$(dirname "$0")/../.." 2>/dev/null && pwd) || root=""
fi
if [ -z "$root" ] || [ ! -d "$root" ]; then
  echo "rules-sync-check: cannot resolve the repo root — FAIL (fail-closed)" >&2
  exit 1
fi

# Installed name first, starter/example fallback (pristine kit).
resolve() { # $1 installed, $2 fallback -> echoes the one that exists, if any
  if [ -f "$root/$1" ]; then echo "$root/$1"
  elif [ -f "$root/$2" ]; then echo "$root/$2"
  fi
}
claude_f=$(resolve "CLAUDE.md" "CLAUDE.md.starter")
agents_f=$(resolve "AGENTS.md" "AGENTS.md.starter")
invar_f=$(resolve ".claude/devil/critical-invariants.md" \
                  ".claude/devil/critical-invariants.md.example")

tmp=$(mktemp -d "${TMPDIR:-/tmp}/rules-sync-XXXXXX") || {
  echo "rules-sync-check: mktemp failed — FAIL (fail-closed)" >&2; exit 1; }
trap 'rm -rf "$tmp"' EXIT

# Extract the marked block, normalized: trailing whitespace stripped, leading
# and trailing blank lines dropped. Markers themselves are excluded.
extract() { # $1 file, $2 out
  awk -v mopen="$MARK_OPEN" -v mclose="$MARK_CLOSE" '
    index($0, mclose) && inside { inside = 0; next }
    inside { sub(/[ \t]+$/, ""); print }
    index($0, mopen) && !seen { inside = 1; seen = 1 }
    END { exit !(seen && !inside) }  # fail: no open marker, or never closed
  ' "$1" > "$2.raw" || return 1
  awk 'NF { blank = 0 } !NF { blank++; next }
       { while (blank-- > 0) print ""; print }' "$2.raw" > "$2"
}

names=() files=()
[ -n "$claude_f" ] && { names+=("CLAUDE");  files+=("$claude_f"); }
[ -n "$agents_f" ] && { names+=("AGENTS");  files+=("$agents_f"); }
[ -n "$invar_f" ]  && { names+=("INVARIANTS"); files+=("$invar_f"); }

fail=0
extracted=() ok_names=()
for i in "${!files[@]}"; do
  out="$tmp/${names[$i]}"
  if extract "${files[$i]}" "$out"; then
    extracted+=("$out"); ok_names+=("${names[$i]} (${files[$i]})")
  else
    echo "rules-sync-check: ${files[$i]} has no intact '$MARK_OPEN' … '$MARK_CLOSE' block — the section was deleted, renamed, or left unclosed. DRIFT." >&2
    fail=1
  fi
done

if [ "$fail" -eq 0 ] && [ "${#extracted[@]}" -lt 2 ]; then
  echo "rules-sync-check: only ${#extracted[@]} copy present — nothing to compare (an install may have consumed the others); pass."
  exit 0
fi

i=1
while [ "$fail" -eq 0 ] && [ "$i" -lt "${#extracted[@]}" ]; do
  if ! cmp -s "${extracted[0]}" "${extracted[$i]}"; then
    echo "rules-sync-check: catastrophic-invariants blocks DIFFER between ${ok_names[0]} and ${ok_names[$i]} — edit every copy, verbatim, in the same commit:" >&2
    diff -u "${extracted[0]}" "${extracted[$i]}" >&2 || true
    fail=1
  fi
  i=$((i + 1))
done

[ "$fail" -eq 0 ] && echo "rules-sync-check: ${#extracted[@]} copies in sync."
exit "$fail"

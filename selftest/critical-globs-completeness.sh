#!/usr/bin/env bash
# Skeleton: prove .claude/devil/critical-globs.conf COVERS every critical file.
#
# Sharing one globs file gives devil.sh and the tripwire *agreement* by
# construction — but not *coverage*: a critical file matched by no glob evades
# effort escalation, the tripwire, and auditor scoping, and nothing says so.
# The source project learned this the hard way. The fix is a mechanical
# anchor: something every critical file provably contains (an import of the
# critical helper module, an annotation, a directory convention) — then this
# check pins "every anchored file is matched by some glob".
#
# EDIT-ME below, then wire this into CI and/or the commit gate's
# INVARIANT_CMD so it runs on every commit. Inert (exit 0, with a notice)
# until ANCHOR_PATTERN is set.
set -u

# EDIT-ME: grep -E pattern that marks a file as critical, e.g.
#   ANCHOR_PATTERN='from ["'"'"'].*common/money/'     (imports the money helpers)
#   ANCHOR_PATTERN='@critical-path'                    (annotation convention)
ANCHOR_PATTERN='@critical-path'
# EDIT-ME: where critical code can live (space-separated dirs):
SRC_DIRS='src migrations'

ROOT=$(cd "$(dirname "$0")/.." && pwd)
conf="$ROOT/.claude/devil/critical-globs.conf"

if [ -z "$ANCHOR_PATTERN" ]; then
  echo "critical-globs-completeness: not configured (set ANCHOR_PATTERN) — skipping."
  exit 0
fi
[ -r "$conf" ] || { echo "critical-globs-completeness: ANCHOR_PATTERN is set but $conf is missing"; exit 1; }
cd "$ROOT" || exit 1

viol=0
# shellcheck disable=SC2086  # SRC_DIRS is a deliberate word-split list
while IFS= read -r f; do
  hit=0
  while IFS= read -r pat || [ -n "$pat" ]; do
    pat=${pat%$'\r'}
    case "$pat" in ''|'#'*) continue ;; esac
    # shellcheck disable=SC2254  # unquoted on purpose: glob match
    case "$f" in $pat) hit=1; break ;; esac
  done < "$conf"
  if [ "$hit" -eq 0 ]; then
    echo "NOT COVERED by critical-globs.conf: $f"
    viol=1
  fi
done < <(grep -rlE "$ANCHOR_PATTERN" $SRC_DIRS 2>/dev/null)

[ "$viol" -eq 0 ] && echo "critical-globs-completeness: every anchored file is covered."
exit "$viol"

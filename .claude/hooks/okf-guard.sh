#!/usr/bin/env bash
# Stop hook — enforce the OKF gate before the turn ends whenever the docs
# bundle is implicated. Trigger (an honest approximation of "changed this
# turn"): the bundle root is DIRTY (staged/unstaged/untracked) at stop time,
# OR the tree is clean and the LATEST commit touched the bundle (covers
# docs committed mid-turn; idempotent — a green gate stays green).
#
# Dependency behavior (declared, tested):
#   - node missing + bundle implicated → BLOCK once with a clear message
#     (fail-loud; the stop_hook_active loop-guard lets the next stop pass).
#   - jq missing → loop-guard falls back to a whitespace-tolerant grep on
#     the raw payload; the gate itself still runs (node does the real work).
#   - DECLARED fail-open (warn on stderr, allow), and nothing else: git not
#     installed, the project directory unreachable, or the directory not a
#     git work tree — in all three there is no repo claim to enforce.
#   - git ERRORS inside a real work tree (status/diff-tree failing) are
#     fail-CLOSED: the bundle is treated as implicated and the gate runs,
#     surfacing whatever is broken.
# The hook is a convenience; CI running `node scripts/okf/check.mjs` is the
# authority.
set -uo pipefail

# EDIT-ME (keep in sync with okf.config.mjs docRoot):
DOC_ROOT="doc"
# EDIT-ME if your check entrypoint differs:
CHECK_CMD="node scripts/okf/check.mjs"

input=$(cat)

# Avoid loops: if we already blocked once this stop cycle, let it finish.
if command -v jq >/dev/null 2>&1; then
  active=$(printf '%s' "$input" | jq -r '.stop_hook_active // false')
else
  # HEURISTIC fallback (declared): flatten whitespace, then look for the
  # key:true pair. Tolerates newlines/tabs anywhere JSON allows them; it is
  # not a JSON parser (a nested same-name key could fool it) — jq is the
  # correct path, this only keeps the loop guard functional without it.
  if printf '%s' "$input" | tr -d '\n\r\t' | grep -qE '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
    active=true
  else
    active=false
  fi
fi
[ "$active" = "true" ] && exit 0

if ! cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null; then
  echo "okf-guard: cannot cd to project dir '${CLAUDE_PROJECT_DIR:-.}' — OKF gate skipped (declared fail-open)." >&2
  exit 0
fi

if ! command -v git >/dev/null 2>&1; then
  echo "okf-guard: git not found — cannot scope doc changes; OKF gate skipped (declared fail-open)." >&2
  exit 0
fi
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "okf-guard: not a git work tree — no repo claim to enforce; OKF gate skipped (declared fail-open)." >&2
  exit 0
fi

# Scope: the bundle itself, the gate machinery, and this hook — a turn that
# edits okf.config.mjs or a gate script must re-prove conformance even when
# no doc changed. --root covers a repository whose very first commit added
# the docs. Git ERRORS here (inside a confirmed work tree) fail CLOSED:
# treat as implicated so the gate runs and surfaces the breakage.
SCOPE=("$DOC_ROOT" scripts/okf .claude/hooks/okf-guard.sh)
implicated=0
status_out=$(git status --porcelain -- "${SCOPE[@]}" 2>/dev/null) || implicated=1
printf '%s' "$status_out" | grep -q . && implicated=1
if [ "$implicated" = 0 ]; then
  tree_out=$(git diff-tree --root --no-commit-id --name-only -r HEAD -- "${SCOPE[@]}" 2>/dev/null)
  rc=$?
  # rc!=0 with no commits yet is benign emptiness only when HEAD is unborn;
  # any other diff-tree failure fails closed.
  if [ "$rc" -ne 0 ]; then
    git rev-parse --verify HEAD >/dev/null 2>&1 && implicated=1
  else
    printf '%s' "$tree_out" | grep -q . && implicated=1
  fi
fi
[ "$implicated" = 1 ] || exit 0

if ! command -v node >/dev/null 2>&1; then
  {
    echo "OKF gate cannot run: node is not installed, but '$DOC_ROOT/' is implicated this turn."
    echo "Install node (the gate scripts are Node) or remove this Stop hook — do not treat the bundle as validated."
  } >&2
  exit 2
fi

if out=$($CHECK_CMD 2>&1); then
  exit 0
fi

{
  echo "OKF gate failed — '$DOC_ROOT/' is implicated this turn but the bundle isn't conformant."
  echo "Fix before finishing (frontmatter / links / refs / stale index):"
  printf '%s\n' "$out" | tail -30
  echo
  echo "Usually: node scripts/okf/build-index.mjs && $CHECK_CMD"
} >&2
exit 2

#!/usr/bin/env bash
# secret-shape-scan.sh — the one "must not" every repo can pin on day one: no
# secret-SHAPED string in any tracked file, and in no untracked file that
# git does not ignore. Needs nothing but git (git grep -E): no language
# toolchain, no test framework, so it works in a repo with no code yet.
#
# Install: cp secret-shape-scan.sh.example secret-shape-scan.sh && chmod +x
# secret-shape-scan.sh, edit SHAPES, then make it the FIRST step of the
# commit gate (.claude/hooks/pre-commit-check.sh):
#   INVARIANT_CMD=".claude/hooks/secret-shape-scan.sh"
# and keep it first when the gate grows: INVARIANT_CMD="<this> && <your specs>".
#
# FAIL-CLOSED: exit 1 = a secret-shaped string was found; exit 2 = the scan
# itself could not run or reported a problem (not a git work tree, git
# failing, a broken regex, anything on stderr) — "could not look" is never
# "looked and found nothing". It prints file paths and match COUNTS only,
# never a matched line, so the gate log and the model context never carry the
# secret. Binary files are skipped. Move a hit into the environment or a secret
# store — and rotate it, because it is in your history from the moment it was
# committed.
set -u

# EDIT-ME — grep -E regexes of the SHAPES of your secrets (never the secrets):
SHAPES=(
  '[0-9]{8,10}:[A-Za-z0-9_-]{35}'            # Telegram bot token
  'AKIA[0-9A-Z]{16}'                          # AWS access key id
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'        # PEM private key block
  '(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}'     # GitHub token
)

cd "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null ||
  { echo "secret-shape-scan: not inside a git work tree — cannot scan" >&2; exit 2; }
args=(); for s in "${SHAPES[@]}"; do args+=(-e "$s"); done
err=$(mktemp "${TMPDIR:-/tmp}/secret-scan-XXXXXX") || exit 2
trap 'rm -f "$err"' EXIT
hits=$(git grep -I -c -E "${args[@]}" --untracked --exclude-standard 2>"$err"); rc=$?
if [ "$rc" -gt 1 ] || [ -s "$err" ]; then
  echo "secret-shape-scan: the scan itself failed (rc=$rc) — blocking, fail-closed" >&2; cat "$err" >&2; exit 2
fi
[ "$rc" -eq 1 ] && exit 0
echo "secret-shape-scan: secret-shaped string in (file:matching lines):" >&2
printf '%s\n' "$hits" | sed 's/^/  /' >&2
exit 1

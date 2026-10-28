#!/usr/bin/env bash
# PostToolUse(Edit|Write) hook — critical-path tripwire.
#
# Heuristic reminder, not an authority: when newly-added lines in a
# critical-path file match a banned pattern, feed a reminder back to the model
# (exit 2 = the message reaches the model; the edit itself already happened
# and is NOT reverted). The real gates are the domain-auditor agent, the
# devil, and your invariant tests — this just catches slips at authoring time.
#
# Scope comes from .claude/devil/critical-globs.conf — the SAME data file
# devil.sh uses, so hook and script cannot drift. The file is DATA: read line
# by line and glob-matched, never executed.
#
# Inert until configured: exits 0 silently while the globs file is absent,
# BANNED_PATTERNS below is empty, or jq is missing. (The pre-commit gate is
# the visibility point for the missing-conf AND empty-BANNED_PATTERNS states —
# a per-edit warning would be spam.)
set -uo pipefail

# ---------------------------------------------------------------------------
# EDIT-ME — what to flag on ADDED lines in critical-path files.
#
# BANNED_PATTERNS: one grep -E regex (alternation with |). Examples:
#   money handling:   'parseFloat[[:space:]]*\(|\.toFixed[[:space:]]*\(|[^A-Za-z0-9_.]Number[[:space:]]*\('
#   raw SQL strings:  'query\(["'"'"'`]'
#   secrets in code:  'API_KEY[[:space:]]*=[[:space:]]*["'"'"']'
BANNED_PATTERNS='console\.(log|error|warn|info|debug)\(|forwardMessages?\(|copyMessages?\(|getChat\(|getFile\(|(^|[^A-Za-z0-9_.])fetch\(|(globalThis|self|window)\.fetch\(|JSON\.stringify\((err|error|e|ctx|update)\b|disable_web_page_preview|is_disabled:[[:space:]]*false'

# File globs never checked (tests may legitimately contain banned shapes):
SKIP_FILE_GLOBS='*.spec.* *.test.* *_test.*'

# The reminder the model sees on a hit — state the invariant and the sanctioned
# alternative. Keep it short; point to .claude/devil/critical-invariants.md.
REMINDER=$(cat <<'EOF'
These shapes break div-report's critical invariants (full text:
.claude/devil/critical-invariants.md, mirrored in CLAUDE.md):
- console.*( or JSON.stringify(err|error|e|ctx|update): rule 6. Never log a
  payload, an update or an error wholesale; log through the redacting
  logger in src/privacy/, which records the error class only.
- forwardMessage(s)( / copyMessage(s)( / getChat( / getFile(: rules 3 and 4.
  Never forward or copy a reported message, and never fetch or download
  what a reported link points to; intake is text-only.
- a bare fetch( or globalThis./self./window.fetch(: rule 4. The only
  outbound call is the Telegram Bot API adapter's; a reported URL is never
  fetched.
- disable_web_page_preview, or is_disabled: false: rule 4. Every message
  that carries a reported URL sets link_preview_options: { is_disabled: true }.
EOF
)
# ---------------------------------------------------------------------------

command -v jq >/dev/null 2>&1 || exit 0
input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')
[ -z "$file" ] && exit 0

proj="${CLAUDE_PROJECT_DIR:-.}"
conf="$proj/.claude/devil/critical-globs.conf"
[ -r "$conf" ] || exit 0
[ -n "$BANNED_PATTERNS" ] || exit 0

# Match against the REPO-RELATIVE path, exactly like devil.sh matches
# `git diff --name-only` output — so one conf line means the same thing to
# both consumers. (Leading-* globs match either form; repo-relative globs
# like `src/pay/*` would silently miss the absolute path without this.)
rel="${file#"$proj"/}"

for g in $SKIP_FILE_GLOBS; do
  # shellcheck disable=SC2254  # unquoted on purpose: globs must glob-match
  case "$rel" in $g) exit 0 ;; esac
done

matched=0
while IFS= read -r pat || [ -n "$pat" ]; do
  pat=${pat%$'\r'}
  case "$pat" in ''|'#'*) continue ;; esac
  # shellcheck disable=SC2254
  case "$rel" in $pat) matched=1; break ;; esac
done < "$conf"
[ "$matched" = 1 ] || exit 0
[ -f "$file" ] || exit 0

cd "$proj" 2>/dev/null || exit 0

# Look only at lines this working tree ADDED vs HEAD (low noise). Exclude
# only the `+++ ` file header (space-anchored: added content that itself
# starts with "++" must survive). The whole-file fallback is for UNTRACKED
# files only — a tracked file whose edit added no lines (deletion-only) must
# not resurrect its old content as findings.
added=$(git diff HEAD -- "$file" 2>/dev/null | grep '^+' | grep -vE '^\+\+\+ ' || true)
if [ -z "$added" ]; then
  git ls-files --error-unmatch -- "$file" >/dev/null 2>&1 && exit 0
  added=$(sed 's/^/+/' "$file" 2>/dev/null)
fi

hits=$(printf '%s\n' "$added" | grep -nE "$BANNED_PATTERNS" || true)
[ -z "$hits" ] && exit 0

{
  echo "critical-path tripwire — $file"
  echo "Newly-added line(s) match a banned pattern (heuristic):"
  printf '%s\n' "$hits" | sed 's/^/    /'
  echo
  printf '%s\n' "$REMINDER"
  echo "If this is a genuine false positive, ignore. Otherwise fix before finishing."
} >&2
exit 2

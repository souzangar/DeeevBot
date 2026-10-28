#!/usr/bin/env bash
# PreToolUse(Bash) hook — gate `git commit` on the project's own checks.
# Every non-commit Bash command passes straight through (exit 0) so normal use
# stays fast.
#
# Token-aware reporting: running the checks OUT of the main thread is the
# whole point — the heavy output never enters the model's context.
#   PASS -> exit 0, nothing on stderr            -> ~0 main-thread tokens.
#   FAIL -> exit 2 (blocks the commit) + a COMPACT summary on stderr (failing
#           step + a few key error lines + a path). The FULL output lives in
#           $GATE_LOG for on-demand drill-down — the model should read that
#           file if the summary isn't enough, NOT re-run the gate.
#
# Inert until configured: with all three command slots empty the hook lets the
# commit through but prints a visible notice so the gap stays visible.
#
# Escape hatch for an intentional bypass: prefix the commit command with
# SKIP_COMMIT_GATE=1 (detected in the COMMAND STRING — an inline env
# assignment never reaches this hook's own environment) or export it.
#
# Scope notes (accepted limitations, not bugs):
# - The commit matcher is a guardrail for the routine flow, not a security
#   boundary — exotic quoting/wrapping can slip past it; CI is the backstop.
# - The gate validates the WORKING TREE, not the staged snapshot. Commit with
#   tree == index (e.g. `git add -A` right before) or accept that unstaged
#   edits can mask what is actually being committed; snapshot isolation was
#   rejected as too invasive for a hook.
set -uo pipefail

# ---------------------------------------------------------------------------
# EDIT-ME — the project's gate commands. Leave a slot empty ("") to skip it.
#
# BUILD_CMD:     fast compile/typecheck/lint, e.g.
#                  "npm run build"  |  "cargo check"  |  "go build ./..."
# TEST_CMD:      the unit-test run; prefer a changed-files-only variant, e.g.
#                  "npm test -- --changedSince=HEAD --passWithNoTests"
# INVARIANT_CMD: the always-run invariant/regression specs — tests that
#                FS-walk the tree or pin global "must never happen" rules;
#                changed-file selection never picks them up, so they must be
#                run explicitly on EVERY commit (see
#                .claude/kit-docs/WORKFLOW.md). Including
#                the kit's own guard here keeps the tooling honest too, e.g.
#                  INVARIANT_CMD="bash selftest/run-all.sh && <your specs>"
#                The stack-free first invariant for a brand-new repo is
#                .claude/hooks/secret-shape-scan.sh (INSTALL step 3).
#                Keep each slot's value on ONE line: put a longer command in
#                a script and call that (selftest/hooks-behavior.sh blanks
#                the slots line by line).
BUILD_CMD=""
TEST_CMD=""
INVARIANT_CMD=".claude/hooks/rules-sync-check.sh && .claude/hooks/secret-shape-scan.sh && bash selftest/run-all.sh && bash selftest-okf/run-all.sh && node scripts/okf/check.mjs"
# ---------------------------------------------------------------------------

input=$(cat)

# jq is required to parse the hook payload; degrade harmlessly but VISIBLY —
# the static JSON below needs no jq and is the user-visible channel.
if ! command -v jq >/dev/null 2>&1; then
  case "$input" in
    *"git commit"*|*"git"*" commit"*)
      printf '{"systemMessage":"pre-commit gate: jq not installed — gate skipped (install jq to enable it)"}\n' ;;
  esac
  exit 0
fi

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')

# Only gate real `git commit` invocations: top-level or chained (&& ; |),
# allowing env-assignment prefixes (`VAR=x git commit` — without this, any
# prefix silently bypasses the whole gate), `command git`, an absolute git
# path, and flag words between git and commit (`-C <dir>`, `-c k=v`,
# `--long[=v]`). Best-effort guardrail. ASSIGN/GIT_COMMIT are shared with
# the skip detector below so both recognize the SAME invocation shape.
ASSIGN='[A-Za-z_][A-Za-z_0-9]*=[^[:space:]]*'
GIT_COMMIT='(command[[:space:]]+)?([^[:space:]]*/)?git([[:space:]]+-[Cc][[:space:]]+[^[:space:]]+|[[:space:]]+--?[A-Za-z][A-Za-z-]*(=[^[:space:]]*)?)*[[:space:]]+commit\b'
printf '%s' "$cmd" | grep -qE "(^|&&|;|\|)[[:space:]]*($ASSIGN[[:space:]]+)*$GIT_COMMIT" || exit 0

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0

# Commit time is the visibility point for inert critical-path protections
# (per-edit warnings from the tripwire would be spam): report a missing or
# semantically empty globs conf, the half-configured state where the conf
# exists but the tripwire's BANNED_PATTERNS is still empty, and a missing or
# still-placeholder invariants file.
config_notes() {
  conf=".claude/devil/critical-globs.conf"
  if [ ! -r "$conf" ]; then
    echo "note: $conf missing — critical-path escalation + tripwire are inert (see .claude/kit-docs/INSTALL.md)."
  elif [ "$(grep -cvE '^[[:space:]]*(#|$)' "$conf" 2>/dev/null)" = "0" ]; then
    echo "note: $conf has no active globs — critical-path escalation + tripwire are inert."
  else
    sibling="$(dirname "$0")/critical-path-tripwire.sh"
    if [ -f "$sibling" ] && grep -q "^BANNED_PATTERNS=''" "$sibling" 2>/dev/null; then
      echo "note: critical-globs.conf exists but BANNED_PATTERNS is still empty in .claude/hooks/critical-path-tripwire.sh — the authoring-time tripwire is inert."
    fi
    inv=".claude/devil/critical-invariants.md"
    if [ ! -r "$inv" ] || ! grep -qE '[^[:space:]]' "$inv" 2>/dev/null || grep -q "EDIT-ME" "$inv" 2>/dev/null; then
      echo "note: $inv is missing, empty, or still placeholder — devil critiques won't carry your invariants."
    fi
  fi
}

# A {"systemMessage": ...} JSON stdout is the one success-path channel the
# user reliably SEES (plain stdout with exit 0 is transcript-only). Callers
# must keep stdout otherwise clean for that invocation — mixed output stops
# parsing as JSON and the message silently degrades to transcript-only.
say_visible() { jq -n --arg m "$1" '{systemMessage: $m}'; }

# Bypass: exported env OR an inline `SKIP_COMMIT_GATE=1 git commit ...`
# prefix — the inline form only exists in the proposed command string (it
# never reaches this hook's environment), so detect it there. The flag must
# prefix the COMMITTING git invocation itself (same GIT_COMMIT shape as the
# matcher): the flag on an unrelated git command, inside a commit message,
# or in an unrelated chained word must NOT skip the gate (quoted text is
# still not shell-parsed — best-effort, like the matcher).
if [ "${SKIP_COMMIT_GATE:-0}" = "1" ] \
   || printf '%s' "$cmd" | grep -qE "(^|&&|;|\|)[[:space:]]*($ASSIGN[[:space:]]+)*SKIP_COMMIT_GATE=1([[:space:]]+$ASSIGN)*[[:space:]]+$GIT_COMMIT"; then
  say_visible ">>> pre-commit gate: SKIPPED (SKIP_COMMIT_GATE=1)"
  exit 0
fi

notes=$(config_notes)
# The gate validates the working tree; if the tree differs from what will be
# committed, say so instead of pretending the check covered it. Two forms:
# tracked-but-unstaged edits (tree ≠ index), and untracked files (they shape
# the validated tree but are absent from the commit).
if ! git diff --quiet 2>/dev/null; then
  drift="note: working tree differs from the staged snapshot — the gate validated the TREE; stage everything (git add -A) for the check to cover the commit exactly."
  notes="${notes:+$notes
}$drift"
fi
if [ -n "$(git ls-files --others --exclude-standard 2>/dev/null | head -1)" ]; then
  drift="note: untracked files present — they shaped the validated tree but are NOT part of the commit (add or ignore them)."
  notes="${notes:+$notes
}$drift"
fi

if [ -z "$BUILD_CMD" ] && [ -z "$TEST_CMD" ] && [ -z "$INVARIANT_CMD" ]; then
  say_visible ">>> pre-commit gate: not configured yet — commit allowed. Fill the EDIT-ME slots in .claude/hooks/pre-commit-check.sh.${notes:+ $notes}"
  exit 0
fi

GATE_LOG="${TMPDIR:-/tmp}/claude-precommit-gate-$(basename "$PWD")-$(printf '%s' "$PWD" | cksum | cut -d' ' -f1).log"
: > "$GATE_LOG"
fail=0
failed=""

# Progress goes to the LOG only: stdout must stay clean so the final
# emission can be a parseable systemMessage (see say_visible).
run_step() { # $1 = label, $2 = command
  [ -n "$2" ] || { echo "===== $1: skipped (not configured) =====" >>"$GATE_LOG"; return 0; }
  { echo "===== $1 ====="; bash -c "$2"; } >>"$GATE_LOG" 2>&1 \
    || { fail=1; failed="${failed:+$failed, }$1"; }
}

run_step "build"      "$BUILD_CMD"
run_step "tests"      "$TEST_CMD"
run_step "invariants" "$INVARIANT_CMD"

if [ "$fail" != "0" ]; then
  {
    echo "pre-commit gate FAILED ($failed) — commit blocked."
    echo "key errors (preview only; the full log is authoritative):"
    grep -aiE 'error|fail|✕|✗|panic|exception' "$GATE_LOG" \
      | sed 's/\x1b\[[0-9;]*m//g' | head -n 12
    echo "full log: $GATE_LOG  (read it for detail — do NOT re-run the gate)"
    [ -n "$notes" ] && printf '%s\n' "$notes"
    echo "bypass intentionally: prefix the commit with SKIP_COMMIT_GATE=1"
  } >&2
  exit 2
fi

if [ -n "$notes" ]; then
  say_visible ">>> pre-commit gate passed. $notes"
else
  echo ">>> pre-commit gate passed.  (full log -> $GATE_LOG)"
fi
exit 0

#!/usr/bin/env bash
# Regression guard for the Stop hook's contract: trigger semantics (bundle
# or gate machinery dirty, OR touched by the latest commit), loop guard, and
# the declared dependency behavior — node missing blocks loudly, jq missing
# degrades to a heuristic grep fallback (still enforcing), and exactly three
# DECLARED fail-opens (git missing, unreachable project dir, not a git work
# tree), each with a warning.
set -u
# Hermetic git: the user's global/system config (commit signing, hooks,
# defaults) must not leak into the fixtures — a global commit.gpgsign=true
# would fail setup commits and let later cases false-pass.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
KIT=$(cd "$(dirname "$0")/.." && pwd)
GUARD="$KIT/.claude/hooks/okf-guard.sh"
pass=0; fail=0
ok()  { echo "  ok:   $1"; pass=$((pass+1)); }
bad() { echo "  FAIL: $1"; fail=$((fail+1)); }

tmp=$(mktemp -d "${TMPDIR:-/tmp}/okf-guard-XXXXXX") || exit 1
trap 'rm -rf "$tmp"' EXIT

proj="$tmp/proj"
mkdir -p "$proj/scripts/okf" "$proj/doc/guides" "$proj/src"
cp "$KIT/scripts/okf/"*.mjs "$proj/scripts/okf/"
cat > "$proj/scripts/okf/okf.config.mjs" <<'EOF'
export default {
  template: false, okfVersion: '0.1', docRoot: 'doc', skipDirs: [],
  reservedFiles: ['index.md', 'log.md'], conventionsFile: 'okf-conventions.md',
  bundleTitle: 'Guard Test Bundle',
  readmeStub: { enabled: true, title: 'Guard Test Docs', description: 'Start at index.md.' },
  refExtensions: ['md'], assetExcludeExts: ['.png'], activeStatus: 'active',
  folders: { guides: 'How-tos.' }, rulesAndInvariants: [],
};
EOF
cat > "$proj/doc/okf-conventions.md" <<'EOF'
---
type: reference
title: "Conventions"
description: "Fixture conventions doc."
---
# Conventions
EOF
cat > "$proj/doc/guides/how-to.md" <<'EOF'
---
type: guide
title: "How To"
description: "Fixture."
---
# How To
EOF
( cd "$proj" && node scripts/okf/build-index.mjs >/dev/null 2>&1 ) || { echo "setup: build-index failed"; exit 1; }
git -C "$proj" init -q
git -C "$proj" add -A
git -C "$proj" -c user.email=t@t.t -c user.name=t commit -qm "docs baseline" \
  || { echo "setup: baseline commit failed"; exit 1; }
echo "code" > "$proj/src/app.txt"
git -C "$proj" add -A
git -C "$proj" -c user.email=t@t.t -c user.name=t commit -qm "src only" \
  || { echo "setup: src commit failed"; exit 1; }
export CLAUDE_PROJECT_DIR="$proj"

plain='{"stop_hook_active":false}'
active='{"stop_hook_active":true}'

# full minimal PATH (node needs its real dir for spawned children? process.execPath is absolute — safe)
bin="$tmp/bin"; mkdir -p "$bin"
for t in bash git node jq grep tail cat sed printf env tr; do
  p=$(command -v "$t" 2>/dev/null) && ln -s "$p" "$bin/$t" 2>/dev/null
done

# --- 1. clean tree, HEAD touches only src → silent pass ---------------------
out=$(printf '%s' "$plain" | "$GUARD" 2>&1); rc=$?
[ "$rc" -eq 0 ] && [ -z "$out" ] && ok "clean tree + non-doc HEAD → exit 0 silent" || bad "clean-tree case rc=$rc out='$out'"

# --- 2. dirty doc + violation → blocks -------------------------------------
echo "no frontmatter" > "$proj/doc/guides/bad.md"
out=$(printf '%s' "$plain" | "$GUARD" 2>&1); rc=$?
[ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q "OKF gate failed" && ok "dirty doc + violation → exit 2 with message" || bad "violation not blocked rc=$rc"

# --- 3. loop guard: stop_hook_active → pass even with violation -------------
out=$(printf '%s' "$active" | "$GUARD" 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok "stop_hook_active → exit 0 (loop guard)" || bad "loop guard broken rc=$rc"

# --- 4. no jq: loop guard falls back to grep; gate still enforces -----------
rm "$bin/jq"
out=$(printf '%s' "$plain" | PATH="$bin" "$GUARD" 2>&1); rc=$?
[ "$rc" -eq 2 ] && ok "no jq: still enforces (exit 2 on violation)" || bad "no-jq enforcement lost rc=$rc"
out=$(printf '%s' "$active" | PATH="$bin" "$GUARD" 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok "no jq: loop guard grep fallback works" || bad "no-jq loop guard broken rc=$rc"
spaced='{ "stop_hook_active"  :  true }'
out=$(printf '%s' "$spaced" | PATH="$bin" "$GUARD" 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok "no jq: fallback tolerates JSON whitespace variants" || bad "no-jq fallback missed spaced JSON rc=$rc"
newlined=$(printf '{ "stop_hook_active"\n  : true }')
out=$(printf '%s' "$newlined" | PATH="$bin" "$GUARD" 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok "no jq: fallback tolerates newline between key and colon" || bad "no-jq fallback missed newlined JSON rc=$rc"
p=$(command -v jq) && ln -s "$p" "$bin/jq"

# --- 5. no node + doc implicated → loud block -------------------------------
rm "$bin/node"
out=$(printf '%s' "$plain" | PATH="$bin" "$GUARD" 2>&1); rc=$?
[ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q "node is not installed" && ok "no node: loud block, never a silent pass" || bad "no-node case rc=$rc"
p=$(command -v node) && ln -s "$p" "$bin/node"

# --- 6. no git → the one declared fail-open (warn + allow) ------------------
rm "$bin/git"
out=$(printf '%s' "$plain" | PATH="$bin" "$GUARD" 2>&1); rc=$?
[ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "git not found" && ok "no git: declared fail-open with warning" || bad "no-git case rc=$rc out='$out'"
p=$(command -v git) && ln -s "$p" "$bin/git"

# --- 7. dirty doc + conformant → pass ---------------------------------------
rm "$proj/doc/guides/bad.md"
printf '\nExtra body paragraph.\n' >> "$proj/doc/guides/how-to.md"
out=$(printf '%s' "$plain" | "$GUARD" 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok "dirty doc + conformant bundle → exit 0" || bad "conformant dirty doc blocked rc=$rc out='$(printf '%s' "$out" | tail -2)'"
git -C "$proj" checkout -q -- doc/guides/how-to.md

# --- 8. committed-mid-turn: clean tree, HEAD touched doc, violation ---------
echo "no frontmatter" > "$proj/doc/guides/bad.md"
git -C "$proj" add -A
git -C "$proj" -c user.email=t@t.t -c user.name=t commit -qm "bad doc committed" \
  || { echo "setup: mid-turn commit failed"; exit 1; }
[ -z "$(git -C "$proj" status --porcelain)" ] \
  || { echo "setup: tree not clean after commit — case would not exercise the committed path"; exit 1; }
out=$(printf '%s' "$plain" | "$GUARD" 2>&1); rc=$?
[ "$rc" -eq 2 ] && ok "clean tree but HEAD touched doc → still gated (exit 2)" || bad "committed-doc bypass rc=$rc"
git -C "$proj" reset -q --hard HEAD~1

# --- 9. non-doc dirty file only → silent pass -------------------------------
echo "more code" >> "$proj/src/app.txt"
out=$(printf '%s' "$plain" | "$GUARD" 2>&1); rc=$?
[ "$rc" -eq 0 ] && [ -z "$out" ] && ok "non-doc dirt only → exit 0 silent" || bad "non-doc dirt triggered gate rc=$rc"
git -C "$proj" checkout -q -- src/app.txt

# --- 10. gate-machinery changes are in scope (dirty config, clean docs) -----
sed -i 's/template: false/template: true/' "$proj/scripts/okf/okf.config.mjs"
out=$(printf '%s' "$plain" | "$GUARD" 2>&1); rc=$?
[ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q "template" \
  && ok "dirty gate config with clean docs → still gated (broken config caught)" \
  || bad "config change bypassed the guard rc=$rc"
git -C "$proj" checkout -q -- scripts/okf/okf.config.mjs

# --- 11. docs added in the repository's ROOT commit are in scope ------------
proj2="$tmp/proj2"
mkdir -p "$proj2/scripts/okf" "$proj2/doc/guides"
cp "$KIT/scripts/okf/"*.mjs "$proj2/scripts/okf/"
cp "$proj/scripts/okf/okf.config.mjs" "$proj2/scripts/okf/"
cp "$proj/doc/okf-conventions.md" "$proj2/doc/"
echo "no frontmatter" > "$proj2/doc/guides/bad.md"
git -C "$proj2" init -q
git -C "$proj2" add -A
git -C "$proj2" -c user.email=t@t.t -c user.name=t commit -qm "root commit with bad doc" \
  || { echo "setup: proj2 root commit failed"; exit 1; }
out=$(printf '%s' "$plain" | CLAUDE_PROJECT_DIR="$proj2" "$GUARD" 2>&1); rc=$?
[ "$rc" -eq 2 ] && ok "root-commit docs → still gated (diff-tree --root)" || bad "root-commit docs bypassed rc=$rc"

# --- 12. non-repo project dir → declared fail-open with warning -------------
norepo="$tmp/norepo"; mkdir -p "$norepo"
out=$(printf '%s' "$plain" | CLAUDE_PROJECT_DIR="$norepo" "$GUARD" 2>&1); rc=$?
[ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "not a git work tree" \
  && ok "non-repo dir: declared fail-open with warning" || bad "non-repo dir rc=$rc out='$out'"

echo "guard-behavior: $pass ok, $fail failed"
[ "$fail" -eq 0 ]

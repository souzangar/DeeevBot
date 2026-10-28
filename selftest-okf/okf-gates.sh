#!/usr/bin/env bash
# Regression guard for the four OKF gates + orchestrator, run against a
# scratch "installed" repo. Pins the fail-loud and safety contracts:
# template config fails; each violation class fails its gate; --fix repoints
# prose refs but never rewrites URLs; pins fail on missing/ambiguous;
# pre-existing files are refused without --adopt; reserved files are exempt;
# the orchestrator is chain-safe.
set -u
# Hermetic git (none of these fixtures use git, but keep the suite immune to
# any future git usage inheriting user/system config).
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
KIT=$(cd "$(dirname "$0")/.." && pwd)
pass=0; fail=0
ok()  { echo "  ok:   $1"; pass=$((pass+1)); }
bad() { echo "  FAIL: $1"; fail=$((fail+1)); }

tmp=$(mktemp -d "${TMPDIR:-/tmp}/okf-gates-XXXXXX") || exit 1
trap 'rm -rf "$tmp"' EXIT

proj="$tmp/proj"
mkdir -p "$proj/scripts/okf" "$proj/doc/guides"
cp "$KIT/scripts/okf/"*.mjs "$proj/scripts/okf/"
# Post-install the kit's own config has `template: false` (INSTALL step 3), so
# cases 1/1b would go red on a configured kit. They pin the SHIPPED contract:
# force the scratch copy back to the template state (a no-op on a pristine kit;
# GNU sed -i is already assumed by guard-behavior.sh).
sed -i -E 's/^(\s*template:\s*)false/\1true/' "$proj/scripts/okf/okf.config.mjs"
cd "$proj" || exit 1
MARKER=$(grep -o '<!-- generated-by:.*-->' scripts/okf/build-index.mjs | head -1)

# --- 1. template config refuses to run -------------------------------------
node scripts/okf/check.mjs >"$tmp/o" 2>&1
if [ $? -ne 0 ] && grep -q "template" "$tmp/o"; then
  ok "template config → gate fails with guidance"
else bad "template config was accepted"; fi

# --- 1b. template flag must be EXPLICITLY false — removing the line refuses -
grep -v 'template: true' scripts/okf/okf.config.mjs > "$tmp/noflag.mjs" && cp "$tmp/noflag.mjs" scripts/okf/okf.config.mjs
node scripts/okf/check.mjs >"$tmp/o" 2>&1
if [ $? -ne 0 ] && grep -q "EXPLICITLY" "$tmp/o"; then
  ok "missing template flag → gate still refuses"
else bad "deleted template line armed the gate"; fi

write_config() { # $1 = rulesAndInvariants JS array literal, $2 = readmeStub enabled (default true)
  cat > scripts/okf/okf.config.mjs <<EOF
export default {
  template: false,
  okfVersion: '0.1',
  docRoot: 'doc',
  skipDirs: [],
  reservedFiles: ['index.md', 'log.md'],
  conventionsFile: 'okf-conventions.md',
  bundleTitle: 'Test Bundle',
  readmeStub: { enabled: ${2:-true}, title: 'Test Docs', description: 'Start at index.md.' },
  refExtensions: ['md', 'json'],
  assetExcludeExts: ['.png'],
  activeStatus: 'active',
  folders: { guides: 'How-tos.', reference: 'Lookup.' },
  rulesAndInvariants: ${1},
};
EOF
}
write_config "[]"

cat > doc/okf-conventions.md <<'EOF'
---
type: reference
title: "Conventions"
description: "Fixture conventions doc."
---
# Conventions
EOF

cat > doc/guides/how-to.md <<'EOF'
---
type: guide
title: "How To"
description: "A fixture guide."
status: active
---

# How To

Body.
EOF

# --- 2. green path ----------------------------------------------------------
node scripts/okf/build-index.mjs >"$tmp/o" 2>&1 && node scripts/okf/check.mjs >"$tmp/o2" 2>&1 \
  && ok "configured bundle: build + full gate green" \
  || { bad "green path failed: $(tail -3 "$tmp/o" "$tmp/o2" 2>/dev/null | tr '\n' ' ')"; }

# --- 3. missing frontmatter fails validate ---------------------------------
echo "no frontmatter here" > doc/guides/bad.md
node scripts/okf/validate.mjs >"$tmp/o" 2>&1
[ $? -ne 0 ] && grep -q "frontmatter" "$tmp/o" && ok "missing frontmatter → validate fails" || bad "frontmatter violation passed"
rm doc/guides/bad.md

# --- 3b. semantically empty `type` values fail validate ----------------------
for t in '""' '~' 'NULL' '"" # looks set' '!!null null' '|-' '[]'; do
  printf -- '---\ntype: %s\ntitle: "X"\n---\n# X\n' "$t" > doc/guides/empty-type.md
  node scripts/okf/validate.mjs >"$tmp/o" 2>&1
  [ $? -ne 0 ] && grep -q "empty" "$tmp/o" && ok "type: $t → validate fails" || bad "type: $t passed validate"
done
rm doc/guides/empty-type.md

# --- 3c. configured conventions doc is enforced -----------------------------
mv doc/okf-conventions.md "$tmp/conv-away.md"
node scripts/okf/validate.mjs >"$tmp/o" 2>&1
[ $? -ne 0 ] && grep -q "conventionsFile" "$tmp/o" && ok "missing configured conventions doc → validate fails" || bad "missing conventions doc passed"
mv "$tmp/conv-away.md" doc/okf-conventions.md

# --- 4. broken link fails check-links --------------------------------------
cat > doc/guides/linky.md <<'EOF'
---
type: guide
title: "Linky"
description: "Has a broken link."
---
# Linky
See [gone](./nope.md).
EOF
node scripts/okf/check-links.mjs >"$tmp/o" 2>&1
[ $? -ne 0 ] && grep -q "nope.md" "$tmp/o" && ok "broken link → check-links fails" || bad "broken link passed"
rm doc/guides/linky.md

cat > doc/guides/reflink.md <<'EOF'
---
type: guide
title: "Reflink"
description: "Broken reference-style link."
---
# Reflink
See [the ref][r].

[r]: ./nope2.md
EOF
node scripts/okf/check-links.mjs >"$tmp/o" 2>&1
[ $? -ne 0 ] && grep -q "nope2.md" "$tmp/o" && ok "broken reference-style link → check-links fails" || bad "reference-style link passed"
rm doc/guides/reflink.md

cat > doc/guides/refuse.md <<'EOF'
---
type: guide
title: "Refuse"
description: "Reference usage without a definition."
---
# Refuse
See [the guide][missing].
EOF
node scripts/okf/check-links.mjs >"$tmp/o" 2>&1
[ $? -ne 0 ] && grep -q "never defined" "$tmp/o" && ok "reference usage without definition → check-links fails" || bad "undefined reference usage passed"
rm doc/guides/refuse.md

cat > doc/guides/angle.md <<'EOF'
---
type: guide
title: "Angle"
description: "Angle-bracket destination and code-fence examples."
---
# Angle
See [the target][t].

[t]: <./angle.md>

Example (must NOT be treated as a live reference):

```
See [example][not-a-real-ref] and [gone](./nope3.md).
```
EOF
node scripts/okf/check-links.mjs >"$tmp/o" 2>&1 \
  && ok "angle-bracket target resolves; fenced-code examples ignored" \
  || bad "angle/fence handling broken: $(tail -2 "$tmp/o" | tr '\n' ' ')"
rm doc/guides/angle.md

# --- 5. stale prose ref fails; --fix repoints but never touches URLs --------
mkdir -p doc/reference
cat > doc/reference/target.md <<'EOF'
---
type: reference
title: "Target"
description: "Moved here."
---
# Target
EOF
cat > doc/guides/mentions.md <<'EOF'
---
type: guide
title: "Mentions"
description: "Mentions a moved file and a URL."
---
# Mentions
See `doc/old/target.md` for details.
External: https://example.com/doc/old/target.md stays untouched.
EOF
node scripts/okf/check-refs.mjs >"$tmp/o" 2>&1
[ $? -ne 0 ] && grep -q "doc/old/target.md" "$tmp/o" && ok "stale prose ref → check-refs fails" || bad "stale ref passed"
node scripts/okf/check-refs.mjs --fix >"$tmp/o" 2>&1
grep -q '`doc/reference/target.md`' doc/guides/mentions.md \
  && ok "--fix repointed the prose ref" || bad "--fix did not repoint"
grep -q "https://example.com/doc/old/target.md" doc/guides/mentions.md \
  && ok "--fix left the URL untouched" || bad "--fix corrupted a URL"
node scripts/okf/check-refs.mjs >"$tmp/o" 2>&1 && ok "refs green after --fix" || bad "refs still stale after --fix"

# --- 5b. URL query strings and mailto bodies are never flagged or rewritten -
cat > doc/guides/url-edge.md <<'EOF'
---
type: guide
title: "URL Edge"
description: "Stale-looking paths inside URLs must be left alone."
---
# URL Edge
Query: https://example.com/?next=doc/old/target.md
Mail: mailto:team@example.com?body=doc/old/target.md
Root-relative: /redirect?next=doc/old/target.md
Scheme-relative: //example.com/?next=doc/old/target.md
Parenthesized: https://example.com/?next=(doc/old/target.md)
Relative parenthesized: /redirect?next=(doc/old/target.md)
Scheme-relative parenthesized: //host/?next=(doc/old/target.md)
EOF
node scripts/okf/check-refs.mjs >"$tmp/o" 2>&1 && ok "paths inside URL query/mailto → not flagged" || bad "URL-embedded path flagged: $(tail -2 "$tmp/o" | tr '\n' ' ')"
cp doc/guides/url-edge.md "$tmp/url-edge.before"
node scripts/okf/check-refs.mjs --fix >"$tmp/o" 2>&1
cmp -s doc/guides/url-edge.md "$tmp/url-edge.before" && ok "--fix left URL-embedded paths untouched" || bad "--fix rewrote inside a URL"
rm doc/guides/url-edge.md

# --- 6. unknown basename = planned/external, ignored ------------------------
cat >> doc/guides/mentions.md <<'EOF'
Planned: doc/planned/future-thing.md (does not exist anywhere).
EOF
node scripts/okf/check-refs.mjs >"$tmp/o" 2>&1 && ok "unknown basename ignored (planned/external)" || bad "unknown basename flagged"

# --- 7. stale index fails --check; rebuild recovers -------------------------
node scripts/okf/build-index.mjs >"$tmp/o" 2>&1
node scripts/okf/check.mjs >"$tmp/o" 2>&1 || bad "expected green before staleness case: $(tail -2 "$tmp/o" | tr '\n' ' ')"
cat > doc/guides/new-doc.md <<'EOF'
---
type: guide
title: "New Doc"
description: "Freshly added."
---
# New Doc
EOF
node scripts/okf/build-index.mjs --check >"$tmp/o" 2>&1
[ $? -ne 0 ] && grep -q "STALE" "$tmp/o" && ok "new doc without rebuild → index stale" || bad "stale index passed --check"
node scripts/okf/build-index.mjs >"$tmp/o" 2>&1 && node scripts/okf/build-index.mjs --check >"$tmp/o" 2>&1 \
  && ok "rebuild recovers to green" || bad "rebuild did not recover"

# --- 8. orphan index detected AND removed by a build (convergence) ----------
mkdir -p doc/empty
printf '%s\n\n# empty/\n' "$MARKER" > doc/empty/index.md
node scripts/okf/build-index.mjs --check >"$tmp/o" 2>&1
[ $? -ne 0 ] && grep -q "orphan" "$tmp/o" && ok "orphan index → --check fails" || bad "orphan index passed"
node scripts/okf/build-index.mjs >"$tmp/o" 2>&1
[ ! -e doc/empty/index.md ] && node scripts/okf/build-index.mjs --check >"$tmp/o" 2>&1 \
  && ok "build removes the orphan; check converges to green" || bad "orphan not removed by build"
rmdir doc/empty

# --- 8b. disabling the README stub removes the generated README --------------
write_config "[]" false
node scripts/okf/build-index.mjs >"$tmp/o" 2>&1
[ ! -e doc/README.md ] && ok "readmeStub disabled → generated README removed" || bad "generated README left behind"
write_config "[]" true
node scripts/okf/build-index.mjs >"$tmp/o" 2>&1

# --- 8c. an index under a NEWLY skipped dir is still found and removed -------
mkdir -p doc/oldstuff
printf '%s\n\n# oldstuff/\n' "$MARKER" > doc/oldstuff/index.md
cat > scripts/okf/okf.config.mjs <<'EOF'
export default {
  template: false, okfVersion: '0.1', docRoot: 'doc', skipDirs: ['oldstuff'],
  reservedFiles: ['index.md', 'log.md'], conventionsFile: 'okf-conventions.md',
  bundleTitle: 'Test Bundle',
  readmeStub: { enabled: true, title: 'Test Docs', description: 'Start at index.md.' },
  refExtensions: ['md', 'json'], assetExcludeExts: ['.png'], activeStatus: 'active',
  folders: { guides: 'How-tos.', reference: 'Lookup.' },
  rulesAndInvariants: [],
};
EOF
node scripts/okf/build-index.mjs >"$tmp/o" 2>&1
[ ! -e doc/oldstuff/index.md ] && ok "orphan under newly skipped dir removed" || bad "skipped-dir orphan survived"
rmdir doc/oldstuff
write_config "[]"
node scripts/okf/build-index.mjs >"$tmp/o" 2>&1

# --- 8d. conventionsFile '' → no bogus empty link, gate still green ----------
cat > scripts/okf/okf.config.mjs <<'EOF'
export default {
  template: false, okfVersion: '0.1', docRoot: 'doc', skipDirs: [],
  reservedFiles: ['index.md', 'log.md'], conventionsFile: '',
  bundleTitle: 'Test Bundle',
  readmeStub: { enabled: true, title: 'Test Docs', description: 'Start at index.md.' },
  refExtensions: ['md', 'json'], assetExcludeExts: ['.png'], activeStatus: 'active',
  folders: { guides: 'How-tos.', reference: 'Lookup.' },
  rulesAndInvariants: [],
};
EOF
node scripts/okf/build-index.mjs >"$tmp/o" 2>&1
if grep -q '\[\](\./)'  doc/index.md; then bad "empty conventions link emitted"; else ok "conventionsFile '' → no bogus link"; fi
node scripts/okf/check.mjs >"$tmp/o" 2>&1 && ok "conventionsFile '' → full gate green" || bad "no-conventions mode red: $(tail -2 "$tmp/o" | tr '\n' ' ')"
write_config "[]"
node scripts/okf/build-index.mjs >"$tmp/o" 2>&1

# --- 9. pinned rules: path works; missing and ambiguous fail -----------------
write_config "['guides/how-to.md']"
node scripts/okf/build-index.mjs >"$tmp/o" 2>&1 \
  && grep -q "Rules & Invariants" doc/index.md && grep -q "guides/how-to.md" doc/index.md \
  && ok "path-pinned rule lands in the root index" || bad "path pin failed: $(tail -2 "$tmp/o" | tr '\n' ' ')"
write_config "['nope.md']"
node scripts/okf/build-index.mjs >"$tmp/o" 2>&1
[ $? -ne 0 ] && grep -q "not found" "$tmp/o" && ok "missing pin → build fails" || bad "missing pin passed"
cat > doc/reference/how-to.md <<'EOF'
---
type: reference
title: "Other How To"
description: "Same basename, different folder."
---
# Other
EOF
write_config "['how-to.md']"
node scripts/okf/build-index.mjs >"$tmp/o" 2>&1
[ $? -ne 0 ] && grep -q "ambiguous" "$tmp/o" && ok "ambiguous basename pin → build fails" || bad "ambiguous pin passed"
rm doc/reference/how-to.md
write_config "['../escape.md']"
node scripts/okf/build-index.mjs >"$tmp/o" 2>&1
[ $? -ne 0 ] && grep -q "not a concept doc" "$tmp/o" && ok "traversal pin (../) → build fails" || bad "traversal pin escaped the bundle"
write_config "['guides/log.md']"
printf 'free-form\n' > doc/guides/log.md
node scripts/okf/build-index.mjs >"$tmp/o" 2>&1
[ $? -ne 0 ] && grep -q "not a concept doc" "$tmp/o" && ok "reserved-file pin → build fails" || bad "reserved-file pin accepted"
rm doc/guides/log.md
write_config "[]"
node scripts/okf/build-index.mjs >"$tmp/o" 2>&1 || bad "cleanup rebuild failed"

# --- 9b. root-index domain order follows the config, not the alphabet --------
cat > scripts/okf/okf.config.mjs <<'EOF'
export default {
  template: false, okfVersion: '0.1', docRoot: 'doc', skipDirs: [],
  reservedFiles: ['index.md', 'log.md'], conventionsFile: 'okf-conventions.md',
  bundleTitle: 'Test Bundle',
  readmeStub: { enabled: true, title: 'Test Docs', description: 'Start at index.md.' },
  refExtensions: ['md', 'json'], assetExcludeExts: ['.png'], activeStatus: 'active',
  folders: { reference: 'Lookup.', guides: 'How-tos.' },
  rulesAndInvariants: [],
};
EOF
node scripts/okf/build-index.mjs >"$tmp/o" 2>&1
first=$(grep -oE '^- \[[a-z]+/' doc/index.md | head -1)
[ "$first" = "- [reference/" ] && ok "domain order follows config insertion order" || bad "domain order ignored config (first: $first)"
write_config "[]"
node scripts/okf/build-index.mjs >"$tmp/o" 2>&1

# --- 10. pre-existing files are refused without --adopt ----------------------
printf '# Hand-written README\n' > doc/README.md
node scripts/okf/build-index.mjs >"$tmp/o" 2>&1
[ $? -ne 0 ] && grep -q "REFUSING" "$tmp/o" && ok "unmarked pre-existing file → build refuses" || bad "pre-existing file clobbered silently"
node scripts/okf/build-index.mjs --adopt >"$tmp/o" 2>&1 \
  && grep -q "generated-by" doc/README.md \
  && ok "--adopt takes ownership (marker present)" || bad "--adopt failed"

# --- 11. reserved files are exempt from frontmatter --------------------------
printf 'free-form log, no frontmatter\n' > doc/guides/log.md
node scripts/okf/validate.mjs >"$tmp/o" 2>&1 && ok "reserved log.md without frontmatter passes validate" || bad "reserved file flagged"
rm doc/guides/log.md

# --- 12. orchestrator is chain-safe ------------------------------------------
echo "no frontmatter" > doc/guides/bad.md
sh -c 'true && node scripts/okf/check.mjs' >"$tmp/o" 2>&1
[ $? -ne 0 ] && ok "check.mjs propagates failure through a && chain" || bad "chained check.mjs swallowed the failure"
rm doc/guides/bad.md
node scripts/okf/check.mjs >"$tmp/o" 2>&1 && ok "final state green" || bad "final state not green: $(tail -3 "$tmp/o" | tr '\n' ' ')"

echo "okf-gates: $pass ok, $fail failed"
[ "$fail" -eq 0 ]

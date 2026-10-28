# INSTALL — claude-okf-kit

Target: a repository (any stack) that will keep its docs as an OKF bundle.
Prerequisites: **git**, **node ≥ 18**, and — for the Stop hook — a Claude
Code setup (jq recommended; the hook degrades to a grep fallback without
it). The core `claude-project-kit` is recommended but not required.

## 1. Copy the files

```bash
cp -r kit/scripts            <repo>/            # scripts/okf/*
mkdir -p <repo>/.claude/hooks <repo>/.claude/agents <repo>/.claude/kit-docs/okf
cp    kit/.claude/hooks/okf-guard.sh   <repo>/.claude/hooks/
cp    kit/.claude/agents/doc-scribe.md <repo>/.claude/agents/
cp    kit/README.md kit/INSTALL.md     <repo>/.claude/kit-docs/okf/
cp -r kit/selftest                     <repo>/selftest-okf   # must live at the repo root
```

Verify executable bits survived: `find <repo>/.claude/hooks <repo>/selftest-okf
-name '*.sh' ! -perm -u+x` must print nothing (zip transfer can drop modes —
`chmod +x` them if it does), and **run the extracted hook once directly**
(`printf '{}' | .claude/hooks/okf-guard.sh; echo $?` → `0`) so you know
Claude Code can execute it.

## 2. Create the bundle

```bash
mkdir -p <repo>/doc                                  # or your docRoot
cp kit/doc-starter/okf-conventions.md <repo>/doc/    # then EDIT-ME its vocabulary
```

## 3. Configure the manifest

Edit `scripts/okf/okf.config.mjs`: docRoot, folders map, titles, pinned
rules — then set **`template: false`**. Every gate fails loudly until you
do; an unconfigured docs gate must never pass green.

## 4. First index build (adoption)

```bash
cd <repo>
node scripts/okf/build-index.mjs          # refuses pre-existing index/README files
node scripts/okf/build-index.mjs --adopt  # ONLY if it refused and you reviewed the list
node scripts/okf/check.mjs                # the full gate — must end green
```

The refusal is deliberate: hand-written `index.md`/`README.md` files in an
adopting repo are replaced by generated listings only after you explicitly
say so. Commit the generated files — they are part of the tree, and the
`--check` gate keeps them honest.

## 5. Wire enforcement (pick at least one; CI is the authority)

- **Stop hook** (Claude Code): merge `settings-stop-hook.snippet.json` into
  the repo's `.claude/settings.json` — append to any existing `Stop` array,
  never replace the file. If your docRoot isn't `doc`, update `DOC_ROOT` in
  `okf-guard.sh` (kept in sync with the config by hand — the hook can't
  import mjs).
- **Commit gate** (core kit): APPEND to `INVARIANT_CMD` in
  `.claude/hooks/pre-commit-check.sh`:
  `INVARIANT_CMD="<whatever is already there> && node scripts/okf/check.mjs"`
  (if the slot was empty: just `"node scripts/okf/check.mjs"`).
- **CI**: add a `node scripts/okf/check.mjs` step. Hooks are best-effort;
  this is the gate that cannot be slipped.
- **Permissions** (Claude Code): have the HUMAN add
  `Bash(node scripts/okf/*.mjs)` and `Bash(bash selftest-okf/*.sh)` to the
  `permissions.allow` list in `.claude/settings.local.json` — a Claude
  session is refused when it writes its own permission file, so this step
  is yours, not the session's.

Optional npm convenience (npm projects only):

```json
"okf:check": "node scripts/okf/check.mjs",
"okf:build-index": "node scripts/okf/build-index.mjs"
```

## 6. Verify

```bash
bash selftest-okf/run-all.sh   # the kit's own contracts, on this machine
node scripts/okf/check.mjs     # your bundle, green
```

Then in a Claude session: edit any doc and end the turn — the Stop hook
should run the gate (first firing may need one-time hook approval; check
`/hooks` if it seems silent). Ask the **doc-scribe** agent for a trivial doc
update to confirm it reads your conventions.

## Go-live checklist

- [ ] `okf.config.mjs` configured, `template: false`
- [ ] Conventions doc in the bundle root, vocabulary edited
- [ ] First build done; pre-existing files reviewed/adopted; generated files
      committed
- [ ] At least one enforcement wired — and CI running the gate (authority)
- [ ] `selftest-okf/run-all.sh` green on the destination machine
- [ ] Stop hook fired once for real (or consciously not installed)
- [ ] doc-scribe answers with your conventions, not "unconfigured"

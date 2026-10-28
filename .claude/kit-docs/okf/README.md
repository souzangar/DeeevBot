# claude-okf-kit

Optional **docs-bundle overlay** for the `claude-project-kit` core: an
Open Knowledge Format (OKF) documentation system with generated indexes and
a blocking conformance gate, extracted from a production backend and
genericized. Works standalone too — the core kit is recommended, not
required.

What you get: every concept doc lives in a domain folder with YAML
frontmatter; `index.md` files and the bundle `README.md` are **generated**;
a four-part gate (frontmatter → links → prose refs → index staleness) runs
npm-free on a bare `node`, wired as a Claude Code Stop hook, a commit-gate
step, and/or CI.

**Requires Node ≥ 18** (the gates are `.mjs` scripts). This is inherent to
the overlay and is exactly why it is NOT part of the runtime-free core kit.

## Inventory

| Piece | Path | What it is |
|---|---|---|
| Project manifest | `scripts/okf/okf.config.mjs` | THE EDIT-ME config: doc root, folders, pinned rules, titles. Ships as a template that makes every gate **fail loudly** until configured (`template: false`) |
| Frontmatter gate | `scripts/okf/validate.mjs` | Every concept doc has frontmatter with a non-empty `type`; reserved files exempt |
| Link gate | `scripts/okf/check-links.mjs` | Relative + bundle-root markdown links resolve |
| Prose-ref gate | `scripts/okf/check-refs.mjs` | `doc/<path>` prose mentions resolve; `--fix` repoints moved files; URL-safe (never matches or rewrites inside URLs) |
| Index generator + gate | `scripts/okf/build-index.mjs` | Generated per-folder indexes, root index with pinned Rules & Invariants, README stub; `--check` staleness gate; **marker + `--adopt`** so pre-existing hand-written files are refused, never clobbered; missing/ambiguous pins fail the build |
| Orchestrator | `scripts/okf/check.mjs` | The one gate entrypoint (`node scripts/okf/check.mjs`), fail-fast, chain-safe |
| Stop hook | `.claude/hooks/okf-guard.sh` | Blocks ending a turn while the bundle is implicated and nonconformant; honest trigger (bundle/gate-machinery dirty OR touched by latest commit); fail-loud without node, heuristic grep fallback without jq; exactly three declared fail-opens (no git, unreachable project dir, not a work tree — each warns) and git errors inside a work tree fail CLOSED |
| Settings snippet | `settings-stop-hook.snippet.json` | The Stop block to MERGE into `.claude/settings.json` (quoted path; never replace the core kit's file) |
| doc-scribe agent | `.claude/agents/doc-scribe.md` | Writes/updates docs to conventions, regenerates indexes, leaves the gate green; reports "unconfigured" instead of inventing conventions |
| Conventions starter | `doc-starter/okf-conventions.md` | House-profile skeleton: frontmatter fields, neutral EDIT-ME type vocabulary, naming, lifecycle |
| Self-tests | `selftest/` | Pins the fail-loud/safety contracts: template-config refusal, every violation class, URL-safe `--fix`, pin resolution, `--adopt` refusal, guard trigger + dependency matrix |

## Composition with the core kit

- **Stop hook**: merge the snippet into the existing `.claude/settings.json`.
- **Commit gate**: APPEND to the core gate's `INVARIANT_CMD` — never replace
  what's already there:
  `INVARIANT_CMD="<existing> && node scripts/okf/check.mjs"`.
- **CI**: run `node scripts/okf/check.mjs` as a pipeline step. Hooks are
  best-effort convenience (same doctrine as the core kit); **CI is the
  authority**. Pick at least one enforcement point — installing the overlay
  with none is decoration.

## What was deliberately left behind (patterns, not files)

- **Data-dictionary generation** (one doc per DB collection, generated from
  the ORM schemas) — inherently stack-specific; if your stack has schema
  objects, a generator that emits OKF docs from them is a high-value
  addition. Wire it before `build-index` in your docs pipeline.
- **HTML site builder** — the source repo renders the bundle plus a link
  graph to a static site; nice-to-have, heavy, style-specific.
- **Client-contract changelog** — a strict, self-contained, newest-on-top
  dated changelog for frontend consumers, updated in the same commit as any
  contract change. Strongly recommended once you have API consumers; it's a
  convention plus one file, no tooling needed.
- **Migration tools** (bulk move/rename, timestamp backfill) — one-time
  scripts, not part of a steady-state kit.

## Honesty notes

- The Stop hook's trigger is an approximation: "bundle, gate scripts, or
  the hook itself dirty at stop — or touched by the latest commit" — not
  literally "changed this turn". A pre-existing dirty bundle (someone
  else's edits) fires it; that is by design (the bundle IS nonconformant)
  but can surprise.
- The link gate validates FILE existence (inline and reference-style
  links); `#anchor` fragments are not checked against headings —
  slugification is renderer-specific, so anchor validation is declared out
  of scope.
- A configured `conventionsFile` is enforced by the gate (missing → red);
  set it to `''` if the project genuinely wants no conventions doc — the
  doc-scribe agent will then treat conventions as unconfigured.
- `check-refs` treats mentions whose basename exists nowhere as
  planned/external docs and ignores them — it verifies resolvable mentions
  point at the right path, not that every mention resolves.
- The generator owns only files carrying its marker; everything else
  requires an explicit `--adopt`.

## Upstream sync

- **Checked 2026-10-28** against the source repo (finowin-backend
  fc8ab1a4): the only change to the mirrored gate scripts since this kit
  was cut is centralizing the skip-dirs set into a shared manifest export —
  this kit has been config-driven there from day one (`okf.config.mjs`
  `skipDirs`), so the gates are at parity and nothing was ported. Two
  upstream patterns were considered and left behind: a **governance-mode
  switch** (a repo-local `strict`/`easy` marker the Stop hook reads, so a
  team can suspend the stop-time gate while CI still warns — worth copying
  if your team wants process rigor to be switchable) and **verbatim vendor
  doc snapshots** as a git-tracked non-bundle directory (source-repo
  policy, not OKF machinery). The source repo's data-dictionary generator
  quirks don't apply here (generation was left behind by design, above).
- **Field report folded 2026-10-28** (first real install, a Telegram-bot
  repo): the gate selftest pinned the SHIPPED `template: true` refusal
  against the INSTALLED config, so cases 1/1b went red right after
  INSTALL's own configure step — the suite now forces its scratch copy
  back to the template state and passes 42/42 both pristine and
  configured. INSTALL §5 also gained the permission lines a Claude session
  cannot add for itself (`settings.local.json` is human-edited).

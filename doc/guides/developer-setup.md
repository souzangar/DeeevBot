---
type: guide
title: "Developer setup"
description: "Working on the div-report code: prerequisites and install, the npm scripts and stack-independent checks, the commit gate, the three test tiers, lint and TypeScript settings, configuration and local secrets, wrangler, critical paths and the tripwire, and the toolchain's known issues as of 2026-10-28."
status: active
tags: [guide, development, toolchain, testing, cloudflare]
timestamp: 2026-10-28T00:00:00Z
---

# Developer setup

For whoever works on the code; facts as of 2026-10-28. Phase 2 scaffolded the
toolchain, and Phase 3 is adding the application modules: so far the core
(`src/errors/`, `src/config/`, the redacting logger and the reporter reference
in `src/privacy/`, `src/i18n/` and `src/clock.ts`) and the storage (`src/db/`:
the SQL port with its D1 and node:sqlite adapters, the Node migrations runner
and the random ids; `migrations/0001_init.sql`, D1 being the only store), with
no Telegram wiring yet, so the Worker entry is still empty. The decisions: the
stack in [ADR 0002](../architecture/adr-0002-language-and-framework.md),
storage in [ADR 0004](../architecture/adr-0004-storage-and-delivery-ledger.md),
errors in [ADR 0005](../architecture/adr-0005-error-handling-convention.md),
the module map in
[ADR 0006](../architecture/adr-0006-data-model-and-module-layout.md), the
rules in [Critical invariants](../architecture/critical-invariants.md).
Deployment, the secret store and who holds each value belong to the
[operations and security runbook](./operations-and-security.md).

## 1. Prerequisites and install

- Node 22.13.0 or later (`engines` in `package.json`; 22.13 is eslint 10's
  floor on the 22 line). Development so far has used Node v22.22.3 through
  nvm, with npm 12.0.1; the repository has no `.nvmrc`.
- git, bash and jq: the kit selftests refuse to run without git and jq, the
  commit gate is skipped without jq (it says so), and the tripwire is inert.
- `npm ci` installs exactly what the committed `package-lock.json` records;
  `npm install` is for changing a dependency. Every version in `package.json`
  is pinned exactly; ADR 0002 records the stack and the TypeScript pin that
  constrains upgrades.

npm 12 blocks dependency install scripts by default (its `allow-scripts`
setting), so an install on Linux warns that two `postinstall` scripts were
blocked: esbuild 0.28.2's and workerd 1.20261023.1's, one copy of each (the
lockfile's only other install script is the macOS-only fsevents). That is
expected and harmless: both binaries resolve through their platform packages
(`@esbuild/linux-x64` and `@cloudflare/workerd-linux-64` on Linux x64),
`npx esbuild --version` and `npx workerd --version` both run, and nothing
needs the scripts approved. Nothing else warns on install.

## 2. Commands

| Command | What it does |
|---|---|
| `npm run typecheck` | `tsc --noEmit` over `src/`, `test/` and `vitest.config.ts`; emits nothing |
| `npm run lint` | `eslint .`, with type information (section 5) |
| `npm run build` | typecheck, then lint: the commit gate's build step |
| `npm test` | `vitest run --project unit --project workers`: the commit gate's test step |
| `npm run test:unit` | the unit project only |
| `npm run test:workers` | the workers project only |
| `npm run test:invariants` | the invariants project: the commit gate's last command; it fails when it finds no spec, so an empty or mis-globbed invariants tier cannot pass silently |
| `npm run dev` | `wrangler dev`: the Worker on a local server, with the variables from `.dev.vars` (section 6); until Phase 3 it answers every request with 404 |
| `npm run dry-run` | `wrangler deploy --dry-run --outdir .wrangler/dry-run`: bundles the Worker and lists its bindings (section 7) |
| `npm run migrate:local` | `wrangler d1 migrations apply div-report --local`: applies `migrations/` to the local D1 database |
| `bash selftest/run-all.sh` | stack-independent, like the rows below: the kit's tooling pins (devil.sh, the hooks, the statusline, the critical-globs completeness check, the tripwire patterns) |
| `bash selftest-okf/run-all.sh` | the OKF docs-gate contracts |
| `node scripts/okf/check.mjs` | the docs gate: frontmatter, links, prose references, index staleness |
| `node scripts/okf/build-index.mjs` | regenerates the doc indexes after a doc is added, moved or retitled |
| `.claude/hooks/rules-sync-check.sh` | the catastrophic-rules drift gate: the three copies of the invariants block must match |
| `.claude/hooks/secret-shape-scan.sh` | fails on a secret-shaped string in any tracked file, or in any untracked file git does not ignore |

## 3. The commit gate

`.claude/hooks/pre-commit-check.sh`, a Claude Code `PreToolUse` hook on Bash
(wired in `.claude/settings.json`), gates the `git commit` commands Claude
Code runs; a commit typed in a terminal runs no hook (there is no git hook and
no CI yet), so run the same steps by hand first. All three steps run, even
after one of them fails:

1. build: `npm run build` (`tsc --noEmit`, then `eslint .`);
2. tests: `npm test` (the unit and workers projects);
3. invariants, a chain that stops at its first failure: the catastrophic-rules
   drift gate (`.claude/hooks/rules-sync-check.sh`), the secret-shape scan
   (`.claude/hooks/secret-shape-scan.sh`), the kit selftests
   (`bash selftest/run-all.sh`, with the critical-globs completeness and
   tripwire-pattern checks of section 8), the OKF selftests
   (`bash selftest-okf/run-all.sh`), the OKF docs gate
   (`node scripts/okf/check.mjs`), then `npm run test:invariants`.

A failure blocks the commit with a short summary (the failing steps, up to 12
key error lines) naming the full log,
`${TMPDIR:-/tmp}/claude-precommit-gate-<repo>-<checksum>.log`: read it, do not
re-run the gate. The gate checks the working tree, not the staged snapshot, so
commit with the tree equal to the index (for example, `git add -A` right
before). `SKIP_COMMIT_GATE=1`, prefixed to the commit command or exported, is
the documented intentional bypass.

## 4. Tests

| Tier | Files | Runs in | Rules |
|---|---|---|---|
| unit | `src/**/*.test.ts`, beside the module | plain node | no network; mock at the boundary (the Telegram API, storage, the clock) |
| workers | `test/workers/**/*.test.ts` | the Workers runtime through `@cloudflare/vitest-plugin`, with the local D1 binding from `wrangler.jsonc`; no Cloudflare account | for the Cloudflare adapters; pure logic stays in unit |
| invariants | `test/invariants/**/*.test.ts` | plain node | always run by the commit gate; one spec per stated "must not" |

The three Vitest projects are defined in `vitest.config.ts`. The unit tier
holds the tests beside each module under `src/`, every SQL-level one on the
node:sqlite adapter. The workers tier holds `test/workers/smoke.test.ts`
(boots the Worker, expects 404), `test/workers/d1.test.ts` (applies
`migrations/` to the local D1 with `applyD1Migrations`, from the
`TEST_MIGRATIONS` binding `vitest.config.ts` reads, checks that D1 builds the
same tables as node:sqlite, and drives the D1 adapter). The invariants tier
holds
`test/invariants/config-redaction.test.ts` and
`test/invariants/logger-redaction.test.ts` (critical invariant 6: the
configuration is unprintable, and no secret, report data or Telegram id
reaches a log line), `test/invariants/approval-record.test.ts` (rule 1: the
approval record and the due query) and `test/invariants/storage-retention.test.ts`
(rule 8: no member or reporter identity in the schema, every column with a
classified fate named in the deletion schedule). In-memory fakes of the ports
live under `test/fakes/` (the clock; the logger, which is the real redacting
logger over a recording sink), and shared test code under `test/support/`: the
schema describer and the expected D1 schema both tiers check.
The duties, from CLAUDE.md's testing conventions:

- every new logic file (service, repository, handler, util) gets a unit test,
  and every stated "must not" a regression test in the same change; refactor
  to make it testable rather than skip it;
- tests are run, not just written: a claimed pass is an observed pass;
- fixture values are never secret-shaped, because the secret-shape scan reads
  test files too (the fixtures use values like `unit-test-bot-token`);
- there is no coverage gate yet.

## 5. Lint and TypeScript settings

`eslint.config.js` applies typescript-eslint's `recommendedTypeChecked` to
every `.ts` file, with type information from `tsconfig.json`, and adds:

- `no-console` as an error: nothing is logged except through the redacting
  logger, `src/privacy/logger.ts` (critical invariant 6), the one file whose
  override admits `console.log` and `console.error`;
  `test/invariants/logger-redaction.test.ts` fails if any other file under
  `src/` (tests aside) refers to the console;
- `@typescript-eslint/no-floating-promises` as an error, and `eqeqeq`;
- in `src/` outside `src/**/*.test.ts`, `no-restricted-imports` on `node:fs`,
  `node:fs/promises`, `fs`, `fs/promises`, `node:child_process` and
  `child_process`: the Workers runtime has no file system or processes, while
  unit tests run under node and never reach the bundle. One override lifts the
  file-system part for the Node port's own files, `src/node.ts`,
  `src/db/node-*.ts` and `src/db/migrate.ts` (the migrations runner reads
  `migrations/*.sql`); the Worker never imports them, and child processes stay
  forbidden there too.

The kit's tooling (`.claude/`, `scripts/okf/`, `selftest/`, `selftest-okf/`)
and generated output (`node_modules/`, `dist/`, `coverage/`, `.wrangler/`) are
not linted.

`tsconfig.json` sets `strict` plus `noUncheckedIndexedAccess` (an indexed
read is `T | undefined`), `exactOptionalPropertyTypes` (an optional property
takes an explicit `undefined` only when its type includes it),
`noImplicitOverride` and `noFallthroughCasesInSwitch`. With `module: ESNext`
and `moduleResolution: Bundler`, relative imports carry no extension
(`from './schema'`); wrangler (esbuild) and Vitest (Vite) resolve them.
`verbatimModuleSyntax` requires `import type` for a type-only import, and
`noEmit` leaves the bundling to wrangler.

## 6. Configuration and local secrets

Code reads the deployment's variables only through `configFor(env)` in
`src/config/memo.ts`, which passes the string-valued properties of the
Worker's `env` (its variables and secrets, never its bindings) to
`loadConfig()` in `src/config/schema.ts` (critical invariants 2 and 6) and
keeps the result for as long as that `env` object lives, so an isolate parses
once per `env` object; a failed load is not kept. Nothing calls it yet: the
Worker entry is wired in a later unit.

| Variable | Must hold | Default |
|---|---|---|
| `BOT_TOKEN` | a non-blank secret | required |
| `BOT_ID` | a positive integer: the bot's numeric Telegram id, which grammY's `botInfo` needs with `BOT_USERNAME`, so no update costs a `getMe` call | required |
| `BOT_USERNAME` | the bot's username without the @: 5 to 32 characters from A-Z, a-z, 0-9 and `_` | required |
| `WEBHOOK_SECRET` | 1 to 256 characters from A-Z, a-z, 0-9, `_` and `-` (Telegram's `secret_token` alphabet) | required |
| `WEBHOOK_PATH_SEGMENT` | a URL path segment of A-Z, a-z, 0-9, `_` and `-` | required |
| `ADMIN_IDS` | comma-separated numeric Telegram user ids, never usernames; at least one | required |
| `KEYHOLDER_IDS` | comma-separated numeric Telegram user ids of the keyholders, never usernames; at least one; the same rules as `ADMIN_IDS`, and no id in both lists (a keyholder is never an admin). The keyholders receive the alerts and may run `/lockdown`, `/unlock` and `/retract` | required |
| `REPORTER_REF_KEY` | a non-blank secret | required |
| `ADMIN_CHAT_ID` | a non-zero integer chat id, negative for groups and channels | required |
| `MEMBERSHIP_CHAT_ID` | a non-zero integer chat id, negative for groups and channels: the chat whose members get the members' intake limits | required |
| `BROADCAST_CHAT_ID` | a negative integer chat id: the channel each approved report is posted into, once | required |
| `ALLOWED_LINK_HOSTS` | comma-separated exact lowercase hostnames, each of a-z, 0-9, dots and hyphens, with no scheme, path or port: the only hosts a post may link to | `instagram.com,www.instagram.com,x.com,twitter.com,www.facebook.com,facebook.com,www.tiktok.com,tiktok.com,t.me` |
| `LOCKDOWN` | `1` or nothing: the keyholder's override, which no Telegram command can clear | none: off |
| `APPROVAL_GRACE_MINUTES` | an integer from 1 to 1440 | 30 |
| `MARKS_PER_DAY` | an integer from 0 to 1000000: the daily cap on recorded "I reported it" presses, all reports together | 20000 |
| `MARKS_PER_REPORT` | an integer from 0 to 1000000: the cap on recorded "I reported it" presses for one report | 5000 |

- An empty value counts as absent: a tunable left empty takes its default,
  and an empty required variable fails. A value of spaces only is not absent,
  and no variable accepts it. Variables the schema does not know are ignored.
- Integers are canonical decimals: no leading zero, exponent or decimal point,
  and a sign only as the `-` of a chat id. In `ADMIN_IDS` and `KEYHOLDER_IDS`
  (critical invariant 2) spaces around an entry are ignored; an @handle, a
  username, an empty entry (a doubled, leading or trailing comma), zero, a
  sign, a leading zero, a decimal, an exponent, hexadecimal, another separator
  or an id beyond the safe-integer range fails the load, and so does an id
  that is in both lists, the error naming the two variables and no value.
- In `ALLOWED_LINK_HOSTS` spaces around an entry are ignored; a scheme, a
  path, a port, userinfo, a capital, a wildcard, a single label, a
  dotted-quad address, an empty label or a label starting or ending with a
  hyphen fails the load.
- `LOCKDOWN` accepts `1` and nothing else; any other value fails the load
  rather than being read as "off".
- A failed load throws an `AppError` with the code `CONFIG_INVALID`
  (`src/errors/`), naming each offending variable with what it must hold in its
  message and listing the names in its `variables` field, never a value, and
  carrying no cause. The loaded object is
  frozen and unprintable: `JSON.stringify` and `util.inspect` render it, and
  any spread copy, as `[config redacted]` (critical invariant 6). That covers
  the object, not a field read from it: `config.botToken` is a plain string,
  and logging it leaks the token.

Locally, copy `.dev.vars.example` to `.dev.vars` and fill in `.dev.vars`,
never the example, which is committed with every secret and id empty, the
tunables at their defaults and `LOCKDOWN` off. `wrangler dev` reads `.dev.vars` next to
`wrangler.jsonc`, and the Vitest plugin reads it through wrangler's loader
too; wrangler also reads `.dev.vars.<name>` under `--env <name>`, and `.env`
files when no `.dev.vars*` file exists. All of them are gitignored, except the
`.example` files. In production every value is set with
`wrangler secret put <NAME>`, and `vars` stays empty; where each value lives,
who holds it and when it is re-issued is in the
[operations and security runbook](./operations-and-security.md), sections 1.4
and 2.1.

## 7. Wrangler

| `wrangler.jsonc` | Setting |
|---|---|
| `main` | `src/worker.ts`: the HTTP handler and the cron handler, without logic until Phase 3 (every request is answered 404) |
| `compatibility_date` | 2026-10-28 (see below), with the `nodejs_compat` flag |
| `send_metrics` | `false`: wrangler sends no usage metrics for this project, overriding each user's own telemetry setting (an explicit `WRANGLER_SEND_METRICS` in the environment still takes precedence); the owner's stance, not a rule-6 requirement |
| `d1_databases` | binding `DB`, `database_name` `div-report`, an all-zero placeholder `database_id` (the real id is deployment configuration), `migrations_dir` `migrations/` at the repository root |
| `triggers` | one cron, `5 0 * * *`, for the nightly retention job (00:05 UTC, after the Free plan's daily caps reset); the one-minute cron that drains the `jobs` table, and also replaces the stall detector, is added with the scheduling unit (U5; ADR 0004) |
| `observability` | disabled: the platform's invocation logs are logs (critical invariant 6); turned on only deliberately (runbook, section 4) |
| `vars` | empty: no secret and no deployment value lives in this file |

`npm run migrate:local` applies `migrations/` to the local database under
`.wrangler/`; `migrations/0001_init.sql` is the MVP schema
([ADR 0006](../architecture/adr-0006-data-model-and-module-layout.md)), and a
later change adds a file rather than editing an applied one. On the Node port
`src/db/migrate.ts` applies the same files, each once, recording them in
`schema_migrations`.
`npm run dry-run` bundles the Worker into `.wrangler/dry-run` and lists its
one binding (`env.DB`) with no Cloudflare account and no network access, and
with `send_metrics` off it prints no telemetry notice. `.wrangler/`, which also
holds the local D1 state, is gitignored. There is no Durable Object. The
`Broadcaster` class and its `v1` migration tag of Phase 2 were removed before
any deployment (the `database_id` is still the placeholder), so no
`deleted_classes` migration is needed; a Worker that had deployed them would
need one. `wrangler dev` does not fire the cron trigger by itself; it
prints the `curl` command (`/cdn-cgi/local/scheduled` on the dev server)
that does.

`compatibility_date` follows ADR 0002's rule: the newest date every runtime
in the toolchain accepts when it is set. miniflare, behind both `wrangler dev`
and the Vitest plugin, refuses any date after today's UTC date
(`ERR_FUTURE_COMPATIBILITY_DATE`), and workerd 1.20261023.1's own ceiling is
2026-10-30; neither `npx workerd --version` (2026-10-23) nor wrangler's
default date is a ceiling. To raise it, set at most the current UTC date and
run `npm run test:workers`: dev and tests share one miniflare and one workerd.

## 8. Critical paths, the anchor and the tripwire

The critical paths are the globs in `.claude/devil/critical-globs.conf`, which
also scope the domain-auditor and devil.sh's critical-path runs; ADR 0006 is
the source of truth for the module map and the rules each module carries.

| Glob | Holds | Rules |
|---|---|---|
| `*src/telegram/*` | bot wiring, handlers, rendering with previews disabled, the webhook secret check | 2, 4 |
| `*src/auth/*` | the allowlist gate, the membership check | 2, 4 |
| `*src/review/*` | the report state machine, routing table, approval records, grace and cancel | 1, 3, 7 |
| `*src/broadcast/*` | the single post of an approved report, its edits (retraction, closure), the jobs the minute cron drains | 1, 5 |
| `*src/privacy/*` | HMAC references, log redaction, the retention job | 6, 8 |
| `*src/config/*` | the zod schema and loaders | 2, 6 |
| `*src/db/*` | the `SqlDb` port and its adapters | 8 |
| `*migrations/*` | the D1 schema migrations | 8 |
| `*src/platforms/*` | URL parsing, per-platform instruction keys and the link policy (the exact hosts a post may link to) | 4 |
| `*src/worker.ts`, `*src/node.ts` | the Worker entry (HTTP, cron) and the Node port's entry, when it lands | none listed |

`src/errors/` and `src/i18n/` are deliberately not critical.
Every file on a critical path carries the comment line `// @critical-path`
(TypeScript) or `-- @critical-path` (SQL) near its top, as `src/worker.ts`
and `src/config/schema.ts` do. `selftest/critical-globs-completeness.sh`
fails, naming the file, when an anchored file under `src/` or `migrations/`
matches no glob, so a new critical module adds its glob in the same change.
The check sees only anchored files: a critical file without the anchor
escapes it.

The tripwire, `.claude/hooks/critical-path-tripwire.sh`, runs after every
Claude Code Edit or Write. In a file the globs match (test files, `*.spec.*`,
`*.test.*` and `*_test.*`, are skipped) it checks the lines added against
HEAD, or the whole file when it is untracked, and flags:

| Pattern | Rules |
|---|---|
| `console.log(`, `.error(`, `.warn(`, `.info(` or `.debug(` | 6 |
| `JSON.stringify(` of `err`, `error`, `e`, `ctx` or `update` | 6 |
| `forwardMessage(s)(`, `copyMessage(s)(`, `getChat(`, `getFile(` | 3, 4 |
| a bare `fetch(` (at the start of a line, or not preceded by a dot or an identifier character), plus `globalThis.fetch(`, `self.fetch(` and `window.fetch(` | 4 |
| `disable_web_page_preview`, `is_disabled: false` | 4 |

On a hit it feeds a reminder of rules 3, 4 and 6 back to the model; the edit
itself stays. One hit is sanctioned: the two console calls in
`src/privacy/logger.ts`, the only console writer, whenever an edit adds them
(and on every edit while that file is untracked, since the hook then scans it
whole). It is an authoring-time heuristic, not a gate: the
domain-auditor and the invariant tests are the gates. The pattern itself is
pinned by `selftest/tripwire-patterns.sh` (run by `bash selftest/run-all.sh`),
which checks that `BANNED_PATTERNS` compiles and drives the unmodified hook
with lines that must and must not trip it, so an invalid pattern can no
longer turn the hook into a silent no-op. `getChatMember(`, which the
membership check needs, and a method call such as `stub.fetch(` do not match.
Known false positive: a method-shorthand handler such as
`async fetch(request, env, ctx) {` matches the bare-fetch pattern, which is
why `src/worker.ts` writes its handlers as properties (`fetch: () => ...`).

## 9. Known issues (2026-10-28)

Moving to `@cloudflare/vitest-plugin` on 2026-10-28 removed the deprecated
Workers Vitest pool package, its six high-severity audit findings and the
2026-08-22 compatibility-date cap; `npm audit` now reports
`found 0 vulnerabilities`. What remains:

- `SELF` from `cloudflare:test` is marked deprecated in the plugin's types, in
  favour of `exports` from `cloudflare:workers` (`exports.default.fetch()`);
  the smoke test still uses `SELF.fetch`.
- `@types/node` 26 on a Node 22 runtime can type-check APIs that Node 22
  lacks; that matters only for the unit tests and the Node port. For
  `node:sqlite`, `src/db/node-sqlite.ts` uses only what Node 22 has
  (`DatabaseSync`, `prepare`, `exec`, `isTransaction`).
- `node:sqlite` is experimental in Node 22 and prints an `ExperimentalWarning`
  when it loads. `vitest.config.ts` passes `--disable-warning=ExperimentalWarning`
  to the unit and invariants tiers, which hides every experimental warning
  there; the Node port will print it once at start.

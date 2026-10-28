#!/usr/bin/env node
// Guard against stale in-prose bundle references. check-links.mjs only
// validates real markdown links `](...)`; doc bodies also mention files as
// backtick/prose paths like `doc/reference/provider_api.json`, which
// reorganizations leave pointing at old locations. This catches the
// unambiguous case: a `<docRoot>/<path>.<ext>` mention that does NOT exist at
// that path but whose basename resolves to exactly one real file elsewhere in
// the bundle — i.e. a misplaced ref. Mentions whose basename resolves nowhere
// are treated as PLANNED/EXTERNAL docs and deliberately ignored (writing a
// doc's future path before the doc exists is legitimate).
//
// URL safety (two independent layers): a lookbehind refuses matches preceded
// by a word/URL character, AND any match positioned inside a detected URL
// span (scheme://… or mailto:…, including query strings like
// `?next=<docRoot>/x.md`) is skipped by both the checker and --fix — URLs
// are never flagged and never rewritten.
//   node scripts/okf/check-refs.mjs          # gate: exit 1 on any stale ref
//   node scripts/okf/check-refs.mjs --fix    # repoint stale refs at the real path
import fs from 'node:fs';
import path from 'node:path';
import CONFIG from './okf.config.mjs';

if (CONFIG.template !== false) {
  console.error('okf gate: okf.config.mjs must set `template: false` EXPLICITLY — it is still the shipped template, or the flag was removed/misspelled. Edit the config for this project first.');
  process.exit(1);
}

const P = path.posix;
const DOC = CONFIG.docRoot;
const SKIP = new Set(CONFIG.skipDirs);
const ASSET_EXCLUDE = new Set(CONFIG.assetExcludeExts);
const FIX = process.argv.includes('--fix');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Lookbehind blocks matches inside URLs, query strings, and longer paths:
// preceded by a word char or : / . - = ? & # (covers `?next=doc/…`,
// `//host/?q=doc/…`, `#doc/…`), plus the `=(` two-char form for
// parenthesized query values in RELATIVE urls (`?next=(doc/…)`) — absolute
// urls are additionally covered by the span layer. `(` alone stays allowed:
// `](doc/x.md)` inline links are legitimate fix targets.
const GUARD = '(?<![\\w:/.=?&#-])(?<!=\\()';
const REF = new RegExp(`${GUARD}${escapeRe(DOC)}/[A-Za-z0-9_./-]+\\.(?:${CONFIG.refExtensions.map(escapeRe).join('|')})`, 'g');

if (!fs.existsSync(DOC)) {
  console.error(`okf gate: bundle root '${DOC}' not found — run from the repository root (or fix docRoot in okf.config.mjs).`);
  process.exit(1);
}

function walk(dir, pred, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = P.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(f, pred, out); continue; }
    if (pred(e.name)) out.push(f);
  }
  return out;
}

// basename -> set of real repo paths (every concept doc + asset, minus excluded asset types)
const byBase = new Map();
for (const f of walk(DOC, (n) => !ASSET_EXCLUDE.has(P.extname(n).toLowerCase()))) {
  const b = P.basename(f);
  if (!byBase.has(b)) byBase.set(b, new Set());
  byBase.get(b).add(f);
}

// URL spans: absolute-scheme and mailto occurrences, including their query
// strings — matches inside these are never touched. Parentheses are PART of
// a span (query values like `?next=(…)` are legal); over-extending a span
// past a closing paren only excludes more, never rewrites more.
function urlSpans(c) {
  const spans = [];
  for (const m of c.matchAll(/(?:[a-z][a-z0-9+.-]*:\/\/|mailto:)[^\s<>[\]"']+/gi)) {
    spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}
const inSpan = (spans, i) => spans.some(([a, b]) => i >= a && i < b);

const stale = [];      // { file, token, real }
const ambiguous = [];  // { file, token, options }
let fixedFiles = 0, fixedHits = 0;

for (const file of walk(DOC, (n) => n.endsWith('.md'))) {
  const c = fs.readFileSync(file, 'utf8');
  const spans = urlSpans(c);
  const edits = []; // [start, end, replacement] — applied back-to-front
  const seen = new Map(); // token -> verdict, to report each token once per file
  REF.lastIndex = 0;
  let m;
  while ((m = REF.exec(c))) {
    if (inSpan(spans, m.index)) continue;
    const token = m[0];
    if (!seen.has(token)) {
      if (fs.existsSync(token)) { seen.set(token, null); }
      else {
        const set = byBase.get(P.basename(token));
        if (!set || set.size === 0) { seen.set(token, null); }        // planned/external
        else if (set.size > 1) { seen.set(token, null); ambiguous.push({ file, token, options: [...set] }); }
        else { const real = [...set][0]; seen.set(token, real); stale.push({ file, token, real }); }
      }
    }
    const real = seen.get(token);
    if (FIX && real) { edits.push([m.index, m.index + token.length, real]); fixedHits++; }
  }
  if (FIX && edits.length) {
    let out = c;
    for (const [a, b, r] of edits.sort((x, y) => y[0] - x[0])) out = out.slice(0, a) + r + out.slice(b);
    fs.writeFileSync(file, out);
    fixedFiles++;
  }
}

if (FIX) {
  console.log(`check-refs --fix: repointed ${fixedHits} stale references across ${fixedFiles} files.`);
  for (const a of ambiguous) console.warn(`  AMBIGUOUS (left): ${a.file} -> ${a.token} (basename in ${a.options.length} places)`);
  process.exit(0);
}

if (stale.length) {
  console.error(`Stale bundle references (${stale.length}) — wrong path, file lives elsewhere (run \`node scripts/okf/check-refs.mjs --fix\`):`);
  for (const s of stale) console.error(`  ${s.file}: ${s.token}  ->  ${s.real}`);
  process.exit(1);
}
if (ambiguous.length) for (const a of ambiguous) console.warn(`  ambiguous (manual): ${a.file} -> ${a.token}`);
console.log(`Ref check OK: every resolvable ${DOC}/<path> prose mention points at the right path (unknown basenames are treated as planned/external docs).`);

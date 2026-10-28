#!/usr/bin/env node
// OKF conformance gate. Exits non-zero on any violation.
// MUST: every non-reserved .md under the bundle root has a YAML frontmatter
// block with a non-empty `type`. Reserved files (see okf.config.mjs) carry no
// frontmatter — except the root index, which may set `okf_version` only.
import fs from 'node:fs';
import path from 'node:path';
import CONFIG from './okf.config.mjs';

if (CONFIG.template !== false) {
  console.error('okf gate: okf.config.mjs must set `template: false` EXPLICITLY — it is still the shipped template, or the flag was removed/misspelled. Edit the config for this project first.');
  process.exit(1);
}

const P = path.posix;
const DOC = CONFIG.docRoot;
const SKIP_DIRS = new Set(CONFIG.skipDirs);
const RESERVED = new Set(CONFIG.reservedFiles);
const violations = [];

// Frontmatter terminator: a line that is exactly `---` (not merely a line
// starting with dashes).
const FM_END = /\n---(\r?\n|$)/;

// A `type:` line whose VALUE is semantically empty does not satisfy the
// gate: ``, `""`, `''`, any-case `null`, `~`, comment-only, a quoted-empty
// followed by a comment, a bare tag (`!!null`), or a block-scalar
// introducer (`|`, `>`).
function typeValue(block) {
  const line = block.split('\n').find((l) => /^type:/.test(l));
  if (line === undefined) return undefined;
  let v = line.replace(/^type:\s*/, '').trim();
  if (v.startsWith('"') || v.startsWith("'")) {
    const q = v[0];
    const end = v.indexOf(q, 1);
    v = end > 0 ? v.slice(1, end).trim() : '';
  } else {
    v = v.replace(/\s+#.*$/, '').trim();
    if (v.startsWith('#')) v = '';
  }
  v = v.replace(/^!!\w+\s*/, ''); // strip a leading tag: `!!null null`, `!!str x`
  // Block scalars (`|`, `>`, and modifier forms like `|-`, `>+`, `|2-`) are
  // rejected as a declared scope decision: a `type` must be a single-line
  // scalar token — failing CLOSED on multiline forms. Empty flow
  // collections (`[]`, `{}`) are equally not a type.
  if (/^[|>][0-9+-]*$/.test(v) || v === '[]' || v === '{}') v = '';
  if (v === '' || v.toLowerCase() === 'null' || v === '~') return '';
  return v;
}

if (!fs.existsSync(DOC)) {
  console.error(`okf gate: bundle root '${DOC}' not found — run from the repository root (or fix docRoot in okf.config.mjs).`);
  process.exit(1);
}

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = P.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(f); continue; }
    if (!e.name.endsWith('.md')) continue;
    const content = fs.readFileSync(f, 'utf8');
    if (RESERVED.has(e.name)) {
      if (content.startsWith('---\n')) {
        const endM = FM_END.exec(content.slice(4));
        if (!endM) { violations.push(`${f}: unterminated frontmatter on a reserved file`); continue; }
        const block = content.slice(4, 4 + endM.index);
        const onlyOkfVersion = f === P.join(DOC, 'index.md')
          && /^okf_version:/.test(block.trim()) && block.trim().split('\n').length === 1;
        if (!onlyOkfVersion) violations.push(`${f}: reserved file must not carry frontmatter (root index may set okf_version only)`);
      }
      continue;
    }
    if (!content.startsWith('---\n')) { violations.push(`${f}: missing YAML frontmatter`); continue; }
    const endM = FM_END.exec(content.slice(4));
    if (!endM) { violations.push(`${f}: unterminated frontmatter`); continue; }
    const block = content.slice(4, 4 + endM.index);
    const t = typeValue(block);
    if (t === undefined) violations.push(`${f}: missing required \`type\``);
    else if (t === '') violations.push(`${f}: \`type\` is empty (\`""\`/\`null\`/\`~\`/comment-only do not count)`);
  }
}
walk(DOC);

// A configured conventions doc is part of conformance: the doc-scribe agent
// and INSTALL both require it, so the gate must agree. Projects that want
// none set conventionsFile to '' / null.
if (CONFIG.conventionsFile && !fs.existsSync(P.join(DOC, CONFIG.conventionsFile))) {
  violations.push(`${P.join(DOC, CONFIG.conventionsFile)}: configured conventionsFile is missing (create it, or set conventionsFile: '' in okf.config.mjs)`);
}

if (violations.length) {
  console.error(`OKF conformance FAILED (${violations.length}):\n` + violations.join('\n'));
  process.exit(1);
}
console.log('OKF conformance OK: every concept doc has frontmatter with a non-empty `type`.');

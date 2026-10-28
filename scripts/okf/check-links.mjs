#!/usr/bin/env node
// Verify intra-bundle markdown links resolve. Scans <docRoot>/**/*.md for
// inline `](…)` links, reference-style `[label]: …` definitions, and
// bundle-root-absolute `/…` links. Declared scope: FILE existence only —
// `#anchor` fragments are not validated against headings (slugification is
// renderer-specific; see the kit README's honesty notes).
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
const broken = [];

if (!fs.existsSync(DOC)) {
  console.error(`okf gate: bundle root '${DOC}' not found — run from the repository root (or fix docRoot in okf.config.mjs).`);
  process.exit(1);
}

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = P.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(f); continue; }
    if (!e.name.endsWith('.md')) continue;
    // Fenced blocks (``` and ~~~) and inline code (single/double backtick)
    // are EXAMPLES, not live links — blank them before scanning. Declared
    // scope: 4-space-INDENTED code blocks are NOT masked (indistinguishable
    // from nested list content without block-context parsing; masking them
    // would silently unvalidate real links in nested lists).
    const c = fs.readFileSync(f, 'utf8')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/~~~[\s\S]*?~~~/g, '')
      .replace(/``[^`]*``/g, '')
      .replace(/`[^`\n]*`/g, '');
    const targets = [];
    for (const m of c.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) targets.push(m[1]);
    // reference-style definitions: [label]: target (angle-bracketed targets
    // are unwrapped; labels are case-insensitive with collapsed whitespace)
    const normId = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
    const unwrap = (t) => (t.startsWith('<') && t.endsWith('>')) ? t.slice(1, -1) : t;
    const defs = new Set();
    for (const m of c.matchAll(/^\[([^\]]+)\]:\s*(\S+)/gm)) { defs.add(normId(m[1])); targets.push(unwrap(m[2])); }
    // reference-style USAGES need a definition: [text][id] and collapsed
    // [id][]. (Bare [shortcut] references are declared out of scope —
    // indistinguishable from ordinary brackets without a full parser.)
    for (const m of c.matchAll(/\[[^\]]*\]\[([^\]]+)\]/g)) {
      if (!defs.has(normId(m[1]))) broken.push(`${f} -> [${m[1]}] (reference used but never defined)`);
    }
    for (const m of c.matchAll(/\[([^\]]+)\]\[\](?!\()/g)) {
      if (!defs.has(normId(m[1]))) broken.push(`${f} -> [${m[1]}] (collapsed reference never defined)`);
    }
    for (const raw of targets) {
      let u = raw;
      if (/^[a-z]+:/i.test(u) || u.startsWith('#')) continue;
      const base = u.startsWith('/') ? DOC : P.dirname(f); // `/…` resolves against the bundle root
      u = u.split('#')[0];
      if (!u) continue;
      const target = P.normalize(P.join(base, u));
      if (!fs.existsSync(target)) broken.push(`${f} -> ${raw}`);
    }
  }
}
walk(DOC);

if (broken.length) {
  console.error(`Broken intra-bundle links (${broken.length}):\n` + broken.join('\n'));
  process.exit(1);
}
console.log(`Link check OK: all relative markdown links inside ${DOC}/ resolve.`);

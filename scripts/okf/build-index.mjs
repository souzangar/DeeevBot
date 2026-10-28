#!/usr/bin/env node
// Generate OKF index.md files from frontmatter. Root carries okf_version and
// (when configured) a pinned "Rules & Invariants" section; every folder with
// docs gets a directory listing. Re-runnable.
//   node scripts/okf/build-index.mjs            # write the indexes
//   node scripts/okf/build-index.mjs --check    # gate: fail if any index is stale
//   node scripts/okf/build-index.mjs --adopt    # first run in a repo with
//                                               #   pre-existing index/README files:
//                                               #   take ownership of them
//
// Ownership safety: every generated file carries a marker comment. The
// generator REFUSES to overwrite an existing file that lacks the marker
// unless --adopt is passed — a target repo's hand-written indexes are never
// silently clobbered.
//
// Pinned-rule safety: every rulesAndInvariants entry must resolve — a
// docRoot-relative path must exist; a bare basename must be unique in the
// bundle. A missing or ambiguous entry fails the build (and --check): the
// most important index section must never silently thin out.
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
const CHECK = process.argv.includes('--check');
const ADOPT = process.argv.includes('--adopt');
const MARKER = '<!-- generated-by: scripts/okf/build-index.mjs — do not edit by hand -->';
const outputs = []; // [path, content]

if (!fs.existsSync(DOC)) {
  console.error(`okf gate: bundle root '${DOC}' not found — run from the repository root (or fix docRoot in okf.config.mjs).`);
  process.exit(1);
}

function walkDirs(dir) {
  const dirs = [dir];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && !SKIP_DIRS.has(e.name)) dirs.push(...walkDirs(P.join(dir, e.name)));
  }
  return dirs;
}

function readFm(file) {
  const c = fs.readFileSync(file, 'utf8');
  if (!c.startsWith('---\n')) return {};
  const endM = /\n---(\r?\n|$)/.exec(c.slice(4));
  if (!endM) return {};
  const fm = {};
  for (const line of c.slice(4, 4 + endM.index).split('\n')) {
    const m = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    fm[m[1]] = v;
  }
  return fm;
}

const isConcept = (name) => name.endsWith('.md') && !RESERVED.has(name) && name !== 'README.md';
const titleOf = (file) => readFm(file).title || P.basename(file);
const descOf = (file) => { const d = readFm(file).description; return d ? ` — ${d}` : ''; };
const statusTag = (file) => { const s = readFm(file).status; return s && s !== CONFIG.activeStatus ? ` _(${s})_` : ''; };

// All concept docs (for pin resolution)
const allDocs = [];
(function collect(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = P.join(d, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) collect(f); }
    else if (isConcept(e.name)) allDocs.push(f);
  }
})(DOC);
const byBasename = new Map();
for (const f of allDocs) {
  const b = P.basename(f);
  if (!byBasename.has(b)) byBasename.set(b, []);
  byBasename.get(b).push(f);
}

// Resolve pinned rules STRICTLY — collect all problems, then fail loudly.
// A pin must be a CONCEPT DOC inside the bundle: path traversal (`../…`),
// directories, reserved files, and skipped paths are all rejected because
// membership is checked against the collected concept-doc set, not bare
// filesystem existence.
const allDocsSet = new Set(allDocs);
const pinErrors = [];
const pins = [];
for (const entry of CONFIG.rulesAndInvariants) {
  if (entry.includes('/')) {
    const f = P.normalize(P.join(DOC, entry));
    if (allDocsSet.has(f)) pins.push(f);
    else pinErrors.push(`pinned rule is not a concept doc inside the bundle: ${entry} (resolved to ${f})`);
  } else {
    const hits = byBasename.get(entry) || [];
    if (hits.length === 1) pins.push(hits[0]);
    else if (hits.length === 0) pinErrors.push(`pinned rule not found anywhere in the bundle: ${entry}`);
    else pinErrors.push(`pinned rule basename is ambiguous: ${entry} → ${hits.join(', ')} (use a ${DOC}-relative path in okf.config.mjs)`);
  }
}
if (pinErrors.length) {
  console.error(`Pinned rulesAndInvariants FAILED to resolve (${pinErrors.length}):\n  ` + pinErrors.join('\n  '));
  process.exit(1);
}

function hasDocs(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && isConcept(e.name)) return true;
    if (e.isDirectory() && !SKIP_DIRS.has(e.name) && hasDocs(P.join(dir, e.name))) return true;
  }
  return false;
}
function countDocs(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && isConcept(e.name)) n++;
    else if (e.isDirectory() && !SKIP_DIRS.has(e.name)) n += countDocs(P.join(dir, e.name));
  }
  return n;
}
function listing(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const subdirs = entries.filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name)).map((e) => e.name).sort();
  const docs = entries.filter((e) => e.isFile() && isConcept(e.name)).map((e) => e.name).sort();
  return { subdirs, docs };
}

// Root-index domain order: okf.config.mjs `folders` insertion order first
// (as its comment promises), then unconfigured folders alphabetically.
function orderDomains(names) {
  const cfg = Object.keys(CONFIG.folders).filter((n) => names.includes(n));
  const rest = names.filter((n) => !(n in CONFIG.folders));
  return [...cfg, ...rest];
}

for (const dir of walkDirs(DOC)) {
  const isRoot = dir === DOC;
  if (!isRoot && !hasDocs(dir)) continue;
  const all = listing(dir);
  const subdirs = all.subdirs.filter((n) => hasDocs(P.join(dir, n)));
  const docs = all.docs;
  let out = '';
  if (isRoot) {
    out += `---\nokf_version: "${CONFIG.okfVersion}"\n---\n\n${MARKER}\n\n`;
    out += `# ${CONFIG.bundleTitle}\n\n`;
    out += `Open Knowledge Format v${CONFIG.okfVersion} bundle. Every concept doc carries YAML `;
    out += `frontmatter (\`type\` required; \`title\`, \`description\`, \`tags\`, \`status\`, \`timestamp\` recommended)`;
    if (CONFIG.conventionsFile && fs.existsSync(P.join(DOC, CONFIG.conventionsFile))) {
      out += `; conventions in [${CONFIG.conventionsFile}](./${CONFIG.conventionsFile})`;
    }
    out += `. Generated by \`scripts/okf/build-index.mjs\` — do not edit by hand.\n\n`;
    if (pins.length) {
      out += `## Rules & Invariants\n\nBinding rules — read before touching the relevant code path.\n\n`;
      for (const f of pins) out += `- [${titleOf(f)}](./${P.relative(DOC, f)})${descOf(f)}\n`;
      out += `\n`;
    }
    out += `## Domains\n\n`;
    for (const name of orderDomains(subdirs)) {
      if (!(name in CONFIG.folders)) console.warn(`build-index: note: folder '${name}/' has no description in okf.config.mjs folders`);
      out += `- [${name}/](./${name}/index.md) — ${CONFIG.folders[name] || ''} _(${countDocs(P.join(dir, name))})_\n`;
    }
    if (docs.length) {
      out += `\n## Bundle\n\n`;
      for (const d of docs) out += `- [${titleOf(P.join(dir, d))}](./${d})${descOf(P.join(dir, d))}\n`;
    }
  } else {
    const folderKey = P.relative(DOC, dir);
    out += `${MARKER}\n\n# ${folderKey}/\n\n`;
    if (CONFIG.folders[folderKey]) out += `${CONFIG.folders[folderKey]}\n\n`;
    out += `↑ [bundle index](${P.relative(dir, P.join(DOC, 'index.md'))})\n\n`;
    for (const d of docs) out += `- [${titleOf(P.join(dir, d))}](./${d})${statusTag(P.join(dir, d))}${descOf(P.join(dir, d))}\n`;
    for (const s of subdirs) out += `- [${s}/](./${s}/index.md)\n`;
  }
  outputs.push([P.join(dir, 'index.md'), out]);
}

// README stub so code-forge folder views point at the bundle index.
if (CONFIG.readmeStub?.enabled) {
  const t = CONFIG.readmeStub.title;
  const d = CONFIG.readmeStub.description;
  const fm = `---\ntype: reference\ntitle: "${t}"\ndescription: "${d}"\nstatus: ${CONFIG.activeStatus}\ntags: [docs, index]\n---\n\n${MARKER}\n\n`;
  outputs.push([P.join(DOC, 'README.md'),
    `${fm}# ${t}\n\nThis folder is an **Open Knowledge Format (OKF) v${CONFIG.okfVersion}** bundle.\n\n` +
    `➡️ Start at **[index.md](./index.md)** — the generated bundle index.\n` +
    (CONFIG.conventionsFile && fs.existsSync(P.join(DOC, CONFIG.conventionsFile)) ? `\nConventions: [${CONFIG.conventionsFile}](./${CONFIG.conventionsFile}).\n` : '')]);
}

// Ownership check: never overwrite a pre-existing file that we didn't generate.
const conflicts = [];
for (const [file] of outputs) {
  if (!fs.existsSync(file)) continue;
  const cur = fs.readFileSync(file, 'utf8');
  if (!cur.includes(MARKER)) conflicts.push(file);
}
if (conflicts.length && !ADOPT) {
  console.error(
    `build-index: REFUSING to overwrite ${conflicts.length} pre-existing file(s) not generated by this tool:\n  ` +
    conflicts.join('\n  ') +
    `\nReview them, then re-run with --adopt to take ownership (their content is replaced by generated listings).`);
  process.exit(1);
}

// Orphans: files WE generated (marker present) that this run no longer
// produces — an emptied folder's index, an index under a directory that is
// NOW in skipDirs, or the README stub after it was disabled. A build
// DELETES them (convergence: build → check must end green); --check flags
// them. Unmarked files in the same positions are the user's — never
// touched, never flagged. The orphan walk deliberately IGNORES skipDirs
// (only .git is skipped): newly skipped directories are exactly where
// stale generated files hide.
function walkAllDirs(dir) {
  const dirs = [dir];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && e.name !== '.git') dirs.push(...walkAllDirs(P.join(dir, e.name)));
  }
  return dirs;
}
const want = new Set(outputs.map(([f]) => f));
const orphans = [];
for (const dir of walkAllDirs(DOC)) {
  const idx = P.join(dir, 'index.md');
  if (!want.has(idx) && fs.existsSync(idx) && fs.readFileSync(idx, 'utf8').includes(MARKER)) orphans.push(idx);
}
const readmePath = P.join(DOC, 'README.md');
if (!CONFIG.readmeStub?.enabled && fs.existsSync(readmePath)
    && fs.readFileSync(readmePath, 'utf8').includes(MARKER)) orphans.push(readmePath);

if (CHECK) {
  const stale = [];
  for (const [file, content] of outputs) {
    let cur = null;
    try { cur = fs.readFileSync(file, 'utf8'); } catch {}
    if (cur !== content) stale.push(`${file} ${cur === null ? '(missing)' : cur.includes(MARKER) ? '(out of date)' : '(pre-existing, unadopted — see --adopt)'}`);
  }
  for (const o of orphans) stale.push(`${o} (orphan — no longer generated; a build removes it)`);
  if (stale.length) {
    console.error(`OKF index is STALE (${stale.length}) — run \`node scripts/okf/build-index.mjs\` and commit:\n` + stale.join('\n'));
    process.exit(1);
  }
  console.log(`OKF index check OK: ${outputs.length} generated files match the committed tree.`);
} else {
  for (const [file, content] of outputs) fs.writeFileSync(file, content);
  for (const o of orphans) fs.unlinkSync(o);
  console.log(`Indexes generated (${outputs.length} files${orphans.length ? `, ${orphans.length} orphan(s) removed` : ''}${ADOPT ? ', pre-existing files adopted' : ''}).`);
}

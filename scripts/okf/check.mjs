#!/usr/bin/env node
// The one OKF gate entrypoint — npm-free by design (a bare `node` suffices):
//   node scripts/okf/check.mjs
// Runs, in order: validate → check-links → check-refs → build-index --check.
// Fail-fast: exits with the first failing gate's code. Projects using npm may
// alias it (e.g. "okf:check": "node scripts/okf/check.mjs") — the alias is a
// convenience, this file is the authority.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import CONFIG from './okf.config.mjs';

if (CONFIG.template !== false) {
  console.error('okf gate: okf.config.mjs must set `template: false` EXPLICITLY — it is still the shipped template, or the flag was removed/misspelled. Edit the config for this project first.');
  process.exit(1);
}
if (!fs.existsSync(CONFIG.docRoot)) {
  console.error(`okf gate: bundle root '${CONFIG.docRoot}' not found — run from the repository root (or fix docRoot in okf.config.mjs).`);
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const steps = [
  ['validate.mjs'],
  ['check-links.mjs'],
  ['check-refs.mjs'],
  ['build-index.mjs', '--check'],
];
for (const [script, ...args] of steps) {
  const r = spawnSync(process.execPath, [path.join(here, script), ...args], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

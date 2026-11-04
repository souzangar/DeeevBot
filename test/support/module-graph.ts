// The static import graph of a module under src/, read from the sources'
// own import, export-from and import() statements with TypeScript's
// preProcessFile, type-only imports included: the files under src/ it
// reaches, and the packages and built-ins it names. src/worker.test.ts and
// test/invariants/polling-authenticity.test.ts check with it that the
// graphs of the Worker's entry and of the deployed probe, which wrangler
// bundles, hold nothing of the Node port.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// `.href`: the Workers and Node type packages both declare URL.
const SRC = fileURLToPath(new URL('../../src', import.meta.url).href);

/** The Node port's own files under src/: its entry and module hook, long polling, the minute loop, the node:sqlite adapter and the migrations runner. */
export const NODE_PORT_FILES: readonly string[] = [
  'node.ts',
  'node-hooks.ts',
  'telegram/polling.ts',
  'broadcast/minute-loop.ts',
  'db/node-sqlite.ts',
  'db/migrate.ts',
];

/** The packages and built-ins only the Node port may use: the runner, the SQLite driver, the file system, module hooks, processes. */
export const NODE_ONLY_MODULES: readonly string[] = [
  '@grammyjs/runner',
  'node:sqlite',
  'node:fs',
  'node:fs/promises',
  'node:module',
  'node:child_process',
  'fs',
  'child_process',
];

export interface ImportGraph {
  /** The files under src/ reached, src/-relative with forward slashes, sorted. */
  readonly files: string[];
  /** The packages and built-ins named, sorted. */
  readonly external: string[];
}

/** The import graph of `entry`, a src/-relative path (see the header). */
export function importGraph(entry: string): ImportGraph {
  const files = new Set<string>();
  const external = new Set<string>();
  const visit = (file: string): void => {
    if (files.has(file)) return;
    files.add(file);
    for (const { fileName } of ts.preProcessFile(readFileSync(file, 'utf8'), true, true).importedFiles) {
      if (!fileName.startsWith('.')) {
        external.add(fileName);
        continue;
      }
      const target = join(dirname(file), fileName);
      const resolved = [`${target}.ts`, target].find((candidate) => candidate.endsWith('.ts') && existsSync(candidate));
      if (resolved === undefined) throw new Error(`unresolved import ${fileName} in ${relative(SRC, file)}`);
      visit(resolved);
    }
  };
  visit(join(SRC, entry));
  return {
    files: [...files].map((file) => relative(SRC, file).split('\\').join('/')).sort(),
    external: [...external].sort(),
  };
}

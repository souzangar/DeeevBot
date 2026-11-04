// Tests of the Node port's module hook (src/node-hooks.ts), each in a child
// process of the Node running the tests, as the port runs it (`node
// --import ./src/node-hooks.ts …`): the module registers the hook as it
// loads, so no test process imports it. With the hook, Node runs the
// sources from their TypeScript, completing an extensionless relative
// import from a `.ts` module with `.ts`, transitively, while packages,
// built-ins, a specifier that names its extension and an import from a
// JavaScript module resolve as Node resolves them, and a missing module
// fails as it would; without the hook, the port's entry does not load.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const HOOKS = fileURLToPath(new URL('./node-hooks.ts', import.meta.url).href);
const ENTRY = fileURLToPath(new URL('./node.ts', import.meta.url).href);
const MEMO = pathToFileURL(fileURLToPath(new URL('./config/memo.ts', import.meta.url).href)).href;

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh directory holding `files`. */
const withFiles = (files: Readonly<Record<string, string>>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'div-report-hooks-'));
  scratch.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
};

/** Runs `script` of `dir` under Node, with the hook unless told otherwise. */
const node = (dir: string, script: string, hook = true) =>
  spawnSync(process.execPath, [...(hook ? ['--import', HOOKS] : []), script], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60_000,
    env: { PATH: process.env.PATH ?? '' },
  });

describe('the Node port\'s module hook', () => {
  it('completes extensionless relative imports from .ts modules, transitively; packages and built-ins resolve as Node resolves them', () => {
    const dir = withFiles({
      'sibling.ts': 'export const value: number = 42;\n',
      // memo.ts imports './schema' without an extension, which imports zod, a package.
      'main.ts': [
        `import { configFor } from '${MEMO}';`,
        "import { value } from './sibling';",
        "import { value as named } from './sibling.ts';",
        "import { join } from 'node:path';",
        'process.stdout.write(JSON.stringify({ configFor: typeof configFor, value, named, join: typeof join }));',
        '',
      ].join('\n'),
    });
    const result = node(dir, 'main.ts');
    expect(result.status).toBe(0);
    // Nothing on stderr but, on some Node 22 releases, Node's own notice that a feature is experimental.
    for (const line of result.stderr.split('\n').filter((entry) => entry !== '')) expect(line).toMatch(/ExperimentalWarning|--trace-warnings/);
    expect(JSON.parse(result.stdout)).toEqual({ configFor: 'function', value: 42, named: 42, join: 'function' });
  });

  it('leaves an import from a JavaScript module alone, and a missing module fails as Node fails it', () => {
    const fromJs = withFiles({ 'sibling.ts': 'export const value = 1;\n', 'main.mjs': "import './sibling';\n" });
    const js = node(fromJs, 'main.mjs');
    expect(js.status).not.toBe(0);
    expect(js.stderr).toContain('ERR_MODULE_NOT_FOUND');

    const missing = withFiles({ 'main.ts': "import './missing';\n" });
    const absent = node(missing, 'main.ts');
    expect(absent.status).not.toBe(0);
    expect(absent.stderr).toContain('ERR_MODULE_NOT_FOUND');
    expect(absent.stderr).toContain('missing.ts');
  });

  it('is what the port needs: without it, Node does not load the entry', () => {
    const dir = withFiles({});
    const result = node(dir, ENTRY, false);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ERR_MODULE_NOT_FOUND');
  });
});

// @critical-path
// The Node port's module hook (doc/guides/developer-setup.md, "The Node
// port"). Loaded before the entry,
//   node --import ./src/node-hooks.ts src/node.ts
// it lets Node's type stripping run the sources as they are: they import
// each other without a file extension (`./config/memo`), as wrangler's
// bundler and Vitest resolve them, and Node's own resolver wants the
// extension. So a relative specifier whose last segment has no extension,
// imported from a `.ts` module, is resolved with `.ts` added; nothing else
// changes: a package (grammy, zod, the runner), a node: built-in, a
// specifier with an extension and an import from a JavaScript module all
// resolve as Node resolves them, and a module that is not there fails as
// it would. The hook reads nothing, loads nothing and keeps no state.
// module.registerHooks() (in-thread, synchronous hooks) is Node 22.15's and
// later; the port's Node is 22.18 or later, where type stripping is on by
// default. The module exports nothing and registers the hook as it loads,
// so no test imports it: src/node-hooks.test.ts runs it in a child process,
// as the port does.
import { registerHooks, type ResolveHookSync } from 'node:module';

/** A relative specifier: `./` or `../` first. */
const RELATIVE = /^\.\.?\//;
/** A last path segment that carries an extension of its own (`api.ts`, `wipe.sh`). */
const HAS_EXTENSION = /\.[A-Za-z0-9]+$/;

/** Whether `specifier`, imported by the module at `parentUrl`, is one this hook completes with `.ts`. */
function completesWithTs(specifier: string, parentUrl: string | undefined): boolean {
  if (parentUrl === undefined || !parentUrl.startsWith('file:') || !parentUrl.endsWith('.ts')) return false;
  if (!RELATIVE.test(specifier)) return false;
  const last = specifier.slice(specifier.lastIndexOf('/') + 1);
  return last !== '' && last !== '.' && last !== '..' && !HAS_EXTENSION.test(last);
}

/** The resolve hook (see the header). */
const resolveExtensionless: ResolveHookSync = (specifier, context, nextResolve) =>
  completesWithTs(specifier, context.parentURL) ? nextResolve(`${specifier}.ts`, context) : nextResolve(specifier, context);

registerHooks({ resolve: resolveExtensionless });

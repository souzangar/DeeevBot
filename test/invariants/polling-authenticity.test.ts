// Always-run invariant spec, critical invariant 2 on the Node port: an
// update is acted on only if it provably came from Telegram. The Worker's
// source is its webhook boundary (test/invariants/webhook-authenticity.test.ts);
// the Node port's is long polling, getUpdates under the bot's token
// (src/telegram/polling.ts). Pinned here by source scans, each probed with
// planted sources it must catch:
// - the only code in src/ that hands an update to the bot (`.handleUpdate(`)
//   is the webhook boundary's and long polling's;
// - nothing in src/ opens a server or listens on a port: no node:http,
//   node:https, node:http2 or node:net, no createServer, no .listen(, so the
//   port takes no inbound connection at all;
// - the Node port's entry composes the bot exactly as the Worker's does,
//   createBot(deps, defaultFeatures(deps)), once, and hands that bot to long
//   polling;
// - the import graphs of the Worker's entry and of the deployed probe, which
//   wrangler bundles, hold none of the Node port's files, the runner,
//   node:sqlite, node:fs or node:module, so on Workers the webhook is the
//   only source.
// The commit gate runs this file on every commit (`npm run test:invariants`).
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { importGraph, NODE_ONLY_MODULES, NODE_PORT_FILES } from '../support/module-graph';

// `.href`: the Workers and Node type packages both declare URL.
const SRC = fileURLToPath(new URL('../../src', import.meta.url).href);

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });

/** A source without its comments: a comment may name what the code must not do. */
const withoutComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Every source file under src/, tests aside, src/-relative, with its code. */
const tree = (): { readonly path: string; readonly code: string }[] =>
  sources(SRC).map((path) => ({ path: relative(SRC, path).split('\\').join('/'), code: withoutComments(readFileSync(path, 'utf8')) }));

const offenders = (files: readonly { readonly path: string; readonly code: string }[], pattern: RegExp): string[] =>
  files.filter((file) => pattern.test(file.code)).map((file) => file.path).sort();

const code = (path: string): string => withoutComments(readFileSync(join(SRC, path), 'utf8'));

/** A call that hands an update to the bot. */
const HANDS_AN_UPDATE = /\.handleUpdate\(/;
/** A server, or a listening socket. */
const SERVES = /['"](?:node:)?(?:https?|http2|net)['"]|\bcreateServer\b|\.listen\(/;

describe('critical invariant 2 on the Node port: updates come from Telegram only', () => {
  it('scans a source tree that is there', () => {
    const paths = tree().map((file) => file.path);
    expect(paths).toEqual(expect.arrayContaining(['node.ts', 'telegram/polling.ts', 'telegram/webhook.ts', 'worker.ts']));
  });

  it('hands updates to the bot from the webhook boundary and long polling only', () => {
    expect(offenders(tree(), HANDS_AN_UPDATE)).toEqual(['telegram/polling.ts', 'telegram/webhook.ts']);
    const planted = [
      ...tree(),
      { path: 'telegram/shortcut.ts', code: 'export const replay = (bot, update) => bot.handleUpdate(update);' },
      { path: 'node-extra.ts', code: 'await deps.bot.handleUpdate(JSON.parse(line));' },
    ];
    expect(offenders(planted, HANDS_AN_UPDATE)).toEqual(['node-extra.ts', 'telegram/polling.ts', 'telegram/shortcut.ts', 'telegram/webhook.ts']);
  });

  it('opens no server and listens on no port anywhere in src/', () => {
    expect(offenders(tree(), SERVES)).toEqual([]);
    for (const planted of [
      "import { createServer } from 'node:http';",
      "import https from 'https';",
      "import { connect } from 'node:net';",
      'server.listen(8443);',
      'const server = http2.createServer(handler);',
    ]) {
      expect(SERVES.test(planted), planted).toBe(true);
    }
    expect(SERVES.test("import { createHash } from 'node:crypto';")).toBe(false);
  });

  it("composes the bot in the Node port's entry exactly as the Worker does, once, and hands it to long polling", () => {
    const COMPOSITION = /createBot\(\s*deps\s*,\s*defaultFeatures\(\s*deps\s*\)\s*\)/;
    for (const entry of ['node.ts', 'worker.ts']) expect(code(entry), entry).toMatch(COMPOSITION);
    expect(code('node.ts').match(/\bcreateBot\(/g)).toHaveLength(1);
    const call = /startPolling\(\{[\s\S]*?\n\s*\}\);/.exec(code('node.ts'))?.[0] ?? '';
    expect(call).toMatch(/^\s*bot,$/m);
  });

  it.each(['worker.ts', 'probe.ts'])("keeps everything of the Node port out of %s's import graph", (entry) => {
    const { files, external } = importGraph(entry);
    expect(files).toEqual(expect.arrayContaining([entry, 'telegram/webhook.ts', 'telegram/bot.ts']));
    expect(files.filter((file) => NODE_PORT_FILES.includes(file))).toEqual([]);
    expect(external.filter((name) => NODE_ONLY_MODULES.includes(name))).toEqual([]);
  });

  it("finds the Node port's files in its own graph, so the graph check is not vacuous", () => {
    const { files, external } = importGraph('node.ts');
    expect(files).toEqual(expect.arrayContaining(NODE_PORT_FILES.filter((file) => file !== 'node-hooks.ts')));
    expect(external).toEqual(expect.arrayContaining(['@grammyjs/runner', 'node:sqlite', 'node:fs']));
  });
});

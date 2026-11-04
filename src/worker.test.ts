// Unit tests for the Worker entry (src/worker.ts) under node, over the fake
// Bot API: the webhook boundary through createWorker(), and a configuration
// that does not load answered 500 with a class-only log line and no bot;
// the cron handler, which loads the configuration first (one that does not
// load runs nothing), dispatches on the cron expression and hands the run to
// waitUntil, which never rejects. The same entry runs in the Workers runtime
// on D1 in test/workers/webhook.test.ts and test/workers/scheduled.test.ts.
// Then the module graph wrangler bundles from this entry (and from the
// deployed probe's, src/probe.ts) holds nothing of the Node port: not its
// entry or module hook, not long polling or the minute loop, not the
// node:sqlite adapter or the migrations runner, not the runner package and
// no Node-only built-in, read from the sources' own imports, type-only ones
// included; and nothing outside src/, so never the operator scripts
// (scripts/set-webhook.ts, which handles the token and the webhook secret).
// Last, the deployment's own configuration (unit U8): wrangler.jsonc, and
// the deployed probe's wrangler.probe.jsonc, declare exactly the one cron
// this Worker runs, TICK_CRON, with no per-environment block that could add
// another, and keep Workers observability off (critical invariant 6: the
// platform's invocation logs are logs).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { enqueuePost } from './broadcast/jobs';
import { SEND_TIMEOUT_SECONDS } from './broadcast/post';
import { TICK_CRON } from './broadcast/tick';
import { sql } from './db/sql';
import { FAILURES } from '../test/fakes/bot-api';
import { migratedDatabase } from '../test/support/database';
import { importGraph, NODE_ONLY_MODULES, NODE_PORT_FILES } from '../test/support/module-graph';
import { insertApproval, insertReport } from '../test/support/review-rows';
import { fakeBotApi } from '../test/fakes/bot-api';
import { recordingLogger } from '../test/fakes/logger';
import { groupMessage, privateMessage } from '../test/support/updates';
import { IDS, TEST_VARIABLES } from '../test/support/variables';
import { SECRET_HEADER } from './telegram/webhook';
import worker, { createWorker, type Env } from './worker';

const PATH = `https://div-report.test/${TEST_VARIABLES.WEBHOOK_PATH_SEGMENT}`;
/** No test here reaches D1: a binding that fails if one does. */
const DB = new Proxy({}, { get: () => { throw new Error('D1 was touched'); } }) as D1Database;

const setup = () => {
  const telegram = fakeBotApi();
  const log = recordingLogger();
  const handler = createWorker(telegram.fetch, log.logger).fetch;
  if (handler === undefined) throw new Error('the Worker has no fetch handler');
  const waited: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => void waited.push(promise), passThroughOnException: () => undefined };
  const call = async (request: Request, env: Env & Record<string, unknown> = { ...TEST_VARIABLES, DB }) => {
    const response = await handler(
      request as Parameters<typeof handler>[0],
      env,
      ctx as unknown as Parameters<typeof handler>[2],
    );
    await Promise.all(waited);
    return response;
  };
  return { telegram, log, call };
};

const post = (update: unknown, secret: string | null = TEST_VARIABLES.WEBHOOK_SECRET) =>
  new Request(PATH, {
    method: 'POST',
    headers: secret === null ? {} : { [SECRET_HEADER]: secret },
    body: JSON.stringify(update),
  });

describe('the Worker entry', () => {
  it('exports the handlers over the runtime fetch', () => {
    expect(typeof worker.fetch).toBe('function');
    expect(typeof worker.scheduled).toBe('function');
  });

  it('answers everything but an authentic request 404, with no Bot API call', async () => {
    const { telegram, call } = setup();
    for (const request of [
      new Request('https://div-report.test/', { method: 'GET' }),
      new Request('https://div-report.test/webhook', { method: 'POST', body: '{}' }),
      post({ update_id: 1 }, null),
      post({ update_id: 1 }, 'wrong-secret-value'),
    ]) {
      const response = await call(request);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('');
    }
    expect(telegram.calls).toEqual([]);
  });

  it('answers an authentic request 200 and hands the update to the bot', async () => {
    const { telegram, call } = setup();
    const response = await call(post(groupMessage(IDS.membershipChat, IDS.reporter, 'hello')));
    expect(response.status).toBe(200);
    expect(telegram.calls).toEqual([]);
  });

  it('answers 500 for a configuration that does not load, logs it by class, builds no bot', async () => {
    const { telegram, log, call } = setup();
    const response = await call(post(privateMessage(IDS.reporter, '/start')), { ...TEST_VARIABLES, BOT_ID: 'not-a-number', DB });
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('');
    expect(telegram.calls).toEqual([]);
    expect(log.records()).toEqual([{ level: 'error', event: 'config.invalid', errorClass: 'AppError', errorCode: 'CONFIG_INVALID' }]);
  });
});

describe('the cron handler', () => {
  const scheduledSetup = () => {
    const telegram = fakeBotApi();
    const log = recordingLogger();
    const handler = createWorker(telegram.fetch, log.logger).scheduled;
    if (handler === undefined) throw new Error('the Worker has no scheduled handler');
    const waited: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => void waited.push(promise), passThroughOnException: () => undefined };
    const fire = async (cron: string, env: Env & Record<string, unknown> = { ...TEST_VARIABLES, DB }) => {
      await handler(
        { cron, scheduledTime: Date.UTC(2027, 0, 15, 12, 1), noRetry: () => undefined },
        env,
        ctx as unknown as Parameters<typeof handler>[2],
      );
      return Promise.all(waited);
    };
    return { telegram, log, fire };
  };

  it('runs nothing on a configuration that does not load, and logs it by class', async () => {
    const { telegram, log, fire } = scheduledSetup();
    expect(await fire('* * * * *', { ...TEST_VARIABLES, DEBUG: '', DB })).toEqual([]);
    expect(telegram.calls).toEqual([]);
    expect(log.records()).toEqual([{ level: 'error', event: 'config.invalid', errorClass: 'AppError', errorCode: 'CONFIG_INVALID' }]);
  });

  it('runs nothing for another cron expression, touching no store', async () => {
    const { telegram, log, fire } = scheduledSetup();
    expect(await fire('5 0 * * *')).toEqual([]);
    expect(telegram.calls).toEqual([]);
    expect(log.records()).toEqual([{ level: 'info', event: 'cron.unknown' }]);
  });

  it("bounds the scheduler's client at SEND_TIMEOUT_SECONDS: a send that hangs ends as ambiguous then, and never later", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const telegram = fakeBotApi({ channelIds: [IDS.broadcastChannel] });
      const log = recordingLogger();
      const database = migratedDatabase();
      const now = Date.now();
      const reportId = await insertReport(database.db, { comment: null, affected_person: null });
      const approvalId = await insertApproval(database.db, reportId, { approvedAt: now - 3_600_000, startsAt: now - 60_000 });
      await database.db.run(sql`UPDATE reports SET status = 'approved', broadcast_text = '<b>The post</b>', link_mode = 'account' WHERE id = ?`, [reportId]);
      await enqueuePost(database.db, { now: () => now, sleep: () => Promise.resolve() }, reportId, approvalId, now - 60_000);
      telegram.fail({ method: 'sendMessage', chatId: IDS.broadcastChannel }, FAILURES.hang);
      const handler = createWorker(telegram.fetch, log.logger, { db: () => database.db }).scheduled;
      if (handler === undefined) throw new Error('the Worker has no scheduled handler');
      const waited: Promise<unknown>[] = [];
      await handler(
        { cron: '* * * * *', scheduledTime: Math.floor(now / 60_000) * 60_000, noRetry: () => undefined },
        { ...TEST_VARIABLES, DB },
        { waitUntil: (promise: Promise<unknown>) => void waited.push(promise), passThroughOnException: () => undefined } as unknown as Parameters<typeof handler>[2],
      );
      await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_SECONDS * 1000 - 1);
      expect(telegram.hanging()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await Promise.all(waited);
      expect(telegram.hanging()).toBe(0);
      expect(await database.db.first(sql`SELECT status, post_message_id, needs_attention FROM reports WHERE id = ?`, [reportId])).toEqual({
        status: 'posting',
        post_message_id: null,
        needs_attention: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('hands the one cron\'s run to waitUntil; a store that fails stops it, and nothing rejects', async () => {
    const { telegram, log, fire } = scheduledSetup();
    const [outcome] = await fire('* * * * *');
    expect(outcome).toMatchObject({ post: 'skipped', stopped: 'storage' });
    expect(telegram.calls).toEqual([]);
    expect(log.records()).toEqual([{ level: 'error', event: 'tick.storage_failed', errorClass: 'AppError', errorCode: 'STORAGE_FAILURE' }]);
  });
});

describe("the Worker's module graph: nothing of the Node port", () => {
  it.each(['worker.ts', 'probe.ts'])('%s imports none of the Node port\'s files and no Node-only module', (entry) => {
    const { files, external } = importGraph(entry);
    expect(files).toEqual(expect.arrayContaining([entry, 'telegram/bot.ts', 'broadcast/tick.ts', 'db/d1.ts']));
    expect(files.filter((file) => NODE_PORT_FILES.includes(file))).toEqual([]);
    expect(external.filter((name) => NODE_ONLY_MODULES.includes(name))).toEqual([]);
  });

  it("sees the Node port's own graph, so the check is not vacuous", () => {
    const { files, external } = importGraph('node.ts');
    expect(files).toEqual(expect.arrayContaining([...NODE_PORT_FILES.filter((file) => file !== 'node-hooks.ts'), 'telegram/bot.ts', 'broadcast/tick.ts']));
    expect(external).toEqual(expect.arrayContaining(['@grammyjs/runner', 'node:sqlite', 'node:fs']));
    expect(importGraph('node-hooks.ts').external).toEqual(['node:module']);
  });

  it.each(['worker.ts', 'probe.ts'])('%s imports nothing outside src/, so never the webhook registration script', (entry) => {
    expect(importGraph(entry).files.filter((file) => file.startsWith('../'))).toEqual([]);
  });

  it('would see the script in a graph that reached it, so the check is not vacuous', () => {
    expect(importGraph('../scripts/set-webhook.ts').files).toEqual(expect.arrayContaining(['../scripts/set-webhook.ts', 'config/memo.ts', 'telegram/api.ts']));
  });
});

/** A wrangler configuration file, read as wrangler reads it: JSON with comments. */
const wranglerConfig = (file: string): Record<string, unknown> => {
  // `.href`: the Workers and Node type packages both declare URL.
  const path = fileURLToPath(new URL(`../${file}`, import.meta.url).href);
  const parsed = ts.parseConfigFileTextToJson(path, readFileSync(path, 'utf8'));
  if (parsed.error !== undefined) throw new Error(`${file} does not parse`);
  return parsed.config as Record<string, unknown>;
};

describe("the deployment's wrangler configuration: one cron, observability off", () => {
  it.each(['wrangler.jsonc', 'wrangler.probe.jsonc'])('%s declares exactly the one cron the Worker runs, and no environment that could add another', (file) => {
    const config = wranglerConfig(file);
    expect(config.triggers).toEqual({ crons: [TICK_CRON] });
    expect(config.env).toBeUndefined();
  });

  it.each(['wrangler.jsonc', 'wrangler.probe.jsonc'])('%s keeps Workers observability off', (file) => {
    expect(wranglerConfig(file).observability).toEqual({ enabled: false });
  });
});

// Unit tests for the Worker entry (src/worker.ts) under node, over the fake
// Bot API: the webhook boundary through createWorker(), and a configuration
// that does not load answered 500 with a class-only log line and no bot;
// the cron handler, which loads the configuration first (one that does not
// load runs nothing), dispatches on the cron expression and hands the run to
// waitUntil, which never rejects. The same entry runs in the Workers runtime
// on D1 in test/workers/webhook.test.ts and test/workers/scheduled.test.ts.
import { describe, expect, it, vi } from 'vitest';
import { enqueuePost } from './broadcast/jobs';
import { SEND_TIMEOUT_SECONDS } from './broadcast/post';
import { sql } from './db/sql';
import { FAILURES } from '../test/fakes/bot-api';
import { migratedDatabase } from '../test/support/database';
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

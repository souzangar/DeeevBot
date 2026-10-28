// Unit tests for the Worker entry (src/worker.ts) under node, over the fake
// Bot API: the webhook boundary through createWorker(), and a configuration
// that does not load answered 500 with a class-only log line and no bot.
// The same entry runs in the Workers runtime on D1 in
// test/workers/webhook.test.ts.
import { describe, expect, it } from 'vitest';
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

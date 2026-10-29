// Unit tests for the deployed probe's entry (src/probe.ts), under node over
// the fake Bot API and a D1 stand-in that holds nothing: every D1 call and
// every Bot API request of one invocation counted, and ONE line logged
// after the invocation's own work is done, with the counts and nothing
// else; the webhook boundary and the cron run are the Worker's own. And the
// one-time fidelity check of /attach's text comparison: only for a POST to
// its path with the webhook's secret; each sample sent to the channel,
// probed, compared and deleted; numbers and verdicts answered, counts
// logged. Against a fake that keeps texts as Telegram parses them it agrees;
// against one that keeps the HTML as sent it says where the texts part,
// which is what the owner's run against Telegram itself settles.
import { describe, expect, it } from 'vitest';
import { sql, type SqlDb } from './db/sql';
import { fakeBotApi } from '../test/fakes/bot-api';
import { recordingLogger } from '../test/fakes/logger';
import { privateMessage } from '../test/support/updates';
import { IDS, TEST_VARIABLES } from '../test/support/variables';
import { postKeyboard } from './broadcast/post';
import { PROBE_KEYBOARDS } from './broadcast/attach';
import { countingDb, createProbe, FIDELITY_PATH, FIDELITY_REPORT_ID, fidelitySamples, type ProbeTally } from './probe';
import { DEFAULT_LINK_HOSTS } from './config/schema';
import { FSI } from './telegram/render';
import { SECRET_HEADER } from './telegram/webhook';
import type { Env } from './worker';

/** A D1 stand-in with no rows: every read empty, every write changing nothing. */
const emptyD1 = (): D1Database => {
  const statement = {
    bind: () => statement,
    all: () => Promise.resolve({ results: [], success: true, meta: {} }),
    first: () => Promise.resolve(null),
    run: () => Promise.resolve({ results: [], success: true, meta: { changes: 0 } }),
  };
  return { prepare: () => statement, batch: (statements: unknown[]) => Promise.resolve(statements.map(() => ({ results: [], success: true, meta: { changes: 0 } }))) } as unknown as D1Database;
};

const setup = (telegramTexts = false) => {
  const telegram = fakeBotApi({ telegramTexts, channelIds: [IDS.broadcastChannel] });
  const log = recordingLogger();
  const probe = createProbe(telegram.fetch, log.logger);
  const waited: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => void waited.push(promise), passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
  const env = { ...TEST_VARIABLES, DB: emptyD1() } as unknown as Env;
  return { telegram, log, probe, waited, ctx, env };
};

describe('countingDb', () => {
  it('counts every call of the port, a batch as one', async () => {
    const tally: ProbeTally = { queries: 0, apiCalls: 0 };
    const calls: string[] = [];
    const inner: SqlDb = {
      run: () => (calls.push('run'), Promise.resolve({ changes: 0 })),
      all: () => (calls.push('all'), Promise.resolve([])),
      first: () => (calls.push('first'), Promise.resolve(null)),
      batch: () => (calls.push('batch'), Promise.resolve([])),
    };
    const db = countingDb(inner, tally);
    await db.run(sql`SELECT 1`);
    await db.all(sql`SELECT 1`);
    await db.first(sql`SELECT 1`);
    await db.batch([{ sql: sql`SELECT 1`, params: [] }, { sql: sql`SELECT 2`, params: [] }]);
    expect(tally).toEqual({ queries: 4, apiCalls: 0 });
    expect(calls).toEqual(['run', 'all', 'first', 'batch']);
  });
});

describe('the probe', () => {
  it('counts one webhook update through the real boundary, and logs the counts once its work is done', async () => {
    const { telegram, log, probe, waited, ctx, env } = setup();
    const request = new Request(`https://div-report-probe.test/${TEST_VARIABLES.WEBHOOK_PATH_SEGMENT}`, {
      method: 'POST',
      headers: { [SECRET_HEADER]: TEST_VARIABLES.WEBHOOK_SECRET },
      body: JSON.stringify(privateMessage(IDS.reporter, '/start')),
    });
    const response = await probe.fetch?.(request as Parameters<NonNullable<typeof probe.fetch>>[0], env, ctx);
    expect(response?.status).toBe(200);
    await Promise.all(waited);
    // /start: the lockdown read, then the deletion and the reply.
    expect(telegram.calls.map((call) => call.method)).toEqual(['deleteMessage', 'sendMessage']);
    expect(log.records()).toEqual([{ level: 'info', event: 'probe.invocation', queries: 1, apiCalls: 2 }]);
  });

  it('counts a request the boundary refuses as nothing', async () => {
    const { log, probe, waited, ctx, env } = setup();
    const response = await probe.fetch?.(new Request('https://div-report-probe.test/', { method: 'POST' }), env, ctx);
    expect(response?.status).toBe(404);
    await Promise.all(waited);
    expect(log.records()).toEqual([{ level: 'info', event: 'probe.invocation', queries: 0, apiCalls: 0 }]);
  });

  it('counts one cron run against an empty store', async () => {
    const { log, probe, waited, ctx, env } = setup();
    await probe.scheduled?.(
      { cron: '* * * * *', scheduledTime: Date.UTC(2027, 0, 15, 12, 1), noRetry: () => undefined },
      env,
      ctx,
    );
    await Promise.all(waited);
    // The state, the due post and the due edit jobs: nothing more on a quiet minute.
    expect(log.records()).toEqual([{ level: 'info', event: 'probe.invocation', queries: 3, apiCalls: 0 }]);
  });
});

/** The request type the probe's fetch handler takes. */
type ProbeRequest = Parameters<NonNullable<ReturnType<typeof createProbe>['fetch']>>[0];

describe("the probe's fidelity check", () => {
  const request = (secret: string | null = TEST_VARIABLES.WEBHOOK_SECRET, path = `${TEST_VARIABLES.WEBHOOK_PATH_SEGMENT}/${FIDELITY_PATH}`): ProbeRequest =>
    new Request(`https://div-report-probe.test/${path}`, { method: 'POST', headers: secret === null ? {} : { [SECRET_HEADER]: secret } });

  it('has two bilingual samples, Persian first, with code lines and each of the named entities', () => {
    const samples = fidelitySamples(DEFAULT_LINK_HOSTS);
    expect(samples.map((sample) => sample.name)).toEqual(['x', 'telegram']);
    for (const { html } of samples) {
      expect(html).toContain('<code>');
      expect(html).toContain(FSI);
      for (const entity of ['&amp;', '&lt;', '&gt;', '&quot;']) expect(html).toContain(entity);
      expect(html.search(/[\u0600-\u06ff]/)).toBeLessThan(html.search(/Report|Points/));
    }
  });

  it('sends each sample to the channel, probes it as /attach does, compares, deletes it, and answers the verdicts', async () => {
    const { telegram, log, probe, ctx, env } = setup(true);
    const response = await probe.fetch?.(request(), env, ctx);
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as { checkedAt: string; samples: { name: string; samePlainText: boolean; firstDifference: number | null }[] };
    expect(body.samples.map(({ name, samePlainText, firstDifference }) => ({ name, samePlainText, firstDifference }))).toEqual([
      { name: 'x', samePlainText: true, firstDifference: null },
      { name: 'telegram', samePlainText: true, firstDifference: null },
    ]);
    expect(Number.isNaN(Date.parse(body.checkedAt))).toBe(false);
    expect(telegram.calls.map((call) => [call.method, call.chatId])).toEqual(
      Array.from({ length: 2 }, () => [
        ['sendMessage', IDS.broadcastChannel],
        ['editMessageReplyMarkup', IDS.broadcastChannel],
        ['deleteMessage', IDS.broadcastChannel],
      ]).flat(),
    );
    expect(telegram.callsOf('sendMessage')[0]?.payload.reply_markup).toEqual(postKeyboard(FIDELITY_REPORT_ID));
    expect(telegram.callsOf('editMessageReplyMarkup')[0]?.payload.reply_markup).toEqual(PROBE_KEYBOARDS[0]);
    expect(telegram.messagesIn(IDS.broadcastChannel)).toEqual([]);
    expect(log.records()).toEqual([{ level: 'info', event: 'probe.fidelity', count: 2, failed: 0 }]);
  });

  it('says where the texts part when Telegram keeps another text, with numbers only', async () => {
    const { log, probe, ctx, env } = setup(false);
    const response = await probe.fetch?.(request(), env, ctx);
    const text = (await response?.text()) ?? '';
    const body = JSON.parse(text) as { samples: { samePlainText: boolean; firstDifference: number | null }[] };
    expect(body.samples.map((sample) => sample.samePlainText)).toEqual([false, false]);
    expect(body.samples.map((sample) => sample.firstDifference)).toEqual([0, 0]);
    expect(text).not.toContain('x.com');
    expect(text).not.toContain('somechannel');
    expect(log.records()).toEqual([{ level: 'info', event: 'probe.fidelity', count: 0, failed: 2 }]);
  });

  it('runs only for a POST to its path with the secret: anything else goes to the Worker', async () => {
    for (const [secret, path] of [
      [null, undefined],
      ['wrong-secret-value', undefined],
      [TEST_VARIABLES.WEBHOOK_SECRET, `${TEST_VARIABLES.WEBHOOK_PATH_SEGMENT}/elsewhere`],
      [TEST_VARIABLES.WEBHOOK_SECRET, FIDELITY_PATH],
    ] as const) {
      const { telegram, probe, ctx, env } = setup(true);
      const response = await probe.fetch?.(request(secret, path), env, ctx);
      expect(response?.status, String(path)).toBe(404);
      expect(telegram.calls, String(path)).toEqual([]);
    }
  });

  it('answers 502 and logs the failure by class when the Bot API refuses a call', async () => {
    const { telegram, log, probe, ctx, env } = setup(true);
    telegram.fail({ method: 'sendMessage' }, { kind: 'error', errorCode: 403, description: 'Forbidden: bot is not a member of the channel chat' });
    const response = await probe.fetch?.(request(), env, ctx);
    expect(response?.status).toBe(502);
    expect(log.records()).toEqual([{ level: 'error', event: 'probe.fidelity', errorClass: 'GrammyError', telegramErrorCode: 403, apiMethod: 'sendMessage' }]);
  });
});

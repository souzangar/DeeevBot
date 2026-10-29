// Workers tier: the Worker entry (src/worker.ts) in the Workers runtime,
// with the local D1 binding and the test deployment's variables
// (vitest.config.ts). It replaces Phase 2's smoke test and keeps its
// contract: everything but an authentic webhook request is answered 404
// with an empty body.
// - Through SELF, the deployed shape: off-path requests and a missing,
//   wrong or equal-length wrong secret are 404 (node:crypto's
//   timingSafeEqual and createHash run under nodejs_compat here); an
//   authentic request is 200. The authentic updates sent this way are ones
//   the bot drops without a call, since SELF's outbound fetch is the real
//   network.
// - Through createWorker() with the fake Bot API, the same handler on the
//   real D1: /start is deleted on receipt and the reply leaves with
//   previews off and HTML; a keyholder's
//   /lockdown writes the switch to D1, intake then answers the neutral
//   text, /unlock clears it; and a press is counted in one D1 batch, which
//   relies on SQLite's changes() between the batch's two statements on D1.
import { applyD1Migrations, createExecutionContext, SELF, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { d1SqlDb } from '../../src/db/d1';
import { randomId } from '../../src/db/ids';
import { sql } from '../../src/db/sql';
import { t } from '../../src/i18n/index';
import { SECRET_HEADER } from '../../src/telegram/webhook';
import { markData } from '../../src/telegram/presses';
import { createWorker, type Env } from '../../src/worker';
import { fakeBotApi } from '../fakes/bot-api';
import { recordingLogger } from '../fakes/logger';
import { buttonPress, groupMessage, privateMessage } from '../support/updates';
import { IDS, TEST_VARIABLES } from '../support/variables';

const ORIGIN = 'https://div-report.test';
const PATH = `${ORIGIN}/${TEST_VARIABLES.WEBHOOK_PATH_SEGMENT}`;
const SECRET = TEST_VARIABLES.WEBHOOK_SECRET;
const db = d1SqlDb(env.DB);

const authentic = (update: unknown, secret: string | null = SECRET, url = PATH): RequestInit & { url: string } => ({
  url,
  method: 'POST',
  headers: secret === null ? {} : { [SECRET_HEADER]: secret },
  body: JSON.stringify(update),
});

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await db.run(sql`DELETE FROM meta WHERE key IN ('lockdown', 'lockdown_alerted_at')`);
});

describe('the test deployment', () => {
  it('runs on the variables of test/support/variables.ts, as vitest.config.ts writes them out', () => {
    const bindings = env as unknown as Readonly<Record<string, unknown>>;
    for (const [name, value] of Object.entries(TEST_VARIABLES)) expect(bindings[name], name).toBe(value);
  });
});

describe('the Worker through SELF', () => {
  it.each([
    ['GET', `${ORIGIN}/`],
    ['POST', `${ORIGIN}/webhook`],
    ['GET', PATH],
    ['POST', `${PATH}/`],
    ['POST', `${PATH}/more`],
  ])('answers %s %s with 404 and an empty body', async (method, url) => {
    const response = await SELF.fetch(url, { method, headers: { [SECRET_HEADER]: SECRET }, ...(method === 'POST' ? { body: '{}' } : {}) });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
  });

  it.each([
    ['no secret header', null],
    ['an empty secret header', ''],
    ['a wrong secret of the same length', 'X'.repeat(SECRET.length)],
    ['the secret with one character changed', `${SECRET.slice(0, -1)}X`],
    ['a longer secret', `${SECRET}-more`],
  ])('answers %s with 404 and an empty body', async (_label, secret) => {
    const { url, ...init } = authentic({ update_id: 1 }, secret);
    const response = await SELF.fetch(url, init);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
  });

  it('answers an authentic request with 200 and an empty body', async () => {
    for (const update of [{ update_id: 2 }, groupMessage(IDS.membershipChat, IDS.reporter, 'hello')]) {
      const { url, ...init } = authentic(update);
      const response = await SELF.fetch(url, init);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('');
    }
  });
});

describe('the Worker entry with the fake Bot API, on D1', () => {
  /** Runs one request through createWorker(fake.fetch), waiting for its waitUntil work. */
  const run = async (update: unknown, environment: Env = env, secret: string | null = SECRET) => {
    const telegram = fakeBotApi({ channelIds: [IDS.broadcastChannel] });
    const log = recordingLogger();
    const handler = createWorker(telegram.fetch, log.logger).fetch;
    if (handler === undefined) throw new Error('the Worker has no fetch handler');
    const { url, ...init } = authentic(update, secret);
    const ctx = createExecutionContext();
    const response = await handler(new Request(url, init) as Parameters<typeof handler>[0], environment, ctx);
    await waitOnExecutionContext(ctx);
    return { response, telegram, log };
  };

  it("deletes /start on receipt and replies with previews off and HTML, in the reader's own chat", async () => {
    const update = privateMessage(IDS.reporter, '/start', { languageCode: 'fa' });
    const { response, telegram } = await run(update);
    expect(response.status).toBe(200);
    expect(telegram.calls).toEqual([
      {
        method: 'deleteMessage',
        chatId: IDS.reporter,
        payload: { chat_id: IDS.reporter, message_id: update.message?.message_id },
      },
      {
        method: 'sendMessage',
        chatId: IDS.reporter,
        payload: {
          chat_id: IDS.reporter,
          text: t('fa', 'start.intro'),
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        },
      },
    ]);
    expect(telegram.foreignRequests).toEqual([]);
  });

  it('makes no Bot API call for a wrong secret', async () => {
    const { response, telegram } = await run(privateMessage(IDS.reporter, '/start'), env, 'wrong-secret-value');
    expect(response.status).toBe(404);
    expect(telegram.calls).toEqual([]);
  });

  it("takes a keyholder's /lockdown into D1, answers intake neutrally, and lifts it on /unlock", async () => {
    await run(privateMessage(IDS.keyholder, '/lockdown'));
    expect(await db.first(sql`SELECT count(*) AS locked FROM meta WHERE key = 'lockdown'`)).toEqual({ locked: 1 });
    const locked = await run(privateMessage(IDS.reporter, 'https://www.instagram.com/reported.account/'));
    expect(locked.telegram.callsOf('sendMessage').map((call) => call.payload.text)).toEqual([t('en', 'lockdown.unavailable')]);
    await run(privateMessage(IDS.admin, '/unlock'));
    expect(await db.first(sql`SELECT count(*) AS locked FROM meta WHERE key = 'lockdown'`)).toEqual({ locked: 1 });
    await run(privateMessage(IDS.keyholder, '/unlock'));
    expect(await db.first(sql`SELECT count(*) AS locked FROM meta WHERE key = 'lockdown'`)).toEqual({ locked: 0 });
  });

  it('counts a press on D1: both rows in one batch, and the day row only when the report row changed', async () => {
    const id = randomId();
    const now = Date.now();
    await db.run(
      sql`INSERT INTO reports (id, status, platform, category, created_at, posting_started_at, posted_at, post_message_id) VALUES (?, 'posted', 'instagram', 'harassment', ?, ?, ?, ?)`,
      [id, now - 120_000, now - 60_000, now - 60_000, 9001],
    );
    const day = new Date(Date.now()).toISOString().slice(0, 10);
    const before = (await db.first<{ count: number }>(sql`SELECT count FROM counters WHERE day = ? AND key = 'presses'`, [day]))?.count ?? 0;
    const counted = await run(buttonPress(IDS.reporter, markData(id), { chatId: IDS.broadcastChannel, messageId: 9001 }));
    expect(counted.telegram.calls.map((call) => call.method)).toEqual(['answerCallbackQuery']);
    await run(buttonPress(IDS.reporter, markData(id), { chatId: IDS.broadcastChannel, messageId: 9002 }));
    await run(buttonPress(IDS.reporter, markData(randomId()), { chatId: IDS.broadcastChannel, messageId: 9001 }));
    expect(await db.first(sql`SELECT presses FROM reports WHERE id = ?`, [id])).toEqual({ presses: 1 });
    expect(await db.first(sql`SELECT count FROM counters WHERE day = ? AND key = 'presses'`, [day])).toEqual({
      count: before + 1,
    });
  });

  it('answers 500 with no bot and no Bot API call when the configuration does not load', async () => {
    const { response, telegram, log } = await run(privateMessage(IDS.reporter, '/start'), { DB: env.DB });
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('');
    expect(telegram.calls).toEqual([]);
    expect(log.records()).toEqual([{ level: 'error', event: 'config.invalid', errorClass: 'AppError', errorCode: 'CONFIG_INVALID' }]);
  });
});

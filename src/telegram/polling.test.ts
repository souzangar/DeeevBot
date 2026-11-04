// Unit tests for the Node port's long polling (src/telegram/polling.ts;
// critical invariant 2, and rule 6 for its logging), over the fake Bot
// API's long polling through grammY's real client and the runner: what
// each getUpdates asks for; every update handed to the bot, concurrently,
// so a handler that waits holds back no other update; stop() aborting the
// held getUpdates and waiting for the updates still being handled; a
// failed getUpdates logged by class and retried; a 401 or another poller's
// 409 ending polling as failed, logged; a webhook's 409 ending it as a
// yield, the keyholders alerted in both locales first (a miss logged, the
// yield unchanged); a handler's failure logged by class, never the update;
// and nothing written to the console on any of these paths.
import { BotError, GrammyError, type Context } from 'grammy';
import type { Update } from 'grammy/types';
import { describe, expect, it, vi } from 'vitest';
import { FAILURES, fakeBotApi, type FakeBotApi } from '../../test/fakes/bot-api';
import { recordingLogger } from '../../test/fakes/logger';
import { testConfig } from '../../test/support/config';
import { IDS } from '../../test/support/variables';
import { t } from '../i18n/index';
import type { Logger } from '../privacy/logger';
import { createBotApi } from './api';
import { ALLOWED_UPDATES, LONG_POLL_SECONDS, POLL_TIMEOUT_SECONDS, startPolling, type Polling } from './polling';
import type { UpdateHandler } from './webhook';

const REPORTED_URL = 'https://www.instagram.com/reported.account/';
const CONSOLE_METHODS = ['log', 'error', 'warn', 'info', 'debug'] as const;

const update = (id: number): Update => ({ update_id: id });

/** A bot that records the updates it is handed; the ids in `held` wait for release(id). */
const recordingBot = (held: readonly number[] = []) => {
  const started: number[] = [];
  const finished: number[] = [];
  const releases = new Map<number, () => void>();
  const bot: UpdateHandler = {
    handleUpdate: async (incoming) => {
      started.push(incoming.update_id);
      if (held.includes(incoming.update_id)) {
        await new Promise<void>((resolve) => releases.set(incoming.update_id, resolve));
      }
      finished.push(incoming.update_id);
    },
  };
  return {
    bot,
    started,
    finished,
    release: (id: number) => {
      releases.get(id)?.();
    },
  };
};

/** Polling's deps over `telegram`: the polling client, and the bot's own client and the configuration for the alert. */
const pollingDeps = (telegram: FakeBotApi, bot: UpdateHandler, logger: Logger) => {
  const config = testConfig();
  return {
    api: createBotApi(config, telegram.fetch, { timeoutSeconds: POLL_TIMEOUT_SECONDS }),
    bot,
    logger,
    alerts: { api: createBotApi(config, telegram.fetch), config },
  };
};

/** Polling over a fresh fake; `prepare` scripts the fake before the first getUpdates goes out. */
const setup = (bot: UpdateHandler, prepare: (telegram: FakeBotApi) => void = () => undefined) => {
  const telegram = fakeBotApi();
  prepare(telegram);
  const log = recordingLogger();
  const polling = startPolling(pollingDeps(telegram, bot, log.logger));
  return { telegram, log, polling };
};

/** Stops polling at the end of a test, whatever happened. */
const stopped = async (polling: Polling): Promise<void> => {
  await polling.stop();
};

describe('long polling', () => {
  it('asks for message and callback_query only, LONG_POLL_SECONDS a call, from past the last update fetched', async () => {
    const spy = recordingBot();
    const { telegram, polling } = setup(spy.bot);
    try {
      await vi.waitFor(() => expect(telegram.waitingForUpdates()).toBe(1));
      telegram.queueUpdates(update(41), update(42));
      await vi.waitFor(() => expect(spy.finished).toEqual([41, 42]));
      await vi.waitFor(() => expect(telegram.waitingForUpdates()).toBe(1));
      const asked = telegram.callsOf('getUpdates').map((call) => call.payload);
      expect(asked[0]).toMatchObject({ offset: 0, timeout: LONG_POLL_SECONDS, allowed_updates: ['message', 'callback_query'] });
      expect(asked.at(-1)).toMatchObject({ offset: 43, timeout: LONG_POLL_SECONDS, allowed_updates: ['message', 'callback_query'] });
      expect([...ALLOWED_UPDATES]).toEqual(['message', 'callback_query']);
      expect(POLL_TIMEOUT_SECONDS).toBeGreaterThan(LONG_POLL_SECONDS);
      expect(telegram.calls.map((call) => call.method).filter((method) => method !== 'getUpdates')).toEqual([]);
    } finally {
      await stopped(polling);
    }
  });

  it('handles updates concurrently: a second update is handled while the first one\'s handler still waits', async () => {
    const spy = recordingBot([1]);
    const { telegram, polling } = setup(spy.bot);
    try {
      telegram.queueUpdates(update(1), update(2));
      await vi.waitFor(() => expect(spy.finished).toEqual([2]));
      expect(spy.started).toEqual([1, 2]);
      expect(polling.inFlight()).toBe(1);
      // The next update is fetched and handled while update 1 still waits.
      telegram.queueUpdates(update(3));
      await vi.waitFor(() => expect(spy.finished).toEqual([2, 3]));
      spy.release(1);
      await vi.waitFor(() => expect(spy.finished).toEqual([2, 3, 1]));
      expect(polling.inFlight()).toBe(0);
    } finally {
      await stopped(polling);
    }
  });

  it('stop() aborts the held getUpdates, fetches nothing more, and waits for the updates still being handled', async () => {
    const spy = recordingBot([5]);
    const { telegram, polling } = setup(spy.bot);
    telegram.queueUpdates(update(5));
    await vi.waitFor(() => expect(spy.started).toEqual([5]));
    await vi.waitFor(() => expect(telegram.waitingForUpdates()).toBe(1));
    let done = false;
    const stopping = polling.stop().then(() => {
      done = true;
    });
    await vi.waitFor(() => expect(telegram.waitingForUpdates()).toBe(0));
    expect(done).toBe(false);
    spy.release(5);
    await stopping;
    expect(spy.finished).toEqual([5]);
    expect(await polling.ended).toBe('stopped');
    const asked = telegram.count('getUpdates');
    telegram.queueUpdates(update(6));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(telegram.count('getUpdates')).toBe(asked);
    expect(spy.started).toEqual([5]);
  });

  it('logs a failed getUpdates by class and fetches again', async () => {
    const spy = recordingBot();
    const { telegram, log, polling } = setup(spy.bot, (fake) => {
      fake.fail({ method: 'getUpdates' }, FAILURES.serverError, 1);
      fake.fail({ method: 'getUpdates' }, FAILURES.networkFailure, 1);
    });
    try {
      await vi.waitFor(() => expect(telegram.waitingForUpdates()).toBe(1));
      expect(telegram.count('getUpdates')).toBe(3);
      telegram.queueUpdates(update(9));
      await vi.waitFor(() => expect(spy.finished).toEqual([9]));
      expect(log.records()).toEqual([
        { level: 'error', event: 'polling.failed', apiMethod: 'getUpdates', errorClass: 'GrammyError', telegramErrorCode: 502 },
        { level: 'error', event: 'polling.failed', apiMethod: 'getUpdates', errorClass: 'HttpError' },
      ]);
    } finally {
      await stopped(polling);
    }
  });

  it.each([
    ['a 409: another getUpdates on the token', FAILURES.conflict, 409],
    ['a 401: the token refused', FAILURES.unauthorized, 401],
  ])('ends polling on %s: `ended` resolves failed, logged by class, nobody alerted', async (_label, outcome, code) => {
    const spy = recordingBot();
    const telegram = fakeBotApi();
    telegram.fail({ method: 'getUpdates' }, outcome, 1);
    const log = recordingLogger();
    const polling = startPolling(pollingDeps(telegram, spy.bot, log.logger));
    expect(await polling.ended).toBe('failed');
    expect(log.records()).toEqual([
      { level: 'error', event: 'polling.failed', apiMethod: 'getUpdates', errorClass: 'GrammyError', telegramErrorCode: code },
      { level: 'error', event: 'polling.stopped', errorClass: 'GrammyError', telegramErrorCode: code, apiMethod: 'getUpdates' },
    ]);
    expect(telegram.calls.map((call) => call.method)).toEqual(['getUpdates']);
    await polling.stop();
    expect(telegram.count('getUpdates')).toBe(1);
  });

  it("yields to a webhook set meanwhile (its 409): the keyholders alerted in both locales before `ended` resolves 'webhook'", async () => {
    const spy = recordingBot();
    const telegram = fakeBotApi();
    telegram.fail({ method: 'getUpdates' }, FAILURES.webhookActive, 1);
    const log = recordingLogger();
    const polling = startPolling(pollingDeps(telegram, spy.bot, log.logger));
    expect(await polling.ended).toBe('webhook');
    const alert = `${t('fa', 'alert.port_yielded')}\n\n${t('en', 'alert.port_yielded')}`;
    expect(telegram.callsOf('sendMessage').map((call) => [call.chatId, call.payload.text])).toEqual([
      [IDS.keyholder, alert],
      [IDS.secondKeyholder, alert],
    ]);
    expect(telegram.callsOf('sendMessage')[0]?.payload).toMatchObject({ link_preview_options: { is_disabled: true }, parse_mode: 'HTML' });
    expect(log.records()).toEqual([
      { level: 'error', event: 'polling.failed', apiMethod: 'getUpdates', errorClass: 'GrammyError', telegramErrorCode: 409 },
      { level: 'error', event: 'polling.webhook_set', errorClass: 'GrammyError', telegramErrorCode: 409, apiMethod: 'getUpdates' },
      { level: 'info', event: 'polling.webhook_alerted', sent: 2, failed: 0 },
    ]);
    await polling.stop();
    expect(telegram.count('getUpdates')).toBe(1);
  });

  it('yields all the same when the alert reaches no keyholder, logging each miss by class', async () => {
    const telegram = fakeBotApi();
    telegram.fail({ method: 'getUpdates' }, FAILURES.webhookActive, 1);
    telegram.fail({ method: 'sendMessage' }, FAILURES.botBlocked);
    const log = recordingLogger();
    const polling = startPolling(pollingDeps(telegram, recordingBot().bot, log.logger));
    expect(await polling.ended).toBe('webhook');
    expect(log.records().slice(2)).toEqual([
      { level: 'error', event: 'alert.failed', errorClass: 'GrammyError', telegramErrorCode: 403, apiMethod: 'sendMessage' },
      { level: 'error', event: 'alert.failed', errorClass: 'GrammyError', telegramErrorCode: 403, apiMethod: 'sendMessage' },
      { level: 'info', event: 'polling.webhook_alerted', sent: 0, failed: 2 },
    ]);
    expect(log.text()).not.toContain(String(IDS.keyholder));
    await polling.stop();
  });

  it("logs a handler's failure by class, never the update or the payload, and goes on", async () => {
    const handled: number[] = [];
    const bot: UpdateHandler = {
      handleUpdate: (incoming) => {
        handled.push(incoming.update_id);
        if (incoming.update_id === 11) {
          return Promise.reject(
            new BotError(
              new GrammyError("Call to 'sendMessage' failed!", { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }, 'sendMessage', {
                chat_id: IDS.reporter,
                text: `Report ${REPORTED_URL} now`,
              }),
              {} as Context,
            ),
          );
        }
        return Promise.resolve();
      },
    };
    const { telegram, log, polling } = setup(bot);
    try {
      telegram.queueUpdates({ update_id: 11, message: { text: REPORTED_URL } } as unknown as Update);
      await vi.waitFor(() => expect(log.records()).toHaveLength(1));
      telegram.queueUpdates(update(12));
      await vi.waitFor(() => expect(handled).toEqual([11, 12]));
      expect(log.records()).toEqual([
        { level: 'error', event: 'update.failed', errorClass: 'GrammyError', telegramErrorCode: 403, apiMethod: 'sendMessage' },
      ]);
      expect(log.text()).not.toContain('instagram');
      expect(log.text()).not.toContain(String(IDS.reporter));
    } finally {
      await stopped(polling);
    }
  });

  it('writes nothing to the console: a failed fetch, the end by a 409 and a failing handler alike', async () => {
    const spies = CONSOLE_METHODS.map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    try {
      const bot: UpdateHandler = { handleUpdate: () => Promise.reject(new TypeError(`a ${REPORTED_URL}`)) };
      const telegram = fakeBotApi();
      telegram.fail({ method: 'getUpdates' }, FAILURES.serverError, 1);
      const log = recordingLogger();
      const polling = startPolling(pollingDeps(telegram, bot, log.logger));
      await vi.waitFor(() => expect(telegram.waitingForUpdates()).toBe(1));
      telegram.queueUpdates(update(21));
      await vi.waitFor(() => expect(log.records().map((record) => record.event)).toEqual(['polling.failed', 'update.failed']));
      telegram.fail({ method: 'getUpdates' }, FAILURES.conflict, 1);
      telegram.queueUpdates(update(22));
      expect(await polling.ended).toBe('failed');
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

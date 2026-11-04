// @critical-path
// The Node port's update source (critical invariant 2: an update is acted
// on only if it provably came from Telegram; ADR 0003): long polling, the
// port's counterpart of the Worker's webhook boundary
// (src/telegram/webhook.ts). An update fetched with `getUpdates` came from
// Telegram by construction: the request goes to api.telegram.org under the
// bot's token and the answer is what Telegram holds for the bot. Each one
// goes to the bot the port composed exactly as the Worker does
// (createBot(deps, defaultFeatures(deps)), src/node.ts), so every gate, the
// allowlists and the lockdown check included, applies to it unchanged.
//
// - grammY's runner (@grammyjs/runner) fetches and hands the updates on.
//   Each update is handled as it arrives, CONCURRENTLY, never after the one
//   before it: the intake waits up to 25 seconds inside its handler for its
//   acknowledgement's self-deletion (src/telegram/intake.ts), and a
//   sequential loop would hold every other update that long. At most
//   POLL_CONCURRENCY updates are handled at once (the runner's own default,
//   stated); past it the runner fetches fewer.
// - The offset moves past an update as soon as it is fetched, so Telegram
//   never sends it again, as the webhook's 200 at once does; a handler that
//   fails is not retried, and every handler is idempotent per update.
// - Its own client: the bot's gives up after BOT_TIMEOUT_SECONDS
//   (src/telegram/api.ts), which would cut every long poll; this one waits
//   LONG_POLL_SECONDS on Telegram's side and gives up after
//   POLL_TIMEOUT_SECONDS. It asks for `message` and `callback_query` only,
//   as the webhook is registered (ADR 0003).
// - Logging, through the redacting logger only: the runner's own console
//   lines are switched off (`silent`); a failed getUpdates is logged by
//   class (`polling.failed`) and retried after a wait that grows by 100 ms
//   a time (the runner's 'quadratic' interval: linear, so a long outage
//   leaves no hour-long wait behind once the network is back, unlike its
//   doubling default); a handler's failure that escapes the bot's error
//   boundary is logged by class (`update.failed`), the error inside
//   grammY's BotError, never the update. This error handler never throws:
//   the runner would print what it threw to the console.
// - The end, told apart by Telegram's answer (src/telegram/errors.ts):
//   - a 409 "webhook is active": a webhook was set for the bot, so Telegram
//     now sends the updates there. Polling ends, logged
//     `polling.webhook_set`; the keyholders are sent the catalog's fixed
//     alert (`alert.port_yielded`, both locales, Persian first) before
//     `ended` resolves 'webhook', and the port yields: it stops with exit
//     code 0 and stays stopped (src/node.ts), so its start, which deletes
//     the webhook, never takes the bot back from the Worker in a loop. An
//     alert that reaches nobody is logged and ends nothing;
//   - a 401 (the token revoked or re-issued), a 409 "terminated by other
//     getUpdates request" (another poller on the token), or failures past
//     POLL_MAX_RETRY_MS: `ended` resolves 'failed', logged
//     `polling.stopped`, and the port stops with exit code 1.
// - stop(): aborts the pending getUpdates, then waits for every update
//   still being handled; `ended` resolves 'stopped'.
import { run } from '@grammyjs/runner';
import { BotError, type Api } from 'grammy';
import type { Update } from 'grammy/types';
import { inBothLocales } from '../broadcast/report-alerts';
import { t } from '../i18n/index';
import type { Logger } from '../privacy/logger';
import { alertKeyholders, type AlertDeps } from './alerts';
import { classifyTelegramError } from './errors';
import type { UpdateHandler } from './webhook';

/** How long Telegram holds a getUpdates open while it has nothing, in seconds. */
export const LONG_POLL_SECONDS = 30;

/** How long the polling client waits for one getUpdates, in seconds: the long poll and a margin. */
export const POLL_TIMEOUT_SECONDS = LONG_POLL_SECONDS + 10;

/** The update kinds the bot asks for, as the webhook is registered (ADR 0003). */
export const ALLOWED_UPDATES = Object.freeze(['message', 'callback_query'] as const);

/** The most updates handled at once: the runner's own default, stated. */
export const POLL_CONCURRENCY = 500;

/** How long getUpdates may keep failing before polling ends: the runner's own default, stated. */
export const POLL_MAX_RETRY_MS = 15 * 60 * 60_000;

export interface PollingDeps {
  /** The polling client: createBotApi(config, fetch, { timeoutSeconds: POLL_TIMEOUT_SECONDS }). */
  readonly api: Pick<Api, 'getUpdates'>;
  /** The bot: createBot(deps, defaultFeatures(deps)), as on the Worker. */
  readonly bot: UpdateHandler;
  readonly logger: Logger;
  /** The keyholders' alert when a webhook ends polling: the bot's own client and the configuration. */
  readonly alerts: Pick<AlertDeps, 'api' | 'config'>;
}

/**
 * How polling ended: stopped by stop(); ended by a webhook set meanwhile,
 * the keyholders alerted; or failed by itself (see the header).
 */
export type PollingEnd = 'stopped' | 'webhook' | 'failed';

export interface Polling {
  /** Resolves once polling has ended, never rejects. */
  readonly ended: Promise<PollingEnd>;
  /** The updates being handled now. */
  inFlight(): number;
  /** Stops fetching and resolves once every update still being handled is done. */
  stop(): Promise<void>;
}

/** What grammY wraps a middleware failure in; its own error is the one logged. */
const unwrap = (error: unknown): unknown => (error instanceof BotError ? error.error : error);

/** Sends the keyholders the alert that the port yielded to a webhook (see the header). Never throws. */
async function alertWebhookSet(deps: PollingDeps): Promise<void> {
  try {
    const outcome = await alertKeyholders(
      { ...deps.alerts, logger: deps.logger },
      inBothLocales((locale) => t(locale, 'alert.port_yielded')),
    );
    deps.logger.log('polling.webhook_alerted', { sent: outcome.sent, failed: outcome.failed });
  } catch (error) {
    deps.logger.logError('alert.failed', error);
  }
}

/** Starts long polling (see the header): its first getUpdates goes out at once. */
export function startPolling(deps: PollingDeps): Polling {
  const handling = new Set<Promise<void>>();
  let stopping = false;

  /** Keeps `work` among the updates being handled until it settles; returns it as it is. */
  const track = (work: Promise<void>): Promise<void> => {
    const settled = work.then(
      () => undefined,
      () => undefined,
    );
    handling.add(settled);
    void settled.then(() => handling.delete(settled));
    return work;
  };

  const handle = run<Update, unknown>(
    {
      api: {
        getUpdates: async (args, signal) => {
          try {
            return await deps.api.getUpdates(
              { offset: args.offset, limit: args.limit, timeout: LONG_POLL_SECONDS, allowed_updates: [...ALLOWED_UPDATES] },
              signal,
            );
          } catch (error) {
            if (!signal.aborted) deps.logger.logError('polling.failed', error, { apiMethod: 'getUpdates' });
            throw error;
          }
        },
      },
      handleUpdate: (update) => track(deps.bot.handleUpdate(update)),
      errorHandler: (error) => {
        deps.logger.logError('update.failed', unwrap(error));
      },
    },
    {
      runner: { silent: true, retryInterval: 'quadratic', maxRetryTime: POLL_MAX_RETRY_MS },
      sink: { concurrency: POLL_CONCURRENCY },
    },
  );

  // The runner's task settles when polling ends: resolved after stop(),
  // rejected when it ended by itself.
  const ended: Promise<PollingEnd> = (handle.task() ?? Promise.resolve()).then(
    (): PollingEnd => 'stopped',
    async (error: unknown): Promise<PollingEnd> => {
      if (stopping) return 'stopped';
      if (classifyTelegramError(error).kind === 'webhook_active') {
        deps.logger.logError('polling.webhook_set', error);
        await alertWebhookSet(deps);
        return 'webhook';
      }
      deps.logger.logError('polling.stopped', error);
      return 'failed';
    },
  );

  return {
    ended,
    inFlight: () => handling.size,
    stop: async () => {
      stopping = true;
      // stop() hands back the task `ended` already waits on.
      void handle.stop();
      await ended;
      await Promise.all(handling);
    },
  };
}

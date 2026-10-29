// @critical-path
// The Worker entry (doc/architecture/adr-0001-runtime-and-hosting.md): the
// HTTP handler and the cron handler.
// - fetch: the webhook boundary (src/telegram/webhook.ts; ADR 0003): the
//   path and the constant-time secret check before any bot object exists
//   or the body is read, 404 with an empty body otherwise; then the update
//   goes to the bot, with the review in its slot of features
//   (defaultFeatures()), under waitUntil, and Telegram gets 200 at once. The
//   configuration comes from configFor(env), parsed once per env object; a
//   configuration that does not load is logged by class and answered 500,
//   with no bot and no body read, and Telegram keeps the update for later.
// - scheduled: the one cron, every minute (wrangler.jsonc; ADR 0004,
//   "Scheduling"). configFor(env) comes first, before anything else: no run
//   starts on a configuration that does not load (a DEBUG variable
//   included, which would switch on grammY's own logging), which is logged
//   by class, and nothing else happens. Then handleScheduled()
//   (src/broadcast/tick.ts) dispatches on the cron expression and hands the
//   run to the invocation's waitUntil; the run never throws. Its Bot API
//   client gives up on a request after SEND_TIMEOUT_SECONDS, so a post's
//   send has ended before /repost may touch the report.
// The Bot API's transport is the runtime's fetch; createWorker() takes
// another one so the workers tier can drive this very handler against the
// fake Bot API, and another store over the D1 binding (the deployed probe's
// counting one, src/probe.ts). The fetch is only ever handed to grammY's
// client, which calls api.telegram.org: a reported URL is never fetched.
import { SEND_TIMEOUT_SECONDS } from './broadcast/post';
import { handleScheduled } from './broadcast/tick';
import { systemClock } from './clock';
import { configFor } from './config/memo';
import type { Config } from './config/schema';
import { d1SqlDb } from './db/d1';
import type { SqlDb } from './db/sql';
import { consoleLogger, type Logger } from './privacy/logger';
import { isolateNotices } from './review/notify';
import { createBotApi } from './telegram/api';
import { createBot, defaultFeatures, type BotDeps } from './telegram/bot';
import { handleWebhook } from './telegram/webhook';

/** The bindings declared in wrangler.jsonc. Secrets are read through src/config/. */
export interface Env {
  readonly DB: D1Database;
}

export interface WorkerOptions {
  /** The store over the D1 binding: d1SqlDb() unless given. */
  readonly db?: (binding: D1Database) => SqlDb;
}

/** The Worker's handlers over `fetchImpl`, the Bot API's transport, logging to `logger`. */
export function createWorker(fetchImpl: typeof fetch, logger: Logger = consoleLogger, options: WorkerOptions = {}): ExportedHandler<Env> {
  const store = options.db ?? d1SqlDb;
  return {
    fetch: (request, env, ctx) => {
      let config: Config;
      try {
        config = configFor(env);
      } catch (error) {
        logger.logError('config.invalid', error);
        return new Response(null, { status: 500 });
      }
      return handleWebhook(request, ctx, {
        config,
        logger,
        bot: () => {
          const deps: BotDeps = { config, db: store(env.DB), clock: systemClock, logger, fetch: fetchImpl };
          return createBot(deps, defaultFeatures(deps));
        },
      });
    },
    scheduled: (controller, env, ctx) => {
      let config: Config;
      try {
        config = configFor(env);
      } catch (error) {
        logger.logError('config.invalid', error);
        return;
      }
      handleScheduled(controller, ctx, {
        api: createBotApi(config, fetchImpl, { timeoutSeconds: SEND_TIMEOUT_SECONDS }),
        config,
        db: store(env.DB),
        clock: systemClock,
        logger,
        notices: isolateNotices,
      });
    },
  };
}

export default createWorker(fetch);

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
// - scheduled: the one-minute job cron arrives with the scheduling unit
//   (ADR 0004, ADR 0006).
// The Bot API's transport is the runtime's fetch; createWorker() takes
// another one so the workers tier can drive this very handler against the
// fake Bot API. It is only ever handed to grammY's client, which calls
// api.telegram.org: a reported URL is never fetched.
import { systemClock } from './clock';
import { configFor } from './config/memo';
import type { Config } from './config/schema';
import { d1SqlDb } from './db/d1';
import { consoleLogger, type Logger } from './privacy/logger';
import { createBot, defaultFeatures, type BotDeps } from './telegram/bot';
import { handleWebhook } from './telegram/webhook';

/** The bindings declared in wrangler.jsonc. Secrets are read through src/config/. */
export interface Env {
  readonly DB: D1Database;
}

/** The Worker's handlers over `fetchImpl`, the Bot API's transport, logging to `logger`. */
export function createWorker(fetchImpl: typeof fetch, logger: Logger = consoleLogger): ExportedHandler<Env> {
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
          const deps: BotDeps = { config, db: d1SqlDb(env.DB), clock: systemClock, logger, fetch: fetchImpl };
          return createBot(deps, defaultFeatures(deps));
        },
      });
    },
    // The one-minute job cron arrives with the scheduling unit (U5).
    scheduled: (): void => undefined,
  };
}

export default createWorker(fetch);

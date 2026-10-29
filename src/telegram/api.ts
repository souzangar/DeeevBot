// @critical-path
// The Bot API adapter (the MVP plan, section 2, "Ports"; critical invariants
// 4 and 6): grammY's Api over an injected `fetch`, with the ONE transformer
// the project installs. Every sendMessage and editMessageText leaves with
// `link_preview_options: { is_disabled: true }` and `parse_mode: 'HTML'`,
// whatever its caller passed, so a message that carries a reported URL can
// never be sent with a preview, by construction (rule 4), and every catalog
// string, being Telegram HTML, is parsed as such.
//
// What the transformer does with a caller's own values:
// - `parse_mode`: always 'HTML'; a caller's 'HTML' is kept as it was, any
//   other mode is replaced.
// - `link_preview_options`: always exactly `{ is_disabled: true }`; a
//   caller's `{ is_disabled: true }` is kept as it was, and anything else is
//   replaced whole (a caller's false, and the `url`, `prefer_small_media`,
//   `prefer_large_media` and `show_above_text` fields, which mean nothing
//   once previews are off). Through the port (src/telegram/bot-api-port.ts)
//   a different value is a type error; through grammY's own methods,
//   ctx.reply among them, this runtime override is the guard.
// - every other field is passed through untouched, and the caller's object
//   is never mutated.
// Other methods pass through unchanged.
//
// No other transformer is installed: no @grammyjs/auto-retry, no throttler
// (ADR 0004 rejects retry bursts inside an invocation; ADR 0005 classifies
// failures instead). grammY's `sensitiveLogs` stays false, so an HttpError's
// message never carries the token URL. No webhook reply is ever used.
//
// The `fetch` is injected: the Worker passes the runtime's own, the Node
// port Node's, and the tests the fake Bot API (test/fakes/bot-api.ts). It
// is called for api.telegram.org only; a reported URL is never fetched.
import { Api, type ApiClientOptions, type Transformer } from 'grammy';
import type { Config } from '../config/schema';

/** The methods whose payloads the transformer enforces: the project's text sends and edits. */
export const ENFORCED_METHODS = ['sendMessage', 'editMessageText'] as const;

/** The link-preview setting every enforced payload carries. */
export const PREVIEWS_DISABLED = Object.freeze({ is_disabled: true as const });

const isEnforced = (method: string): boolean => (ENFORCED_METHODS as readonly string[]).includes(method);

/**
 * The payload as it leaves: the caller's fields, with `parse_mode` set to
 * 'HTML' and `link_preview_options` set to exactly `{ is_disabled: true }`.
 * A new object; the caller's is left as it was.
 */
export const enforceFormat = (payload: unknown): Record<string, unknown> => ({
  ...(typeof payload === 'object' && payload !== null ? payload : {}),
  parse_mode: 'HTML',
  link_preview_options: { ...PREVIEWS_DISABLED },
});

/** The one transformer: previews off and HTML parse mode on every enforced method. */
export const htmlWithoutPreviews: Transformer = (prev, method, payload, signal) =>
  isEnforced(method)
    ? prev(method, enforceFormat(payload) as unknown as typeof payload, signal)
    : prev(method, payload, signal);

/**
 * How long the bot's own client waits for one Bot API request, in seconds:
 * a handler's work runs under the webhook's waitUntil, which the runtime
 * ends about 30 seconds after the answer, so a probe of /attach and its
 * undo fit inside it (src/telegram/bot.ts).
 */
export const BOT_TIMEOUT_SECONDS = 10;

/**
 * The grammY client options every Api and Bot of the project is built with;
 * `timeoutSeconds` bounds each request when given (grammY's own default,
 * 500 seconds, otherwise). The scheduler's client takes a short one, so a
 * post's send has ended, one way or the other, long before /repost may
 * touch the report (src/broadcast/tick.ts), and the bot's client takes
 * BOT_TIMEOUT_SECONDS.
 */
export const clientOptions = (fetchImpl: typeof fetch, timeoutSeconds?: number): ApiClientOptions => ({
  fetch: fetchImpl,
  sensitiveLogs: false,
  ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
});

/** Installs the one transformer on `api`, once: a second call adds nothing. */
export function installTransformer(api: Api): Api {
  if (!api.config.installedTransformers().includes(htmlWithoutPreviews)) {
    api.config.use(htmlWithoutPreviews);
  }
  return api;
}

/** What a client may be built with besides its transport. */
export interface BotApiOptions {
  /** Each request's bound, in seconds (see clientOptions()). */
  readonly timeoutSeconds?: number;
}

/**
 * The project's Bot API client: grammY's Api for the configured token, over
 * `fetchImpl`, with the one transformer installed. It satisfies BotApiPort.
 */
export function createBotApi(config: Pick<Config, 'botToken'>, fetchImpl: typeof fetch, options: BotApiOptions = {}): Api {
  return installTransformer(new Api(config.botToken, clientOptions(fetchImpl, options.timeoutSeconds)));
}

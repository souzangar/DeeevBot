// @critical-path
// The webhook boundary (critical invariant 2: an update is acted on only if
// it provably came from Telegram; ADR 0003; ADR 0005, "Boundary"). In this
// order, and nothing before the checks:
// 1. the path: a POST to `/${WEBHOOK_PATH_SEGMENT}`; the random segment only
//    keeps scanners off the daily request budget, it is not the check;
// 2. the secret: the X-Telegram-Bot-Api-Secret-Token header against
//    WEBHOOK_SECRET, compared with node:crypto's timingSafeEqual over the
//    SHA-256 digests of both sides, so the compare takes the same time
//    whatever the header's length or content;
// an off-path request, a missing or wrong header, is answered 404 with an
// empty body before the body is read and before any bot object exists, so
// it costs no Bot API call and no parse;
// 3. the body: `await request.json()`; a body that is not an update object
//    is logged by class and answered 200, since Telegram would only send it
//    again;
// 4. the bot is built and `bot.handleUpdate(update)` handed to
//    `waitUntil`, its failure logged by class only (never the update); the
//    answer is 200 at once, so Telegram never redelivers an update because
//    of a slow or failing handler, and every handler is idempotent per
//    update but the press counter (src/telegram/presses.ts says why). grammY's webhookCallback is not used: it would read the body
//    and build the reply itself, and this order is the point.
import { createHash, timingSafeEqual } from 'node:crypto';
import { BotError } from 'grammy';
import type { Update } from 'grammy/types';
import type { Config } from '../config/schema';
import type { Logger } from '../privacy/logger';

/** The header Telegram sends the registered secret_token in. */
export const SECRET_HEADER = 'X-Telegram-Bot-Api-Secret-Token';

/** What the boundary needs of a bot: grammY's Bot is one. */
export interface UpdateHandler {
  handleUpdate(update: Update): Promise<void>;
}

export interface WebhookDeps {
  readonly config: Pick<Config, 'webhookPathSegment' | 'webhookSecret'>;
  readonly logger: Logger;
  /** Builds the bot: called only for a request that passed both checks. */
  readonly bot: () => UpdateHandler;
}

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/**
 * Whether `header` holds `secret`: timingSafeEqual over the SHA-256 digests,
 * which have the same length whatever the inputs. A missing header is
 * compared as the empty string, which never matches: the secret has 32 to
 * 256 characters.
 */
export const secretMatches = (header: string | null, secret: string): boolean =>
  timingSafeEqual(digest(header ?? ''), digest(secret));

/** Whether the request is a POST to the webhook's path; a URL that does not parse is not. */
export const onWebhookPath = (request: Request, segment: string): boolean => {
  if (request.method !== 'POST') return false;
  try {
    return new URL(request.url).pathname === `/${segment}`;
  } catch {
    return false;
  }
};

const isUpdate = (value: unknown): value is Update =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Number.isSafeInteger((value as { readonly update_id?: unknown }).update_id);

/** What grammY wraps a middleware failure in; its own error is the one logged. */
const unwrap = (error: unknown): unknown => (error instanceof BotError ? error.error : error);

const empty = (status: number): Response => new Response(null, { status });

/** The boundary of the header. Never throws. */
export async function handleWebhook(
  request: Request,
  executionCtx: Pick<ExecutionContext, 'waitUntil'>,
  deps: WebhookDeps,
): Promise<Response> {
  if (!onWebhookPath(request, deps.config.webhookPathSegment)) return empty(404);
  if (!secretMatches(request.headers.get(SECRET_HEADER), deps.config.webhookSecret)) return empty(404);

  let update: unknown;
  try {
    update = await request.json();
  } catch (error) {
    deps.logger.logError('update.unreadable', error);
    return empty(200);
  }
  if (!isUpdate(update)) {
    deps.logger.log('update.unreadable');
    return empty(200);
  }

  try {
    const bot = deps.bot();
    executionCtx.waitUntil(
      bot.handleUpdate(update).catch((error: unknown) => {
        deps.logger.logError('update.failed', unwrap(error));
      }),
    );
  } catch (error) {
    deps.logger.logError('update.failed', error);
  }
  return empty(200);
}

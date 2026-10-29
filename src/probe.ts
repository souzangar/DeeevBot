// @critical-path
// The deployed per-update probe (the MVP plan, section 7; ADR 0004, "The
// deployed probe"): a throwaway Worker entry the owner deploys once, under
// its own name, with its own bot, its own empty D1 database and its own
// secrets (wrangler.probe.jsonc), never with the bot's configuration and
// never by the code. It is the Worker itself, createWorker() of
// src/worker.ts with the same handlers, but every Bot API request and every
// D1 call is counted per invocation: after each invocation (one webhook
// update through the real boundary, one cron run) it logs ONE line,
// `probe.invocation`, with the invocation's D1 queries and Bot API calls,
// through the redacting logger: counts only, nothing of the update. The
// CPU time is the platform's own figure (the Worker's metrics, or wrangler
// tail), since a Worker cannot time its own CPU.
// Every D1 call goes through the SqlDb port, so counting the port counts
// them all (a batch is one query); every Bot API request goes through the
// fetch grammY's client is given.
//
// The one-time fidelity check of /attach's text comparison (ADR 0004, "The
// deployed probe", step 6): a POST to `/<WEBHOOK_PATH_SEGMENT>/fidelity`
// carrying the webhook's secret header (compared as the webhook compares
// it; anything else goes to the Worker, which answers it 404) sends each of
// FIDELITY_SAMPLES, a rendered bilingual post with code lines, Persian
// first, to BROADCAST_CHAT_ID (the probe's throwaway channel), probes it
// with editMessageReplyMarkup as /attach does, and checks samePlainText() of
// the text Telegram returns against the rendered post, then deletes the
// sample. It answers JSON with, per sample, the verdict, both lengths and
// the index of the first character that differs, numbers only, and logs
// `probe.fidelity` with the counts. Only the probe has this path: the bot's
// Worker never does.
import { PROBE_KEYBOARDS } from './broadcast/attach';
import { postKeyboard, SEND_TIMEOUT_SECONDS } from './broadcast/post';
import { configFor } from './config/memo';
import type { Config } from './config/schema';
import { d1SqlDb } from './db/d1';
import type { SqlDb } from './db/sql';
import { consoleLogger, type Logger } from './privacy/logger';
import { plainText, renderBilingualPost, samePlainText } from './review/render-post';
import { createBotApi } from './telegram/api';
import type { BotApiPort } from './telegram/bot-api-port';
import { onWebhookPath, SECRET_HEADER, secretMatches } from './telegram/webhook';
import { createWorker, type Env } from './worker';

/** The fidelity check's path, below the webhook's segment. */
export const FIDELITY_PATH = 'fidelity';

/** The report id the samples' buttons carry: no report has it. */
export const FIDELITY_REPORT_ID = 'fidelitysamplereport';

/** A sample of the fidelity check: its name and its rendered post. */
export interface FidelitySample {
  readonly name: string;
  readonly html: string;
}

/**
 * The posts the fidelity check sends: an X report with both its links as
 * code lines, and a Telegram report with its channel and post as code text,
 * each bilingual, Persian first, with admin points that carry each of
 * Telegram's named entities.
 */
export function fidelitySamples(allowedHosts: readonly string[]): FidelitySample[] {
  const terms = { linkMode: 'post' as const, recommendedComment: 'بگویید «این حساب» & <آزار> را "گزارش" کنید؛ say it is harassment & <abuse>.' };
  const subjects = [
    { name: 'x', subject: { platform: 'x' as const, category: 'harassment' as const, url: 'https://x.com/someone/status/1234567890', accountUrl: 'https://x.com/someone' } },
    { name: 'telegram', subject: { platform: 'telegram' as const, category: 'private_data' as const, url: 'https://t.me/somechannel/42', accountUrl: 'https://t.me/somechannel' } },
  ];
  return subjects.flatMap(({ name, subject }) => {
    const rendering = renderBilingualPost(subject, terms, allowedHosts);
    return rendering.ok ? [{ name, html: rendering.text }] : [];
  });
}

/** One sample's result: numbers and a verdict, never a text. */
export interface FidelityResult {
  readonly name: string;
  readonly samePlainText: boolean;
  readonly length: number;
  readonly expectedLength: number;
  /** The index of the first character that differs between the two plain texts, or null. */
  readonly firstDifference: number | null;
}

const firstDifference = (left: string, right: string): number | null => {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) if (left[index] !== right[index]) return index;
  return null;
};

/** Sends, probes, compares and deletes each sample (see the header). Throws a Bot API failure. */
export async function fidelityCheck(
  api: Pick<BotApiPort, 'sendMessage' | 'editMessageReplyMarkup' | 'deleteMessage'>,
  config: Pick<Config, 'broadcastChatId' | 'allowedLinkHosts'>,
  logger: Logger,
): Promise<FidelityResult[]> {
  const results: FidelityResult[] = [];
  const [probeKeyboard] = PROBE_KEYBOARDS;
  for (const sample of fidelitySamples(config.allowedLinkHosts)) {
    const sent = await api.sendMessage(config.broadcastChatId, sample.html, { reply_markup: postKeyboard(FIDELITY_REPORT_ID) });
    const edited = await api.editMessageReplyMarkup(config.broadcastChatId, sent.message_id, probeKeyboard === undefined ? {} : { reply_markup: probeKeyboard });
    const text = edited === true ? '' : (edited.text ?? '');
    const expected = plainText(sample.html);
    results.push({
      name: sample.name,
      samePlainText: samePlainText(text, sample.html),
      length: text.length,
      expectedLength: expected.length,
      firstDifference: firstDifference(text, expected),
    });
    try {
      await api.deleteMessage(config.broadcastChatId, sent.message_id);
    } catch (error) {
      logger.logError('probe.fidelity', error);
    }
  }
  const failed = results.filter((result) => !result.samePlainText).length;
  logger.log('probe.fidelity', { count: results.length - failed, failed });
  return results;
}

/** Whether `request` is the fidelity check's: a POST to its path with the webhook's secret. */
const isFidelityRequest = (request: Request, config: Pick<Config, 'webhookPathSegment' | 'webhookSecret'>): boolean =>
  onWebhookPath(request, `${config.webhookPathSegment}/${FIDELITY_PATH}`) && secretMatches(request.headers.get(SECRET_HEADER), config.webhookSecret);

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** One invocation's counts. */
export interface ProbeTally {
  queries: number;
  apiCalls: number;
}

/** `db`, counting every call into `tally`. */
export function countingDb(db: SqlDb, tally: ProbeTally): SqlDb {
  return {
    run: (text, params) => {
      tally.queries += 1;
      return db.run(text, params);
    },
    all: (text, params) => {
      tally.queries += 1;
      return db.all(text, params);
    },
    first: (text, params) => {
      tally.queries += 1;
      return db.first(text, params);
    },
    batch: (statements) => {
      tally.queries += 1;
      return db.batch(statements);
    },
  };
}

/** The invocation's own context: its waitUntil work collected, to be awaited before the counts are logged. */
const collecting = (ctx: ExecutionContext, pending: Promise<unknown>[]): ExecutionContext =>
  ({
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
    },
    passThroughOnException: () => {
      ctx.passThroughOnException();
    },
    props: ctx.props,
  }) as unknown as ExecutionContext;

/** The probe's handlers over `fetchImpl`, logging to `logger` (see the header). */
export function createProbe(fetchImpl: typeof fetch, logger: Logger = consoleLogger): ExportedHandler<Env> {
  const instrumented = () => {
    const tally: ProbeTally = { queries: 0, apiCalls: 0 };
    const counted: typeof fetch = (input, init) => {
      tally.apiCalls += 1;
      return fetchImpl(input, init);
    };
    const worker = createWorker(counted, logger, { db: (binding) => countingDb(d1SqlDb(binding), tally) });
    return { worker, tally };
  };
  const report = (ctx: ExecutionContext, pending: Promise<unknown>[], tally: ProbeTally): void => {
    ctx.waitUntil(
      Promise.allSettled(pending).then(() => {
        logger.log('probe.invocation', { queries: tally.queries, apiCalls: tally.apiCalls });
      }),
    );
  };
  return {
    fetch: async (request, env, ctx) => {
      let config: Config | null = null;
      try {
        config = configFor(env);
      } catch {
        // Not handled here: the Worker below loads it again, logs the failure by class and answers 500.
        config = null;
      }
      if (config !== null && isFidelityRequest(request, config)) {
        try {
          const samples = await fidelityCheck(createBotApi(config, fetchImpl, { timeoutSeconds: SEND_TIMEOUT_SECONDS }), config, logger);
          return json(200, { checkedAt: new Date().toISOString(), samples });
        } catch (error) {
          logger.logError('probe.fidelity', error);
          return json(502, { checkedAt: new Date().toISOString(), error: 'the Bot API refused or failed a call: see the log line' });
        }
      }
      const { worker, tally } = instrumented();
      const pending: Promise<unknown>[] = [];
      const response = (await worker.fetch?.(request, env, collecting(ctx, pending))) ?? new Response(null, { status: 500 });
      report(ctx, pending, tally);
      return response;
    },
    scheduled: async (controller, env, ctx) => {
      const { worker, tally } = instrumented();
      const pending: Promise<unknown>[] = [];
      await worker.scheduled?.(controller, env, collecting(ctx, pending));
      report(ctx, pending, tally);
    },
  };
}

export default createProbe(fetch);

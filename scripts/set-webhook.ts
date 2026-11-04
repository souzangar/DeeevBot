// @critical-path
// The webhook registration script (unit U8; critical invariants 2 and 6;
// doc/guides/operations-and-security.md, section 2.1; ADR 0003). An
// operator script the keyholder runs with Node from their own machine,
// never part of the Worker: nothing under src/ imports it (wrangler bundles
// src/worker.ts and its import graph only, which src/worker.test.ts walks).
//   npm run set-webhook -- https://<worker>.<account subdomain>.workers.dev
//   npm run set-webhook:delete
// that is, `node --import ./src/node-hooks.ts scripts/set-webhook.ts
// <origin | --delete>`: Node 22.18 or later runs it from this TypeScript
// source through its type stripping and the Node port's resolve hook.
//
// runSetWebhook(), in this order, a failing step ending the run with ONE
// class-only line through the redacting logger and exit code 1:
// 1. the configuration, configFor(process.env), before anything else, as on
//    the Worker and the port: every required variable must be set, and an
//    environment that defines DEBUG, NODE_DEBUG or NODE_DEBUG_NATIVE is
//    refused before any request (NODE_DEBUG=fetch would print each request
//    line, the token in its path): `config.invalid`;
// 2. the arguments: one https origin, with no path, query, fragment,
//    userinfo or port, or `--delete`, and nothing else; they are never
//    echoed: `webhook.usage`;
// 3. one call, over createBotApi(): the one transformer, and a client
//    bounded at BOT_TIMEOUT_SECONDS:
//    - setWebhook(<origin>/<WEBHOOK_PATH_SEGMENT>, webhookOptions()):
//      `secret_token` = WEBHOOK_SECRET, which the Worker checks on every
//      request before anything else (src/telegram/webhook.ts; rule 2);
//      `allowed_updates` message and callback_query, the two kinds the bot
//      handles, nothing else; `max_connections` 10, the Free plan's burst
//      being small; `drop_pending_updates` true on every registration;
//    - or deleteWebhook with `drop_pending_updates` false: the updates
//      Telegram keeps are authentic ones, which a port started next handles,
//      as the port's own deleteWebhook keeps them (src/node.ts);
//    a failure: `webhook.failed`, naming the method;
// 4. getWebhookInfo, printed on stdout as JSON: Telegram's fields read one
//    by one (printedInfo()), the URL's path masked (MASKS), and every
//    string, the masked URL's origin included, scrubbed of the token, the
//    secret token and the path segment in any letter case (a hostname is
//    lowercased by the URL parser, and a mistyped origin or a registration
//    made by another tool can carry the segment in a host label); Telegram
//    never answers the secret token. A failure: `webhook.failed`.
// Nothing else is ever printed: no line names the token, the secret token,
// the path segment or any argument, since every line goes through the
// redacting logger (src/privacy/logger.ts), which keeps an error's class
// (and a GrammyError's code and method, an AppError's code) and nothing of
// its message or payload. scripts/set-webhook.test.ts pins the exact
// parameters of both calls and the masking, against the fake Bot API; the
// script is never run against Telegram by a test.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { WebhookInfo } from 'grammy/types';
import { configFor } from '../src/config/memo';
import type { Config } from '../src/config/schema';
import { AppError } from '../src/errors/app-error';
import { consoleLogger, type Logger } from '../src/privacy/logger';
import { BOT_TIMEOUT_SECONDS, createBotApi } from '../src/telegram/api';
import type { BotApiPort, SetWebhookOptions } from '../src/telegram/bot-api-port';

/** How many connections Telegram may open to the Worker at once: the Free plan's burst is small. */
export const MAX_CONNECTIONS = 10;

/** The update kinds the bot handles; the Node port's long polling asks for the same (src/telegram/polling.ts). */
export const ALLOWED_UPDATES = Object.freeze(['message', 'callback_query'] as const);

/** What the printed info shows in place of a secret (see printedInfo()). */
export const MASKS = Object.freeze({
  /** The URL's path when it is exactly the configured WEBHOOK_PATH_SEGMENT. */
  segment: '<WEBHOOK_PATH_SEGMENT>',
  /** Any other path, which may hold an older segment. */
  otherPath: '<hidden: not WEBHOOK_PATH_SEGMENT>',
  /** A URL that does not parse, whole. */
  unreadable: '<hidden: unreadable URL>',
  /** The token, the secret token or the path segment inside any other string. */
  scrubbed: '<hidden>',
});

/** The configuration's secrets the printed info is kept free of. */
type Secrets = Pick<Config, 'botToken' | 'webhookSecret' | 'webhookPathSegment'>;

/** What the script was asked to do. */
export type ScriptRequest = { readonly mode: 'set'; readonly origin: string } | { readonly mode: 'delete' };

/** The calls the script makes, typed by the port (src/telegram/bot-api-port.ts). */
type WebhookApi = Pick<BotApiPort, 'setWebhook' | 'deleteWebhook' | 'getWebhookInfo'>;

/** setWebhook's parameters besides the URL (see the header, step 3). */
export const webhookOptions = (config: Pick<Config, 'webhookSecret'>): SetWebhookOptions => ({
  secret_token: config.webhookSecret,
  allowed_updates: [...ALLOWED_UPDATES],
  max_connections: MAX_CONNECTIONS,
  drop_pending_updates: true,
});

/** deleteWebhook's parameters: the pending updates are kept (see the header, step 3). */
export const DELETE_OPTIONS = Object.freeze({ drop_pending_updates: false });

/** The URL the webhook is registered at: the Worker's origin, then its secret path segment, which the Worker answers on alone. */
export const webhookUrl = (origin: string, config: Pick<Config, 'webhookPathSegment'>): string =>
  `${origin}/${config.webhookPathSegment}`;

/**
 * The request in `args`, the process's arguments after the script's own
 * path: `--delete`, or one https URL that is an origin and nothing more (no
 * path but `/`, no query, fragment, userinfo or port), returned as its
 * origin; null for anything else.
 */
export function parseArguments(args: readonly string[]): ScriptRequest | null {
  const [argument] = args;
  if (args.length !== 1 || argument === undefined) return null;
  if (argument === '--delete') return { mode: 'delete' };
  let url: URL;
  try {
    url = new URL(argument);
  } catch {
    return null;
  }
  const originOnly =
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    url.port === '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '';
  return originOnly ? { mode: 'set', origin: url.origin } : null;
}

/**
 * The webhook's URL as the script prints it: an empty one (no webhook)
 * stays empty; otherwise its origin, then MASKS.segment for a path that is
 * exactly `/<segment>` with no query or fragment, or MASKS.otherPath for any
 * other; a URL that does not parse is MASKS.unreadable whole.
 */
export function maskUrl(url: string, segment: string): string {
  if (url === '') return '';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return MASKS.unreadable;
  }
  const ours = parsed.pathname === `/${segment}` && parsed.search === '' && parsed.hash === '';
  return `${parsed.origin}/${ours ? MASKS.segment : MASKS.otherPath}`;
}

/** A pattern that matches `value` literally, in any letter case, everywhere. */
const literally = (value: string): RegExp => new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');

/**
 * `text` with every occurrence of the token, the secret token and the path
 * segment, in any letter case, replaced by MASKS.scrubbed.
 */
export function scrub(text: string, secrets: Secrets): string {
  let scrubbed = text;
  for (const secret of [secrets.botToken, secrets.webhookSecret, secrets.webhookPathSegment]) {
    if (secret !== '') scrubbed = scrubbed.replace(literally(secret), MASKS.scrubbed);
  }
  return scrubbed;
}

/**
 * The getWebhookInfo answer as the script prints it: each field Telegram
 * documents, read on its own and kept only with its documented type, the
 * URL masked by maskUrl() and then, like every other string, scrubbed by
 * scrub(), so not even the origin can show a secret; anything else in the
 * answer is left out.
 */
export function printedInfo(info: WebhookInfo, secrets: Secrets): Record<string, unknown> {
  const answer: Readonly<Record<string, unknown>> = { ...info };
  const printed: Record<string, unknown> = {
    url: typeof answer.url === 'string' ? scrub(maskUrl(answer.url, secrets.webhookPathSegment), secrets) : '',
  };
  if (typeof answer.has_custom_certificate === 'boolean') printed.has_custom_certificate = answer.has_custom_certificate;
  for (const field of ['pending_update_count', 'max_connections', 'last_error_date', 'last_synchronization_error_date']) {
    const value = answer[field];
    if (typeof value === 'number' && Number.isFinite(value)) printed[field] = value;
  }
  for (const field of ['ip_address', 'last_error_message']) {
    const value = answer[field];
    if (typeof value === 'string') printed[field] = scrub(value, secrets);
  }
  const kinds = answer.allowed_updates;
  if (Array.isArray(kinds)) {
    printed.allowed_updates = kinds.filter((kind): kind is string => typeof kind === 'string').map((kind) => scrub(kind, secrets));
  }
  return printed;
}

/** What runSetWebhook() needs: the arguments, the environment, the Bot API's transport, the logger and the output. */
export interface ScriptDeps {
  /** The process's arguments after the script's own path. */
  readonly args: readonly string[];
  /** The deployment's variables: process.env. */
  readonly env: object;
  /** The Bot API's transport: Node's fetch, or the fake Bot API's in tests. */
  readonly fetch: typeof fetch;
  readonly logger: Logger;
  /** Where the printed info goes: stdout. */
  readonly write: (text: string) => void;
}

/** Runs the script (see the header); resolves with the exit code, 0 or 1. */
export async function runSetWebhook(deps: ScriptDeps): Promise<number> {
  let config: Config;
  try {
    config = configFor(deps.env);
  } catch (error) {
    deps.logger.logError('config.invalid', error);
    return 1;
  }

  const request = parseArguments(deps.args);
  if (request === null) {
    deps.logger.logError('webhook.usage', new AppError('INVALID_INPUT', 'set-webhook takes one https Worker origin, or --delete'));
    return 1;
  }

  const api: WebhookApi = createBotApi(config, deps.fetch, { timeoutSeconds: BOT_TIMEOUT_SECONDS });
  try {
    if (request.mode === 'set') await api.setWebhook(webhookUrl(request.origin, config), webhookOptions(config));
    else await api.deleteWebhook(DELETE_OPTIONS);
  } catch (error) {
    deps.logger.logError('webhook.failed', error, { apiMethod: request.mode === 'set' ? 'setWebhook' : 'deleteWebhook' });
    return 1;
  }

  let info: WebhookInfo;
  try {
    info = await api.getWebhookInfo();
  } catch (error) {
    deps.logger.logError('webhook.failed', error, { apiMethod: 'getWebhookInfo' });
    return 1;
  }
  deps.write(`${JSON.stringify(printedInfo(info, config), null, 2)}\n`);
  return 0;
}

/** Whether the process runs this file (its first argument is this module), not a test importing it. */
export function isScriptEntry(entry: string | undefined, moduleUrl: string): boolean {
  if (entry === undefined) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === moduleUrl;
  } catch {
    // An entry that is no file (node -e, the REPL) is not this module.
    return false;
  }
}

if (isScriptEntry(process.argv[1], import.meta.url)) {
  void runSetWebhook({
    args: process.argv.slice(2),
    env: process.env,
    fetch,
    logger: consoleLogger,
    write: (text) => {
      process.stdout.write(text);
    },
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      consoleLogger.logError('webhook.failed', error);
      process.exitCode = 1;
    },
  );
}

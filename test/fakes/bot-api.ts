// The fake Bot API for tests: a `fetch` for grammY's client that answers as
// api.telegram.org does, in Telegram's own envelopes (`{ ok: true, result }`
// or `{ ok: false, error_code, description, parameters }`), and records
// every call: its method, its chat id and its payload. Every test that
// drives a handler, the webhook or the Worker passes `fake.fetch` where the
// runtime's fetch would go, so the code under test runs unchanged through
// grammY's real client and the project's one transformer, and the
// recording is what Telegram would have received.
//
// - Methods: getMe, getUpdates, getChatMember, setWebhook, deleteWebhook,
//   sendMessage, editMessageText, editMessageReplyMarkup (returning the
//   edited Message with its reply_markup), deleteMessage and
//   answerCallbackQuery. Any other method, getChat among them, is answered
//   404 "Not Found" and recorded like the rest, so a test can assert it was
//   never called.
// - Messages the bot sends are kept per chat, so edits and deletes behave:
//   an unknown message answers "message to edit not found" or "message to
//   delete not found", an edit to the same text and keyboard "message is
//   not modified". seedMessage() puts a message there, a post sent before
//   the test started, say.
// - Scripted failures, per chat id and/or method, for a number of calls or
//   for every one: the Bot API's 400s and 403s, a 429 with retry_after, a
//   5xx, a timeout, a network failure, and a request that never answers.
// - A request to any other host is refused as a network failure and kept in
//   `foreignRequests`: a test asserts it stays empty, so no reported URL is
//   ever fetched.
// Fixture values are never secret-shaped (the secret-shape scan reads test
// files too).
import type { Update, UserFromGetMe } from 'grammy/types';

/** One call the code under test made. */
export interface RecordedCall {
  readonly method: string;
  /** The payload's chat_id, when it carries one. */
  readonly chatId: number | string | undefined;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** How a scripted call fails. */
export type FakeOutcome =
  | {
      readonly kind: 'error';
      readonly errorCode: number;
      readonly description: string;
      readonly retryAfter?: number;
    }
  /** The fetch rejects with a TimeoutError, as an aborted fetch does. */
  | { readonly kind: 'timeout' }
  /** The fetch rejects with a TypeError, as a refused or lost connection does. */
  | { readonly kind: 'network' }
  /** The fetch never settles, unless its signal aborts. */
  | { readonly kind: 'hang' };

/** A scripted answer of the Bot API's own: an error envelope. */
export type ErrorOutcome = Extract<FakeOutcome, { readonly kind: 'error' }>;

const answer = (errorCode: number, description: string): ErrorOutcome => ({ kind: 'error', errorCode, description });

/** The Bot API's failures by name, with Telegram's own descriptions. */
export const FAILURES = {
  chatNotFound: answer(400, 'Bad Request: chat not found'),
  privateChatNotFound: answer(400, 'Bad Request: private chat not found'),
  messageNotModified: answer(
    400,
    'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message',
  ),
  messageToEditNotFound: answer(400, 'Bad Request: message to edit not found'),
  messageToDeleteNotFound: answer(400, 'Bad Request: message to delete not found'),
  messageCantBeDeleted: answer(400, "Bad Request: message can't be deleted"),
  userNotFound: answer(400, 'Bad Request: user not found'),
  botBlocked: answer(403, 'Forbidden: bot was blocked by the user'),
  userDeactivated: answer(403, 'Forbidden: user is deactivated'),
  cantInitiateConversation: answer(403, "Forbidden: bot can't initiate conversation with a user"),
  serverError: answer(502, 'Bad Gateway'),
  timeout: { kind: 'timeout' },
  networkFailure: { kind: 'network' },
  hang: { kind: 'hang' },
} as const satisfies Record<string, FakeOutcome>;

/** A 429 asking to wait `seconds`. */
export const rateLimited = (seconds: number): ErrorOutcome => ({
  kind: 'error',
  errorCode: 429,
  description: `Too Many Requests: retry after ${seconds}`,
  retryAfter: seconds,
});

/** Which calls a scripted outcome applies to: every field given must match. */
export interface CallMatch {
  readonly method?: string;
  readonly chatId?: number;
}

/** A chat member as getChatMember answers it. */
export interface FakeMember {
  readonly status: 'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked';
  /** For `restricted`: whether the user is still a member. */
  readonly isMember?: boolean;
}

/** A message the fake holds for a chat. */
export interface StoredMessage {
  readonly message_id: number;
  readonly date: number;
  readonly chat: { readonly id: number; readonly type: string };
  readonly text?: string;
  readonly reply_markup?: unknown;
  readonly edit_date?: number;
}

export interface FakeBotApiOptions {
  /** What getMe answers. */
  readonly botInfo?: UserFromGetMe;
  /** The fake's clock, for message dates: milliseconds. */
  readonly now?: () => number;
  /** Chat ids whose messages are a channel's (the broadcast channel, say). */
  readonly channelIds?: readonly number[];
}

export interface FakeBotApi {
  /** The `fetch` to hand to grammY's client. */
  readonly fetch: typeof fetch;
  /** Every Bot API call, in order. */
  readonly calls: readonly RecordedCall[];
  /** Every request to another host: must stay empty. */
  readonly foreignRequests: readonly string[];
  /** The number of calls, of `method` when given. */
  count(method?: string): number;
  callsOf(method: string): RecordedCall[];
  /** Every sendMessage, editMessageText and editMessageReplyMarkup, in order. */
  outgoing(): RecordedCall[];
  /** Fails the matching calls with `outcome`: the next `times` of them, or every one. */
  fail(match: CallMatch, outcome: FakeOutcome, times?: number): void;
  /** What getChatMember answers for `userId` in `chatId`; 'user_not_found' answers that 400. */
  setMember(chatId: number, userId: number, member: FakeMember | 'user_not_found'): void;
  /** Puts a message the bot sent before into `chatId`. */
  seedMessage(chatId: number, message: { readonly message_id: number; readonly text?: string; readonly reply_markup?: unknown }): void;
  /** The message the fake holds, if any. */
  messageIn(chatId: number, messageId: number): StoredMessage | undefined;
  /** Updates the next getUpdates answers with. */
  queueUpdates(...updates: Update[]): void;
  /** The requests a 'hang' outcome left unsettled. */
  hanging(): number;
}

const API_ORIGIN = 'https://api.telegram.org';
const METHOD_PATH = /^\/bot[^/]+\/([A-Za-z]+)$/;

const DEFAULT_BOT: UserFromGetMe = {
  id: 424240001,
  is_bot: true,
  first_name: 'Fake',
  username: 'div_report_test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

interface Rule {
  readonly match: CallMatch;
  readonly outcome: FakeOutcome;
  remaining: number;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ok = (result: unknown): Response => json(200, { ok: true, result });

const failed = (outcome: ErrorOutcome): Response =>
  json(outcome.errorCode, {
    ok: false,
    error_code: outcome.errorCode,
    description: outcome.description,
    ...(outcome.retryAfter === undefined ? {} : { parameters: { retry_after: outcome.retryAfter } }),
  });

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

const payloadOf = (init: RequestInit | undefined): Record<string, unknown> => {
  const body = init?.body;
  if (typeof body !== 'string' || body === '') return {};
  const parsed: unknown = JSON.parse(body);
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
};

const sameMarkup = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

/** A fake Bot API (see the header). */
export function fakeBotApi(options: FakeBotApiOptions = {}): FakeBotApi {
  const botInfo = options.botInfo ?? DEFAULT_BOT;
  const now = options.now ?? (() => 1_800_000_000_000);
  const channels = new Set(options.channelIds ?? []);
  const calls: RecordedCall[] = [];
  const foreignRequests: string[] = [];
  const rules: Rule[] = [];
  const messages = new Map<string, StoredMessage>();
  const lastMessageId = new Map<number, number>();
  const members = new Map<string, FakeMember | 'user_not_found'>();
  const updates: Update[] = [];
  let hung = 0;

  const key = (chatId: number, messageId: number): string => `${chatId}:${messageId}`;
  const seconds = (): number => Math.floor(now() / 1000);
  const chatOf = (chatId: number) => ({
    id: chatId,
    type: channels.has(chatId) ? 'channel' : chatId > 0 ? 'private' : 'supergroup',
  });

  const store = (chatId: number, message: Omit<StoredMessage, 'chat' | 'date'> & { readonly date?: number }): StoredMessage => {
    const stored: StoredMessage = { date: seconds(), ...message, chat: chatOf(chatId) };
    messages.set(key(chatId, stored.message_id), stored);
    lastMessageId.set(chatId, Math.max(lastMessageId.get(chatId) ?? 0, stored.message_id));
    return stored;
  };

  const scripted = (method: string, chatId: unknown): FakeOutcome | undefined => {
    const rule = rules.find(
      (candidate) =>
        candidate.remaining > 0 &&
        (candidate.match.method === undefined || candidate.match.method === method) &&
        (candidate.match.chatId === undefined || candidate.match.chatId === chatId),
    );
    if (rule === undefined) return undefined;
    rule.remaining -= 1;
    return rule.outcome;
  };

  const settle = (outcome: FakeOutcome, signal: AbortSignal | null | undefined): Promise<Response> => {
    switch (outcome.kind) {
      case 'error':
        return Promise.resolve(failed(outcome));
      case 'timeout':
        return Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
      case 'network':
        return Promise.reject(new TypeError('fetch failed'));
      case 'hang':
        hung += 1;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            hung -= 1;
            reject(new DOMException('The operation was aborted', 'AbortError'));
          });
        });
    }
  };

  /** The default answer of each method. */
  const respond = (method: string, payload: Record<string, unknown>): Response => {
    const chatId = payload.chat_id;
    const messageId = payload.message_id;
    switch (method) {
      case 'getMe':
        return ok(botInfo);
      case 'getUpdates':
        return ok(updates.splice(0));
      case 'setWebhook':
      case 'deleteWebhook':
      case 'answerCallbackQuery':
        return ok(true);
      case 'getChatMember': {
        const userId = Number(payload.user_id);
        const member = members.get(`${String(chatId)}:${userId}`);
        if (member === 'user_not_found') return failed(FAILURES.userNotFound);
        const status = member?.status ?? 'left';
        return ok({
          status,
          user: { id: userId, is_bot: false, first_name: 'Member' },
          ...(status === 'restricted' ? { is_member: member?.isMember ?? false, until_date: 0 } : {}),
          ...(status === 'kicked' ? { until_date: 0 } : {}),
        });
      }
      case 'sendMessage': {
        const id = Number(chatId);
        const message = store(id, {
          message_id: (lastMessageId.get(id) ?? 0) + 1,
          text: String(payload.text),
          ...(payload.reply_markup === undefined ? {} : { reply_markup: payload.reply_markup }),
        });
        return ok(message);
      }
      case 'editMessageText':
      case 'editMessageReplyMarkup': {
        const id = Number(chatId);
        const current = messages.get(key(id, Number(messageId)));
        if (current === undefined) return failed(FAILURES.messageToEditNotFound);
        const text = method === 'editMessageText' ? String(payload.text) : current.text;
        const markup = payload.reply_markup;
        if (text === current.text && sameMarkup(markup, current.reply_markup)) {
          return failed(FAILURES.messageNotModified);
        }
        const edited = store(id, {
          message_id: current.message_id,
          date: current.date,
          ...(text === undefined ? {} : { text }),
          ...(markup === undefined ? {} : { reply_markup: markup }),
          edit_date: seconds(),
        });
        return ok(edited);
      }
      case 'deleteMessage': {
        const removed = messages.delete(key(Number(chatId), Number(messageId)));
        return removed ? ok(true) : failed(FAILURES.messageToDeleteNotFound);
      }
      default:
        return json(404, { ok: false, error_code: 404, description: 'Not Found' });
    }
  };

  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(urlOf(input));
    const method = METHOD_PATH.exec(url.pathname)?.[1];
    if (url.origin !== API_ORIGIN || method === undefined) {
      foreignRequests.push(url.href);
      return Promise.reject(new TypeError('fetch failed'));
    }
    const payload = payloadOf(init);
    const chatId = payload.chat_id as number | string | undefined;
    calls.push({ method, chatId, payload });
    const outcome = scripted(method, chatId);
    if (outcome !== undefined) return settle(outcome, init?.signal);
    return Promise.resolve(respond(method, payload));
  };

  return {
    fetch: fetchImpl,
    calls,
    foreignRequests,
    count: (method) => (method === undefined ? calls.length : calls.filter((call) => call.method === method).length),
    callsOf: (method) => calls.filter((call) => call.method === method),
    outgoing: () =>
      calls.filter((call) => ['sendMessage', 'editMessageText', 'editMessageReplyMarkup'].includes(call.method)),
    fail: (match, outcome, times = Number.POSITIVE_INFINITY) => {
      rules.push({ match, outcome, remaining: times });
    },
    setMember: (chatId, userId, member) => {
      members.set(`${chatId}:${userId}`, member);
    },
    seedMessage: (chatId, message) => {
      store(chatId, message);
    },
    messageIn: (chatId, messageId) => messages.get(key(chatId, messageId)),
    queueUpdates: (...queued) => {
      updates.push(...queued);
    },
    hanging: () => hung,
  };
}

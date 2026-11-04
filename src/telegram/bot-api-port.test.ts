// The port's subset and the fake Bot API's own contract
// (test/fakes/bot-api.ts), tested through grammY's real Api over the fake's
// fetch: the envelopes it answers with, what it records and counts, every
// scripted failure as grammY surfaces it (a GrammyError carrying Telegram's
// code and description, or an HttpError for a timeout and a network
// failure), the request that never answers, the stateful edits and deletes,
// and the refusal of every method outside the port and every other host.
// The later units' tests rest on this fake, so its behaviour is pinned here.
import { Api, GrammyError, HttpError } from 'grammy';
import type { Message, Update } from 'grammy/types';
import { describe, expect, it, vi } from 'vitest';
import { FAILURES, fakeBotApi, rateLimited, type FakeOutcome } from '../../test/fakes/bot-api';
import { API_METHODS } from '../privacy/logger';
import { createBotApi } from './api';
import { PORT_METHODS } from './bot-api-port';

const USER = 424240031;
const OTHER_USER = 424240032;
const GROUP = -1004242400051;
const TOKEN = 'unit-test-bot-token';

const setup = () => {
  const telegram = fakeBotApi({ channelIds: [-1004242400061] });
  return { telegram, api: createBotApi({ botToken: TOKEN }, telegram.fetch) };
};

const failureOf = (attempt: Promise<unknown>): Promise<unknown> =>
  attempt.then(
    () => {
      throw new Error('expected the call to fail');
    },
    (error: unknown) => error,
  );

describe('the port', () => {
  it('lists the methods the fake supports, each one a method log lines may name', () => {
    expect([...PORT_METHODS].sort()).toEqual(
      [
        'answerCallbackQuery',
        'deleteMessage',
        'deleteWebhook',
        'editMessageReplyMarkup',
        'editMessageText',
        'getChatMember',
        'getMe',
        'getUpdates',
        'getWebhookInfo',
        'sendMessage',
        'setWebhook',
      ].sort(),
    );
    for (const method of PORT_METHODS) expect(API_METHODS).toContain(method);
  });

  it('holds none of the methods rule 4 forbids', () => {
    for (const method of ['forwardMessage', 'forwardMessages', 'copyMessage', 'copyMessages', 'getFile', 'getChat']) {
      expect(PORT_METHODS as readonly string[]).not.toContain(method);
    }
  });
});

describe('the fake Bot API: envelopes and recording', () => {
  it('answers in Telegram envelopes, which grammY unwraps', async () => {
    const { telegram } = setup();
    const response = await telegram.fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      body: JSON.stringify({ chat_id: USER, text: 'raw' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, result: { message_id: 1, chat: { id: USER }, text: 'raw' } });
    telegram.fail({ chatId: USER }, FAILURES.botBlocked, 1);
    const refused = await telegram.fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      body: JSON.stringify({ chat_id: USER, text: 'raw' }),
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      ok: false,
      error_code: 403,
      description: 'Forbidden: bot was blocked by the user',
    });
  });

  it('records every call with its method, chat id and payload, and counts them', async () => {
    const { telegram, api } = setup();
    await api.sendMessage(USER, 'one');
    await api.sendMessage(OTHER_USER, 'two');
    await api.answerCallbackQuery('query-1');
    expect(telegram.count()).toBe(3);
    expect(telegram.count('sendMessage')).toBe(2);
    expect(telegram.count('getChat')).toBe(0);
    expect(telegram.callsOf('sendMessage').map((call) => call.chatId)).toEqual([USER, OTHER_USER]);
    expect(telegram.calls[2]).toEqual({
      method: 'answerCallbackQuery',
      chatId: undefined,
      payload: { callback_query_id: 'query-1' },
    });
    expect(telegram.outgoing().map((call) => call.method)).toEqual(['sendMessage', 'sendMessage']);
  });

  it('numbers messages per chat and dates them by its clock', async () => {
    const telegram = fakeBotApi({ now: () => 1_900_000_000_500 });
    const api = createBotApi({ botToken: TOKEN }, telegram.fetch);
    const first = await api.sendMessage(USER, 'a');
    const second = await api.sendMessage(USER, 'b');
    const elsewhere = await api.sendMessage(OTHER_USER, 'c');
    expect([first.message_id, second.message_id, elsewhere.message_id]).toEqual([1, 2, 1]);
    expect(first.date).toBe(1_900_000_000);
    expect(first.chat).toEqual({ id: USER, type: 'private' });
  });

  it('answers getMe, getUpdates, setWebhook and deleteWebhook', async () => {
    const { telegram, api } = setup();
    expect((await api.getMe()).username).toBe('div_report_test_bot');
    const update = { update_id: 41 } as Update;
    telegram.queueUpdates(update);
    expect(await api.getUpdates()).toEqual([update]);
    expect(await api.getUpdates()).toEqual([]);
    expect(await api.setWebhook('https://worker.example/segment', { secret_token: 'x' })).toBe(true);
    expect(await api.deleteWebhook({ drop_pending_updates: true })).toBe(true);
  });

  it('keeps the webhook as Telegram does: getWebhookInfo answers what setWebhook set, never its secret, and an empty url once deleted', async () => {
    const { telegram, api } = setup();
    expect(await api.getWebhookInfo()).toEqual({ url: '', has_custom_certificate: false, pending_update_count: 0 });
    await api.setWebhook('https://worker.example/segment', {
      secret_token: 'unit-test-webhook-secret',
      max_connections: 10,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true,
    });
    expect(await api.getWebhookInfo()).toEqual({
      url: 'https://worker.example/segment',
      has_custom_certificate: false,
      pending_update_count: 0,
      max_connections: 10,
      allowed_updates: ['message', 'callback_query'],
    });
    telegram.setWebhookInfo({ last_error_date: 1_900_000_000, last_error_message: 'Wrong response from the webhook: 404 Not Found' });
    expect(await api.getWebhookInfo()).toMatchObject({ url: 'https://worker.example/segment', last_error_message: 'Wrong response from the webhook: 404 Not Found' });
    await api.setWebhook('https://worker.example/other');
    expect(await api.getWebhookInfo()).toMatchObject({ url: 'https://worker.example/other', max_connections: 40 });
    await api.deleteWebhook();
    expect((await api.getWebhookInfo()).url).toBe('');
  });

  describe('long polling (getUpdates with a timeout)', () => {
    const update = (id: number) => ({ update_id: id }) as Update;

    it('holds a getUpdates until an update is queued, then answers with it at once', async () => {
      const { telegram, api } = setup();
      const held = api.getUpdates({ timeout: 30 });
      await vi.waitFor(() => expect(telegram.waitingForUpdates()).toBe(1));
      telegram.queueUpdates(update(7));
      expect(await held).toEqual([update(7)]);
      expect(telegram.waitingForUpdates()).toBe(0);
    });

    it('answers at once when an update is queued already, or without a timeout', async () => {
      const { telegram, api } = setup();
      telegram.queueUpdates(update(8));
      expect(await api.getUpdates({ timeout: 30 })).toEqual([update(8)]);
      expect(await api.getUpdates({ timeout: 0 })).toEqual([]);
      expect(telegram.waitingForUpdates()).toBe(0);
    });

    it('answers nothing once the timeout passes with nothing queued', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const { telegram, api } = setup();
        const held = api.getUpdates({ timeout: 5 });
        await vi.advanceTimersByTimeAsync(4_999);
        expect(telegram.waitingForUpdates()).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(await held).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('ends the wait when its request is aborted, as an aborted fetch does', async () => {
      const { telegram, api } = setup();
      const controller = new AbortController();
      // grammY types the signal with its abort-controller polyfill; the runtime's own is what it receives.
      const held = failureOf(api.getUpdates({ timeout: 30 }, controller.signal as unknown as Parameters<typeof api.getUpdates>[1]));
      await vi.waitFor(() => expect(telegram.waitingForUpdates()).toBe(1));
      controller.abort();
      expect(await held).toBeInstanceOf(HttpError);
      expect(telegram.waitingForUpdates()).toBe(0);
    });

    it('drops the updates below the offset, as Telegram confirms them, and answers at most `limit`', async () => {
      const { telegram, api } = setup();
      telegram.queueUpdates(update(1), update(2), update(3), update(4));
      expect(await api.getUpdates({ offset: 2, limit: 2 })).toEqual([update(2), update(3)]);
      expect(await api.getUpdates({ offset: 4 })).toEqual([update(4)]);
      expect(await api.getUpdates()).toEqual([]);
    });
  });

  it('answers getChatMember as configured, "left" by default, and "user not found" on request', async () => {
    const { telegram, api } = setup();
    expect((await api.getChatMember(GROUP, USER)).status).toBe('left');
    telegram.setMember(GROUP, USER, { status: 'restricted', isMember: true });
    expect(await api.getChatMember(GROUP, USER)).toMatchObject({ status: 'restricted', is_member: true });
    telegram.setMember(GROUP, OTHER_USER, 'user_not_found');
    const error = await failureOf(api.getChatMember(GROUP, OTHER_USER));
    expect(error).toBeInstanceOf(GrammyError);
    expect((error as GrammyError).description).toBe('Bad Request: user not found');
  });

  it('answers 404 to a method outside the port, getChat included, and records it', async () => {
    const { telegram } = setup();
    const raw = new Api(TOKEN, { fetch: telegram.fetch });
    const error = await failureOf(raw.getChat(USER));
    expect(error).toBeInstanceOf(GrammyError);
    expect((error as GrammyError).error_code).toBe(404);
    expect(telegram.count('getChat')).toBe(1);
  });

  it('refuses any other host as a network failure and keeps it', async () => {
    const { telegram } = setup();
    await expect(telegram.fetch('https://www.instagram.com/reported.account/')).rejects.toThrow(TypeError);
    expect(telegram.foreignRequests).toEqual(['https://www.instagram.com/reported.account/']);
    expect(telegram.count()).toBe(0);
  });
});

describe('the fake Bot API: edits and deletes', () => {
  const keyboard = (data: string) => ({ inline_keyboard: [[{ text: 'I reported it', callback_data: data }]] });

  it('edits a message the bot sent, and says "not modified" when nothing changes', async () => {
    const { telegram, api } = setup();
    const sent = await api.sendMessage(USER, 'first');
    const edited = await api.editMessageText(USER, sent.message_id, 'second');
    expect(edited).toMatchObject({ message_id: sent.message_id, text: 'second' });
    expect(telegram.messageIn(USER, sent.message_id)?.text).toBe('second');
    const error = await failureOf(api.editMessageText(USER, sent.message_id, 'second'));
    expect((error as GrammyError).description).toMatch(/^Bad Request: message is not modified/);
  });

  it('editMessageReplyMarkup returns the edited Message with its reply_markup', async () => {
    const { telegram, api } = setup();
    telegram.seedMessage(-1004242400061, { message_id: 55, text: 'a post' });
    const edited = (await api.editMessageReplyMarkup(-1004242400061, 55, {
      reply_markup: keyboard('mark:abcdefghijklmnopqrst'),
    })) as Message;
    expect(edited.reply_markup).toEqual(keyboard('mark:abcdefghijklmnopqrst'));
    expect(edited.chat).toEqual({ id: -1004242400061, type: 'channel' });
    const again = await failureOf(
      api.editMessageReplyMarkup(-1004242400061, 55, { reply_markup: keyboard('mark:abcdefghijklmnopqrst') }),
    );
    expect((again as GrammyError).description).toMatch(/message is not modified/);
  });

  it('cannot edit a message it never sent', async () => {
    const { api } = setup();
    const error = await failureOf(api.editMessageReplyMarkup(-1004242400061, 999, { reply_markup: keyboard('mark:x') }));
    expect((error as GrammyError).description).toBe('Bad Request: message to edit not found');
  });

  it('deletes a message once, then says it is not found', async () => {
    const { telegram, api } = setup();
    const sent = await api.sendMessage(USER, 'to delete');
    expect(await api.deleteMessage(USER, sent.message_id)).toBe(true);
    expect(telegram.messageIn(USER, sent.message_id)).toBeUndefined();
    const error = await failureOf(api.deleteMessage(USER, sent.message_id));
    expect((error as GrammyError).description).toBe('Bad Request: message to delete not found');
  });
});

describe('the fake Bot API: scripted failures', () => {
  it.each([
    ['400 chat not found', FAILURES.chatNotFound, 400, 'Bad Request: chat not found'],
    ['400 private chat not found', FAILURES.privateChatNotFound, 400, 'Bad Request: private chat not found'],
    ['400 message is not modified', FAILURES.messageNotModified, 400, FAILURES.messageNotModified.description],
    ['400 message to edit not found', FAILURES.messageToEditNotFound, 400, 'Bad Request: message to edit not found'],
    ['400 message cannot be deleted', FAILURES.messageCantBeDeleted, 400, "Bad Request: message can't be deleted"],
    ['403 bot was blocked', FAILURES.botBlocked, 403, 'Forbidden: bot was blocked by the user'],
    ['403 user is deactivated', FAILURES.userDeactivated, 403, 'Forbidden: user is deactivated'],
    ['5xx', FAILURES.serverError, 502, 'Bad Gateway'],
  ])('surfaces %s as a GrammyError with Telegram code and text', async (_label, outcome, code, description) => {
    const { telegram, api } = setup();
    telegram.fail({ chatId: USER }, outcome);
    const error = await failureOf(api.sendMessage(USER, 'x'));
    expect(error).toBeInstanceOf(GrammyError);
    expect((error as GrammyError).error_code).toBe(code);
    expect((error as GrammyError).description).toBe(description);
  });

  it.each([
    ['409 another getUpdates', FAILURES.conflict, 409, 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running'],
    ['409 a webhook is set', FAILURES.webhookActive, 409, "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first"],
    ['401 the token refused', FAILURES.unauthorized, 401, 'Unauthorized'],
  ])("surfaces getUpdates' %s as a GrammyError with Telegram code and text", async (_label, outcome, code, description) => {
    const { telegram, api } = setup();
    telegram.fail({ method: 'getUpdates' }, outcome, 1);
    const error = await failureOf(api.getUpdates({ timeout: 30 }));
    expect(error).toBeInstanceOf(GrammyError);
    expect((error as GrammyError).error_code).toBe(code);
    expect((error as GrammyError).description).toBe(description);
    expect(await api.getUpdates()).toEqual([]);
  });

  it('surfaces a 429 with its retry_after', async () => {
    const { telegram, api } = setup();
    telegram.fail({ method: 'sendMessage' }, rateLimited(17));
    const error = (await failureOf(api.sendMessage(USER, 'x'))) as GrammyError;
    expect(error.error_code).toBe(429);
    expect(error.description).toBe('Too Many Requests: retry after 17');
    expect(error.parameters.retry_after).toBe(17);
  });

  it.each([
    ['a timeout', FAILURES.timeout, 'TimeoutError'],
    ['a network failure', FAILURES.networkFailure, 'TypeError'],
  ])('surfaces %s as an HttpError around the fetch failure', async (_label, outcome: FakeOutcome, inner) => {
    const { telegram, api } = setup();
    telegram.fail({ chatId: USER }, outcome);
    const error = await failureOf(api.sendMessage(USER, 'x'));
    expect(error).toBeInstanceOf(HttpError);
    expect(((error as HttpError).error as Error).name).toBe(inner);
    expect(telegram.count('sendMessage')).toBe(1);
  });

  it('leaves a hanging request unsettled until its signal aborts', async () => {
    const { telegram, api } = setup();
    telegram.fail({ chatId: USER }, FAILURES.hang);
    const controller = new AbortController();
    let settled = false;
    // grammY types its signal as the abort-controller package's; the runtime's is the same at run time.
    const signal = controller.signal as unknown as Parameters<typeof api.sendMessage>[3];
    const pending = api.sendMessage(USER, 'x', {}, signal).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    expect(telegram.hanging()).toBe(1);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(HttpError);
    expect(telegram.hanging()).toBe(0);
  });

  it('scripts per chat id and per method, for a number of calls or for every one', async () => {
    const { telegram, api } = setup();
    telegram.fail({ chatId: USER }, FAILURES.botBlocked, 1);
    telegram.fail({ method: 'deleteMessage' }, FAILURES.messageCantBeDeleted);
    await expect(api.sendMessage(USER, 'blocked once')).rejects.toBeInstanceOf(GrammyError);
    await expect(api.sendMessage(USER, 'fine now')).resolves.toMatchObject({ text: 'fine now' });
    await expect(api.sendMessage(OTHER_USER, 'never blocked')).resolves.toMatchObject({ chat: { id: OTHER_USER } });
    await expect(api.deleteMessage(USER, 1)).rejects.toBeInstanceOf(GrammyError);
    await expect(api.deleteMessage(USER, 2)).rejects.toBeInstanceOf(GrammyError);
    expect(telegram.count()).toBe(5);
  });
});

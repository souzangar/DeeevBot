// Unit tests for the Bot API adapter (src/telegram/api.ts): the one
// transformer's exact behaviour on every caller value, through grammY's real
// client over the fake Bot API, and the client options. The rule-4 sweep
// over every handler's sends is test/invariants/outgoing-messages.test.ts.
import { Api, HttpError } from 'grammy';
import { describe, expect, it } from 'vitest';
import { fakeBotApi, FAILURES } from '../../test/fakes/bot-api';
import { testConfig } from '../../test/support/config';
import {
  clientOptions,
  createBotApi,
  enforceFormat,
  ENFORCED_METHODS,
  htmlWithoutPreviews,
  installTransformer,
  PREVIEWS_DISABLED,
} from './api';
import type { BotApiPort } from './bot-api-port';

const CHAT = 424240031;
const config = testConfig();

const setup = () => {
  const telegram = fakeBotApi();
  const api = createBotApi(config, telegram.fetch);
  const payload = (index = 0): Readonly<Record<string, unknown>> => {
    const call = telegram.calls[index];
    if (call === undefined) throw new Error(`no call ${index}`);
    return call.payload;
  };
  return { telegram, api, payload };
};

describe('the one transformer', () => {
  it('adds previews off and HTML parse mode to a sendMessage that sets neither', async () => {
    const { api, payload } = setup();
    await api.sendMessage(CHAT, 'hello');
    expect(payload()).toEqual({
      chat_id: CHAT,
      text: 'hello',
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  });

  it('adds them to an editMessageText too', async () => {
    const { telegram, api, payload } = setup();
    telegram.seedMessage(CHAT, { message_id: 7, text: 'before' });
    await api.editMessageText(CHAT, 7, 'after');
    expect(payload()).toEqual({
      chat_id: CHAT,
      message_id: 7,
      text: 'after',
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  });

  it('keeps a caller that sets the same values exactly as it was', async () => {
    const { api, payload } = setup();
    await api.sendMessage(CHAT, 'same', { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    expect(payload()).toEqual({
      chat_id: CHAT,
      text: 'same',
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  });

  it('overrides a caller that turns previews on, at run time', async () => {
    const { api, payload } = setup();
    // grammY's own types allow this; only the port's forbid it.
    await api.sendMessage(CHAT, 'on?', { link_preview_options: { is_disabled: false } });
    expect(payload()).toMatchObject({ link_preview_options: { is_disabled: true } });
  });

  it("replaces a caller's preview options whole: no url, no media preference survives", async () => {
    const { api, payload } = setup();
    await api.sendMessage(CHAT, 'x', {
      link_preview_options: {
        is_disabled: true,
        url: 'https://www.instagram.com/reported.account/',
        prefer_large_media: true,
        show_above_text: true,
      },
    });
    expect(payload().link_preview_options).toEqual({ is_disabled: true });
  });

  it('overrides another parse mode with HTML', async () => {
    const { api, payload } = setup();
    await api.sendMessage(CHAT, 'x', { parse_mode: 'MarkdownV2' });
    expect(payload().parse_mode).toBe('HTML');
  });

  it("passes every other field through untouched and never mutates the caller's object", async () => {
    const { api, payload } = setup();
    const other = {
      reply_markup: { inline_keyboard: [[{ text: 'I reported it', callback_data: 'mark:abcdefghijklmnopqrst' }]] },
      disable_notification: true,
      link_preview_options: { is_disabled: false },
    };
    const before = structuredClone(other);
    await api.sendMessage(CHAT, 'x', other);
    expect(other).toEqual(before);
    expect(payload()).toEqual({
      chat_id: CHAT,
      text: 'x',
      reply_markup: other.reply_markup,
      disable_notification: true,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  });

  it('leaves every other method alone', async () => {
    const { telegram, api } = setup();
    telegram.seedMessage(CHAT, { message_id: 3, text: 'keyboard' });
    await api.answerCallbackQuery('query-id', { text: 'thanks' });
    await api.deleteMessage(CHAT, 3);
    await api.getChatMember(-1004242400051, CHAT);
    await api.getMe();
    for (const call of telegram.calls) {
      expect(call.payload, call.method).not.toHaveProperty('parse_mode');
      expect(call.payload, call.method).not.toHaveProperty('link_preview_options');
    }
    expect(telegram.calls.map((call) => call.method)).toEqual([
      'answerCallbackQuery',
      'deleteMessage',
      'getChatMember',
      'getMe',
    ]);
  });

  it('enforces exactly sendMessage and editMessageText', () => {
    expect(ENFORCED_METHODS).toEqual(['sendMessage', 'editMessageText']);
    expect(PREVIEWS_DISABLED).toEqual({ is_disabled: true });
    expect(Object.isFrozen(PREVIEWS_DISABLED)).toBe(true);
  });

  it('enforceFormat builds a new object and tolerates a missing payload', () => {
    const payload = { text: 'x', parse_mode: 'Markdown' };
    const enforced = enforceFormat(payload);
    expect(enforced).not.toBe(payload);
    expect(payload.parse_mode).toBe('Markdown');
    expect(enforceFormat(undefined)).toEqual({ parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  });
});

describe('createBotApi and installTransformer', () => {
  it('installs the one transformer, once, however often it is asked to', () => {
    const { api } = setup();
    expect(api.config.installedTransformers()).toEqual([htmlWithoutPreviews]);
    installTransformer(api);
    installTransformer(api);
    expect(api.config.installedTransformers()).toEqual([htmlWithoutPreviews]);
  });

  it('calls the Bot API through the injected fetch only', async () => {
    const { telegram, api } = setup();
    await api.sendMessage(CHAT, 'through the fake');
    expect(telegram.count()).toBe(1);
    expect(telegram.foreignRequests).toEqual([]);
  });

  it('keeps sensitiveLogs off: a network failure names the method, never the token', async () => {
    const { telegram, api } = setup();
    telegram.fail({ method: 'sendMessage' }, FAILURES.networkFailure);
    const caught: unknown = await api.sendMessage(CHAT, 'x').catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).message).toBe("Network request for 'sendMessage' failed!");
    expect((caught as HttpError).message).not.toContain(config.botToken);
    expect(clientOptions(telegram.fetch)).toEqual({ fetch: telegram.fetch, sensitiveLogs: false });
  });

  it('satisfies the port, which refuses previews by type', async () => {
    const { telegram, api } = setup();
    const port: BotApiPort = api;
    await port.sendMessage(CHAT, 'typed', { link_preview_options: { is_disabled: true }, parse_mode: 'HTML' });
    // @ts-expect-error: the port admits previews disabled only
    await port.sendMessage(CHAT, 'typed', { link_preview_options: { is_disabled: false } });
    // @ts-expect-error: the port admits HTML only
    await port.sendMessage(CHAT, 'typed', { parse_mode: 'MarkdownV2' });
    expect(telegram.callsOf('sendMessage').map((call) => call.payload.link_preview_options)).toEqual([
      { is_disabled: true },
      { is_disabled: true },
      { is_disabled: true },
    ]);
  });

  it('is a plain grammY Api', () => {
    expect(setup().api).toBeInstanceOf(Api);
  });
});

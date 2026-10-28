// @critical-path
// Where the bot may answer an update (critical invariant 5: the bot sends a
// direct message only as a reply to a user's own message in their own chat,
// or as an alert to a keyholder; posts go only to the configured channel):
// - a pressed button is answered with answerCallbackQuery, never with a
//   message: the button may sit on a channel post, and ctx.reply() there
//   would send a message into the channel; and it is answered once:
//   answerPress() marks the update's context when Telegram took the answer,
//   so the error boundary, after a handler that answered first and then
//   failed, sends no second one;
// - a message in a private chat is answered in that chat, the sender's own;
// - a message in the admin review venue is answered in the venue;
// - anything else (the membership group, the channel, any other chat, any
//   other update) is not answered at all.
// The guards' refusals and the error boundary's replies all go through
// respond(); a handler's own replies follow the same rule (each handler is
// registered for private chats or buttons only).
import type { Context } from 'grammy';
import type { Config } from '../config/schema';
import { resolveLocale, t, type PlainMessageKey } from '../i18n/index';
import type { AnswerCallbackOptions } from './bot-api-port';

/** How respond() answered, if at all. */
export type RespondOutcome = 'answered' | 'replied' | 'silent';

/** Whether the bot answers a message in `chat`: a private chat, or the venue. */
export const answersIn = (config: Pick<Config, 'adminChatId'>, chat: { readonly id: number; readonly type: string }): boolean =>
  chat.type === 'private' || chat.id === config.adminChatId;

/** The updates whose press has been answered, marked on their context (it lives as long as the update). */
const answeredPresses = new WeakSet<Context>();

/** Whether this update's press has been answered. */
export const pressAnswered = (ctx: Context): boolean => answeredPresses.has(ctx);

/**
 * Answers this update's press once. True when it answered now; false, with
 * nothing sent, when it was answered already. The mark is set only once
 * Telegram took the answer, so a failed answer can be tried again.
 */
export async function answerPress(ctx: Context, options?: AnswerCallbackOptions): Promise<boolean> {
  if (answeredPresses.has(ctx)) return false;
  await ctx.answerCallbackQuery(options);
  answeredPresses.add(ctx);
  return true;
}

/**
 * Answers the update with `text` where the rule above allows it, and says
 * how; a press answered already gets nothing more ('silent').
 */
export async function respond(ctx: Context, config: Pick<Config, 'adminChatId'>, text: string): Promise<RespondOutcome> {
  if (ctx.callbackQuery !== undefined) return (await answerPress(ctx, { text })) ? 'answered' : 'silent';
  const chat = ctx.message?.chat;
  if (chat !== undefined && answersIn(config, chat)) {
    await ctx.reply(text);
    return 'replied';
  }
  return 'silent';
}

/** respond() with the catalog string `key` in the sender's locale. */
export const respondWith = (ctx: Context, config: Pick<Config, 'adminChatId'>, key: PlainMessageKey): Promise<RespondOutcome> =>
  respond(ctx, config, t(resolveLocale(ctx.from?.language_code), key));

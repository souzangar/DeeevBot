// @critical-path
// The review's messages in the admin review venue (critical invariants 3, 4
// and 5; doc/product/review-and-abuse-controls.md, "Review venue"): the
// review card, the routing card, the status card and the force-reply
// prompts all go to ADMIN_CHAT_ID and nowhere else, through these helpers.
// - Every text is checked before it leaves, sent or edited: it fits
//   Telegram's 4096 characters, and every tappable link in it is on
//   TRUSTED_HELP_HOSTS or, as a normalised target link, on
//   ALLOWED_LINK_HOSTS (outgoingLinkProblems()); a text that fails is not
//   sent (an AppError UNEXPECTED, whose message holds no text). A reported
//   URL of any host is shown, but only as <code>, which is not tappable.
// - Every send and edit goes through the one transformer (previews off,
//   HTML), the api being the bot's own.
// - An edit to what the message already shows ("message is not modified")
//   is no failure. A deletion is tried twice; a message already gone counts
//   as deleted; one that cannot be deleted (Telegram's 48 hours, which bind
//   an administrator bot as well) is edited instead to the given text,
//   without links or buttons; whatever still fails is logged by class, never
//   with the ids or the text.
// - The venue is monolingual: every message written there, the card posted
//   at intake and every message a press or a reply produces, is in
//   VENUE_LOCALE (config.venueLocale, Persian by default), whoever acts, so
//   a card never changes language between its edits and the venue's text
//   reveals no admin's client language. An answer to a press is in the
//   actor's locale: the venue's for a venue actor, a keyholder's own for a
//   keyholder (src/telegram/review.ts).
import type { ForceReply, InlineKeyboardMarkup, Message } from 'grammy/types';
import type { Clock } from '../clock';
import type { Config } from '../config/schema';
import type { SqlDb } from '../db/sql';
import { AppError } from '../errors/app-error';
import type { Locale } from '../i18n/index';
import type { Logger } from '../privacy/logger';
import type { BotApiPort } from '../telegram/bot-api-port';
import { classifyTelegramError } from '../telegram/errors';
import type { NoticeMemory } from './notify';
import { postProblems, sendable } from './render-post';

/** A message's text and buttons. */
export interface CardView {
  readonly text: string;
  readonly keyboard?: InlineKeyboardMarkup;
}

/** What every review flow works with: the bot's api, the configuration, the store, the clock, the logger. */
export interface ReviewDeps {
  readonly api: Pick<BotApiPort, 'sendMessage' | 'editMessageText' | 'deleteMessage'>;
  readonly config: Config;
  readonly db: SqlDb;
  readonly clock: Clock;
  readonly logger: Logger;
  /** The isolate's memory of the keyholder notices (src/review/notify.ts). */
  readonly notices: NoticeMemory;
}

/**
 * Who acts: an allowlisted id (checked by the gates before any flow runs),
 * and the locale the press is answered in: the venue's for an admin in the
 * venue, the keyholder's own for a keyholder. Messages in the venue never
 * take it: they are in config.venueLocale.
 */
export interface Actor {
  readonly id: number;
  readonly locale: Locale;
}

/** The message a press sat on. */
export interface Pressed {
  readonly chatId: number;
  readonly messageId: number;
  /**
   * When Telegram says the message was sent, in milliseconds (its `date`,
   * in seconds, times 1000; 0 for a message Telegram no longer gives).
   * Unknown when not given: no flow then takes the message for an old one.
   */
  readonly sentAt?: number;
}

/** What a press is answered with: a short plain text, or nothing. */
export interface PressOutcome {
  readonly answer?: string;
}

/** Refuses `text` unless it may be sent (see the header). */
export function checkedText(config: Pick<Config, 'allowedLinkHosts'>, text: string): string {
  if (!sendable(postProblems(text, config.allowedLinkHosts))) {
    throw new AppError('UNEXPECTED', 'a review message is too long or carries a link off the lists');
  }
  return text;
}

/** Sends `view` to the venue, as a reply to `replyTo` when given, with a force reply instead of buttons when asked. */
export async function sendToVenue(
  deps: Pick<ReviewDeps, 'api' | 'config'>,
  view: CardView,
  options: { readonly replyTo?: number; readonly forceReply?: ForceReply } = {},
): Promise<Message> {
  const text = checkedText(deps.config, view.text);
  const markup = options.forceReply ?? view.keyboard;
  return deps.api.sendMessage(deps.config.adminChatId, text, {
    ...(markup === undefined ? {} : { reply_markup: markup }),
    ...(options.replyTo === undefined
      ? {}
      : { reply_parameters: { message_id: options.replyTo, allow_sending_without_reply: true } }),
  });
}

/**
 * Edits message `messageId` of `chatId` (the venue's unless given) to
 * `view`; no buttons when the view has none. "Message is not modified" is
 * no failure; any other failure throws.
 */
export async function editMessage(
  deps: Pick<ReviewDeps, 'api' | 'config'>,
  messageId: number,
  view: CardView,
  chatId: number = deps.config.adminChatId,
): Promise<void> {
  const text = checkedText(deps.config, view.text);
  try {
    await deps.api.editMessageText(chatId, messageId, text, view.keyboard === undefined ? {} : { reply_markup: view.keyboard });
  } catch (error) {
    if (classifyTelegramError(error).kind !== 'message_not_modified') throw error;
  }
}

/**
 * editMessage(), after a decision committed: a message already gone (a
 * card another decision deleted) is left alone, any other failure is
 * logged by class, and nothing ends. True when the edit went.
 */
export async function editAfterCommit(
  deps: Pick<ReviewDeps, 'api' | 'config' | 'logger'>,
  messageId: number,
  view: CardView,
  chatId?: number,
): Promise<boolean> {
  try {
    await editMessage(deps, messageId, view, chatId);
    return true;
  } catch (error) {
    if (classifyTelegramError(error).kind !== 'message_not_found') deps.logger.logError('review.message_not_edited', error);
    return false;
  }
}

/** Deletes message `messageId` of the venue, trying twice; true when it is gone (see the header). Never throws. */
export async function deleteInVenue(deps: Pick<ReviewDeps, 'api' | 'config' | 'logger'>, messageId: number): Promise<boolean> {
  let failure: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await deps.api.deleteMessage(deps.config.adminChatId, messageId);
      return true;
    } catch (error) {
      if (classifyTelegramError(error).kind === 'message_not_found') return true;
      failure = error;
    }
  }
  deps.logger.logError('review.message_not_deleted', failure);
  return false;
}

/**
 * Deletes message `messageId` of the venue, or, when it cannot be deleted,
 * edits it to `fallback` (see the header). Never throws.
 */
export async function deleteOrEdit(
  deps: Pick<ReviewDeps, 'api' | 'config' | 'logger'>,
  messageId: number,
  fallback: CardView,
): Promise<void> {
  if (await deleteInVenue(deps, messageId)) return;
  await editAfterCommit(deps, messageId, fallback);
}

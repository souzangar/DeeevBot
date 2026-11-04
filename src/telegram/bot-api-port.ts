// @critical-path
// The Bot API port (the MVP plan, section 2, "Ports"; critical invariants 4
// and 5): the subset of the Telegram Bot API the project calls, typed. A
// grammY Api built by createBotApi() (src/telegram/api.ts) satisfies it, and
// so does the fake every test drives (test/fakes/bot-api.ts, through the
// same grammY Api over a fake fetch).
//
// The send and edit options carry no preview or parse-mode choice of their
// own: `link_preview_options` may only be `{ is_disabled: true }` and
// `parse_mode` only 'HTML', so a caller asking the port for previews (the
// flag set to false) fails the build. The one transformer sets both on every
// sendMessage and editMessageText whatever the caller passes, which also
// covers code that calls grammY's own methods (ctx.reply and the like),
// whose types cannot be narrowed here.
//
// Deliberately absent: forwardMessage, copyMessage, getFile and getChat
// (critical invariant 4: reported content is never forwarded, copied,
// fetched or looked up; the tripwire flags them), sendRichMessage and the
// rich form of editMessageText, every media send, and inline mode.
import type {
  ChatMember,
  ForceReply,
  InlineKeyboardMarkup,
  Message,
  ReplyParameters,
  Update,
  UserFromGetMe,
  WebhookInfo,
} from 'grammy/types';

/** The only link-preview setting the project ever sends. */
export interface PreviewsDisabled {
  readonly is_disabled: true;
}

/** What a send may say about previews and parsing: nothing but the enforced values. */
interface EnforcedFormat {
  readonly link_preview_options?: PreviewsDisabled;
  readonly parse_mode?: 'HTML';
}

/** The options the project passes to sendMessage. */
export interface SendOptions extends EnforcedFormat {
  readonly reply_markup?: InlineKeyboardMarkup | ForceReply;
  readonly reply_parameters?: ReplyParameters;
  /** Forum topics: a reply in a topic stays in it (the MVP plan, section 8). */
  readonly message_thread_id?: number;
  readonly disable_notification?: boolean;
  readonly protect_content?: boolean;
}

/** The options the project passes to editMessageText. */
export interface EditTextOptions extends EnforcedFormat {
  /** Omitted, Telegram removes the message's inline keyboard. */
  readonly reply_markup?: InlineKeyboardMarkup;
}

/** The options the project passes to editMessageReplyMarkup. */
export interface EditMarkupOptions {
  /** Omitted, Telegram removes the message's inline keyboard. */
  readonly reply_markup?: InlineKeyboardMarkup;
}

/** The options the project passes to answerCallbackQuery: a short text, never a URL. */
export interface AnswerCallbackOptions {
  readonly text?: string;
  readonly show_alert?: boolean;
}

/** The options the Node port's long polling passes to getUpdates. */
export interface GetUpdatesOptions {
  readonly offset?: number;
  readonly limit?: number;
  readonly timeout?: number;
  readonly allowed_updates?: readonly ('message' | 'callback_query')[];
}

/** The options the operations script passes to setWebhook (scripts/set-webhook.ts; ADR 0003). */
export interface SetWebhookOptions {
  readonly secret_token?: string;
  readonly max_connections?: number;
  readonly allowed_updates?: readonly ('message' | 'callback_query')[];
  readonly drop_pending_updates?: boolean;
}

/** The subset of the Bot API the project calls. */
export interface BotApiPort {
  getMe(): Promise<UserFromGetMe>;
  getUpdates(other?: GetUpdatesOptions): Promise<Update[]>;
  setWebhook(url: string, other?: SetWebhookOptions): Promise<true>;
  deleteWebhook(other?: { readonly drop_pending_updates?: boolean }): Promise<true>;
  /** What the operations script prints after it set or deleted the webhook, the URL's path masked (scripts/set-webhook.ts). */
  getWebhookInfo(): Promise<WebhookInfo>;
  /** The membership check (src/auth/membership.ts); its answer is never stored. */
  getChatMember(chatId: number, userId: number): Promise<ChatMember>;
  sendMessage(chatId: number, text: string, other?: SendOptions): Promise<Message>;
  editMessageText(chatId: number, messageId: number, text: string, other?: EditTextOptions): Promise<Message | true>;
  /** Returns the edited Message, whose reply_markup /attach reads back (the MVP plan, section 4). */
  editMessageReplyMarkup(chatId: number, messageId: number, other?: EditMarkupOptions): Promise<Message | true>;
  deleteMessage(chatId: number, messageId: number): Promise<true>;
  answerCallbackQuery(callbackQueryId: string, other?: AnswerCallbackOptions): Promise<true>;
}

/** The port's methods by name: what the fake supports and what a log line may name. */
export const PORT_METHODS = [
  'getMe',
  'getUpdates',
  'setWebhook',
  'deleteWebhook',
  'getWebhookInfo',
  'getChatMember',
  'sendMessage',
  'editMessageText',
  'editMessageReplyMarkup',
  'deleteMessage',
  'answerCallbackQuery',
] as const satisfies readonly (keyof BotApiPort)[];

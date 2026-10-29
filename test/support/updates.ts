// Builders for the Telegram updates tests feed the bot: messages in a
// private chat, a group or the venue, button presses, and the update kinds
// the bot must ignore. Each update gets a fresh update_id and message id.
// A text that starts with a command (/start, /lockdown@bot) carries the
// bot_command entity Telegram adds, so grammY's command matching sees what
// it would see live.
import type { Message, Update } from 'grammy/types';
import { IDS } from './variables';

let lastUpdateId = 0;
let lastMessageId = 0;
const nextUpdateId = (): number => (lastUpdateId += 1);
const nextMessageId = (): number => (lastMessageId += 1);

/** Seconds since the epoch, as Telegram dates are. */
const DATE = 1_800_000_000;

export interface SenderOptions {
  readonly languageCode?: string;
  readonly firstName?: string;
  readonly username?: string;
}

export interface MessageOptions extends SenderOptions {
  /** Marks the message as forwarded (a hidden user's). */
  readonly forwarded?: boolean;
  /** Marks the message as sent through an inline bot. */
  readonly viaBot?: boolean;
  /** Marks the message as a reply quoting a message of another chat. */
  readonly externalReply?: boolean;
  /** Marks the message as a reply to the bot's own message of this id, in the same chat. */
  readonly replyToBot?: number;
}

const sender = (id: number, options: SenderOptions) => ({
  id,
  is_bot: false as const,
  first_name: options.firstName ?? 'Tester',
  ...(options.username === undefined ? {} : { username: options.username }),
  ...(options.languageCode === undefined ? {} : { language_code: options.languageCode }),
});

/** The bot_command entity of a text that starts with a command, if it does. */
const commandEntities = (text: string): Message['entities'] => {
  const command = /^\/[A-Za-z0-9_]+(?:@[A-Za-z0-9_]+)?/.exec(text)?.[0];
  return command === undefined ? undefined : [{ type: 'bot_command', offset: 0, length: command.length }];
};

const textMessage = (chat: Message['chat'], userId: number, text: string, options: MessageOptions): Message => {
  const entities = commandEntities(text);
  return {
    message_id: nextMessageId(),
    date: DATE,
    chat,
    from: sender(userId, options),
    text,
    ...(entities === undefined ? {} : { entities }),
    ...(options.forwarded === true
      ? { forward_origin: { type: 'hidden_user' as const, date: DATE - 60, sender_user_name: 'Someone Else' } }
      : {}),
    ...(options.viaBot === true ? { via_bot: { id: 424240099, is_bot: true as const, first_name: 'Inline', username: 'some_inline_bot' } } : {}),
    ...(options.externalReply === true
      ? { external_reply: { origin: { type: 'hidden_user' as const, date: DATE - 60, sender_user_name: 'Someone Else' } } }
      : {}),
    ...(options.replyToBot === undefined
      ? {}
      : {
          // grammY types the replied-to message without a reply of its own; this one has none.
          reply_to_message: {
            message_id: options.replyToBot,
            date: DATE - 30,
            chat,
            from: { id: IDS.bot, is_bot: true as const, first_name: 'Fake', username: 'div_report_test_bot' },
            text: 'A message of the bot',
          } as unknown as NonNullable<Message['reply_to_message']>,
        }),
  };
};

/** A text (or command) from `userId` in their own private chat with the bot. */
export function privateMessage(userId: number, text: string, options: MessageOptions = {}): Update {
  return {
    update_id: nextUpdateId(),
    message: textMessage({ id: userId, type: 'private', first_name: options.firstName ?? 'Tester' }, userId, text, options),
  } as Update;
}

/** A private-chat message carrying a photo and a caption, no text. */
export function privatePhoto(userId: number, caption: string, options: SenderOptions = {}): Update {
  return {
    update_id: nextUpdateId(),
    message: {
      message_id: nextMessageId(),
      date: DATE,
      chat: { id: userId, type: 'private', first_name: options.firstName ?? 'Tester' },
      from: sender(userId, options),
      photo: [{ file_id: 'photo-file', file_unique_id: 'photo-unique', width: 10, height: 10 }],
      caption,
    },
  };
}

/** What a private message can carry instead of text. */
export const MEDIA_KINDS = ['photo', 'document', 'video', 'sticker', 'voice', 'animation', 'location', 'contact', 'poll'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

const FILE = { file_id: 'media-file', file_unique_id: 'media-unique' };

/** The field a message of `kind` carries, with the least Telegram sends for it. */
const mediaField = (kind: MediaKind): Record<string, unknown> => {
  switch (kind) {
    case 'photo':
      return { photo: [{ ...FILE, width: 10, height: 10 }] };
    case 'document':
      return { document: { ...FILE, file_name: 'leak.pdf' } };
    case 'video':
      return { video: { ...FILE, width: 10, height: 10, duration: 1 } };
    case 'sticker':
      return { sticker: { ...FILE, type: 'regular', width: 10, height: 10, is_animated: false, is_video: false } };
    case 'voice':
      return { voice: { ...FILE, duration: 1 } };
    case 'animation':
      return { animation: { ...FILE, width: 10, height: 10, duration: 1 } };
    case 'location':
      return { location: { latitude: 35.7, longitude: 51.4 } };
    case 'contact':
      return { contact: { phone_number: '09120000000', first_name: 'Someone' } };
    case 'poll':
      return {
        poll: {
          id: 'poll',
          question: 'Q',
          options: [],
          total_voter_count: 0,
          is_closed: false,
          is_anonymous: true,
          type: 'regular',
          allows_multiple_answers: false,
        },
      };
  }
};

/** A private-chat message carrying `kind` instead of text, with `caption` where the kind takes one. */
export function privateMedia(userId: number, kind: MediaKind, caption?: string, options: SenderOptions = {}): Update {
  return {
    update_id: nextUpdateId(),
    message: {
      message_id: nextMessageId(),
      date: DATE,
      chat: { id: userId, type: 'private', first_name: options.firstName ?? 'Tester' },
      from: sender(userId, options),
      ...mediaField(kind),
      ...(caption === undefined ? {} : { caption }),
    },
  };
}

/** A text (or command) from `userId` in the supergroup `chatId` (the venue, the membership group, any group). */
export function groupMessage(chatId: number, userId: number, text: string, options: MessageOptions = {}): Update {
  return {
    update_id: nextUpdateId(),
    message: textMessage({ id: chatId, type: 'supergroup', title: 'A group' }, userId, text, options),
  } as Update;
}

/** An edited private message: an update kind the bot ignores. */
export function editedPrivateMessage(userId: number, text: string): Update {
  return {
    update_id: nextUpdateId(),
    edited_message: {
      ...textMessage({ id: userId, type: 'private', first_name: 'Tester' }, userId, text, {}),
      edit_date: DATE + 1,
    },
  } as Update;
}

/** A post in a channel: an update kind the bot ignores. */
export function channelPost(chatId: number, text: string): Update {
  return {
    update_id: nextUpdateId(),
    channel_post: { message_id: nextMessageId(), date: DATE, chat: { id: chatId, type: 'channel', title: 'A channel' }, text },
  };
}

/** Where a pressed button sits. */
export interface PressedMessage {
  readonly chatId: number;
  readonly messageId: number;
  readonly chatType?: 'private' | 'supergroup' | 'channel';
  /** The message's `date`, in seconds: a fixed one unless given. */
  readonly date?: number;
}

/** A press by `userId` of a button carrying `data`, on the message `on`. */
export function buttonPress(userId: number, data: string, on: PressedMessage, options: SenderOptions = {}): Update {
  const type = on.chatType ?? (on.chatId > 0 ? 'private' : 'channel');
  const chat =
    type === 'private'
      ? { id: on.chatId, type, first_name: 'Tester' }
      : { id: on.chatId, type, title: type === 'channel' ? 'The channel' : 'A group' };
  return {
    update_id: nextUpdateId(),
    callback_query: {
      id: `press-${nextUpdateId()}`,
      from: sender(userId, options),
      chat_instance: 'chat-instance',
      data,
      message: { message_id: on.messageId, date: on.date ?? DATE, chat, text: 'A post' },
    },
  };
}

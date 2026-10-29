// The admin review, driven through a bot harness (test/support/bot-harness.ts)
// as the admins and the keyholders drive it: a report submitted through the
// real intake (test/support/intake-driver.ts), whose card the bot posts to
// the venue; presses of the card's buttons by an admin, in the venue; the
// force-reply prompts answered by a reply, which is first put into the
// fake Bot API's store under the venue's next message id, as Telegram holds
// it, so the bot's deleteMessage finds it and a test can see that it is
// gone; and a keyholder's presses on the approval notice in their own chat.
// A press carries the date the fake holds for the pressed message, as
// Telegram's callback query carries the message's own date.
// Fixture values are never secret-shaped.
import type { Update } from 'grammy/types';
import { sql } from '../../src/db/sql';
import { reviewData, type ReviewAction } from '../../src/review/callbacks';
import type { Category, LinkMode } from '../../src/review/categories';
import type { StoredMessage } from '../fakes/bot-api';
import type { BotHarness } from './bot-harness';
import { report, reporterIn, type ReportAnswers } from './intake-driver';
import { buttonPress, groupMessage, type MessageOptions, type SenderOptions } from './updates';
import { IDS } from './variables';

/** A submitted report, as the venue shows it. */
export interface SubmittedReport {
  readonly reportId: string;
  /** The card's message id in the venue. */
  readonly cardId: number;
}

/** What an approval answers: the category, the account link when asked, the link mode and the points. */
export interface ApprovalAnswers {
  readonly category: Category;
  readonly account?: string;
  readonly mode: LinkMode;
  readonly points: string;
}

export interface ReviewDriver {
  /** Submits a report through the intake as `reporterId` (a member) and returns it with its card. */
  submit(answers: ReportAnswers, reporterId?: number, sender?: SenderOptions): Promise<SubmittedReport>;
  /** Presses `action`'s button as `adminId` on venue message `messageId` (the report's card unless given). */
  press(adminId: number, action: ReviewAction, messageId: number, sender?: SenderOptions): Promise<void>;
  /** Presses raw `data` as `userId` on message `messageId` of `chatId` (the venue unless given). */
  pressData(userId: number, data: string, messageId: number, chatId?: number, sender?: SenderOptions): Promise<void>;
  /** The bot's latest force-reply prompt in the venue. */
  lastPrompt(): StoredMessage | undefined;
  /** Replies as `userId` to venue message `replyTo` with `text`; the reply's message id. */
  reply(userId: number, replyTo: number, text: string, options?: MessageOptions): Promise<number>;
  /** Sends any update of the venue as it is, its message (if any) in the store first. */
  sendVenue(update: Update): Promise<void>;
  /** A whole approval of `submitted` by `adminId`: Approve, the category, the account if asked, the mode, the points. */
  approve(adminId: number, submitted: SubmittedReport, answers: ApprovalAnswers, sender?: SenderOptions): Promise<void>;
  /** The notices the keyholders hold for `reportId`, by their chat. */
  noticesOf(reportId: string): StoredMessage[];
  /** The review card's text and buttons in the venue, if it is there. */
  card(submitted: SubmittedReport): StoredMessage | undefined;
  /** The callback data of `message`'s buttons. */
  buttonsOf(message: StoredMessage | undefined): string[];
}

const dataOf = (message: StoredMessage | undefined): string[] => {
  const markup = message?.reply_markup as { inline_keyboard?: { callback_data?: string }[][] } | undefined;
  return (markup?.inline_keyboard ?? []).flat().map((button) => button.callback_data ?? '');
};

const isForceReply = (message: StoredMessage): boolean =>
  (message.reply_markup as { force_reply?: boolean } | undefined)?.force_reply === true;

/** The review of `harness`'s bot (see the header). */
export function reviewIn(harness: BotHarness): ReviewDriver {
  const sendVenue = async (update: Update): Promise<void> => {
    await harness.send(update);
  };
  const reply = async (userId: number, replyTo: number, text: string, options: MessageOptions = {}): Promise<number> => {
    const messageId = harness.telegram.receive(IDS.adminChat, { text });
    const update = groupMessage(IDS.adminChat, userId, text, { ...options, replyToBot: replyTo });
    await harness.send({ ...update, message: { ...update.message, message_id: messageId } } as Update);
    return messageId;
  };
  const lastPrompt = (): StoredMessage | undefined => harness.telegram.messagesIn(IDS.adminChat).filter(isForceReply).at(-1);
  const pressData = async (userId: number, data: string, messageId: number, chatId: number = IDS.adminChat, sender: SenderOptions = {}) => {
    const date = harness.telegram.messageIn(chatId, messageId)?.date;
    await harness.send(
      buttonPress(
        userId,
        data,
        { chatId, messageId, chatType: chatId === IDS.adminChat ? 'supergroup' : 'private', ...(date === undefined ? {} : { date }) },
        sender,
      ),
    );
  };
  const press = (adminId: number, action: ReviewAction, messageId: number, sender: SenderOptions = {}) =>
    pressData(adminId, reviewData(action), messageId, IDS.adminChat, sender);
  return {
    submit: async (answers, reporterId = IDS.reporter, sender = {}) => {
      harness.telegram.setMember(IDS.membershipChat, reporterId, { status: 'member' });
      await report(reporterIn(harness, reporterId, sender), answers);
      const row = await harness.db.first<{ id: string; card_message_id: number | null }>(
        sql`SELECT id, card_message_id FROM reports WHERE status IN ('pending', 'merged') ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      );
      if (row === null) throw new Error('no report was submitted');
      return { reportId: row.id, cardId: row.card_message_id ?? 0 };
    },
    press,
    pressData,
    lastPrompt,
    reply,
    sendVenue,
    approve: async (adminId, submitted, answers, sender = {}) => {
      const { reportId, cardId } = submitted;
      await press(adminId, { kind: 'approve', reportId }, cardId, sender);
      await press(adminId, { kind: 'category', reportId, category: answers.category }, cardId, sender);
      if (answers.account !== undefined) {
        const prompt = lastPrompt();
        if (prompt === undefined) throw new Error('no account prompt');
        await reply(adminId, prompt.message_id, answers.account, sender);
      }
      await press(adminId, { kind: 'mode', reportId, category: answers.category, mode: answers.mode }, cardId, sender);
      const prompt = lastPrompt();
      if (prompt === undefined) throw new Error('no points prompt');
      await reply(adminId, prompt.message_id, answers.points, sender);
    },
    noticesOf: (reportId) =>
      harness.config.keyholderIds.flatMap((keyholder) =>
        harness.telegram.messagesIn(keyholder).filter((message) => dataOf(message).some((data) => data.includes(reportId)) || (message.text ?? '').includes(reportId)),
      ),
    card: (submitted) => harness.telegram.messageIn(IDS.adminChat, submitted.cardId),
    buttonsOf: dataOf,
  };
}

// One reporter's intake conversation, driven through a bot harness
// (test/support/bot-harness.ts). Each message the reporter sends is first
// put into the fake Bot API's store under the chat's next message id, as
// Telegram holds it (one sequence for both sides of a private chat), so the
// bot's deleteMessage finds it and a test can see that it is gone; a press
// goes to the bot's latest message in the chat that carries the button.
import type { Update } from 'grammy/types';
import type { Category } from '../../src/review/categories';
import { pressData } from '../../src/review/intake';
import type { StoredMessage } from '../fakes/bot-api';
import type { BotHarness } from './bot-harness';
import { buttonPress, privateMessage, type MessageOptions, type SenderOptions } from './updates';

export interface Reporter {
  readonly id: number;
  /** Sends `text` as this reporter, its message in the store first; returns the update as sent. */
  say(text: string, options?: MessageOptions): Promise<Update>;
  /** Sends any update of this reporter's, its message (if any) in the store first; returns it as sent. */
  send(update: Update): Promise<Update>;
  /** Presses the button with `data` on the bot's latest message that has it. */
  press(data: string): Promise<void>;
  /** The bot's latest message in the chat that carries buttons. */
  lastPrompt(): StoredMessage | undefined;
  /** The message ids this reporter sent. */
  readonly sent: readonly number[];
}

/** What a whole conversation answers. */
export interface ReportAnswers {
  readonly url: string;
  /** The account's link, when the bot asks for it; 'unknown', or none, presses "I don't know". */
  readonly account?: string;
  readonly category: Category;
  readonly affected: boolean;
  /** The comment, or /skip when absent. */
  readonly comment?: string;
}

const buttonsOf = (message: StoredMessage): string[] => {
  const markup = message.reply_markup as { inline_keyboard?: { callback_data?: string }[][] } | undefined;
  return (markup?.inline_keyboard ?? []).flat().map((button) => button.callback_data ?? '');
};

/** The reporter `id` in `harness`'s bot. */
export function reporterIn(harness: Pick<BotHarness, 'telegram' | 'send'>, id: number, sender: SenderOptions = {}): Reporter {
  const sent: number[] = [];
  const send = async (update: Update): Promise<Update> => {
    const message = update.message;
    if (message === undefined) {
      await harness.send(update);
      return update;
    }
    const messageId = harness.telegram.receive(id, message.text === undefined ? {} : { text: message.text });
    sent.push(messageId);
    const numbered = { ...update, message: { ...message, message_id: messageId } } as Update;
    await harness.send(numbered);
    return numbered;
  };
  const latestWith = (data: string): StoredMessage | undefined =>
    harness.telegram
      .messagesIn(id)
      .filter((message) => buttonsOf(message).includes(data))
      .at(-1);
  return {
    id,
    sent,
    say: (text, options = {}) => send(privateMessage(id, text, { ...sender, ...options })),
    send,
    press: async (data) => {
      const prompt = latestWith(data);
      if (prompt === undefined) throw new Error(`no message in the chat carries ${data}`);
      await harness.send(buttonPress(id, data, { chatId: id, messageId: prompt.message_id, chatType: 'private' }, sender));
    },
    lastPrompt: () =>
      harness.telegram
        .messagesIn(id)
        .filter((message) => buttonsOf(message).length > 0)
        .at(-1),
  };
}

/** Runs a whole conversation: the link, the account if asked, the category, the flag, the comment. */
export async function report(reporter: Reporter, answers: ReportAnswers): Promise<void> {
  await reporter.say(answers.url);
  const prompt = reporter.lastPrompt();
  const asksForAccount = prompt !== undefined && buttonsOf(prompt).includes(pressData({ kind: 'account_unknown' }));
  if (asksForAccount) {
    if (answers.account === undefined || answers.account === 'unknown') await reporter.press(pressData({ kind: 'account_unknown' }));
    else await reporter.say(answers.account);
  }
  await reporter.press(pressData({ kind: 'category', category: answers.category }));
  await reporter.press(pressData({ kind: 'affected', affected: answers.affected }));
  await reporter.say(answers.comment ?? '/skip');
}

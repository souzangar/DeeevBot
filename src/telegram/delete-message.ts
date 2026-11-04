// @critical-path
// Deleting what a user sends on receipt (critical invariants 3 and 8;
// doc/product/report-lifecycle.md, "Intake"; doc/product/threat-model-seizure.md,
// "A reporter's or member's phone"). Outside lockdown every message the bot
// receives in a private chat is deleted by the handler that took it,
// whatever it is: every intake step, a refused or misplaced message,
// /cancel, /skip, a command the bot does not know, /start and /language,
// so no reported URL, typed anywhere, stays in the sender's chat. The two
// exceptions: a keyholder's own commands (/start from a keyholder,
// /lockdown, /unlock, and every command registered through
// src/telegram/registry.ts's keyholderCommand: /open, /attach, /halt,
// /retract and /stats), whose chat is an operations log the keyholder
// keeps (their reply to a retraction prompt is deleted with the prompt
// once taken, src/telegram/closing.ts); and the lockdown path, which
// reads, stores and deletes nothing.
//
// A handler deletes after the write that recorded what the message said
// has committed and before its reply. The delete is awaited and retried
// once; a message already gone counts as deleted; if it still fails, the
// reply asks the sender to delete it themselves (withDeleteNote) and the
// failure is logged by class, never with the ids.
import type { Context } from 'grammy';
import { t, type Locale } from '../i18n/index';
import type { Logger } from '../privacy/logger';
import type { BotApiPort } from './bot-api-port';
import { classifyTelegramError } from './errors';

/** Deletes message `messageId` of `chatId`, retrying once (see the header); true when it is gone. */
export async function deleteReceivedMessage(
  api: Pick<BotApiPort, 'deleteMessage'>,
  logger: Logger,
  chatId: number,
  messageId: number,
): Promise<boolean> {
  let failure: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await api.deleteMessage(chatId, messageId);
      return true;
    } catch (error) {
      if (classifyTelegramError(error).kind === 'message_not_found') return true;
      failure = error;
    }
  }
  logger.logError('intake.message_not_deleted', failure);
  return false;
}

/** Deletes the update's own message, if it has one (see the header); true when it is gone. */
export function deleteOwnMessage(ctx: Context, logger: Logger): Promise<boolean> {
  const message = ctx.message;
  if (message === undefined) return Promise.resolve(true);
  return deleteReceivedMessage(ctx.api, logger, message.chat.id, message.message_id);
}

/** `text`, with the request to delete the message by hand when it could not be deleted. */
export const withDeleteNote = (locale: Locale, text: string, deleted: boolean): string =>
  deleted ? text : `${text}\n\n${t(locale, 'intake.delete_yourself')}`;

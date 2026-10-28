// @critical-path
// Alerts (critical invariants 2 and 5; ADR 0003, "Keyholder alerts";
// ADR 0004, "Reconciliation"): the only direct messages the bot sends that
// are not a reply in the reader's own chat.
// - alertKeyholders() sends the alert to every id on KEYHOLDER_IDS, one by
//   one, under lockdown too. A bot cannot start a private chat, so a
//   keyholder who has not sent /start yet answers 403; every failed send is
//   logged by class (never the id or the text) and counted, never dropped:
//   the caller, reconciliation, marks an alert sent only when `failed` is 0,
//   so the next run retries it.
// - alertVenue() sends it to the admin review venue, unless the bot is
//   locked down: the venue is compromised by assumption then, and nothing
//   is sent there.
// Each send goes through the one transformer (previews off, HTML), and the
// caller's text is Telegram HTML whose links already passed the link policy.
// Nothing is retried within the call: a 429 is a failure like any other.
import type { InlineKeyboardMarkup } from 'grammy/types';
import { isLockedDown } from '../auth/lockdown';
import type { Config } from '../config/schema';
import type { SqlDb } from '../db/sql';
import type { Logger } from '../privacy/logger';
import type { BotApiPort } from './bot-api-port';

export interface AlertDeps {
  readonly api: Pick<BotApiPort, 'sendMessage'>;
  readonly config: Pick<Config, 'keyholderIds' | 'adminChatId' | 'lockdown'>;
  readonly logger: Logger;
}

/** One alert that reached its chat: the keyholder notices are edited later by these. */
export interface Delivery {
  readonly chatId: number;
  readonly messageId: number;
}

export interface AlertOutcome {
  readonly sent: number;
  readonly failed: number;
  readonly deliveries: readonly Delivery[];
}

export interface AlertOptions {
  /** The keyholder notice's Cancel and Lockdown buttons, for instance. */
  readonly reply_markup?: InlineKeyboardMarkup;
}

/** Sends `text` to each chat in turn; a failure is logged by class and counted. */
const sendEach = async (
  deps: AlertDeps,
  chatIds: readonly number[],
  text: string,
  options: AlertOptions,
): Promise<AlertOutcome> => {
  const deliveries: Delivery[] = [];
  let failed = 0;
  for (const chatId of chatIds) {
    try {
      const message = await deps.api.sendMessage(chatId, text, options);
      deliveries.push({ chatId, messageId: message.message_id });
    } catch (error) {
      failed += 1;
      deps.logger.logError('alert.failed', error);
    }
  }
  return { sent: deliveries.length, failed, deliveries };
};

/** Sends `text` to every keyholder by direct message (see the header). Never throws. */
export function alertKeyholders(deps: AlertDeps, text: string, options: AlertOptions = {}): Promise<AlertOutcome> {
  return sendEach(deps, deps.config.keyholderIds, text, options);
}

export interface VenueAlertOutcome extends AlertOutcome {
  /** True when the bot is locked down, so nothing was sent. */
  readonly suppressed: boolean;
}

/**
 * Sends `text` to the admin review venue unless the bot is locked down (see
 * the header). A failed lockdown read throws (an AppError STORAGE_FAILURE):
 * the venue is never alerted on a guess.
 */
export async function alertVenue(
  deps: AlertDeps & { readonly db: SqlDb },
  text: string,
  options: AlertOptions = {},
): Promise<VenueAlertOutcome> {
  if (await isLockedDown(deps.config, deps.db)) return { sent: 0, failed: 0, deliveries: [], suppressed: true };
  return { ...(await sendEach(deps, [deps.config.adminChatId], text, options)), suppressed: false };
}

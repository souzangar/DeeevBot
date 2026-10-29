// @critical-path
// Alerts (critical invariants 2 and 5; ADR 0003, "Keyholder alerts";
// ADR 0004, "Reconciliation"): the only direct messages the bot sends that
// are not a reply in the reader's own chat.
// - alertKeyholders() sends the alert to every id on KEYHOLDER_IDS, one by
//   one, under lockdown too. A bot cannot start a private chat, so a
//   keyholder who has not sent /start yet answers 403; every failed send is
//   logged by class (never the id or the text) and counted: a caller marks
//   an alert sent once `sent` is above 0, as the approval notice is (one
//   delivered of several suffices), and the scheduler sends one that
//   reached nobody again at its next run.
// - alertVenue() sends it to the admin review venue, unless the bot is
//   locked down: the venue is compromised by assumption then, and nothing
//   is sent there.
// Each send goes through the one transformer (previews off, HTML). These
// two functions are the choke point for every link an alert carries (the U2
// audit's carried rule; critical invariant 4: every link sent to a
// keyholder passes the link policy): a caller hands structured input, the
// catalog's Telegram HTML plus, when it has any, `links`, each passed
// through the link policy (an exact host of ALLOWED_LINK_HOSTS, or of the
// fixed help and hotline list) and rendered as code text by withLinks();
// and the whole text is checked as every outgoing text is (within 4096
// characters, no tappable link off the lists) before anything is sent. A
// text or a link that fails is never sent to anyone: an AppError
// UNEXPECTED, whose message holds neither.
// Nothing is retried within the call: a 429 is a failure like any other.
import type { InlineKeyboardMarkup } from 'grammy/types';
import { isLockedDown } from '../auth/lockdown';
import type { Config } from '../config/schema';
import type { SqlDb } from '../db/sql';
import { AppError } from '../errors/app-error';
import { isSendableTargetLink, isTrustedHelpLink } from '../platforms/link-policy';
import type { Logger } from '../privacy/logger';
import { postProblems, sendable } from '../review/render-post';
import type { BotApiPort } from './bot-api-port';
import { withLinks } from './render';

export interface AlertDeps {
  readonly api: Pick<BotApiPort, 'sendMessage'>;
  readonly config: Pick<Config, 'keyholderIds' | 'adminChatId' | 'lockdown' | 'allowedLinkHosts'>;
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
  /**
   * Links the alert carries, each after the text on its own line as code
   * text, once it has passed the link policy (see the header).
   */
  readonly links?: readonly string[];
}

/**
 * The alert's text as it leaves: `text` and its `links` (see the header).
 * Throws an AppError UNEXPECTED for a link off the lists or a text that
 * may not be sent; never names either.
 */
export function alertText(config: Pick<Config, 'allowedLinkHosts'>, text: string, links: readonly string[] = []): string {
  if (!links.every((link) => isSendableTargetLink(link, config.allowedLinkHosts) || isTrustedHelpLink(link))) {
    throw new AppError('UNEXPECTED', 'an alert carries a link off the lists');
  }
  const message = withLinks('fa', text, links);
  if (!sendable(postProblems(message, config.allowedLinkHosts))) {
    throw new AppError('UNEXPECTED', 'an alert is too long or carries a link off the lists');
  }
  return message;
}

/** Sends the alert to each chat in turn; a failure is logged by class and counted. */
const sendEach = async (
  deps: AlertDeps,
  chatIds: readonly number[],
  text: string,
  options: AlertOptions,
): Promise<AlertOutcome> => {
  const message = alertText(deps.config, text, options.links);
  const sendOptions = options.reply_markup === undefined ? {} : { reply_markup: options.reply_markup };
  const deliveries: Delivery[] = [];
  let failed = 0;
  for (const chatId of chatIds) {
    try {
      const sent = await deps.api.sendMessage(chatId, message, sendOptions);
      deliveries.push({ chatId, messageId: sent.message_id });
    } catch (error) {
      failed += 1;
      deps.logger.logError('alert.failed', error);
    }
  }
  return { sent: deliveries.length, failed, deliveries };
};

/**
 * Sends `text` to every keyholder by direct message (see the header).
 * Never throws for a failed send; throws, sending nothing, for a text or a
 * link that may not be sent.
 */
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
 * the venue is never alerted on a guess; so does a text or a link that may
 * not be sent.
 */
export async function alertVenue(
  deps: AlertDeps & { readonly db: SqlDb },
  text: string,
  options: AlertOptions = {},
): Promise<VenueAlertOutcome> {
  if (await isLockedDown(deps.config, deps.db)) return { sent: 0, failed: 0, deliveries: [], suppressed: true };
  return { ...(await sendEach(deps, [deps.config.adminChatId], text, options)), suppressed: false };
}

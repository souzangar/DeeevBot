// @critical-path
// The keyholder's approval notice (critical invariants 1, 2, 4 and 5; the
// MVP plan, section 4, "Review"; doc/product/threat-model-seizure.md,
// controls 6 and 7): at every approval, every id on KEYHOLDER_IDS gets, by
// direct message, the post exactly as it will go out, with a Cancel button
// that works for the whole grace and a Lockdown button beside it, so someone
// outside the admins' reach sees each post before it goes out and one tap
// escalates when a seized admin keeps re-approving. Both buttons keep
// working under lockdown (src/telegram/registry.ts).
//
// - The notice is the alert of src/telegram/alerts.ts (one send per
//   keyholder, a failure logged by class and counted, never thrown), after
//   the same check every outgoing text gets: within Telegram's 4096
//   characters, every tappable link on the lists (the post's own links are
//   code text, checked when it was rendered). The approval validates the
//   notice before it writes anything, so a post whose notice would not fit
//   is refused there, and sends it before its batch, under the approval's
//   new id (src/review/approve.ts): an approval whose notice reaches no
//   keyholder is never written.
// - The keyholder's locale is unknown, so the header is in both locales,
//   Persian first, like the post; so are the buttons.
// - The notices' message ids are kept in this isolate's memory only, never
//   stored (no table holds a keyholder's chat beyond the configuration):
//   Cancel edits every notice it remembers, and always the one pressed, to
//   "cancelled", without links, so no target URL stays in a keyholder's
//   chat (but a press on the notice of an approval not recorded, which
//   edits nothing until the notice is five minutes old:
//   src/review/cancel.ts); the scheduling unit edits them
//   to "posted". A notice another isolate sent is not remembered, and
//   keeps its text until its own Cancel is pressed: the stated cost of
//   storing nothing.
import type { InlineKeyboardMarkup } from 'grammy/types';
import { utcMinute } from '../clock';
import type { Config } from '../config/schema';
import { t, type Locale } from '../i18n/index';
import { PLATFORM_NAME_KEYS } from '../platforms/instructions';
import type { Platform } from '../platforms/platforms';
import type { Logger } from '../privacy/logger';
import { alertKeyholders, type AlertOutcome, type Delivery } from '../telegram/alerts';
import type { BotApiPort } from '../telegram/bot-api-port';
import { classifyTelegramError } from '../telegram/errors';
import type { Category } from './categories';
import { noticeData } from './callbacks';
import { CATEGORY_NAME_KEYS } from './names';
import { POST_DIVIDER } from './render-post';
import { checkedText } from './venue';

/** The most approvals whose notices one isolate remembers; the oldest is forgotten first. */
export const NOTICE_MEMORY_LIMIT = 200;

/** This isolate's memory of the notices it sent, by approval id. */
export interface NoticeMemory {
  remember(approvalId: string, deliveries: readonly Delivery[]): void;
  /** The notices of `approvalId` this isolate sent, if it remembers them. */
  recall(approvalId: string): readonly Delivery[];
  forget(approvalId: string): void;
  readonly size: number;
}

/** A memory of at most `limit` approvals' notices. */
export function createNoticeMemory(limit = NOTICE_MEMORY_LIMIT): NoticeMemory {
  const entries = new Map<string, readonly Delivery[]>();
  return {
    remember: (approvalId, deliveries) => {
      entries.delete(approvalId);
      entries.set(approvalId, Object.freeze([...deliveries]));
      while (entries.size > limit) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    recall: (approvalId) => entries.get(approvalId) ?? [],
    forget: (approvalId) => {
      entries.delete(approvalId);
    },
    get size() {
      return entries.size;
    },
  };
}

/** The isolate's own memory, which the bot uses unless it is given another (tests do). */
export const isolateNotices: NoticeMemory = createNoticeMemory();

/** What a notice says besides the post. */
export interface NoticeFacts {
  readonly reportId: string;
  readonly platform: Platform;
  readonly category: Category;
  readonly startsAt: number;
}

const bothLocales = (render: (locale: Locale) => string): string => `${render('fa')}\n${render('en')}`;

/** The notice's text: the header in both locales, the divider, then the post (see the header). */
export function noticeText(facts: NoticeFacts, post: string): string {
  const header = bothLocales((locale) =>
    t(locale, 'notice.body', {
      id: facts.reportId,
      platform: t(locale, PLATFORM_NAME_KEYS[facts.platform]),
      category: t(locale, CATEGORY_NAME_KEYS[facts.category]),
      time: utcMinute(facts.startsAt),
    }),
  );
  return `${header}\n\n${POST_DIVIDER}\n\n${post}`;
}

/** The notice of a cancelled approval: its report's id, in both locales, without links. */
export const cancelledNoticeText = (reportId: string): string =>
  bothLocales((locale) => t(locale, 'notice.cancelled', { id: reportId }));

/** The notice's two buttons, labelled in both locales. */
export function noticeKeyboard(reportId: string, approvalId: string): InlineKeyboardMarkup {
  const label = (key: 'notice.button.cancel' | 'notice.button.lockdown'): string => `${t('fa', key)} · ${t('en', key)}`;
  return {
    inline_keyboard: [
      [
        { text: label('notice.button.cancel'), callback_data: noticeData({ kind: 'cancel', reportId, approvalId }) },
        { text: label('notice.button.lockdown'), callback_data: noticeData({ kind: 'lockdown' }) },
      ],
    ],
  };
}

export interface NotifyDeps {
  readonly api: Pick<BotApiPort, 'sendMessage'>;
  readonly config: Pick<Config, 'keyholderIds' | 'adminChatId' | 'lockdown' | 'allowedLinkHosts'>;
  readonly logger: Logger;
  readonly notices: NoticeMemory;
}

/**
 * Sends the approval notice of `facts` with `post` to every keyholder, and
 * remembers the deliveries under `approvalId` (see the header). Never throws
 * for a failed send, only for a text that may not be sent.
 */
export async function notifyKeyholders(deps: NotifyDeps, facts: NoticeFacts, approvalId: string, post: string): Promise<AlertOutcome> {
  const text = checkedText(deps.config, noticeText(facts, post));
  const outcome = await alertKeyholders(deps, text, { reply_markup: noticeKeyboard(facts.reportId, approvalId) });
  deps.notices.remember(approvalId, outcome.deliveries);
  return outcome;
}

export interface NoticeEditDeps {
  readonly api: Pick<BotApiPort, 'editMessageText'>;
  readonly config: Pick<Config, 'allowedLinkHosts'>;
  readonly logger: Logger;
  readonly notices: NoticeMemory;
}

/**
 * Edits every notice of `approvalId` this isolate remembers, and `pressed`
 * when given, to `text`, without buttons, then forgets them. A notice
 * already gone or already showing `text` is no failure; any other failure is
 * logged by class. Never throws.
 */
export async function editNotices(deps: NoticeEditDeps, approvalId: string, text: string, pressed?: Delivery): Promise<void> {
  const checked = checkedText(deps.config, text);
  const targets = [...deps.notices.recall(approvalId)];
  if (pressed !== undefined && !targets.some((delivery) => delivery.chatId === pressed.chatId && delivery.messageId === pressed.messageId)) {
    targets.push(pressed);
  }
  deps.notices.forget(approvalId);
  for (const { chatId, messageId } of targets) {
    try {
      await deps.api.editMessageText(chatId, messageId, checked, {});
    } catch (error) {
      const { kind } = classifyTelegramError(error);
      if (kind !== 'message_not_modified' && kind !== 'message_not_found') deps.logger.logError('review.notice_not_edited', error);
    }
  }
}

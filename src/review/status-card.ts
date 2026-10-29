// @critical-path
// The status card (critical invariants 1, 3 and 5; the MVP plan, section 4,
// "Review"): the message the approval posts in the admin review venue for
// the report's life after its decision, while the review card, which shows
// the URLs and goes within 48 hours, is gone. It shows the report's id (the
// one the admin commands take), its platform and category, its state and,
// in the grace, its start time and how many keyholders got the approval
// notice; never a URL, a comment or a reporter's reference. Its buttons:
// Cancel while the report is approved under its live approval, and Block
// reporter while the report still holds the reference; the later units add
// their own (taken down, no result, retract) to the posted report's card.
// The scheduler (src/broadcast/) edits it to "posted", or to its state with
// a note saying what needs a human: a post Telegram refused, a post that
// may or may not be in the channel, a stored post the send-time check
// refused, a report /repost returned to approved.
import type { InlineKeyboardButton } from 'grammy/types';
import { utcMinute } from '../clock';
import { t, type Locale } from '../i18n/index';
import { PLATFORM_NAME_KEYS } from '../platforms/instructions';
import { reviewData, type ReviewAction } from './callbacks';
import { CATEGORY_NAME_KEYS, STATUS_NAME_KEYS } from './names';
import type { ApprovalRecord, ReviewReport } from './reports';
import type { CardView } from './venue';

/** How many keyholders the approval notice reached. */
export interface NoticeCount {
  readonly sent: number;
  readonly total: number;
}

/** What the scheduler says needs a human, or that /repost is under way (see the header). */
export type StatusNote = 'refused' | 'unknown' | 'held' | 'reposted';

const NOTE_KEYS = Object.freeze({
  refused: 'review.status_card.note.refused',
  unknown: 'review.status_card.note.unknown',
  held: 'review.status_card.note.held',
  reposted: 'review.status_card.note.reposted',
} as const satisfies Record<StatusNote, string>);

const button = (text: string, action: ReviewAction): InlineKeyboardButton.CallbackButton => ({
  text,
  callback_data: reviewData(action),
});

/**
 * The status card of `report` (see the header); `approval` is its live
 * approval, if it has one; `note`, what the scheduler says of it, in place
 * of the grace line.
 */
export function statusCard(
  report: Pick<ReviewReport, 'id' | 'status' | 'platform' | 'category' | 'reporterRef'>,
  approval: Pick<ApprovalRecord, 'approvalId' | 'startsAt' | 'voidedAt'> | null,
  locale: Locale,
  notified?: NoticeCount,
  note?: StatusNote,
): CardView {
  const inGrace = report.status === 'approved' && approval !== null && approval.voidedAt === null;
  const lines = [
    t(locale, 'review.status_card.title', { id: report.id }),
    `${t(locale, PLATFORM_NAME_KEYS[report.platform])} · ${t(locale, CATEGORY_NAME_KEYS[report.category])}`,
    inGrace && note === undefined
      ? t(locale, 'review.status_card.in_grace', { time: utcMinute(approval.startsAt) })
      : t(locale, 'review.status_card.state', { state: t(locale, STATUS_NAME_KEYS[report.status]) }),
  ];
  if (note !== undefined) lines.push(t(locale, NOTE_KEYS[note], { id: report.id }));
  if (inGrace && note === undefined && notified !== undefined) {
    lines.push(t(locale, 'review.status_card.notified', { sent: notified.sent, total: notified.total }));
  }
  const rows: InlineKeyboardButton.CallbackButton[][] = [];
  if (inGrace) {
    rows.push([button(t(locale, 'review.button.cancel'), { kind: 'cancel', reportId: report.id, approvalId: approval.approvalId })]);
  }
  if (report.reporterRef !== null) rows.push([button(t(locale, 'review.button.block'), { kind: 'block', reportId: report.id })]);
  return rows.length === 0 ? { text: lines.join('\n') } : { text: lines.join('\n'), keyboard: { inline_keyboard: rows } };
}

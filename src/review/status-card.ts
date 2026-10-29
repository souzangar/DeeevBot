// @critical-path
// The status card (critical invariants 1, 3 and 5; the MVP plan, section 4,
// "Review"): the message the approval posts in the admin review venue for
// the report's life after its decision, while the review card, which shows
// the URLs and goes within 48 hours, is gone. It shows the report's id (the
// one the admin commands take), its platform and category, its state and,
// in the grace, its start time and how many keyholders got the approval
// notice; never a URL, a comment or a reporter's reference. Its buttons:
// Cancel while the report is approved under its live approval; while it is
// posted, the closure unit's (U6): Taken down and Closed without result,
// which close it, and Retract, which asks for the correction
// (src/broadcast/closure.ts, retraction.ts); and Block reporter while the
// report still holds the reference.
// The scheduler (src/broadcast/) edits it to "posted", or to its state with
// a note saying what needs a human: a post Telegram refused, a post that
// may or may not be in the channel, a stored post the send-time check
// refused, a report /repost returned to approved; a closure or a
// retraction under way, an edit Telegram refused. Once the report is
// concluded (closed, retracted or expired, and finalized), the card shows
// the outcome and no button (concludedStatusCard).
import type { InlineKeyboardButton } from 'grammy/types';
import { utcMinute } from '../clock';
import { t, type Locale } from '../i18n/index';
import { PLATFORM_NAME_KEYS } from '../platforms/instructions';
import { reviewData, type ReviewAction } from './callbacks';
import { CATEGORY_NAME_KEYS, outcomeNameKey, STATUS_NAME_KEYS } from './names';
import type { ApprovalRecord, ReviewReport } from './reports';
import type { CardView } from './venue';

/** How many keyholders the approval notice reached. */
export interface NoticeCount {
  readonly sent: number;
  readonly total: number;
}

/** What the scheduler says needs a human, or what is under way (see the header). */
export type StatusNote = 'refused' | 'unknown' | 'held' | 'reposted' | 'closing' | 'retracting' | 'edit_failed';

const NOTE_KEYS = Object.freeze({
  refused: 'review.status_card.note.refused',
  unknown: 'review.status_card.note.unknown',
  held: 'review.status_card.note.held',
  reposted: 'review.status_card.note.reposted',
  closing: 'review.status_card.note.closing',
  retracting: 'review.status_card.note.retracting',
  edit_failed: 'review.status_card.note.edit_failed',
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
  if (report.status === 'posted') {
    rows.push([
      button(t(locale, 'review.button.taken_down'), { kind: 'close', reportId: report.id, outcome: 'taken_down' }),
      button(t(locale, 'review.button.no_result'), { kind: 'close', reportId: report.id, outcome: 'no_result' }),
    ]);
    rows.push([button(t(locale, 'review.button.retract'), { kind: 'retract', reportId: report.id })]);
  }
  if (report.reporterRef !== null) rows.push([button(t(locale, 'review.button.block'), { kind: 'block', reportId: report.id })]);
  return rows.length === 0 ? { text: lines.join('\n') } : { text: lines.join('\n'), keyboard: { inline_keyboard: rows } };
}

/**
 * The status card of a concluded report (closed, retracted or expired, and
 * finalized): its id, platform and category, and its outcome by its code
 * (src/review/names.ts); no button, since nothing is left to act on.
 */
export function concludedStatusCard(report: Pick<ReviewReport, 'id' | 'platform' | 'category'>, outcome: string, locale: Locale): CardView {
  return {
    text: [
      t(locale, 'review.status_card.title', { id: report.id }),
      `${t(locale, PLATFORM_NAME_KEYS[report.platform])} · ${t(locale, CATEGORY_NAME_KEYS[report.category])}`,
      t(locale, 'review.status_card.concluded', { outcome: t(locale, outcomeNameKey(outcome)) }),
    ].join('\n'),
  };
}

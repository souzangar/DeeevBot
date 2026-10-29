// @critical-path
// Cancel (critical invariants 1 and 2; the MVP plan, section 4, "Cancel";
// doc/product/report-lifecycle.md, approved to pending): during the grace,
// an admin's Cancel on the review card or the status card, or a keyholder's
// on their approval notice, returns the report to review. The button names
// the approval it cancels by its random `approval_id`, so a stale button
// can never cancel a later re-approval. ONE batch (cancelStatements):
// - the post job deleted, while the report is approved under that approval;
// - `voided_at` set on that approval, while the report is approved;
// - the conditional `approved` to `pending` (exactly one row changes for
//   the Cancel that wins), the rendered post, the link mode and the status
//   card's id cleared.
// A report already claimed by the tick (`posting`) or posted is past
// Cancel: the answer says so, and /retract is for a posted report. Under
// lockdown the gates refuse an admin's Cancel and let a keyholder's
// through (src/telegram/registry.ts); a keyholder's Cancel under lockdown
// then edits only the keyholders' own chats, never the venue, which is
// compromised by assumption. After the commit, each step logged by class if
// it fails: every remembered notice of the approval, and the one pressed,
// edited to "cancelled" without links; the card back to its review state;
// the status card deleted (edited to the outcome if it cannot be).
//
// The notices go out before their approval is written (src/review/approve.ts),
// so a keyholder's Cancel can find a pending report whose approval row does
// not carry the notice's approval id: the approval is not recorded, still
// on its way, or it never landed. Such a press writes nothing, leaves the
// notice and its buttons as they are, and says the approval is not
// recorded yet, so a Cancel pressed while its approval is on its way is
// never answered "cancelled" before the approval stands. A notice older
// than NOTICE_SETTLE_MS, though, belongs to an approval that will never be
// recorded (no approval's batch takes that long on Workers, whose
// waitUntil ends well before; a send Telegram answered ambiguously, say,
// whose notice did arrive): its Cancel edits it to "cancelled" and answers
// so. Otherwise only a notice of an approval recorded and voided since, or
// of a report decided otherwise, is edited to "cancelled".
import { isLockedDown } from '../auth/lockdown';
import { sql, type SqlStatement } from '../db/sql';
import { t } from '../i18n/index';
import type { Delivery } from '../telegram/alerts';
import { cardFacts, currentCard, reviewCard } from './card';
import { loadPress, showAfterCommit } from './flow';
import { cancelledNoticeText, editNotices } from './notify';
import { liveApproval, readApproval, readReport, type ReviewReport } from './reports';
import { deleteOrEdit, type Actor, type Pressed, type PressOutcome, type ReviewDeps } from './venue';

const DROP_POST_JOB = sql`DELETE FROM jobs WHERE kind = 'post' AND report_id = ? AND EXISTS (SELECT 1 FROM reports WHERE id = ? AND status = 'approved') AND EXISTS (SELECT 1 FROM approvals WHERE report_id = ? AND approval_id = ? AND voided_at IS NULL)`;
const VOID_APPROVAL = sql`UPDATE approvals SET voided_at = ? WHERE report_id = ? AND approval_id = ? AND voided_at IS NULL AND EXISTS (SELECT 1 FROM reports WHERE id = ? AND status = 'approved')`;
const UNAPPROVE = sql`UPDATE reports SET status = 'pending', broadcast_text = NULL, link_mode = NULL, status_message_id = NULL WHERE id = ? AND status = 'approved' AND EXISTS (SELECT 1 FROM approvals WHERE report_id = ? AND approval_id = ? AND voided_at IS NOT NULL)`;

/**
 * How old the notice of an approval not recorded must be for its Cancel to
 * settle it as cancelled (see the header): five minutes.
 */
export const NOTICE_SETTLE_MS = 5 * 60_000;

/** The index, in cancelStatements(), of the status change: one row changed means the Cancel won. */
export const CANCEL_STATUS_STATEMENT = 2;

/** The Cancel's one batch (see the header). */
export function cancelStatements(reportId: string, approvalId: string, now: number): SqlStatement[] {
  return [
    { sql: DROP_POST_JOB, params: [reportId, reportId, reportId, approvalId] },
    { sql: VOID_APPROVAL, params: [now, reportId, approvalId, reportId] },
    { sql: UNAPPROVE, params: [reportId, reportId, approvalId] },
  ];
}

/** Runs the Cancel's batch; true when it won. */
export async function writeCancel(deps: Pick<ReviewDeps, 'db'>, reportId: string, approvalId: string, now: number): Promise<boolean> {
  const results = await deps.db.batch(cancelStatements(reportId, approvalId, now));
  return results[CANCEL_STATUS_STATEMENT]?.changes === 1;
}

/** What a Cancel that lost is answered, by the report's state. */
function losingAnswer(actor: Actor, report: ReviewReport | null): string {
  if (report === null) return t(actor.locale, 'review.answer.gone');
  switch (report.status) {
    case 'pending':
      return t(actor.locale, 'review.answer.already_cancelled');
    case 'posting':
    case 'posted':
      return t(actor.locale, 'review.answer.too_late');
    default:
      return t(actor.locale, 'review.answer.not_cancellable');
  }
}

/**
 * After a Cancel won: the notices, then, unless locked down, the card and
 * the status card, in the venue's language whoever cancelled.
 */
async function afterCancel(deps: ReviewDeps, before: ReviewReport, approvalId: string, pressedNotice?: Delivery): Promise<void> {
  const venue = deps.config.venueLocale;
  await editNotices(deps, approvalId, cancelledNoticeText(before.id), pressedNotice);
  if (await isLockedDown(deps.config, deps.db)) return;
  const current = await readReport(deps.db, before.id);
  if (current !== null && current.status === 'pending') {
    await showAfterCommit(deps, current, reviewCard(await cardFacts(deps.db, current), venue));
  }
  if (before.statusMessageId !== null) {
    await deleteOrEdit(deps, before.statusMessageId, { text: t(venue, 'review.status_card.cancelled', { id: before.id }) });
  }
}

/** An admin's Cancel, on the report's card or status card. */
export async function cancelByAdmin(
  deps: ReviewDeps,
  actor: Actor,
  reportId: string,
  approvalId: string,
  pressed: Pressed,
): Promise<PressOutcome> {
  const loaded = await loadPress(deps, actor, reportId, pressed, { pendingOnly: false, statusCard: true });
  if (!loaded.ok) return loaded.outcome;
  const { report } = loaded;
  if (!(await writeCancel(deps, reportId, approvalId, deps.clock.now()))) {
    // The card shows the report as it is now: back in review (a keyholder's
    // Cancel under lockdown left the venue as it was), or its outcome.
    const current = await readReport(deps.db, reportId);
    if (current !== null && pressed.messageId === current.cardMessageId) {
      await showAfterCommit(deps, current, currentCard(await cardFacts(deps.db, current), await readApproval(deps.db, current.id), deps.config.venueLocale));
    }
    return { answer: losingAnswer(actor, current) };
  }
  try {
    await afterCancel(deps, report, approvalId);
  } catch (error) {
    deps.logger.logError('review.message_not_edited', error, { reportId });
  }
  return { answer: t(actor.locale, 'review.answer.cancelled') };
}

/**
 * A keyholder's Cancel, on their approval notice `pressed` (in their own
 * chat; the gate checked it). Works under lockdown.
 */
export async function cancelByKeyholder(
  deps: ReviewDeps,
  actor: Actor,
  reportId: string,
  approvalId: string,
  pressed: Pressed,
): Promise<PressOutcome> {
  const report = await readReport(deps.db, reportId);
  const notice: Delivery = { chatId: pressed.chatId, messageId: pressed.messageId };
  if (report === null) return { answer: losingAnswer(actor, null) };
  if (!(await writeCancel(deps, reportId, approvalId, deps.clock.now()))) {
    const current = await readReport(deps.db, reportId);
    if (current?.status === 'pending' && (await readApproval(deps.db, reportId))?.approvalId !== approvalId) {
      // Not recorded (see the header): nothing is written, and the notice is edited only once it is too old to be recorded.
      if (pressed.sentAt === undefined || deps.clock.now() - pressed.sentAt <= NOTICE_SETTLE_MS) {
        return { answer: t(actor.locale, 'review.answer.not_recorded') };
      }
      await editNotices(deps, approvalId, cancelledNoticeText(reportId), notice);
      return { answer: t(actor.locale, 'review.answer.already_cancelled') };
    }
    // This notice's approval ended without a post (cancelled before, or
    // replaced by a re-approval): the notice says so, without links. A
    // posted report's notice is the scheduling unit's to edit.
    const ended =
      current !== null &&
      (current.status === 'pending' ||
        current.status === 'rejected' ||
        current.status === 'routed' ||
        (current.status === 'approved' && (await liveApproval(deps.db, reportId))?.approvalId !== approvalId));
    if (ended) await editNotices(deps, approvalId, cancelledNoticeText(reportId), notice);
    return { answer: losingAnswer(actor, current) };
  }
  try {
    await afterCancel(deps, report, approvalId, notice);
  } catch (error) {
    deps.logger.logError('review.message_not_edited', error, { reportId });
  }
  return { answer: t(actor.locale, 'review.answer.cancelled') };
}

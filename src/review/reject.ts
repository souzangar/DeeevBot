// @critical-path
// Reject (critical invariants 1, 3 and 8; the MVP plan, section 4,
// "Reject"; doc/product/report-lifecycle.md, pending to rejected): Reject on
// the review card shows the reasons, internal codes shown to nobody but the
// admins (src/review/callbacks.ts, REJECT_REASONS); a reason rejects. ONE
// batch (rejectStatements), every statement while the report is pending, the
// status change last, so whichever decision commits first is the only one
// (exactly one row changes):
// - `rejections_30d` raised on the reporter references of the report and
//   of every report merged into it (each reference once): the admins
//   decide once per target, so every report of it is rejected;
// - `comment` and `affected_person` nulled on the merged reports;
// - the report's prompts deleted;
// - `pending` to `rejected`, with `rejection_reason`, `decided_at`,
//   `decided_by` (the admin's id), `comment` and `affected_person` nulled,
//   the card's id cleared.
// Then the card is deleted, or edited to the outcome without links when it
// cannot be (older than Telegram's 48 hours), and the prompts' messages go.
// No message goes to the reporter. The row is finalized 30 days later.
import { sql, type SqlStatement } from '../db/sql';
import { t } from '../i18n/index';
import { outcomeCard } from './card';
import type { RejectReason } from './callbacks';
import { deletePromptMessages, loadPress, showDecided, showStep } from './flow';
import { promptsOf } from './prompts';
import { readReport } from './reports';
import { deleteOrEdit, type Actor, type Pressed, type PressOutcome, type ReviewDeps } from './venue';

const COUNT_REJECTIONS = sql`UPDATE reporter_stats SET rejections_30d = rejections_30d + 1 WHERE reporter_ref IN (SELECT reporter_ref FROM reports WHERE (id = ? OR merged_into = ?) AND reporter_ref IS NOT NULL) AND EXISTS (SELECT 1 FROM reports WHERE id = ? AND status = 'pending')`;
const CLEAR_MERGED = sql`UPDATE reports SET comment = NULL, affected_person = NULL WHERE merged_into = ? AND EXISTS (SELECT 1 FROM reports WHERE id = ? AND status = 'pending')`;
const DROP_PROMPTS = sql`DELETE FROM admin_prompts WHERE report_id = ? AND EXISTS (SELECT 1 FROM reports WHERE id = ? AND status = 'pending')`;
const REJECT = sql`UPDATE reports SET status = 'rejected', rejection_reason = ?, decided_at = ?, decided_by = ?, comment = NULL, affected_person = NULL, broadcast_text = NULL, link_mode = NULL, card_message_id = NULL WHERE id = ? AND status = 'pending'`;

/** The index, in rejectStatements(), of the status change: one row changed means the rejection won. */
export const REJECT_STATUS_STATEMENT = 3;

/** The rejection's one batch (see the header). */
export function rejectStatements(reportId: string, reason: RejectReason, adminId: number, now: number): SqlStatement[] {
  return [
    { sql: COUNT_REJECTIONS, params: [reportId, reportId, reportId] },
    { sql: CLEAR_MERGED, params: [reportId, reportId] },
    { sql: DROP_PROMPTS, params: [reportId, reportId] },
    { sql: REJECT, params: [reason, now, adminId, reportId] },
  ];
}

/** Reject: the reasons. */
export async function showReasons(deps: ReviewDeps, actor: Actor, reportId: string, pressed: Pressed): Promise<PressOutcome> {
  const loaded = await loadPress(deps, actor, reportId, pressed, { pendingOnly: true });
  if (!loaded.ok) return loaded.outcome;
  await showStep(deps, loaded.report, { kind: 'reasons' });
  return {};
}

/** A reason: the rejection (see the header). */
export async function reject(deps: ReviewDeps, actor: Actor, reportId: string, reason: RejectReason, pressed: Pressed): Promise<PressOutcome> {
  const loaded = await loadPress(deps, actor, reportId, pressed, { pendingOnly: true });
  if (!loaded.ok) return loaded.outcome;
  const { report } = loaded;
  const prompts = await promptsOf(deps.db, reportId);
  const results = await deps.db.batch(rejectStatements(reportId, reason, actor.id, deps.clock.now()));
  if (results[REJECT_STATUS_STATEMENT]?.changes !== 1) {
    const current = await readReport(deps.db, reportId);
    return current === null ? { answer: t(actor.locale, 'review.answer.gone') } : showDecided(deps, actor, current, pressed.messageId);
  }
  if (report.cardMessageId !== null) {
    await deleteOrEdit(deps, report.cardMessageId, outcomeCard({ id: reportId, status: 'rejected' }, deps.config.venueLocale));
  }
  await deletePromptMessages(deps, prompts);
  return { answer: t(actor.locale, 'review.answer.rejected') };
}

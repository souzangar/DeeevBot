// @critical-path
// Route as suspected CSAM (critical invariants 1, 3, 7 and 8; the MVP plan,
// section 4, "Route"; doc/product/report-categories-and-routing.md,
// "Suspected CSAM"; doc/reference/csam-hotlines.md). Route on the review
// card, or the suspected-CSAM category at the approval's category step,
// replaces the review card with the routing card, in the venue and nowhere
// else (src/review/card.ts): the links as code, the platform's own path,
// the hotlines, the wording "unverified member report, content not
// opened", Confirm. No approval can exist for it: Approve leads here.
// Confirm runs ONE batch (routeStatements), every statement while the
// report is pending, the status change last (first decision wins):
// - `url`, `account_url`, `comment` and `affected_person` nulled on every
//   report merged into it;
// - the report's prompts deleted;
// - `pending` to `routed`, its category the admin's, suspected CSAM, with
//   `decided_at` and `decided_by`; its `url`, `account_url`, `comment`,
//   `affected_person`, any rendered post of a cancelled approval and the
//   card's id nulled. Only the aggregate fields and the keyed link hash
//   remain, until finalization 30 days later.
// Then the routing card is deleted (edited to the outcome without links
// when it cannot be), and the prompts' messages go. No message goes to the
// reporter: the hotline links went at intake, to a reporter whose label
// asked for them.
import { sql, type SqlStatement } from '../db/sql';
import { t } from '../i18n/index';
import { outcomeCard, routingCard } from './card';
import { deletePromptMessages, loadPress, showDecided } from './flow';
import { promptsOf } from './prompts';
import { readReport } from './reports';
import { deleteOrEdit, editMessage, type Actor, type Pressed, type PressOutcome, type ReviewDeps } from './venue';

const CLEAR_MERGED = sql`UPDATE reports SET url = NULL, account_url = NULL, comment = NULL, affected_person = NULL WHERE merged_into = ? AND EXISTS (SELECT 1 FROM reports WHERE id = ? AND status = 'pending')`;
const DROP_PROMPTS = sql`DELETE FROM admin_prompts WHERE report_id = ? AND EXISTS (SELECT 1 FROM reports WHERE id = ? AND status = 'pending')`;
const ROUTE = sql`UPDATE reports SET status = 'routed', category = 'csam', decided_at = ?, decided_by = ?, url = NULL, account_url = NULL, comment = NULL, affected_person = NULL, broadcast_text = NULL, link_mode = NULL, card_message_id = NULL WHERE id = ? AND status = 'pending'`;

/** The index, in routeStatements(), of the status change: one row changed means the routing won. */
export const ROUTE_STATUS_STATEMENT = 2;

/** The routing's one batch (see the header). */
export function routeStatements(reportId: string, adminId: number, now: number): SqlStatement[] {
  return [
    { sql: CLEAR_MERGED, params: [reportId, reportId] },
    { sql: DROP_PROMPTS, params: [reportId, reportId] },
    { sql: ROUTE, params: [now, adminId, reportId] },
  ];
}

/** Route: the routing card in place of the review card. */
export async function showRouting(deps: ReviewDeps, actor: Actor, reportId: string, pressed: Pressed): Promise<PressOutcome> {
  const loaded = await loadPress(deps, actor, reportId, pressed, { pendingOnly: true });
  if (!loaded.ok) return loaded.outcome;
  if (loaded.report.cardMessageId !== null) {
    await editMessage(deps, loaded.report.cardMessageId, routingCard(loaded.report, deps.config.venueLocale));
  }
  return {};
}

/** Confirm: the routing (see the header). */
export async function confirmRoute(deps: ReviewDeps, actor: Actor, reportId: string, pressed: Pressed): Promise<PressOutcome> {
  const loaded = await loadPress(deps, actor, reportId, pressed, { pendingOnly: true });
  if (!loaded.ok) return loaded.outcome;
  const { report } = loaded;
  const prompts = await promptsOf(deps.db, reportId);
  const results = await deps.db.batch(routeStatements(reportId, actor.id, deps.clock.now()));
  if (results[ROUTE_STATUS_STATEMENT]?.changes !== 1) {
    const current = await readReport(deps.db, reportId);
    return current === null ? { answer: t(actor.locale, 'review.answer.gone') } : showDecided(deps, actor, current, pressed.messageId);
  }
  if (report.cardMessageId !== null) {
    await deleteOrEdit(deps, report.cardMessageId, outcomeCard({ id: reportId, status: 'routed' }, deps.config.venueLocale));
  }
  await deletePromptMessages(deps, prompts);
  return { answer: t(actor.locale, 'review.answer.routed') };
}

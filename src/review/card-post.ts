// @critical-path
// Posting the review card (critical invariants 3, 4 and 5; the MVP plan,
// section 4, "Review"), in the venue's one language, VENUE_LOCALE: a
// submitted report that is pending (a new target;
// a duplicate merged into an open one gets none, its target being decided
// once) gets its card in the admin review venue, ADMIN_CHAT_ID, and nowhere
// else, from inside the reporter's own update, right after the
// acknowledgement (src/telegram/intake.ts); its message id is stored in
// `reports.card_message_id`, which every press is bound to. The card's text
// is checked before it leaves (src/review/venue.ts).
//
// postReviewCard() never throws: the report is in already, and a failed
// card is logged by class, the report left pending without a card; /open
// marks it "no card", and /card <id> (repostCard()) posts it, a new card in
// place of the old one, which is then deleted (or, past 48 hours, edited to
// say it is out of date). A press on a card that is no longer the report's
// is refused (src/review/flow.ts).
//
// No card the report does not know of stays in the venue with live
// buttons: when the report left review between the read and the store of
// the card's id (decided on its old card meanwhile, say), the card just
// sent is deleted, or edited to the report's outcome without links or
// buttons when it cannot be (deleted only, when the report is gone); when
// the store fails, the card is deleted and the failure goes on.
import { t } from '../i18n/index';
import { cardFacts, outcomeCard, reviewCard } from './card';
import { readReport, setCardMessage, type ReviewReport } from './reports';
import { deleteInVenue, deleteOrEdit, sendToVenue, type ReviewDeps } from './venue';

export type CardPostDeps = Pick<ReviewDeps, 'api' | 'config' | 'db' | 'logger'>;

/**
 * Sends `report`'s card to the venue and stores its id (see the header):
 * the message id, or null when the report left review before the id was
 * stored and the card was withdrawn. Throws on a failed send or store.
 */
async function postCard(deps: CardPostDeps, report: ReviewReport): Promise<number | null> {
  const venue = deps.config.venueLocale;
  const sent = await sendToVenue(deps, reviewCard(await cardFacts(deps.db, report), venue));
  let stored: boolean;
  try {
    stored = await setCardMessage(deps.db, report.id, sent.message_id);
  } catch (error) {
    await deleteInVenue(deps, sent.message_id);
    throw error;
  }
  if (stored) return sent.message_id;
  const current = await readReport(deps.db, report.id);
  if (current === null) await deleteInVenue(deps, sent.message_id);
  else await deleteOrEdit(deps, sent.message_id, outcomeCard(current, venue));
  return null;
}

/**
 * The card of the report just submitted as `reportId`, if it is pending
 * (see the header). The card's message id, or null when there is no card.
 * Never throws.
 */
export async function postReviewCard(deps: CardPostDeps, reportId: string): Promise<number | null> {
  try {
    const report = await readReport(deps.db, reportId);
    if (report === null || report.status !== 'pending') return null;
    return await postCard(deps, report);
  } catch (error) {
    deps.logger.logError('review.card_not_sent', error, { reportId });
    return null;
  }
}

/** What /card <id> did. */
export type RepostOutcome = 'posted' | 'not_pending' | 'not_found';

/** /card <id>: a new card for a pending report, the old one deleted (see the header). */
export async function repostCard(deps: CardPostDeps, reportId: string): Promise<RepostOutcome> {
  const report = await readReport(deps.db, reportId);
  if (report === null || report.status === 'merged') return 'not_found';
  if (report.status !== 'pending') return 'not_pending';
  // A report decided while its new card went out keeps its old card, which shows the outcome.
  if ((await postCard(deps, report)) === null) return 'not_pending';
  if (report.cardMessageId !== null) {
    await deleteOrEdit(deps, report.cardMessageId, { text: t(deps.config.venueLocale, 'review.card.replaced', { id: report.id }) });
  }
  return 'posted';
}

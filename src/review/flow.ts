// @critical-path
// What every review press and reply shares (critical invariants 1, 2 and 8;
// doc/product/report-lifecycle.md, "First decision wins"). The gates of
// src/telegram/registry.ts have already checked, on the update itself, that
// the presser or replier is on ADMIN_IDS (or KEYHOLDER_IDS for a notice),
// in the venue, and that the bot is not locked down; this module checks the
// report:
// - a press counts only on its report's own card (`card_message_id`), or,
//   for Cancel and Block reporter, its status card (`status_message_id`): a
//   press on an older card, after /card posted a new one, is answered "out
//   of date" and changes nothing;
// - a press whose report is no longer in the state the press needs (another
//   admin decided first, or a keyholder cancelled) gets its card edited to
//   the report's current state and an answer naming it. Every status
//   change itself is a conditional update in its own batch (first decision
//   wins: exactly one row changes, whoever presses at the same moment);
// - a prompt (src/review/prompts.ts) is sent as a force reply under the
//   card, and an admin holds at most one approval prompt per report: a new
//   one replaces the old, row and message.
// Every message written in the venue (a card, a prompt) is in the venue's
// one language, VENUE_LOCALE; an answer to a press is in the actor's
// (src/telegram/review.ts gives a venue actor the venue's).
import type { ForceReply } from 'grammy/types';
import { t, type Locale } from '../i18n/index';
import { cardFacts, currentCard, reviewCard, type CardStep } from './card';
import type { Category, LinkMode } from './categories';
import { STATUS_NAME_KEYS } from './names';
import { createPrompt, deleteAdminPrompts, promptsOf, type AdminPrompt, type PromptKind } from './prompts';
import { readApproval, readReport, type ReviewReport } from './reports';
import {
  deleteInVenue,
  editAfterCommit,
  editMessage,
  sendToVenue,
  type Actor,
  type CardView,
  type Pressed,
  type PressOutcome,
  type ReviewDeps,
} from './venue';

/** A press's report, or the answer the press already got. */
export type LoadedPress = { readonly ok: true; readonly report: ReviewReport } | { readonly ok: false; readonly outcome: PressOutcome };

export interface LoadOptions {
  /** The press needs a pending report (every review step does; Cancel and Block do not). */
  readonly pendingOnly: boolean;
  /** The press may sit on the status card as well as the review card (Cancel, Block reporter). */
  readonly statusCard?: boolean;
}

/** Report `reportId` for a press on `pressed`, checked as the header says. */
export async function loadPress(
  deps: ReviewDeps,
  actor: Actor,
  reportId: string,
  pressed: Pressed,
  options: LoadOptions,
): Promise<LoadedPress> {
  const report = await readReport(deps.db, reportId);
  if (report === null || report.status === 'merged') return { ok: false, outcome: { answer: t(actor.locale, 'review.answer.gone') } };
  if (pressed.chatId !== deps.config.adminChatId) return { ok: false, outcome: { answer: t(actor.locale, 'review.answer.stale_card') } };
  // A decision already taken is the news, on whichever card the press sat (the winner's batch may have cleared the card's id).
  if (options.pendingOnly && report.status !== 'pending') return { ok: false, outcome: await showDecided(deps, actor, report, pressed.messageId) };
  const onCard = report.cardMessageId !== null && pressed.messageId === report.cardMessageId;
  const onStatus = options.statusCard === true && report.statusMessageId !== null && pressed.messageId === report.statusMessageId;
  if (!onCard && !onStatus) return { ok: false, outcome: { answer: t(actor.locale, 'review.answer.stale_card') } };
  return { ok: true, report };
}

/** Edits message `messageId` (a card of `report`) to `report`'s current state, and says what that is. */
export async function showDecided(deps: ReviewDeps, actor: Actor, report: ReviewReport, messageId: number): Promise<PressOutcome> {
  if (messageId === report.cardMessageId) {
    const view = currentCard(await cardFacts(deps.db, report), await readApproval(deps.db, report.id), deps.config.venueLocale);
    await editAfterCommit(deps, messageId, view);
  }
  return { answer: t(actor.locale, 'review.answer.decided', { state: t(actor.locale, STATUS_NAME_KEYS[report.status]) }) };
}

/** Edits `report`'s card to its review card at `step`, in the venue's language. Throws when the edit fails. */
export async function showStep(deps: ReviewDeps, report: ReviewReport, step: CardStep): Promise<void> {
  if (report.cardMessageId === null) return;
  await editMessage(deps, report.cardMessageId, reviewCard(await cardFacts(deps.db, report), deps.config.venueLocale, step));
}

/** Edits `report`'s card (when it has one) to `view` after a decision committed; a failure is logged. */
export async function showAfterCommit(deps: ReviewDeps, report: ReviewReport, view: CardView): Promise<void> {
  if (report.cardMessageId !== null) await editAfterCommit(deps, report.cardMessageId, view);
}

/** The text of a prompt of `kind` for report `reportId` in `locale`, after `lead` when given. */
export function promptView(kind: PromptKind, reportId: string, locale: Locale, lead?: string): { readonly view: CardView; readonly forceReply: ForceReply } {
  const text = t(locale, kind === 'account_link' ? 'review.prompt.account' : 'review.prompt.points', { id: reportId });
  return {
    view: { text: lead === undefined ? text : `${lead}\n\n${text}` },
    forceReply: {
      force_reply: true,
      input_field_placeholder: t(locale, kind === 'account_link' ? 'review.placeholder.account' : 'review.placeholder.points'),
    },
  };
}

/** Deletes the messages of `prompts` (their rows are gone already). Never throws. */
export async function deletePromptMessages(deps: ReviewDeps, prompts: readonly AdminPrompt[]): Promise<void> {
  for (const prompt of prompts) {
    if (prompt.chatId === deps.config.adminChatId) await deleteInVenue(deps, prompt.promptMessageId);
  }
}

/** Deletes the approval prompts `actor` has open for `report`, rows and messages. */
export async function clearActorPrompts(deps: ReviewDeps, actor: Actor, report: ReviewReport): Promise<void> {
  const own = (await promptsOf(deps.db, report.id)).filter(
    (prompt) => prompt.adminId === actor.id && (prompt.kind === 'account_link' || prompt.kind === 'recommended_comment'),
  );
  if (own.length === 0) return;
  await deleteAdminPrompts(deps.db, report.id, actor.id);
  await deletePromptMessages(deps, own);
}

/**
 * Sends a prompt of `kind` for `report` to the venue, under its card, and
 * records it with what the admin chose so far; `actor`'s earlier approval
 * prompts for the report go first. A record that fails takes its message
 * with it, and the failure goes on.
 */
export async function sendPrompt(
  deps: ReviewDeps,
  actor: Actor,
  report: ReviewReport,
  kind: PromptKind,
  choice: { readonly category: Category; readonly linkMode: LinkMode | null },
): Promise<void> {
  await clearActorPrompts(deps, actor, report);
  const { view, forceReply } = promptView(kind, report.id, deps.config.venueLocale);
  const sent = await sendToVenue(deps, view, { forceReply, ...(report.cardMessageId === null ? {} : { replyTo: report.cardMessageId }) });
  try {
    await createPrompt(deps.db, {
      chatId: deps.config.adminChatId,
      promptMessageId: sent.message_id,
      adminId: actor.id,
      reportId: report.id,
      kind,
      category: choice.category,
      linkMode: choice.linkMode,
      createdAt: deps.clock.now(),
    });
  } catch (error) {
    await deleteInVenue(deps, sent.message_id);
    throw error;
  }
}

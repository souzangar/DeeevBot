// @critical-path
// The review card (critical invariants 2, 3, 4 and 7; the MVP plan, section
// 4, "Review"; doc/product/review-and-abuse-controls.md, "Review venue"):
// the one message per pending report in the admin review venue, posted when
// the report is submitted and edited, step by step, by the admins' presses.
//
// What it shows: the report's id and platform; the reporter's category
// label, a hint (after a cancelled approval, the category that approval
// confirmed, said so); every reported URL as non-tappable code text,
// whatever its host, because the admins must see it (a URL longer than
// URL_DISPLAY_LIMIT shown cut short, said so); the reporter's comment as
// code text, escaped, so Telegram cannot linkify a URL written in it; the
// affected-person flag; the opaque reporter reference, never the reporter's
// Telegram id, username or name, none of which is stored; and "previously
// reported, outcome X" for a target reported before (src/review/reports.ts,
// priorOutcome). Its buttons: Approve, Reject, Route as suspected CSAM,
// Block reporter; then the steps of each.
//
// The approval's steps (src/review/approve.ts): the category confirmation
// (the seven categories, the reporter's label marked; suspected CSAM leads
// to the routing card, never to an approval), the account link when the
// report has none, the link mode within allowedModes(), the recommended
// points. allowedModes() is the routing table's set (linkModesFor()) for
// the confirmed category, the account link alone when the reporter is the
// affected person, or when the flag is unknown (a cancelled approval cleared
// it: fail closed), and the post's URL only when the report has one distinct
// from the account's.
//
// The routing card replaces the review card for suspected CSAM: the links
// as code, the platform's own path, the hotlines on TRUSTED_HELP_HOSTS, the
// wording "unverified member report, content not opened" and a Confirm
// button; it is only ever an edit of the card in the venue.
//
// Once decided, a card shows its outcome without links (outcomeCard), or
// is deleted. Every view is checked again before it is sent or edited
// (src/review/venue.ts).
import type { InlineKeyboardButton, InlineKeyboardMarkup } from 'grammy/types';
import { utcMinute } from '../clock';
import type { SqlDb } from '../db/sql';
import { t, type Locale } from '../i18n/index';
import { PLATFORM_NAME_KEYS } from '../platforms/instructions';
import type { Platform } from '../platforms/platforms';
import { bidiIsolate, codeText, codeUrl } from '../telegram/render';
import { CATEGORIES, linkModesFor, type Category, type LinkMode } from './categories';
import { REJECT_REASONS, reviewData, type ReviewAction } from './callbacks';
import { CATEGORY_NAME_KEYS, MODE_NAME_KEYS, outcomeNameKey, REASON_NAME_KEYS, STATUS_NAME_KEYS } from './names';
import { priorOutcome, readApproval, type ApprovalRecord, type ReviewReport } from './reports';
import type { CardView } from './venue';

/** The longest URL a card shows whole, in characters; longer ones are cut and marked. */
export const URL_DISPLAY_LIMIT = 1000;

/** What the card knows besides the report: the target's earlier outcome, and whether an approval was cancelled. */
export interface CardFacts {
  readonly report: ReviewReport;
  /** The outcome code of an earlier report of the same target, or null. */
  readonly prior: string | null;
  /** True when the report holds a voided approval: its category is that approval's, no longer the reporter's label. */
  readonly cancelled: boolean;
}

/** A step of the card, after its review state. */
export type CardStep =
  | { readonly kind: 'review' }
  | { readonly kind: 'categories' }
  | { readonly kind: 'account'; readonly category: Category }
  | { readonly kind: 'modes'; readonly category: Category; readonly modes: readonly LinkMode[] }
  | { readonly kind: 'points'; readonly category: Category; readonly mode: LinkMode }
  | { readonly kind: 'reasons' };

const REVIEW: CardStep = Object.freeze({ kind: 'review' });

/** The facts of `report`'s card, read from the store. */
export async function cardFacts(db: SqlDb, report: ReviewReport): Promise<CardFacts> {
  const approval = await readApproval(db, report.id);
  return { report, prior: await priorOutcome(db, report), cancelled: approval !== null && approval.voidedAt !== null };
}

/**
 * The link modes an admin may pick for `report` under `category` (see the
 * header): never more than the routing table allows; the account link
 * alone unless the reporter said they are not the affected person; the
 * post's URL only when the report has one.
 */
export function allowedModes(report: Pick<ReviewReport, 'url' | 'accountUrl' | 'affectedPerson'>, category: Category): readonly LinkMode[] {
  const affected = report.affectedPerson !== false;
  const hasPost = report.url !== null && report.accountUrl !== null && report.url !== report.accountUrl;
  return linkModesFor(category, affected).filter((mode) => mode === 'account' || hasPost);
}

const button = (text: string, action: ReviewAction): InlineKeyboardButton.CallbackButton => ({
  text,
  callback_data: reviewData(action),
});

/** A URL as the card shows it: code text, cut at URL_DISPLAY_LIMIT, isolated as a run in Persian. */
const shownUrl = (locale: Locale, url: string): string => {
  const chars = [...url];
  const shown = chars.length > URL_DISPLAY_LIMIT ? `${codeUrl(chars.slice(0, URL_DISPLAY_LIMIT).join(''))} ${t(locale, 'review.card.cut')}` : codeUrl(url);
  return locale === 'fa' ? bidiIsolate(shown) : shown;
};

const platformName = (locale: Locale, platform: Platform): string => t(locale, PLATFORM_NAME_KEYS[platform]);
const categoryName = (locale: Locale, category: Category): string => t(locale, CATEGORY_NAME_KEYS[category]);

/** The card's lines about the reported links; an unknown account said so on the review card only. */
function linkLines(report: ReviewReport, locale: Locale, unknownAccount = true): string[] {
  const lines: string[] = [];
  if (report.url !== null) lines.push(`${t(locale, 'review.card.link')} ${shownUrl(locale, report.url)}`);
  if (report.accountUrl === null) {
    if (unknownAccount) lines.push(t(locale, 'review.card.account_unknown'));
  } else if (report.accountUrl !== report.url) {
    lines.push(`${t(locale, 'review.card.account')} ${shownUrl(locale, report.accountUrl)}`);
  }
  return lines;
}

/** The card's text, before its step line. */
function cardBody(facts: CardFacts, locale: Locale): string {
  const { report } = facts;
  const lines = [
    t(locale, 'review.card.title', { id: report.id, platform: platformName(locale, report.platform) }),
    t(locale, facts.cancelled ? 'review.card.category_earlier' : 'review.card.hint', {
      category: categoryName(locale, report.category),
    }),
    ...linkLines(report, locale),
    t(
      locale,
      report.affectedPerson === null ? 'review.card.affected_cleared' : report.affectedPerson ? 'review.card.affected_yes' : 'review.card.affected_no',
    ),
    report.comment === null ? t(locale, 'review.card.no_comment') : `${t(locale, 'review.card.comment')}\n${codeText(report.comment)}`,
  ];
  if (report.reporterRef !== null) lines.push(`${t(locale, 'review.card.reporter')} ${codeText(report.reporterRef)}`);
  if (facts.prior !== null) lines.push(t(locale, 'review.card.prior', { outcome: t(locale, outcomeNameKey(facts.prior)) }));
  return lines.join('\n');
}

/** The step's line under the card's text, if any. */
function stepLine(step: CardStep, locale: Locale): string | null {
  switch (step.kind) {
    case 'review':
      return null;
    case 'categories':
      return t(locale, 'review.step.category');
    case 'account':
      return t(locale, 'review.step.account', { category: categoryName(locale, step.category) });
    case 'modes':
      return t(locale, 'review.step.mode', { category: categoryName(locale, step.category) });
    case 'points':
      return t(locale, 'review.step.points', {
        category: categoryName(locale, step.category),
        mode: t(locale, MODE_NAME_KEYS[step.mode]),
      });
    case 'reasons':
      return t(locale, 'review.step.reject');
  }
}

/** The step's buttons. */
function stepKeyboard(report: ReviewReport, step: CardStep, locale: Locale): InlineKeyboardMarkup {
  const reportId = report.id;
  const back = [button(t(locale, 'review.button.back'), { kind: 'back', reportId })];
  switch (step.kind) {
    case 'review':
      return {
        inline_keyboard: [
          [button(t(locale, 'review.button.approve'), { kind: 'approve', reportId }), button(t(locale, 'review.button.reject'), { kind: 'reject', reportId })],
          [button(t(locale, 'review.button.route'), { kind: 'route', reportId })],
          [button(t(locale, 'review.button.block'), { kind: 'block', reportId })],
        ],
      };
    case 'categories':
      return {
        inline_keyboard: [
          ...CATEGORIES.map((category) => {
            const name = categoryName(locale, category);
            return [button(category === report.category ? `✓ ${name}` : name, { kind: 'category', reportId, category })];
          }),
          back,
        ],
      };
    case 'modes':
      return {
        inline_keyboard: [
          ...step.modes.map((mode) => [button(t(locale, MODE_NAME_KEYS[mode]), { kind: 'mode', reportId, category: step.category, mode })]),
          back,
        ],
      };
    case 'reasons':
      return {
        inline_keyboard: [...REJECT_REASONS.map((reason) => [button(t(locale, REASON_NAME_KEYS[reason]), { kind: 'reason', reportId, reason })]), back],
      };
    case 'account':
    case 'points':
      return { inline_keyboard: [back] };
  }
}

/** The review card of `facts` at `step` (see the header). */
export function reviewCard(facts: CardFacts, locale: Locale, step: CardStep = REVIEW): CardView {
  const line = stepLine(step, locale);
  const body = cardBody(facts, locale);
  return { text: line === null ? body : `${body}\n\n${line}`, keyboard: stepKeyboard(facts.report, step, locale) };
}

/** Each platform's own path for suspected CSAM, on the routing card. */
const ROUTE_PATH_KEYS = Object.freeze({
  instagram: 'review.route.path.instagram',
  x: 'review.route.path.x',
  facebook: 'review.route.path.facebook',
  tiktok: 'review.route.path.tiktok',
  telegram: 'review.route.path.telegram',
  other: 'review.route.path.other',
} as const satisfies Record<Platform, string>);

/** The routing card of `report`, which replaces its review card (see the header). */
export function routingCard(report: ReviewReport, locale: Locale): CardView {
  const text = [
    t(locale, 'review.route.title', { id: report.id }),
    t(locale, 'review.route.intro'),
    linkLines(report, locale, false).join('\n'),
    `${t(locale, 'review.route.platform_heading')}\n${t(locale, ROUTE_PATH_KEYS[report.platform])}`,
    t(locale, 'review.route.hotlines'),
    t(locale, 'review.route.confirm_note'),
  ].join('\n\n');
  return {
    text,
    keyboard: {
      inline_keyboard: [
        [button(t(locale, 'review.button.confirm_route'), { kind: 'confirm_route', reportId: report.id })],
        [button(t(locale, 'review.button.back'), { kind: 'back', reportId: report.id })],
      ],
    },
  };
}

/** The card of an approved report in its grace: what it posts and when, and Cancel. */
export function approvedCard(report: ReviewReport, approval: ApprovalRecord, locale: Locale): CardView {
  const text = [
    t(locale, 'review.card.title', { id: report.id, platform: platformName(locale, report.platform) }),
    t(locale, 'review.card.category', { category: categoryName(locale, report.category) }),
    ...linkLines(report, locale, false),
    '',
    t(locale, 'review.card.approved', { time: utcMinute(approval.startsAt), mode: t(locale, MODE_NAME_KEYS[approval.linkMode]) }),
  ].join('\n');
  return {
    text,
    keyboard: {
      inline_keyboard: [[button(t(locale, 'review.button.cancel'), { kind: 'cancel', reportId: report.id, approvalId: approval.approvalId })]],
    },
  };
}

/** A decided report's card: its id and outcome, without links or buttons. */
export function outcomeCard(report: Pick<ReviewReport, 'id' | 'status'>, locale: Locale): CardView {
  return { text: t(locale, 'review.card.outcome', { id: report.id, outcome: t(locale, STATUS_NAME_KEYS[report.status]) }) };
}

/** The card `report` shows in its current state: the review, the approval in its grace, or the outcome. */
export function currentCard(facts: CardFacts, approval: ApprovalRecord | null, locale: Locale): CardView {
  const { report } = facts;
  if (report.status === 'pending') return reviewCard(facts, locale);
  if (report.status === 'approved' && approval !== null && approval.voidedAt === null) return approvedCard(report, approval, locale);
  return outcomeCard(report, locale);
}

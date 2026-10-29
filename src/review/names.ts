// @critical-path
// The names the review shows (critical invariant 3: the catalog's own text,
// never report data): each category's name for the admins and for a post,
// each status, each outcome a target can have had, each link mode and each
// rejection reason, as catalog keys (src/i18n/). They are plain text: a
// button label or a placeholder's value, never parsed as HTML. The
// reporter's own labels for the categories are the intake's
// (ROUTING[category].labelKey, src/review/categories.ts).
import type { PlainMessageKey } from '../i18n/index';
import type { Category, LinkMode } from './categories';
import type { RejectReason } from './callbacks';
import type { ReportStatus } from './reports';

/** Each category's name, as the routing table names it. */
export const CATEGORY_NAME_KEYS: Readonly<Record<Category, PlainMessageKey>> = Object.freeze({
  private_data: 'review.category.private_data',
  child_safety: 'review.category.child_safety',
  csam: 'review.category.csam',
  harassment: 'review.category.harassment',
  intimate_images: 'review.category.intimate_images',
  impersonation: 'review.category.impersonation',
  other: 'review.category.other',
});

/** Each status's name. */
export const STATUS_NAME_KEYS: Readonly<Record<ReportStatus, PlainMessageKey>> = Object.freeze({
  pending: 'status.pending',
  approved: 'status.approved',
  posting: 'status.posting',
  posted: 'status.posted',
  closing: 'status.closing',
  retracting: 'status.retracting',
  closed: 'status.closed',
  retracted: 'status.retracted',
  expired: 'status.expired',
  rejected: 'status.rejected',
  routed: 'status.routed',
  merged: 'status.merged',
});

/** The outcomes a target can have had, by their codes (an aggregate row's, or a decided report's status). */
const OUTCOME_KEYS: Readonly<Record<string, PlainMessageKey>> = Object.freeze({
  taken_down: 'review.outcome.taken_down',
  no_result: 'review.outcome.no_result',
  retracted: 'review.outcome.retracted',
  expired: 'review.outcome.expired',
  no_decision: 'review.outcome.no_decision',
  rejected: 'review.outcome.rejected',
  routed: 'review.outcome.routed',
});

/** The name of outcome `code`, or the generic one for a code this unit does not know. */
export const outcomeNameKey = (code: string): PlainMessageKey =>
  Object.hasOwn(OUTCOME_KEYS, code) ? (OUTCOME_KEYS[code] ?? 'review.outcome.other') : 'review.outcome.other';

/** Each link mode's button label. */
export const MODE_NAME_KEYS: Readonly<Record<LinkMode, PlainMessageKey>> = Object.freeze({
  account: 'review.mode.account',
  post: 'review.mode.post',
});

/** Each rejection reason's button label. */
export const REASON_NAME_KEYS: Readonly<Record<RejectReason, PlainMessageKey>> = Object.freeze({
  no_violation: 'review.reason.no_violation',
  wrong_target: 'review.reason.wrong_target',
  weaponised: 'review.reason.weaponised',
  other: 'review.reason.other',
});

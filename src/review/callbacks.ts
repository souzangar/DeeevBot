// @critical-path
// The review's button data (critical invariants 1, 2 and 7; the MVP plan,
// sections 4 and 8): every button on a review card, a routing card and a
// status card in the venue, and on a keyholder's approval notice, carries
// data written here, and a press is read back here, in exactly a form this
// module writes, or not at all. The data is never authority: who pressed is
// the update's own `from.id`, checked by the gates every button is
// registered behind (src/telegram/registry.ts), and what the data names (a
// category, a link mode, a reason) is checked again against the report and
// the routing table by the flow it starts, at every step. Ids are the
// random 20-letter ids of src/db/ids.ts, so the data can be neither forged
// for another report nor enumerated.
//
// Each action has its own prefix (`rv:` for the review, `kh:` for the
// keyholder notice), and the registry registers each prefix once, so the
// always-run lockdown spec drives every one. Every form stays within
// Telegram's 64 bytes (tested): the longest, a link-mode choice, is 50.
import { isId } from '../db/ids';
import { isCategory, LINK_MODES, type Category, type LinkMode } from './categories';

/** Why an admin rejects a report: internal codes, shown to nobody but the admins. */
export const REJECT_REASONS = ['no_violation', 'wrong_target', 'weaponised', 'other'] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export const isRejectReason = (value: unknown): value is RejectReason =>
  typeof value === 'string' && (REJECT_REASONS as readonly string[]).includes(value);

const isLinkMode = (value: unknown): value is LinkMode =>
  typeof value === 'string' && (LINK_MODES as readonly string[]).includes(value);

/** A press of an admin button in the venue. */
export type ReviewAction =
  | { readonly kind: 'approve'; readonly reportId: string }
  | { readonly kind: 'category'; readonly reportId: string; readonly category: Category }
  | { readonly kind: 'mode'; readonly reportId: string; readonly category: Category; readonly mode: LinkMode }
  | { readonly kind: 'reject'; readonly reportId: string }
  | { readonly kind: 'reason'; readonly reportId: string; readonly reason: RejectReason }
  | { readonly kind: 'route'; readonly reportId: string }
  | { readonly kind: 'confirm_route'; readonly reportId: string }
  | { readonly kind: 'cancel'; readonly reportId: string; readonly approvalId: string }
  | { readonly kind: 'block'; readonly reportId: string }
  | { readonly kind: 'back'; readonly reportId: string };

export type ReviewActionKind = ReviewAction['kind'];

/** Each admin action's prefix: no prefix is a prefix of another. */
export const REVIEW_PREFIXES = Object.freeze({
  approve: 'rv:ap:',
  category: 'rv:ct:',
  mode: 'rv:md:',
  reject: 'rv:rj:',
  reason: 'rv:rs:',
  route: 'rv:ro:',
  confirm_route: 'rv:rc:',
  cancel: 'rv:cn:',
  block: 'rv:bl:',
  back: 'rv:bk:',
} as const satisfies Record<ReviewActionKind, string>);

/** A press of a keyholder button on an approval notice. */
export type NoticeAction =
  | { readonly kind: 'cancel'; readonly reportId: string; readonly approvalId: string }
  | { readonly kind: 'lockdown' };

export type NoticeActionKind = NoticeAction['kind'];

/** Each keyholder action's prefix; the Lockdown button's data is its prefix alone. */
export const NOTICE_PREFIXES = Object.freeze({
  cancel: 'kh:cn:',
  lockdown: 'kh:lk',
} as const satisfies Record<NoticeActionKind, string>);

/** Telegram's bound on a button's callback data, in bytes. */
export const CALLBACK_DATA_MAX_BYTES = 64;

/** The data of `action`'s button. */
export function reviewData(action: ReviewAction): string {
  const prefix = REVIEW_PREFIXES[action.kind];
  switch (action.kind) {
    case 'category':
      return `${prefix}${action.reportId}:${action.category}`;
    case 'mode':
      return `${prefix}${action.reportId}:${action.category}:${action.mode}`;
    case 'reason':
      return `${prefix}${action.reportId}:${action.reason}`;
    case 'cancel':
      return `${prefix}${action.reportId}:${action.approvalId}`;
    default:
      return `${prefix}${action.reportId}`;
  }
}

/** The data of `action`'s button on a notice. */
export function noticeData(action: NoticeAction): string {
  return action.kind === 'lockdown' ? NOTICE_PREFIXES.lockdown : `${NOTICE_PREFIXES.cancel}${action.reportId}:${action.approvalId}`;
}

/** The parts of `data` after `prefix`, split at ':', or null when it does not start with it. */
const partsAfter = (data: string, prefix: string): string[] | null =>
  data.startsWith(prefix) ? data.slice(prefix.length).split(':') : null;

/** The action `data` is, in exactly a form reviewData() writes; else null. */
export function parseReviewData(data: string): ReviewAction | null {
  for (const kind of Object.keys(REVIEW_PREFIXES) as ReviewActionKind[]) {
    const parts = partsAfter(data, REVIEW_PREFIXES[kind]);
    if (parts === null) continue;
    const [reportId, first, second] = parts;
    if (!isId(reportId)) return null;
    switch (kind) {
      case 'category':
        return parts.length === 2 && isCategory(first) ? { kind, reportId, category: first } : null;
      case 'mode':
        return parts.length === 3 && isCategory(first) && isLinkMode(second)
          ? { kind, reportId, category: first, mode: second }
          : null;
      case 'reason':
        return parts.length === 2 && isRejectReason(first) ? { kind, reportId, reason: first } : null;
      case 'cancel':
        return parts.length === 2 && isId(first) ? { kind, reportId, approvalId: first } : null;
      default:
        return parts.length === 1 ? { kind, reportId } : null;
    }
  }
  return null;
}

/** The notice action `data` is, in exactly a form noticeData() writes; else null. */
export function parseNoticeData(data: string): NoticeAction | null {
  if (data === NOTICE_PREFIXES.lockdown) return { kind: 'lockdown' };
  const parts = partsAfter(data, NOTICE_PREFIXES.cancel);
  if (parts === null || parts.length !== 2) return null;
  const [reportId, approvalId] = parts;
  return isId(reportId) && isId(approvalId) ? { kind: 'cancel', reportId, approvalId } : null;
}

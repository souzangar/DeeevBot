// Unit tests for the review's button data (src/review/callbacks.ts): every
// action written and read back in exactly its own form, within Telegram's
// 64 bytes, each prefix its own and none a prefix of another, and anything
// else, a forged category, mode, reason or id among it, read as nothing.
import { describe, expect, it } from 'vitest';
import { randomId } from '../db/ids';
import {
  CALLBACK_DATA_MAX_BYTES,
  NOTICE_PREFIXES,
  noticeData,
  parseNoticeData,
  parseReviewData,
  REJECT_REASONS,
  REVIEW_PREFIXES,
  reviewData,
  type NoticeAction,
  type ReviewAction,
} from './callbacks';
import { CATEGORIES, LINK_MODES } from './categories';

const REPORT = 'abcdefghijklmnopqrst';
const APPROVAL = 'zyxwvutsrqponmlkjihg';

/** One action of every kind and every value. */
const ACTIONS: readonly ReviewAction[] = [
  { kind: 'approve', reportId: REPORT },
  ...CATEGORIES.map((category) => ({ kind: 'category' as const, reportId: REPORT, category })),
  ...CATEGORIES.flatMap((category) => LINK_MODES.map((mode) => ({ kind: 'mode' as const, reportId: REPORT, category, mode }))),
  { kind: 'reject', reportId: REPORT },
  ...REJECT_REASONS.map((reason) => ({ kind: 'reason' as const, reportId: REPORT, reason })),
  { kind: 'route', reportId: REPORT },
  { kind: 'confirm_route', reportId: REPORT },
  { kind: 'cancel', reportId: REPORT, approvalId: APPROVAL },
  { kind: 'block', reportId: REPORT },
  { kind: 'back', reportId: REPORT },
];
const NOTICES: readonly NoticeAction[] = [{ kind: 'cancel', reportId: REPORT, approvalId: APPROVAL }, { kind: 'lockdown' }];

const bytes = (text: string): number => new TextEncoder().encode(text).length;

describe('reviewData and parseReviewData', () => {
  it('read back every action they write, exactly', () => {
    for (const action of ACTIONS) expect(parseReviewData(reviewData(action)), JSON.stringify(action)).toEqual(action);
  });

  it('write every action under its own prefix, within 64 bytes', () => {
    for (const action of ACTIONS) {
      const data = reviewData(action);
      expect(data.startsWith(REVIEW_PREFIXES[action.kind])).toBe(true);
      expect(bytes(data), data).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
    }
    expect(Math.max(...ACTIONS.map((action) => bytes(reviewData(action))))).toBe(50);
  });

  it('give every kind its own prefix, none a prefix of another', () => {
    const prefixes = [...Object.values(REVIEW_PREFIXES), ...Object.values(NOTICE_PREFIXES)];
    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const one of prefixes) {
      for (const other of prefixes) if (one !== other) expect(other.startsWith(one), `${one} ${other}`).toBe(false);
    }
  });

  it.each([
    ['an unknown prefix', `rv:xx:${REPORT}`],
    ['a short id', 'rv:ap:abc'],
    ['an id with a digit', `rv:ap:${REPORT.slice(0, 19)}1`],
    ['an id in capitals', `rv:ap:${REPORT.toUpperCase()}`],
    ['a trailing part', `rv:ap:${REPORT}:x`],
    ['an unknown category', `rv:ct:${REPORT}:nudity`],
    ['a category with no report', 'rv:ct:harassment'],
    ['an unknown link mode', `rv:md:${REPORT}:harassment:everything`],
    ['a link mode without its category', `rv:md:${REPORT}:post`],
    ['an unknown reason', `rv:rs:${REPORT}:because`],
    ['a cancel without its approval', `rv:cn:${REPORT}`],
    ['a cancel with a short approval id', `rv:cn:${REPORT}:abc`],
    ['a notice prefix', `kh:cn:${REPORT}:${APPROVAL}`],
    ['an intake press', 'intake:category:harassment'],
    ['a mark press', `mark:${REPORT}`],
    ['nothing', ''],
  ])('reads nothing from %s', (_label, data) => {
    expect(parseReviewData(data)).toBeNull();
  });
});

describe('noticeData and parseNoticeData', () => {
  it('read back both actions, within 64 bytes', () => {
    for (const action of NOTICES) {
      const data = noticeData(action);
      expect(parseNoticeData(data)).toEqual(action);
      expect(bytes(data)).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
    }
    expect(noticeData({ kind: 'lockdown' })).toBe('kh:lk');
  });

  it.each([
    ['a lockdown with more', 'kh:lkx'],
    ['a cancel without its approval', `kh:cn:${REPORT}`],
    ['a cancel with a forged id', `kh:cn:${REPORT}:${APPROVAL}1`],
    ['a review cancel', `rv:cn:${REPORT}:${APPROVAL}`],
  ])('reads nothing from %s', (_label, data) => {
    expect(parseNoticeData(data)).toBeNull();
  });

  it('carries the random ids it is given, so a stale button names its own approval', () => {
    const first = randomId();
    const second = randomId();
    expect(parseNoticeData(noticeData({ kind: 'cancel', reportId: REPORT, approvalId: first }))).toMatchObject({ approvalId: first });
    expect(noticeData({ kind: 'cancel', reportId: REPORT, approvalId: first })).not.toBe(
      noticeData({ kind: 'cancel', reportId: REPORT, approvalId: second }),
    );
  });
});

// Unit tests for the status card (src/review/status-card.ts; critical
// invariants 1 and 3): the report's id, platform, category and state, the
// start and the notified keyholders in the grace, Cancel bound to the live
// approval and Block reporter while the reference is there; never a URL, a
// comment or a reference.
import { describe, expect, it } from 'vitest';
import { t } from '../i18n/index';
import { parseReviewData } from './callbacks';
import type { ApprovalRecord, ReviewReport } from './reports';
import { statusCard } from './status-card';

const REF = 'ab'.repeat(32);
const REPORT: Pick<ReviewReport, 'id' | 'status' | 'platform' | 'category' | 'reporterRef'> = {
  id: 'abcdefghijklmnopqrst',
  status: 'approved',
  platform: 'instagram',
  category: 'private_data',
  reporterRef: REF,
};
const APPROVAL: Pick<ApprovalRecord, 'approvalId' | 'startsAt' | 'voidedAt'> = {
  approvalId: 'zyxwvutsrqponmlkjihg',
  startsAt: Date.UTC(2027, 0, 15, 12, 30),
  voidedAt: null,
};
const actions = (view: ReturnType<typeof statusCard>) =>
  (view.keyboard?.inline_keyboard ?? []).flat().map((button) => ('callback_data' in button ? parseReviewData(button.callback_data) : null));

describe('statusCard', () => {
  it('shows the grace: the id, platform, category, start and notified keyholders, with Cancel and Block reporter', () => {
    const view = statusCard(REPORT, APPROVAL, 'en', { sent: 1, total: 2 });
    expect(view.text).toBe(
      [
        t('en', 'review.status_card.title', { id: REPORT.id }),
        `${t('en', 'platform.instagram')} · ${t('en', 'review.category.private_data')}`,
        t('en', 'review.status_card.in_grace', { time: '2027-01-15 12:30 UTC' }),
        t('en', 'review.status_card.notified', { sent: 1, total: 2 }),
      ].join('\n'),
    );
    expect(actions(view)).toEqual([
      { kind: 'cancel', reportId: REPORT.id, approvalId: APPROVAL.approvalId },
      { kind: 'block', reportId: REPORT.id },
    ]);
    expect(view.text).not.toContain(REF);
    expect(view.text).not.toContain('https://');
  });

  it('shows any other state by its name, with no Cancel', () => {
    const view = statusCard({ ...REPORT, status: 'posted' }, APPROVAL, 'fa');
    expect(view.text).toContain(t('fa', 'review.status_card.state', { state: t('fa', 'status.posted') }));
    expect(actions(view)).toEqual([{ kind: 'block', reportId: REPORT.id }]);
    expect(statusCard(REPORT, { ...APPROVAL, voidedAt: 1 }, 'en').text).toContain(t('en', 'status.approved'));
  });

  it('has no buttons once the reference is gone and the grace is over', () => {
    expect(statusCard({ ...REPORT, status: 'rejected', reporterRef: null }, null, 'en').keyboard).toBeUndefined();
  });
});

// Unit tests for the status card (src/review/status-card.ts; critical
// invariants 1 and 3): the report's id, platform, category and state, the
// start and the notified keyholders in the grace, Cancel bound to the live
// approval, the closure and retraction buttons while the report is posted,
// and Block reporter while the reference is there; the notes of a closure
// or a retraction under way and of an edit refused; the concluded card with
// its outcome and no button; never a URL, a comment or a reference.
import { describe, expect, it } from 'vitest';
import { t } from '../i18n/index';
import { parseReviewData } from './callbacks';
import type { ApprovalRecord, ReviewReport } from './reports';
import { concludedStatusCard, statusCard } from './status-card';

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
    const view = statusCard({ ...REPORT, status: 'closing' }, APPROVAL, 'fa');
    expect(view.text).toContain(t('fa', 'review.status_card.state', { state: t('fa', 'status.closing') }));
    expect(actions(view)).toEqual([{ kind: 'block', reportId: REPORT.id }]);
    expect(statusCard(REPORT, { ...APPROVAL, voidedAt: 1 }, 'en').text).toContain(t('en', 'status.approved'));
  });

  it('gives a posted report its closure and retraction buttons, before Block reporter, and no Cancel', () => {
    const view = statusCard({ ...REPORT, status: 'posted' }, null, 'en');
    expect(view.text).toContain(t('en', 'review.status_card.state', { state: t('en', 'status.posted') }));
    expect(actions(view)).toEqual([
      { kind: 'close', reportId: REPORT.id, outcome: 'taken_down' },
      { kind: 'close', reportId: REPORT.id, outcome: 'no_result' },
      { kind: 'retract', reportId: REPORT.id },
      { kind: 'block', reportId: REPORT.id },
    ]);
    expect(view.keyboard?.inline_keyboard.flat().map((button) => button.text)).toEqual([
      t('en', 'review.button.taken_down'),
      t('en', 'review.button.no_result'),
      t('en', 'review.button.retract'),
      t('en', 'review.button.block'),
    ]);
    for (const status of ['closing', 'retracting', 'closed', 'retracted', 'expired'] as const) {
      expect(actions(statusCard({ ...REPORT, status }, null, 'en')), status).toEqual([{ kind: 'block', reportId: REPORT.id }]);
    }
  });

  it('has no buttons once the reference is gone and the grace is over', () => {
    expect(statusCard({ ...REPORT, status: 'rejected', reporterRef: null }, null, 'en').keyboard).toBeUndefined();
  });
});

describe('statusCard with a note of the scheduler', () => {
  it('says what needs a human in place of the grace line, keeping Cancel while the report is approved', () => {
    for (const note of ['refused', 'held', 'reposted'] as const) {
      const view = statusCard(REPORT, APPROVAL, 'en', { sent: 2, total: 2 }, note);
      expect(view.text, note).toBe(
        [
          t('en', 'review.status_card.title', { id: REPORT.id }),
          `${t('en', 'platform.instagram')} · ${t('en', 'review.category.private_data')}`,
          t('en', 'review.status_card.state', { state: t('en', 'status.approved') }),
          t('en', `review.status_card.note.${note}`, { id: REPORT.id }),
        ].join('\n'),
      );
      expect(actions(view)[0], note).toEqual({ kind: 'cancel', reportId: REPORT.id, approvalId: APPROVAL.approvalId });
    }
  });

  it('says a closure or a retraction is under way, or an edit was refused, without the closure buttons', () => {
    for (const [status, note] of [
      ['closing', 'closing'],
      ['retracting', 'retracting'],
      ['closing', 'edit_failed'],
      ['retracting', 'edit_failed'],
    ] as const) {
      const view = statusCard({ ...REPORT, status }, null, 'en', undefined, note);
      expect(view.text, note).toContain(t('en', 'review.status_card.state', { state: t('en', `status.${status}`) }));
      expect(view.text, note).toContain(t('en', `review.status_card.note.${note}`, { id: REPORT.id }));
      expect(actions(view), note).toEqual([{ kind: 'block', reportId: REPORT.id }]);
    }
  });

  it('shows a post that may or may not be in the channel without Cancel, and without a link', () => {
    const view = statusCard({ ...REPORT, status: 'posting' }, APPROVAL, 'fa', undefined, 'unknown');
    expect(view.text).toContain(t('fa', 'review.status_card.note.unknown', { id: REPORT.id }));
    expect(actions(view)).toEqual([{ kind: 'block', reportId: REPORT.id }]);
    expect(view.text).not.toContain('https://');
  });
});

describe('concludedStatusCard', () => {
  it('shows the id, platform, category and outcome, and no button', () => {
    for (const outcome of ['taken_down', 'no_result', 'retracted', 'expired'] as const) {
      const view = concludedStatusCard(REPORT, outcome, 'en');
      expect(view.text, outcome).toBe(
        [
          t('en', 'review.status_card.title', { id: REPORT.id }),
          `${t('en', 'platform.instagram')} · ${t('en', 'review.category.private_data')}`,
          t('en', 'review.status_card.concluded', { outcome: t('en', `review.outcome.${outcome}`) }),
        ].join('\n'),
      );
      expect(view.keyboard, outcome).toBeUndefined();
    }
    expect(concludedStatusCard(REPORT, 'something else', 'fa').text).toContain(t('fa', 'review.outcome.other'));
  });
});

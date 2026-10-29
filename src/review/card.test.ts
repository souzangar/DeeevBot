// Unit tests for the review card's views (src/review/card.ts; critical
// invariants 3, 4 and 7): what a card shows and never shows (the reporter
// reference, never an id, a username or a name; every URL and the comment
// as code text), its buttons at each step, the link modes an admin may
// pick, the routing card's links on the help hosts and its Confirm, the
// approved card's Cancel bound to its approval, and an outcome without links.
import { describe, expect, it } from 'vitest';
import { DEFAULT_LINK_HOSTS } from '../config/schema';
import { telegramHtmlProblems } from '../i18n/html';
import { t } from '../i18n/index';
import { linksIn, outgoingLinkProblems } from '../platforms/link-policy';
import { parseReviewData, REJECT_REASONS, reviewData } from './callbacks';
import {
  allowedModes,
  approvedCard,
  currentCard,
  outcomeCard,
  reviewCard,
  routingCard,
  URL_DISPLAY_LIMIT,
  type CardFacts,
} from './card';
import { CATEGORIES } from './categories';
import type { ApprovalRecord, ReviewReport } from './reports';
import type { CardView } from './venue';

const REF = 'ab'.repeat(32);
const REPORT: ReviewReport = {
  id: 'abcdefghijklmnopqrst',
  status: 'pending',
  platform: 'x',
  category: 'harassment',
  url: 'https://x.com/someone/status/1234567890',
  accountUrl: 'https://x.com/someone',
  comment: 'see https://evil.test/ and <b>this</b>',
  affectedPerson: false,
  reporterRef: REF,
  mergedInto: null,
  linkHash: 'cd'.repeat(32),
  createdAt: 1_800_000_000_000,
  cardMessageId: 7,
  statusMessageId: null,
};
const FACTS: CardFacts = { report: REPORT, prior: null, cancelled: false };
const APPROVAL: ApprovalRecord = {
  reportId: REPORT.id,
  approvalId: 'zyxwvutsrqponmlkjihg',
  adminId: 424240011,
  approvedAt: Date.UTC(2027, 0, 15, 12, 0),
  linkMode: 'post',
  recommendedComment: 'say it',
  startsAt: Date.UTC(2027, 0, 15, 12, 30),
  voidedAt: null,
};

const data = (view: CardView) =>
  (view.keyboard?.inline_keyboard ?? []).flat().map((button) => ('callback_data' in button ? button.callback_data : ''));
const texts = (view: CardView) => (view.keyboard?.inline_keyboard ?? []).flat().map((button) => button.text);

describe('reviewCard', () => {
  it('shows the reference, the platform, the hint, the links and the comment as code, and the flag', () => {
    const { text } = reviewCard(FACTS, 'en');
    expect(text).toContain(`<code>${REPORT.id}</code>`);
    expect(text).toContain(t('en', 'review.card.hint', { category: t('en', 'review.category.harassment') }));
    expect(text).toContain('<code>https://x.com/someone/status/1234567890</code>');
    expect(text).toContain('<code>https://x.com/someone</code>');
    expect(text).toContain('<code>see https://evil.test/ and &lt;b&gt;this&lt;/b&gt;</code>');
    expect(text).toContain(t('en', 'review.card.affected_no'));
    expect(text).toContain(`<code>${REF}</code>`);
    expect(telegramHtmlProblems(text)).toEqual([]);
    // Nothing on the card is tappable but what the lists allow: the URLs and the comment are code.
    expect(linksIn(text)).toEqual([]);
  });

  it('says what it does not know: the account, the comment, a cleared flag, a cancelled approval, a prior outcome', () => {
    const { text } = reviewCard(
      { report: { ...REPORT, accountUrl: null, comment: null, affectedPerson: null }, prior: 'rejected', cancelled: true },
      'en',
    );
    expect(text).toContain(t('en', 'review.card.account_unknown'));
    expect(text).toContain(t('en', 'review.card.no_comment'));
    expect(text).toContain(t('en', 'review.card.affected_cleared'));
    expect(text).toContain(t('en', 'review.card.category_earlier', { category: t('en', 'review.category.harassment') }));
    expect(text).toContain(t('en', 'review.card.prior', { outcome: t('en', 'review.outcome.rejected') }));
  });

  it('shows an account report once, and a very long URL cut short and marked', () => {
    const account = reviewCard({ ...FACTS, report: { ...REPORT, url: REPORT.accountUrl } }, 'en').text;
    expect(account.match(/<code>https:\/\/x\.com\/someone<\/code>/g)).toHaveLength(1);
    const long = `https://leak-site.org/${'p'.repeat(2000)}`;
    const cut = reviewCard({ ...FACTS, report: { ...REPORT, platform: 'other', url: long, accountUrl: null } }, 'en').text;
    expect(cut).toContain(`<code>${long.slice(0, URL_DISPLAY_LIMIT)}</code> ${t('en', 'review.card.cut')}`);
    expect(cut).not.toContain(long);
  });

  it('isolates the URLs as left-to-right runs in Persian', () => {
    expect(reviewCard(FACTS, 'fa').text).toContain('⁨<code>https://x.com/someone</code>⁩');
  });

  it('offers Approve, Reject, Route as suspected CSAM and Block reporter in its review state', () => {
    expect(data(reviewCard(FACTS, 'en')).map((each) => parseReviewData(each)?.kind)).toEqual(['approve', 'reject', 'route', 'block']);
  });

  it('offers the seven categories at confirmation, the reporter\'s label marked, and Back', () => {
    const view = reviewCard(FACTS, 'en', { kind: 'categories' });
    expect(data(view).map((each) => parseReviewData(each))).toEqual([
      ...CATEGORIES.map((category) => ({ kind: 'category', reportId: REPORT.id, category })),
      { kind: 'back', reportId: REPORT.id },
    ]);
    expect(texts(view).filter((text) => text.startsWith('✓ '))).toEqual([`✓ ${t('en', 'review.category.harassment')}`]);
    expect(view.text).toContain(t('en', 'review.step.category'));
  });

  it('offers the modes it is given, the reasons, and Back alone while a prompt waits', () => {
    expect(data(reviewCard(FACTS, 'en', { kind: 'modes', category: 'harassment', modes: ['account'] }))).toEqual([
      reviewData({ kind: 'mode', reportId: REPORT.id, category: 'harassment', mode: 'account' }),
      reviewData({ kind: 'back', reportId: REPORT.id }),
    ]);
    expect(data(reviewCard(FACTS, 'en', { kind: 'reasons' })).map((each) => parseReviewData(each))).toEqual([
      ...REJECT_REASONS.map((reason) => ({ kind: 'reason', reportId: REPORT.id, reason })),
      { kind: 'back', reportId: REPORT.id },
    ]);
    for (const step of [{ kind: 'account', category: 'harassment' }, { kind: 'points', category: 'harassment', mode: 'post' }] as const) {
      expect(data(reviewCard(FACTS, 'en', step))).toEqual([reviewData({ kind: 'back', reportId: REPORT.id })]);
    }
  });
});

describe('allowedModes', () => {
  it("is the routing table's set when the reporter is not the affected person and the report has a post", () => {
    expect(allowedModes(REPORT, 'harassment')).toEqual(['account', 'post']);
    expect(allowedModes(REPORT, 'intimate_images')).toEqual(['account']);
  });

  it('is the account link alone for the affected person, and for a flag a decision cleared', () => {
    expect(allowedModes({ ...REPORT, affectedPerson: true }, 'harassment')).toEqual(['account']);
    expect(allowedModes({ ...REPORT, affectedPerson: null }, 'private_data')).toEqual(['account']);
  });

  it('is the account link alone for a report without a post URL of its own', () => {
    expect(allowedModes({ ...REPORT, url: REPORT.accountUrl }, 'harassment')).toEqual(['account']);
  });

  it('is nothing for suspected CSAM', () => {
    expect(allowedModes(REPORT, 'csam')).toEqual([]);
  });
});

describe('routingCard', () => {
  it('shows the links as code, the platform path, the hotlines on the help hosts, the wording and Confirm', () => {
    for (const locale of ['en', 'fa'] as const) {
      const view = routingCard(REPORT, locale);
      expect(view.text).toContain('<code>https://x.com/someone/status/1234567890</code>');
      expect(view.text).toContain(t(locale, 'review.route.path.x'));
      expect(view.text).toContain(t(locale, 'review.route.hotlines'));
      expect(view.text).toContain('unverified member report, content not opened');
      expect(outgoingLinkProblems(view.text, DEFAULT_LINK_HOSTS)).toEqual([]);
      expect(linksIn(view.text).map((link) => link.text)).toEqual(
        expect.arrayContaining(['https://report.cybertip.org/', 'https://help.x.com/en/forms/safety-and-sensitive-content/cse']),
      );
      expect(data(view).map((each) => parseReviewData(each)?.kind)).toEqual(['confirm_route', 'back']);
      expect(view.text).not.toContain(REPORT.comment ?? '');
    }
  });

  it('shows only the links the report has, never the review card\'s line about an unknown account', () => {
    const view = routingCard({ ...REPORT, accountUrl: null }, 'en');
    expect(view.text).toContain('<code>https://x.com/someone/status/1234567890</code>');
    expect(view.text).not.toContain(t('en', 'review.card.account_unknown'));
  });

  it('names stopCA for a Telegram target, as code text', () => {
    const view = routingCard({ ...REPORT, platform: 'telegram', url: 'https://t.me/leak_channel/7', accountUrl: 'https://t.me/leak_channel' }, 'en');
    expect(view.text).toContain('<code>stopCA@telegram.org</code>');
    expect(outgoingLinkProblems(view.text, DEFAULT_LINK_HOSTS)).toEqual([]);
  });
});

describe('approvedCard, outcomeCard and currentCard', () => {
  it('shows an approved report with its start and a Cancel bound to its approval', () => {
    const view = approvedCard({ ...REPORT, status: 'approved', comment: null, affectedPerson: null }, APPROVAL, 'en');
    expect(view.text).toContain('2027-01-15 12:30 UTC');
    expect(data(view)).toEqual([reviewData({ kind: 'cancel', reportId: REPORT.id, approvalId: APPROVAL.approvalId })]);
    expect(view.text).not.toContain(REF);
  });

  it('shows an outcome without links or buttons', () => {
    const view = outcomeCard({ id: REPORT.id, status: 'rejected' }, 'en');
    expect(view).toEqual({ text: t('en', 'review.card.outcome', { id: REPORT.id, outcome: t('en', 'status.rejected') }) });
    expect(view.text).not.toContain('https://');
  });

  it('picks the view of the current state', () => {
    expect(currentCard(FACTS, null, 'en')).toEqual(reviewCard(FACTS, 'en'));
    const approved = { ...REPORT, status: 'approved' as const };
    expect(currentCard({ ...FACTS, report: approved }, APPROVAL, 'en')).toEqual(approvedCard(approved, APPROVAL, 'en'));
    expect(currentCard({ ...FACTS, report: approved }, { ...APPROVAL, voidedAt: 1 }, 'en')).toEqual(outcomeCard(approved, 'en'));
    const posted = { ...REPORT, status: 'posted' as const };
    expect(currentCard({ ...FACTS, report: posted }, APPROVAL, 'en')).toEqual(outcomeCard(posted, 'en'));
  });
});

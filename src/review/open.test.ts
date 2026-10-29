// Unit tests for /open's list (src/review/open.ts; critical invariants 3 and
// 4), on node:sqlite with the D1 migrations: the open reports, oldest
// first, by id, platform, category, day and state, the start of one in its
// grace and "no card" for a pending report without one; never a URL, a
// comment or a reference; at most OPEN_LIST_LIMIT lines and how many more.
import { describe, expect, it } from 'vitest';
import { fakeClock } from '../../test/fakes/clock';
import { migratedDatabase } from '../../test/support/database';
import { hex, insertApproval, insertReport } from '../../test/support/review-rows';
import { sql } from '../db/sql';
import { t } from '../i18n/index';
import { outgoingLinkProblems } from '../platforms/link-policy';
import { OPEN_LIST_LIMIT, OPEN_STATUSES, openReportsText } from './open';

const DAY = Date.UTC(2027, 0, 15, 9);
const setup = () => migratedDatabase(fakeClock(DAY));

describe('openReportsText', () => {
  it('says so when nothing is open', async () => {
    const { db } = setup();
    await insertReport(db, { status: 'rejected' });
    expect(await openReportsText(db, 'en')).toBe(t('en', 'open.none'));
  });

  it('lists the open reports, oldest first, with their state, and nothing of their content', async () => {
    const { db } = setup();
    const pending = await insertReport(db, { created_at: DAY, platform: 'instagram', category: 'private_data', url: 'https://www.instagram.com/p/AbC123xyz', reporter_ref: hex(7) });
    const noCard = await insertReport(db, { created_at: DAY + 1, card_message_id: null });
    const approved = await insertReport(db, { created_at: DAY + 2, platform: 'telegram', category: 'impersonation' });
    await insertApproval(db, approved, { approvedAt: DAY + 3, startsAt: Date.UTC(2027, 0, 15, 10, 30) });
    await db.run(sql`UPDATE reports SET status = 'approved' WHERE id = ?`, [approved]);
    await insertReport(db, { created_at: DAY + 4, status: 'merged', merged_into: pending });
    await insertReport(db, { created_at: DAY + 5, status: 'routed' });
    const text = await openReportsText(db, 'en');
    expect(text).toBe(
      [
        t('en', 'open.title', { count: 3 }),
        t('en', 'open.line', { id: pending, platform: 'Instagram', category: t('en', 'review.category.private_data'), day: '2027-01-15', state: t('en', 'status.pending') }),
        t('en', 'open.line', { id: noCard, platform: 'X', category: t('en', 'review.category.harassment'), day: '2027-01-15', state: t('en', 'open.state.no_card') }),
        t('en', 'open.line', {
          id: approved,
          platform: 'Telegram',
          category: t('en', 'review.category.impersonation'),
          day: '2027-01-15',
          state: t('en', 'open.state.approved', { time: '2027-01-15 10:30 UTC' }),
        }),
      ].join('\n'),
    );
    for (const fragment of ['https://', 'instagram.com', 'a comment', hex(7)]) expect(text).not.toContain(fragment);
    expect(outgoingLinkProblems(text, [])).toEqual([]);
  });

  it('lists at most OPEN_LIST_LIMIT reports, and says how many more', async () => {
    const { db } = setup();
    for (let n = 0; n < OPEN_LIST_LIMIT + 2; n += 1) await insertReport(db, { created_at: DAY + n });
    const lines = (await openReportsText(db, 'fa')).split('\n');
    expect(lines).toHaveLength(OPEN_LIST_LIMIT + 2);
    expect(lines[0]).toBe(t('fa', 'open.title', { count: OPEN_LIST_LIMIT + 2 }));
    expect(lines.at(-1)).toBe(t('fa', 'open.more', { count: 2 }));
  });

  it("lists exactly the statuses of a report that is open, whose SQL list it matches", () => {
    expect(OPEN_STATUSES).toEqual(['pending', 'approved', 'posting', 'posted', 'closing', 'retracting']);
  });
});

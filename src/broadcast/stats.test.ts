// Unit tests for the counts (src/broadcast/stats.ts; critical invariants 3,
// 5 and 8), over the tick harness's fakes: the periods (a UTC month, this
// one, the one before, a `YYYY-MM` argument); the counts read from the
// aggregate rows alone, by the day of their finalization, by outcome,
// category and platform in a fixed order, the lines that are not zero, the
// presses labelled advisory; the monthly snapshot, the previous month's,
// to every keyholder in both locales and to the venue in its language,
// never to the venue under lockdown; /budget's counters of the day.
import { describe, expect, it } from 'vitest';
import { setLockdown } from '../auth/lockdown';
import { sql, type SqlDb } from '../db/sql';
import { AppError } from '../errors/app-error';
import { t } from '../i18n/index';
import { NON_MEMBER_COUNTER } from '../review/intake';
import { PRESS_COUNTER } from '../telegram/presses';
import { FAILURES } from '../../test/fakes/bot-api';
import { hex } from '../../test/support/review-rows';
import { tickHarness } from '../../test/support/tick-harness';
import { IDS } from '../../test/support/variables';
import { budgetText, currentMonth, monthPeriod, parseMonth, previousMonth, readStats, snapshot, statsAnswer, statsText } from './stats';

const OCTOBER = monthPeriod(2026, 9);

let nextId = 0;
/** An aggregate row of a report concluded on `closedDay`. */
const aggregate = async (db: SqlDb, closedDay: string, fields: { category?: string; platform?: string; outcome?: string | null; presses?: number } = {}) => {
  nextId += 1;
  const id = `${'s'.repeat(17)}${String.fromCharCode(97 + Math.floor(nextId / 676) % 26)}${String.fromCharCode(97 + Math.floor(nextId / 26) % 26)}${String.fromCharCode(97 + (nextId % 26))}`;
  await db.run(
    sql`INSERT INTO stats (report_id, category, platform, created_day, decided_day, closed_day, outcome, presses, link_hash) VALUES (?, ?, ?, '2026-09-01', '2026-09-02', ?, ?, ?, ?)`,
    [id, fields.category ?? 'harassment', fields.platform ?? 'x', closedDay, fields.outcome === undefined ? 'taken_down' : fields.outcome, fields.presses ?? 0, hex(nextId, 'c')],
  );
};

describe('the periods', () => {
  it('are UTC months: this one, the one before, across a year, and a YYYY-MM argument', () => {
    expect(OCTOBER).toEqual({ label: '2026-10', from: '2026-10-01', to: '2026-11-01' });
    expect(currentMonth(Date.UTC(2026, 9, 31, 23, 59))).toEqual(OCTOBER);
    expect(previousMonth(Date.UTC(2026, 10, 1, 6, 0))).toEqual(OCTOBER);
    expect(previousMonth(Date.UTC(2027, 0, 1, 6, 0))).toEqual({ label: '2026-12', from: '2026-12-01', to: '2027-01-01' });
    expect(parseMonth(' 2026-10 ')).toEqual(OCTOBER);
    for (const text of ['2026-13', '2026-1', '1999-12', '0050-01', 'october', '2026-10-01', '']) expect(parseMonth(text), text).toBeNull();
  });
});

describe('the counts', () => {
  it('are read from the aggregate rows of the period alone, by outcome, category and platform', async () => {
    const harness = tickHarness();
    await aggregate(harness.db, '2026-10-01', { outcome: 'taken_down', presses: 10 });
    await aggregate(harness.db, '2026-10-31', { outcome: 'retracted', category: 'private_data', platform: 'instagram', presses: 3 });
    await aggregate(harness.db, '2026-10-15', { outcome: 'routed', category: 'csam', platform: 'telegram' });
    await aggregate(harness.db, '2026-10-15', { outcome: null });
    await aggregate(harness.db, '2026-09-30', { outcome: 'rejected', presses: 99 });
    await aggregate(harness.db, '2026-11-01', { outcome: 'rejected', presses: 99 });
    const tally = await readStats(harness.db, OCTOBER);
    expect(tally.total).toBe(4);
    expect(tally.presses).toBe(13);
    expect(Object.fromEntries(tally.outcomes)).toEqual({ taken_down: 1, retracted: 1, routed: 1, closed: 1 });
    expect(Object.fromEntries(tally.categories)).toEqual({ harassment: 2, private_data: 1, csam: 1 });
    expect(Object.fromEntries(tally.platforms)).toEqual({ x: 2, instagram: 1, telegram: 1 });
  });

  it('read as a text: the title, the total, the non-zero lines in a fixed order, the presses labelled advisory', async () => {
    const harness = tickHarness();
    await aggregate(harness.db, '2026-10-02', { outcome: 'routed', category: 'csam', platform: 'telegram' });
    await aggregate(harness.db, '2026-10-03', { outcome: 'taken_down', presses: 5 });
    const text = statsText('en', await readStats(harness.db, OCTOBER), OCTOBER);
    const line = (name: string, count: number) => t('en', 'stats.line', { name, count });
    expect(text).toBe(
      [
        t('en', 'stats.title', { period: '2026-10' }),
        t('en', 'stats.total', { count: 2 }),
        '',
        t('en', 'stats.by_outcome'),
        line(t('en', 'review.outcome.taken_down'), 1),
        line(t('en', 'review.outcome.routed'), 1),
        '',
        t('en', 'stats.by_category'),
        line(t('en', 'review.category.csam'), 1),
        line(t('en', 'review.category.harassment'), 1),
        '',
        t('en', 'stats.by_platform'),
        line(t('en', 'platform.x'), 1),
        line(t('en', 'platform.telegram'), 1),
        '',
        t('en', 'stats.presses', { count: 5 }),
      ].join('\n'),
    );
    expect(await statsAnswer(harness.db, 'fa', monthPeriod(2026, 8))).toBe([t('fa', 'stats.title', { period: '2026-09' }), t('fa', 'stats.none')].join('\n'));
  });
});

describe('the monthly snapshot', () => {
  it("sends the previous month's counts to every keyholder in both locales and to the venue in its language", async () => {
    const harness = tickHarness();
    await aggregate(harness.db, '2026-10-20', { outcome: 'no_result', presses: 2 });
    await snapshot(harness.deps, Date.UTC(2026, 10, 1, 6, 0));
    const sends = harness.telegram.callsOf('sendMessage');
    expect(sends.map((call) => call.chatId)).toEqual([IDS.keyholder, IDS.secondKeyholder, IDS.adminChat]);
    const tally = await readStats(harness.db, OCTOBER);
    expect(sends[0]?.payload.text).toBe(`${statsText('fa', tally, OCTOBER, 'stats.snapshot_title')}\n\n${statsText('en', tally, OCTOBER, 'stats.snapshot_title')}`);
    expect(sends[2]?.payload.text).toBe(statsText(harness.config.venueLocale, tally, OCTOBER, 'stats.snapshot_title'));
    expect(harness.log.records()).toEqual([{ level: 'info', event: 'snapshot.sent', count: 1, sent: 2, failed: 0 }]);
  });

  it('is never posted to the venue under lockdown, and a send that fails is logged by class', async () => {
    const harness = tickHarness();
    await setLockdown(harness.db, harness.clock);
    harness.telegram.fail({ chatId: IDS.secondKeyholder }, FAILURES.botBlocked);
    await snapshot(harness.deps, Date.UTC(2026, 10, 1, 6, 0));
    expect(harness.telegram.callsOf('sendMessage').map((call) => call.chatId)).toEqual([IDS.keyholder, IDS.secondKeyholder]);
    expect(harness.log.records().map((record) => record.event)).toEqual(['alert.failed', 'snapshot.sent']);
  });

  it('lets a storage failure through, for the run to stop on, sending nothing', async () => {
    const harness = tickHarness({ store: (db) => ({ ...db, all: () => Promise.reject(new AppError('STORAGE_FAILURE', 'down')) }) });
    await expect(snapshot(harness.deps, Date.UTC(2026, 10, 1, 6))).rejects.toMatchObject({ code: 'STORAGE_FAILURE' });
    expect(harness.telegram.calls).toEqual([]);
  });
});

describe('/budget', () => {
  it("reads the day's counters: the presses against MARKS_PER_DAY, the non-member reports against their cap", async () => {
    const harness = tickHarness();
    const day = '2027-01-15';
    await harness.db.run(sql`INSERT INTO counters (day, key, count) VALUES (?, ?, 7), (?, ?, 2), ('2027-01-14', ?, 50)`, [day, PRESS_COUNTER, day, NON_MEMBER_COUNTER, PRESS_COUNTER]);
    expect(await budgetText(harness.deps, Date.UTC(2027, 0, 15, 12), 'en')).toBe(
      t('en', 'budget.text', { day, presses: 7, pressCap: harness.config.marksPerDay, nonMembers: 2, nonMemberCap: 20 }),
    );
    expect(await budgetText(harness.deps, Date.UTC(2027, 0, 16), 'en')).toBe(
      t('en', 'budget.text', { day: '2027-01-16', presses: 0, pressCap: harness.config.marksPerDay, nonMembers: 0, nonMemberCap: 20 }),
    );
  });
});

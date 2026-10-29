// Unit tests for the scheduler's alerts (src/broadcast/report-alerts.ts;
// critical invariants 2, 4 and 5): to every keyholder in both locales,
// Persian first, and to the venue in its language unless the bot is locked
// down; a venue alert that fails stops nothing; the reports marked alerted
// only as asked, never twice, never past D1's parameter bound.
import { describe, expect, it } from 'vitest';
import { setLockdown } from '../auth/lockdown';
import { sql } from '../db/sql';
import { t } from '../i18n/index';
import { createBotApi } from '../telegram/api';
import { FAILURES } from '../../test/fakes/bot-api';
import { botHarness } from '../../test/support/bot-harness';
import { insertReport } from '../../test/support/review-rows';
import { IDS } from '../../test/support/variables';
import { alertEveryone, inBothLocales, MARK_LIMIT, markAlerted, type ReportAlertDeps } from './report-alerts';

const ID = 'abcdefghijklmnopqrst';

const setup = (variables: Readonly<Record<string, string>> = {}) => {
  const harness = botHarness({ variables });
  const deps: ReportAlertDeps = { api: createBotApi(harness.config, harness.telegram.fetch), config: harness.config, db: harness.db, logger: harness.log.logger };
  return { harness, deps };
};

const render = (locale: 'fa' | 'en') => t(locale, 'alert.post_unknown', { id: ID });

describe('alertEveryone', () => {
  it('sends every keyholder both locales, Persian first, and the venue its own', async () => {
    const { harness, deps } = setup({ VENUE_LOCALE: 'en' });
    const outcome = await alertEveryone(deps, render, true);
    expect(outcome).toMatchObject({ sent: 2, failed: 0 });
    const both = `${render('fa')}\n\n${render('en')}`;
    expect(inBothLocales(render)).toBe(both);
    expect(harness.textsTo(IDS.keyholder)).toEqual([both]);
    expect(harness.textsTo(IDS.secondKeyholder)).toEqual([both]);
    expect(harness.textsTo(IDS.adminChat)).toEqual([render('en')]);
  });

  it('sends the venue nothing when not asked, or under lockdown', async () => {
    const { harness, deps } = setup();
    await alertEveryone(deps, render, false);
    await setLockdown(harness.db, harness.clock);
    await alertEveryone(deps, render, true);
    expect(harness.textsTo(IDS.adminChat)).toEqual([]);
    expect(harness.textsTo(IDS.keyholder)).toHaveLength(2);
  });

  it('counts a keyholder it missed, and a failed venue alert stops nothing', async () => {
    const { harness, deps } = setup();
    harness.telegram.fail({ chatId: IDS.secondKeyholder }, FAILURES.botBlocked);
    harness.telegram.fail({ chatId: IDS.adminChat }, FAILURES.serverError);
    expect(await alertEveryone(deps, render, true)).toMatchObject({ sent: 1, failed: 1 });
    expect(harness.log.records().map((record) => record.event)).toEqual(['alert.failed', 'alert.failed']);
  });
});

describe('markAlerted', () => {
  it('marks the reports named, once', async () => {
    const { harness } = setup();
    const first = await insertReport(harness.db);
    const second = await insertReport(harness.db);
    const other = await insertReport(harness.db);
    expect(await markAlerted(harness.db, [first, second], 7)).toBe(2);
    expect(await markAlerted(harness.db, [first], 9)).toBe(0);
    expect(await markAlerted(harness.db, [], 9)).toBe(0);
    expect(await harness.db.all(sql`SELECT id, alert_sent_at FROM reports ORDER BY alert_sent_at, id`)).toEqual(
      [
        { id: other, alert_sent_at: null },
        ...[first, second].sort().map((id) => ({ id, alert_sent_at: 7 })),
      ],
    );
  });

  it('names at most MARK_LIMIT reports in one statement, within the parameter bound', async () => {
    const { harness } = setup();
    const ids = Array.from({ length: MARK_LIMIT + 5 }, (_, n) => `${'q'.repeat(18)}${String.fromCharCode(97 + Math.floor(n / 26))}${String.fromCharCode(97 + (n % 26))}`);
    expect(await markAlerted(harness.db, ids, 1)).toBe(0);
    expect(MARK_LIMIT + 1).toBeLessThanOrEqual(100);
  });
});

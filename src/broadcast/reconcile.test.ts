// Unit tests for reconciliation (src/broadcast/reconcile.ts; critical
// invariants 1, 5 and 8), with planted rows on node:sqlite and the fake Bot
// API: each branch (a stuck post, an overdue post job, a missing edit job,
// an unfinalized terminal row, the needs-attention alert), each alerted
// exactly once, a keyholder it missed alerted again by the next run, the
// venue left out under lockdown, every step bounded.
import { describe, expect, it } from 'vitest';
import { setLockdown } from '../auth/lockdown';
import { sql, type SqlDb } from '../db/sql';
import { t } from '../i18n/index';
import { FAILURES } from '../../test/fakes/bot-api';
import { insertReport, reportRow } from '../../test/support/review-rows';
import { plantApproved, TICK_AT, tickHarness, type TickHarness } from '../../test/support/tick-harness';
import { IDS } from '../../test/support/variables';
import { TELEGRAM_TEXT_LIMIT, visibleLength } from '../review/render-post';
import { POSTING_WINDOW_MS } from './post';
import { ALERT_LIMIT, attentionText, FINALIZE_LIMIT, OVERDUE_POST_MS, reconcile, REENQUEUE_LIMIT } from './reconcile';
import { readTickState } from './state';

/** The next reconciliation minute after the harness's start. */
const AT = Date.UTC(2027, 0, 15, 12, 15);

const run = async (harness: TickHarness, at: number = AT) => {
  harness.clock.set(at);
  return reconcile(harness.deps, at, await readTickState(harness.config, harness.db));
};

/** A report posting without a message id since `startedAt`, its job present. */
const posting = async (harness: TickHarness, startedAt: number): Promise<string> => {
  const planted = await plantApproved(harness, { startsAt: startedAt - 1_000 });
  await harness.db.run(sql`UPDATE reports SET status = 'posting', posting_started_at = ? WHERE id = ?`, [startedAt, planted.reportId]);
  return planted.reportId;
};

const flags = async (db: SqlDb, id: string) => {
  const row = await reportRow(db, id);
  return { needs_attention: row?.needs_attention, alert_sent_at: row?.alert_sent_at };
};

describe('a stuck post', () => {
  it('is a report posting without a message id past its window: flagged and alerted once, to the keyholders and the venue', async () => {
    const harness = tickHarness();
    const stuck = await posting(harness, AT - POSTING_WINDOW_MS);
    const inProgress = await posting(harness, AT - POSTING_WINDOW_MS + 1_000);
    expect(await run(harness)).toMatchObject({ flagged: 1, alerted: 1, delivered: true });
    expect(await flags(harness.db, stuck)).toEqual({ needs_attention: 1, alert_sent_at: AT });
    expect(await flags(harness.db, inProgress)).toEqual({ needs_attention: 0, alert_sent_at: null });
    const digest = (locale: 'fa' | 'en') => attentionText(locale, [{ id: stuck, status: 'posting' }]);
    expect(harness.textsTo(IDS.keyholder)).toEqual([`${digest('fa')}\n\n${digest('en')}`]);
    expect(harness.textsTo(IDS.secondKeyholder)).toEqual([`${digest('fa')}\n\n${digest('en')}`]);
    expect(harness.textsTo(IDS.adminChat)).toEqual([digest(harness.config.venueLocale)]);
    // Once: the next run says nothing more.
    expect(await run(harness, AT + 15 * 60_000)).toMatchObject({ alerted: 1 });
    expect(harness.textsTo(IDS.keyholder)).toHaveLength(2);
  });
});

describe('an overdue post job', () => {
  it('is flagged once overdue by two reconciliation periods, and not before', async () => {
    const harness = tickHarness();
    const overdue = await plantApproved(harness, { startsAt: AT - OVERDUE_POST_MS });
    const late = await plantApproved(harness, { startsAt: AT - OVERDUE_POST_MS + 1 });
    await run(harness);
    expect((await flags(harness.db, overdue.reportId)).needs_attention).toBe(1);
    expect((await flags(harness.db, late.reportId)).needs_attention).toBe(0);
    expect(harness.textsTo(IDS.keyholder)[0]).toContain(t('en', 'alert.attention.approved', { id: overdue.reportId }));
  });

  it.each([
    ['halted', { key: 'halted', value: 1 }],
    ['paused', { key: 'paused_until', value: AT + 60_000 }],
    ['locked down by the switch', { key: 'lockdown', value: 1 }],
  ])('is not flagged while %s: the hold explains it', async (_label, row) => {
    const harness = tickHarness();
    const overdue = await plantApproved(harness, { startsAt: AT - 2 * OVERDUE_POST_MS });
    await harness.db.run(sql`INSERT INTO meta (key, value) VALUES (?, ?)`, [row.key, row.value]);
    await run(harness);
    expect((await flags(harness.db, overdue.reportId)).needs_attention).toBe(0);
  });

  it('is not flagged under the LOCKDOWN override', async () => {
    const harness = tickHarness({ variables: { LOCKDOWN: '1' } });
    const overdue = await plantApproved(harness, { startsAt: AT - 2 * OVERDUE_POST_MS });
    await run(harness);
    expect((await flags(harness.db, overdue.reportId)).needs_attention).toBe(0);
  });
});

describe('a missing edit job', () => {
  it('is re-enqueued for a report closing or retracting, its action by the status, at most REENQUEUE_LIMIT a run', async () => {
    const harness = tickHarness();
    const closing = await insertReport(harness.db, { status: 'closing' });
    const retracting = await insertReport(harness.db, { status: 'retracting' });
    const posted = await insertReport(harness.db, { status: 'posted', posting_started_at: AT - 9_000, posted_at: AT - 8_000, post_message_id: 77 });
    expect(await run(harness)).toMatchObject({ reenqueued: 2 });
    expect(await harness.db.all(sql`SELECT report_id, kind, due_at, json_extract(payload, '$.action') AS action FROM jobs ORDER BY report_id`)).toEqual(
      [
        { report_id: closing, kind: 'edit', due_at: AT, action: 'close' },
        { report_id: retracting, kind: 'edit', due_at: AT, action: 'retract' },
      ].sort((a, b) => a.report_id.localeCompare(b.report_id)),
    );
    expect(await harness.db.all(sql`SELECT * FROM jobs WHERE report_id = ?`, [posted])).toEqual([]);
    // A job present is left as it is.
    await harness.db.run(sql`UPDATE jobs SET attempts = 3`);
    expect(await run(harness, AT + 15 * 60_000)).toMatchObject({ reenqueued: 0 });
    expect(await harness.db.all(sql`SELECT attempts FROM jobs`)).toEqual([{ attempts: 3 }, { attempts: 3 }]);
    expect(harness.log.records()).toEqual([{ level: 'info', event: 'reconcile.reenqueued', count: 2 }]);
    expect(REENQUEUE_LIMIT).toBeGreaterThan(0);
  });

  it('never finalizes a report closing or retracting', async () => {
    const finalized: string[] = [];
    const harness = tickHarness({
      hooks: {
        finalize: (_deps, id) => {
          finalized.push(id);
          return Promise.resolve();
        },
      },
    });
    await insertReport(harness.db, { status: 'closing' });
    await insertReport(harness.db, { status: 'retracting' });
    await run(harness);
    expect(finalized).toEqual([]);
  });
});

describe('a terminal report whose finalization never landed', () => {
  it('is finalized: closed, retracted and expired rows, never rejected, routed or finalized ones, at most FINALIZE_LIMIT a run', async () => {
    const finalized: string[] = [];
    const harness = tickHarness({
      hooks: {
        finalize: (_deps, id) => {
          finalized.push(id);
          return Promise.resolve();
        },
      },
    });
    const due = [];
    for (const status of ['closed', 'retracted', 'expired']) due.push(await insertReport(harness.db, { status }));
    for (const status of ['rejected', 'routed']) await insertReport(harness.db, { status });
    const done = await insertReport(harness.db, { status: 'closed' });
    await harness.db.run(sql`UPDATE reports SET data_deleted_at = 1 WHERE id = ?`, [done]);
    expect(await run(harness)).toMatchObject({ finalized: 3 });
    expect(finalized.sort()).toEqual(due.sort());
    for (let n = 0; n < FINALIZE_LIMIT + 2; n += 1) await insertReport(harness.db, { status: 'expired' });
    finalized.length = 0;
    await run(harness, AT + 15 * 60_000);
    expect(finalized).toHaveLength(FINALIZE_LIMIT);
  });

  it('logs a finalization that fails by class, and goes on', async () => {
    const harness = tickHarness({ hooks: { finalize: () => Promise.reject(new Error('the batch failed')) } });
    const id = await insertReport(harness.db, { status: 'retracted' });
    expect(await run(harness)).toMatchObject({ finalized: 0 });
    expect(harness.log.records()).toEqual([{ level: 'error', event: 'finalize.failed', reportId: id, errorClass: 'Error' }]);
  });
});

describe('the needs-attention alert', () => {
  it('names at most ALERT_LIMIT reports, in one message; the rest go in the next run', async () => {
    const harness = tickHarness();
    const ids: string[] = [];
    for (let n = 0; n < ALERT_LIMIT + 2; n += 1) ids.push(await posting(harness, AT - 10 * 60_000));
    expect(await run(harness)).toMatchObject({ alerted: ALERT_LIMIT, delivered: true });
    expect(harness.telegram.messagesIn(IDS.keyholder)).toHaveLength(1);
    expect(await run(harness, AT + 15 * 60_000)).toMatchObject({ alerted: 2 });
    for (const id of ids) expect((await flags(harness.db, id)).alert_sent_at).not.toBeNull();
  });

  it('fits Telegram in both locales at its bound, for the longest lines', () => {
    const reports = Array.from({ length: ALERT_LIMIT }, (_, n) => ({ id: `${'q'.repeat(19)}${String.fromCharCode(97 + n)}`, status: 'approved' as const }));
    const both = `${attentionText('fa', reports)}\n\n${attentionText('en', reports)}`;
    expect(visibleLength(both)).toBeLessThan(TELEGRAM_TEXT_LIMIT);
  });

  it('marks the reports once one keyholder got the alert, the miss logged with its counts, so the next run names the next ones', async () => {
    const harness = tickHarness();
    const ids: string[] = [];
    for (let n = 0; n < ALERT_LIMIT + 1; n += 1) ids.push(await posting(harness, AT - 10 * 60_000));
    // One keyholder unreachable on every call: blocked the bot, or never sent /start.
    harness.telegram.fail({ chatId: IDS.secondKeyholder }, FAILURES.botBlocked);
    expect(await run(harness)).toMatchObject({ alerted: ALERT_LIMIT, delivered: true });
    expect(await run(harness, AT + 15 * 60_000)).toMatchObject({ alerted: 1, delivered: true });
    for (const id of ids) expect((await flags(harness.db, id)).alert_sent_at, id).not.toBeNull();
    expect(await run(harness, AT + 30 * 60_000)).toMatchObject({ alerted: 0 });
    expect(harness.telegram.messagesIn(IDS.keyholder)).toHaveLength(2);
    expect(harness.log.records().filter((record) => record.event === 'reconcile.alert_incomplete')).toEqual([
      { level: 'info', event: 'reconcile.alert_incomplete', count: ALERT_LIMIT, sent: 1, failed: 1 },
      { level: 'info', event: 'reconcile.alert_incomplete', count: 1, sent: 1, failed: 1 },
    ]);
  });

  it('marks nothing when the alert reached no keyholder, so the next run sends it again', async () => {
    const harness = tickHarness();
    const stuck = await posting(harness, AT - 10 * 60_000);
    for (const keyholder of [IDS.keyholder, IDS.secondKeyholder]) harness.telegram.fail({ chatId: keyholder }, FAILURES.cantInitiateConversation, 1);
    expect(await run(harness)).toMatchObject({ alerted: 1, delivered: false });
    expect((await flags(harness.db, stuck)).alert_sent_at).toBeNull();
    expect(await run(harness, AT + 15 * 60_000)).toMatchObject({ alerted: 1, delivered: true });
    expect(harness.telegram.messagesIn(IDS.secondKeyholder)).toHaveLength(1);
    expect(harness.log.records().map((record) => record.event)).toEqual(['alert.failed', 'alert.failed', 'reconcile.alert_incomplete', 'reconcile.alerted']);
  });

  it('goes to the keyholders only under lockdown', async () => {
    const harness = tickHarness();
    await posting(harness, AT - 10 * 60_000);
    await setLockdown(harness.db, harness.clock);
    await run(harness);
    expect(harness.textsTo(IDS.keyholder)).toHaveLength(1);
    expect(harness.textsTo(IDS.adminChat)).toEqual([]);
  });

  it('names a report whose edit failed by its state', async () => {
    const harness = tickHarness();
    const id = await insertReport(harness.db, { status: 'retracting' });
    await harness.db.run(sql`UPDATE reports SET needs_attention = 1 WHERE id = ?`, [id]);
    await run(harness);
    expect(harness.textsTo(IDS.adminChat)[0]).toContain(
      t(harness.config.venueLocale, 'alert.attention.edit', { id, state: t(harness.config.venueLocale, 'status.retracting') }),
    );
  });

  it('runs on the 15th minutes, never at another minute', async () => {
    const harness = tickHarness();
    await posting(harness, TICK_AT - 10 * 60_000);
    harness.clock.set(TICK_AT + 60_000);
    expect((await harness.run(TICK_AT + 60_000)).ran).toEqual([]);
    expect(harness.telegram.count('sendMessage')).toBe(0);
    harness.clock.set(AT);
    expect((await harness.run(AT)).ran).toEqual(['reconcile']);
    expect(harness.telegram.messagesIn(IDS.keyholder)).toHaveLength(1);
  });
});

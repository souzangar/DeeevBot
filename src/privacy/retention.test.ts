// Unit tests for the retention job (src/privacy/retention.ts; critical
// invariant 8 above all, and 1, 2 and 5), over the tick harness's fakes and
// its counted store, one case per path of the deletion schedule, each with
// its statement count pinned: drafts after 24 hours; prompts after 24 hours,
// their messages within the 48 hours deleted from their chats, at most
// PROMPT_MESSAGES_PER_RUN, the venue's not under lockdown; jobs abandoned at
// 20 attempts, flagged and alerted, nothing finalized; posted reports set to
// expire at 90 days, never while locked down or halted, the next night
// without a hold catching up; pending reports expired at 30 days and rejected and
// routed rows finalized 30 days after their decision, in one batch, at most
// FINALIZE_PER_RUN, an expired pending report's card edited to its outcome;
// finalized rows deleted; idle reporter counters but blocked ones, and old
// daily counters, deleted; a failing step logged by class with the next one
// run, and a storage failure stopping the job.
import { describe, expect, it } from 'vitest';
import { setLockdown } from '../auth/lockdown';
import { sql, type SqlDb, type SqlText } from '../db/sql';
import { AppError } from '../errors/app-error';
import { t } from '../i18n/index';
import { createPrompt } from '../review/prompts';
import { outcomeCard } from '../review/card';
import { hex, insertApproval, insertReport, reportRow } from '../../test/support/review-rows';
import { tickHarness, type TickHarness } from '../../test/support/tick-harness';
import { IDS } from '../../test/support/variables';
import { abandonedText, ABANDON_PER_RUN, FINALIZE_PER_RUN, PROMPT_MESSAGES_PER_RUN, retention } from './retention';

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** The run: 2027-04-20 00:15 UTC. */
const RUN = Date.UTC(2027, 3, 20, 0, 15);
/** A run with nothing to do: the read of the holds, then the steps' reads and deletes. */
const QUIET = 10;

const at = (harness: TickHarness) => {
  harness.clock.set(RUN);
  harness.reset();
  return harness;
};

const run = (harness: TickHarness) => retention(harness.deps, RUN);

let next = 0;
const someId = (): string => {
  next += 1;
  return `${'r'.repeat(17)}${String.fromCharCode(97 + (Math.floor(next / 676) % 26))}${String.fromCharCode(97 + (Math.floor(next / 26) % 26))}${String.fromCharCode(97 + (next % 26))}`;
};

/** A posted report under a live approval, posted at `postedAt`. */
const postedAt = async (db: SqlDb, postedAtMs: number, messageId: number): Promise<string> => {
  const reportId = await insertReport(db, { status: 'posted', created_at: postedAtMs - DAY, posting_started_at: postedAtMs, posted_at: postedAtMs, post_message_id: messageId, broadcast_text: 'the post' });
  await insertApproval(db, reportId, { approvedAt: postedAtMs - HOUR, startsAt: postedAtMs - HOUR / 2 });
  return reportId;
};

const ids = (rows: readonly { readonly id?: unknown; readonly report_id?: unknown }[]) => rows.map((row) => row.id ?? row.report_id).sort();

describe('the retention job, with nothing to do', () => {
  it('issues ten statements and no call, nine under the switch or /halt, eight under the override, and logs its counts', async () => {
    const harness = at(tickHarness());
    expect(await run(harness)).toEqual({ drafts: 0, prompts: 0, abandoned: 0, expiring: 0, finalized: 0, removed: 0, reporterRows: 0, counterRows: 0 });
    expect(harness.tally.queries).toBe(QUIET);
    expect(harness.telegram.calls).toEqual([]);
    expect(harness.log.records()).toEqual([
      { level: 'info', event: 'retention.done', drafts: 0, prompts: 0, abandoned: 0, expiring: 0, finalized: 0, removed: 0, reporterRows: 0, counterRows: 0 },
    ]);
    for (const key of ['lockdown', 'halted'] as const) {
      const held = tickHarness();
      await held.db.run(sql`INSERT INTO meta (key, value) VALUES (?, 1)`, [key]);
      at(held);
      await run(held);
      // The expiry reads nothing while held.
      expect(held.tally.queries, key).toBe(QUIET - 1);
    }
    const overridden = at(tickHarness({ variables: { LOCKDOWN: '1' } }));
    await run(overridden);
    // No read of the holds, and none for the expiry.
    expect(overridden.tally.queries).toBe(QUIET - 2);
  });
});

describe('the deletion paths', () => {
  it('deletes the drafts created more than 24 hours ago', async () => {
    const harness = tickHarness();
    const draft = sql`INSERT INTO drafts (draft_key, step, locale, created_at, updated_at) VALUES (?, 'comment', 'en', ?, ?)`;
    await harness.db.run(draft, [hex(1), RUN - DAY, RUN - HOUR]);
    await harness.db.run(draft, [hex(2), RUN - DAY + 1, RUN - DAY + 1]);
    at(harness);
    expect((await run(harness)).drafts).toBe(1);
    expect(await harness.db.all(sql`SELECT draft_key FROM drafts`)).toEqual([{ draft_key: hex(2) }]);
    expect(harness.tally.queries).toBe(QUIET);
  });

  it('deletes the prompts created more than 24 hours ago, their messages within the 48 hours too, at most PROMPT_MESSAGES_PER_RUN', async () => {
    const harness = tickHarness();
    const reportId = await insertReport(harness.db, { created_at: RUN - DAY });
    const prompt = async (chatId: number, messageId: number, ageMs: number) => {
      harness.telegram.seedMessage(chatId, { message_id: messageId, text: 'a prompt' });
      await createPrompt(harness.db, { chatId, promptMessageId: messageId, adminId: chatId === IDS.adminChat ? IDS.admin : chatId, reportId, kind: 'retraction', category: null, linkMode: null, createdAt: RUN - ageMs });
    };
    await prompt(IDS.adminChat, 1, 25 * HOUR);
    await prompt(IDS.keyholder, 2, 30 * HOUR);
    await prompt(IDS.adminChat, 3, 49 * HOUR);
    await prompt(IDS.adminChat, 4, 23 * HOUR);
    at(harness);
    expect((await run(harness)).prompts).toBe(3);
    expect(await harness.db.all(sql`SELECT prompt_message_id FROM admin_prompts`)).toEqual([{ prompt_message_id: 4 }]);
    expect(harness.telegram.callsOf('deleteMessage').map((call) => [call.chatId, call.payload.message_id]).sort()).toEqual(
      [
        [IDS.keyholder, 2],
        [IDS.adminChat, 1],
      ].sort(),
    );
    expect(harness.tally.queries).toBe(QUIET);
    const many = tickHarness();
    const other = await insertReport(many.db, { created_at: RUN - DAY });
    for (let n = 0; n < PROMPT_MESSAGES_PER_RUN + 3; n += 1) {
      await createPrompt(many.db, { chatId: IDS.keyholder, promptMessageId: 100 + n, adminId: IDS.keyholder, reportId: other, kind: 'retraction', category: null, linkMode: null, createdAt: RUN - 30 * HOUR });
    }
    at(many);
    expect((await run(many)).prompts).toBe(PROMPT_MESSAGES_PER_RUN + 3);
    expect(many.telegram.count('deleteMessage')).toBe(PROMPT_MESSAGES_PER_RUN);
  });

  it('abandons the jobs that failed 20 times: deleted, their reports flagged and alerted once, nothing finalized', async () => {
    const harness = tickHarness();
    const closing = await postedAt(harness.db, RUN - 10 * DAY, 31);
    await harness.db.run(sql`UPDATE reports SET status = 'closing', outcome = 'taken_down' WHERE id = ?`, [closing]);
    const approved = await insertReport(harness.db, { created_at: RUN - DAY });
    await insertApproval(harness.db, approved);
    await harness.db.run(sql`UPDATE reports SET status = 'approved' WHERE id = ?`, [approved]);
    const job = sql`INSERT INTO jobs (id, kind, report_id, due_at, payload, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, 1)`;
    await harness.db.run(job, [someId(), 'edit', closing, RUN, '{"action":"close"}', 20]);
    await harness.db.run(job, [someId(), 'post', approved, RUN, '{"approval_id":"abcdefghijklmnopqrst"}', 19]);
    at(harness);
    expect((await run(harness)).abandoned).toBe(1);
    expect(await harness.db.all(sql`SELECT report_id, attempts FROM jobs`)).toEqual([{ report_id: approved, attempts: 19 }]);
    expect(await reportRow(harness.db, closing)).toMatchObject({ status: 'closing', needs_attention: 1, alert_sent_at: RUN, post_message_id: 31, data_deleted_at: null });
    const text = abandonedText('fa', [{ reportId: closing, status: 'closing' }]);
    expect(harness.telegram.callsOf('sendMessage').map((call) => call.chatId)).toEqual([IDS.keyholder, IDS.secondKeyholder, IDS.adminChat]);
    expect(String(harness.telegram.callsOf('sendMessage')[0]?.payload.text)).toContain(text);
    expect(abandonedText('en', [{ reportId: closing, status: 'closing' }])).toContain(t('en', 'alert.abandoned.line', { id: closing, state: t('en', 'status.closing') }));
    // The batch, the venue's lockdown read, the mark.
    expect(harness.tally.queries).toBe(QUIET + 3);
  });

  it('abandons at most ABANDON_PER_RUN jobs a run', async () => {
    const harness = tickHarness();
    for (let n = 0; n < ABANDON_PER_RUN + 2; n += 1) {
      const reportId = await insertReport(harness.db, { status: 'retracting', created_at: RUN - DAY, posting_started_at: 1, posted_at: 2, post_message_id: 200 + n });
      await harness.db.run(sql`INSERT INTO jobs (id, kind, report_id, due_at, payload, attempts, created_at) VALUES (?, 'edit', ?, ?, '{"action":"retract"}', 25, 1)`, [someId(), reportId, RUN - n]);
    }
    at(harness);
    expect((await run(harness)).abandoned).toBe(ABANDON_PER_RUN);
    expect(await harness.db.all(sql`SELECT id FROM jobs`)).toHaveLength(2);
  });

  it('sets the posted reports 90 days old to expire, with their edit jobs, and no younger one', async () => {
    const harness = tickHarness();
    const old = await postedAt(harness.db, RUN - 90 * DAY, 41);
    const young = await postedAt(harness.db, RUN - 90 * DAY + 1, 42);
    at(harness);
    expect((await run(harness)).expiring).toBe(1);
    expect(await reportRow(harness.db, old)).toMatchObject({ status: 'closing', outcome: 'expired', post_message_id: 41 });
    expect(await harness.db.all(sql`SELECT report_id, json_extract(payload, '$.action') AS action FROM jobs`)).toEqual([{ report_id: old, action: 'close' }]);
    expect(await reportRow(harness.db, young)).toMatchObject({ status: 'posted' });
    expect(harness.tally.queries).toBe(QUIET + 1);
  });

  it('lets the expiry wait under lockdown (either layer) and under /halt, and catches up the next night without a hold', async () => {
    for (const hold of ['switch', 'override', 'halted'] as const) {
      const harness = tickHarness(hold === 'override' ? { variables: { LOCKDOWN: '1' } } : {});
      const old = await postedAt(harness.db, RUN - 120 * DAY, 43);
      if (hold === 'switch') await setLockdown(harness.db, harness.clock);
      if (hold === 'halted') await harness.db.run(sql`INSERT INTO meta (key, value) VALUES ('halted', 1)`);
      at(harness);
      expect((await run(harness)).expiring, hold).toBe(0);
      expect(await reportRow(harness.db, old), hold).toMatchObject({ status: 'posted', outcome: null });
      expect(await harness.db.all(sql`SELECT * FROM jobs`), hold).toEqual([]);
      if (hold === 'override') continue;
      // The hold lifted, the next night catches up: the cut-off is the post's own time.
      await harness.db.run(sql`DELETE FROM meta WHERE key IN ('lockdown', 'halted')`);
      harness.clock.set(RUN + DAY);
      expect((await retention(harness.deps, RUN + DAY)).expiring, hold).toBe(1);
      expect(await reportRow(harness.db, old), hold).toMatchObject({ status: 'closing', outcome: 'expired' });
    }
  });

  it('expires the pending reports 30 days old as no decision, finalizes them in D1 alone with their card edited, and deletes them', async () => {
    const harness = tickHarness();
    const old = await insertReport(harness.db, { created_at: RUN - 30 * DAY, card_message_id: 51 });
    await insertReport(harness.db, { status: 'merged', merged_into: old, created_at: RUN - 29 * DAY, comment: null, affected_person: null });
    const young = await insertReport(harness.db, { created_at: RUN - 30 * DAY + 1, card_message_id: 52 });
    harness.telegram.seedMessage(IDS.adminChat, { message_id: 51, text: 'the card, with the links' });
    at(harness);
    const counts = await run(harness);
    expect(counts).toMatchObject({ finalized: 1, removed: 1 });
    expect(await reportRow(harness.db, old)).toBeNull();
    expect(await harness.db.all(sql`SELECT report_id, outcome, decided_day FROM stats`)).toEqual([{ report_id: old, outcome: 'no_decision', decided_day: null }]);
    expect(await reportRow(harness.db, young)).toMatchObject({ status: 'pending', url: 'https://x.com/someone/status/1234567890' });
    expect(await harness.db.all(sql`SELECT id FROM reports`)).toEqual([{ id: young }]);
    expect(harness.telegram.messageIn(IDS.adminChat, 51)?.text).toBe(outcomeCard({ id: old, status: 'expired' }, harness.config.venueLocale).text);
    // The batch, the read of what expired.
    expect(harness.tally.queries).toBe(QUIET + 2);
  });

  it('finalizes the rejected and routed rows 30 days after their decision, a rejection counted off, and deletes them', async () => {
    const harness = tickHarness();
    const rejected = await insertReport(harness.db, { status: 'rejected', reporter_ref: hex(7), created_at: RUN - 40 * DAY, decided_at: RUN - 30 * DAY, decided_by: IDS.admin, card_message_id: null });
    const routed = await insertReport(harness.db, { status: 'routed', category: 'csam', url: null, account_url: null, created_at: RUN - 40 * DAY, decided_at: RUN - 30 * DAY - 1, decided_by: IDS.admin, card_message_id: null });
    const recent = await insertReport(harness.db, { status: 'rejected', created_at: RUN - 40 * DAY, decided_at: RUN - 30 * DAY + 1, decided_by: IDS.admin, card_message_id: null });
    // Active this month, so the idle step leaves it.
    await harness.db.run(sql`INSERT INTO reporter_stats (reporter_ref, open_count, day, day_count, rejections_30d, blocked, last_seen) VALUES (?, 0, '2027-04-01', 1, 3, 0, '2027-04-01')`, [hex(7)]);
    at(harness);
    expect(await run(harness)).toMatchObject({ finalized: 2, removed: 2 });
    expect(ids(await harness.db.all(sql`SELECT report_id FROM stats`))).toEqual([rejected, routed].sort());
    expect(await harness.db.all(sql`SELECT outcome FROM stats WHERE report_id = ?`, [routed])).toEqual([{ outcome: 'routed' }]);
    expect(await harness.db.all(sql`SELECT id FROM reports`)).toEqual([{ id: recent }]);
    expect(await harness.db.all(sql`SELECT rejections_30d FROM reporter_stats WHERE reporter_ref = ?`, [hex(7)])).toEqual([{ rejections_30d: 2 }]);
    expect(harness.telegram.calls).toEqual([]);
    expect(harness.tally.queries).toBe(QUIET + 1);
  });

  it('finalizes at most FINALIZE_PER_RUN reports a run, the oldest first, and the rest the next night', async () => {
    const harness = tickHarness();
    for (let n = 0; n < FINALIZE_PER_RUN + 10; n += 1) await insertReport(harness.db, { created_at: RUN - 31 * DAY - n * 1_000, card_message_id: null });
    at(harness);
    expect((await run(harness)).finalized).toBe(FINALIZE_PER_RUN);
    expect(await harness.db.all(sql`SELECT id FROM reports`)).toHaveLength(10);
    harness.clock.set(RUN + DAY);
    expect((await retention(harness.deps, RUN + DAY)).finalized).toBe(10);
    expect(await harness.db.all(sql`SELECT id FROM reports`)).toEqual([]);
    expect(await harness.db.all(sql`SELECT report_id FROM stats`)).toHaveLength(FINALIZE_PER_RUN + 10);
  });

  it('deletes the finalized rows, and nothing open', async () => {
    const harness = tickHarness();
    const finalized = await insertReport(harness.db, { status: 'pending', created_at: RUN - DAY, url: null, account_url: null, comment: null, reporter_ref: null, link_hash: null });
    await harness.db.run(sql`UPDATE reports SET status = 'rejected', data_deleted_at = ? WHERE id = ?`, [RUN - HOUR, finalized]);
    const open = await insertReport(harness.db, { created_at: RUN - DAY });
    at(harness);
    expect((await run(harness)).removed).toBe(1);
    expect(await harness.db.all(sql`SELECT id FROM reports`)).toEqual([{ id: open }]);
  });

  it('deletes the reporter counters 90 days without activity, a blocked one excepted', async () => {
    const harness = tickHarness();
    const stats = sql`INSERT INTO reporter_stats (reporter_ref, open_count, day, day_count, rejections_30d, blocked, last_seen) VALUES (?, 0, ?, 1, 0, ?, ?)`;
    await harness.db.run(stats, [hex(1), '2027-01-19', 0, '2027-01-19']);
    await harness.db.run(stats, [hex(2), '2027-01-20', 0, '2027-01-20']);
    await harness.db.run(stats, [hex(3), '2026-01-01', 1, '2026-01-01']);
    at(harness);
    expect((await run(harness)).reporterRows).toBe(1);
    expect(await harness.db.all(sql`SELECT reporter_ref FROM reporter_stats ORDER BY reporter_ref`)).toEqual([{ reporter_ref: hex(2) }, { reporter_ref: hex(3) }]);
  });

  it('deletes the daily counters of days more than 90 days ago', async () => {
    const harness = tickHarness();
    await harness.db.run(sql`INSERT INTO counters (day, key, count) VALUES ('2027-01-19', 'presses', 5), ('2027-01-20', 'presses', 6), ('2027-01-19', 'intake_non_member', 2)`);
    at(harness);
    expect((await run(harness)).counterRows).toBe(2);
    expect(await harness.db.all(sql`SELECT day, key FROM counters`)).toEqual([{ day: '2027-01-20', key: 'presses' }]);
  });
});

describe('the retention job under lockdown', () => {
  it('deletes and finalizes as ever, touches nothing in the venue, and alerts the keyholders only', async () => {
    for (const layer of ['switch', 'override'] as const) {
      const harness = tickHarness(layer === 'override' ? { variables: { LOCKDOWN: '1' } } : {});
      if (layer === 'switch') await setLockdown(harness.db, harness.clock);
      const reportId = await insertReport(harness.db, { created_at: RUN - 31 * DAY, card_message_id: 61 });
      harness.telegram.seedMessage(IDS.adminChat, { message_id: 61, text: 'the card' });
      harness.telegram.seedMessage(IDS.adminChat, { message_id: 62, text: 'a prompt' });
      harness.telegram.seedMessage(IDS.keyholder, { message_id: 63, text: 'a prompt' });
      for (const [chatId, messageId] of [[IDS.adminChat, 62], [IDS.keyholder, 63]] as const) {
        await createPrompt(harness.db, { chatId, promptMessageId: messageId, adminId: chatId === IDS.adminChat ? IDS.admin : chatId, reportId, kind: 'retraction', category: null, linkMode: null, createdAt: RUN - 30 * HOUR });
      }
      const closing = await postedAt(harness.db, RUN - 10 * DAY, 64);
      await harness.db.run(sql`UPDATE reports SET status = 'closing' WHERE id = ?`, [closing]);
      await harness.db.run(sql`INSERT INTO jobs (id, kind, report_id, due_at, payload, attempts, created_at) VALUES (?, 'edit', ?, ?, '{"action":"close"}', 20, 1)`, [someId(), closing, RUN]);
      at(harness);
      expect(await run(harness), layer).toMatchObject({ prompts: 2, abandoned: 1, finalized: 1, removed: 1 });
      expect(harness.telegram.calls.filter((call) => call.chatId === IDS.adminChat), layer).toEqual([]);
      expect(harness.telegram.messageIn(IDS.keyholder, 63), layer).toBeUndefined();
      expect(harness.telegram.callsOf('sendMessage').map((call) => call.chatId), layer).toEqual([IDS.keyholder, IDS.secondKeyholder]);
    }
  });
});

describe('the retention job when a step fails', () => {
  /** The counted store with statements of `text` failing as `failure`. */
  const failing = (text: SqlText, failure: Error) => (db: SqlDb): SqlDb => ({
    ...db,
    run: (statement, params) => (statement === text ? Promise.reject(failure) : db.run(statement, params)),
  });

  it('logs a failure of a step by class and runs the next steps', async () => {
    const DRAFTS = sql`DELETE FROM drafts WHERE created_at <= ?`;
    const harness = tickHarness({ store: failing(DRAFTS, new TypeError('a bug about https://x.com/someone')) });
    await harness.db.run(sql`INSERT INTO counters (day, key, count) VALUES ('2026-01-01', 'presses', 5)`);
    at(harness);
    expect(await run(harness)).toMatchObject({ drafts: 0, counterRows: 1 });
    expect(harness.log.records()[0]).toEqual({ level: 'error', event: 'retention.failed', errorClass: 'TypeError' });
    expect(harness.log.text()).not.toContain('x.com');
  });

  it('stops where a storage failure meets it, without another write', async () => {
    const PROMPTS = sql`DELETE FROM admin_prompts WHERE created_at <= ?`;
    const harness = tickHarness({ store: failing(PROMPTS, new AppError('STORAGE_FAILURE', 'down')) });
    await harness.db.run(sql`INSERT INTO counters (day, key, count) VALUES ('2026-01-01', 'presses', 5)`);
    at(harness);
    await expect(run(harness)).rejects.toMatchObject({ code: 'STORAGE_FAILURE' });
    expect(await harness.db.all(sql`SELECT day FROM counters`)).toEqual([{ day: '2026-01-01' }]);
    expect(harness.log.records()).toEqual([]);
  });
});

// Unit tests for the rejection's batch (src/review/reject.ts; critical
// invariants 1 and 8), on node:sqlite with the D1 migrations: pending to
// rejected with the reason, the time and the admin; the review-only fields
// nulled on the report and its merged rows; the rejection counted once on
// each reference of the target's reports; the prompts gone; nothing at all
// for a report no longer pending.
import { describe, expect, it } from 'vitest';
import { fakeClock } from '../../test/fakes/clock';
import { migratedDatabase } from '../../test/support/database';
import { hex, insertReport, insertReporterStats, reportRow, snapshot } from '../../test/support/review-rows';
import { IDS } from '../../test/support/variables';
import { sql } from '../db/sql';
import { createPrompt } from './prompts';
import { rejectStatements, REJECT_STATUS_STATEMENT } from './reject';

const NOW = 1_800_000_000_000;
const setup = () => migratedDatabase(fakeClock(NOW));

describe('the rejection batch', () => {
  it('rejects with the reason, the time and the admin, nulling the review-only fields of the report and its merged rows', async () => {
    const { db } = setup();
    const reportId = await insertReport(db, { reporter_ref: hex(1) });
    const merged = await insertReport(db, { status: 'merged', merged_into: reportId, reporter_ref: hex(2), affected_person: 1, card_message_id: null });
    await insertReporterStats(db, hex(1));
    await insertReporterStats(db, hex(2), { rejections: 2 });
    await insertReporterStats(db, hex(3));
    await createPrompt(db, { chatId: IDS.adminChat, promptMessageId: 5, adminId: IDS.admin, reportId, kind: 'account_link', category: 'harassment', linkMode: null, createdAt: NOW });
    const results = await db.batch(rejectStatements(reportId, 'weaponised', IDS.secondAdmin, NOW));
    expect(results[REJECT_STATUS_STATEMENT]).toEqual({ changes: 1 });
    expect(await reportRow(db, reportId)).toMatchObject({
      status: 'rejected',
      rejection_reason: 'weaponised',
      decided_at: NOW,
      decided_by: IDS.secondAdmin,
      comment: null,
      affected_person: null,
      card_message_id: null,
      url: 'https://x.com/someone/status/1234567890',
    });
    expect(await reportRow(db, merged)).toMatchObject({ status: 'merged', comment: null, affected_person: null });
    expect(await db.all(sql`SELECT reporter_ref, rejections_30d FROM reporter_stats ORDER BY reporter_ref`)).toEqual([
      { reporter_ref: hex(1), rejections_30d: 1 },
      { reporter_ref: hex(2), rejections_30d: 3 },
      { reporter_ref: hex(3), rejections_30d: 0 },
    ]);
    expect(await db.all(sql`SELECT * FROM admin_prompts`)).toEqual([]);
  });

  it('counts one rejection for a reference that reported the target twice', async () => {
    const { db } = setup();
    const reportId = await insertReport(db, { reporter_ref: hex(1) });
    await insertReport(db, { status: 'merged', merged_into: reportId, reporter_ref: hex(1), card_message_id: null });
    await insertReporterStats(db, hex(1));
    await db.batch(rejectStatements(reportId, 'no_violation', IDS.admin, NOW));
    expect(await db.all(sql`SELECT rejections_30d FROM reporter_stats`)).toEqual([{ rejections_30d: 1 }]);
  });

  it('writes nothing at all for a report no longer pending', async () => {
    const { db } = setup();
    const reportId = await insertReport(db, { status: 'routed', comment: null, reporter_ref: hex(1) });
    await insertReport(db, { status: 'merged', merged_into: reportId, reporter_ref: hex(2), card_message_id: null });
    await insertReporterStats(db, hex(1));
    const before = await snapshot(db);
    const results = await db.batch(rejectStatements(reportId, 'no_violation', IDS.admin, NOW));
    expect(results[REJECT_STATUS_STATEMENT]).toEqual({ changes: 0 });
    expect(await snapshot(db)).toEqual(before);
  });
});

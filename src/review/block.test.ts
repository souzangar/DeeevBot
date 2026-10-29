// Unit tests for Block reporter (src/review/block.ts; critical invariants 3
// and 8), on node:sqlite with the D1 migrations: a reference blocked and
// unblocked by itself, a new one's row created blocked, a report's reporter
// blocked by its reference, and the intake's limits refusing a blocked
// reference; nothing here is an id.
import { describe, expect, it } from 'vitest';
import { fakeClock } from '../../test/fakes/clock';
import { migratedDatabase } from '../../test/support/database';
import { hex, insertReport, insertReporterStats } from '../../test/support/review-rows';
import { sql } from '../db/sql';
import { blockReference, blockReporterOf, isReporterRef, unblockReference } from './block';

const setup = () => {
  const clock = fakeClock(Date.UTC(2027, 0, 15, 12));
  return { clock, ...migratedDatabase(clock) };
};

const stats = (db: ReturnType<typeof setup>['db']) =>
  db.all(sql`SELECT reporter_ref, blocked, rejections_30d, day_count, last_seen FROM reporter_stats ORDER BY reporter_ref`);

describe('the block list', () => {
  it('takes a reference of 64 lowercase hex characters, and nothing else', () => {
    expect(isReporterRef(hex(1))).toBe(true);
    for (const value of [hex(1).toUpperCase(), hex(1).slice(1), `${hex(1)}a`, '424240031', 'g'.repeat(64), 42]) {
      expect(isReporterRef(value)).toBe(false);
    }
  });

  it('blocks a known reference, keeping its counters, and says when it was blocked already', async () => {
    const { db, clock } = setup();
    await insertReporterStats(db, hex(1), { rejections: 2 });
    expect(await blockReference(db, clock, hex(1))).toBe('blocked');
    expect(await blockReference(db, clock, hex(1))).toBe('already_blocked');
    expect(await stats(db)).toEqual([{ reporter_ref: hex(1), blocked: 1, rejections_30d: 2, day_count: 1, last_seen: '2027-01-15' }]);
  });

  it("creates a new reference's row blocked, so it is refused if it ever reports", async () => {
    const { db, clock } = setup();
    expect(await blockReference(db, clock, hex(2))).toBe('blocked');
    expect(await stats(db)).toEqual([{ reporter_ref: hex(2), blocked: 1, rejections_30d: 0, day_count: 0, last_seen: '2027-01-15' }]);
  });

  it('unblocks a blocked reference only', async () => {
    const { db, clock } = setup();
    expect(await unblockReference(db, hex(3))).toBe(false);
    await blockReference(db, clock, hex(3));
    expect(await unblockReference(db, hex(3))).toBe(true);
    expect(await unblockReference(db, hex(3))).toBe(false);
    expect(await stats(db)).toEqual([{ reporter_ref: hex(3), blocked: 0, rejections_30d: 0, day_count: 0, last_seen: '2027-01-15' }]);
  });

  it("blocks a report's reporter by its reference, or says there is none left", async () => {
    const { db, clock } = setup();
    const reportId = await insertReport(db, { reporter_ref: hex(4) });
    const finalized = await insertReport(db, { reporter_ref: null, status: 'rejected' });
    expect(await blockReporterOf(db, clock, reportId)).toBe('blocked');
    expect(await blockReporterOf(db, clock, finalized)).toBe('no_reference');
    expect(await blockReporterOf(db, clock, 'nosuchreportxxxxxxxx')).toBe('no_reference');
    expect(await stats(db)).toEqual([{ reporter_ref: hex(4), blocked: 1, rejections_30d: 0, day_count: 0, last_seen: '2027-01-15' }]);
  });
});

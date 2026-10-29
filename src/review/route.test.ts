// Unit tests for the routing's batch (src/review/route.ts; critical
// invariants 7 and 8), on node:sqlite with the D1 migrations: pending to
// routed as suspected CSAM with the time and the admin, in one batch that
// nulls the links, the comment and the flag on the report and on every
// report merged into it, a cancelled approval's rendered post with them;
// the keyed link hash and the aggregate fields kept; nothing at all for a
// report no longer pending; and no approval left that could post it.
import { describe, expect, it } from 'vitest';
import { fakeClock } from '../../test/fakes/clock';
import { migratedDatabase } from '../../test/support/database';
import { hex, insertApproval, insertReport, reportRow, snapshot } from '../../test/support/review-rows';
import { IDS } from '../../test/support/variables';
import { sql } from '../db/sql';
import { routeStatements, ROUTE_STATUS_STATEMENT } from './route';

const NOW = 1_800_000_000_000;
const setup = () => migratedDatabase(fakeClock(NOW));

describe('the routing batch', () => {
  it('routes, nulling the links, the comment and the flag of the report and of its merged rows, together', async () => {
    const { db } = setup();
    const reportId = await insertReport(db, { category: 'child_safety', broadcast_text: 'a post of a cancelled approval', link_hash: hex(5, 'c') });
    await insertApproval(db, reportId, { voidedAt: NOW - 1 });
    const merged = [
      await insertReport(db, { status: 'merged', merged_into: reportId, comment: 'more', affected_person: 1, card_message_id: null }),
      await insertReport(db, { status: 'merged', merged_into: reportId, url: 'https://x.com/someone/status/99', card_message_id: null }),
    ];
    const results = await db.batch(routeStatements(reportId, IDS.admin, NOW));
    expect(results[ROUTE_STATUS_STATEMENT]).toEqual({ changes: 1 });
    expect(await reportRow(db, reportId)).toMatchObject({
      status: 'routed',
      category: 'csam',
      decided_at: NOW,
      decided_by: IDS.admin,
      url: null,
      account_url: null,
      comment: null,
      affected_person: null,
      broadcast_text: null,
      link_mode: null,
      card_message_id: null,
      link_hash: hex(5, 'c'),
      platform: 'x',
    });
    for (const id of merged) {
      expect(await reportRow(db, id)).toMatchObject({ status: 'merged', url: null, account_url: null, comment: null, affected_person: null });
    }
    expect(await db.all(sql`SELECT count(*) AS n FROM approvals WHERE voided_at IS NULL`)).toEqual([{ n: 0 }]);
  });

  it('writes nothing at all for a report no longer pending', async () => {
    const { db } = setup();
    const reportId = await insertReport(db, { status: 'rejected' });
    await insertReport(db, { status: 'merged', merged_into: reportId, card_message_id: null });
    const before = await snapshot(db);
    const results = await db.batch(routeStatements(reportId, IDS.admin, NOW));
    expect(results[ROUTE_STATUS_STATEMENT]).toEqual({ changes: 0 });
    expect(await snapshot(db)).toEqual(before);
  });
});

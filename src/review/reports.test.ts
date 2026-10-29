// Unit tests for the review's reads of a report and its approval
// (src/review/reports.ts), on node:sqlite with the D1 migrations: a row
// read whole and typed, a corrupt value refused by name of its table only,
// the live approval, the conditional writes of the card's, the status
// card's and the account's fields, and the "previously reported" outcome
// from the aggregate rows and from the decided reports.
import { describe, expect, it } from 'vitest';
import { fakeClock } from '../../test/fakes/clock';
import { migratedDatabase } from '../../test/support/database';
import { hex, insertApproval, insertReport } from '../../test/support/review-rows';
import { sql } from '../db/sql';
import { AppError } from '../errors/app-error';
import {
  isReportStatus,
  liveApproval,
  priorOutcome,
  readApproval,
  readReport,
  REPORT_STATUSES,
  setAccountUrl,
  setCardMessage,
  setStatusMessage,
} from './reports';

const setup = () => migratedDatabase(fakeClock(1_800_000_000_000));

describe('readReport', () => {
  it('reads a report whole, its flag as a boolean, and null for one that does not exist', async () => {
    const { db } = setup();
    const id = await insertReport(db, { affected_person: 1 });
    expect(await readReport(db, id)).toEqual({
      id,
      status: 'pending',
      platform: 'x',
      category: 'harassment',
      url: 'https://x.com/someone/status/1234567890',
      accountUrl: 'https://x.com/someone',
      comment: 'a comment of the reporter',
      affectedPerson: true,
      reporterRef: hex(1),
      mergedInto: null,
      linkHash: hex(1, 'c'),
      createdAt: 1_800_000_000_000,
      cardMessageId: 7,
      statusMessageId: null,
    });
    expect(await readReport(db, 'nosuchreportxxxxxxxx')).toBeNull();
  });

  it('reads a cleared flag as null', async () => {
    const { db } = setup();
    const id = await insertReport(db, { affected_person: null, comment: null });
    expect(await readReport(db, id)).toMatchObject({ affectedPerson: null, comment: null });
  });

  it('refuses a row holding a value outside its type, naming no value', async () => {
    const { db, connection } = setup();
    const id = await insertReport(db);
    connection.prepare("UPDATE reports SET platform = 'myspace' WHERE id = ?").run(id);
    const caught = await readReport(db, id).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('UNEXPECTED');
    expect((caught as AppError).message).not.toContain('myspace');
  });

  it('knows exactly the statuses of the schema', () => {
    for (const status of REPORT_STATUSES) expect(isReportStatus(status)).toBe(true);
    expect(isReportStatus('approving')).toBe(false);
  });
});

describe('readApproval and liveApproval', () => {
  it('read the approval record, and the live one only while it is not voided', async () => {
    const { db } = setup();
    const id = await insertReport(db, { status: 'pending' });
    expect(await readApproval(db, id)).toBeNull();
    const approvalId = await insertApproval(db, id, { approvedAt: 100, startsAt: 200 });
    const record = { reportId: id, approvalId, adminId: 424240011, approvedAt: 100, linkMode: 'account', recommendedComment: 'say it is harassment', startsAt: 200, voidedAt: null };
    expect(await readApproval(db, id)).toEqual(record);
    expect(await liveApproval(db, id)).toEqual(record);
    await db.run(sql`UPDATE approvals SET voided_at = 150 WHERE report_id = ?`, [id]);
    expect(await readApproval(db, id)).toMatchObject({ voidedAt: 150 });
    expect(await liveApproval(db, id)).toBeNull();
  });
});

describe('the conditional writes', () => {
  it("record the card's id on a pending report only", async () => {
    const { db } = setup();
    const pending = await insertReport(db, { card_message_id: null });
    const rejected = await insertReport(db, { status: 'rejected', card_message_id: null });
    expect(await setCardMessage(db, pending, 41)).toBe(true);
    expect(await setCardMessage(db, rejected, 42)).toBe(false);
    expect((await readReport(db, pending))?.cardMessageId).toBe(41);
    expect((await readReport(db, rejected))?.cardMessageId).toBeNull();
  });

  it("record the status card's id on an approved report only", async () => {
    const { db } = setup();
    const approved = await insertReport(db);
    await insertApproval(db, approved);
    await db.run(sql`UPDATE reports SET status = 'approved' WHERE id = ?`, [approved]);
    const pending = await insertReport(db);
    expect(await setStatusMessage(db, approved, 43)).toBe(true);
    expect(await setStatusMessage(db, pending, 44)).toBe(false);
  });

  it('record an account link on a pending report that has none, and never overwrite one', async () => {
    const { db } = setup();
    const id = await insertReport(db, { account_url: null });
    expect(await setAccountUrl(db, id, 'https://x.com/first')).toBe(true);
    expect(await setAccountUrl(db, id, 'https://x.com/second')).toBe(false);
    expect((await readReport(db, id))?.accountUrl).toBe('https://x.com/first');
  });
});

describe('priorOutcome', () => {
  const HASH = hex(9, 'c');

  it('is null for a target reported for the first time, or a report without a hash', async () => {
    const { db } = setup();
    const id = await insertReport(db, { link_hash: HASH });
    expect(await priorOutcome(db, { id, linkHash: HASH })).toBeNull();
    expect(await priorOutcome(db, { id, linkHash: null })).toBeNull();
  });

  it("is a decided report's outcome, before its finalization", async () => {
    const { db } = setup();
    await insertReport(db, { status: 'rejected', link_hash: HASH, decided_at: 1_800_000_000_500 });
    const id = await insertReport(db, { link_hash: HASH, created_at: 1_800_000_001_000 });
    expect(await priorOutcome(db, { id, linkHash: HASH })).toBe('rejected');
  });

  it("is the aggregate row's outcome after the finalization, and the later of the two when both exist", async () => {
    const { db } = setup();
    await db.run(
      sql`INSERT INTO stats (report_id, category, platform, created_day, decided_day, closed_day, outcome, presses, link_hash) VALUES ('oldreportxxxxxxxxxxx', 'harassment', 'x', '2026-12-01', '2026-12-01', '2026-12-20', 'taken_down', 4, ?)`,
      [HASH],
    );
    const id = await insertReport(db, { link_hash: HASH });
    expect(await priorOutcome(db, { id, linkHash: HASH })).toBe('taken_down');
    // A routing of the same target in January is later than the December closure.
    await insertReport(db, { status: 'routed', link_hash: HASH, decided_at: Date.UTC(2027, 0, 10) });
    expect(await priorOutcome(db, { id, linkHash: HASH })).toBe('routed');
  });

  it('ignores the report itself, merged and open reports of the target', async () => {
    const { db } = setup();
    const primary = await insertReport(db, { link_hash: HASH });
    await insertReport(db, { status: 'merged', merged_into: primary, link_hash: HASH });
    expect(await priorOutcome(db, { id: primary, linkHash: HASH })).toBeNull();
  });
});

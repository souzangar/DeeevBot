// Unit tests for the intake store (src/review/drafts.ts), on node:sqlite
// with the D1 migrations: the draft keyed by the reporter reference and
// moved on only from its own step, /language and /cancel, and the submit's
// one batch: the limits by reference (members 5 open and 20 a day,
// non-members 1 a day and 20 a day together, 3 rejections throttle to 1,
// a block refuses), the duplicate check against open targets only, the
// stats row, and a second submit of the same draft writing nothing.
import { describe, expect, it } from 'vitest';
import { fakeClock } from '../../test/fakes/clock';
import { migratedDatabase } from '../../test/support/database';
import { utcDay } from '../clock';
import { randomId } from '../db/ids';
import { sql, type SqlDb } from '../db/sql';
import {
  cancelDraft,
  readDraft,
  rememberLocale,
  setAccount,
  setAffected,
  setCategory,
  startDraft,
  submitReport,
  submitStatements,
  type SubmitInput,
} from './drafts';
import { INTAKE_LIMITS, NON_MEMBER_COUNTER } from './intake';

const NOW = Date.UTC(2027, 0, 15, 12, 0, 0);
const DAY = utcDay(NOW);
const ref = (n: number): string => n.toString(16).padStart(64, 'a');
const HASH = 'c'.repeat(64);
const OTHER_HASH = 'd'.repeat(64);
const LINK = { url: 'https://www.instagram.com/p/AbC123xyz', platform: 'instagram' as const, accountUrl: null };

const setup = () => {
  const clock = fakeClock(NOW);
  const { db, connection } = migratedDatabase(clock);
  return { clock, db, connection };
};

/** A draft of `key` at the comment step. */
const commentDraft = async (db: SqlDb, clock: ReturnType<typeof fakeClock>, key: string): Promise<void> => {
  await startDraft(db, clock, key, 'category', { ...LINK, accountUrl: 'https://www.instagram.com/someone' }, 'en');
  await setCategory(db, clock, key, 'harassment');
  await setAffected(db, clock, key, false);
};

const input = (key: string, fields: Partial<SubmitInput> = {}): SubmitInput => ({
  reporterRef: key,
  reportId: randomId(),
  member: true,
  url: LINK.url,
  platform: 'instagram',
  accountUrl: 'https://www.instagram.com/someone',
  category: 'harassment',
  affectedPerson: false,
  comment: 'a note',
  linkHash: HASH,
  ...fields,
});

/** Submits a fresh draft of `key` with `fields`. */
const submitFresh = async (db: SqlDb, clock: ReturnType<typeof fakeClock>, key: string, fields: Partial<SubmitInput> = {}) => {
  await commentDraft(db, clock, key);
  return submitReport(db, input(key, fields), clock.now());
};

const reports = (db: SqlDb) =>
  db.all<{ status: string; merged_into: string | null; reporter_ref: string; link_hash: string; comment: string | null }>(
    sql`SELECT status, merged_into, reporter_ref, link_hash, comment FROM reports ORDER BY created_at, id`,
  );
const statsOf = (db: SqlDb, key: string) =>
  db.first<{ open_count: number; day: string; day_count: number; last_seen: string }>(
    sql`SELECT open_count, day, day_count, last_seen FROM reporter_stats WHERE reporter_ref = ?`,
    [key],
  );
const draftRows = async (db: SqlDb) => (await db.first<{ n: number }>(sql`SELECT count(*) AS n FROM drafts`))?.n;

describe('the draft', () => {
  it('starts with its link, keyed by the reference, and moves on one step at a time', async () => {
    const { db, clock } = setup();
    const key = ref(1);
    expect(await readDraft(db, key)).toBeNull();
    expect(await startDraft(db, clock, key, 'account', LINK, 'fa')).toBe(true);
    expect(await readDraft(db, key)).toEqual({
      key,
      step: 'account',
      url: LINK.url,
      platform: 'instagram',
      accountUrl: null,
      category: null,
      affectedPerson: null,
      locale: 'fa',
      createdAt: NOW,
      updatedAt: NOW,
    });
    clock.advance(1_000);
    expect(await setAccount(db, clock, key, null)).toBe(true);
    expect(await setCategory(db, clock, key, 'csam')).toBe(true);
    expect(await setAffected(db, clock, key, true)).toBe(true);
    expect(await readDraft(db, key)).toMatchObject({ step: 'comment', accountUrl: null, category: 'csam', affectedPerson: true, updatedAt: NOW + 1_000 });
  });

  it('moves on only from its own step: a second press or a late message changes nothing', async () => {
    const { db, clock } = setup();
    const key = ref(2);
    await startDraft(db, clock, key, 'category', { ...LINK, accountUrl: 'https://www.instagram.com/someone' }, 'en');
    expect(await setAccount(db, clock, key, 'https://www.instagram.com/other')).toBe(false);
    expect(await setCategory(db, clock, key, 'harassment')).toBe(true);
    expect(await setCategory(db, clock, key, 'other')).toBe(false);
    expect(await startDraft(db, clock, key, 'category', LINK, 'en')).toBe(false);
    expect(await readDraft(db, key)).toMatchObject({ step: 'affected', category: 'harassment', accountUrl: 'https://www.instagram.com/someone' });
  });

  it('keeps a /language choice, and starts from it with the link', async () => {
    const { db, clock } = setup();
    const key = ref(3);
    await rememberLocale(db, clock, key, 'fa');
    expect(await readDraft(db, key)).toMatchObject({ step: 'url', url: null, locale: 'fa' });
    await rememberLocale(db, clock, key, 'en');
    expect(await readDraft(db, key)).toMatchObject({ step: 'url', locale: 'en' });
    expect(await startDraft(db, clock, key, 'category', { ...LINK, accountUrl: 'https://www.instagram.com/x' }, 'fa')).toBe(true);
    expect(await readDraft(db, key)).toMatchObject({ step: 'category', url: LINK.url, locale: 'en' });
    await rememberLocale(db, clock, key, 'fa');
    expect(await readDraft(db, key)).toMatchObject({ step: 'category', locale: 'fa' });
  });

  it('is deleted by /cancel, which says whether there was one', async () => {
    const { db, clock } = setup();
    const key = ref(4);
    await startDraft(db, clock, key, 'account', LINK, 'en');
    expect(await cancelDraft(db, key)).toBe(true);
    expect(await cancelDraft(db, key)).toBe(false);
    expect(await draftRows(db)).toBe(0);
  });

  it('reads a row that does not hold its step as none, and deletes it', async () => {
    const { db } = setup();
    const key = ref(5);
    await db.run(sql`INSERT INTO drafts (draft_key, step, locale, created_at, updated_at) VALUES (?, 'comment', 'en', 1, 1)`, [key]);
    expect(await readDraft(db, key)).toBeNull();
    expect(await draftRows(db)).toBe(0);
    await db.run(sql`INSERT INTO drafts (draft_key, step, locale, created_at, updated_at) VALUES (?, 'nonsense', 'en', 1, 1)`, [key]);
    expect(await readDraft(db, key)).toBeNull();
    await db.run(sql`INSERT INTO drafts (draft_key, step, locale, created_at, updated_at) VALUES (?, 'url', 'de', 1, 1)`, [key]);
    expect(await readDraft(db, key)).toBeNull();
  });
});

describe('the submit', () => {
  it('turns the draft into one pending report, keyed by the reference, and deletes the draft', async () => {
    const { db, clock } = setup();
    const key = ref(10);
    expect(await submitFresh(db, clock, key)).toBe('submitted');
    expect(await reports(db)).toEqual([{ status: 'pending', merged_into: null, reporter_ref: key, link_hash: HASH, comment: 'a note' }]);
    expect(await draftRows(db)).toBe(0);
    expect(await statsOf(db, key)).toEqual({ open_count: 1, day: DAY, day_count: 1, last_seen: DAY });
  });

  it('merges a report of an open target into it, and counts it for the day but not as open', async () => {
    const { db, clock } = setup();
    expect(await submitFresh(db, clock, ref(11))).toBe('submitted');
    clock.advance(1_000);
    expect(await submitFresh(db, clock, ref(12))).toBe('submitted');
    expect(await submitFresh(db, clock, ref(11))).toBe('submitted');
    const [primary, ...merged] = await db.all<{ id: string; status: string; merged_into: string | null }>(
      sql`SELECT id, status, merged_into FROM reports ORDER BY created_at, status DESC`,
    );
    expect(primary?.status).toBe('pending');
    expect(merged.map((row) => [row.status, row.merged_into])).toEqual([
      ['merged', primary?.id],
      ['merged', primary?.id],
    ]);
    expect(await statsOf(db, ref(12))).toMatchObject({ open_count: 0, day_count: 1 });
    expect(await statsOf(db, ref(11))).toMatchObject({ open_count: 1, day_count: 2 });
  });

  it.each(['approved', 'posting', 'posted'])('merges into a target that is %s', async (status) => {
    const { db, clock } = setup();
    const id = randomId();
    await db.run(
      sql`INSERT INTO reports (id, status, platform, category, link_hash, created_at, posting_started_at, posted_at) VALUES (?, 'pending', 'instagram', 'harassment', ?, ?, ?, ?)`,
      [id, HASH, NOW - 5_000, status === 'pending' ? null : NOW - 4_000, status === 'posted' ? NOW - 3_000 : null],
    );
    await db.run(
      sql`INSERT INTO approvals (report_id, approval_id, admin_id, approved_at, link_mode, recommended_comment, starts_at) VALUES (?, ?, 424240011, ?, 'account', 'points', ?)`,
      [id, randomId(), NOW - 6_000, NOW - 6_000],
    );
    await db.run(sql`UPDATE reports SET status = ? WHERE id = ?`, [status, id]);
    expect(await submitFresh(db, clock, ref(13))).toBe('submitted');
    expect((await reports(db)).map((row) => row.status).sort()).toEqual(['merged', status].sort());
  });

  it.each(['closed', 'retracted', 'expired', 'rejected', 'routed', 'closing', 'retracting'])(
    'does not merge into a target that is %s: there is no open row',
    async (status) => {
      const { db, clock } = setup();
      await db.run(sql`INSERT INTO reports (id, status, platform, category, link_hash, created_at) VALUES (?, ?, 'instagram', 'harassment', ?, ?)`, [
        randomId(),
        status,
        HASH,
        NOW - 5_000,
      ]);
      expect(await submitFresh(db, clock, ref(14))).toBe('submitted');
      expect((await reports(db)).map((row) => row.status).sort()).toEqual(['pending', status].sort());
    },
  );

  it('does not merge different links', async () => {
    const { db, clock } = setup();
    await submitFresh(db, clock, ref(15));
    await submitFresh(db, clock, ref(16), { linkHash: OTHER_HASH });
    expect((await reports(db)).map((row) => row.status)).toEqual(['pending', 'pending']);
  });

  it('writes nothing for a second submit of the same draft: the draft was taken', async () => {
    const { db, clock } = setup();
    const key = ref(17);
    await commentDraft(db, clock, key);
    expect(await submitReport(db, input(key), NOW)).toBe('submitted');
    expect(await submitReport(db, input(key), NOW)).toBe('stale');
    expect(await reports(db)).toHaveLength(1);
    expect(await statsOf(db, key)).toMatchObject({ day_count: 1 });
  });

  it('writes nothing for a draft not at the comment step', async () => {
    const { db, clock } = setup();
    const key = ref(18);
    await startDraft(db, clock, key, 'category', { ...LINK, accountUrl: 'https://www.instagram.com/x' }, 'en');
    expect(await submitReport(db, input(key), NOW)).toBe('stale');
    expect(await reports(db)).toEqual([]);
    expect(await readDraft(db, key)).toMatchObject({ step: 'category' });
  });
});

describe('the limits', () => {
  it(`lets a member have ${INTAKE_LIMITS.memberOpen} pending reports, and refuses the next, deleting its draft`, async () => {
    const { db, clock } = setup();
    const key = ref(20);
    for (let n = 0; n < INTAKE_LIMITS.memberOpen; n += 1) {
      expect(await submitFresh(db, clock, key, { linkHash: n.toString(16).padStart(64, 'e') })).toBe('submitted');
    }
    expect(await submitFresh(db, clock, key, { linkHash: OTHER_HASH })).toBe('limited');
    expect(await draftRows(db)).toBe(0);
    expect(await reports(db)).toHaveLength(INTAKE_LIMITS.memberOpen);
    expect(await statsOf(db, key)).toMatchObject({ open_count: INTAKE_LIMITS.memberOpen, day_count: INTAKE_LIMITS.memberOpen });
  });

  it('frees a member\'s slot as soon as a pending report is decided, with no counter to keep right', async () => {
    const { db, clock } = setup();
    const key = ref(21);
    for (let n = 0; n < INTAKE_LIMITS.memberOpen; n += 1) {
      await submitFresh(db, clock, key, { linkHash: n.toString(16).padStart(64, 'e') });
    }
    await db.run(sql`UPDATE reports SET status = 'rejected' WHERE id = (SELECT id FROM reports ORDER BY created_at LIMIT 1)`);
    expect(await submitFresh(db, clock, key, { linkHash: OTHER_HASH })).toBe('submitted');
    expect(await statsOf(db, key)).toMatchObject({ open_count: INTAKE_LIMITS.memberOpen });
  });

  it(`lets a member submit ${INTAKE_LIMITS.memberPerDay} a day, merged ones included, and again the next day`, async () => {
    const { db, clock } = setup();
    const key = ref(22);
    await db.run(sql`INSERT INTO reports (id, status, platform, category, link_hash, created_at) VALUES (?, 'pending', 'x', 'other', ?, ?)`, [randomId(), HASH, NOW - 1]);
    for (let n = 0; n < INTAKE_LIMITS.memberPerDay; n += 1) expect(await submitFresh(db, clock, key)).toBe('submitted');
    expect(await submitFresh(db, clock, key)).toBe('limited');
    clock.advance(24 * 60 * 60 * 1000);
    expect(await submitFresh(db, clock, key)).toBe('submitted');
    expect(await statsOf(db, key)).toMatchObject({ day: utcDay(clock.now()), day_count: 1, last_seen: utcDay(clock.now()) });
  });

  it(`lets a non-member submit ${INTAKE_LIMITS.nonMemberPerDay} a day`, async () => {
    const { db, clock } = setup();
    const key = ref(23);
    expect(await submitFresh(db, clock, key, { member: false })).toBe('submitted');
    expect(await submitFresh(db, clock, key, { member: false, linkHash: OTHER_HASH })).toBe('limited');
    expect(await db.first(sql`SELECT count FROM counters WHERE day = ? AND key = ?`, [DAY, NON_MEMBER_COUNTER])).toEqual({ count: 1 });
  });

  it(`stops every non-member at ${INTAKE_LIMITS.nonMemberGlobalPerDay} a day together, and not the members`, async () => {
    const { db, clock } = setup();
    for (let n = 0; n < INTAKE_LIMITS.nonMemberGlobalPerDay; n += 1) {
      expect(await submitFresh(db, clock, ref(100 + n), { member: false })).toBe('submitted');
    }
    expect(await submitFresh(db, clock, ref(200), { member: false })).toBe('limited');
    expect(await submitFresh(db, clock, ref(201), { member: true })).toBe('submitted');
    expect(await db.first(sql`SELECT count FROM counters WHERE day = ? AND key = ?`, [DAY, NON_MEMBER_COUNTER])).toEqual({
      count: INTAKE_LIMITS.nonMemberGlobalPerDay,
    });
    clock.advance(24 * 60 * 60 * 1000);
    expect(await submitFresh(db, clock, ref(200), { member: false })).toBe('submitted');
  });

  it(`throttles a reference with ${INTAKE_LIMITS.throttleRejections} rejections to ${INTAKE_LIMITS.throttledPerDay} a day, member or not`, async () => {
    const { db, clock } = setup();
    for (const [key, member] of [
      [ref(30), true],
      [ref(31), false],
    ] as const) {
      await db.run(sql`INSERT INTO reporter_stats (reporter_ref, rejections_30d, last_seen) VALUES (?, ?, ?)`, [key, INTAKE_LIMITS.throttleRejections, DAY]);
      expect(await submitFresh(db, clock, key, { member })).toBe('submitted');
      expect(await submitFresh(db, clock, key, { member, linkHash: OTHER_HASH })).toBe('limited');
    }
    await db.run(sql`INSERT INTO reporter_stats (reporter_ref, rejections_30d, last_seen) VALUES (?, ?, ?)`, [ref(32), 2, DAY]);
    expect(await submitFresh(db, clock, ref(32))).toBe('submitted');
    expect(await submitFresh(db, clock, ref(32), { linkHash: OTHER_HASH })).toBe('submitted');
  });

  it('refuses a blocked reference, which keeps its row', async () => {
    const { db, clock } = setup();
    const key = ref(40);
    await db.run(sql`INSERT INTO reporter_stats (reporter_ref, blocked, last_seen) VALUES (?, 1, '2026-01-01')`, [key]);
    expect(await submitFresh(db, clock, key)).toBe('limited');
    expect(await reports(db)).toEqual([]);
    expect(await db.first(sql`SELECT blocked, day_count, last_seen FROM reporter_stats WHERE reporter_ref = ?`, [key])).toEqual({
      blocked: 1,
      day_count: 0,
      last_seen: '2026-01-01',
    });
  });

  it('writes only the draft deletion for a refused submit: no stats row, no counter, no report', async () => {
    const { db, clock } = setup();
    for (let n = 0; n < INTAKE_LIMITS.nonMemberGlobalPerDay; n += 1) await submitFresh(db, clock, ref(300 + n), { member: false });
    const before = await db.all(sql`SELECT * FROM counters`);
    expect(await submitFresh(db, clock, ref(399), { member: false })).toBe('limited');
    expect(await statsOf(db, ref(399))).toBeNull();
    expect(await db.all(sql`SELECT * FROM counters`)).toEqual(before);
    expect(await reports(db)).toHaveLength(INTAKE_LIMITS.nonMemberGlobalPerDay);
  });
});

describe('submitStatements', () => {
  it('is four statements, the first the draft taken from the comment step', () => {
    const statements = submitStatements(input(ref(50)), NOW);
    expect(statements).toHaveLength(4);
    expect(statements[0]?.sql).toMatch(/^DELETE FROM drafts WHERE draft_key = \? AND step = 'comment'$/);
    expect(statements[0]?.params).toEqual([ref(50)]);
    expect(statements.map((statement) => statement.sql).slice(1).every((text) => text.includes('changes() = 1'))).toBe(true);
  });
});

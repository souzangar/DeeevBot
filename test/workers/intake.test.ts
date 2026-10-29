// Workers tier: the intake store's submit on the local D1 that miniflare
// runs (src/review/drafts.ts over src/db/d1.ts). The submit is one batch of
// four statements chained by SQLite's changes(), which this checks on D1
// itself, as test/workers/webhook.test.ts does for the press counter: a new
// report is pending, a duplicate of an open target is merged into it, a
// refused submit writes nothing but the draft's deletion, and a second
// submit of the same draft writes nothing. Keys and hashes are unique to
// this file, so it shares the database with the other files safely.
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Clock } from '../../src/clock';
import { d1SqlDb } from '../../src/db/d1';
import { randomId } from '../../src/db/ids';
import { sql } from '../../src/db/sql';
import { readDraft, setAffected, setCategory, startDraft, submitReport, type SubmitInput } from '../../src/review/drafts';

const db = d1SqlDb(env.DB);
const NOW = Date.UTC(2031, 5, 1, 12, 0, 0);
const clock: Clock = { now: () => NOW, sleep: () => Promise.resolve() };
const ref = (n: number): string => `${'f'.repeat(56)}${n.toString(16).padStart(8, '0')}`;
const hash = (n: number): string => `${'e'.repeat(56)}${n.toString(16).padStart(8, '0')}`;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const draftAtComment = async (key: string): Promise<void> => {
  await startDraft(db, clock, key, 'category', { url: 'https://x.com/someone/status/1', platform: 'x', accountUrl: 'https://x.com/someone' }, 'en');
  await setCategory(db, clock, key, 'harassment');
  await setAffected(db, clock, key, false);
};

const input = (key: string, linkHash: string, member: boolean): SubmitInput => ({
  reporterRef: key,
  reportId: randomId(),
  member,
  url: 'https://x.com/someone/status/1',
  platform: 'x',
  accountUrl: 'https://x.com/someone',
  category: 'harassment',
  affectedPerson: false,
  comment: null,
  linkHash,
});

describe('the intake submit on D1', () => {
  it('inserts a pending report, merges a duplicate of it, and deletes both drafts', async () => {
    await draftAtComment(ref(1));
    expect(await submitReport(db, input(ref(1), hash(1), true), NOW)).toBe('submitted');
    await draftAtComment(ref(2));
    expect(await submitReport(db, input(ref(2), hash(1), true), NOW + 1)).toBe('submitted');
    const rows = await db.all<{ id: string; status: string; merged_into: string | null }>(
      sql`SELECT id, status, merged_into FROM reports WHERE link_hash = ? ORDER BY created_at`,
      [hash(1)],
    );
    expect(rows.map((row) => [row.status, row.merged_into])).toEqual([
      ['pending', null],
      ['merged', rows[0]?.id],
    ]);
    expect(await readDraft(db, ref(1))).toBeNull();
    expect(await readDraft(db, ref(2))).toBeNull();
    expect(await db.first(sql`SELECT open_count, day_count FROM reporter_stats WHERE reporter_ref = ?`, [ref(2)])).toEqual({
      open_count: 0,
      day_count: 1,
    });
  });

  it("refuses a non-member's second report of the day, writing nothing but the draft's deletion", async () => {
    await draftAtComment(ref(3));
    expect(await submitReport(db, input(ref(3), hash(3), false), NOW)).toBe('submitted');
    await draftAtComment(ref(3));
    expect(await submitReport(db, input(ref(3), hash(4), false), NOW)).toBe('limited');
    expect(await db.first(sql`SELECT count(*) AS n FROM reports WHERE reporter_ref = ?`, [ref(3)])).toEqual({ n: 1 });
    expect(await db.first(sql`SELECT day_count FROM reporter_stats WHERE reporter_ref = ?`, [ref(3)])).toEqual({ day_count: 1 });
    expect(await readDraft(db, ref(3))).toBeNull();
  });

  it('writes nothing for a second submit of a draft already taken', async () => {
    await draftAtComment(ref(5));
    expect(await submitReport(db, input(ref(5), hash(5), true), NOW)).toBe('submitted');
    expect(await submitReport(db, input(ref(5), hash(5), true), NOW)).toBe('stale');
    expect(await db.first(sql`SELECT count(*) AS n FROM reports WHERE reporter_ref = ?`, [ref(5)])).toEqual({ n: 1 });
  });
});

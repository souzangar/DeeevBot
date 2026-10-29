// @critical-path
// Block reporter (critical invariants 2, 3 and 8; doc/product/review-and-abuse-controls.md,
// "Block list and rejection throttle"): the button on the review card and
// the status card, so nobody types a 64-character reference, and /block
// <ref> and /unblock <ref> in the venue, set and clear `blocked` on the
// reference's `reporter_stats` row; the intake refuses a blocked reference
// with the neutral answer every limit gets. A blocked row persists through
// the 90-day expiry of the counters. The reference is the keyed HMAC of the
// reporter's id (src/privacy/reporter-ref.ts), opaque to the admins: nothing
// here reads, stores or shows an id. A /block of a reference that never
// reported creates its row, blocked, so the reference is refused if it ever
// does; /unblock clears only a row that exists.
import { utcDay, type Clock } from '../clock';
import { sql, type SqlDb } from '../db/sql';

/** A reporter reference: 64 lowercase hex characters, as the schema holds it. */
export const REPORTER_REF_PATTERN = /^[0-9a-f]{64}$/;

export const isReporterRef = (value: unknown): value is string => typeof value === 'string' && REPORTER_REF_PATTERN.test(value);

const BLOCK = sql`INSERT INTO reporter_stats (reporter_ref, blocked, last_seen) VALUES (?, 1, ?) ON CONFLICT (reporter_ref) DO UPDATE SET blocked = 1 WHERE reporter_stats.blocked = 0`;
const UNBLOCK = sql`UPDATE reporter_stats SET blocked = 0 WHERE reporter_ref = ? AND blocked = 1`;
const REPORTER_OF = sql`SELECT reporter_ref FROM reports WHERE id = ?`;

/** What a block did: blocked it now, found it blocked already, or found no reference to block. */
export type BlockOutcome = 'blocked' | 'already_blocked' | 'no_reference';

/** Blocks reference `ref` (see the header). */
export async function blockReference(db: SqlDb, clock: Clock, ref: string): Promise<Exclude<BlockOutcome, 'no_reference'>> {
  return (await db.run(BLOCK, [ref, utcDay(clock.now())])).changes === 1 ? 'blocked' : 'already_blocked';
}

/** Clears the block of reference `ref`; true when it was blocked. */
export async function unblockReference(db: SqlDb, ref: string): Promise<boolean> {
  return (await db.run(UNBLOCK, [ref])).changes === 1;
}

/** Blocks the reporter of report `reportId`, by its reference. */
export async function blockReporterOf(db: SqlDb, clock: Clock, reportId: string): Promise<BlockOutcome> {
  const row = await db.first<{ reporter_ref: unknown }>(REPORTER_OF, [reportId]);
  const ref = row?.reporter_ref;
  if (!isReporterRef(ref)) return 'no_reference';
  return blockReference(db, clock, ref);
}

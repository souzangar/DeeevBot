// @critical-path
// The two-layer lockdown (critical invariant 2;
// doc/architecture/adr-0003-update-transport-and-admin-authority.md;
// doc/product/threat-model-seizure.md, "Lockdown"):
// - the switch, `meta.lockdown` in D1, holding the time it was set: set by a
//   keyholder's /lockdown and cleared only by a keyholder's /unlock
//   (src/telegram/commands.ts is the one caller of clearLockdown, which
//   test/invariants/lockdown.test.ts pins); never by /resume, never by an
//   admin;
// - the override, the LOCKDOWN secret (`config.lockdown`), which the
//   keyholder sets with `wrangler secret put` and no Telegram command can
//   clear. It is read before any query, so it still locks the bot when D1
//   refuses queries.
// isLockedDown() is what every handler consults first: under lockdown
// intake stores nothing and answers a neutral text, presses are ignored,
// admin actions are refused and alerts go to the keyholders only. A
// statement that must not run under lockdown binds NOT_LOCKED_DOWN in its
// own WHERE clause, so a switch set between a read and a write still stops
// it. A failed read is an AppError STORAGE_FAILURE, never "not locked".
import type { Clock } from '../clock';
import type { Config } from '../config/schema';
import { sql, type SqlDb } from '../db/sql';

/** The meta key of the switch. */
export const LOCKDOWN_KEY = 'lockdown';
/**
 * The meta key of the once-only lockdown alert of the scheduling unit:
 * /unlock clears it with the switch, so the next lockdown alerts again.
 */
export const LOCKDOWN_ALERTED_KEY = 'lockdown_alerted_at';

/** A condition a statement binds in its WHERE clause: the switch is not set. */
export const NOT_LOCKED_DOWN = sql`NOT EXISTS (SELECT 1 FROM meta WHERE key = 'lockdown')`;

const READ_SWITCH = sql`SELECT value FROM meta WHERE key = 'lockdown'`;
const SET_SWITCH = sql`INSERT INTO meta (key, value) VALUES ('lockdown', ?) ON CONFLICT (key) DO NOTHING`;
const CLEAR_SWITCH = sql`DELETE FROM meta WHERE key = 'lockdown'`;
const CLEAR_ALERTED = sql`DELETE FROM meta WHERE key = 'lockdown_alerted_at'`;

/** Whether the switch is set in D1 (the override aside). */
export async function lockdownSwitchSet(db: SqlDb): Promise<boolean> {
  return (await db.first(READ_SWITCH)) !== null;
}

/**
 * Whether the bot is locked down: the LOCKDOWN override (no query at all),
 * or the switch in D1.
 */
export async function isLockedDown(config: Pick<Config, 'lockdown'>, db: SqlDb): Promise<boolean> {
  if (config.lockdown) return true;
  return lockdownSwitchSet(db);
}

/**
 * Sets the switch with the time it was set (milliseconds), unless it is set
 * already, which keeps the first time. True when this call set it. For a
 * keyholder's /lockdown only.
 */
export async function setLockdown(db: SqlDb, clock: Clock): Promise<boolean> {
  return (await db.run(SET_SWITCH, [clock.now()])).changes === 1;
}

/**
 * Clears the switch and the once-only alert marker, in one batch. True when
 * the switch was set. For a keyholder's /unlock only; the override is not
 * touched, and nothing here can touch it.
 */
export async function clearLockdown(db: SqlDb): Promise<boolean> {
  const [cleared] = await db.batch([
    { sql: CLEAR_SWITCH, params: [] },
    { sql: CLEAR_ALERTED, params: [] },
  ]);
  return cleared?.changes === 1;
}

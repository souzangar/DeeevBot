// @critical-path
// The scheduler's global state in `meta` (critical invariants 1 and 2; the
// MVP plan, sections 2 and 3; doc/architecture/adr-0004-storage-and-delivery-ledger.md,
// "Scheduling"):
// - `halted`: /halt holds every post and every closure edit until /resume;
//   retraction edits still run. The post's claim binds it in its own
//   statement (src/broadcast/post.ts), so a /halt set after a run read the
//   state still stops the post. /resume binds NOT_LOCKED_DOWN: an admin
//   action, so a lockdown set after the gate read the switch stops it.
// - `paused_until`: the global 429 pause, in milliseconds. Every job send
//   honours it: the post's claim binds it, and no edit job runs while it
//   lies ahead. A 429 only ever moves it later, never earlier.
// - `lockdown` and `lockdown_alerted_at`: src/auth/lockdown.ts writes them;
//   a run reads them here, beside the LOCKDOWN override, which needs no
//   query.
// readTickState() reads the four keys in ONE query; a failed read is an
// AppError STORAGE_FAILURE, which stops the run (src/broadcast/tick.ts),
// never a guess.
import { NOT_LOCKED_DOWN } from '../auth/lockdown';
import type { Clock } from '../clock';
import type { Config } from '../config/schema';
import { concatSql, sql, type SqlDb, type SqlStatement, type SqlValue } from '../db/sql';
import { isAppError } from '../errors/app-error';

/** The meta key of /halt. */
export const HALTED_KEY = 'halted';
/** The meta key of the global 429 pause. */
export const PAUSED_UNTIL_KEY = 'paused_until';

const READ_STATE = sql`SELECT key, value FROM meta WHERE key IN ('lockdown', 'lockdown_alerted_at', 'halted', 'paused_until')`;
const SET_HALT = sql`INSERT INTO meta (key, value) VALUES ('halted', ?) ON CONFLICT (key) DO NOTHING`;
const CLEAR_HALT = concatSql(sql`DELETE FROM meta WHERE key = 'halted' AND `, NOT_LOCKED_DOWN);
const PAUSE = sql`INSERT INTO meta (key, value) VALUES ('paused_until', ?) ON CONFLICT (key) DO UPDATE SET value = max(meta.value, excluded.value)`;

/** What a run knows of the global state, read once at its start. */
export interface TickState {
  /** The LOCKDOWN override, or the switch in D1. */
  readonly locked: boolean;
  /** When the switch was set (milliseconds); null when it is not, the override alone included. */
  readonly lockdownSetAt: number | null;
  /** Whether the once-only lockdown alert reached a keyholder (`lockdown_alerted_at`). */
  readonly lockdownAlerted: boolean;
  readonly halted: boolean;
  /** The end of the global pause (milliseconds), or null when none was ever set. */
  readonly pausedUntil: number | null;
}

const asTime = (value: SqlValue | undefined): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** The state of `meta`, with the override (see the header). */
export async function readTickState(config: Pick<Config, 'lockdown'>, db: SqlDb): Promise<TickState> {
  const rows = await db.all<{ key: SqlValue; value: SqlValue }>(READ_STATE);
  const values = new Map(rows.map((row) => [row.key, row.value] as const));
  const switchSet = values.has('lockdown');
  return {
    locked: config.lockdown || switchSet,
    lockdownSetAt: switchSet ? asTime(values.get('lockdown')) : null,
    lockdownAlerted: values.has('lockdown_alerted_at'),
    halted: values.has('halted'),
    pausedUntil: asTime(values.get('paused_until')),
  };
}

/** Whether the global pause lies ahead of `now`. */
export const isPaused = (state: Pick<TickState, 'pausedUntil'>, now: number): boolean => state.pausedUntil !== null && state.pausedUntil > now;

/** Sets /halt with the time it was set, unless it is set already. True when this call set it. */
export async function setHalt(db: SqlDb, clock: Clock): Promise<boolean> {
  return (await db.run(SET_HALT, [clock.now()])).changes === 1;
}

/** Clears /halt, unless the bot is locked down. True when it was set and is now cleared. */
export async function clearHalt(db: SqlDb): Promise<boolean> {
  return (await db.run(CLEAR_HALT)).changes === 1;
}

/** The statement that moves the global pause to `until`, never earlier than it already is. */
export const pauseStatement = (until: number): SqlStatement => ({ sql: PAUSE, params: [until] });

/** Whether `error` is a failure of the store: the one class that stops a run without writing. */
export const isStorageFailure = (error: unknown): boolean =>
  isAppError(error) && (error.code === 'STORAGE_FAILURE' || error.code === 'STORAGE_CAP_HIT');

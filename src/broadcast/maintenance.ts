// @critical-path
// The scheduler's maintenance slots and the one lockdown entry (critical
// invariants 2 and 8; the MVP plan, sections 2 and 4, "Retention",
// "Reconciliation", "Lockdown and wipe"):
// - the slots the closure and retention unit (U6) fills: runRetention(),
//   the nightly retention job the run starts at 00:15 UTC, under lockdown
//   too, since it reduces exposure (src/privacy/retention.ts);
//   runRetentionNow(), the immediate pass a lockdown triggers, the same job
//   at the clock's now; runSnapshot(), the monthly stats snapshot, on the
//   first day at 06:00 UTC (src/broadcast/stats.ts); finalize(), a
//   terminal report's finalization batch, which reconciliation calls for a
//   closed, retracted or expired row whose finalization never landed
//   (src/broadcast/reconcile.ts, src/broadcast/finalize.ts);
// - lockdownNow(), the ONE function both lockdown entry points call, a
//   keyholder's /lockdown (src/telegram/commands.ts) and the Lockdown
//   button of an approval notice (src/telegram/review.ts): the switch set
//   (src/auth/lockdown.ts, which keeps the first time), the log line, then
//   the immediate retention pass, run even when the switch was set already;
//   a pass that fails is logged by class and never undoes the switch. A
//   source scan pins that nothing else sets the switch
//   (test/invariants/lockdown.test.ts), so no entry point can leave the
//   pass unrun.
import { setLockdown } from '../auth/lockdown';
import type { Clock } from '../clock';
import type { Config } from '../config/schema';
import type { SqlDb } from '../db/sql';
import type { Logger } from '../privacy/logger';
import { retention } from '../privacy/retention';
import type { BotApiPort } from '../telegram/bot-api-port';
import { finalizeTerminal } from './finalize';
import { snapshot } from './stats';

/** What a maintenance pass works with: the bot's api, the configuration, the store, the clock, the logger. */
export interface MaintenanceDeps {
  readonly api: Pick<BotApiPort, 'sendMessage' | 'editMessageText' | 'editMessageReplyMarkup' | 'deleteMessage'>;
  readonly config: Config;
  readonly db: SqlDb;
  readonly clock: Clock;
  readonly logger: Logger;
}

/** An immediate retention pass. */
export type RetentionPass = (deps: MaintenanceDeps) => Promise<void>;

/** The retention job of the run at `now` (src/privacy/retention.ts). Throws only a storage failure. */
export const runRetention: (deps: MaintenanceDeps, now: number) => Promise<void> = async (deps, now) => {
  await retention(deps, now);
};

/** The immediate retention pass a lockdown triggers: the retention job, now. */
export const runRetentionNow: RetentionPass = (deps) => runRetention(deps, deps.clock.now());

/** The monthly stats snapshot of the run at `now` (src/broadcast/stats.ts). Throws only a storage failure. */
export const runSnapshot: (deps: MaintenanceDeps, now: number) => Promise<void> = (deps, now) => snapshot(deps, now);

/**
 * The finalization of report `reportId`, a closed, retracted or expired one
 * whose finalization never landed (src/broadcast/finalize.ts): nothing for
 * any other. Throws only a storage failure.
 */
export const finalize: (deps: MaintenanceDeps, reportId: string, now: number) => Promise<void> = async (deps, reportId, now) => {
  await finalizeTerminal(deps, reportId, now);
};

export interface LockdownNowDeps extends MaintenanceDeps {
  /** The pass to run: runRetentionNow unless given (tests pass a spy). */
  readonly retentionNow?: RetentionPass;
}

/**
 * Locks the bot down (see the header). True when this call set the switch,
 * false when it was set already; the pass runs either way. Throws only when
 * the switch cannot be written.
 */
export async function lockdownNow(deps: LockdownNowDeps): Promise<boolean> {
  const set = await setLockdown(deps.db, deps.clock);
  if (set) deps.logger.log('lockdown.set');
  try {
    await (deps.retentionNow ?? runRetentionNow)(deps);
  } catch (error) {
    deps.logger.logError('retention.failed', error);
  }
  return set;
}

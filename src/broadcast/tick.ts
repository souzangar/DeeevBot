// @critical-path
// The one-minute run (critical invariants 1, 2, 5 and 8; the MVP plan,
// section 2, "Worker scheduled"; ADR 0004, "Scheduling"). The Worker's one
// cron, `* * * * *` (TICK_CRON), arrives at handleScheduled(), which
// dispatches on the cron expression and hands tick() to the invocation's
// waitUntil; the Node port's minute loop calls tick() itself. tick(deps,
// now) runs, in order:
// 1. the state, in one query (src/broadcast/state.ts): the lockdown and its
//    alert's marker, /halt, the pause; with the LOCKDOWN override;
// 2. the lockdown alert: under lockdown, once, to the keyholders only (the
//    venue is compromised by assumption), on the run after a keyholder set
//    the switch, and otherwise on a 15th minute, until at least one
//    keyholder got it (`meta.lockdown_alerted_at` marks that; one delivered
//    of several suffices, as for the approval notice, the misses logged
//    with their counts); once neither layer holds the bot, a marker left
//    behind (the override lifted) is forgotten, so the next lockdown alerts
//    again;
// 3. at most ONE post (src/broadcast/post.ts), unless locked down, halted
//    or paused; the claim binds all three again in its own statement;
// 4. at most EDIT_JOBS_PER_TICK edit jobs (src/broadcast/edits.ts), unless
//    paused or the post met a 429; under lockdown or /halt retractions
//    only;
// 5. by the UTC minute of `now`: reconcile() on every 15th minute, the
//    retention job at 00:15 and the monthly snapshot on the first day at
//    06:00 (both the closure and retention unit's slots,
//    src/broadcast/maintenance.ts), under lockdown too: retention reduces
//    exposure.
// `now` is the run's scheduled time: the minute schedule and the due checks
// use it; the claim and every record take the clock's own time.
// The alarm-handler rule: nothing escapes tick(), and handleScheduled()
// never throws, since a throwing cron handler could be retried by the
// platform. A storage failure (a daily cap among them) stops the run where
// it is, without another write (the next run, after the 00:00 UTC reset
// for a cap, resumes from what was committed), and alerts the keyholders:
// from one isolate at most once a UTC day, and on a 15th minute only, so a
// store that stays down never floods them. Any other failure is logged by
// class, and the run ends normally.
import { forgetLockdownAlert, markLockdownAlerted } from '../auth/lockdown';
import { utcDay } from '../clock';
import { t } from '../i18n/index';
import { alertKeyholders } from '../telegram/alerts';
import { runEditJobs, type EditHandlers } from './edits';
import { runRetention, runSnapshot, type MaintenanceDeps } from './maintenance';
import { runPostJob, type PostDeps, type PostOutcome } from './post';
import { reconcile, RECONCILE_EVERY_MINUTES } from './reconcile';
import { inBothLocales } from './report-alerts';
import { isPaused, isStorageFailure, readTickState, type TickState } from './state';

/** The Worker's one cron expression: every minute (wrangler.jsonc). */
export const TICK_CRON = '* * * * *';

/** The lockdown alert goes out on the first run within this time of the switch being set. */
export const LOCKDOWN_ALERT_FRESH_MS = 2 * 60_000;

/** The passes a run starts by the minute; the defaults unless a test passes its own. */
export interface TickHooks {
  readonly reconcile: (deps: TickDeps, now: number, state: TickState) => Promise<unknown>;
  readonly retention: (deps: MaintenanceDeps, now: number) => Promise<void>;
  readonly snapshot: (deps: MaintenanceDeps, now: number) => Promise<void>;
  readonly finalize: (deps: MaintenanceDeps, reportId: string, now: number) => Promise<void>;
}

/** This isolate's memory of the storage alert: the UTC day it last went out. */
export interface StorageAlertMemory {
  lastDay: string | null;
}

/** The isolate's own, which the runs use unless given another (tests do). */
export const isolateStorageAlerts: StorageAlertMemory = { lastDay: null };

export interface TickDeps extends PostDeps {
  /** The edit jobs' handlers: EDIT_HANDLERS unless given. */
  readonly edits?: EditHandlers;
  readonly hooks?: Partial<TickHooks>;
  readonly storageAlerts?: StorageAlertMemory;
}

/** What one run did. */
export interface TickOutcome {
  readonly post: PostOutcome | 'skipped';
  readonly edits: number;
  readonly ran: readonly ('reconcile' | 'retention' | 'snapshot')[];
  /** Why the run stopped short: a storage failure, or any other. */
  readonly stopped?: 'storage' | 'failure';
}

interface Progress {
  post: PostOutcome | 'skipped';
  edits: number;
  ran: ('reconcile' | 'retention' | 'snapshot')[];
}

/** The UTC minute, hour and day of the month of `now`. */
const utcParts = (now: number): { readonly minute: number; readonly hour: number; readonly day: number } => {
  const at = new Date(now);
  return { minute: at.getUTCMinutes(), hour: at.getUTCHours(), day: at.getUTCDate() };
};

const isReconcileMinute = (now: number): boolean => utcParts(now).minute % RECONCILE_EVERY_MINUTES === 0;

/** The lockdown alert of step 2 (see the header). Throws only a storage failure. */
async function lockdownAlert(deps: TickDeps, state: TickState, now: number): Promise<void> {
  if (!state.locked) {
    if (state.lockdownAlerted) await forgetLockdownAlert(deps.db);
    return;
  }
  if (state.lockdownAlerted) return;
  const fresh = state.lockdownSetAt !== null && now - state.lockdownSetAt < LOCKDOWN_ALERT_FRESH_MS;
  if (!fresh && !isReconcileMinute(now)) return;
  let outcome;
  try {
    outcome = await alertKeyholders(deps, inBothLocales((locale) => t(locale, 'alert.lockdown')));
  } catch (error) {
    deps.logger.logError('alert.failed', error);
    return;
  }
  if (outcome.sent > 0) await markLockdownAlerted(deps.db, now);
  deps.logger.log(outcome.failed === 0 ? 'lockdown.alerted' : 'lockdown.alert_incomplete', { sent: outcome.sent, failed: outcome.failed });
}

/** The storage alert (see the header). Never throws. */
async function alertStorage(deps: TickDeps, now: number): Promise<void> {
  const memory = deps.storageAlerts ?? isolateStorageAlerts;
  const day = utcDay(now);
  if (!isReconcileMinute(now) || memory.lastDay === day) return;
  try {
    const outcome = await alertKeyholders(deps, inBothLocales((locale) => t(locale, 'alert.storage')));
    if (outcome.sent > 0) memory.lastDay = day;
    deps.logger.log('tick.storage_alerted', { sent: outcome.sent, failed: outcome.failed });
  } catch (error) {
    deps.logger.logError('alert.failed', error);
  }
}

async function run(deps: TickDeps, now: number, progress: Progress): Promise<void> {
  const state = await readTickState(deps.config, deps.db);
  await lockdownAlert(deps, state, now);
  const paused = isPaused(state, now);
  if (!state.locked && !state.halted && !paused) progress.post = await runPostJob(deps, now, state);
  if (!paused && progress.post !== 'rate_limited') progress.edits = (await runEditJobs(deps, now, state, deps.edits)).ran;
  const { minute, hour, day } = utcParts(now);
  if (minute % RECONCILE_EVERY_MINUTES === 0) {
    progress.ran.push('reconcile');
    await (deps.hooks?.reconcile ?? reconcile)(deps, now, state);
  }
  if (hour === 0 && minute === 15) {
    progress.ran.push('retention');
    await (deps.hooks?.retention ?? runRetention)(deps, now);
  }
  if (day === 1 && hour === 6 && minute === 0) {
    progress.ran.push('snapshot');
    await (deps.hooks?.snapshot ?? runSnapshot)(deps, now);
  }
}

/** One run at `now` (see the header). Never throws. */
export async function tick(deps: TickDeps, now: number): Promise<TickOutcome> {
  const progress: Progress = { post: 'skipped', edits: 0, ran: [] };
  const outcome = (stopped?: 'storage' | 'failure'): TickOutcome => ({
    post: progress.post,
    edits: progress.edits,
    ran: [...progress.ran],
    ...(stopped === undefined ? {} : { stopped }),
  });
  try {
    await run(deps, now, progress);
    return outcome();
  } catch (error) {
    if (isStorageFailure(error)) {
      deps.logger.logError('tick.storage_failed', error);
      await alertStorage(deps, now);
      return outcome('storage');
    }
    deps.logger.logError('tick.failed', error);
    return outcome('failure');
  }
}

/**
 * The cron handler's dispatch (see the header): the one cron runs tick()
 * under the invocation's waitUntil; any other expression is logged and runs
 * nothing. Never throws.
 */
export function handleScheduled(
  controller: Pick<ScheduledController, 'cron' | 'scheduledTime'>,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
  deps: TickDeps,
): void {
  if (controller.cron !== TICK_CRON) {
    deps.logger.log('cron.unknown');
    return;
  }
  ctx.waitUntil(tick(deps, controller.scheduledTime));
}

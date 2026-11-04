// @critical-path
// The Node port's minute loop (critical invariant 1; ADR 0001 and ADR 0004,
// "Scheduling": on the Node port an in-process timer runs the same
// function as the Worker's one cron). The port's counterpart of the cron
// `* * * * *`: it calls `run`, the port's tick() (src/broadcast/tick.ts),
// once a minute at the minute's start, with that start as `now`, the way
// the cron hands tick() its scheduled time. tick() itself dispatches by the
// UTC minute of `now`: reconciliation on every 15th minute, the retention
// job at 00:15 and the monthly snapshot on the first day at 06:00, so the
// port schedules nothing but this loop.
// - Never two runs at once: a minute that comes while the run before it is
//   still going is skipped and logged (`tick.skipped`). The post's claim
//   would keep a post at most once even so (src/broadcast/post.ts), but the
//   loop does not lean on it.
// - Each minute at most once, and in order. The loop keeps the minute start
//   it armed the timer for: a timer that fires before it (Node's timers can
//   fire with Date.now() a millisecond short, and the wall clock may be set
//   back) runs nothing and is armed again for what is left, so minute M is
//   never run at M-1:59.999 in place of M-1 only to skip M while it runs.
//   A minute at or before the last one run is never run again.
// - A minute the process missed (stopped, asleep, its event loop blocked
//   past it) is not run late, as a cron invocation that never fired is not:
//   the timer runs the minute it fires in.
// - A run that rejects is logged by class (`tick.failed`) and ends nothing;
//   tick() itself never throws.
// - stop(): no further run starts; it waits for the one running.
// The timers are a port, so the tests fire the minutes themselves.
import type { Clock } from '../clock';
import type { Logger } from '../privacy/logger';

/** A minute, in milliseconds: the cron's period. */
export const MINUTE_MS = 60_000;

/** The timer functions the loop arms; the runtime's own in production. */
export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The runtime's timers. */
export const systemTimers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface MinuteLoopDeps {
  readonly clock: Pick<Clock, 'now'>;
  readonly timers: Timers;
  readonly logger: Logger;
  /** One run at the minute's start: the port's tick(). */
  readonly run: (minuteStart: number) => Promise<unknown>;
}

export interface MinuteLoop {
  /** Starts no further run, and resolves once the running one has ended. */
  stop(): Promise<void>;
}

/** The start of the minute `ms` falls in. */
export const minuteStart = (ms: number): number => ms - (((ms % MINUTE_MS) + MINUTE_MS) % MINUTE_MS);

/** Starts the loop of the header: its first run is at the next minute's start. */
export function startMinuteLoop(deps: MinuteLoopDeps): MinuteLoop {
  let stopped = false;
  let timer: unknown;
  let running: Promise<void> | null = null;
  let lastRun = Number.NEGATIVE_INFINITY;
  /** The minute start the timer is armed for. */
  let target = 0;

  /** Arms the timer for the start of the minute after `now`. */
  const arm = (now: number): void => {
    target = minuteStart(now) + MINUTE_MS;
    timer = deps.timers.setTimeout(fire, target - now);
  };

  function fire(): void {
    if (stopped) return;
    const now = deps.clock.now();
    if (now < target) {
      // Early, or the wall clock set back: nothing runs before the minute it was armed for.
      timer = deps.timers.setTimeout(fire, target - now);
      return;
    }
    const minute = minuteStart(now);
    arm(now);
    if (minute <= lastRun) return;
    if (running !== null) {
      deps.logger.log('tick.skipped');
      return;
    }
    lastRun = minute;
    const run = Promise.resolve()
      .then(() => deps.run(minute))
      .then(
        () => undefined,
        (error: unknown) => {
          deps.logger.logError('tick.failed', error);
        },
      );
    running = run;
    void run.then(() => {
      if (running === run) running = null;
    });
  }

  arm(deps.clock.now());
  return {
    stop: async () => {
      stopped = true;
      deps.timers.clearTimeout(timer);
      await running;
    },
  };
}

// Manual timers for tests (the Timers port of src/broadcast/minute-loop.ts),
// coupled to a fake clock (test/fakes/clock.ts): setTimeout() records the
// callback and its due time on that clock, and nothing fires until the test
// says so. fireNext() sets the clock to the earliest due time and runs that
// callback, so a test walks the minute loop through the minutes it names,
// whatever the real time is.
import type { Timers } from '../../src/broadcast/minute-loop';
import type { FakeClock } from './clock';

interface Pending {
  readonly due: number;
  readonly callback: () => void;
}

export interface ManualTimers extends Timers {
  /** The pending timers' due times, earliest first. */
  pending(): number[];
  /** Sets the clock to the earliest due time and runs that timer; false when none is pending. */
  fireNext(): boolean;
}

/** Timers that fire only through fireNext(), on `clock`. */
export function manualTimers(clock: FakeClock): ManualTimers {
  const timers = new Set<Pending>();
  const earliest = (): Pending | undefined => [...timers].sort((a, b) => a.due - b.due)[0];
  return {
    setTimeout: (callback, ms) => {
      const timer: Pending = { due: clock.now() + Math.max(0, ms), callback };
      timers.add(timer);
      return timer;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as Pending);
    },
    pending: () => [...timers].map((timer) => timer.due).sort((a, b) => a - b),
    fireNext: () => {
      const next = earliest();
      if (next === undefined) return false;
      timers.delete(next);
      clock.set(Math.max(clock.now(), next.due));
      next.callback();
      return true;
    },
  };
}

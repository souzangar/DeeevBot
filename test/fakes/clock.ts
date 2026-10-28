// The in-memory Clock for tests: time moves only when the test moves it.
import type { Clock } from '../../src/clock';

export interface FakeClock extends Clock {
  /** Moves the time by `ms` (backwards when negative). */
  advance(ms: number): void;
  /** Sets the time to `ms` since the epoch. */
  set(ms: number): void;
}

/** A clock that reads `start` until the test advances or sets it. */
export function fakeClock(start: number): FakeClock {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
    set: (ms) => {
      current = ms;
    },
  };
}

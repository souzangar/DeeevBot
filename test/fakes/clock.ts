// The in-memory Clock for tests: time moves only when the test moves it, or
// when the code under test sleeps: sleep() moves the time on by the wait at
// once and records it, so a test asserts how long the code waited without
// waiting itself.
import type { Clock } from '../../src/clock';

export interface FakeClock extends Clock {
  /** Moves the time by `ms` (backwards when negative). */
  advance(ms: number): void;
  /** Sets the time to `ms` since the epoch. */
  set(ms: number): void;
  /** Every wait the code under test asked for, in order (a negative one as 0). */
  readonly sleeps: readonly number[];
}

/** A clock that reads `start` until the test advances or sets it, or the code sleeps. */
export function fakeClock(start: number): FakeClock {
  let current = start;
  const sleeps: number[] = [];
  return {
    now: () => current,
    sleep: (ms) => {
      const wait = Math.max(0, ms);
      sleeps.push(wait);
      current += wait;
      return Promise.resolve();
    },
    advance: (ms) => {
      current += ms;
    },
    set: (ms) => {
      current = ms;
    },
    sleeps,
  };
}

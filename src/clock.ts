// The time port. Code that needs the current time takes a Clock, so tests
// drive time with the fake in test/fakes/clock.ts instead of the real clock.

export interface Clock {
  /** Milliseconds since the Unix epoch (UTC). */
  now(): number;
}

/**
 * The runtime's clock. On Workers, Date.now() does not advance during
 * synchronous execution, only across I/O; that is the granularity the
 * steps' timestamps need.
 */
export const systemClock: Clock = { now: () => Date.now() };

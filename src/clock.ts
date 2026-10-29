// The time port. Code that needs the current time takes a Clock, so tests
// drive time with the fake in test/fakes/clock.ts instead of the real clock.
// sleep() is the one wait the bot makes: the intake acknowledgement deletes
// itself from inside the same update's handling (src/telegram/intake.ts),
// and a test runs that wait instantly, with the fake moving its time on.

export interface Clock {
  /** Milliseconds since the Unix epoch (UTC). */
  now(): number;
  /** Resolves after `ms` milliseconds (at once for 0 or less). */
  sleep(ms: number): Promise<void>;
}

/**
 * The runtime's clock. On Workers, Date.now() does not advance during
 * synchronous execution, only across I/O; that is the granularity the
 * steps' timestamps need. A timer is I/O, so the time read after sleep()
 * has moved on. On Workers the wait counts against the invocation's
 * lifetime after the response (30 seconds under waitUntil), never against
 * its CPU time.
 */
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, Math.max(0, ms));
    }),
};

/** The UTC day of `ms`, `YYYY-MM-DD`, as the `day` and `*_day` columns hold it. */
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * The UTC minute of `ms`, `YYYY-MM-DD HH:MM UTC`, as the review's messages
 * name an approval's start (the seconds dropped, never rounded up: a post
 * goes out at the start or after it).
 */
export const utcMinute = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

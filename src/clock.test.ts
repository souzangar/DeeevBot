// Unit tests for the Clock port: the system clock, its sleep() over the
// runtime's timer, and the fake that tests use instead (test/fakes/clock.ts),
// whose sleep() moves its time on at once.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeClock } from '../test/fakes/clock';
import { systemClock } from './clock';

describe('systemClock', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the current time in milliseconds since the epoch', () => {
    const before = Date.now();
    const now = systemClock.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it('is Date.now(), so it follows the runtime clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 28, 0, 5));
    expect(systemClock.now()).toBe(Date.UTC(2026, 9, 28, 0, 5));
  });

  it('sleeps on the runtime timer, and not at all for a negative wait', async () => {
    vi.useFakeTimers();
    let woke = false;
    const sleeping = systemClock.sleep(20_000).then(() => {
      woke = true;
    });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(woke).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await sleeping;
    expect(woke).toBe(true);
    const negative = systemClock.sleep(-5);
    await vi.advanceTimersByTimeAsync(0);
    await expect(negative).resolves.toBeUndefined();
  });
});

describe('fakeClock', () => {
  it('reads its start time until the test moves it', () => {
    const clock = fakeClock(1_000);
    expect(clock.now()).toBe(1_000);
    expect(clock.now()).toBe(1_000);
  });

  it('advances by a duration and jumps to a time', () => {
    const clock = fakeClock(1_000);
    clock.advance(250);
    expect(clock.now()).toBe(1_250);
    clock.advance(-50);
    expect(clock.now()).toBe(1_200);
    clock.set(Date.UTC(2026, 9, 29));
    expect(clock.now()).toBe(Date.UTC(2026, 9, 29));
  });

  it('sleeps by moving its time on at once, and records each wait', async () => {
    const clock = fakeClock(1_000);
    await clock.sleep(20_000);
    await clock.sleep(-3);
    expect(clock.now()).toBe(21_000);
    expect(clock.sleeps).toEqual([20_000, 0]);
  });
});

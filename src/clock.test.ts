// Unit tests for the Clock port: the system clock, and the fake that tests
// use instead (test/fakes/clock.ts).
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
});

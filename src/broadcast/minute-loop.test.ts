// Unit tests for the Node port's minute loop (src/broadcast/minute-loop.ts;
// critical invariant 1), over a fake clock and manual timers: one run at
// each minute's start with that start as `now`; never two runs at once (a
// minute that comes while a run is still going is skipped and logged);
// each minute at most once and in order; a missed minute not run late; a
// rejected run logged by class; stop() starting nothing more and waiting
// for the running one.
import { describe, expect, it } from 'vitest';
import { fakeClock } from '../../test/fakes/clock';
import { recordingLogger } from '../../test/fakes/logger';
import { manualTimers } from '../../test/fakes/timers';
import { MINUTE_MS, minuteStart, startMinuteLoop, type Timers } from './minute-loop';

const at = (hour: number, minute: number, second = 0, ms = 0): number => Date.UTC(2027, 0, 15, hour, minute, second, ms);

/** A run that records its minute, and waits for release() when `hold` is set. */
const runs = () => {
  const started: number[] = [];
  const releases: (() => void)[] = [];
  let hold = false;
  let active = 0;
  let mostAtOnce = 0;
  const run = async (minute: number): Promise<void> => {
    started.push(minute);
    active += 1;
    mostAtOnce = Math.max(mostAtOnce, active);
    if (hold) await new Promise<void>((resolve) => releases.push(resolve));
    active -= 1;
  };
  return {
    run,
    started,
    holdRuns: (value: boolean) => {
      hold = value;
    },
    release: () => {
      for (const resolve of releases.splice(0)) resolve();
    },
    mostAtOnce: () => mostAtOnce,
  };
};

/** Lets the loop's promise chain settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe('minuteStart', () => {
  it('is the start of the minute a time falls in', () => {
    expect(minuteStart(at(12, 0, 0))).toBe(at(12, 0, 0));
    expect(minuteStart(at(12, 0, 59, 999))).toBe(at(12, 0, 0));
    expect(minuteStart(at(12, 1, 0, 1))).toBe(at(12, 1, 0));
    expect(minuteStart(-1)).toBe(-MINUTE_MS);
  });
});

describe('the minute loop', () => {
  it("runs once a minute at the minute's start, with that start as now, the first at the next minute's start", async () => {
    const clock = fakeClock(at(12, 0, 30));
    const timers = manualTimers(clock);
    const log = recordingLogger();
    const spy = runs();
    const loop = startMinuteLoop({ clock, timers, logger: log.logger, run: spy.run });
    expect(timers.pending()).toEqual([at(12, 1)]);
    expect(spy.started).toEqual([]);
    for (let i = 0; i < 3; i += 1) {
      timers.fireNext();
      await settle();
    }
    expect(spy.started).toEqual([at(12, 1), at(12, 2), at(12, 3)]);
    expect(timers.pending()).toEqual([at(12, 4)]);
    expect(log.lines).toEqual([]);
    await loop.stop();
  });

  it('never runs two at once: a minute that comes while the run before it is going is skipped and logged', async () => {
    const clock = fakeClock(at(12, 0, 30));
    const timers = manualTimers(clock);
    const log = recordingLogger();
    const spy = runs();
    const loop = startMinuteLoop({ clock, timers, logger: log.logger, run: spy.run });
    spy.holdRuns(true);
    timers.fireNext();
    await settle();
    timers.fireNext();
    timers.fireNext();
    await settle();
    expect(spy.started).toEqual([at(12, 1)]);
    expect(log.records()).toEqual([
      { level: 'info', event: 'tick.skipped' },
      { level: 'info', event: 'tick.skipped' },
    ]);
    spy.holdRuns(false);
    spy.release();
    await settle();
    timers.fireNext();
    await settle();
    expect(spy.started).toEqual([at(12, 1), at(12, 4)]);
    expect(spy.mostAtOnce()).toBe(1);
    await loop.stop();
  });

  it('never runs a minute twice or out of order: a timer that fires early, or the clock set back', async () => {
    const clock = fakeClock(at(12, 0, 30));
    const armed: { callback: () => void; ms: number }[] = [];
    const timers: Timers = {
      setTimeout: (callback, ms) => armed.push({ callback, ms }),
      clearTimeout: () => undefined,
    };
    const spy = runs();
    const loop = startMinuteLoop({ clock, timers, logger: recordingLogger().logger, run: spy.run });
    expect(armed.at(-1)?.ms).toBe(30_000);
    clock.set(at(12, 1));
    armed.at(-1)?.callback();
    await settle();
    // The next timer fires a millisecond early: nothing runs, and it is armed again for the minute's start.
    clock.set(at(12, 1, 59, 999));
    armed.at(-1)?.callback();
    await settle();
    expect(armed.at(-1)?.ms).toBe(1);
    // The wall clock set back by a few minutes: nothing runs until a later minute.
    clock.set(at(11, 58, 0));
    armed.at(-1)?.callback();
    await settle();
    clock.set(at(12, 2));
    armed.at(-1)?.callback();
    await settle();
    expect(spy.started).toEqual([at(12, 1), at(12, 2)]);
    await loop.stop();
  });

  it('never runs a minute a millisecond early: the first timer, or one after a skipped minute, fired short of its minute waits for it', async () => {
    const clock = fakeClock(at(12, 0, 30));
    const armed: { callback: () => void; ms: number }[] = [];
    const timers: Timers = {
      setTimeout: (callback, ms) => armed.push({ callback, ms }),
      clearTimeout: () => undefined,
    };
    const log = recordingLogger();
    const spy = runs();
    const loop = startMinuteLoop({ clock, timers, logger: log.logger, run: spy.run });
    // The first timer, armed for 12:01, fires with the clock a millisecond short of it.
    clock.set(at(12, 0, 59, 999));
    armed.at(-1)?.callback();
    await settle();
    expect(spy.started).toEqual([]);
    expect(armed.at(-1)?.ms).toBe(1);
    clock.set(at(12, 1));
    armed.at(-1)?.callback();
    await settle();
    expect(spy.started).toEqual([at(12, 1)]);
    // 12:02 comes while 12:01 still runs, and is skipped; 12:03's timer then fires a millisecond short.
    spy.holdRuns(true);
    spy.release();
    clock.set(at(12, 2));
    armed.at(-1)?.callback();
    await settle();
    expect(spy.started).toEqual([at(12, 1), at(12, 2)]);
    clock.set(at(12, 3));
    armed.at(-1)?.callback();
    await settle();
    expect(log.records()).toEqual([{ level: 'info', event: 'tick.skipped' }]);
    spy.holdRuns(false);
    spy.release();
    await settle();
    clock.set(at(12, 3, 59, 999));
    armed.at(-1)?.callback();
    await settle();
    expect(spy.started).toEqual([at(12, 1), at(12, 2)]);
    expect(armed.at(-1)?.ms).toBe(1);
    clock.set(at(12, 4));
    armed.at(-1)?.callback();
    await settle();
    expect(spy.started).toEqual([at(12, 1), at(12, 2), at(12, 4)]);
    expect(spy.mostAtOnce()).toBe(1);
    await loop.stop();
  });

  it('runs a missed minute never late: the timer runs the minute it fires in', async () => {
    const clock = fakeClock(at(12, 0, 30));
    const armed: { callback: () => void; ms: number }[] = [];
    const timers: Timers = {
      setTimeout: (callback, ms) => armed.push({ callback, ms }),
      clearTimeout: () => undefined,
    };
    const spy = runs();
    const loop = startMinuteLoop({ clock, timers, logger: recordingLogger().logger, run: spy.run });
    // The process was asleep from before 12:01 to 12:05:20.
    clock.set(at(12, 5, 20));
    armed.at(-1)?.callback();
    await settle();
    expect(spy.started).toEqual([at(12, 5)]);
    expect(armed.at(-1)?.ms).toBe(40_000);
    await loop.stop();
  });

  it('logs a run that rejects by class, and goes on with the next minute', async () => {
    const clock = fakeClock(at(12, 0, 30));
    const timers = manualTimers(clock);
    const log = recordingLogger();
    const started: number[] = [];
    const run = (minute: number): Promise<void> => {
      started.push(minute);
      return started.length === 1 ? Promise.reject(new TypeError('a report https://x.com/someone 424240031')) : Promise.resolve();
    };
    const loop = startMinuteLoop({ clock, timers, logger: log.logger, run });
    timers.fireNext();
    await settle();
    timers.fireNext();
    await settle();
    expect(started).toEqual([at(12, 1), at(12, 2)]);
    expect(log.records()).toEqual([{ level: 'error', event: 'tick.failed', errorClass: 'TypeError' }]);
    expect(log.text()).not.toContain('x.com');
    await loop.stop();
  });

  it('stop() starts no further run and waits for the running one', async () => {
    const clock = fakeClock(at(12, 0, 30));
    const timers = manualTimers(clock);
    const spy = runs();
    const loop = startMinuteLoop({ clock, timers, logger: recordingLogger().logger, run: spy.run });
    spy.holdRuns(true);
    timers.fireNext();
    await settle();
    let stopped = false;
    const stopping = loop.stop().then(() => {
      stopped = true;
    });
    await settle();
    expect(stopped).toBe(false);
    expect(timers.pending()).toEqual([]);
    spy.release();
    await stopping;
    expect(stopped).toBe(true);
    expect(spy.started).toEqual([at(12, 1)]);
  });

  it('stop() with no run going resolves at once and clears the timer', async () => {
    const clock = fakeClock(at(12, 0, 30));
    const timers = manualTimers(clock);
    const spy = runs();
    const loop = startMinuteLoop({ clock, timers, logger: recordingLogger().logger, run: spy.run });
    await loop.stop();
    expect(timers.pending()).toEqual([]);
    expect(timers.fireNext()).toBe(false);
    expect(spy.started).toEqual([]);
  });
});

// Unit tests for the edit jobs' runner (src/broadcast/edits.ts; critical
// invariants 1, 2 and 5), through the run over the fakes with handlers of
// the test's own in the registry's place (the registry itself holds the
// closure unit's two, src/broadcast/closure.ts and retraction.ts, whose
// own tests drive them): due jobs of a registered action
// only, the oldest first, at most EDIT_JOBS_PER_TICK a run; under lockdown
// or /halt retractions only; a failure recorded on its own job while the
// next one runs; a 429 that reschedules, pauses and ends the run's edits; a
// storage failure that stops the run; none run while paused; a job whose row
// it cannot read logged by class, its report flagged for the alert, the
// failure recorded on the job.
import { describe, expect, it } from 'vitest';
import { setLockdown } from '../auth/lockdown';
import { sql, type SqlDb } from '../db/sql';
import { AppError } from '../errors/app-error';
import { rateLimited } from '../../test/fakes/bot-api';
import { insertReport, reportRow } from '../../test/support/review-rows';
import { TICK_AT, tickHarness, type TickHarness } from '../../test/support/tick-harness';
import { IDS } from '../../test/support/variables';
import { EDIT_HANDLERS, EDIT_JOBS_PER_TICK, EDIT_RETRY_MAX_MS, EDIT_RETRY_MS, runnableActions, type EditHandler, type EditHandlers, type EditJob } from './edits';
import { closeEdit } from './closure';
import { enqueueEditStatement, type EditingStatus } from './jobs';
import { retractEdit } from './retraction';

/** A report in `status` with its edit job, due at `dueAt`. */
const planted = async (harness: TickHarness, status: EditingStatus, dueAt: number = TICK_AT): Promise<string> => {
  const reportId = await insertReport(harness.db, { status });
  const statement = enqueueEditStatement({ reportId, status, dueAt, now: dueAt });
  await harness.db.run(statement.sql, statement.params);
  return reportId;
};

const jobRows = (db: SqlDb) => db.all(sql`SELECT report_id, due_at, attempts FROM jobs WHERE kind = 'edit' ORDER BY due_at, report_id`);

/** Handlers that record the jobs they get, and do what `act` says. */
const recording = (act: (job: EditJob) => Promise<void> = () => Promise.resolve()) => {
  const seen: EditJob[] = [];
  const handler: EditHandler = (_deps, job) => {
    seen.push(job);
    return act(job);
  };
  return { seen, handlers: { close: handler, retract: handler } satisfies EditHandlers };
};

describe('the edit runner', () => {
  it('registers one handler per action, the closure and the retraction, frozen', () => {
    expect(Object.keys(EDIT_HANDLERS).sort()).toEqual(['close', 'retract']);
    expect(EDIT_HANDLERS.close).toBe(closeEdit);
    expect(EDIT_HANDLERS.retract).toBe(retractEdit);
    expect(Object.isFrozen(EDIT_HANDLERS)).toBe(true);
  });

  it('with no handler registered, a run runs none, reading the due jobs once', async () => {
    const harness = tickHarness({ edits: {} });
    const closing = await planted(harness, 'closing');
    harness.reset();
    expect((await harness.run()).edits).toBe(0);
    // The state read, the post's due query, and one read of the due edit jobs for an unreadable one.
    expect(harness.tally.queries).toBe(3);
    expect(await jobRows(harness.db)).toEqual([{ report_id: closing, due_at: TICK_AT, attempts: 0 }]);
  });

  it('logs a job it cannot read by class, flags its report for the alert, and records the failure on the job', async () => {
    const { seen, handlers } = recording();
    for (const registry of [{}, handlers] as const) {
      const harness = tickHarness({ edits: registry });
      const unknownAction = await insertReport(harness.db, { status: 'closing' });
      const noAction = await insertReport(harness.db, { status: 'retracting' });
      await harness.db.run(
        sql`INSERT INTO jobs (id, kind, report_id, due_at, payload, attempts, created_at) VALUES ('unknownactionjobxxxx', 'edit', ?, ?, '{"action":"expire"}', 0, 1), ('noactionjobxxxxxxxxx', 'edit', ?, ?, '{}', 2, 1)`,
        [unknownAction, TICK_AT - 2_000, noAction, TICK_AT - 1_000],
      );
      await harness.run();
      expect(seen).toEqual([]);
      for (const id of [unknownAction, noAction]) expect((await reportRow(harness.db, id))?.needs_attention).toBe(1);
      expect(await jobRows(harness.db)).toEqual([
        { report_id: unknownAction, due_at: TICK_AT + EDIT_RETRY_MS, attempts: 1 },
        { report_id: noAction, due_at: TICK_AT + 3 * EDIT_RETRY_MS, attempts: 3 },
      ]);
      expect(harness.log.records()).toEqual([
        { level: 'error', event: 'edit.unreadable', reportId: unknownAction, errorClass: 'AppError', errorCode: 'UNEXPECTED' },
        { level: 'error', event: 'edit.unreadable', reportId: noAction, errorClass: 'AppError', errorCode: 'UNEXPECTED' },
      ]);
      // Back after the back-off, not before.
      expect((await harness.run(TICK_AT + 30_000)).edits).toBe(0);
      expect(harness.log.records()).toHaveLength(2);
    }
  });

  it('runs the due jobs of a registered action, the oldest first, at most EDIT_JOBS_PER_TICK a run', async () => {
    const { seen, handlers } = recording();
    const harness = tickHarness({ edits: handlers });
    const ids: string[] = [];
    for (let n = 0; n < EDIT_JOBS_PER_TICK + 2; n += 1) ids.push(await planted(harness, n % 2 === 0 ? 'closing' : 'retracting', TICK_AT - (10 - n) * 1_000));
    await planted(harness, 'closing', TICK_AT + 60_000);
    expect((await harness.run()).edits).toBe(EDIT_JOBS_PER_TICK);
    expect(seen.map((job) => job.reportId)).toEqual(ids.slice(0, EDIT_JOBS_PER_TICK));
    expect(seen.map((job) => job.action)).toEqual(['close', 'retract', 'close']);
  });

  it('leaves a job of an action without a handler waiting, holding back none', async () => {
    const seen: EditJob[] = [];
    const harness = tickHarness({
      edits: {
        retract: (_deps, job) => {
          seen.push(job);
          return Promise.resolve();
        },
      },
    });
    for (let n = 0; n < EDIT_JOBS_PER_TICK; n += 1) await planted(harness, 'closing', TICK_AT - 60_000);
    const retraction = await planted(harness, 'retracting');
    await harness.run();
    expect(seen.map((job) => job.reportId)).toEqual([retraction]);
  });

  it.each(['switch', 'halt'] as const)('runs retractions only under the %s', async (hold) => {
    const { seen, handlers } = recording();
    const harness = tickHarness({ edits: handlers });
    await planted(harness, 'closing', TICK_AT - 1_000);
    const retraction = await planted(harness, 'retracting');
    if (hold === 'switch') await setLockdown(harness.db, harness.clock);
    else await harness.db.run(sql`INSERT INTO meta (key, value) VALUES ('halted', 1)`);
    await harness.run();
    expect(seen.map((job) => job.reportId)).toEqual([retraction]);
    expect(runnableActions({ locked: true, halted: false }, handlers)).toEqual(['retract']);
    expect(runnableActions({ locked: false, halted: true }, handlers)).toEqual(['retract']);
    expect(runnableActions({ locked: false, halted: false }, handlers)).toEqual(['close', 'retract']);
  });

  it('runs retractions only under the LOCKDOWN override', async () => {
    const { seen, handlers } = recording();
    const harness = tickHarness({ variables: { LOCKDOWN: '1' }, edits: handlers });
    await planted(harness, 'closing', TICK_AT - 1_000);
    const retraction = await planted(harness, 'retracting');
    await harness.run();
    expect(seen.map((job) => job.reportId)).toEqual([retraction]);
  });

  it('records a failure on its own job, with a back-off, and goes on to the next job', async () => {
    const { seen, handlers } = recording((job) => (job.attempts === 0 && seen.length === 1 ? Promise.reject(new Error('the edit failed')) : Promise.resolve()));
    const harness = tickHarness({ edits: handlers });
    const failing = await planted(harness, 'closing', TICK_AT - 2_000);
    const next = await planted(harness, 'retracting', TICK_AT - 1_000);
    await harness.run();
    expect(seen.map((job) => job.reportId)).toEqual([failing, next]);
    expect(await jobRows(harness.db)).toEqual(
      expect.arrayContaining([{ report_id: failing, due_at: TICK_AT + EDIT_RETRY_MS, attempts: 1 }]),
    );
    expect(harness.log.records()).toEqual([{ level: 'error', event: 'edit.failed', reportId: failing, attempts: 1, errorClass: 'Error' }]);
    expect(Math.min(EDIT_RETRY_MS * 20, EDIT_RETRY_MAX_MS)).toBe(EDIT_RETRY_MAX_MS);
  });

  it('on a 429, moves the job and the global pause to now plus retry_after, and ends the run\'s edits', async () => {
    const harness = tickHarness({
      edits: {
        close: async (deps) => {
          await deps.api.editMessageText(IDS.broadcastChannel, 1, 'an edit');
        },
      },
    });
    harness.telegram.seedMessage(IDS.broadcastChannel, { message_id: 1, text: 'the post' });
    harness.telegram.fail({ method: 'editMessageText' }, rateLimited(30));
    const first = await planted(harness, 'closing', TICK_AT - 2_000);
    await planted(harness, 'closing', TICK_AT - 1_000);
    expect((await harness.run()).edits).toBe(1);
    expect(await jobRows(harness.db)).toEqual(expect.arrayContaining([{ report_id: first, due_at: TICK_AT + 30_000, attempts: 1 }]));
    expect(await harness.db.first(sql`SELECT value FROM meta WHERE key = 'paused_until'`)).toEqual({ value: TICK_AT + 30_000 });
    expect(harness.telegram.count('editMessageText')).toBe(1);
    // Paused: the next run edits nothing until the pause has passed.
    harness.clock.advance(10_000);
    expect((await harness.run(TICK_AT + 10_000)).edits).toBe(0);
  });

  it('lets a storage failure stop the run', async () => {
    const harness = tickHarness({ edits: { close: () => Promise.reject(new AppError('STORAGE_FAILURE', 'down')) } });
    await planted(harness, 'closing');
    expect(await harness.run()).toMatchObject({ edits: 0, stopped: 'storage' });
    expect(await jobRows(harness.db)).toEqual([expect.objectContaining({ attempts: 0 })]);
  });
});

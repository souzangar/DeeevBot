// A store around the harness's database for the review's tests, and a bot
// harness whose review (not the intake) runs over it: the approval's batch,
// the one whose first statement writes the approval row, replaced by a
// test's own (one that does something first, as a keyholder pressing the
// notice's Lockdown while the batch is on its way, one that fails, one
// that fails after committing), and reads failed on demand; every other
// statement passes through. Fixture values are never secret-shaped.
import type { SqlDb, SqlRunResult, SqlStatement, SqlText, SqlValue } from '../../src/db/sql';
import { reviewFeatures } from '../../src/telegram/review';
import { botHarness, type BotHarness, type HarnessOptions } from './bot-harness';

/** The approval's batch: the one whose first statement writes the approval row. */
export const isApprovalBatch = (statements: readonly SqlStatement[]): boolean => String(statements[0]?.sql).startsWith('INSERT INTO approvals');

export interface StoreHooks {
  /** Runs in place of the approval's batch. */
  readonly batch?: (statements: readonly SqlStatement[]) => Promise<SqlRunResult[]>;
  /** Asked before every first(): a failure to answer with instead, or undefined to read. */
  readonly first?: () => Promise<never> | undefined;
}

/** `db`, with `hooks` (see the header). */
export const storeWith = (db: SqlDb, hooks: StoreHooks): SqlDb => ({
  run: (text, params) => db.run(text, params),
  all: <T extends object>(text: SqlText, params?: readonly SqlValue[]) => db.all<T>(text, params),
  first: <T extends object>(text: SqlText, params?: readonly SqlValue[]) => hooks.first?.() ?? db.first<T>(text, params),
  batch: (statements) => (hooks.batch !== undefined && isApprovalBatch(statements) ? hooks.batch(statements) : db.batch(statements)),
});

/**
 * A bot harness whose review runs over `over(the harness's store, the
 * harness)`: the harness is there by the time any update is handled.
 */
export function harnessOver(over: (db: SqlDb, harness: () => BotHarness) => SqlDb, options: Omit<HarnessOptions, 'features'> = {}): BotHarness {
  const built: { harness?: BotHarness } = {};
  const self = (): BotHarness => {
    if (built.harness === undefined) throw new Error('the harness is not built yet');
    return built.harness;
  };
  const harness = botHarness({ ...options, features: (deps) => [reviewFeatures({ ...deps, db: over(deps.db, self) })] });
  built.harness = harness;
  return harness;
}

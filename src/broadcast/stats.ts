// @critical-path
// The counts (critical invariants 3, 5 and 8; the MVP plan, sections 1 and
// 4, "Admin commands" and "Retention"; doc/product/retention-and-minimisation.md,
// "What survives" and "Backups, Time Travel and the emergency wipe"): what
// the bot tells about reports in bulk is read from the aggregate rows alone
// (`stats`), never from a report, so no URL, comment, reference or id can be
// in it. A period's counts are the reports concluded in it, by the UTC day
// of their finalization (`closed_day`): their number by outcome, by category
// and by platform (the lines that are not zero, in a fixed order), and
// their "I reported it" presses, labelled advisory, since presses count
// presses, not people.
// - /stats [YYYY-MM] (src/telegram/closing.ts): this month so far, or the
//   month given, to an admin in the venue or to a keyholder in their own
//   chat (under lockdown too), in the reader's language there.
// - The monthly snapshot (snapshot(), the run's slot on the first day of the
//   month at 06:00 UTC, src/broadcast/maintenance.ts): the previous month,
//   to every keyholder in both locales and to the venue in its language
//   unless the bot is locked down (alertVenue() reads the switch itself);
//   the only export the bot makes. A send that fails is logged by class; a
//   storage failure stops the run.
// - /budget: the day's counters, the presses counted against MARKS_PER_DAY
//   and the reports from non-members against their global cap.
import { utcDay } from '../clock';
import type { Config } from '../config/schema';
import { sql, type SqlDb, type SqlValue } from '../db/sql';
import { t, type Locale } from '../i18n/index';
import { PLATFORM_NAME_KEYS } from '../platforms/instructions';
import { isPlatform, PLATFORMS, type Platform } from '../platforms/platforms';
import { CATEGORIES, isCategory, type Category } from '../review/categories';
import { INTAKE_LIMITS, NON_MEMBER_COUNTER } from '../review/intake';
import { CATEGORY_NAME_KEYS, outcomeNameKey } from '../review/names';
import { PRESS_COUNTER } from '../telegram/presses';
import type { MaintenanceDeps } from './maintenance';
import { alertEveryone } from './report-alerts';
import { isStorageFailure } from './state';

/** A month of UTC days: its label (`YYYY-MM`) and the days from `from` up to, not including, `to`. */
export interface StatsPeriod {
  readonly label: string;
  readonly from: string;
  readonly to: string;
}

/** The month `month` (0 for January; out of range rolls over) of `year`. */
export function monthPeriod(year: number, month: number): StatsPeriod {
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 1));
  return { label: start.toISOString().slice(0, 7), from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

/** The UTC month of `now`. */
export const currentMonth = (now: number): StatsPeriod => monthPeriod(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth());

/** The UTC month before the month of `now`. */
export const previousMonth = (now: number): StatsPeriod => monthPeriod(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() - 1);

const MONTH = /^(2[0-9]{3})-(0[1-9]|1[0-2])$/;

/** The month `YYYY-MM` names (years 2000 to 2999), or null. */
export function parseMonth(text: string): StatsPeriod | null {
  const match = MONTH.exec(text.trim());
  return match === null ? null : monthPeriod(Number(match[1]), Number(match[2]) - 1);
}

/** A period's counts (see the header). */
export interface StatsTally {
  readonly total: number;
  readonly presses: number;
  readonly outcomes: ReadonlyMap<string, number>;
  readonly categories: ReadonlyMap<Category, number>;
  readonly platforms: ReadonlyMap<Platform, number>;
}

/** The outcome codes in the order the counts list them; any other code follows. */
export const OUTCOME_ORDER = ['taken_down', 'no_result', 'retracted', 'expired', 'no_decision', 'rejected', 'routed'] as const;

const READ_STATS = sql`SELECT category, platform, outcome, count(*) AS n, COALESCE(sum(presses), 0) AS presses FROM stats WHERE closed_day >= ? AND closed_day < ? GROUP BY category, platform, outcome`;
const READ_COUNTERS = sql`SELECT key, count FROM counters WHERE day = ? AND key IN (?, ?)`;

interface StatsRow {
  readonly category: SqlValue;
  readonly platform: SqlValue;
  readonly outcome: SqlValue;
  readonly n: SqlValue;
  readonly presses: SqlValue;
}

const amount = (value: SqlValue): number => (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0);

const add = <K>(map: Map<K, number>, key: K, n: number): void => {
  map.set(key, (map.get(key) ?? 0) + n);
};

/** The counts of `period`, in ONE query. Throws only a storage failure. */
export async function readStats(db: SqlDb, period: StatsPeriod): Promise<StatsTally> {
  const rows = await db.all<StatsRow>(READ_STATS, [period.from, period.to]);
  const outcomes = new Map<string, number>();
  const categories = new Map<Category, number>();
  const platforms = new Map<Platform, number>();
  let total = 0;
  let presses = 0;
  for (const row of rows) {
    const n = amount(row.n);
    total += n;
    presses += amount(row.presses);
    add(outcomes, typeof row.outcome === 'string' ? row.outcome : 'closed', n);
    if (isCategory(row.category)) add(categories, row.category, n);
    if (isPlatform(row.platform)) add(platforms, row.platform, n);
  }
  return { total, presses, outcomes, categories, platforms };
}

/** The title a counts text opens with: /stats's own, or the monthly snapshot's. */
export type StatsTitle = 'stats.title' | 'stats.snapshot_title';

const lineOf = (locale: Locale, name: string, count: number): string => t(locale, 'stats.line', { name, count });

/** The counts of `period` in `locale` (see the header). */
export function statsText(locale: Locale, tally: StatsTally, period: StatsPeriod, title: StatsTitle = 'stats.title'): string {
  const lines = [t(locale, title, { period: period.label })];
  if (tally.total === 0) return [...lines, t(locale, 'stats.none')].join('\n');
  lines.push(t(locale, 'stats.total', { count: tally.total }));
  const known = OUTCOME_ORDER.filter((code) => tally.outcomes.has(code));
  const others = [...tally.outcomes.keys()].filter((code) => !(OUTCOME_ORDER as readonly string[]).includes(code)).sort();
  lines.push('', t(locale, 'stats.by_outcome'));
  for (const code of [...known, ...others]) lines.push(lineOf(locale, t(locale, outcomeNameKey(code)), tally.outcomes.get(code) ?? 0));
  lines.push('', t(locale, 'stats.by_category'));
  for (const category of CATEGORIES) {
    const count = tally.categories.get(category);
    if (count !== undefined) lines.push(lineOf(locale, t(locale, CATEGORY_NAME_KEYS[category]), count));
  }
  lines.push('', t(locale, 'stats.by_platform'));
  for (const platform of PLATFORMS) {
    const count = tally.platforms.get(platform);
    if (count !== undefined) lines.push(lineOf(locale, t(locale, PLATFORM_NAME_KEYS[platform]), count));
  }
  lines.push('', t(locale, 'stats.presses', { count: tally.presses }));
  return lines.join('\n');
}

/** /stats: the counts of `period` in `locale`. Throws only a storage failure. */
export async function statsAnswer(db: SqlDb, locale: Locale, period: StatsPeriod): Promise<string> {
  return statsText(locale, await readStats(db, period), period);
}

/**
 * The monthly snapshot of the run at `now` (see the header): the previous
 * month's counts to the keyholders and, unless locked down, to the venue.
 * Throws only a storage failure.
 */
export async function snapshot(deps: MaintenanceDeps, now: number): Promise<void> {
  const period = previousMonth(now);
  const tally = await readStats(deps.db, period);
  try {
    const outcome = await alertEveryone(deps, (locale) => statsText(locale, tally, period, 'stats.snapshot_title'), true);
    deps.logger.log('snapshot.sent', { count: tally.total, sent: outcome.sent, failed: outcome.failed });
  } catch (error) {
    if (isStorageFailure(error)) throw error;
    deps.logger.logError('snapshot.failed', error);
  }
}

/** /budget: the day's counters at `now`, in `locale` (see the header). Throws only a storage failure. */
export async function budgetText(deps: { readonly db: SqlDb; readonly config: Pick<Config, 'marksPerDay'> }, now: number, locale: Locale): Promise<string> {
  const day = utcDay(now);
  const rows = await deps.db.all<{ key: SqlValue; count: SqlValue }>(READ_COUNTERS, [day, PRESS_COUNTER, NON_MEMBER_COUNTER]);
  const counted = (key: string): number => amount(rows.find((row) => row.key === key)?.count ?? null);
  return t(locale, 'budget.text', {
    day,
    presses: counted(PRESS_COUNTER),
    pressCap: deps.config.marksPerDay,
    nonMembers: counted(NON_MEMBER_COUNTER),
    nonMemberCap: INTAKE_LIMITS.nonMemberGlobalPerDay,
  });
}

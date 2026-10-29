// @critical-path
// The intake store (critical invariants 3 and 8; doc/product/report-lifecycle.md,
// "Intake"; doc/product/retention-and-minimisation.md): the draft of one
// reporter's conversation, keyed by the reporter reference of the chat
// (`drafts.draft_key`), never the chat id, and the submit that turns it into
// a report.
//
// Every write is conditional on the step it leaves, so two updates handled
// at once (a double press, a message sent twice) move a draft on once: the
// loser changes no row and is told so. The draft keeps no message id: each
// reporter message is deleted on receipt (src/telegram/intake.ts). A draft
// is deleted on submit, on /cancel, and by the retention job after 24 hours.
//
// The submit is ONE batch, one transaction on D1 and on node:sqlite, of
// four statements chained by SQLite's changes(), the number of rows the
// batch's previous statement changed (the press counter relies on the
// same, src/telegram/presses.ts, and both are tested on D1):
// 1. the draft deleted, only from the comment step: a second submit of the
//    same draft changes nothing, and everything after it is skipped;
// 2. the reference's `reporter_stats` row written (open_count, day,
//    day_count, last_seen), only if the draft was taken and the limits
//    hold (src/review/intake.ts, INTAKE_LIMITS): not blocked; today's
//    count under the day's limit (20 for a member, 1 for a non-member or
//    for a reference with 3 rejections); for a member fewer than 5 pending
//    reports; for a non-member, the day's non-member count under 20. The
//    open count is read from `reports`, so `open_count` holds the pending
//    reports as of the reference's last submit, and no later decision has
//    to keep a counter right;
// 3. the report inserted, only if the row was written: `merged` into the
//    oldest open target with the same keyed link hash (src/privacy/link-hash.ts),
//    `pending` otherwise; it carries the reporter reference, never an id;
// 4. the day's non-member count raised, for a non-member's report only.
// A refused submit deletes the draft too and writes nothing else: a
// refused report is not kept for later.
import { utcDay, type Clock } from '../clock';
import { sql, type SqlDb, type SqlRunResult, type SqlStatement, type SqlValue } from '../db/sql';
import { isLocale, type Locale } from '../i18n/index';
import { isPlatform, type Platform } from '../platforms/platforms';
import { isCategory, type Category } from './categories';
import {
  holdsItsStep,
  INTAKE_LIMITS,
  isIntakeStep,
  NON_MEMBER_COUNTER,
  type Draft,
  type IntakeStep,
} from './intake';

interface DraftRow {
  readonly draft_key: string;
  readonly step: SqlValue;
  readonly url: SqlValue;
  readonly platform: SqlValue;
  readonly account_url: SqlValue;
  readonly category: SqlValue;
  readonly affected_person: SqlValue;
  readonly locale: SqlValue;
  readonly created_at: SqlValue;
  readonly updated_at: SqlValue;
}

const READ = sql`SELECT draft_key, step, url, platform, account_url, category, affected_person, locale, created_at, updated_at FROM drafts WHERE draft_key = ?`;
const DELETE = sql`DELETE FROM drafts WHERE draft_key = ?`;
/** A new draft with its link, or a `url` draft (kept by /language) moved on; any other step is left alone. */
const START = sql`INSERT INTO drafts (draft_key, step, url, platform, account_url, locale, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (draft_key) DO UPDATE SET step = excluded.step, url = excluded.url, platform = excluded.platform, account_url = excluded.account_url, updated_at = excluded.updated_at WHERE drafts.step = 'url'`;
const SET_ACCOUNT = sql`UPDATE drafts SET step = 'category', account_url = ?, updated_at = ? WHERE draft_key = ? AND step = 'account'`;
const SET_CATEGORY = sql`UPDATE drafts SET step = 'affected', category = ?, updated_at = ? WHERE draft_key = ? AND step = 'category'`;
const SET_AFFECTED = sql`UPDATE drafts SET step = 'comment', affected_person = ?, updated_at = ? WHERE draft_key = ? AND step = 'affected'`;
const REMEMBER_LOCALE = sql`INSERT INTO drafts (draft_key, step, locale, created_at, updated_at) VALUES (?, 'url', ?, ?, ?) ON CONFLICT (draft_key) DO UPDATE SET locale = excluded.locale, updated_at = excluded.updated_at`;

const TAKE_DRAFT = sql`DELETE FROM drafts WHERE draft_key = ? AND step = 'comment'`;
const WRITE_STATS = sql`INSERT INTO reporter_stats (reporter_ref, open_count, day, day_count, last_seen) SELECT ?, (SELECT count(*) FROM reports WHERE reporter_ref = ? AND status = 'pending') + (CASE WHEN EXISTS (SELECT 1 FROM reports WHERE link_hash = ? AND status IN ('pending', 'approved', 'posting', 'posted')) THEN 0 ELSE 1 END), ?, 1, ? WHERE changes() = 1 AND NOT EXISTS (SELECT 1 FROM reporter_stats WHERE reporter_ref = ? AND (blocked = 1 OR (day = ? AND day_count >= (CASE WHEN rejections_30d >= ? THEN ? ELSE ? END)))) AND (? = 0 OR (SELECT count(*) FROM reports WHERE reporter_ref = ? AND status = 'pending') < ?) AND (? = 1 OR COALESCE((SELECT count FROM counters WHERE day = ? AND key = ?), 0) < ?) ON CONFLICT (reporter_ref) DO UPDATE SET open_count = excluded.open_count, day_count = CASE WHEN reporter_stats.day = excluded.day THEN reporter_stats.day_count + 1 ELSE 1 END, day = excluded.day, last_seen = excluded.last_seen`;
const INSERT_REPORT = sql`INSERT INTO reports (id, status, platform, category, url, account_url, comment, affected_person, reporter_ref, merged_into, link_hash, created_at) SELECT ?, CASE WHEN target.id IS NULL THEN 'pending' ELSE 'merged' END, ?, ?, ?, ?, ?, ?, ?, target.id, ?, ? FROM (SELECT (SELECT id FROM reports WHERE link_hash = ? AND status IN ('pending', 'approved', 'posting', 'posted') ORDER BY created_at, id LIMIT 1) AS id) AS target WHERE changes() = 1`;
const COUNT_NON_MEMBER = sql`INSERT INTO counters (day, key, count) SELECT ?, ?, 1 WHERE ? = 0 AND changes() = 1 ON CONFLICT (day, key) DO UPDATE SET count = count + 1`;

const asNumber = (value: SqlValue): number | null => (typeof value === 'number' ? value : null);

/** The draft `row` is, or null when it does not hold what its step requires. */
function toDraft(row: DraftRow): Draft | null {
  const { step, url, platform, account_url: accountUrl, category, affected_person: affected, locale } = row;
  const createdAt = asNumber(row.created_at);
  const updatedAt = asNumber(row.updated_at);
  if (!isIntakeStep(step) || !isLocale(locale) || createdAt === null || updatedAt === null) return null;
  if (url !== null && typeof url !== 'string') return null;
  if (accountUrl !== null && typeof accountUrl !== 'string') return null;
  if (platform !== null && !isPlatform(platform)) return null;
  if (category !== null && !isCategory(category)) return null;
  if (affected !== null && affected !== 0 && affected !== 1) return null;
  const draft: Draft = {
    key: row.draft_key,
    step,
    url,
    platform,
    accountUrl,
    category,
    affectedPerson: affected === null ? null : affected === 1,
    locale,
    createdAt,
    updatedAt,
  };
  return holdsItsStep(draft) ? draft : null;
}

/** The draft keyed `key`, or null. A row that does not hold its step is deleted and read as none. */
export async function readDraft(db: SqlDb, key: string): Promise<Draft | null> {
  const row = await db.first<DraftRow>(READ, [key]);
  if (row === null) return null;
  const draft = toDraft(row);
  if (draft === null) await db.run(DELETE, [key]);
  return draft;
}

/** The reported link, as a draft starts with it. */
export interface DraftLink {
  readonly url: string;
  readonly platform: Platform;
  readonly accountUrl: string | null;
}

/**
 * Starts the draft keyed `key` at `step` with its link, or moves a `url`
 * draft on (its locale kept); true when a row changed, false when another
 * step holds the draft.
 */
export async function startDraft(
  db: SqlDb,
  clock: Clock,
  key: string,
  step: IntakeStep,
  link: DraftLink,
  locale: Locale,
): Promise<boolean> {
  const now = clock.now();
  const result = await db.run(START, [key, step, link.url, link.platform, link.accountUrl, locale, now, now]);
  return result.changes === 1;
}

/** Sets the account's link (null: "I don't know") and moves an `account` draft on; false at another step. */
export async function setAccount(db: SqlDb, clock: Clock, key: string, accountUrl: string | null): Promise<boolean> {
  return (await db.run(SET_ACCOUNT, [accountUrl, clock.now(), key])).changes === 1;
}

/** Sets the category and moves a `category` draft on; false at another step. */
export async function setCategory(db: SqlDb, clock: Clock, key: string, category: Category): Promise<boolean> {
  return (await db.run(SET_CATEGORY, [category, clock.now(), key])).changes === 1;
}

/** Sets the affected-person flag and moves an `affected` draft on; false at another step. */
export async function setAffected(db: SqlDb, clock: Clock, key: string, affected: boolean): Promise<boolean> {
  return (await db.run(SET_AFFECTED, [affected ? 1 : 0, clock.now(), key])).changes === 1;
}

/** /cancel: deletes the draft keyed `key`; true when there was one. */
export async function cancelDraft(db: SqlDb, key: string): Promise<boolean> {
  return (await db.run(DELETE, [key])).changes === 1;
}

/** /language: keeps `locale` in the draft keyed `key`, starting a `url` draft when there is none. */
export async function rememberLocale(db: SqlDb, clock: Clock, key: string, locale: Locale): Promise<void> {
  const now = clock.now();
  await db.run(REMEMBER_LOCALE, [key, locale, now, now]);
}

/** What the submit of a draft records. */
export interface SubmitInput {
  /** The reporter reference: the draft's key and the report's `reporter_ref`. */
  readonly reporterRef: string;
  /** A fresh random id (src/db/ids.ts). */
  readonly reportId: string;
  readonly member: boolean;
  readonly url: string;
  readonly platform: Platform;
  readonly accountUrl: string | null;
  readonly category: Category;
  readonly affectedPerson: boolean;
  readonly comment: string | null;
  /** The keyed hash of `url` (src/privacy/link-hash.ts). */
  readonly linkHash: string;
}

/**
 * What a submit did: 'submitted' (a pending or a merged report), 'limited'
 * (a limit refused it; the draft is gone and nothing else was written) or
 * 'stale' (no draft at the comment step was there to take: another update
 * submitted or cancelled it first).
 */
export type SubmitOutcome = 'submitted' | 'limited' | 'stale';

/** The submit's four statements (see the header). */
export function submitStatements(input: SubmitInput, now: number): SqlStatement[] {
  const day = utcDay(now);
  const member = input.member ? 1 : 0;
  const dayMax = input.member ? INTAKE_LIMITS.memberPerDay : INTAKE_LIMITS.nonMemberPerDay;
  const ref = input.reporterRef;
  return [
    { sql: TAKE_DRAFT, params: [ref] },
    {
      sql: WRITE_STATS,
      params: [
        ref,
        ref,
        input.linkHash,
        day,
        day,
        ref,
        day,
        INTAKE_LIMITS.throttleRejections,
        INTAKE_LIMITS.throttledPerDay,
        dayMax,
        member,
        ref,
        INTAKE_LIMITS.memberOpen,
        member,
        day,
        NON_MEMBER_COUNTER,
        INTAKE_LIMITS.nonMemberGlobalPerDay,
      ],
    },
    {
      sql: INSERT_REPORT,
      params: [
        input.reportId,
        input.platform,
        input.category,
        input.url,
        input.accountUrl,
        input.comment,
        input.affectedPerson ? 1 : 0,
        ref,
        input.linkHash,
        now,
        input.linkHash,
      ],
    },
    { sql: COUNT_NON_MEMBER, params: [day, NON_MEMBER_COUNTER, member] },
  ];
}

/** The outcome the submit batch's results say. */
export function submitOutcome(results: readonly SqlRunResult[]): SubmitOutcome {
  if (results[0]?.changes !== 1) return 'stale';
  return results[2]?.changes === 1 ? 'submitted' : 'limited';
}

/** Submits the draft of `input.reporterRef` as one batch at `now` (see the header). */
export async function submitReport(db: SqlDb, input: SubmitInput, now: number): Promise<SubmitOutcome> {
  return submitOutcome(await db.batch(submitStatements(input, now)));
}

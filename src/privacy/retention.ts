// @critical-path
// The retention job (critical invariant 8 above all, and 1, 2 and 5; the
// MVP plan, section 4, "Retention"; doc/product/retention-and-minimisation.md,
// "Deletion schedule"; ADR 0004): every night at 00:15 UTC (the run's slot,
// src/broadcast/maintenance.ts, under lockdown too, since it only reduces
// exposure) and at once on a lockdown (lockdownNow()), at `now`, the
// schedule's cut-offs taken from `now` and every record from the clock:
// 1. drafts created more than 24 hours ago, deleted;
// 2. prompts (`admin_prompts`) created more than 24 hours ago, deleted, the
//    messages of those still within Telegram's 48 hours deleted from their
//    chat first, at most PROMPT_MESSAGES_PER_RUN (none in the venue under
//    lockdown, the venue being compromised by assumption then; the venue's
//    auto-delete covers what is left);
// 3. jobs that failed ABANDON_ATTEMPTS (20) times or more, at most
//    ABANDON_PER_RUN, abandoned: deleted and their reports flagged
//    `needs_attention` in one batch, then ONE alert naming them, to every
//    keyholder in both locales and to the venue unless locked down (the
//    reports marked alerted once a keyholder got it). Nothing is
//    finalized: a closure or a retraction keeps its report closing or
//    retracting with its data, and reconciliation queues its edit again
//    (src/broadcast/reconcile.ts); an abandoned post leaves its report
//    approved, for /repost or Cancel;
// 4. posted reports 90 days after `posted_at`, at most EXPIRE_PER_RUN,
//    moved to `closing` with the outcome `expired` and their `edit` job
//    enqueued, in one batch (src/broadcast/closure.ts): the closure's edit
//    appends the outcome, and its success finalizes them as `expired`.
//    Not while the bot is locked down or halted: the closure's edit cannot
//    run then, and a report moved to `closing` could no longer be
//    retracted, its post left in the channel for the whole hold; the cut-off
//    being `posted_at`, the next night without a hold catches up;
// 5. at most FINALIZE_PER_RUN (50) reports finalized in D1 alone, the
//    oldest first, in ONE batch (src/broadcast/finalize.ts): pending
//    reports 30 days after intake (status `expired`, outcome `no_decision`)
//    and rejected and routed rows 30 days after their decision, a
//    rejection counted off its references first; then the review cards of
//    the pending reports that expired, past Telegram's 48 hours, edited to
//    the outcome without links, at most CARD_EDITS_PER_RUN, never under
//    lockdown; the rest the next night (the 10 ms Worker budget);
// 6. finalized rows (`data_deleted_at` set) deleted, step 5's included:
//    the aggregate row is then all that holds their id;
// 7. reporter counters 90 days without activity (`last_seen`) deleted, a
//    blocked one excepted;
// 8. daily counters of days more than 90 days ago deleted.
// Each step is a fixed number of statements, pinned by the tests: ten for
// a run with nothing to do (the read of the holds, the lockdown switch and
// /halt, then one or two per step); nine under the switch or /halt, whose
// expiry reads nothing; eight under the LOCKDOWN override, which needs no
// read of the holds either. A step that fails
// for any reason but the store is logged by class (`retention.failed`) and
// the next step runs; a storage failure stops the job where it is, without
// another write, for the caller (the run stops: src/broadcast/tick.ts; a
// lockdown logs it and stays set). One line, `retention.done`, carries the
// counts.
import { utcDay } from '../clock';
import { expiryStatements } from '../broadcast/closure';
import { deleteFromChat, MESSAGE_DELETE_WINDOW_MS } from '../broadcast/concluding';
import { finalizationStatements, rejectionDecayStatement } from '../broadcast/finalize';
import type { MaintenanceDeps } from '../broadcast/maintenance';
import { alertEveryone, markAlerted } from '../broadcast/report-alerts';
import { isStorageFailure } from '../broadcast/state';
import { isId } from '../db/ids';
import { concatSql, placeholders, sql, type SqlStatement, type SqlValue } from '../db/sql';
import { t, type Locale } from '../i18n/index';
import { outcomeCard } from '../review/card';
import { STATUS_NAME_KEYS } from '../review/names';
import { isReportStatus, type ReportStatus } from '../review/reports';
import { editAfterCommit } from '../review/venue';

const DAY_MS = 24 * 60 * 60_000;

/** How long a draft lives, a prompt lives, a pending report waits, a rejected or routed row stays, a post stays. */
export const DRAFT_TTL_MS = DAY_MS;
export const PROMPT_TTL_MS = DAY_MS;
export const PENDING_TTL_MS = 30 * DAY_MS;
export const DECIDED_TTL_MS = 30 * DAY_MS;
export const POST_TTL_MS = 90 * DAY_MS;
/** How many days without activity a reporter's counters, and a day's counters, are kept. */
export const IDLE_REPORTER_DAYS = 90;
export const COUNTER_DAYS = 90;
/** The attempts after which a job is abandoned. */
export const ABANDON_ATTEMPTS = 20;
/** The bounds of one run. */
export const FINALIZE_PER_RUN = 50;
export const EXPIRE_PER_RUN = 50;
export const ABANDON_PER_RUN = 20;
export const PROMPT_MESSAGES_PER_RUN = 5;
export const CARD_EDITS_PER_RUN = 5;

const HOLDS = sql`SELECT key FROM meta WHERE key IN ('lockdown', 'halted')`;
const DELETE_DRAFTS = sql`DELETE FROM drafts WHERE created_at <= ?`;
const PROMPT_MESSAGES = sql`SELECT chat_id, prompt_message_id FROM admin_prompts WHERE created_at <= ? AND created_at > ? ORDER BY created_at, chat_id, prompt_message_id LIMIT ?`;
const DELETE_PROMPTS = sql`DELETE FROM admin_prompts WHERE created_at <= ?`;
const ABANDONED = sql`SELECT j.id, j.report_id, r.status FROM jobs AS j JOIN reports AS r ON r.id = j.report_id WHERE j.attempts >= ? ORDER BY j.due_at, j.id LIMIT ?`;
const DROP_JOBS = sql`DELETE FROM jobs WHERE attempts >= ? AND id IN (`;
const FLAG_REPORTS = sql`UPDATE reports SET needs_attention = 1 WHERE id IN (`;
const EXPIRING = sql`SELECT id FROM reports WHERE status = 'posted' AND posted_at <= ? AND post_message_id IS NOT NULL ORDER BY posted_at, id LIMIT ?`;
const DECIDED = sql`SELECT id, status, card_message_id FROM reports WHERE (status = 'pending' AND created_at <= ?) OR (status IN ('rejected', 'routed') AND decided_at <= ?) ORDER BY COALESCE(decided_at, created_at), id LIMIT ?`;
const EXPIRE_PENDING = sql`UPDATE reports SET status = 'expired', outcome = 'no_decision' WHERE status = 'pending' AND created_at <= ? AND id IN (`;
const EXPIRED_NOW = sql`SELECT id FROM reports WHERE status = 'expired' AND outcome = 'no_decision' AND data_deleted_at = ? AND id IN (`;
const DELETE_FINALIZED = sql`DELETE FROM reports WHERE data_deleted_at IS NOT NULL`;
const DELETE_IDLE_REPORTERS = sql`DELETE FROM reporter_stats WHERE blocked = 0 AND last_seen < ?`;
const DELETE_OLD_COUNTERS = sql`DELETE FROM counters WHERE day < ?`;

/** What one run did, by path: rows deleted, jobs abandoned, posts set to expire, reports finalized. */
export interface RetentionRun {
  readonly drafts: number;
  readonly prompts: number;
  readonly abandoned: number;
  readonly expiring: number;
  readonly finalized: number;
  readonly removed: number;
  readonly reporterRows: number;
  readonly counterRows: number;
}

const ids = (count: number) => concatSql(placeholders(count), sql`)`);

/** Step 2 (see the header). */
async function expirePrompts(deps: MaintenanceDeps, now: number, locked: boolean): Promise<number> {
  const cutoff = now - PROMPT_TTL_MS;
  const rows = await deps.db.all<{ chat_id: SqlValue; prompt_message_id: SqlValue }>(PROMPT_MESSAGES, [cutoff, now - MESSAGE_DELETE_WINDOW_MS, PROMPT_MESSAGES_PER_RUN]);
  for (const row of rows) {
    if (typeof row.chat_id !== 'number' || typeof row.prompt_message_id !== 'number') continue;
    if (row.chat_id === deps.config.adminChatId && locked) continue;
    await deleteFromChat(deps, row.chat_id, row.prompt_message_id);
  }
  return (await deps.db.run(DELETE_PROMPTS, [cutoff])).changes;
}

interface AbandonedJob {
  readonly jobId: string;
  readonly reportId: string;
  readonly status: ReportStatus;
}

/** The alert naming the abandoned jobs' reports, in `locale`. */
export function abandonedText(locale: Locale, jobs: readonly Pick<AbandonedJob, 'reportId' | 'status'>[]): string {
  return [
    t(locale, 'alert.abandoned.title'),
    ...jobs.map((job) => t(locale, 'alert.abandoned.line', { id: job.reportId, state: t(locale, STATUS_NAME_KEYS[job.status]) })),
    t(locale, 'alert.abandoned.hint'),
  ].join('\n');
}

/** Step 3 (see the header). */
async function abandonJobs(deps: MaintenanceDeps): Promise<number> {
  const jobs = (await deps.db.all<{ id: SqlValue; report_id: SqlValue; status: SqlValue }>(ABANDONED, [ABANDON_ATTEMPTS, ABANDON_PER_RUN])).flatMap((row) =>
    isId(row.id) && isId(row.report_id) && isReportStatus(row.status) ? [{ jobId: row.id, reportId: row.report_id, status: row.status }] : [],
  );
  if (jobs.length === 0) return 0;
  const reportIds = [...new Set(jobs.map((job) => job.reportId))];
  const results = await deps.db.batch([
    { sql: concatSql(DROP_JOBS, ids(jobs.length)), params: [ABANDON_ATTEMPTS, ...jobs.map((job) => job.jobId)] },
    { sql: concatSql(FLAG_REPORTS, ids(reportIds.length)), params: reportIds },
  ]);
  let delivered = false;
  try {
    const outcome = await alertEveryone(deps, (locale) => abandonedText(locale, jobs), true);
    delivered = outcome.sent > 0;
    deps.logger.log('retention.abandoned', { count: jobs.length, sent: outcome.sent, failed: outcome.failed });
  } catch (error) {
    if (isStorageFailure(error)) throw error;
    deps.logger.logError('alert.failed', error);
  }
  if (delivered) await markAlerted(deps.db, reportIds, deps.clock.now());
  return results[0]?.changes ?? 0;
}

/** Step 4 (see the header). */
async function expirePosts(deps: MaintenanceDeps, now: number): Promise<number> {
  const cutoff = now - POST_TTL_MS;
  const due = (await deps.db.all<{ id: SqlValue }>(EXPIRING, [cutoff, EXPIRE_PER_RUN])).flatMap((row) => (isId(row.id) ? [row.id] : []));
  if (due.length === 0) return 0;
  const at = deps.clock.now();
  const results = await deps.db.batch(expiryStatements(due, cutoff, at));
  return results[0]?.changes ?? 0;
}

interface DecidedRow {
  readonly id: string;
  readonly status: 'pending' | 'rejected' | 'routed';
  readonly cardMessageId: number | null;
}

const isDecidedStatus = (value: SqlValue): value is DecidedRow['status'] => value === 'pending' || value === 'rejected' || value === 'routed';

/** Step 5 (see the header). */
async function finalizeDecided(deps: MaintenanceDeps, now: number, locked: boolean): Promise<number> {
  const pendingCutoff = now - PENDING_TTL_MS;
  const rows: DecidedRow[] = (
    await deps.db.all<{ id: SqlValue; status: SqlValue; card_message_id: SqlValue }>(DECIDED, [pendingCutoff, now - DECIDED_TTL_MS, FINALIZE_PER_RUN])
  ).flatMap((row) =>
    isId(row.id) && isDecidedStatus(row.status)
      ? [{ id: row.id, status: row.status, cardMessageId: typeof row.card_message_id === 'number' ? row.card_message_id : null }]
      : [],
  );
  if (rows.length === 0) return 0;
  const pending = rows.filter((row) => row.status === 'pending');
  const at = deps.clock.now();
  const statements: SqlStatement[] = [
    ...(pending.length === 0 ? [] : [{ sql: concatSql(EXPIRE_PENDING, ids(pending.length)), params: [pendingCutoff, ...pending.map((row) => row.id)] }]),
    ...rows.filter((row) => row.status === 'rejected').map((row) => rejectionDecayStatement(row.id)),
    ...finalizationStatements(
      rows.map((row) => row.id),
      at,
      ['expired', 'rejected', 'routed'],
    ),
  ];
  const results = await deps.db.batch(statements);
  const finalized = results.at(-1)?.changes ?? 0;
  const cards = pending.filter((row) => row.cardMessageId !== null).slice(0, CARD_EDITS_PER_RUN);
  if (!locked && cards.length > 0) {
    const expired = new Set(
      (await deps.db.all<{ id: SqlValue }>(concatSql(EXPIRED_NOW, ids(cards.length)), [at, ...cards.map((row) => row.id)])).map((row) => row.id),
    );
    for (const card of cards) {
      if (card.cardMessageId !== null && expired.has(card.id)) {
        await editAfterCommit(deps, card.cardMessageId, outcomeCard({ id: card.id, status: 'expired' }, deps.config.venueLocale));
      }
    }
  }
  return finalized;
}

/**
 * The holds the job heeds: `locked` (the LOCKDOWN override, read with no
 * query, or the switch) keeps it out of the venue, and `held` (locked, or
 * /halt) keeps the expiry waiting (see the header). Throws only a storage
 * failure.
 */
async function holdsOf(deps: MaintenanceDeps): Promise<{ readonly locked: boolean; readonly held: boolean }> {
  if (deps.config.lockdown) return { locked: true, held: true };
  const keys = new Set((await deps.db.all<{ key: SqlValue }>(HOLDS)).map((row) => row.key));
  const locked = keys.has('lockdown');
  return { locked, held: locked || keys.has('halted') };
}

/**
 * The retention job of the run at `now` (see the header). Throws only a
 * storage failure, which stops it where it is.
 */
export async function retention(deps: MaintenanceDeps, now: number): Promise<RetentionRun> {
  const { locked, held } = await holdsOf(deps);
  const counts = { drafts: 0, prompts: 0, abandoned: 0, expiring: 0, finalized: 0, removed: 0, reporterRows: 0, counterRows: 0 };
  const step = async (run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      if (isStorageFailure(error)) throw error;
      deps.logger.logError('retention.failed', error);
    }
  };
  await step(async () => {
    counts.drafts = (await deps.db.run(DELETE_DRAFTS, [now - DRAFT_TTL_MS])).changes;
  });
  await step(async () => {
    counts.prompts = await expirePrompts(deps, now, locked);
  });
  await step(async () => {
    counts.abandoned = await abandonJobs(deps);
  });
  await step(async () => {
    if (!held) counts.expiring = await expirePosts(deps, now);
  });
  await step(async () => {
    counts.finalized = await finalizeDecided(deps, now, locked);
  });
  await step(async () => {
    counts.removed = (await deps.db.run(DELETE_FINALIZED)).changes;
  });
  await step(async () => {
    counts.reporterRows = (await deps.db.run(DELETE_IDLE_REPORTERS, [utcDay(now - IDLE_REPORTER_DAYS * DAY_MS)])).changes;
  });
  await step(async () => {
    counts.counterRows = (await deps.db.run(DELETE_OLD_COUNTERS, [utcDay(now - COUNTER_DAYS * DAY_MS)])).changes;
  });
  deps.logger.log('retention.done', counts);
  return counts;
}

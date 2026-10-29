// The scheduler under test (src/broadcast/tick.ts), over a bot harness's
// fakes (test/support/bot-harness.ts) as the Worker's scheduled handler
// wires it: the fake Bot API behind grammY's real client with the one
// transformer (createBotApi), the migrated node:sqlite database, the fake
// clock, the real redacting logger over a recorder and the harness's own
// memory of the keyholder notices, so a report approved through the real
// review (test/support/review-driver.ts) is posted by the very run that
// would post it. The store is counted (src/probe.ts's countingDb), so a test
// can pin how many statements a run issues; a test can wrap it further.
// plantApproved() writes what an approval's batch writes, for the SQL-level
// cases: the report approved under a fresh approval with its rendered
// bilingual post, and the post job carrying that approval's id; the venue's
// card and status card are put in the fake's store so their edits behave.
// plantPosted() goes on to post it with one real run, as the channel then
// holds it, for the closure and retraction cases.
// Fixture values are never secret-shaped.
import { createBotApi } from '../../src/telegram/api';
import { enqueuePost } from '../../src/broadcast/jobs';
import type { EditHandlers } from '../../src/broadcast/edits';
import { tick, type StorageAlertMemory, type TickDeps, type TickHooks, type TickOutcome } from '../../src/broadcast/tick';
import { randomId } from '../../src/db/ids';
import { sql, type SqlDb } from '../../src/db/sql';
import { countingDb, type ProbeTally } from '../../src/probe';
import type { Category, LinkMode } from '../../src/review/categories';
import { renderBilingualPost } from '../../src/review/render-post';
import type { Platform } from '../../src/platforms/platforms';
import { botHarness, NOW, type BotHarness, type HarnessOptions } from './bot-harness';
import { insertApproval, insertReport } from './review-rows';
import { IDS } from './variables';

export { NOW };

/**
 * When a harness's clock starts: a minute after the bot harness's NOW, so a
 * run at it is no reconciliation minute (those are the 15th minutes).
 */
export const TICK_AT = NOW + 60_000;

/** The grace a planted approval had: its start is this long after its approval. */
export const PLANTED_GRACE = 30 * 60_000;

export interface TickHarnessOptions extends HarnessOptions {
  /** Wraps the counted store the run uses (a failing one, say). */
  readonly store?: (db: SqlDb) => SqlDb;
  readonly edits?: EditHandlers;
  readonly hooks?: Partial<TickHooks>;
}

export interface TickHarness extends BotHarness {
  /** The run's deps, as the Worker builds them. */
  readonly deps: TickDeps;
  /** The statements the run's store issued since the last reset(). */
  readonly tally: ProbeTally;
  readonly storageAlerts: StorageAlertMemory;
  /** One run at `at` (the clock's time unless given). */
  run(at?: number): Promise<TickOutcome>;
  /** Resets the statement count. */
  reset(): void;
}

/** The scheduler over a fresh bot harness (see the header). */
export function tickHarness(options: TickHarnessOptions = {}): TickHarness {
  const harness = botHarness(options);
  harness.clock.set(TICK_AT);
  const tally: ProbeTally = { queries: 0, apiCalls: 0 };
  const counted = countingDb(harness.db, tally);
  const storageAlerts: StorageAlertMemory = { lastDay: null };
  const deps: TickDeps = {
    api: createBotApi(harness.config, harness.telegram.fetch),
    config: harness.config,
    db: options.store?.(counted) ?? counted,
    clock: harness.clock,
    logger: harness.log.logger,
    notices: harness.notices,
    storageAlerts,
    ...(options.edits === undefined ? {} : { edits: options.edits }),
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  };
  return {
    ...harness,
    deps,
    tally,
    storageAlerts,
    run: (at) => tick(deps, at ?? harness.clock.now()),
    reset: () => {
      tally.queries = 0;
      tally.apiCalls = 0;
    },
  };
}

/** What plantApproved() wrote. */
export interface PlantedPost {
  readonly reportId: string;
  readonly approvalId: string;
  /** The rendered post, as `broadcast_text` holds it. */
  readonly text: string;
  readonly startsAt: number;
  readonly cardMessageId: number;
  readonly statusMessageId: number;
}

export interface PlantOptions {
  /** The approval's start: due now unless given. */
  readonly startsAt?: number;
  /** The stored post, in place of the rendered one. */
  readonly text?: string;
  readonly platform?: Platform;
  readonly category?: Category;
  readonly linkMode?: LinkMode;
  /** Writes no post job. */
  readonly withoutJob?: boolean;
}

let nextVenueMessage = 500;

/** An approved report, as an approval's batch leaves it (see the header). */
export async function plantApproved(harness: TickHarness | BotHarness, options: PlantOptions = {}): Promise<PlantedPost> {
  const startsAt = options.startsAt ?? harness.clock.now();
  const platform = options.platform ?? 'x';
  const category = options.category ?? 'harassment';
  const url = 'https://x.com/someone/status/1234567890';
  const accountUrl = 'https://x.com/someone';
  const cardMessageId = (nextVenueMessage += 1);
  const statusMessageId = (nextVenueMessage += 1);
  const reportId = await insertReport(harness.db, {
    platform,
    category,
    url,
    account_url: accountUrl,
    comment: null,
    affected_person: null,
    card_message_id: cardMessageId,
    status_message_id: statusMessageId,
  });
  const approvalId = await insertApproval(harness.db, reportId, {
    approvedAt: startsAt - PLANTED_GRACE,
    startsAt,
    linkMode: options.linkMode ?? 'account',
  });
  const rendering = renderBilingualPost(
    { platform, category, url, accountUrl },
    { linkMode: options.linkMode ?? 'account', recommendedComment: 'Say it mocks a private person every day.' },
    harness.config.allowedLinkHosts,
  );
  if (!rendering.ok) throw new Error('the planted post does not render');
  const text = options.text ?? rendering.text;
  await harness.db.run(sql`UPDATE reports SET status = 'approved', broadcast_text = ?, link_mode = ? WHERE id = ?`, [text, options.linkMode ?? 'account', reportId]);
  if (options.withoutJob !== true) await enqueuePost(harness.db, harness.clock, reportId, approvalId, startsAt);
  harness.telegram.seedMessage(IDS.adminChat, { message_id: cardMessageId, text: 'the approved card' });
  harness.telegram.seedMessage(IDS.adminChat, { message_id: statusMessageId, text: 'the status card' });
  return { reportId, approvalId, text, startsAt, cardMessageId, statusMessageId };
}

/** A fresh random id that is no report's. */
export const unknownId = (): string => randomId();

/** What plantPosted() left: a planted approval, posted by a real run. */
export interface PostedPost extends PlantedPost {
  /** The post's message id in the channel. */
  readonly postMessageId: number;
}

/**
 * An approved report as plantApproved() writes it, posted by one run at the
 * clock's time; the statement count is reset after it. Its approval starts
 * before every post job already due, so the run, which posts the oldest,
 * posts this one.
 */
export async function plantPosted(harness: TickHarness, options: Omit<PlantOptions, 'startsAt' | 'withoutJob'> = {}): Promise<PostedPost> {
  const earliest = await harness.db.first<{ due: number | null }>(sql`SELECT min(due_at) AS due FROM jobs WHERE kind = 'post'`);
  const startsAt = Math.min(harness.clock.now(), (earliest?.due ?? Number.POSITIVE_INFINITY) - 1);
  const planted = await plantApproved(harness, { ...options, startsAt });
  const outcome = await harness.run();
  if (outcome.post !== 'posted') throw new Error(`the planted report was not posted: ${outcome.post}`);
  const row = await harness.db.first<{ status: string; post_message_id: number }>(sql`SELECT status, post_message_id FROM reports WHERE id = ?`, [planted.reportId]);
  if (row?.status !== 'posted') throw new Error('the run posted another report than the planted one');
  harness.reset();
  return { ...planted, postMessageId: row.post_message_id };
}

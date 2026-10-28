// @critical-path
// "I reported it" (critical invariants 2, 5 and 8; the MVP plan, section 4;
// doc/product/broadcast-consent-policy.md): the button on each channel post
// carries the callback data `mark:<report id>`. A press is answered first,
// "thank you" in the presser's locale, whatever happens next (and once:
// the error boundary does not answer it again, src/telegram/respond.ts);
// then it is counted, or not, and nothing about the presser is ever stored:
// presses count presses, not people.
//
// A redelivered update counts its press again. This is the one handler
// that is not idempotent per update, and the stated exception: telling a
// redelivery from a second press would take a record per press, and
// nothing about a press or its presser is stored (critical invariant 8);
// the figure is a count, advisory (/stats labels it so). The webhook
// answers 200 at once, so Telegram redelivers only an update whose answer
// was lost.
//
// It is counted, in ONE batch of two writes, `reports.presses` and the
// day's `counters` row (key PRESS_COUNTER), only when all of these hold:
// the data has the id shape (20 letters a to z); the pressed message is in
// the broadcast channel and is this report's own post (`post_message_id`);
// the report is `posted`; its count is under MARKS_PER_REPORT and the day's
// under MARKS_PER_DAY; and the bot is not locked down: the LOCKDOWN override
// is checked before any query, and the switch is bound in the report's
// UPDATE itself, so a lockdown set at any moment before it stops it.
//
// The second statement adds to the day's row only when the first changed
// its row: `changes()` is SQLite's count of rows the batch's previous
// statement changed, in the one transaction a batch is on D1 and on
// node:sqlite alike (both are tested, test/workers/webhook.test.ts on D1). Two
// D1 rows are written per counted press, so MARKS_PER_DAY at 20,000 is at
// most 40,000 of the daily 100,000.
import { Composer, type Context } from 'grammy';
import { NOT_LOCKED_DOWN } from '../auth/lockdown';
import type { Clock } from '../clock';
import type { Config } from '../config/schema';
import { concatSql, sql, type SqlDb } from '../db/sql';
import { resolveLocale, t } from '../i18n/index';
import { answerPress } from './respond';

/** The prefix of the button's callback data. */
export const MARK_PREFIX = 'mark:';
/** The whole callback data of a press: the prefix and a report id. */
export const MARK_DATA = /^mark:([a-z]{20})$/;
/** The `counters` key of the day's recorded presses. */
export const PRESS_COUNTER = 'presses';

/** The button's callback data for `reportId`: 25 bytes, well under Telegram's 64. */
export const markData = (reportId: string): string => `${MARK_PREFIX}${reportId}`;

/** The UTC day of `ms`, as `counters.day` holds it. */
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const COUNT_FOR_REPORT = concatSql(
  sql`UPDATE reports SET presses = presses + 1 WHERE id = ? AND status = 'posted' AND post_message_id = ? AND presses < ? AND COALESCE((SELECT count FROM counters WHERE day = ? AND key = ?), 0) < ? AND `,
  NOT_LOCKED_DOWN,
);
const COUNT_FOR_DAY = sql`INSERT INTO counters (day, key, count) SELECT ?, ?, 1 WHERE changes() = 1 ON CONFLICT (day, key) DO UPDATE SET count = count + 1`;

export interface PressDeps {
  readonly config: Pick<Config, 'broadcastChatId' | 'lockdown' | 'marksPerDay' | 'marksPerReport'>;
  readonly db: SqlDb;
  readonly clock: Clock;
}

/**
 * Counts one press of report `reportId`'s post, message `postMessageId` of
 * the channel, if the conditions in the header hold. True when it counted.
 */
export async function recordPress(deps: PressDeps, reportId: string, postMessageId: number): Promise<boolean> {
  if (deps.config.lockdown) return false;
  const day = utcDay(deps.clock.now());
  const [report] = await deps.db.batch([
    {
      sql: COUNT_FOR_REPORT,
      params: [reportId, postMessageId, deps.config.marksPerReport, day, PRESS_COUNTER, deps.config.marksPerDay],
    },
    { sql: COUNT_FOR_DAY, params: [day, PRESS_COUNTER] },
  ]);
  return report?.changes === 1;
}

/** The press handler: answer first, then count (see the header). */
export function presses(deps: PressDeps): Composer<Context> {
  const composer = new Composer<Context>();
  composer.on('callback_query:data').filter(
    (ctx) => ctx.callbackQuery.data.startsWith(MARK_PREFIX),
    async (ctx) => {
      await answerPress(ctx, { text: t(resolveLocale(ctx.from.language_code), 'press.thanks') });
      const reportId = MARK_DATA.exec(ctx.callbackQuery.data)?.[1];
      const message = ctx.callbackQuery.message;
      if (reportId === undefined || message === undefined || message.chat.id !== deps.config.broadcastChatId) return;
      await recordPress(deps, reportId, message.message_id);
    },
  );
  return composer;
}

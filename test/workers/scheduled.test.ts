// Workers tier: the cron handler (src/worker.ts's `scheduled`) in the
// Workers runtime, with the local D1 binding and the test deployment's
// variables: one run through createWorker() with the fake Bot API, called
// as the platform calls it (createScheduledController, an execution
// context awaited to its end), posts a due approved report once into the
// channel, its claim and its record made on D1 itself (the claim's EXISTS
// clauses over approvals and meta, the record's batch); a second run sends
// nothing; a run of another cron expression touches nothing. The rows and
// the message ids are this file's own, and the times are real ones, since
// the run's claim takes the runtime's own clock, so the file shares the
// database with the others safely.
import { applyD1Migrations, createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { enqueuePost } from '../../src/broadcast/jobs';
import { postKeyboard } from '../../src/broadcast/post';
import type { Clock } from '../../src/clock';
import { d1SqlDb } from '../../src/db/d1';
import { sql } from '../../src/db/sql';
import { createWorker } from '../../src/worker';
import { fakeBotApi } from '../fakes/bot-api';
import { recordingLogger } from '../fakes/logger';
import { IDS } from '../support/variables';

const db = d1SqlDb(env.DB);
const MINUTE = 60_000;
const POST = '<b>The post</b>\n<code>https://x.com/someone</code>';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

/** The cron handler over a fresh fake Bot API, run once at `scheduledTime` with `cron`. */
const fire = async (scheduledTime: number, cron = '* * * * *', base = 0) => {
  const telegram = fakeBotApi({ channelIds: [IDS.broadcastChannel] });
  // A message id of this file's own, the post's id being UNIQUE in the database the files share.
  if (base > 0) telegram.seedMessage(IDS.broadcastChannel, { message_id: base, text: 'an earlier post' });
  const log = recordingLogger();
  const handler = createWorker(telegram.fetch, log.logger).scheduled;
  if (handler === undefined) throw new Error('the Worker has no scheduled handler');
  const ctx = createExecutionContext();
  await handler(createScheduledController({ scheduledTime, cron }), env, ctx);
  await waitOnExecutionContext(ctx);
  return { telegram, log };
};

describe('the cron handler on D1', () => {
  it('posts a due approved report once, claimed and recorded on D1, and a second run sends nothing', async () => {
    const now = Math.floor(Date.now() / MINUTE) * MINUTE;
    const reportId = 'workersscheduledzzzz';
    const approvalId = 'workersapprovalzzzzz';
    const startsAt = now - 10 * MINUTE;
    await db.run(
      sql`INSERT INTO reports (id, status, platform, category, url, account_url, created_at) VALUES (?, 'pending', 'x', 'harassment', 'https://x.com/someone/status/1', 'https://x.com/someone', ?)`,
      [reportId, now - 60 * MINUTE],
    );
    await db.batch([
      {
        sql: sql`INSERT INTO approvals (report_id, approval_id, admin_id, approved_at, link_mode, recommended_comment, starts_at, voided_at) VALUES (?, ?, 424240011, ?, 'account', 'say it', ?, NULL)`,
        params: [reportId, approvalId, startsAt - 30 * MINUTE, startsAt],
      },
      { sql: sql`UPDATE reports SET status = 'approved', broadcast_text = ?, link_mode = 'account' WHERE id = ?`, params: [POST, reportId] },
    ]);
    const clock: Clock = { now: () => startsAt, sleep: () => Promise.resolve() };
    expect(await enqueuePost(db, clock, reportId, approvalId, startsAt)).toBe(true);
    const base = 700_000 + (now / MINUTE) % 100_000;

    const first = await fire(now, '* * * * *', base);
    expect(first.telegram.callsOf('sendMessage').map((call) => call.payload)).toEqual([
      {
        chat_id: IDS.broadcastChannel,
        text: POST,
        reply_markup: postKeyboard(reportId),
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      },
    ]);
    const row = await db.first<{ status: string; post_message_id: number; posting_started_at: number; posted_at: number }>(
      sql`SELECT status, post_message_id, posting_started_at, posted_at FROM reports WHERE id = ?`,
      [reportId],
    );
    expect(row).toMatchObject({ status: 'posted', post_message_id: base + 1 });
    expect(row?.posted_at).toBeGreaterThanOrEqual(row?.posting_started_at ?? Number.POSITIVE_INFINITY);
    expect(await db.all(sql`SELECT id FROM jobs WHERE report_id = ?`, [reportId])).toEqual([]);

    const second = await fire(now + MINUTE);
    expect(second.telegram.callsOf('sendMessage').filter((call) => call.chatId === IDS.broadcastChannel)).toEqual([]);
  });

  it('runs nothing for another cron expression', async () => {
    const { telegram, log } = await fire(Date.now(), '5 0 * * *');
    expect(telegram.calls).toEqual([]);
    expect(log.records()).toEqual([{ level: 'info', event: 'cron.unknown' }]);
  });
});

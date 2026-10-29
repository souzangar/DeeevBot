// Unit tests for /repost (src/broadcast/repost.ts; critical invariants 1 and
// 2), over the fakes on node:sqlite: admitted from posting once the send
// window is over, and from approved with no post job; refused inside the
// window, once a message id exists, for an approval in its grace, under a
// voided approval and under lockdown; the next run posts the report once,
// under the live approval; the status card says it goes out again.
import { describe, expect, it } from 'vitest';
import { setLockdown } from '../auth/lockdown';
import { sql } from '../db/sql';
import { t } from '../i18n/index';
import { FAILURES } from '../../test/fakes/bot-api';
import { insertReport, reportRow } from '../../test/support/review-rows';
import { plantApproved, TICK_AT, tickHarness, type PlantedPost, type TickHarness } from '../../test/support/tick-harness';
import { IDS } from '../../test/support/variables';
import { POSTING_WINDOW_MS } from './post';
import { repostReport } from './repost';

const channelSends = (harness: TickHarness) => harness.telegram.callsOf('sendMessage').filter((call) => call.chatId === IDS.broadcastChannel);
const postJobs = (harness: TickHarness) =>
  harness.db.all(sql`SELECT report_id, json_extract(payload, '$.approval_id') AS approval_id FROM jobs WHERE kind = 'post'`);

/** A report whose send at TICK_AT Telegram answered with `failure`. */
const failedSend = async (harness: TickHarness, failure: (typeof FAILURES)[keyof typeof FAILURES]): Promise<PlantedPost> => {
  const planted = await plantApproved(harness);
  harness.telegram.fail({ method: 'sendMessage', chatId: IDS.broadcastChannel }, failure, 1);
  await harness.run();
  return planted;
};

describe('/repost of a report posting without a message id', () => {
  it('is admitted once its send window is over: approved again, its flags cleared, posted once by the next run', async () => {
    const harness = tickHarness();
    const planted = await failedSend(harness, FAILURES.timeout);
    harness.clock.set(TICK_AT + POSTING_WINDOW_MS);
    expect(await repostReport(harness.deps, planted.reportId)).toBe('done');
    expect(await reportRow(harness.db, planted.reportId)).toMatchObject({ status: 'approved', posting_started_at: null, needs_attention: 0, alert_sent_at: null });
    expect(await postJobs(harness)).toEqual([{ report_id: planted.reportId, approval_id: planted.approvalId }]);
    expect(harness.telegram.messageIn(IDS.adminChat, planted.statusMessageId)?.text).toContain(
      t(harness.config.venueLocale, 'review.status_card.note.reposted', { id: planted.reportId }),
    );
    expect((await harness.run(TICK_AT + POSTING_WINDOW_MS)).post).toBe('posted');
    expect(channelSends(harness)).toHaveLength(2);
    expect(harness.telegram.messagesIn(IDS.broadcastChannel)).toHaveLength(1);
    expect(harness.log.records().map((record) => record.event)).toContain('repost.done');
  });

  it('is refused inside its send window: the send may be in flight', async () => {
    const harness = tickHarness();
    const planted = await failedSend(harness, FAILURES.timeout);
    harness.clock.set(TICK_AT + POSTING_WINDOW_MS - 1);
    expect(await repostReport(harness.deps, planted.reportId)).toBe('refused');
    expect((await reportRow(harness.db, planted.reportId))?.status).toBe('posting');
  });
});

describe('/repost of an approved report', () => {
  it('re-creates the post job a refusal abandoned, under the live approval, due at once', async () => {
    const harness = tickHarness();
    const planted = await failedSend(harness, FAILURES.chatNotFound);
    expect(await postJobs(harness)).toEqual([]);
    harness.clock.advance(5 * 60_000);
    expect(await repostReport(harness.deps, planted.reportId)).toBe('done');
    expect(await harness.db.all(sql`SELECT due_at, attempts, json_extract(payload, '$.approval_id') AS approval_id FROM jobs`)).toEqual([
      { due_at: TICK_AT + 5 * 60_000, attempts: 0, approval_id: planted.approvalId },
    ]);
    expect((await reportRow(harness.db, planted.reportId))?.needs_attention).toBe(0);
  });

  it('is refused while it still has its job: an approval in its grace, or a post a 429 moved', async () => {
    const harness = tickHarness();
    const inGrace = await plantApproved(harness, { startsAt: TICK_AT + 60_000 });
    expect(await repostReport(harness.deps, inGrace.reportId)).toBe('refused');
    expect(await postJobs(harness)).toHaveLength(1);
  });
});

describe('/repost is refused', () => {
  it('once a message id exists', async () => {
    const harness = tickHarness();
    const planted = await plantApproved(harness);
    await harness.run();
    expect((await reportRow(harness.db, planted.reportId))?.status).toBe('posted');
    harness.clock.advance(10 * 60_000);
    expect(await repostReport(harness.deps, planted.reportId)).toBe('refused');
    expect(await postJobs(harness)).toEqual([]);
  });

  it('under a voided approval, for any other status, and says so for an unknown id', async () => {
    const harness = tickHarness();
    const pending = await insertReport(harness.db);
    const rejected = await insertReport(harness.db, { status: 'rejected' });
    for (const reportId of [pending, rejected]) expect(await repostReport(harness.deps, reportId)).toBe('refused');
    expect(await repostReport(harness.deps, 'abcdefghijklmnopqrst')).toBe('not_found');
    expect(await postJobs(harness)).toEqual([]);
  });

  it('under lockdown: the statement binds the switch', async () => {
    const harness = tickHarness();
    const planted = await failedSend(harness, FAILURES.chatNotFound);
    await setLockdown(harness.db, harness.clock);
    expect(await repostReport(harness.deps, planted.reportId)).toBe('refused');
    expect(await postJobs(harness)).toEqual([]);
    expect((await reportRow(harness.db, planted.reportId))?.needs_attention).toBe(1);
  });
});

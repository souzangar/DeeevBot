// Unit tests for the single post (src/broadcast/post.ts; critical
// invariants 1, 2, 4 and 5), through the run (tick()) over the fakes, on
// node:sqlite with the D1 migrations: one due approved report posted once
// into the channel with its button and its follow-ups; the claim as the
// plan states it and every case it claims nothing in; the failure classes
// (a 429, a refusal, an ambiguous send, a record that fails) and the
// send-time check of the stored post.
import { describe, expect, it } from 'vitest';
import { sql, type SqlDb, type SqlStatement, type SqlText, type SqlValue } from '../db/sql';
import { AppError } from '../errors/app-error';
import { t } from '../i18n/index';
import { statusCard } from '../review/status-card';
import { FAILURES, rateLimited } from '../../test/fakes/bot-api';
import { plantApproved, TICK_AT, tickHarness, type TickHarness } from '../../test/support/tick-harness';
import { reportRow } from '../../test/support/review-rows';
import { IDS } from '../../test/support/variables';
import { CLAIM_POST, DEFAULT_RETRY_AFTER_SECONDS, postKeyboard, runPostJob } from './post';
import { readTickState } from './state';

const PLAN_CLAIM =
  "UPDATE reports SET status = 'posting', posting_started_at = ? WHERE id = ? AND status = 'approved' AND EXISTS (SELECT 1 FROM approvals a WHERE a.report_id = reports.id AND a.voided_at IS NULL AND a.starts_at <= ? AND a.approval_id = ?) AND NOT EXISTS (SELECT 1 FROM meta WHERE key IN ('lockdown', 'halted')) AND NOT EXISTS (SELECT 1 FROM meta WHERE key = 'paused_until' AND value > ?)";

const channelSends = (harness: TickHarness) => harness.telegram.callsOf('sendMessage').filter((call) => call.chatId === IDS.broadcastChannel);
const jobs = (db: SqlDb) => db.all(sql`SELECT kind, report_id, due_at, attempts, json_extract(payload, '$.approval_id') AS approval_id FROM jobs ORDER BY due_at, id`);
const meta = (db: SqlDb, key: string) => db.first<{ value: SqlValue }>(sql`SELECT value FROM meta WHERE key = ?`, [key]);
const bothLocales = (key: Parameters<typeof t>[1], id: string): string =>
  `${t('fa', key as 'alert.post_refused', { id })}\n\n${t('en', key as 'alert.post_refused', { id })}`;

describe('the post of a due approved report', () => {
  it('sends the stored post once, to the channel only, with its button, previews off and HTML', async () => {
    const harness = tickHarness();
    const planted = await plantApproved(harness);
    expect((await harness.run()).post).toBe('posted');
    expect(channelSends(harness)).toEqual([
      {
        method: 'sendMessage',
        chatId: IDS.broadcastChannel,
        payload: {
          chat_id: IDS.broadcastChannel,
          text: planted.text,
          reply_markup: postKeyboard(planted.reportId),
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        },
      },
    ]);
    const [post] = harness.telegram.messagesIn(IDS.broadcastChannel);
    expect(await reportRow(harness.db, planted.reportId)).toMatchObject({
      status: 'posted',
      post_message_id: post?.message_id,
      posting_started_at: TICK_AT,
      posted_at: TICK_AT,
      needs_attention: 0,
      alert_sent_at: null,
    });
    expect(await jobs(harness.db)).toEqual([]);
    expect(harness.log.records()).toEqual([{ level: 'info', event: 'post.sent', reportId: planted.reportId }]);
  });

  it('labels its one button in both locales, with the press data of its report', () => {
    const keyboard = postKeyboard('abcdefghijklmnopqrst');
    expect(keyboard).toEqual({
      inline_keyboard: [[{ text: `${t('fa', 'post.button.reported')} · ${t('en', 'post.button.reported')}`, callback_data: 'mark:abcdefghijklmnopqrst' }]],
    });
  });

  it('edits the status card to "posted" and deletes the review card, which shows the links', async () => {
    const harness = tickHarness();
    const planted = await plantApproved(harness);
    await harness.run();
    expect(harness.telegram.messageIn(IDS.adminChat, planted.cardMessageId)).toBeUndefined();
    const statusMessage = harness.telegram.messageIn(IDS.adminChat, planted.statusMessageId);
    const expected = statusCard(
      { id: planted.reportId, status: 'posted', platform: 'x', category: 'harassment', reporterRef: 'a'.repeat(63) + '1' },
      null,
      harness.config.venueLocale,
    );
    expect(statusMessage?.text).toBe(expected.text);
    expect(statusMessage?.text).not.toContain('x.com');
  });

  it('posts at the start of its approval, not a minute before', async () => {
    const harness = tickHarness();
    const planted = await plantApproved(harness, { startsAt: TICK_AT + 60_000 });
    expect((await harness.run(TICK_AT)).post).toBe('none');
    expect(channelSends(harness)).toEqual([]);
    harness.clock.set(TICK_AT + 60_000);
    expect((await harness.run(TICK_AT + 60_000)).post).toBe('posted');
    expect(channelSends(harness).map((call) => call.payload.text)).toEqual([planted.text]);
  });

  it('takes one post a run, the oldest first', async () => {
    const harness = tickHarness();
    const first = await plantApproved(harness, { startsAt: TICK_AT - 120_000 });
    const second = await plantApproved(harness, { startsAt: TICK_AT - 60_000 });
    await harness.run();
    expect(channelSends(harness).map((call) => call.payload.text)).toEqual([first.text]);
    expect((await reportRow(harness.db, second.reportId))?.status).toBe('approved');
    await harness.run();
    expect(channelSends(harness)).toHaveLength(2);
    expect((await reportRow(harness.db, second.reportId))?.status).toBe('posted');
  });

  it('never picks a job no claim could take, so it holds back no other', async () => {
    const harness = tickHarness();
    const stale = await plantApproved(harness, { startsAt: TICK_AT - 120_000 });
    await harness.db.run(sql`UPDATE jobs SET payload = json_object('approval_id', ?) WHERE report_id = ?`, ['zzzzzzzzzzzzzzzzzzzz', stale.reportId]);
    const fresh = await plantApproved(harness, { startsAt: TICK_AT - 60_000 });
    expect((await harness.run()).post).toBe('posted');
    expect(channelSends(harness).map((call) => call.payload.text)).toEqual([fresh.text]);
    expect((await reportRow(harness.db, stale.reportId))?.status).toBe('approved');
  });
});

describe('the claim', () => {
  it("is the MVP plan's statement, verbatim", () => {
    expect(CLAIM_POST).toBe(PLAN_CLAIM);
  });

  it('claims nothing, and sends nothing, while halted, locked down or paused', async () => {
    for (const [key, value] of [
      ['halted', TICK_AT],
      ['lockdown', TICK_AT],
      ['paused_until', TICK_AT + 60_000],
    ] as const) {
      const harness = tickHarness();
      const planted = await plantApproved(harness);
      await harness.db.run(sql`INSERT INTO meta (key, value) VALUES (?, ?)`, [key, value]);
      expect((await harness.run()).post, key).toBe('skipped');
      expect(channelSends(harness), key).toEqual([]);
      expect((await reportRow(harness.db, planted.reportId))?.status, key).toBe('approved');
    }
    const overridden = tickHarness({ variables: { LOCKDOWN: '1' } });
    await plantApproved(overridden);
    expect((await overridden.run()).post).toBe('skipped');
    expect(channelSends(overridden)).toEqual([]);
  });

  it('claims nothing once a hold is set after the run read the state: the statement binds it', async () => {
    for (const key of ['halted', 'lockdown', 'paused_until']) {
      let armed = true;
      const harness = tickHarness({
        store: (db) => ({
          ...db,
          run: async (text: SqlText, params?: readonly SqlValue[]) => {
            if (armed && text === CLAIM_POST) {
              armed = false;
              await db.run(sql`INSERT INTO meta (key, value) VALUES (?, ?)`, [key, TICK_AT + 60_000]);
            }
            return db.run(text, params);
          },
        }),
      });
      const planted = await plantApproved(harness);
      expect((await harness.run()).post, key).toBe('claim_lost');
      expect(channelSends(harness), key).toEqual([]);
      expect(await reportRow(harness.db, planted.reportId), key).toMatchObject({ status: 'approved', posting_started_at: null });
    }
  });

  it('binds the approval the job carries: a cancelled approval re-approved under a new id is never posted by the old job', async () => {
    const harness = tickHarness();
    const planted = await plantApproved(harness);
    const state = await readTickState(harness.config, harness.db);
    // The run read the job; meanwhile Cancel voided the approval and a re-approval wrote a new id.
    let interleaved = false;
    const deps = {
      ...harness.deps,
      db: {
        ...harness.deps.db,
        run: async (text: SqlText, params?: readonly SqlValue[]) => {
          if (!interleaved && text === CLAIM_POST) {
            interleaved = true;
            await harness.db.batch([
              { sql: sql`UPDATE approvals SET voided_at = ? WHERE report_id = ?`, params: [TICK_AT, planted.reportId] },
              { sql: sql`UPDATE reports SET status = 'pending' WHERE id = ?`, params: [planted.reportId] },
            ]);
            await harness.db.batch([
              { sql: sql`UPDATE approvals SET approval_id = ?, voided_at = NULL WHERE report_id = ?`, params: ['newapprovalidxxxxxxx', planted.reportId] },
              { sql: sql`UPDATE reports SET status = 'approved' WHERE id = ?`, params: [planted.reportId] },
            ]);
          }
          return harness.deps.db.run(text, params);
        },
      },
    };
    expect(await runPostJob(deps, TICK_AT, state)).toBe('claim_lost');
    expect(channelSends(harness)).toEqual([]);
    expect((await reportRow(harness.db, planted.reportId))?.status).toBe('approved');
  });

  it('lets one of two racing runs post: the other claims nothing, or finds nothing due', async () => {
    const harness = tickHarness();
    const planted = await plantApproved(harness);
    const outcomes = await Promise.all([harness.run(), harness.run()]);
    expect(outcomes.filter((outcome) => outcome.post === 'posted')).toHaveLength(1);
    expect(outcomes.map((outcome) => outcome.post)).toEqual(expect.arrayContaining([expect.stringMatching(/^(claim_lost|none)$/)]));
    expect(channelSends(harness)).toHaveLength(1);
    expect((await reportRow(harness.db, planted.reportId))?.status).toBe('posted');
  });
});

describe('a send Telegram answers 429', () => {
  it('reverts the claim, moves the job and the pause to now plus retry_after, and alerts nobody', async () => {
    const harness = tickHarness();
    const planted = await plantApproved(harness);
    harness.telegram.fail({ method: 'sendMessage', chatId: IDS.broadcastChannel }, rateLimited(42), 1);
    expect((await harness.run()).post).toBe('rate_limited');
    expect(await reportRow(harness.db, planted.reportId)).toMatchObject({ status: 'approved', posting_started_at: null, needs_attention: 0 });
    expect(await jobs(harness.db)).toEqual([
      { kind: 'post', report_id: planted.reportId, due_at: TICK_AT + 42_000, attempts: 1, approval_id: planted.approvalId },
    ]);
    expect(await meta(harness.db, 'paused_until')).toEqual({ value: TICK_AT + 42_000 });
    expect(harness.telegram.callsOf('sendMessage')).toHaveLength(1);
    expect(harness.log.records()).toEqual([
      { level: 'error', event: 'post.rate_limited', reportId: planted.reportId, durationMs: '42k', errorClass: 'GrammyError', telegramErrorCode: 429, apiMethod: 'sendMessage' },
    ]);
  });

  it('sends nothing until the pause has passed, then posts once', async () => {
    const harness = tickHarness();
    const planted = await plantApproved(harness);
    harness.telegram.fail({ method: 'sendMessage', chatId: IDS.broadcastChannel }, rateLimited(90), 1);
    await harness.run();
    harness.clock.set(TICK_AT + 60_000);
    expect((await harness.run(TICK_AT + 60_000)).post).toBe('skipped');
    harness.clock.set(TICK_AT + 120_000);
    expect((await harness.run(TICK_AT + 120_000)).post).toBe('posted');
    expect(channelSends(harness)).toHaveLength(2);
    expect(harness.telegram.messagesIn(IDS.broadcastChannel)).toHaveLength(1);
    expect((await reportRow(harness.db, planted.reportId))?.status).toBe('posted');
  });

  it('takes a 429 without a usable retry_after as a minute', async () => {
    const harness = tickHarness();
    await plantApproved(harness);
    harness.telegram.fail({ method: 'sendMessage', chatId: IDS.broadcastChannel }, { kind: 'error', errorCode: 429, description: 'Too Many Requests' }, 1);
    await harness.run();
    expect(await meta(harness.db, 'paused_until')).toEqual({ value: TICK_AT + DEFAULT_RETRY_AFTER_SECONDS * 1000 });
  });
});

describe('a send Telegram refuses (a 400 or a 403)', () => {
  it.each([
    ['chat not found', FAILURES.chatNotFound],
    ['no right to post', { kind: 'error', errorCode: 403, description: 'Forbidden: bot is not a member of the channel chat' } as const],
    ['blocked', FAILURES.botBlocked],
  ])('%s: reverts the claim, flags the report, abandons the job, alerts once', async (_label, failure) => {
    const harness = tickHarness();
    const planted = await plantApproved(harness);
    harness.telegram.fail({ method: 'sendMessage', chatId: IDS.broadcastChannel }, failure, 1);
    expect((await harness.run()).post).toBe('refused');
    expect(await reportRow(harness.db, planted.reportId)).toMatchObject({ status: 'approved', posting_started_at: null, needs_attention: 1, alert_sent_at: TICK_AT });
    expect(await jobs(harness.db)).toEqual([]);
    const alert = bothLocales('alert.post_refused', planted.reportId);
    expect(harness.textsTo(IDS.keyholder)).toEqual([alert]);
    expect(harness.textsTo(IDS.secondKeyholder)).toEqual([alert]);
    expect(harness.textsTo(IDS.adminChat)).toEqual([t(harness.config.venueLocale, 'alert.post_refused', { id: planted.reportId })]);
    expect(harness.telegram.messageIn(IDS.adminChat, planted.statusMessageId)?.text).toContain(
      t(harness.config.venueLocale, 'review.status_card.note.refused', { id: planted.reportId }),
    );
    // Abandoned: no later run sends it again.
    harness.clock.advance(60_000);
    expect((await harness.run()).post).toBe('none');
    expect(channelSends(harness)).toHaveLength(1);
  });
});

describe('an ambiguous send (a timeout, a network error, a 5xx)', () => {
  it.each([
    ['a timeout', FAILURES.timeout],
    ['a network error', FAILURES.networkFailure],
    ['a 502', FAILURES.serverError],
  ])('%s: the report stays posting without an id, flagged, its job kept, alerted once, never re-sent', async (_label, failure) => {
    const harness = tickHarness();
    const planted = await plantApproved(harness);
    harness.telegram.fail({ method: 'sendMessage', chatId: IDS.broadcastChannel }, failure, 1);
    expect((await harness.run()).post).toBe('ambiguous');
    expect(await reportRow(harness.db, planted.reportId)).toMatchObject({
      status: 'posting',
      post_message_id: null,
      posting_started_at: TICK_AT,
      needs_attention: 1,
      alert_sent_at: TICK_AT,
    });
    expect(await jobs(harness.db)).toHaveLength(1);
    const alert = bothLocales('alert.post_unknown', planted.reportId);
    expect(harness.textsTo(IDS.keyholder)).toEqual([alert]);
    expect(harness.telegram.messageIn(IDS.adminChat, planted.statusMessageId)?.text).toContain(
      t(harness.config.venueLocale, 'review.status_card.note.unknown', { id: planted.reportId }),
    );
    for (let minute = 1; minute <= 20; minute += 1) {
      harness.clock.set(TICK_AT + minute * 60_000);
      await harness.run(TICK_AT + minute * 60_000);
    }
    expect(channelSends(harness)).toHaveLength(1);
    // Alerted once: the 15th minute's reconciliation sends nothing more about it.
    expect(harness.textsTo(IDS.keyholder)).toEqual([alert]);
  });

  it('marks the alert once one keyholder got it: the one it missed is counted, and no run repeats it', async () => {
    const harness = tickHarness();
    const planted = await plantApproved(harness);
    harness.telegram.fail({ method: 'sendMessage', chatId: IDS.broadcastChannel }, FAILURES.timeout, 1);
    harness.telegram.fail({ chatId: IDS.secondKeyholder }, FAILURES.cantInitiateConversation);
    await harness.run();
    expect((await reportRow(harness.db, planted.reportId))?.alert_sent_at).toBe(TICK_AT);
    const reconcileAt = Date.UTC(2027, 0, 15, 12, 15);
    harness.clock.set(reconcileAt);
    await harness.run(reconcileAt);
    expect(harness.telegram.messagesIn(IDS.keyholder)).toHaveLength(1);
    expect(harness.log.records().map((record) => record.event)).toEqual(['post.ambiguous', 'alert.failed']);
  });

  it('marks no alert that reached nobody, so reconciliation sends it again', async () => {
    const harness = tickHarness();
    const planted = await plantApproved(harness);
    harness.telegram.fail({ method: 'sendMessage', chatId: IDS.broadcastChannel }, FAILURES.timeout, 1);
    for (const keyholder of [IDS.keyholder, IDS.secondKeyholder]) harness.telegram.fail({ chatId: keyholder }, FAILURES.cantInitiateConversation, 1);
    await harness.run();
    expect((await reportRow(harness.db, planted.reportId))?.alert_sent_at).toBeNull();
    const reconcileAt = Date.UTC(2027, 0, 15, 12, 15);
    harness.clock.set(reconcileAt);
    await harness.run(reconcileAt);
    const [received] = harness.telegram.messagesIn(IDS.secondKeyholder);
    expect(received?.text).toContain(planted.reportId);
    expect((await reportRow(harness.db, planted.reportId))?.alert_sent_at).toBe(reconcileAt);
  });
});

describe('the send-time check of the stored post', () => {
  it.each([
    ['a link off the lists', (text: string) => `${text}\n<a href="https://evil.example/">more</a>`],
    ['over 4096 characters', (text: string) => `${text}\n${'x'.repeat(4096)}`],
    ['no post at all', () => null],
  ])('%s: never sent; the report held, flagged, its job abandoned, alerted', async (_label, change) => {
    const harness = tickHarness();
    const planted = await plantApproved(harness);
    await harness.db.run(sql`UPDATE reports SET broadcast_text = ? WHERE id = ?`, [change(planted.text), planted.reportId]);
    expect((await harness.run()).post).toBe('held');
    expect(channelSends(harness)).toEqual([]);
    expect(await reportRow(harness.db, planted.reportId)).toMatchObject({ status: 'approved', posting_started_at: null, needs_attention: 1, alert_sent_at: TICK_AT });
    expect(await jobs(harness.db)).toEqual([]);
    expect(harness.textsTo(IDS.keyholder)).toEqual([bothLocales('alert.post_held', planted.reportId)]);
    expect(harness.log.records().map((record) => record.event)).toEqual(['post.text_refused']);
  });
});

describe('a send whose record changes no row', () => {
  it('alerts the keyholders with the message id of the second message, to delete, and records nothing more', async () => {
    let attached = false;
    const harness = tickHarness({
      store: (db) => ({
        ...db,
        batch: async (statements: readonly SqlStatement[]) => {
          // /attach recorded the post meanwhile, as message 77, while the run's send was on its way.
          if (!attached && String(statements[0]?.sql).startsWith("UPDATE reports SET status = 'posted'")) {
            attached = true;
            await db.run(sql`UPDATE reports SET status = 'posted', post_message_id = 77, posted_at = posting_started_at WHERE id = ?`, [String(statements[0]?.params[2])]);
          }
          return db.batch(statements);
        },
      }),
    });
    const planted = await plantApproved(harness);
    expect((await harness.run()).post).toBe('posted');
    const [orphan] = harness.telegram.messagesIn(IDS.broadcastChannel);
    const messageId = orphan?.message_id ?? 0;
    const alert = `${t('fa', 'alert.post_orphan', { id: planted.reportId, message: messageId })}\n\n${t('en', 'alert.post_orphan', { id: planted.reportId, message: messageId })}`;
    expect(harness.textsTo(IDS.keyholder)).toEqual([alert]);
    expect(harness.textsTo(IDS.secondKeyholder)).toEqual([alert]);
    expect(harness.textsTo(IDS.adminChat)).toEqual([]);
    expect(await reportRow(harness.db, planted.reportId)).toMatchObject({ status: 'posted', post_message_id: 77 });
    expect(await jobs(harness.db)).toEqual([]);
    expect(harness.log.records().map((record) => record.event)).toEqual(['post.resolved_elsewhere', 'post.sent']);
  });
});

describe('a send whose record fails', () => {
  it('alerts the keyholders with the message id, stops the run, and is never re-sent', async () => {
    let failing = true;
    const harness = tickHarness({
      store: (db) => ({
        ...db,
        batch: (statements: readonly SqlStatement[]) =>
          failing && String(statements[0]?.sql).startsWith("UPDATE reports SET status = 'posted'")
            ? Promise.reject(new AppError('STORAGE_FAILURE', 'the record failed'))
            : db.batch(statements),
      }),
    });
    const planted = await plantApproved(harness);
    const outcome = await harness.run();
    expect(outcome).toMatchObject({ post: 'skipped', stopped: 'storage' });
    const [post] = harness.telegram.messagesIn(IDS.broadcastChannel);
    const messageId = post?.message_id ?? 0;
    const alert = `${t('fa', 'alert.post_unrecorded', { id: planted.reportId, message: messageId })}\n\n${t('en', 'alert.post_unrecorded', { id: planted.reportId, message: messageId })}`;
    expect(harness.textsTo(IDS.keyholder)).toEqual([alert]);
    expect(harness.textsTo(IDS.adminChat)).toEqual([]);
    expect(await reportRow(harness.db, planted.reportId)).toMatchObject({ status: 'posting', post_message_id: null });
    failing = false;
    harness.clock.advance(60_000);
    await harness.run();
    expect(channelSends(harness)).toHaveLength(1);
    expect(harness.log.records().map((record) => record.event)).toEqual(['post.not_recorded', 'tick.storage_failed']);
  });
});

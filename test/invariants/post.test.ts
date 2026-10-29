// Always-run invariant spec for the single post (src/broadcast/; critical
// invariants 1, 2, 4 and 5), over the fakes on node:sqlite, the reports
// approved through the real review where the rule is about the approval:
// - rule 1: nothing is ever sent to the channel for a report that is not
//   approved under a live approval whose start has come: not for a pending
//   or cancelled report, not before the start, not for the job of a
//   cancelled approval after a re-approval (the Cancel-and-re-approve
//   interleaving), not while halted, locked down (either layer) or paused,
//   not once a hold is set after the run read the state (the claim binds
//   them all in its own statement, whose text is pinned); a report is
//   posted at most once: two runs racing on one job post once, a send that
//   timed out is never sent again, a 429 posts once after the pause, a 400
//   is never retried; /attach records only this report's own post (never
//   another report's, never a message the bot did not send, never a message
//   whose text is not the post's, whatever keyboard a lost probe left on
//   it) and the post's edits then reach that message; /repost is refused
//   once a message id exists;
// - rule 4: the post leaves with previews off and HTML, its targets as code
//   text, its only tappable links on the lists, the fixed warning line in
//   both locales, a Telegram target never a link;
// - rule 5: the only message sent to the channel per report is its post, to
//   the configured channel and nowhere else, and a run messages nobody but
//   the channel, the keyholders and the venue;
// - rule 2: /attach, /repost, /halt and /resume are no commands from anyone
//   off the allowlists, and under lockdown nobody may /repost;
// - a press triggers no scan: it issues its one batch, and reconciliation
//   runs from the run alone.
// The commit gate runs this file on every commit (`npm run test:invariants`).
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { setLockdown } from '../../src/auth/lockdown';
import { attachPost } from '../../src/broadcast/attach';
import { CLAIM_POST, postKeyboard, POSTING_WINDOW_MS } from '../../src/broadcast/post';
import { repostReport } from '../../src/broadcast/repost';
import { sql, type SqlDb, type SqlText, type SqlValue } from '../../src/db/sql';
import { t } from '../../src/i18n/index';
import { outgoingLinkProblems } from '../../src/platforms/link-policy';
import { plainText } from '../../src/review/render-post';
import { countingDb, type ProbeTally } from '../../src/probe';
import { recordPress } from '../../src/telegram/presses';
import { FAILURES, rateLimited, type RecordedCall } from '../fakes/bot-api';
import { reviewIn, type SubmittedReport } from '../support/review-driver';
import { insertReport, reportRow } from '../support/review-rows';
import { plantApproved, TICK_AT, tickHarness, type TickHarness } from '../support/tick-harness';
import { IDS } from '../support/variables';
import { buttonPress, groupMessage, privateMessage } from '../support/updates';

const X_POST = 'https://x.com/someone/status/1234567890';
const MINUTE = 60_000;

const channelSends = (harness: TickHarness): RecordedCall[] => harness.telegram.callsOf('sendMessage').filter((call) => call.chatId === IDS.broadcastChannel);
const status = async (harness: TickHarness, id: string) => (await reportRow(harness.db, id))?.status;

/** A report submitted and approved through the real review; its approval's id. */
const approved = async (harness: TickHarness, url = X_POST): Promise<SubmittedReport & { readonly approvalId: string }> => {
  const review = reviewIn(harness);
  const report = await review.submit({ url, category: 'harassment', affected: false, comment: 'a comment' });
  await review.approve(IDS.admin, report, { category: 'harassment', mode: 'account', points: 'Say it mocks a private person every day.' });
  const row = await harness.db.first<{ approval_id: string }>(sql`SELECT approval_id FROM approvals WHERE report_id = ? AND voided_at IS NULL`, [report.reportId]);
  if (row === null) throw new Error('the approval was not written');
  return { ...report, approvalId: row.approval_id };
};

/** Every run from `from` to `to`, a minute apart. */
const runMinutes = async (harness: TickHarness, from: number, to: number): Promise<void> => {
  for (let at = from; at <= to; at += MINUTE) {
    harness.clock.set(at);
    await harness.run(at);
  }
};

describe('critical invariant 1: nothing reaches the channel without a live approval whose start has come', () => {
  it('a report approved through the review is posted at its start, not before, and once', async () => {
    const harness = tickHarness();
    const report = await approved(harness);
    const start = (await harness.db.first<{ starts_at: number }>(sql`SELECT starts_at FROM approvals WHERE report_id = ?`, [report.reportId]))?.starts_at ?? 0;
    await runMinutes(harness, harness.clock.now(), start - 1);
    expect(channelSends(harness)).toEqual([]);
    await runMinutes(harness, start - (start % MINUTE) + MINUTE, start + 30 * MINUTE);
    expect(channelSends(harness)).toHaveLength(1);
    expect(await status(harness, report.reportId)).toBe('posted');
  });

  it('nothing for a pending report, a cancelled one, or one whose approval was voided', async () => {
    const harness = tickHarness();
    const review = reviewIn(harness);
    const pending = await review.submit({ url: X_POST, category: 'harassment', affected: false });
    const cancelled = await approved(harness, 'https://x.com/another/status/2234567890');
    await review.press(IDS.admin, { kind: 'cancel', reportId: cancelled.reportId, approvalId: cancelled.approvalId }, cancelled.cardId);
    expect(await status(harness, cancelled.reportId)).toBe('pending');
    await runMinutes(harness, harness.clock.now(), harness.clock.now() + 90 * MINUTE);
    expect(channelSends(harness)).toEqual([]);
    expect(await status(harness, pending.reportId)).toBe('pending');
  });

  it('nothing for the job of a cancelled approval after a re-approval, even when the new approval has started (the interleaving)', async () => {
    let interleave: (() => Promise<void>) | null = null;
    const harness = tickHarness({
      variables: { APPROVAL_GRACE_MINUTES: '1' },
      store: (db) => ({
        ...db,
        first: async <T extends object>(text: SqlText, params?: readonly SqlValue[]) => {
          const row = await db.first<T>(text, params);
          // The run read the old approval's job; now Cancel and a re-approval land before its claim.
          if (interleave !== null && String(text).includes('FROM jobs AS j')) {
            const step = interleave;
            interleave = null;
            await step();
          }
          return row;
        },
      }),
    });
    const review = reviewIn(harness);
    const report = await approved(harness);
    harness.clock.advance(2 * MINUTE);
    interleave = async () => {
      await review.press(IDS.admin, { kind: 'cancel', reportId: report.reportId, approvalId: report.approvalId }, report.cardId);
      await review.approve(IDS.admin, report, { category: 'harassment', mode: 'account', points: 'Say it mocks a private person every day.' });
      harness.clock.advance(2 * MINUTE);
    };
    expect((await harness.run()).post).toBe('claim_lost');
    expect(channelSends(harness)).toEqual([]);
    const live = await harness.db.first<{ approval_id: string }>(sql`SELECT approval_id FROM approvals WHERE report_id = ? AND voided_at IS NULL`, [report.reportId]);
    expect(live?.approval_id).not.toBe(report.approvalId);
    // The re-approval's own job posts it, once.
    expect((await harness.run()).post).toBe('posted');
    expect(channelSends(harness)).toHaveLength(1);
  });

  it('nothing while halted, locked down by either layer, or paused', async () => {
    for (const hold of ['halted', 'lockdown', 'override', 'paused_until'] as const) {
      const harness = tickHarness(hold === 'override' ? { variables: { LOCKDOWN: '1' } } : {});
      await plantApproved(harness);
      if (hold === 'lockdown') await setLockdown(harness.db, harness.clock);
      if (hold === 'halted') await harness.db.run(sql`INSERT INTO meta (key, value) VALUES ('halted', 1)`);
      if (hold === 'paused_until') await harness.db.run(sql`INSERT INTO meta (key, value) VALUES ('paused_until', ?)`, [TICK_AT + 10 * MINUTE]);
      await runMinutes(harness, TICK_AT, TICK_AT + 5 * MINUTE);
      expect(channelSends(harness), hold).toEqual([]);
    }
  });

  it('nothing once a hold is set after the run read the state: the claim binds the switch, /halt and the pause in its own statement', async () => {
    expect(CLAIM_POST).toContain("status = 'approved'");
    expect(CLAIM_POST).toContain('a.voided_at IS NULL AND a.starts_at <= ? AND a.approval_id = ?');
    expect(CLAIM_POST).toContain("NOT EXISTS (SELECT 1 FROM meta WHERE key IN ('lockdown', 'halted'))");
    expect(CLAIM_POST).toContain("NOT EXISTS (SELECT 1 FROM meta WHERE key = 'paused_until' AND value > ?)");
    for (const [key, value] of [
      ['lockdown', 1],
      ['halted', 1],
      ['paused_until', TICK_AT + MINUTE],
    ] as const) {
      let armed = true;
      const harness = tickHarness({
        store: (db) => ({
          ...db,
          run: async (text: SqlText, params?: readonly SqlValue[]) => {
            if (armed && text === CLAIM_POST) {
              armed = false;
              await db.run(sql`INSERT INTO meta (key, value) VALUES (?, ?)`, [key, value]);
            }
            return db.run(text, params);
          },
        }),
      });
      const planted = await plantApproved(harness);
      await harness.run();
      expect(channelSends(harness), key).toEqual([]);
      expect(await status(harness, planted.reportId), key).toBe('approved');
    }
  });

  it('never claims a report again once it left approved: posting or posted', async () => {
    const harness = tickHarness();
    const planted = await plantApproved(harness);
    expect((await harness.db.run(CLAIM_POST, [TICK_AT, planted.reportId, TICK_AT, planted.approvalId, TICK_AT])).changes).toBe(1);
    expect((await harness.db.run(CLAIM_POST, [TICK_AT, planted.reportId, TICK_AT, planted.approvalId, TICK_AT])).changes).toBe(0);
  });
});

describe('critical invariant 1: a report is posted at most once', () => {
  it('two runs racing on one due job: both read it, one claims it, the post goes out once', async () => {
    let released: (() => void) | null = null;
    let reads = 0;
    const harness = tickHarness({
      store: (db) => ({
        ...db,
        first: async <T extends object>(text: SqlText, params?: readonly SqlValue[]) => {
          const row = await db.first<T>(text, params);
          if (String(text).includes('FROM jobs AS j')) {
            reads += 1;
            if (reads === 1) await new Promise<void>((resolve) => (released = resolve));
            else released?.();
          }
          return row;
        },
      }),
    });
    const planted = await plantApproved(harness);
    const outcomes = await Promise.all([harness.run(), harness.run()]);
    expect(reads).toBe(2);
    expect(outcomes.map((outcome) => outcome.post).sort()).toEqual(['claim_lost', 'posted']);
    expect(channelSends(harness)).toHaveLength(1);
    expect(await status(harness, planted.reportId)).toBe('posted');
  });

  it('a send that timed out is never sent again, by any later run', async () => {
    const harness = tickHarness();
    await plantApproved(harness);
    harness.telegram.fail({ method: 'sendMessage', chatId: IDS.broadcastChannel }, FAILURES.timeout, 1);
    await runMinutes(harness, TICK_AT, TICK_AT + 60 * MINUTE);
    expect(channelSends(harness)).toHaveLength(1);
  });

  it('a 429 reverts the claim, and the post goes out once after the pause', async () => {
    const harness = tickHarness();
    const planted = await plantApproved(harness);
    harness.telegram.fail({ method: 'sendMessage', chatId: IDS.broadcastChannel }, rateLimited(150), 1);
    await harness.run();
    expect(await reportRow(harness.db, planted.reportId)).toMatchObject({ status: 'approved', posting_started_at: null });
    await runMinutes(harness, TICK_AT + MINUTE, TICK_AT + 10 * MINUTE);
    expect(channelSends(harness)).toHaveLength(2);
    expect(harness.telegram.messagesIn(IDS.broadcastChannel)).toHaveLength(1);
  });

  it('a 400 reverts the claim, alerts, and is never retried by a run', async () => {
    const harness = tickHarness();
    const planted = await plantApproved(harness);
    harness.telegram.fail({ method: 'sendMessage', chatId: IDS.broadcastChannel }, FAILURES.chatNotFound, 1);
    await runMinutes(harness, TICK_AT, TICK_AT + 30 * MINUTE);
    expect(channelSends(harness)).toHaveLength(1);
    expect(await reportRow(harness.db, planted.reportId)).toMatchObject({ status: 'approved', posting_started_at: null, needs_attention: 1 });
    expect(harness.textsTo(IDS.keyholder)[0]).toContain(planted.reportId);
  });

  it('/repost is refused once a message id exists', async () => {
    const harness = tickHarness();
    const planted = await plantApproved(harness);
    await harness.run();
    harness.clock.advance(POSTING_WINDOW_MS);
    expect(await repostReport(harness.deps, planted.reportId)).toBe('refused');
    await runMinutes(harness, TICK_AT + POSTING_WINDOW_MS, TICK_AT + 20 * MINUTE);
    expect(channelSends(harness)).toHaveLength(1);
  });
});

describe('critical invariant 1: /attach records only this report\'s own post', () => {
  const ambiguous = async (harness: TickHarness) => {
    const planted = await plantApproved(harness);
    harness.telegram.fail({ method: 'sendMessage', chatId: IDS.broadcastChannel }, FAILURES.timeout, 1);
    await harness.run();
    return planted;
  };

  it("refuses another report's post, before any call, and a message the bot did not send", async () => {
    const harness = tickHarness();
    const planted = await ambiguous(harness);
    await insertReport(harness.db, { status: 'posted', posting_started_at: 1, posted_at: 2, post_message_id: 50 });
    expect(await attachPost(harness.deps, 'admin', planted.reportId, 50)).toBe('taken');
    expect(await attachPost(harness.deps, 'keyholder', planted.reportId, 51)).toBe('not_verified');
    expect(harness.telegram.callsOf('editMessageReplyMarkup').map((call) => call.payload.message_id)).toEqual([51]);
    expect(await reportRow(harness.db, planted.reportId)).toMatchObject({ status: 'posting', post_message_id: null });
  });

  it("refuses a message of the bot's that is not this report's post, and leaves it as it was", async () => {
    const harness = tickHarness();
    const planted = await ambiguous(harness);
    harness.clock.set(TICK_AT - 60 * MINUTE);
    harness.telegram.seedMessage(IDS.broadcastChannel, { message_id: 52, text: 'an earlier post, closed' });
    harness.clock.set(TICK_AT + MINUTE);
    expect(await attachPost(harness.deps, 'keyholder', planted.reportId, 52)).toBe('text_mismatch');
    expect(harness.telegram.messageIn(IDS.broadcastChannel, 52)).toMatchObject({ text: 'an earlier post, closed' });
    expect(harness.telegram.messageIn(IDS.broadcastChannel, 52)?.reply_markup).toBeUndefined();
  });

  it('binds nothing when a probe\'s answer was lost and the same mistyped id is attached again: the text decides, never the keyboard', async () => {
    const harness = tickHarness();
    const planted = await ambiguous(harness);
    harness.clock.set(TICK_AT + 5_000);
    harness.telegram.seedMessage(IDS.broadcastChannel, { message_id: 54, text: 'A note of the keyholder, its id mistyped for the post' });
    harness.clock.set(TICK_AT + MINUTE);
    // The probe lands but its answer is lost, and so are both tries of its removal: its keyboard stays.
    harness.telegram.fail({ method: 'editMessageReplyMarkup' }, FAILURES.lostResponse, 1);
    harness.telegram.fail({ method: 'editMessageReplyMarkup' }, FAILURES.timeout, 2);
    expect(await attachPost(harness.deps, 'keyholder', planted.reportId, 54)).toBe('unavailable');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await attachPost(harness.deps, 'keyholder', planted.reportId, 54)).toBe('text_mismatch');
    }
    expect(await reportRow(harness.db, planted.reportId)).toMatchObject({ status: 'posting', post_message_id: null });
    expect(harness.telegram.messageIn(IDS.broadcastChannel, 54)?.reply_markup).toBeUndefined();
  });

  it('refuses a human message sent in the send window under a mistyped id, on its text', async () => {
    const harness = tickHarness();
    const planted = await ambiguous(harness);
    harness.telegram.seedMessage(IDS.broadcastChannel, { message_id: 55, text: 'Posted by hand in the same seconds' });
    expect(await attachPost(harness.deps, 'admin', planted.reportId, 55)).toBe('text_mismatch');
    expect(await reportRow(harness.db, planted.reportId)).toMatchObject({ status: 'posting', post_message_id: null });
  });

  it('records the post itself, after which its button counts and its edits reach that message', async () => {
    const harness = tickHarness();
    const planted = await ambiguous(harness);
    // As Telegram holds it: the post's plain text, sent at the claim.
    harness.telegram.seedMessage(IDS.broadcastChannel, { message_id: 53, text: plainText(planted.text), reply_markup: postKeyboard(planted.reportId) });
    expect(await attachPost(harness.deps, 'keyholder', planted.reportId, 53)).toBe('recorded');
    // The closure and retraction unit's edits address `post_message_id`: this message.
    expect(await reportRow(harness.db, planted.reportId)).toMatchObject({ status: 'posted', post_message_id: 53 });
    expect(await recordPress(harness.deps, planted.reportId, 53)).toBe(true);
    expect(await recordPress(harness.deps, planted.reportId, 52)).toBe(false);
  });
});

describe('critical invariant 4: the post leaves with previews off, as HTML, its links on the lists', () => {
  it('a post approved through the review: code targets, the fixed warning line in both locales', async () => {
    const harness = tickHarness();
    const report = await approved(harness);
    await runMinutes(harness, harness.clock.now(), harness.clock.now() + 35 * MINUTE);
    const [post] = channelSends(harness);
    expect(post?.payload).toMatchObject({ parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    const text = String(post?.payload.text);
    expect(outgoingLinkProblems(text, harness.config.allowedLinkHosts)).toEqual([]);
    expect(text).toContain('<code>https://x.com/someone</code>');
    expect(text).toContain(t('fa', 'post.warning'));
    expect(text).toContain(t('en', 'post.warning'));
    expect(post?.payload.reply_markup).toEqual(postKeyboard(report.reportId));
  });

  it('a Telegram target is code text, never a link', async () => {
    const harness = tickHarness();
    await approved(harness, 'https://t.me/somechannel/42');
    await runMinutes(harness, harness.clock.now(), harness.clock.now() + 35 * MINUTE);
    const text = String(channelSends(harness)[0]?.payload.text);
    expect(text).toContain('<code>@somechannel</code>');
    expect(text).not.toContain('t.me/somechannel');
    expect(outgoingLinkProblems(text, harness.config.allowedLinkHosts)).toEqual([]);
  });
});

describe('critical invariant 5: the post goes only to the configured channel, once per report', () => {
  it('over a report\'s whole life to the post, every send goes to the reporter\'s own chat, the venue, a keyholder or the channel, and the channel gets the post alone', async () => {
    const harness = tickHarness();
    const report = await approved(harness);
    harness.telegram.fail({ method: 'sendMessage', chatId: IDS.broadcastChannel }, FAILURES.timeout, 1);
    await runMinutes(harness, harness.clock.now(), harness.clock.now() + 35 * MINUTE);
    // Telegram took the timed-out send after all: the post is there, sent at the claim.
    const row = await harness.db.first<{ posting_started_at: number; broadcast_text: string }>(
      sql`SELECT posting_started_at, broadcast_text FROM reports WHERE id = ?`,
      [report.reportId],
    );
    const later = harness.clock.now();
    harness.clock.set(row?.posting_started_at ?? 0);
    harness.telegram.seedMessage(IDS.broadcastChannel, { message_id: 60, text: plainText(row?.broadcast_text ?? ''), reply_markup: postKeyboard(report.reportId) });
    harness.clock.set(later + POSTING_WINDOW_MS);
    await harness.send(privateMessage(IDS.keyholder, `/attach ${report.reportId} 60`));
    expect(await status(harness, report.reportId)).toBe('posted');
    await runMinutes(harness, harness.clock.now(), harness.clock.now() + 60 * MINUTE);
    const allowed = new Set<number | string | undefined>([IDS.reporter, IDS.adminChat, IDS.keyholder, IDS.secondKeyholder, IDS.broadcastChannel]);
    for (const call of harness.telegram.callsOf('sendMessage')) expect(allowed.has(call.chatId), String(call.chatId)).toBe(true);
    expect(channelSends(harness)).toHaveLength(1);
    // The membership group is only ever asked who is a member (the intake's getChatMember), never sent anything.
    expect(harness.telegram.outgoing().filter((call) => call.chatId === IDS.membershipChat || call.chatId === IDS.strangerGroup)).toEqual([]);
    expect(harness.telegram.foreignRequests).toEqual([]);
  });

  it('a run sends to the configured channel only, however the report row reads', async () => {
    const harness = tickHarness({ variables: { BROADCAST_CHAT_ID: '-1009999999999' } });
    await plantApproved(harness);
    await harness.run();
    expect(harness.telegram.callsOf('sendMessage').map((call) => call.chatId)).toEqual([-1009999999999]);
  });
});

describe('critical invariant 2: the scheduler\'s commands', () => {
  it('are no commands from anyone off the allowlists, or outside their chats', async () => {
    const harness = tickHarness();
    const planted = await plantApproved(harness);
    harness.telegram.fail({ method: 'sendMessage', chatId: IDS.broadcastChannel }, FAILURES.timeout, 1);
    await harness.run();
    harness.clock.advance(POSTING_WINDOW_MS);
    for (const text of [`/repost ${planted.reportId}`, '/halt', '/resume', `/attach ${planted.reportId} 5`]) {
      await harness.send(groupMessage(IDS.adminChat, IDS.reporter, text));
      await harness.send(groupMessage(IDS.adminChat, IDS.keyholder, text));
      await harness.send(privateMessage(IDS.admin, text));
      await harness.send(privateMessage(IDS.reporter, text));
      await harness.send(groupMessage(IDS.membershipChat, IDS.admin, text));
    }
    expect(await status(harness, planted.reportId)).toBe('posting');
    expect(await harness.db.first(sql`SELECT count(*) AS n FROM meta WHERE key = 'halted'`)).toEqual({ n: 0 });
    expect(harness.telegram.callsOf('editMessageReplyMarkup')).toEqual([]);
  });

  it('under lockdown nobody may /repost: refused to an admin, no command for a keyholder, and the statement binds the switch', async () => {
    const harness = tickHarness();
    const planted = await plantApproved(harness);
    harness.telegram.fail({ method: 'sendMessage', chatId: IDS.broadcastChannel }, FAILURES.chatNotFound, 1);
    await harness.run();
    await setLockdown(harness.db, harness.clock);
    await harness.send(groupMessage(IDS.adminChat, IDS.admin, `/repost ${planted.reportId}`));
    expect(harness.textsTo(IDS.adminChat).at(-1)).toBe(t(harness.config.venueLocale, 'admin.refused'));
    await harness.send(privateMessage(IDS.keyholder, `/repost ${planted.reportId}`));
    expect(await repostReport(harness.deps, planted.reportId)).toBe('refused');
    expect(await harness.db.all(sql`SELECT * FROM jobs`)).toEqual([]);
    expect(await status(harness, planted.reportId)).toBe('approved');
  });
});

describe('a press triggers no scan', () => {
  it('a press issues its one batch, and nothing else', async () => {
    const harness = tickHarness();
    const planted = await plantApproved(harness);
    await harness.run();
    const tally: ProbeTally = { queries: 0, apiCalls: 0 };
    const db: SqlDb = countingDb(harness.db, tally);
    const [post] = harness.telegram.messagesIn(IDS.broadcastChannel);
    expect(await recordPress({ config: harness.config, db, clock: harness.clock }, planted.reportId, post?.message_id ?? 0)).toBe(true);
    expect(tally.queries).toBe(1);
    await harness.send(buttonPress(IDS.reporter, `mark:${planted.reportId}`, { chatId: IDS.broadcastChannel, messageId: post?.message_id ?? 0 }));
    expect(harness.telegram.calls.at(-1)?.method).toBe('answerCallbackQuery');
  });

  it('reconciliation runs from the run alone: nothing else in src/ imports it', () => {
    // `.href`: the Workers and Node type packages both declare URL.
    const SRC = fileURLToPath(new URL('../../src', import.meta.url).href);
    const sources = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return sources(path);
        return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
      });
    const IMPORTS_RECONCILE = /import\s*\{[^}]*\breconcile\b[^}]*\}\s*from\s*'[^']*\/reconcile'/;
    const importers = sources(SRC)
      .filter((path) => IMPORTS_RECONCILE.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path));
    expect(importers).toEqual(['broadcast/tick.ts']);
    expect(IMPORTS_RECONCILE.test("import { reconcile, RECONCILE_EVERY_MINUTES } from './reconcile';")).toBe(true);
    expect(IMPORTS_RECONCILE.test("import { RECONCILE_EVERY_MINUTES } from './reconcile';")).toBe(false);
  });
});

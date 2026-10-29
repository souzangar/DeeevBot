// Unit tests for retraction (src/broadcast/retraction.ts; critical
// invariants 1, 2, 3, 4, 5 and 8), over the tick harness's fakes with
// reports posted by a real run: the retracted post's text, bilingual, with
// the warning line, the correction escaped, no link; the correction's
// checks; the batch, the correction written before the status change, bound
// to a posted report with its message id under its live
// approval, an admin's to no lockdown; the prompt, in the retractor's chat,
// replacing their earlier one; the reply refused by a fresh prompt saying
// why, or taken: the batch, the prompt and the reply deleted, the retractor
// told, the status card under way; the edit job, which replaces the post's
// text, removes its button, deletes a post younger than 48 hours as well,
// edits the keyholders' remembered notices, and on its success alone writes
// `retracted` and finalizes, under /halt and lockdown too; a refusal leaving
// the report retracting with its correction and its post.
import { describe, expect, it } from 'vitest';
import { setLockdown } from '../auth/lockdown';
import { sql } from '../db/sql';
import { t } from '../i18n/index';
import { outgoingLinkProblems } from '../platforms/link-policy';
import { retractedNoticeText } from '../review/notify';
import { readPrompt } from '../review/prompts';
import { POST_DIVIDER, postProblems } from '../review/render-post';
import { FAILURES, rateLimited } from '../../test/fakes/bot-api';
import { insertApproval, insertReport, reportRow } from '../../test/support/review-rows';
import { plantApproved, plantPosted, TICK_AT, tickHarness, type TickHarness } from '../../test/support/tick-harness';
import { IDS } from '../../test/support/variables';
import { MESSAGE_DELETE_WINDOW_MS } from './concluding';
import { postKeyboard } from './post';
import {
  answerRetraction,
  checkCorrection,
  RETRACT_STATUS_STATEMENT,
  RETRACTION_PROMPT,
  retractedPostText,
  retractStatements,
  startRetraction,
  type Retractor,
} from './retraction';

const MINUTE = 60_000;
const CORRECTION = 'This account was the victim, not the author. Please do not report it.';

const channel = (harness: TickHarness, method: string) => harness.telegram.callsOf(method).filter((call) => call.chatId === IDS.broadcastChannel);
const admin = (harness: TickHarness): Retractor => ({ id: IDS.admin, role: 'admin', locale: harness.config.venueLocale, chatId: IDS.adminChat });
const keyholder: Retractor = { id: IDS.keyholder, role: 'keyholder', locale: 'en', chatId: IDS.keyholder };

/** The latest prompt row of `retractor` for `reportId`. */
const promptOf = async (harness: TickHarness, retractor: Retractor, reportId: string) => {
  const row = await harness.db.first<{ prompt_message_id: number }>(
    sql`SELECT prompt_message_id FROM admin_prompts WHERE report_id = ? AND chat_id = ? AND admin_id = ? AND kind = 'retraction' ORDER BY created_at DESC, prompt_message_id DESC LIMIT 1`,
    [reportId, retractor.chatId, retractor.id],
  );
  const prompt = row === null ? null : await readPrompt(harness.db, retractor.chatId, row.prompt_message_id);
  if (prompt === null) throw new Error('no retraction prompt');
  return prompt;
};

/** The retractor's reply `text` to their prompt for `reportId`, as Telegram holds it; whether it was taken. */
const replyTo = async (harness: TickHarness, retractor: Retractor, reportId: string, text: string | undefined) => {
  const prompt = await promptOf(harness, retractor, reportId);
  const messageId = harness.telegram.receive(retractor.chatId, text === undefined ? {} : { text });
  return { taken: await answerRetraction(harness.deps, retractor, prompt, { messageId, text }), prompt, messageId };
};

/** A planted approval posted by the statements a run's record writes, for a harness whose run cannot post (the override). */
const postedDirectly = async (harness: TickHarness) => {
  const planted = await plantApproved(harness);
  const postMessageId = 900;
  harness.telegram.seedMessage(IDS.broadcastChannel, { message_id: postMessageId, text: planted.text, reply_markup: postKeyboard(planted.reportId) });
  await harness.db.run(sql`UPDATE reports SET status = 'posting', posting_started_at = ? WHERE id = ?`, [TICK_AT, planted.reportId]);
  await harness.db.run(sql`UPDATE reports SET status = 'posted', post_message_id = ?, posted_at = ? WHERE id = ?`, [postMessageId, TICK_AT, planted.reportId]);
  await harness.db.run(sql`DELETE FROM jobs WHERE report_id = ?`, [planted.reportId]);
  return { ...planted, postMessageId };
};

/** A posted report retracted by `retractor` with CORRECTION; the clock a minute on. */
const retracting = async (harness: TickHarness, retractor: Retractor = admin(harness)) => {
  const posted = await plantPosted(harness);
  expect(await startRetraction(harness.deps, retractor, posted.reportId)).toBe('prompted');
  expect((await replyTo(harness, retractor, posted.reportId, CORRECTION)).taken).toBe(true);
  harness.clock.advance(MINUTE);
  return posted;
};

describe('the retracted post', () => {
  it('is the fixed heading and warning line in both locales, Persian first, then the correction as escaped text, with no link', () => {
    const text = retractedPostText('  The <account> & its owner  ');
    const half = (locale: 'fa' | 'en') =>
      [t(locale, 'post.retracted.title'), t(locale, 'post.retracted.body'), `<i>${t(locale, 'post.warning')}</i>`].join('\n');
    expect(text).toBe(
      [half('fa'), POST_DIVIDER, half('en'), POST_DIVIDER, `${t('fa', 'post.retracted.correction')}\n${t('en', 'post.retracted.correction')}\nThe &lt;account&gt; &amp; its owner`].join('\n\n'),
    );
    expect(outgoingLinkProblems(text, [])).toEqual([]);
  });
});

describe('the correction\'s checks', () => {
  const config = { allowedLinkHosts: ['x.com'] };

  it.each([
    ['no text', undefined, { kind: 'not_text' }],
    ['a blank text', '   ', { kind: 'empty' }],
    ['a URL', 'See https://x.com/other instead', { kind: 'policy', problem: 'url' }],
    ['a bare domain, even an allowed one', 'Report x.com/other instead', { kind: 'policy', problem: 'domain' }],
    ['a mention', 'Ask @someone about it', { kind: 'policy', problem: 'mention' }],
    ['a phone number', 'Call 0912 345 6789', { kind: 'policy', problem: 'phone' }],
  ] as const)('refuse %s', (_label, text, refusal) => {
    expect(checkCorrection(config, text)).toEqual({ ok: false, refusal });
  });

  it("refuse a correction whose post would pass Telegram's 4096 characters, saying by how many", () => {
    const check = checkCorrection(config, 'word '.repeat(900));
    expect(check).toEqual({ ok: false, refusal: { kind: 'too_long', excess: expect.any(Number) as number } });
    if (!check.ok && check.refusal.kind === 'too_long') {
      expect(check.refusal.excess).toBe(postProblems(retractedPostText('word '.repeat(900)), []).excess);
    }
  });

  it('take a neutral correction, trimmed', () => {
    expect(checkCorrection(config, `  ${CORRECTION}\n`)).toEqual({ ok: true, correction: CORRECTION });
  });
});

describe('the retraction\'s batch', () => {
  it('writes the correction, then the status, bound to a posted report under its live approval, and enqueues the edit', async () => {
    const harness = tickHarness();
    const posted = await plantPosted(harness);
    const prompt = { chatId: IDS.keyholder, promptMessageId: 5 };
    const statements = retractStatements({ reportId: posted.reportId, correction: CORRECTION, now: TICK_AT, byAdmin: false, prompt });
    expect(String(statements[0]?.sql)).toMatch(/^UPDATE reports SET correction_text = \?/);
    expect(String(statements[RETRACT_STATUS_STATEMENT]?.sql)).toMatch(/^UPDATE reports SET status = 'retracting'/);
    const results = await harness.db.batch(statements);
    expect(results[RETRACT_STATUS_STATEMENT]?.changes).toBe(1);
    expect(await reportRow(harness.db, posted.reportId)).toMatchObject({ status: 'retracting', outcome: 'retracted', correction_text: CORRECTION });
    expect(await harness.db.all(sql`SELECT kind, json_extract(payload, '$.action') AS action, due_at FROM jobs WHERE report_id = ?`, [posted.reportId])).toEqual([
      { kind: 'edit', action: 'retract', due_at: TICK_AT },
    ]);
  });

  it('retracts a posted report alone: nothing for one posting, with a message id or without, without a live approval, or already closing', async () => {
    const harness = tickHarness();
    const prompt = { chatId: IDS.adminChat, promptMessageId: 5 };
    const attached = await insertReport(harness.db, { status: 'posted', posting_started_at: 1, posted_at: 2, post_message_id: 81 });
    await insertApproval(harness.db, attached);
    await harness.db.run(sql`UPDATE reports SET status = 'posting' WHERE id = ?`, [attached]);
    const withoutId = await insertReport(harness.db, { posting_started_at: 1 });
    await insertApproval(harness.db, withoutId);
    await harness.db.run(sql`UPDATE reports SET status = 'posting' WHERE id = ?`, [withoutId]);
    const unbound = await insertReport(harness.db, { status: 'posted', posting_started_at: 1, posted_at: 2, post_message_id: 82 });
    const closingOne = await plantPosted(harness);
    await harness.db.run(sql`UPDATE reports SET status = 'closing' WHERE id = ?`, [closingOne.reportId]);
    const outcomes: Record<string, number | undefined> = {};
    for (const [name, id] of [['attached', attached], ['without id', withoutId], ['unbound', unbound], ['closing', closingOne.reportId]] as const) {
      outcomes[name] = (await harness.db.batch(retractStatements({ reportId: id, correction: CORRECTION, now: TICK_AT, byAdmin: true, prompt })))[RETRACT_STATUS_STATEMENT]?.changes;
    }
    // /attach writes posted and the id in one statement: a row posting with an id is none of its making, and is not retracted.
    expect(outcomes).toEqual({ attached: 0, 'without id': 0, unbound: 0, closing: 0 });
    for (const id of [attached, withoutId, unbound, closingOne.reportId]) expect((await reportRow(harness.db, id))?.correction_text, id).toBeNull();
  });

  it("binds the switch for an admin's retraction, never for a keyholder's", async () => {
    const harness = tickHarness();
    const first = await plantPosted(harness);
    const second = await plantPosted(harness);
    await setLockdown(harness.db, harness.clock);
    const prompt = { chatId: IDS.adminChat, promptMessageId: 5 };
    const byAdmin = await harness.db.batch(retractStatements({ reportId: first.reportId, correction: CORRECTION, now: TICK_AT, byAdmin: true, prompt }));
    const byKeyholder = await harness.db.batch(retractStatements({ reportId: second.reportId, correction: CORRECTION, now: TICK_AT, byAdmin: false, prompt }));
    expect([byAdmin[RETRACT_STATUS_STATEMENT]?.changes, byKeyholder[RETRACT_STATUS_STATEMENT]?.changes]).toEqual([0, 1]);
    expect((await reportRow(harness.db, first.reportId))?.correction_text).toBeNull();
  });
});

describe('the prompt and the reply', () => {
  it("prompt an admin in the venue under the status card, and a keyholder in their own chat, each recorded with their own id and chat", async () => {
    const harness = tickHarness();
    const posted = await plantPosted(harness);
    expect(await startRetraction(harness.deps, admin(harness), posted.reportId)).toBe('prompted');
    expect(await startRetraction(harness.deps, keyholder, posted.reportId)).toBe('prompted');
    const prompts = harness.telegram.callsOf('sendMessage').filter((call) => String(call.payload.text).includes(posted.reportId));
    expect(prompts.map((call) => [call.chatId, (call.payload.reply_markup as { force_reply?: boolean }).force_reply])).toEqual([
      [IDS.adminChat, true],
      [IDS.keyholder, true],
    ]);
    expect((prompts[0]?.payload.reply_parameters as { message_id?: number } | undefined)?.message_id).toBe(posted.statusMessageId);
    expect(prompts[1]?.payload.text).toBe(t('en', 'retract.prompt', { id: posted.reportId }));
    expect(await harness.db.all(sql`SELECT chat_id, admin_id, kind, category, link_mode FROM admin_prompts ORDER BY chat_id`)).toEqual([
      { chat_id: IDS.adminChat, admin_id: IDS.admin, kind: RETRACTION_PROMPT, category: null, link_mode: null },
      { chat_id: IDS.keyholder, admin_id: IDS.keyholder, kind: RETRACTION_PROMPT, category: null, link_mode: null },
    ]);
  });

  it("replace the retractor's earlier prompt, row and message", async () => {
    const harness = tickHarness();
    const posted = await plantPosted(harness);
    await startRetraction(harness.deps, keyholder, posted.reportId);
    const first = await promptOf(harness, keyholder, posted.reportId);
    await startRetraction(harness.deps, keyholder, posted.reportId);
    expect(await harness.db.all(sql`SELECT prompt_message_id FROM admin_prompts`)).toHaveLength(1);
    expect(harness.telegram.messageIn(IDS.keyholder, first.promptMessageId)).toBeUndefined();
  });

  it('refuse to start for a report not posted with a message id, and say a missing or merged one is not found', async () => {
    const harness = tickHarness();
    const pending = await insertReport(harness.db);
    const merged = await insertReport(harness.db, { status: 'merged' });
    expect(await startRetraction(harness.deps, keyholder, pending)).toBe('refused');
    expect(await startRetraction(harness.deps, keyholder, merged)).toBe('not_found');
    expect(await startRetraction(harness.deps, keyholder, 'nosuchreportxxxxxxxx')).toBe('not_found');
    expect(harness.telegram.callsOf('sendMessage')).toEqual([]);
  });

  it('refuse a reply that fails the checks with a fresh prompt saying why, the old prompt and the reply deleted, nothing else written', async () => {
    const harness = tickHarness();
    const posted = await plantPosted(harness);
    await startRetraction(harness.deps, keyholder, posted.reportId);
    const before = await reportRow(harness.db, posted.reportId);
    const { taken, prompt, messageId } = await replyTo(harness, keyholder, posted.reportId, 'See https://x.com/someone_else instead');
    expect(taken).toBe(true);
    expect(await reportRow(harness.db, posted.reportId)).toEqual(before);
    const fresh = await promptOf(harness, keyholder, posted.reportId);
    expect(fresh.promptMessageId).not.toBe(prompt.promptMessageId);
    expect(harness.telegram.messageIn(IDS.keyholder, fresh.promptMessageId)?.text).toBe(`${t('en', 'review.refused.url')}\n\n${t('en', 'retract.prompt', { id: posted.reportId })}`);
    expect(harness.telegram.messageIn(IDS.keyholder, prompt.promptMessageId)).toBeUndefined();
    expect(harness.telegram.messageIn(IDS.keyholder, messageId)).toBeUndefined();
  });

  it('take a correct reply: the batch, the prompt and the reply deleted, the retractor told, the status card under way', async () => {
    const harness = tickHarness();
    const posted = await plantPosted(harness);
    await startRetraction(harness.deps, admin(harness), posted.reportId);
    const { taken, prompt, messageId } = await replyTo(harness, admin(harness), posted.reportId, CORRECTION);
    expect(taken).toBe(true);
    expect(await reportRow(harness.db, posted.reportId)).toMatchObject({ status: 'retracting', correction_text: CORRECTION });
    expect(await harness.db.all(sql`SELECT * FROM admin_prompts`)).toEqual([]);
    expect(harness.telegram.messageIn(IDS.adminChat, prompt.promptMessageId)).toBeUndefined();
    expect(harness.telegram.messageIn(IDS.adminChat, messageId)).toBeUndefined();
    expect(harness.textsTo(IDS.adminChat).at(-1)).toBe(t(harness.config.venueLocale, 'retract.done', { id: posted.reportId }));
    expect(harness.telegram.messageIn(IDS.adminChat, posted.statusMessageId)?.text).toContain(
      t(harness.config.venueLocale, 'review.status_card.note.retracting', { id: posted.reportId }),
    );
    expect(harness.log.records().filter((record) => record.event === 'retract.ordered')).toEqual([{ level: 'info', event: 'retract.ordered', reportId: posted.reportId }]);
  });

  it("are no business of another retractor's prompt, nor of another kind's", async () => {
    const harness = tickHarness();
    const posted = await plantPosted(harness);
    await startRetraction(harness.deps, keyholder, posted.reportId);
    const prompt = await promptOf(harness, keyholder, posted.reportId);
    const second: Retractor = { ...keyholder, id: IDS.secondKeyholder, chatId: IDS.secondKeyholder };
    expect(await answerRetraction(harness.deps, second, prompt, { messageId: 1, text: CORRECTION })).toBe(false);
    expect(await answerRetraction(harness.deps, keyholder, { ...prompt, kind: 'recommended_comment' }, { messageId: 1, text: CORRECTION })).toBe(false);
    expect(await reportRow(harness.db, posted.reportId)).toMatchObject({ status: 'posted' });
  });

  it('end the prompt of a report no longer posted, saying so', async () => {
    const harness = tickHarness();
    const posted = await plantPosted(harness);
    await startRetraction(harness.deps, keyholder, posted.reportId);
    await harness.db.run(sql`UPDATE reports SET status = 'closing', outcome = 'taken_down' WHERE id = ?`, [posted.reportId]);
    const { taken } = await replyTo(harness, keyholder, posted.reportId, CORRECTION);
    expect(taken).toBe(true);
    expect(await harness.db.all(sql`SELECT * FROM admin_prompts`)).toEqual([]);
    expect(harness.textsTo(IDS.keyholder).at(-1)).toBe(t('en', 'retract.gone', { id: posted.reportId }));
    expect(await reportRow(harness.db, posted.reportId)).toMatchObject({ status: 'closing', correction_text: null });
  });

  it("let a keyholder retract under lockdown, the venue untouched; an admin's reply then writes nothing and the venue gets nothing", async () => {
    const harness = tickHarness();
    const first = await plantPosted(harness);
    const second = await plantPosted(harness);
    await startRetraction(harness.deps, admin(harness), second.reportId);
    await startRetraction(harness.deps, keyholder, first.reportId);
    await setLockdown(harness.db, harness.clock);
    const venueBefore = harness.telegram.calls.filter((call) => call.chatId === IDS.adminChat).length;
    expect((await replyTo(harness, keyholder, first.reportId, CORRECTION)).taken).toBe(true);
    expect(await reportRow(harness.db, first.reportId)).toMatchObject({ status: 'retracting' });
    expect((await replyTo(harness, admin(harness), second.reportId, CORRECTION)).taken).toBe(true);
    expect(await reportRow(harness.db, second.reportId)).toMatchObject({ status: 'posted', correction_text: null });
    expect(harness.telegram.calls.filter((call) => call.chatId === IDS.adminChat).length).toBe(venueBefore);
  });
});

describe('the edit job', () => {
  it('replaces the post with the correction, removes its button, deletes the young post, and concludes retracted', async () => {
    const harness = tickHarness();
    const posted = await retracting(harness);
    expect((await harness.run()).edits).toBe(1);
    expect(channel(harness, 'editMessageText').map((call) => call.payload)).toEqual([
      { chat_id: IDS.broadcastChannel, message_id: posted.postMessageId, text: retractedPostText(CORRECTION), parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
    ]);
    expect(channel(harness, 'deleteMessage').map((call) => call.payload.message_id)).toEqual([posted.postMessageId]);
    expect(await reportRow(harness.db, posted.reportId)).toMatchObject({ status: 'retracted', outcome: 'retracted', correction_text: null, post_message_id: null });
    expect(await harness.db.all(sql`SELECT outcome FROM stats WHERE report_id = ?`, [posted.reportId])).toEqual([{ outcome: 'retracted' }]);
    expect(harness.telegram.messageIn(IDS.adminChat, posted.statusMessageId)?.text).toContain(
      t(harness.config.venueLocale, 'review.status_card.concluded', { outcome: t(harness.config.venueLocale, 'review.outcome.retracted') }),
    );
  });

  it('keeps a post older than 48 hours, edited to the correction', async () => {
    const harness = tickHarness();
    const posted = await retracting(harness);
    harness.clock.advance(MESSAGE_DELETE_WINDOW_MS);
    await harness.run();
    expect(channel(harness, 'deleteMessage')).toEqual([]);
    expect(harness.telegram.messageIn(IDS.broadcastChannel, posted.postMessageId)?.text).toBe(retractedPostText(CORRECTION));
    expect(harness.telegram.messageIn(IDS.broadcastChannel, posted.postMessageId)?.reply_markup).toBeUndefined();
    expect(await reportRow(harness.db, posted.reportId)).toMatchObject({ status: 'retracted' });
  });

  it('edits the keyholders\' remembered notices to "retracted", without links, and forgets them', async () => {
    const harness = tickHarness();
    const posted = await plantPosted(harness);
    harness.telegram.seedMessage(IDS.secondKeyholder, { message_id: 3, text: 'the notice, posted' });
    harness.notices.remember(posted.approvalId, [{ chatId: IDS.secondKeyholder, messageId: 3 }]);
    await startRetraction(harness.deps, keyholder, posted.reportId);
    await replyTo(harness, keyholder, posted.reportId, CORRECTION);
    await harness.run();
    expect(harness.telegram.messageIn(IDS.secondKeyholder, 3)?.text).toBe(retractedNoticeText(posted.reportId));
    expect(harness.telegram.messageIn(IDS.secondKeyholder, 3)?.reply_markup).toBeUndefined();
    expect(harness.notices.recall(posted.approvalId)).toEqual([]);
  });

  it('runs under /halt and under lockdown, the venue left alone then', async () => {
    for (const hold of ['halted', 'lockdown', 'override'] as const) {
      const harness = tickHarness(hold === 'override' ? { variables: { LOCKDOWN: '1' } } : {});
      const posted = hold === 'override' ? await postedDirectly(harness) : await plantPosted(harness);
      await harness.db.batch(retractStatements({ reportId: posted.reportId, correction: CORRECTION, now: TICK_AT, byAdmin: false, prompt: { chatId: IDS.keyholder, promptMessageId: 1 } }));
      if (hold !== 'override') await harness.db.run(sql`INSERT INTO meta (key, value) VALUES (?, 1)`, [hold]);
      const venueBefore = harness.telegram.calls.filter((call) => call.chatId === IDS.adminChat).length;
      await harness.run();
      expect(await reportRow(harness.db, posted.reportId), hold).toMatchObject({ status: 'retracted' });
      const venueCalls = harness.telegram.calls.filter((call) => call.chatId === IDS.adminChat).length - venueBefore;
      expect(venueCalls, hold).toBe(hold === 'halted' ? 1 : 0);
    }
  });

  it('concludes on a post Telegram reports as gone, under its own log line, and deletes nothing', async () => {
    const harness = tickHarness();
    const posted = await retracting(harness);
    harness.telegram.fail({ method: 'editMessageText', chatId: IDS.broadcastChannel }, FAILURES.messageToEditNotFound, 1);
    await harness.run();
    expect(await reportRow(harness.db, posted.reportId)).toMatchObject({ status: 'retracted', data_deleted_at: harness.clock.now() });
    expect(channel(harness, 'deleteMessage')).toEqual([]);
    const concluded = harness.log.records().filter((record) => record.event === 'retract.done' || record.event === 'edit.post_gone');
    expect(concluded).toEqual([{ level: 'info', event: 'edit.post_gone', reportId: posted.reportId }]);
  });

  it('on a refusal, leaves the report retracting with its correction and its post, flagged; a young post deleted instead concludes', async () => {
    const harness = tickHarness();
    const posted = await retracting(harness);
    harness.clock.advance(MESSAGE_DELETE_WINDOW_MS);
    harness.telegram.fail({ method: 'editMessageText', chatId: IDS.broadcastChannel }, FAILURES.chatNotFound);
    await harness.run();
    expect(await reportRow(harness.db, posted.reportId)).toMatchObject({
      status: 'retracting',
      correction_text: CORRECTION,
      post_message_id: posted.postMessageId,
      needs_attention: 1,
      data_deleted_at: null,
    });
    const young = tickHarness();
    const fresh = await retracting(young);
    young.telegram.fail({ method: 'editMessageText', chatId: IDS.broadcastChannel }, FAILURES.chatNotFound);
    await young.run();
    expect(channel(young, 'deleteMessage').map((call) => call.payload.message_id)).toEqual([fresh.postMessageId]);
    expect(await reportRow(young.db, fresh.reportId)).toMatchObject({ status: 'retracted', needs_attention: 0 });
    // Deleted by the bot, not found gone: the retraction's own line.
    expect(young.log.records().filter((record) => record.event === 'retract.done' || record.event === 'edit.post_gone')).toEqual([
      { level: 'info', event: 'retract.done', reportId: fresh.reportId },
    ]);
  });

  it('sets the pause when the deletion meets a 429, and logs a deletion that fails by class: the edit stands', async () => {
    const harness = tickHarness();
    const posted = await retracting(harness);
    harness.telegram.fail({ method: 'deleteMessage', chatId: IDS.broadcastChannel }, rateLimited(40), 1);
    await harness.run();
    expect(await reportRow(harness.db, posted.reportId)).toMatchObject({ status: 'retracted' });
    expect(await harness.db.first(sql`SELECT value FROM meta WHERE key = 'paused_until'`)).toEqual({ value: harness.clock.now() + 40_000 });
    const other = tickHarness();
    const second = await retracting(other);
    other.telegram.fail({ method: 'deleteMessage', chatId: IDS.broadcastChannel }, FAILURES.messageCantBeDeleted, 1);
    await other.run();
    expect(await reportRow(other.db, second.reportId)).toMatchObject({ status: 'retracted' });
    expect(other.log.records().filter((record) => record.event === 'retract.not_deleted')).toEqual([
      { level: 'error', event: 'retract.not_deleted', reportId: second.reportId, errorClass: 'GrammyError', telegramErrorCode: 400, apiMethod: 'deleteMessage' },
    ]);
  });

  it('never edits with a stored correction that fails the checks: flagged, and the job\'s failure recorded', async () => {
    const harness = tickHarness();
    const posted = await retracting(harness);
    await harness.db.run(sql`UPDATE reports SET correction_text = 'Report @someone_else instead' WHERE id = ?`, [posted.reportId]);
    await harness.run();
    expect(channel(harness, 'editMessageText')).toEqual([]);
    expect(await reportRow(harness.db, posted.reportId)).toMatchObject({ status: 'retracting', needs_attention: 1 });
  });
});

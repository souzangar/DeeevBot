// Always-run invariant spec, critical invariant 6, for every code path of
// the Telegram wiring that writes a log line: the error boundary (a failing
// handler, a failing answer), the webhook (a failing update, an unreadable
// body), the Worker entry (a configuration that does not load), the
// membership check and the alerts (failing calls), the lockdown commands,
// the intake (a reporter message, a prompt edit, the acknowledgement or its
// self-deletion failing), and the review (its card, a venue message's
// deletion or edit, the status card, a keyholder notice and its edit
// failing; an approval whose notice reaches no keyholder or cannot be sent
// at all, one whose batch fails with the read after it, and one whose
// batch fails after committing), and the scheduler (a post's send answered
// 429, refused or ambiguously, its alerts failing too; a stored post the
// send-time check refuses; a send whose record fails; reconciliation's
// alert failing; an edit job failing; the lockdown alert reaching a
// keyholder short; a storage failure that stops a run, and its alert; any
// other failure of a run; /attach's refusals and a probe it cannot undo; a
// lockdown's retention pass failing; an unknown cron; the probe's counts).
// Each is driven with updates and texts that carry a reported URL, a
// comment, the reporter's, the admins', the keyholders' and the chats'
// Telegram ids, and with Bot API failures whose GrammyError payloads carry
// the outgoing text and the chat id. No line may hold any of them, nor the
// bot token, nor any part of an update: the lines name an event, an error
// class and code, a method and counts, and nothing else.
// The commit gate runs this file on every commit (`npm run test:invariants`).
import { describe, expect, it } from 'vitest';
import { createMembershipCache, membershipOf } from '../../src/auth/membership';
import { alertKeyholders, alertVenue } from '../../src/telegram/alerts';
import { createBotApi } from '../../src/telegram/api';
import { handleWebhook, SECRET_HEADER } from '../../src/telegram/webhook';
import { createWorker } from '../../src/worker';
import { pressData } from '../../src/review/intake';
import { FAILURES, rateLimited } from '../fakes/bot-api';
import { botHarness, type BotHarness } from '../support/bot-harness';
import { reporterIn } from '../support/intake-driver';
import { reviewIn } from '../support/review-driver';
import { harnessOver, storeWith } from '../support/review-store';
import { noticeData } from '../../src/review/callbacks';
import { createNoticeMemory } from '../../src/review/notify';
import { reviewFeatures } from '../../src/telegram/review';
import { AppError } from '../../src/errors/app-error';
import { sql } from '../../src/db/sql';
import { IDS, TEST_VARIABLES } from '../support/variables';
import { buttonPress, groupMessage, privateMessage } from '../support/updates';
import type { RecordedLine } from '../fakes/logger';
import { plantApproved, TICK_AT, tickHarness, type TickHarness } from '../support/tick-harness';
import { attachPost } from '../../src/broadcast/attach';
import { enqueueEditStatement } from '../../src/broadcast/jobs';
import { lockdownNow } from '../../src/broadcast/maintenance';
import { postKeyboard } from '../../src/broadcast/post';
import { handleScheduled } from '../../src/broadcast/tick';
import { createProbe } from '../../src/probe';
import type { SqlStatement } from '../../src/db/sql';
import { insertReport } from '../support/review-rows';
import { plainText } from '../../src/review/render-post';

const REPORTED_URL = 'https://www.instagram.com/reported.account.for.logs/';
const COMMENT = 'reporter comment that must never be logged';

/** Every value no line may carry. */
const SENSITIVE: readonly string[] = [
  REPORTED_URL,
  'reported.account.for.logs',
  'instagram',
  '://',
  COMMENT,
  'must never be logged',
  TEST_VARIABLES.BOT_TOKEN,
  TEST_VARIABLES.WEBHOOK_SECRET,
  TEST_VARIABLES.REPORTER_REF_KEY,
  ...Object.values(IDS).map((id) => String(Math.abs(id))),
  '424240',
  'Forbidden',
  'Bad Request',
  'update_id',
  'chat_id',
];

/** The events every line may name; nothing else. */
const ALLOWED_KEYS = new Set([
  'level',
  'event',
  'errorClass',
  'errorCode',
  'telegramErrorCode',
  'apiMethod',
  'reportId',
  'durationMs',
  'count',
  'sent',
  'failed',
  'attempts',
  'queries',
  'apiCalls',
  'unknownFields',
]);

const expectClean = (lines: readonly { readonly line: string }[]): void => {
  const text = lines.map(({ line }) => line).join('\n');
  for (const value of SENSITIVE) expect(text, value).not.toContain(value);
  for (const { line } of lines) {
    for (const key of Object.keys(JSON.parse(line) as Record<string, unknown>)) expect(ALLOWED_KEYS.has(key), key).toBe(true);
  }
};

describe('critical invariant 6: no handler logs a URL, an id, a text or an update', () => {
  it('the error boundary, when every send fails and the failure reply fails too', async () => {
    const harness = botHarness();
    harness.telegram.fail({ method: 'sendMessage' }, FAILURES.botBlocked);
    harness.telegram.fail({ method: 'answerCallbackQuery' }, FAILURES.serverError);
    for (const update of [
      privateMessage(IDS.reporter, `/start ${REPORTED_URL}`),
      privateMessage(IDS.reporter, `${REPORTED_URL} ${COMMENT}`),
      privateMessage(IDS.keyholder, '/lockdown'),
      privateMessage(IDS.keyholder, '/unlock'),
      groupMessage(IDS.adminChat, IDS.admin, `${REPORTED_URL} ${COMMENT}`),
      buttonPress(IDS.reporter, 'mark:abcdefghijklmnopqrst', { chatId: IDS.broadcastChannel, messageId: 1 }),
    ]) {
      await harness.send(update);
    }
    const events = harness.log.records().map((record) => record.event);
    expect(events).toContain('update.failed');
    expect(events).toContain('reply.failed');
    expect(events).toContain('lockdown.set');
    expectClean(harness.log.lines);
  });

  it('the webhook, for a failing update and for an unreadable body', async () => {
    const harness = botHarness();
    harness.telegram.fail({ method: 'sendMessage' }, FAILURES.chatNotFound);
    const send = async (body: string) => {
      const waited: Promise<unknown>[] = [];
      await handleWebhook(
        new Request(`https://div-report.test/${TEST_VARIABLES.WEBHOOK_PATH_SEGMENT}`, {
          method: 'POST',
          headers: { [SECRET_HEADER]: TEST_VARIABLES.WEBHOOK_SECRET },
          body,
        }),
        { waitUntil: (promise) => void waited.push(promise) },
        {
          config: harness.config,
          logger: harness.log.logger,
          bot: () => ({
            handleUpdate: () => Promise.reject(new Error(`${REPORTED_URL} for chat ${IDS.reporter}: ${COMMENT}`)),
          }),
        },
      );
      await Promise.all(waited);
    };
    await send(JSON.stringify(privateMessage(IDS.reporter, REPORTED_URL)));
    await send(`{"update_id": ${IDS.reporter}, "text": "${REPORTED_URL}`);
    await send(JSON.stringify({ chat_id: IDS.reporter, text: COMMENT }));
    expect(harness.log.records().map((record) => record.event)).toEqual(['update.failed', 'update.unreadable', 'update.unreadable']);
    expectClean(harness.log.lines);
  });

  it('the Worker entry, for a configuration that does not load', async () => {
    const harness = botHarness();
    const handler = createWorker(harness.telegram.fetch, harness.log.logger).fetch;
    if (handler === undefined) throw new Error('the Worker has no fetch handler');
    const env = { ...TEST_VARIABLES, ADMIN_IDS: `${IDS.admin},@admin_handle`, DB: {} };
    const response = await handler(
      new Request(`https://div-report.test/${TEST_VARIABLES.WEBHOOK_PATH_SEGMENT}`, { method: 'POST', body: REPORTED_URL }),
      env as unknown as Parameters<typeof handler>[1],
      { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as Parameters<typeof handler>[2],
    );
    expect(response.status).toBe(500);
    expect(harness.log.records()).toEqual([{ level: 'error', event: 'config.invalid', errorClass: 'AppError', errorCode: 'CONFIG_INVALID' }]);
    expectClean(harness.log.lines);
    expect(harness.log.text()).not.toContain('admin_handle');
  });

  it('the membership check and the alerts, when their calls fail', async () => {
    const harness = botHarness();
    const api = createBotApi(harness.config, harness.telegram.fetch);
    harness.telegram.fail({ method: 'getChatMember' }, rateLimited(9));
    harness.telegram.fail({ chatId: IDS.keyholder }, FAILURES.cantInitiateConversation);
    harness.telegram.fail({ chatId: IDS.secondKeyholder }, FAILURES.timeout);
    harness.telegram.fail({ chatId: IDS.adminChat }, FAILURES.networkFailure);
    const deps = { api, config: harness.config, clock: harness.clock, logger: harness.log.logger, db: harness.db };
    expect(await membershipOf({ ...deps, cache: createMembershipCache() }, IDS.reporter)).toBe(false);
    // As an alert carries a reported URL: code text, which the alerts' link check passes.
    await alertKeyholders(deps, `Check <code>${REPORTED_URL}</code>: ${COMMENT}`);
    await alertVenue(deps, `Check <code>${REPORTED_URL}</code>: ${COMMENT}`);
    expect(harness.log.records().map((record) => record.event)).toEqual([
      'membership.failed',
      'alert.failed',
      'alert.failed',
      'alert.failed',
    ]);
    expectClean(harness.log.lines);
  });

  it('the intake, when a reporter message, a prompt edit, the acknowledgement and its self-deletion fail', async () => {
    const harness = botHarness();
    const reporter = reporterIn(harness, IDS.reporter, { username: 'reporter_handle' });
    harness.telegram.fail({ method: 'deleteMessage' }, FAILURES.messageCantBeDeleted, 2);
    await reporter.say(`${REPORTED_URL} ${COMMENT}`);
    harness.telegram.fail({ method: 'editMessageText' }, FAILURES.serverError, 1);
    await reporter.press(pressData({ kind: 'category', category: 'private_data' }));
    await reporter.say('/skip');
    await reporter.press(pressData({ kind: 'affected', affected: false }));
    harness.telegram.fail({ method: 'sendMessage' }, FAILURES.botBlocked, 1);
    await reporter.say(COMMENT);
    const second = reporterIn(harness, IDS.stranger);
    await second.say(REPORTED_URL);
    await second.press(pressData({ kind: 'category', category: 'csam' }));
    await second.press(pressData({ kind: 'affected', affected: true }));
    harness.telegram.fail({ method: 'deleteMessage' }, FAILURES.timeout);
    await second.say(COMMENT);
    const events = harness.log.records().map((record) => record.event);
    expect(events).toContain('intake.message_not_deleted');
    expect(events).toContain('intake.prompt_not_edited');
    expect(events).toContain('intake.ack_not_deleted');
    expect(events).toContain('reply.failed');
    expectClean(harness.log.lines);
    expect(harness.log.text()).not.toContain('reporter_handle');
  });

  it('the review, when its card, a deletion, an edit, the status card, a notice and its edit fail', async () => {
    const harness = botHarness();
    const review = reviewIn(harness);
    const sender = { username: 'reporter_handle', firstName: 'Reporter Name' };
    // The first card fails: logged, and /card posts it again.
    harness.telegram.fail({ method: 'sendMessage', chatId: IDS.adminChat }, FAILURES.serverError, 1);
    const report = await review.submit({ url: REPORTED_URL, category: 'private_data', affected: false, comment: COMMENT }, IDS.reporter, sender);
    await harness.send(groupMessage(IDS.adminChat, IDS.admin, `/card ${report.reportId}`));
    const row = await harness.db.first<{ card_message_id: number }>(sql`SELECT card_message_id FROM reports WHERE id = ?`, [report.reportId]);
    const card = { ...report, cardId: Number(row?.card_message_id) };
    // A keyholder unreachable, the status card refused, the prompt and the reply undeletable.
    harness.telegram.fail({ chatId: IDS.secondKeyholder }, FAILURES.cantInitiateConversation, 1);
    await review.press(IDS.admin, { kind: 'approve', reportId: card.reportId }, card.cardId);
    await review.press(IDS.admin, { kind: 'category', reportId: card.reportId, category: 'private_data' }, card.cardId);
    await review.press(IDS.admin, { kind: 'mode', reportId: card.reportId, category: 'private_data', mode: 'account' }, card.cardId);
    const prompt = review.lastPrompt()?.message_id ?? 0;
    harness.telegram.fail({ method: 'editMessageText', chatId: IDS.adminChat }, FAILURES.serverError, 1);
    harness.telegram.fail({ method: 'deleteMessage', chatId: IDS.adminChat }, FAILURES.messageCantBeDeleted, 4);
    harness.telegram.fail({ method: 'sendMessage', chatId: IDS.adminChat }, FAILURES.botBlocked, 1);
    await review.reply(IDS.admin, prompt, `Say it publishes ${COMMENT} without consent.`);
    // A notice that cannot be edited at the Cancel.
    const approval = await harness.db.first<{ approval_id: string }>(sql`SELECT approval_id FROM approvals`);
    harness.telegram.fail({ method: 'editMessageText', chatId: IDS.keyholder }, FAILURES.serverError, 1);
    await review.pressData(IDS.keyholder, noticeData({ kind: 'cancel', reportId: card.reportId, approvalId: approval?.approval_id ?? '' }), 1, IDS.keyholder);
    const events = harness.log.records().map((record) => record.event);
    for (const event of [
      'review.card_not_sent',
      'alert.failed',
      'review.notice_incomplete',
      'review.message_not_edited',
      'review.status_card_not_sent',
      'review.message_not_deleted',
      'review.notice_not_edited',
    ]) {
      expect(events, event).toContain(event);
    }
    expectClean(harness.log.lines);
    expect(harness.log.text()).not.toContain('reporter_handle');
    expect(harness.log.text()).not.toContain('Reporter Name');
  });

  it('the approval, when no keyholder can be notified, when the notice cannot be sent at all, and when its batch fails, unreadably or after committing', async () => {
    const sender = { username: 'reporter_handle', firstName: 'Reporter Name' };
    const approveIn = async (harness: BotHarness): Promise<void> => {
      const review = reviewIn(harness);
      const report = await review.submit({ url: REPORTED_URL, category: 'private_data', affected: false, comment: COMMENT }, IDS.reporter, sender);
      await review.approve(IDS.admin, report, { category: 'private_data', mode: 'account', points: `Say it publishes ${COMMENT} without consent.` });
    };
    // Every keyholder unreachable: the reply is refused.
    const unreached = botHarness();
    for (const keyholder of unreached.config.keyholderIds) unreached.telegram.fail({ chatId: keyholder }, FAILURES.cantInitiateConversation);
    await approveIn(unreached);
    // The notice cannot be sent at all, by an error whose message carries the URL.
    const unsent = botHarness({
      features: (deps) => [
        reviewFeatures({
          ...deps,
          notices: {
            ...createNoticeMemory(),
            remember: () => {
              throw new AppError('UNEXPECTED', `the notice of ${REPORTED_URL}`);
            },
          },
        }),
      ],
    });
    await approveIn(unsent);
    // The approval's batch fails, and so does the read that would tell whether it landed.
    let failed = false;
    const unknown = harnessOver((db) =>
      storeWith(db, {
        batch: () => {
          failed = true;
          return Promise.reject(new AppError('STORAGE_FAILURE', `a batch of ${COMMENT}`));
        },
        first: () => (failed ? Promise.reject(new AppError('STORAGE_FAILURE', `a read of ${REPORTED_URL}`)) : undefined),
      }),
    );
    await approveIn(unknown);
    // The approval's batch fails after committing: the approval goes on.
    const landed = harnessOver((db) =>
      storeWith(db, {
        batch: async (statements) => {
          await db.batch(statements);
          throw new AppError('STORAGE_FAILURE', `a batch of ${REPORTED_URL}`);
        },
      }),
    );
    await approveIn(landed);
    for (const [harness, event] of [
      [unreached, 'review.notice_unreached'],
      [unsent, 'review.notice_failed'],
      [unknown, 'review.approval_unknown'],
      [landed, 'review.approval_landed'],
    ] as const) {
      expect(harness.log.records().map((record) => record.event), event).toContain(event);
      expectClean(harness.log.lines);
      expect(harness.log.text(), event).not.toContain('reporter_handle');
    }
  });

  it('the scheduler, when its sends, its alerts, its store and its probes fail', async () => {
    const TEXT = `<b>A post</b>\n<code>${REPORTED_URL}</code>\n${COMMENT}`;
    const lines: RecordedLine[] = [];
    const events = new Set<string>();
    const keep = (harness: TickHarness): void => {
      lines.push(...harness.log.lines);
      for (const record of harness.log.records()) events.add(String(record.event));
    };
    const unreachable = (harness: TickHarness): void => {
      harness.telegram.fail({ chatId: IDS.keyholder }, FAILURES.cantInitiateConversation);
      harness.telegram.fail({ chatId: IDS.adminChat }, FAILURES.botBlocked);
    };
    // A post's send answered 429, refused or ambiguously, every alert failing too.
    for (const failure of [rateLimited(9), FAILURES.chatNotFound, FAILURES.timeout, FAILURES.serverError, FAILURES.networkFailure]) {
      const harness = tickHarness();
      await plantApproved(harness, { text: TEXT });
      harness.telegram.fail({ method: 'sendMessage', chatId: IDS.broadcastChannel }, failure, 1);
      unreachable(harness);
      await harness.run();
      keep(harness);
    }
    // A stored post the send-time check refuses.
    const held = tickHarness();
    await plantApproved(held, { text: `${TEXT}<a href="https://evil.example/${IDS.reporter}">more</a>` });
    await held.run();
    keep(held);
    // A send whose record fails, by an error that carries the URL.
    const unrecorded = tickHarness({
      store: (db) => ({
        ...db,
        batch: (statements: readonly SqlStatement[]) =>
          String(statements[0]?.sql).startsWith("UPDATE reports SET status = 'posted'")
            ? Promise.reject(new AppError('STORAGE_FAILURE', `the record of ${REPORTED_URL}`))
            : db.batch(statements),
      }),
    });
    await plantApproved(unrecorded, { text: TEXT });
    await unrecorded.run(Date.UTC(2027, 0, 15, 12, 15));
    keep(unrecorded);
    // Reconciliation's alert failing, an edit job failing, the lockdown alert reaching a keyholder short.
    const busy = tickHarness({ edits: { close: () => Promise.reject(new Error(`an edit of ${REPORTED_URL} for ${IDS.reporter}`)) } });
    const stuck = await plantApproved(busy, { text: TEXT, startsAt: TICK_AT - 30 * 60_000 });
    await busy.db.run(sql`UPDATE reports SET status = 'posting', posting_started_at = ? WHERE id = ?`, [TICK_AT - 20 * 60_000, stuck.reportId]);
    const closing = await insertReport(busy.db, { status: 'closing' });
    const edit = enqueueEditStatement({ reportId: closing, status: 'closing', dueAt: TICK_AT, now: TICK_AT });
    await busy.db.run(edit.sql, edit.params);
    unreachable(busy);
    await busy.run(Date.UTC(2027, 0, 15, 12, 15));
    await busy.db.run(sql`INSERT INTO meta (key, value) VALUES ('lockdown', 1)`);
    await busy.run(Date.UTC(2027, 0, 15, 12, 30));
    keep(busy);
    // A storage failure that stops a run, and its alert; any other failure of a run; an unknown cron.
    const down = tickHarness({ store: (db) => ({ ...db, all: () => Promise.reject(new AppError('STORAGE_FAILURE', `a read of ${REPORTED_URL}`)) }) });
    unreachable(down);
    await down.run(Date.UTC(2027, 0, 15, 12, 15));
    handleScheduled({ cron: `${REPORTED_URL} * * *`, scheduledTime: TICK_AT }, { waitUntil: () => undefined }, down.deps);
    keep(down);
    const broken = tickHarness({ store: (db) => ({ ...db, all: () => Promise.reject(new TypeError(`a bug about ${REPORTED_URL} and ${COMMENT}`)) }) });
    await broken.run();
    keep(broken);
    // /attach: a refused probe, and a probe it cannot undo.
    const attaching = tickHarness();
    const posting = await plantApproved(attaching, { text: TEXT });
    attaching.telegram.fail({ method: 'sendMessage', chatId: IDS.broadcastChannel }, FAILURES.timeout, 1);
    await attaching.run();
    await attachPost(attaching.deps, 'keyholder', posting.reportId, 9);
    attaching.telegram.seedMessage(IDS.broadcastChannel, { message_id: 10, text: TEXT, reply_markup: postKeyboard(posting.reportId) });
    // The probe and both tries of its removal time out.
    attaching.telegram.fail({ method: 'editMessageReplyMarkup' }, FAILURES.timeout, 3);
    await attachPost(attaching.deps, 'keyholder', posting.reportId, 10);
    // Refused on the message's text, then on its date.
    attaching.telegram.seedMessage(IDS.broadcastChannel, { message_id: 12, text: `${COMMENT} ${REPORTED_URL} ${IDS.reporter}` });
    await attachPost(attaching.deps, 'keyholder', posting.reportId, 12);
    attaching.clock.set(TICK_AT + 10 * 60_000);
    attaching.telegram.seedMessage(IDS.broadcastChannel, { message_id: 13, text: plainText(TEXT) });
    await attachPost(attaching.deps, 'keyholder', posting.reportId, 13);
    // A verified post whose own keyboard cannot be put back.
    const restoring = tickHarness();
    const restored = await plantApproved(restoring, { text: TEXT });
    restoring.telegram.fail({ method: 'sendMessage', chatId: IDS.broadcastChannel }, FAILURES.timeout, 1);
    await restoring.run();
    restoring.telegram.seedMessage(IDS.broadcastChannel, { message_id: 11, text: plainText(TEXT) });
    const restoreApi = restoring.deps.api;
    let restoreCalls = 0;
    await attachPost(
      {
        ...restoring.deps,
        api: Object.assign(Object.create(restoreApi) as typeof restoreApi, {
          editMessageReplyMarkup: (...args: Parameters<typeof restoreApi.editMessageReplyMarkup>) => {
            restoreCalls += 1;
            return restoreCalls === 1
              ? restoreApi.editMessageReplyMarkup(...args)
              : Promise.reject(new Error(`the keyboard of ${REPORTED_URL} for ${IDS.reporter}`));
          },
        }),
      },
      'keyholder',
      restored.reportId,
      11,
    );
    keep(restoring);
    keep(attaching);
    // A send whose record changes no row: a second message, its alert failing too.
    const orphaned = tickHarness({
      store: (db) => ({
        ...db,
        batch: async (statements: readonly SqlStatement[]) => {
          if (String(statements[0]?.sql).startsWith("UPDATE reports SET status = 'posted'")) {
            await db.run(sql`UPDATE reports SET status = 'posted', post_message_id = 88, posted_at = posting_started_at WHERE id = ?`, [String(statements[0]?.params[2])]);
          }
          return db.batch(statements);
        },
      }),
    });
    await plantApproved(orphaned, { text: TEXT });
    unreachable(orphaned);
    await orphaned.run();
    keep(orphaned);
    // An edit job whose row cannot be read.
    const unreadable = tickHarness();
    const closingReport = await insertReport(unreadable.db, { status: 'closing' });
    await unreadable.db.run(
      sql`INSERT INTO jobs (id, kind, report_id, due_at, payload, attempts, created_at) VALUES ('unreadablejobxxxxxxx', 'edit', ?, 1, ?, 0, 1)`,
      [closingReport, JSON.stringify({ action: `${REPORTED_URL} ${IDS.reporter}` })],
    );
    await unreadable.run();
    keep(unreadable);
    // A lockdown whose retention pass fails, by an error that carries the URL.
    const locking = tickHarness();
    await lockdownNow({ ...locking.deps, retentionNow: () => Promise.reject(new Error(`the pass over ${REPORTED_URL}`)) });
    keep(locking);
    // The probe's counts.
    const probed = tickHarness();
    const probe = createProbe(probed.telegram.fetch, probed.log.logger);
    const waited: Promise<unknown>[] = [];
    await probe.scheduled?.(
      { cron: '* * * * *', scheduledTime: TICK_AT, noRetry: () => undefined },
      { ...TEST_VARIABLES, DB: new Proxy({}, { get: () => { throw new Error(`no D1 here for ${REPORTED_URL}`); } }) } as unknown as Parameters<NonNullable<typeof probe.scheduled>>[1],
      { waitUntil: (promise: Promise<unknown>) => void waited.push(promise), passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext,
    );
    await Promise.all(waited);
    // The probe's fidelity check, its texts parting, then the Bot API refusing it.
    const fidelityRequest = (): Parameters<NonNullable<typeof probe.fetch>>[0] =>
      new Request(`https://div-report-probe.test/${TEST_VARIABLES.WEBHOOK_PATH_SEGMENT}/fidelity`, { method: 'POST', headers: { [SECRET_HEADER]: TEST_VARIABLES.WEBHOOK_SECRET } });
    const fidelityEnv = { ...TEST_VARIABLES, DB: {} } as unknown as Parameters<NonNullable<typeof probe.fetch>>[1];
    const fidelityCtx = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
    await probe.fetch?.(fidelityRequest(), fidelityEnv, fidelityCtx);
    probed.telegram.fail({ method: 'sendMessage' }, FAILURES.botBlocked, 1);
    await probe.fetch?.(fidelityRequest(), fidelityEnv, fidelityCtx);
    keep(probed);
    for (const event of [
      'post.rate_limited',
      'post.refused',
      'post.ambiguous',
      'post.text_refused',
      'post.not_recorded',
      'alert.failed',
      'reconcile.alert_incomplete',
      'edit.failed',
      'lockdown.alert_incomplete',
      'tick.storage_failed',
      'tick.storage_alerted',
      'tick.failed',
      'cron.unknown',
      'attach.refused',
      'attach.text_mismatch',
      'attach.window_mismatch',
      'attach.revert_failed',
      'attach.restore_failed',
      'probe.fidelity',
      'post.resolved_elsewhere',
      'edit.unreadable',
      'retention.failed',
      'probe.invocation',
    ]) {
      expect(events.has(event), event).toBe(true);
    }
    expectClean(lines);
  });
});

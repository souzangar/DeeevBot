// Always-run invariant spec, critical invariant 6, for every code path of
// the Telegram wiring that writes a log line: the error boundary (a failing
// handler, a failing answer), the webhook (a failing update, an unreadable
// body), the Worker entry (a configuration that does not load), the
// membership check and the alerts (failing calls), the lockdown commands,
// and the intake (a reporter message, a prompt edit, the acknowledgement or
// its self-deletion failing).
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
import { botHarness } from '../support/bot-harness';
import { reporterIn } from '../support/intake-driver';
import { IDS, TEST_VARIABLES } from '../support/variables';
import { buttonPress, groupMessage, privateMessage } from '../support/updates';

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
    await alertKeyholders(deps, `Check ${REPORTED_URL}: ${COMMENT}`);
    await alertVenue(deps, `Check ${REPORTED_URL}: ${COMMENT}`);
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
});

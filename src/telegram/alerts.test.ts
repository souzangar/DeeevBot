// Unit tests for the alerts (src/telegram/alerts.ts; critical invariants 2,
// 4 and 5): every keyholder by direct message, under lockdown too, each
// failure logged by class and counted for reconciliation's retry, never
// thrown; the venue only while the bot is not locked down; and the choke
// point for every link an alert carries: a text with a tappable link off
// the lists, or a link of `links` off them, is never sent to anyone, and a
// link that passes is rendered as code text after the text.
import { describe, expect, it } from 'vitest';
import { FAILURES, fakeBotApi, rateLimited } from '../../test/fakes/bot-api';
import { fakeClock } from '../../test/fakes/clock';
import { recordingLogger } from '../../test/fakes/logger';
import { IDS, testConfig } from '../../test/support/config';
import { migratedDatabase } from '../../test/support/database';
import { setLockdown } from '../auth/lockdown';
import type { SqlDb } from '../db/sql';
import { AppError } from '../errors/app-error';
import { alertKeyholders, alertText, alertVenue } from './alerts';
import { FSI, PDI } from './render';
import { createBotApi } from './api';

const ALERT = '<b>Attention.</b> A post is waiting for a check.';

const setup = (variables: Readonly<Record<string, string | undefined>> = {}) => {
  const config = testConfig(variables);
  const telegram = fakeBotApi();
  const clock = fakeClock(1_850_000_000_000);
  const { db } = migratedDatabase(clock);
  const log = recordingLogger();
  const deps = { api: createBotApi(config, telegram.fetch), config, logger: log.logger, db };
  return { config, telegram, clock, db, log, deps };
};

describe('alertKeyholders', () => {
  it('sends the alert to every keyholder, in turn, with previews off and HTML', async () => {
    const { telegram, deps } = setup();
    const outcome = await alertKeyholders(deps, ALERT);
    expect(outcome).toEqual({
      sent: 2,
      failed: 0,
      deliveries: [
        { chatId: IDS.keyholder, messageId: 1 },
        { chatId: IDS.secondKeyholder, messageId: 1 },
      ],
    });
    expect(telegram.callsOf('sendMessage').map((call) => call.payload)).toEqual(
      [IDS.keyholder, IDS.secondKeyholder].map((chatId) => ({
        chat_id: chatId,
        text: ALERT,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      })),
    );
  });

  it('carries the buttons it is given', async () => {
    const { telegram, deps } = setup();
    const reply_markup = { inline_keyboard: [[{ text: 'Cancel', callback_data: 'notice:cancel' }]] };
    await alertKeyholders(deps, ALERT, { reply_markup });
    expect(telegram.callsOf('sendMessage').map((call) => call.payload.reply_markup)).toEqual([reply_markup, reply_markup]);
  });

  it.each([
    ['who never sent /start (403)', FAILURES.cantInitiateConversation],
    ['who blocked the bot', FAILURES.botBlocked],
    ['behind a 429', rateLimited(3)],
    ['behind a timeout', FAILURES.timeout],
  ])('counts a keyholder %s as failed, logs the class only and still alerts the others', async (_label, outcome) => {
    const { telegram, log, deps } = setup();
    telegram.fail({ chatId: IDS.keyholder }, outcome);
    const result = await alertKeyholders(deps, ALERT);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.deliveries).toEqual([{ chatId: IDS.secondKeyholder, messageId: 1 }]);
    expect(log.records()).toEqual([expect.objectContaining({ level: 'error', event: 'alert.failed' })]);
    for (const value of [String(IDS.keyholder), 'Attention', 'Forbidden', 'unit-test-bot-token']) {
      expect(log.text()).not.toContain(value);
    }
  });

  it('never throws, even when every send fails', async () => {
    const { telegram, deps } = setup();
    telegram.fail({ method: 'sendMessage' }, FAILURES.networkFailure);
    await expect(alertKeyholders(deps, ALERT)).resolves.toEqual({ sent: 0, failed: 2, deliveries: [] });
  });

  it('alerts the keyholders under lockdown too', async () => {
    const { telegram, deps, db, clock } = setup();
    await setLockdown(db, clock);
    expect((await alertKeyholders(deps, ALERT)).sent).toBe(2);
    const overridden = setup({ LOCKDOWN: '1' });
    expect((await alertKeyholders(overridden.deps, ALERT)).sent).toBe(2);
    expect(telegram.count('sendMessage') + overridden.telegram.count('sendMessage')).toBe(4);
  });
});

describe('alertVenue', () => {
  it('sends the alert to the venue while the bot is not locked down', async () => {
    const { telegram, deps } = setup();
    expect(await alertVenue(deps, ALERT)).toEqual({
      sent: 1,
      failed: 0,
      deliveries: [{ chatId: IDS.adminChat, messageId: 1 }],
      suppressed: false,
    });
    expect(telegram.callsOf('sendMessage').map((call) => call.chatId)).toEqual([IDS.adminChat]);
  });

  it('sends nothing to the venue under the lockdown switch', async () => {
    const { telegram, deps, db, clock } = setup();
    await setLockdown(db, clock);
    expect(await alertVenue(deps, ALERT)).toEqual({ sent: 0, failed: 0, deliveries: [], suppressed: true });
    expect(telegram.count()).toBe(0);
  });

  it('sends nothing under the LOCKDOWN override, without reading D1', async () => {
    const { telegram, deps } = setup({ LOCKDOWN: '1' });
    const unreadable: SqlDb = {
      run: () => Promise.reject(new AppError('STORAGE_FAILURE', 'D1 run failed')),
      all: () => Promise.reject(new AppError('STORAGE_FAILURE', 'D1 all failed')),
      first: () => Promise.reject(new AppError('STORAGE_FAILURE', 'D1 first failed')),
      batch: () => Promise.reject(new AppError('STORAGE_FAILURE', 'D1 batch failed')),
    };
    expect((await alertVenue({ ...deps, db: unreadable }, ALERT)).suppressed).toBe(true);
    expect(telegram.count()).toBe(0);
  });

  it('logs a failed venue send by class and counts it', async () => {
    const { telegram, log, deps } = setup();
    telegram.fail({ chatId: IDS.adminChat }, FAILURES.chatNotFound);
    expect(await alertVenue(deps, ALERT)).toEqual({ sent: 0, failed: 1, deliveries: [], suppressed: false });
    expect(log.records()).toEqual([
      { level: 'error', event: 'alert.failed', errorClass: 'GrammyError', telegramErrorCode: 400, apiMethod: 'sendMessage' },
    ]);
  });
});

describe('the choke point for an alert\'s links', () => {
  it('sends a link of `links` that passes the policy as code text, after the text', async () => {
    const { deps, telegram } = setup();
    await alertKeyholders(deps, ALERT, { links: ['https://x.com/someone', 'https://report.cybertip.org/'] });
    expect(telegram.callsOf('sendMessage').map((call) => call.payload.text)).toEqual(
      Array.from({ length: 2 }, () => `${ALERT}\n${FSI}<code>https://x.com/someone</code>${PDI}\n${FSI}<code>https://report.cybertip.org/</code>${PDI}`),
    );
  });

  it('refuses, sending nothing to anyone, a link off the lists, a redirector or a Telegram target', async () => {
    const { deps, telegram } = setup();
    for (const link of ['https://evil.example/page', 'https://t.co/abc', 'https://t.me/somechannel', 'http://x.com/someone', 'https://x.com/someone?ref=1']) {
      await expect(alertKeyholders(deps, ALERT, { links: [link] }), link).rejects.toMatchObject({ code: 'UNEXPECTED' });
      await expect(alertVenue(deps, ALERT, { links: [link] }), link).rejects.toMatchObject({ code: 'UNEXPECTED' });
    }
    expect(telegram.calls).toEqual([]);
  });

  it('refuses, sending nothing, a text with a tappable link off the lists or over 4096 characters', async () => {
    const { deps, telegram, config } = setup();
    for (const text of ['Check https://evil.example/ now', 'See <a href="https://evil.example/">it</a> there', 'Mail someone@example.org', `${'x'.repeat(4097)}`]) {
      await expect(alertKeyholders(deps, text), text.slice(0, 30)).rejects.toMatchObject({ code: 'UNEXPECTED' });
      expect(() => alertText(config, text), text.slice(0, 30)).toThrow(AppError);
    }
    expect(telegram.calls).toEqual([]);
    expect(alertText(config, 'A <code>https://evil.example/</code> shown as code')).toBe('A <code>https://evil.example/</code> shown as code');
  });

  it('names neither the text nor the link in its refusal', () => {
    const { config } = setup();
    const caught: unknown = (() => {
      try {
        return alertText(config, 'ok', ['https://evil.example/secret-path']);
      } catch (error) {
        return error;
      }
    })();
    expect(String((caught as Error).message)).not.toContain('evil.example');
  });
});

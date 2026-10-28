// Unit tests for "I reported it" (src/telegram/presses.ts) through the
// composed bot over node:sqlite: the press answered first and always, the
// two counts written together and only when every condition holds (the
// post's own message in the channel, a posted report, both caps, no
// lockdown), the day's count per UTC day, and nothing about the presser
// stored. The same statements run on D1 in test/workers/d1.test.ts.
import { describe, expect, it } from 'vitest';
import { botHarness, NOW, type BotHarness } from '../../test/support/bot-harness';
import { IDS } from '../../test/support/config';
import { buttonPress } from '../../test/support/updates';
import { setLockdown } from '../auth/lockdown';
import { randomId } from '../db/ids';
import { sql, type SqlDb } from '../db/sql';
import { AppError } from '../errors/app-error';
import { t } from '../i18n/index';
import { MARK_DATA, markData, PRESS_COUNTER, recordPress, utcDay } from './presses';

const POST_MESSAGE = 77;
const INSERT_REPORT = sql`INSERT INTO reports (id, status, platform, category, created_at, posting_started_at, posted_at, post_message_id) VALUES (?, ?, 'instagram', 'harassment', ?, ?, ?, ?)`;
const PRESSES = sql`SELECT presses FROM reports WHERE id = ?`;
const COUNTERS = sql`SELECT day, key, count FROM counters ORDER BY day, key`;

/** A report in `status`, posted as message `messageId` of the channel when posted. */
const report = async (db: SqlDb, status = 'posted', messageId = POST_MESSAGE): Promise<string> => {
  const id = randomId();
  const posted = status === 'pending' ? null : NOW - 60_000;
  await db.run(INSERT_REPORT, [id, status, NOW - 120_000, posted, posted, posted === null ? null : messageId]);
  return id;
};

const pressesOf = async (db: SqlDb, id: string): Promise<unknown> => (await db.first<{ presses: number }>(PRESSES, [id]))?.presses;

/** A press of report `id`'s button by `userId`, on message `messageId` of `chatId`. */
const press = (harness: BotHarness, id: string, options: { userId?: number; messageId?: number; chatId?: number; data?: string; languageCode?: string } = {}) =>
  harness.send(
    buttonPress(
      options.userId ?? IDS.reporter,
      options.data ?? markData(id),
      { chatId: options.chatId ?? IDS.broadcastChannel, messageId: options.messageId ?? POST_MESSAGE },
      options.languageCode === undefined ? {} : { languageCode: options.languageCode },
    ),
  );

describe('a press', () => {
  it('is answered "thank you" first, then counted on the report and on the day, together', async () => {
    const harness = botHarness();
    const id = await report(harness.db);
    await press(harness, id);
    expect(harness.telegram.calls.map((call) => call.method)).toEqual(['answerCallbackQuery']);
    expect(harness.telegram.calls[0]?.payload).toMatchObject({ text: t('en', 'press.thanks') });
    expect(await pressesOf(harness.db, id)).toBe(1);
    expect(await harness.db.all(COUNTERS)).toEqual([{ day: '2027-01-15', key: PRESS_COUNTER, count: 1 }]);
    await press(harness, id, { userId: IDS.stranger });
    expect(await pressesOf(harness.db, id)).toBe(2);
    expect(await harness.db.all(COUNTERS)).toEqual([{ day: '2027-01-15', key: PRESS_COUNTER, count: 2 }]);
  });

  it("is thanked in the presser's locale", async () => {
    const harness = botHarness();
    await press(harness, await report(harness.db), { languageCode: 'fa' });
    expect(harness.telegram.calls[0]?.payload).toMatchObject({ text: t('fa', 'press.thanks') });
  });

  it('counts presses, not people: the same account twice is two', async () => {
    const harness = botHarness();
    const id = await report(harness.db);
    await press(harness, id);
    await press(harness, id);
    expect(await pressesOf(harness.db, id)).toBe(2);
  });

  it('stores nothing about the presser', async () => {
    const harness = botHarness();
    await press(harness, await report(harness.db), { userId: IDS.stranger });
    const everything = JSON.stringify([
      await harness.db.all(sql`SELECT * FROM reports`),
      await harness.db.all(sql`SELECT * FROM counters`),
      await harness.db.all(sql`SELECT * FROM meta`),
      await harness.db.all(sql`SELECT * FROM reporter_stats`),
      await harness.db.all(sql`SELECT * FROM drafts`),
    ]);
    expect(everything).not.toContain(String(IDS.stranger));
    expect(await harness.db.all(sql`SELECT * FROM reporter_stats`)).toEqual([]);
  });

  it('starts a new day count at midnight UTC, the report keeping its own', async () => {
    const harness = botHarness();
    const id = await report(harness.db);
    await press(harness, id);
    harness.clock.set(Date.UTC(2027, 0, 16, 0, 0, 1));
    await press(harness, id);
    expect(await pressesOf(harness.db, id)).toBe(2);
    expect(await harness.db.all(COUNTERS)).toEqual([
      { day: '2027-01-15', key: PRESS_COUNTER, count: 1 },
      { day: '2027-01-16', key: PRESS_COUNTER, count: 1 },
    ]);
  });
});

describe('a press that is answered and not counted', () => {
  const expectNothingCounted = async (harness: BotHarness, id: string) => {
    expect(harness.telegram.callsOf('answerCallbackQuery')).toHaveLength(1);
    expect(harness.telegram.count()).toBe(1);
    expect(await pressesOf(harness.db, id)).toBe(0);
    expect(await harness.db.all(COUNTERS)).toEqual([]);
  };

  it.each(['pending', 'approved', 'posting', 'closing', 'retracting', 'closed', 'retracted', 'expired'])(
    'of a report that is %s, not posted',
    async (status) => {
      // Inserted as is (the approval trigger guards updates), with the post's
      // message id, so the status is the only condition that fails.
      const harness = botHarness();
      const id = randomId();
      await harness.db.run(INSERT_REPORT, [id, status, NOW - 120_000, NOW - 60_000, NOW - 60_000, POST_MESSAGE]);
      await press(harness, id);
      await expectNothingCounted(harness, id);
    },
  );

  it("on a message that is not this report's post", async () => {
    const harness = botHarness();
    const id = await report(harness.db);
    await press(harness, id, { messageId: POST_MESSAGE + 1 });
    await expectNothingCounted(harness, id);
  });

  it('on a message outside the broadcast channel, a private chat or the venue', async () => {
    const harness = botHarness();
    const id = await report(harness.db);
    await press(harness, id, { chatId: IDS.reporter });
    await press(harness, id, { chatId: IDS.adminChat });
    expect(harness.telegram.callsOf('answerCallbackQuery')).toHaveLength(2);
    expect(await pressesOf(harness.db, id)).toBe(0);
    expect(await harness.db.all(COUNTERS)).toEqual([]);
  });

  it.each([
    ['a short id', 'mark:abc'],
    ['an id with a digit', 'mark:abcdefghijklmnopqrs1'],
    ['an uppercase id', 'mark:ABCDEFGHIJKLMNOPQRST'],
    ['trailing data', 'mark:abcdefghijklmnopqrst:x'],
    ['an empty id', 'mark:'],
  ])('with %s', async (_label, data) => {
    const harness = botHarness();
    const id = await report(harness.db);
    await press(harness, id, { data });
    await expectNothingCounted(harness, id);
  });

  it('of a report that does not exist', async () => {
    const harness = botHarness();
    const id = await report(harness.db);
    await press(harness, id, { data: markData(randomId()) });
    await expectNothingCounted(harness, id);
  });

  it('past MARKS_PER_REPORT', async () => {
    const harness = botHarness({ variables: { MARKS_PER_REPORT: '2' } });
    const id = await report(harness.db);
    for (let count = 0; count < 4; count += 1) await press(harness, id);
    expect(harness.telegram.callsOf('answerCallbackQuery')).toHaveLength(4);
    expect(await pressesOf(harness.db, id)).toBe(2);
    expect(await harness.db.all(COUNTERS)).toEqual([{ day: '2027-01-15', key: PRESS_COUNTER, count: 2 }]);
  });

  it('past MARKS_PER_DAY, all reports together', async () => {
    const harness = botHarness({ variables: { MARKS_PER_DAY: '3' } });
    const first = await report(harness.db, 'posted', 1);
    const second = await report(harness.db, 'posted', 2);
    await press(harness, first, { messageId: 1 });
    await press(harness, first, { messageId: 1 });
    await press(harness, second, { messageId: 2 });
    await press(harness, second, { messageId: 2 });
    expect([await pressesOf(harness.db, first), await pressesOf(harness.db, second)]).toEqual([2, 1]);
    expect(await harness.db.all(COUNTERS)).toEqual([{ day: '2027-01-15', key: PRESS_COUNTER, count: 3 }]);
  });

  it('with either cap at 0', async () => {
    for (const variables of [{ MARKS_PER_DAY: '0' }, { MARKS_PER_REPORT: '0' }]) {
      const harness = botHarness({ variables });
      const id = await report(harness.db);
      await press(harness, id);
      await expectNothingCounted(harness, id);
    }
  });

  it('under the lockdown switch', async () => {
    const harness = botHarness();
    const id = await report(harness.db);
    await setLockdown(harness.db, harness.clock);
    await press(harness, id);
    await expectNothingCounted(harness, id);
  });

  it('under the LOCKDOWN override', async () => {
    const harness = botHarness({ variables: { LOCKDOWN: '1' } });
    const id = await report(harness.db);
    await press(harness, id);
    await expectNothingCounted(harness, id);
  });
});

describe('a press whose counting fails', () => {
  it('is answered once: the boundary logs the failure and sends no second answer', async () => {
    const harness = botHarness();
    const id = await report(harness.db);
    harness.connection.exec('DROP TABLE counters');
    await press(harness, id);
    expect(harness.telegram.callsOf('answerCallbackQuery')).toHaveLength(1);
    expect(harness.telegram.calls[0]?.payload).toMatchObject({ text: t('en', 'press.thanks') });
    expect(harness.log.records()).toEqual([
      { level: 'error', event: 'update.failed', errorClass: 'AppError', errorCode: 'STORAGE_FAILURE' },
    ]);
  });
});

describe('recordPress', () => {
  const failing: SqlDb = {
    run: () => Promise.reject(new AppError('STORAGE_CAP_HIT', 'D1 run failed')),
    all: () => Promise.reject(new AppError('STORAGE_CAP_HIT', 'D1 all failed')),
    first: () => Promise.reject(new AppError('STORAGE_CAP_HIT', 'D1 first failed')),
    batch: () => Promise.reject(new AppError('STORAGE_CAP_HIT', 'D1 batch failed')),
  };
  const config = { broadcastChatId: IDS.broadcastChannel, marksPerDay: 10, marksPerReport: 10 };
  const clock = { now: () => NOW };

  it('runs no query at all under the LOCKDOWN override', async () => {
    expect(await recordPress({ config: { ...config, lockdown: true }, db: failing, clock }, randomId(), 1)).toBe(false);
  });

  it('lets a storage failure through, for the error boundary to log', async () => {
    await expect(recordPress({ config: { ...config, lockdown: false }, db: failing, clock }, randomId(), 1)).rejects.toMatchObject({
      code: 'STORAGE_CAP_HIT',
    });
  });
});

describe('the button data', () => {
  it('is mark: and the report id, well under 64 bytes, and matches its own shape only', () => {
    const id = randomId();
    expect(markData(id)).toBe(`mark:${id}`);
    expect(new TextEncoder().encode(markData(id)).length).toBeLessThan(64);
    expect(MARK_DATA.exec(markData(id))?.[1]).toBe(id);
  });

  it('days are UTC days', () => {
    expect(utcDay(Date.UTC(2027, 11, 31, 23, 59, 59))).toBe('2027-12-31');
    expect(utcDay(Date.UTC(2028, 0, 1))).toBe('2028-01-01');
  });
});

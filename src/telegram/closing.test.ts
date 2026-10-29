// Unit tests for the closure unit's commands (src/telegram/closing.ts;
// critical invariants 1, 2, 5 and 8), through the composed bot over the
// fakes, with reports posted by a real run: /close in the venue, answered
// there in its one language; /retract from an admin in the venue and from a
// keyholder in their own chat, each prompted where they typed it and each
// reply taken, the prompt and the reply deleted, the command a keyholder
// typed kept; /stats in both places, a month given or not; /budget; a
// keyholder's reply to anything else falling through; the registrations on
// the review's surface.
import type { Update } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import { sql } from '../db/sql';
import { t } from '../i18n/index';
import { outcomeNameKey } from '../review/names';
import { statsText, readStats, currentMonth } from '../broadcast/stats';
import { reviewIn } from '../../test/support/review-driver';
import { reportRow } from '../../test/support/review-rows';
import { plantPosted, tickHarness, type TickHarness } from '../../test/support/tick-harness';
import { IDS } from '../../test/support/variables';
import { groupMessage, privateMessage } from '../../test/support/updates';
import { CLOSURE_ADMIN_COMMANDS, CLOSURE_KEYHOLDER_COMMANDS, parseClose } from './closing';
import { reviewSurface } from './review';

const CORRECTION = 'This account was the victim, not the author. Please do not report it.';

const venue = (harness: TickHarness, text: string, from: number = IDS.admin) => harness.send(groupMessage(IDS.adminChat, from, text));
const lastTo = (harness: TickHarness, chatId: number) => harness.textsTo(chatId).at(-1);
const isForceReply = (markup: unknown): boolean => (markup as { force_reply?: boolean } | undefined)?.force_reply === true;
/** The bot's latest force-reply prompt in `chatId`. */
const promptIn = (harness: TickHarness, chatId: number) => harness.telegram.messagesIn(chatId).filter((message) => isForceReply(message.reply_markup)).at(-1);

/** A keyholder's reply in their own chat to message `replyTo`, as Telegram holds it; its message id. */
const keyholderReply = async (harness: TickHarness, keyholderId: number, replyTo: number, text: string, languageCode = 'en'): Promise<number> => {
  const messageId = harness.telegram.receive(keyholderId, { text });
  const update = privateMessage(keyholderId, text, { replyToBot: replyTo, languageCode });
  await harness.send({ ...update, message: { ...update.message, message_id: messageId } } as Update);
  return messageId;
};

describe('parseClose', () => {
  it('reads an id and an outcome, whatever their case, and nothing else', () => {
    expect(parseClose('abcdefghijklmnopqrst taken_down')).toEqual({ ok: true, reportId: 'abcdefghijklmnopqrst', outcome: 'taken_down' });
    expect(parseClose('  ABCDEFGHIJKLMNOPQRST   No_Result ')).toEqual({ ok: true, reportId: 'abcdefghijklmnopqrst', outcome: 'no_result' });
    for (const argument of ['', 'abcdefghijklmnopqrst', 'abcdefghijklmnopqrst expired', 'abcdefghijklmnopqrst taken_down now', 'abc taken_down', 'taken_down abcdefghijklmnopqrst']) {
      expect(parseClose(argument), argument).toEqual({ ok: false });
    }
  });
});

describe('/close', () => {
  it("closes a posted report from the venue, answered in the venue's language with the outcome's name", async () => {
    const harness = tickHarness();
    const posted = await plantPosted(harness);
    await venue(harness, `/close ${posted.reportId} taken_down`);
    const locale = harness.config.venueLocale;
    expect(lastTo(harness, IDS.adminChat)).toBe(t(locale, 'close.done', { id: posted.reportId, outcome: t(locale, outcomeNameKey('taken_down')) }));
    expect(await reportRow(harness.db, posted.reportId)).toMatchObject({ status: 'closing', outcome: 'taken_down' });
  });

  it('answers the usage, an unknown id and a report that cannot be closed', async () => {
    const harness = tickHarness();
    const posted = await plantPosted(harness);
    const locale = harness.config.venueLocale;
    await venue(harness, `/close ${posted.reportId}`);
    expect(lastTo(harness, IDS.adminChat)).toBe(t(locale, 'close.usage'));
    await venue(harness, '/close nosuchreportxxxxxxxx no_result');
    expect(lastTo(harness, IDS.adminChat)).toBe(t(locale, 'close.not_found'));
    await venue(harness, `/close ${posted.reportId} no_result`);
    await venue(harness, `/close ${posted.reportId} taken_down`);
    expect(lastTo(harness, IDS.adminChat)).toBe(t(locale, 'close.refused', { id: posted.reportId }));
    expect(await reportRow(harness.db, posted.reportId)).toMatchObject({ outcome: 'no_result' });
  });

  it('is no command for a keyholder, in their chat or in the venue', async () => {
    const harness = tickHarness();
    const posted = await plantPosted(harness);
    await harness.send(privateMessage(IDS.keyholder, `/close ${posted.reportId} taken_down`));
    await venue(harness, `/close ${posted.reportId} taken_down`, IDS.keyholder);
    expect(await reportRow(harness.db, posted.reportId)).toMatchObject({ status: 'posted' });
  });
});

describe('/retract', () => {
  it("from an admin: the prompt in the venue, the reply taken there, the report retracting, the prompt and the reply deleted", async () => {
    const harness = tickHarness();
    const posted = await plantPosted(harness);
    await venue(harness, `/retract ${posted.reportId}`);
    const prompt = promptIn(harness, IDS.adminChat);
    expect(prompt?.text).toBe(t(harness.config.venueLocale, 'retract.prompt', { id: posted.reportId }));
    const replyId = await reviewIn(harness).reply(IDS.admin, prompt?.message_id ?? 0, CORRECTION);
    expect(await reportRow(harness.db, posted.reportId)).toMatchObject({ status: 'retracting', correction_text: CORRECTION });
    expect(harness.telegram.messageIn(IDS.adminChat, prompt?.message_id ?? 0)).toBeUndefined();
    expect(harness.telegram.messageIn(IDS.adminChat, replyId)).toBeUndefined();
    expect(lastTo(harness, IDS.adminChat)).toBe(t(harness.config.venueLocale, 'retract.done', { id: posted.reportId }));
  });

  it("from a keyholder: the prompt in their own chat, in their language, the reply taken there, the command kept", async () => {
    const harness = tickHarness();
    const posted = await plantPosted(harness);
    const command = harness.telegram.receive(IDS.keyholder, { text: `/retract ${posted.reportId}` });
    const update = privateMessage(IDS.keyholder, `/retract ${posted.reportId}`, { languageCode: 'fa' });
    await harness.send({ ...update, message: { ...update.message, message_id: command } } as Update);
    const prompt = promptIn(harness, IDS.keyholder);
    expect(prompt?.text).toBe(t('fa', 'retract.prompt', { id: posted.reportId }));
    const replyId = await keyholderReply(harness, IDS.keyholder, prompt?.message_id ?? 0, CORRECTION, 'fa');
    expect(await reportRow(harness.db, posted.reportId)).toMatchObject({ status: 'retracting', correction_text: CORRECTION });
    expect(harness.telegram.messageIn(IDS.keyholder, prompt?.message_id ?? 0)).toBeUndefined();
    expect(harness.telegram.messageIn(IDS.keyholder, replyId)).toBeUndefined();
    expect(harness.telegram.messageIn(IDS.keyholder, command)).toBeDefined();
    expect(lastTo(harness, IDS.keyholder)).toBe(t('fa', 'retract.done', { id: posted.reportId }));
  });

  it("answers the usage, an unknown id and a report that cannot be retracted, in the asker's language", async () => {
    const harness = tickHarness();
    await harness.send(privateMessage(IDS.keyholder, '/retract'));
    expect(lastTo(harness, IDS.keyholder)).toBe(t('en', 'retract.usage'));
    await harness.send(privateMessage(IDS.keyholder, '/retract nosuchreportxxxxxxxx'));
    expect(lastTo(harness, IDS.keyholder)).toBe(t('en', 'retract.not_found'));
    const pending = await reviewIn(harness).submit({ url: 'https://x.com/someone/status/1234567890', category: 'harassment', affected: false });
    await venue(harness, `/retract ${pending.reportId}`);
    expect(lastTo(harness, IDS.adminChat)).toBe(t(harness.config.venueLocale, 'retract.refused', { id: pending.reportId }));
  });

  it("lets a keyholder's reply to anything but their retraction prompt fall through, writing nothing", async () => {
    const harness = tickHarness();
    const posted = await plantPosted(harness);
    harness.telegram.seedMessage(IDS.keyholder, { message_id: 40, text: 'an alert' });
    await keyholderReply(harness, IDS.keyholder, 40, CORRECTION);
    expect(await harness.db.all(sql`SELECT * FROM admin_prompts`)).toEqual([]);
    expect(await reportRow(harness.db, posted.reportId)).toMatchObject({ status: 'posted', correction_text: null });
  });

  it("refuses the second keyholder's reply to the first keyholder's prompt", async () => {
    const harness = tickHarness();
    const posted = await plantPosted(harness);
    await harness.send(privateMessage(IDS.keyholder, `/retract ${posted.reportId}`));
    const prompt = promptIn(harness, IDS.keyholder);
    await keyholderReply(harness, IDS.secondKeyholder, prompt?.message_id ?? 0, CORRECTION);
    expect(await reportRow(harness.db, posted.reportId)).toMatchObject({ status: 'posted', correction_text: null });
  });
});

describe('/stats and /budget', () => {
  it("answer an admin in the venue and a keyholder in their own chat, this month or the month given", async () => {
    const harness = tickHarness();
    await harness.db.run(
      sql`INSERT INTO stats (report_id, category, platform, created_day, decided_day, closed_day, outcome, presses, link_hash) VALUES ('statsreportxxxxxxxxx', 'harassment', 'x', '2026-12-01', '2026-12-02', '2026-12-20', 'taken_down', 4, ?)`,
      ['c'.repeat(64)],
    );
    await venue(harness, '/stats 2026-12');
    expect(lastTo(harness, IDS.adminChat)).toContain(t(harness.config.venueLocale, 'stats.total', { count: 1 }));
    await harness.send(privateMessage(IDS.keyholder, '/stats', { languageCode: 'fa' }));
    const period = currentMonth(harness.clock.now());
    expect(lastTo(harness, IDS.keyholder)).toBe(statsText('fa', await readStats(harness.db, period), period));
    await harness.send(privateMessage(IDS.keyholder, '/stats december'));
    expect(lastTo(harness, IDS.keyholder)).toBe(t('en', 'stats.usage'));
  });

  it("/budget answers an admin in the venue with the day's counters, and is no keyholder's command", async () => {
    const harness = tickHarness();
    await venue(harness, '/budget');
    expect(lastTo(harness, IDS.adminChat)).toBe(
      t(harness.config.venueLocale, 'budget.text', { day: '2027-01-15', presses: 0, pressCap: harness.config.marksPerDay, nonMembers: 0, nonMemberCap: 20 }),
    );
    await harness.send(privateMessage(IDS.keyholder, '/budget'));
    expect(lastTo(harness, IDS.keyholder)).toBe(t('en', 'fallback.help'));
  });
});

describe('the registrations', () => {
  it("are on the review surface: four admin commands, two keyholder commands and the keyholder's reply", () => {
    const harness = tickHarness();
    const registered = reviewSurface({ config: harness.config, db: harness.db, clock: harness.clock, logger: harness.log.logger }).registrations();
    expect(registered.adminCommands.slice(-4)).toEqual([...CLOSURE_ADMIN_COMMANDS]);
    expect(registered.keyholderCommands.slice(-2)).toEqual([...CLOSURE_KEYHOLDER_COMMANDS]);
    expect(registered.keyholderReplies).toBe(1);
    expect(registered.adminReplies).toBe(1);
  });
});

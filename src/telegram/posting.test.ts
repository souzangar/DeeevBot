// Unit tests for the scheduler's commands (src/telegram/posting.ts;
// critical invariants 1, 2 and 5), through the composed bot over the fakes:
// /attach, /repost, /halt and /resume from an admin in the venue, answered
// in the venue's language; /attach and /halt from a keyholder in their own
// chat, answered in theirs and never deleted; from anyone else, or
// anywhere else, no command at all; every answer in the chat it was typed
// in, the link given never echoed.
import { describe, expect, it } from 'vitest';
import { sql } from '../db/sql';
import { t } from '../i18n/index';
import { FAILURES } from '../../test/fakes/bot-api';
import { reportRow } from '../../test/support/review-rows';
import { plantApproved, TICK_AT, tickHarness, type PlantedPost, type TickHarness } from '../../test/support/tick-harness';
import { IDS } from '../../test/support/variables';
import { groupMessage, privateMessage } from '../../test/support/updates';
import { postKeyboard, POSTING_WINDOW_MS } from '../broadcast/post';
import { plainText } from '../review/render-post';
import { channelLinkId } from '../broadcast/attach';
import { POSTING_ADMIN_COMMANDS, POSTING_KEYHOLDER_COMMANDS } from './posting';
import { reviewSurface } from './review';

const POST = 41;

/** A report whose send timed out, its post in the channel all the same. */
const ambiguous = async (harness: TickHarness): Promise<PlantedPost> => {
  const planted = await plantApproved(harness);
  harness.telegram.fail({ method: 'sendMessage', chatId: IDS.broadcastChannel }, FAILURES.timeout, 1);
  await harness.run();
  // As Telegram holds it: the post's plain text, sent at the claim.
  harness.telegram.seedMessage(IDS.broadcastChannel, { message_id: POST, text: plainText(planted.text), reply_markup: postKeyboard(planted.reportId) });
  return planted;
};

const venue = (harness: TickHarness, text: string, from: number = IDS.admin) => harness.send(groupMessage(IDS.adminChat, from, text));
const lastTo = (harness: TickHarness, chatId: number) => harness.textsTo(chatId).at(-1);

describe('the registrations', () => {
  it('are on the review surface: four admin commands and two keyholder commands', () => {
    const harness = tickHarness();
    const registered = reviewSurface({ config: harness.config, db: harness.db, clock: harness.clock, logger: harness.log.logger }).registrations();
    expect(registered.adminCommands).toEqual(expect.arrayContaining([...POSTING_ADMIN_COMMANDS]));
    expect(registered.keyholderCommands).toEqual(expect.arrayContaining([...POSTING_KEYHOLDER_COMMANDS]));
    expect([...POSTING_KEYHOLDER_COMMANDS]).toEqual(['attach', 'halt']);
  });
});

describe('/attach', () => {
  it("from an admin in the venue: recorded, answered in the venue's language with the message id only", async () => {
    const harness = tickHarness();
    const planted = await ambiguous(harness);
    const link = `https://t.me/c/${channelLinkId(IDS.broadcastChannel) ?? ''}/${POST}`;
    await venue(harness, `/attach ${planted.reportId} ${link}`);
    expect((await reportRow(harness.db, planted.reportId))?.status).toBe('posted');
    const answer = lastTo(harness, IDS.adminChat);
    expect(answer).toBe(t(harness.config.venueLocale, 'attach.done', { id: planted.reportId, message: POST }));
    expect(answer).not.toContain('t.me');
  });

  it("from a keyholder in their own chat: answered in the keyholder's language, the command kept", async () => {
    const harness = tickHarness();
    const planted = await ambiguous(harness);
    await harness.send(privateMessage(IDS.keyholder, `/attach ${planted.reportId} ${POST}`, { languageCode: 'fa' }));
    expect(lastTo(harness, IDS.keyholder)).toBe(t('fa', 'attach.done', { id: planted.reportId, message: POST }));
    expect(harness.telegram.callsOf('deleteMessage').filter((call) => call.chatId === IDS.keyholder)).toEqual([]);
  });

  it('answers the usage, another channel, and each refusal', async () => {
    const harness = tickHarness();
    const planted = await ambiguous(harness);
    const locale = harness.config.venueLocale;
    await venue(harness, '/attach');
    expect(lastTo(harness, IDS.adminChat)).toBe(t(locale, 'attach.usage'));
    await venue(harness, `/attach ${planted.reportId} https://t.me/c/1234567890/${POST}`);
    expect(lastTo(harness, IDS.adminChat)).toBe(t(locale, 'attach.other_channel'));
    await venue(harness, `/attach ${planted.reportId} 9`);
    expect(lastTo(harness, IDS.adminChat)).toBe(t(locale, 'attach.not_verified', { id: planted.reportId }));
    await venue(harness, `/attach abcdefghijklmnopqrst ${POST}`);
    expect(lastTo(harness, IDS.adminChat)).toBe(t(locale, 'attach.not_found'));
  });
});

describe("/attach's two refusals of a verified probe", () => {
  it("say a text that is not this report's post apart from a date outside its window, in the venue's language", async () => {
    const harness = tickHarness();
    const planted = await ambiguous(harness);
    const locale = harness.config.venueLocale;
    harness.telegram.seedMessage(IDS.broadcastChannel, { message_id: 70, text: 'A note posted by hand' });
    await venue(harness, `/attach ${planted.reportId} 70`);
    expect(lastTo(harness, IDS.adminChat)).toBe(t(locale, 'attach.text_mismatch', { id: planted.reportId }));
    harness.clock.set(TICK_AT + 10 * 60_000);
    harness.telegram.seedMessage(IDS.broadcastChannel, { message_id: 71, text: plainText(planted.text) });
    await venue(harness, `/attach ${planted.reportId} 71`);
    expect(lastTo(harness, IDS.adminChat)).toBe(t(locale, 'attach.window_mismatch', { id: planted.reportId }));
    expect(t(locale, 'attach.text_mismatch', { id: planted.reportId })).not.toBe(t(locale, 'attach.window_mismatch', { id: planted.reportId }));
  });

  it("say so to a keyholder in the keyholder's own language", async () => {
    const harness = tickHarness();
    const planted = await ambiguous(harness);
    harness.telegram.seedMessage(IDS.broadcastChannel, { message_id: 72, text: 'A note posted by hand' });
    await harness.send(privateMessage(IDS.keyholder, `/attach ${planted.reportId} 72`, { languageCode: 'fa' }));
    expect(lastTo(harness, IDS.keyholder)).toBe(t('fa', 'attach.text_mismatch', { id: planted.reportId }));
    harness.clock.set(TICK_AT + 10 * 60_000);
    harness.telegram.seedMessage(IDS.broadcastChannel, { message_id: 73, text: plainText(planted.text) });
    await harness.send(privateMessage(IDS.keyholder, `/attach ${planted.reportId} 73`));
    expect(lastTo(harness, IDS.keyholder)).toBe(t('en', 'attach.window_mismatch', { id: planted.reportId }));
  });
});

describe('/repost', () => {
  it('from an admin in the venue, once the send window is over', async () => {
    const harness = tickHarness();
    const planted = await ambiguous(harness);
    const locale = harness.config.venueLocale;
    await venue(harness, `/repost ${planted.reportId}`);
    expect(lastTo(harness, IDS.adminChat)).toBe(t(locale, 'repost.refused', { id: planted.reportId }));
    harness.clock.advance(POSTING_WINDOW_MS);
    await venue(harness, `/repost ${planted.reportId.toUpperCase()}`);
    expect(lastTo(harness, IDS.adminChat)).toBe(t(locale, 'repost.done', { id: planted.reportId }));
    expect((await reportRow(harness.db, planted.reportId))?.status).toBe('approved');
    await venue(harness, '/repost nonsense');
    expect(lastTo(harness, IDS.adminChat)).toBe(t(locale, 'repost.usage'));
    await venue(harness, '/repost abcdefghijklmnopqrst');
    expect(lastTo(harness, IDS.adminChat)).toBe(t(locale, 'repost.not_found'));
  });

  it('is no keyholder command: from a keyholder in their own chat it is an unknown command', async () => {
    const harness = tickHarness();
    const planted = await ambiguous(harness);
    harness.clock.set(TICK_AT + POSTING_WINDOW_MS);
    await harness.send(privateMessage(IDS.keyholder, `/repost ${planted.reportId}`));
    expect((await reportRow(harness.db, planted.reportId))?.status).toBe('posting');
    expect(lastTo(harness, IDS.keyholder)).toBe(t('en', 'fallback.help'));
  });
});

describe('/halt and /resume', () => {
  it('from an admin in the venue: halted once, resumed once, each said so', async () => {
    const harness = tickHarness();
    const locale = harness.config.venueLocale;
    await venue(harness, '/halt');
    await venue(harness, '/halt', IDS.secondAdmin);
    await venue(harness, '/resume');
    await venue(harness, '/resume');
    expect(harness.textsTo(IDS.adminChat)).toEqual([t(locale, 'halt.on'), t(locale, 'halt.already_on'), t(locale, 'halt.off'), t(locale, 'halt.was_off')]);
    expect(harness.log.records().map((record) => record.event)).toEqual(['halt.set', 'halt.cleared']);
  });

  it('/halt holds the posts, and /resume lets them go', async () => {
    const harness = tickHarness();
    await plantApproved(harness);
    await venue(harness, '/halt');
    expect((await harness.run()).post).toBe('skipped');
    await venue(harness, '/resume');
    expect((await harness.run()).post).toBe('posted');
  });

  it("from a keyholder: /halt in their own chat, in their language; /resume is no keyholder command", async () => {
    const harness = tickHarness();
    await harness.send(privateMessage(IDS.keyholder, '/halt', { languageCode: 'fa' }));
    expect(harness.textsTo(IDS.keyholder)).toEqual([t('fa', 'halt.on')]);
    await harness.send(privateMessage(IDS.keyholder, '/resume'));
    expect(await harness.db.first(sql`SELECT count(*) AS n FROM meta WHERE key = 'halted'`)).toEqual({ n: 1 });
  });

  it('from anyone else, or anywhere else, are no commands', async () => {
    const harness = tickHarness();
    for (const update of [
      privateMessage(IDS.admin, '/halt'),
      privateMessage(IDS.reporter, '/halt'),
      groupMessage(IDS.adminChat, IDS.keyholder, '/halt'),
      groupMessage(IDS.adminChat, IDS.reporter, '/halt'),
      groupMessage(IDS.membershipChat, IDS.admin, '/halt'),
      privateMessage(IDS.admin, '/halt', { forwarded: true }),
    ]) {
      await harness.send(update);
    }
    expect(await harness.db.first(sql`SELECT count(*) AS n FROM meta WHERE key = 'halted'`)).toEqual({ n: 0 });
  });
});

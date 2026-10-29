// Unit tests for the intake's pure logic (src/review/intake.ts): what a
// message is (text only: media, forwards, inline-bot messages and external
// replies refused; /cancel and /skip, plain or addressed to this bot; other
// commands left alone), the one link of a text, the comment's bound, the
// press data and the steps they answer, a draft's consistency, and the
// acknowledgement's deadline.
import type { Message, Update } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import { IDS } from '../../test/support/variables';
import { MEDIA_KINDS, privateMedia, privateMessage } from '../../test/support/updates';
import { CATEGORIES } from './categories';
import {
  ackDeleteAt,
  checkComment,
  classifyMessage,
  COMMENT_MAX_LENGTH,
  completeDraft,
  extractLink,
  holdsItsStep,
  INTAKE_LIMITS,
  OPEN_TARGET_STATUSES,
  parsePress,
  pressData,
  stepAfterLink,
  stepOfPress,
  type Draft,
  type IntakePress,
} from './intake';

const BOT = 'div_report_test_bot';
const messageOf = (update: Update): Message => {
  if (update.message === undefined) throw new Error('not a message');
  return update.message;
};
const classify = (update: Update) => classifyMessage(messageOf(update), BOT);

describe('classifyMessage', () => {
  it('takes a text its sender typed', () => {
    expect(classify(privateMessage(IDS.reporter, 'https://x.com/someone'))).toEqual({ kind: 'text', text: 'https://x.com/someone' });
    expect(classify(privateMessage(IDS.reporter, '/ not a command'))).toEqual({ kind: 'text', text: '/ not a command' });
  });

  it.each(MEDIA_KINDS)('refuses a message carrying a %s, its caption unread', (kind) => {
    expect(classify(privateMedia(IDS.reporter, kind, 'https://x.com/someone'))).toEqual({ kind: 'refused' });
  });

  it('refuses a forward, a message sent through an inline bot and a reply quoting another chat', () => {
    expect(classify(privateMessage(IDS.reporter, 'https://x.com/someone', { forwarded: true }))).toEqual({ kind: 'refused' });
    expect(classify(privateMessage(IDS.reporter, 'https://x.com/someone', { viaBot: true }))).toEqual({ kind: 'refused' });
    expect(classify(privateMessage(IDS.reporter, 'https://x.com/someone', { externalReply: true }))).toEqual({ kind: 'refused' });
    expect(classify(privateMessage(IDS.reporter, '/cancel', { forwarded: true }))).toEqual({ kind: 'refused' });
  });

  it('reads /cancel and /skip, plain, addressed to this bot or in any case', () => {
    expect(classify(privateMessage(IDS.reporter, '/cancel'))).toEqual({ kind: 'cancel' });
    expect(classify(privateMessage(IDS.reporter, '/CANCEL now'))).toEqual({ kind: 'cancel' });
    expect(classify(privateMessage(IDS.reporter, `/skip@${BOT}`))).toEqual({ kind: 'skip' });
    expect(classify(privateMessage(IDS.reporter, '/skip@DIV_REPORT_TEST_BOT'))).toEqual({ kind: 'skip' });
  });

  it('leaves every other command, and a command addressed to another bot, to the fallback', () => {
    for (const text of ['/lockdown', '/nosuchcommand', '/skip@another_bot', '/cancelled', '/start@another_bot now']) {
      expect(classify(privateMessage(IDS.reporter, text)), text).toEqual({ kind: 'command' });
    }
  });
});

describe('extractLink', () => {
  it('takes a text that is one link, read as https when it has no scheme', () => {
    expect(extractLink('  https://x.com/someone  ')).toEqual({ ok: true, candidate: 'https://x.com/someone' });
    expect(extractLink('instagram.com/someone')).toEqual({ ok: true, candidate: 'https://instagram.com/someone' });
    expect(extractLink('www.instagram.com/p/AbC123xyz/?igsh=1')).toEqual({ ok: true, candidate: 'https://www.instagram.com/p/AbC123xyz/?igsh=1' });
    expect(extractLink('http://x.com/someone')).toEqual({ ok: true, candidate: 'http://x.com/someone' });
    expect(extractLink('javascript:alert(1)')).toEqual({ ok: true, candidate: 'javascript:alert(1)' });
  });

  it('takes the one token with :// out of a sentence, and the punctuation after it off', () => {
    expect(extractLink('please see https://x.com/someone. thanks')).toEqual({ ok: true, candidate: 'https://x.com/someone' });
    expect(extractLink('«https://t.me/some_channel»')).toEqual({ ok: true, candidate: 'https://t.me/some_channel' });
    expect(extractLink('(https://example-site.org/wiki/A_(b)).')).toEqual({ ok: true, candidate: 'https://example-site.org/wiki/A_(b)' });
    expect(extractLink('see (https://x.com/someone), thanks')).toEqual({ ok: true, candidate: 'https://x.com/someone' });
    expect(extractLink('/p/AbC123xyz')).toEqual({ ok: false, refusal: 'not_a_link' });
  });

  it('refuses a text with no link, and one with two', () => {
    expect(extractLink('hello')).toEqual({ ok: false, refusal: 'not_a_link' });
    expect(extractLink('Hello.')).toEqual({ ok: false, refusal: 'not_a_link' });
    expect(extractLink('see instagram.com/someone please')).toEqual({ ok: false, refusal: 'not_a_link' });
    expect(extractLink('   ')).toEqual({ ok: false, refusal: 'not_a_link' });
    expect(extractLink('https://x.com/a and https://x.com/b')).toEqual({ ok: false, refusal: 'one_link' });
  });
});

describe('checkComment', () => {
  it(`takes up to ${COMMENT_MAX_LENGTH} characters, counted as code points, trimmed`, () => {
    expect(checkComment('  a short note  ')).toEqual({ ok: true, comment: 'a short note' });
    expect(checkComment('ب'.repeat(COMMENT_MAX_LENGTH))).toEqual({ ok: true, comment: 'ب'.repeat(COMMENT_MAX_LENGTH) });
    expect(checkComment('😀'.repeat(COMMENT_MAX_LENGTH))).toMatchObject({ ok: true });
    expect(checkComment(' \n ')).toEqual({ ok: true, comment: null });
  });

  it(`refuses ${COMMENT_MAX_LENGTH + 1} characters`, () => {
    expect(checkComment('a'.repeat(COMMENT_MAX_LENGTH + 1))).toEqual({ ok: false });
  });
});

describe('the presses', () => {
  const PRESSES: IntakePress[] = [
    { kind: 'account_unknown' },
    ...CATEGORIES.map((category) => ({ kind: 'category' as const, category })),
    { kind: 'affected', affected: true },
    { kind: 'affected', affected: false },
  ];

  it('round-trip through their callback data, each under 64 bytes', () => {
    for (const press of PRESSES) {
      const data = pressData(press);
      expect(new TextEncoder().encode(data).length, data).toBeLessThan(64);
      expect(data.startsWith('intake:')).toBe(true);
      expect(parsePress(data)).toEqual(press);
    }
  });

  it('read nothing but the exact forms', () => {
    for (const data of ['intake:', 'intake:category:', 'intake:category:spam', 'intake:affected:maybe', 'intake:account:known', 'mark:abc', 'intake:category:csam ', 'x']) {
      expect(parsePress(data), data).toBeNull();
    }
  });

  it('each answer one step', () => {
    expect(stepOfPress({ kind: 'account_unknown' })).toBe('account');
    expect(stepOfPress({ kind: 'category', category: 'other' })).toBe('category');
    expect(stepOfPress({ kind: 'affected', affected: false })).toBe('affected');
  });
});

describe('the steps', () => {
  const draft = (fields: Partial<Draft>): Draft => ({
    key: 'ab'.repeat(32),
    step: 'url',
    url: null,
    platform: null,
    accountUrl: null,
    category: null,
    affectedPerson: null,
    locale: 'en',
    createdAt: 1,
    updatedAt: 1,
    ...fields,
  });
  const link = { url: 'https://x.com/someone/status/1', platform: 'x' as const };

  it('ask for the account only when it is not derivable', () => {
    expect(stepAfterLink(null)).toBe('account');
    expect(stepAfterLink('https://x.com/someone')).toBe('category');
  });

  it('require what each step needs', () => {
    expect(holdsItsStep(draft({}))).toBe(true);
    expect(holdsItsStep(draft({ step: 'account' }))).toBe(false);
    expect(holdsItsStep(draft({ step: 'account', ...link }))).toBe(true);
    expect(holdsItsStep(draft({ step: 'account', ...link, accountUrl: 'https://x.com/someone' }))).toBe(false);
    expect(holdsItsStep(draft({ step: 'category', ...link }))).toBe(true);
    expect(holdsItsStep(draft({ step: 'affected', ...link }))).toBe(false);
    expect(holdsItsStep(draft({ step: 'affected', ...link, category: 'harassment' }))).toBe(true);
    expect(holdsItsStep(draft({ step: 'comment', ...link, category: 'harassment' }))).toBe(false);
    expect(holdsItsStep(draft({ step: 'comment', ...link, category: 'harassment', affectedPerson: false }))).toBe(true);
  });

  it('give a report only at the comment step', () => {
    const complete = draft({ step: 'comment', ...link, category: 'harassment', affectedPerson: true });
    expect(completeDraft(complete)).toEqual({ ...link, accountUrl: null, category: 'harassment', affectedPerson: true });
    expect(completeDraft(draft({ step: 'affected', ...link, category: 'harassment' }))).toBeNull();
  });
});

describe('the constants', () => {
  it('are the limits and open statuses of the review controls', () => {
    expect(INTAKE_LIMITS).toEqual({
      memberOpen: 5,
      memberPerDay: 20,
      nonMemberPerDay: 1,
      nonMemberGlobalPerDay: 20,
      throttleRejections: 3,
      throttledPerDay: 1,
    });
    expect(OPEN_TARGET_STATUSES).toEqual(['pending', 'approved', 'posting', 'posted']);
  });
});

describe('ackDeleteAt', () => {
  it('is 20 seconds after the acknowledgement, or 25 after the handler started, whichever comes first', () => {
    expect(ackDeleteAt(1_000, 1_000)).toBe(21_000);
    expect(ackDeleteAt(1_000, 4_999)).toBe(24_999);
    expect(ackDeleteAt(1_000, 5_000)).toBe(25_000);
    expect(ackDeleteAt(1_000, 12_000)).toBe(26_000);
    expect(ackDeleteAt(0, 30_000)).toBe(25_000);
  });
});

// Unit tests for the admin free-text validator (src/review/text-policy.ts;
// critical invariant 4): each refused class in English and in Persian text,
// the usual evasions, ordinary prose accepted, the fixed warning line of
// every post accepted in both locales, and the recommended comment's bound.
import { describe, expect, it } from 'vitest';
import { t } from '../i18n/index';
import {
  ADMIN_TEXT_FIELDS,
  adminTextProblems,
  checkAdminText,
  normaliseForChecks,
  RECOMMENDED_COMMENT_MAX_LENGTH,
} from './text-policy';

describe('adminTextProblems: refused', () => {
  it.each([
    ['an https URL', 'Report it at https://www.instagram.com/reported.account/ now'],
    ['an http URL', 'see http://example.org'],
    ['a tg: link with slashes', 'open tg://resolve?domain=somebot'],
    ['a tg: link without them', 'open tg:resolve?domain=somebot'],
    ['a tel: link', 'call tel:+15551234'],
    ['a mailto: link', 'write to mailto:someone'],
    ['a dotted-quad address', 'the server is 203.0.113.7 today'],
    ['a URL in Persian text', 'این حساب را در https://x.com/someone گزارش کنید'],
  ])('a URL: %s', (_label, text) => {
    expect(adminTextProblems(text)).toContain('url');
  });

  it.each([
    ['a bare domain', 'post it on example.com please'],
    ['t.me with a path', 'join t.me/somechannel for more'],
    ['t.me alone', 'search t.me'],
    ['telegram.me', 'or telegram.me/somebot'],
    ['a www host', 'go to www.facebook.com'],
    ['a subdomain', 'l.instagram.com redirects'],
    ['a country code under a second level', 'see example.co.uk'],
    ['a shortener', 'bit.ly/abc'],
    ['a capitalised domain', 'Visit Example.COM'],
    ['a domain at the start', 'example.org has it'],
    ['an email address', 'write to someone@example.org'],
    ['a Latin domain in Persian text', 'این حساب را در instagram.com گزارش کنید'],
    ['a Latin domain glued to Persian text', 'لطفاًinstagram.com را ببینید'],
    ['t.me in Persian text', 'به t.me/somechannel بپیوندید'],
    ['an internationalised domain', 'سایت.ایران را ببینید'],
  ])('a bare domain: %s', (_label, text) => {
    expect(adminTextProblems(text)).toContain('domain');
  });

  it.each([
    ['a username', 'ask @someone_admin'],
    ['a bot', 'press start on @some_bot'],
    ['a short handle', '@abc'],
    ['a mention in Persian text', 'به @someone پیام دهید'],
  ])('an @mention: %s', (_label, text) => {
    expect(adminTextProblems(text)).toContain('mention');
  });

  it.each([
    ['an international number', 'call +98 912 345 6789'],
    ['an Iranian mobile number', 'call 09123456789'],
    ['a number with dashes', 'call 0912-345-6789'],
    ['a landline with its area code', 'call (021) 1234 5678'],
    ['dots between groups', 'call 912.345.6789'],
    ['Persian digits', 'با ۰۹۱۲۳۴۵۶۷۸۹ تماس بگیرید'],
    ['Arabic-Indic digits', 'اتصل ٠٩١٢٣٤٥٦٧٨٩'],
    ['Persian digits in groups', 'شماره ۰۹۱۲ ۳۴۵ ۶۷۸۹'],
  ])('a phone number: %s', (_label, text) => {
    expect(adminTextProblems(text)).toContain('phone');
  });
});

describe('adminTextProblems: evasions', () => {
  it.each([
    ['a zero-width space inside a domain', 'example\u200B.com', 'domain'],
    ['a zero-width joiner inside a domain', 'exa\u200Dmple.com', 'domain'],
    ['a soft hyphen inside a domain', 'exam\u00ADple.com', 'domain'],
    ['an ideographic full stop', 'example\u3002com', 'domain'],
    ['a fullwidth full stop', 'example\uFF0Ecom', 'domain'],
    ['a halfwidth ideographic full stop', 'example\uFF61com', 'domain'],
    ['a one dot leader', 'example\u2024com', 'domain'],
    ['fullwidth letters', '\uFF45\uFF58\uFF41\uFF4D\uFF50\uFF4C\uFF45.com', 'domain'],
    ['a fullwidth commercial at', '\uFF20someone', 'mention'],
    ['a right-to-left override inside a domain', 'exam\u202Eple.com', 'domain'],
    ['an underscore inside a label', 'see my_site.com', 'domain'],
    ['an underscore inside a longer label', 'see foo_example.com', 'domain'],
    ['spaced dashes between the groups', 'call 0912 - 345 - 6789', 'phone'],
    ['doubled spaces between the groups', 'call 0912  345  6789', 'phone'],
    ['slashes between the groups', 'call 0912/345/6789', 'phone'],
  ])('sees through %s', (_label, text, problem) => {
    expect(adminTextProblems(text)).toContain(problem);
  });

  it('checks a normalised copy and never changes the text itself', () => {
    const text = 'exam\u200Bple\u3002com';
    expect(normaliseForChecks(text)).toBe('example.com');
    expect(text).toBe('exam\u200Bple\u3002com');
  });
});

describe('adminTextProblems: accepted', () => {
  it.each([
    ['plain prose', 'This account posts private photos of a teenager with abusive captions.'],
    ['abbreviations', 'It targets activists, e.g. students, i.e. people under 25, in the U.S.A. and elsewhere.'],
    ['short numbers', 'It has 3 posts, 1,200 followers and has been active since 1402.'],
    ['an ellipsis', 'It keeps posting... again and again.'],
    ['a lone at sign', 'Meet @ the usual place.'],
    ['a decimal', 'It grew 2.5 times in a week.'],
    ['Persian prose', 'این حساب عکس‌های خصوصی یک نوجوان را با توهین منتشر می‌کند و باید گزارش شود.'],
    ['Persian prose with a full stop', 'این حساب کاربران را آزار می‌دهد. لطفاً آن را گزارش کنید.'],
    ['Persian prose with Persian digits', 'این حساب از سال ۱۴۰۲ فعال است و ۳ پست دارد.'],
    ['an empty text', ''],
  ])('%s', (_label, text) => {
    expect(adminTextProblems(text)).toEqual([]);
  });

  it.each(['en', 'fa'] as const)('the fixed warning line of every post, in %s', (locale) => {
    const warning = t(locale, 'post.warning');
    expect(adminTextProblems(warning)).toEqual([]);
    expect(checkAdminText('recommended_comment', warning)).toEqual([]);
    expect(checkAdminText('correction_text', warning)).toEqual([]);
  });

  it('the warning line within a recommended comment, around ordinary points', () => {
    const comment = `It shares a teenager's photos. ${t('en', 'post.warning')} Report it as harassment.`;
    expect(checkAdminText('recommended_comment', comment)).toEqual([]);
  });
});

describe('adminTextProblems: strict on purpose', () => {
  it.each([
    ['a sentence glued to the next', 'It posts daily.Report it', 'domain'],
    ['a range of years with a dash', 'active 2024-2025', 'phone'],
    ['a range of years with spaced dashes', 'active 2024 - 2025', 'phone'],
    ['a date with slashes', 'It started on 1403/08/07.', 'phone'],
  ])('refuses %s, which the admin rewrites', (_label, text, problem) => {
    expect(adminTextProblems(text)).toEqual([problem]);
  });
});

describe('checkAdminText', () => {
  it('covers the recommended comment and the correction, and no custom instructions', () => {
    expect(ADMIN_TEXT_FIELDS).toEqual(['recommended_comment', 'correction_text']);
  });

  it('bounds the recommended comment to 300 characters, counted as code points', () => {
    expect(RECOMMENDED_COMMENT_MAX_LENGTH).toBe(300);
    expect(checkAdminText('recommended_comment', 'ا'.repeat(300))).toEqual([]);
    expect(checkAdminText('recommended_comment', 'ا'.repeat(301))).toEqual(['too_long']);
    expect(checkAdminText('recommended_comment', '\u{1F600}'.repeat(300))).toEqual([]);
  });

  it('does not bound the correction by that length', () => {
    expect(checkAdminText('correction_text', 'a'.repeat(301))).toEqual([]);
  });

  it('lists every problem a text has, each once', () => {
    expect(checkAdminText('recommended_comment', `https://example.com @someone 09123456789 ${'x'.repeat(300)}`)).toEqual([
      'url',
      'domain',
      'mention',
      'phone',
      'too_long',
    ]);
  });
});

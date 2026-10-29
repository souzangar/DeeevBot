// Unit tests for the post's text (src/review/render-post.ts; critical
// invariants 3 and 4): what each link mode carries, as code text; Telegram
// targets as `@username` and `post N`, never a link; a link of another site
// left out unless its host is allowed, one of the five platforms' refusing
// the post; the instruction block, the warning line and the points under
// their heading, in both locales; nothing of the reporter; suspected CSAM
// never rendered; the length Telegram counts, and the problems that keep a
// text from being sent.
import { describe, expect, it } from 'vitest';
import { DEFAULT_LINK_HOSTS } from '../config/schema';
import { telegramHtmlProblems } from '../i18n/html';
import { t, type Locale } from '../i18n/index';
import { instructionKey } from '../platforms/instructions';
import { linksIn, outgoingLinkProblems } from '../platforms/link-policy';
import { CATEGORIES } from './categories';
import {
  POST_DIVIDER,
  postProblems,
  renderBilingualPost,
  renderPost,
  sendable,
  TELEGRAM_TEXT_LIMIT,
  visibleLength,
  type PostSubject,
  type PostTerms,
} from './render-post';

const HOSTS: readonly string[] = DEFAULT_LINK_HOSTS;
const X: PostSubject = {
  platform: 'x',
  category: 'harassment',
  url: 'https://x.com/someone/status/1234567890',
  accountUrl: 'https://x.com/someone',
};
const POINTS = 'Say it mocks a private person, and that it is repeated every day.';
const terms = (linkMode: PostTerms['linkMode']): PostTerms => ({ linkMode, recommendedComment: POINTS });

const rendered = (subject: PostSubject, linkMode: PostTerms['linkMode'], locale: Locale = 'en', hosts = HOSTS): string => {
  const result = renderPost(subject, terms(linkMode), locale, hosts);
  if (!result.ok) throw new Error(`refused: ${result.refusal}`);
  return result.text;
};

/** The text of every <code> entity of `html`. */
const codeTexts = (html: string): string[] => [...html.matchAll(/<code>([^<]*)<\/code>/g)].map((match) => match[1] ?? '');

describe('renderPost', () => {
  it('carries the account link alone under account mode, as code, and never the post URL', () => {
    for (const locale of ['en', 'fa'] as const) {
      const text = rendered(X, 'account', locale);
      expect(codeTexts(text)).toEqual(['https://x.com/someone']);
      expect(text).not.toContain('status/1234567890');
    }
  });

  it('carries the account link and the post URL under post mode, as code', () => {
    expect(codeTexts(rendered(X, 'post'))).toEqual(['https://x.com/someone', 'https://x.com/someone/status/1234567890']);
  });

  it('shows the title, the instruction block, the warning line and the points under their heading, in that order', () => {
    for (const locale of ['en', 'fa'] as const) {
      const text = rendered(X, 'account', locale);
      const parts = [
        t(locale, 'post.title', { platform: t(locale, 'platform.x'), category: t(locale, 'review.category.harassment') }),
        t(locale, instructionKey('x', 'harassment')),
        t(locale, 'post.warning'),
        t(locale, 'post.points_heading'),
        POINTS,
      ];
      const at = parts.map((part) => text.indexOf(part));
      for (const position of at) expect(position).toBeGreaterThanOrEqual(0);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
    }
  });

  it('isolates each target as a left-to-right run in Persian, outside the code', () => {
    expect(rendered(X, 'account', 'fa')).toContain('⁨<code>https://x.com/someone</code>⁩');
    expect(rendered(X, 'account', 'en')).not.toContain('⁨');
  });

  it('renders a Telegram target as `@username` and `post N` code text, never as a link', () => {
    const telegram: PostSubject = { platform: 'telegram', category: 'impersonation', url: 'https://t.me/leak_channel/77', accountUrl: 'https://t.me/leak_channel' };
    for (const locale of ['en', 'fa'] as const) {
      const account = rendered(telegram, 'account', locale);
      expect(codeTexts(account)).toEqual(['@leak_channel']);
      const post = rendered(telegram, 'post', locale);
      expect(codeTexts(post)).toEqual(['@leak_channel', t(locale, 'post.telegram_post', { number: 77 })]);
      for (const text of [account, post]) {
        expect(text).not.toContain('t.me/leak_channel');
        expect(linksIn(text).filter((link) => link.text.includes('leak_channel'))).toEqual([]);
        expect(text).toContain(t(locale, 'post.channel'));
      }
    }
  });

  it("leaves another site's link out unless its host is allowed, and says so", () => {
    const other: PostSubject = { platform: 'other', category: 'other', url: 'https://leak-site.org/people/someone', accountUrl: 'https://leak-site.org/people' };
    const withheld = rendered(other, 'post');
    expect(codeTexts(withheld)).toEqual([]);
    expect(withheld).toContain(t('en', 'post.link_withheld'));
    expect(withheld).toContain(t('en', 'post.title_other', { category: t('en', 'review.category.other') }));
    expect(withheld).toContain(t('en', 'instructions.generic'));
    const allowed = rendered(other, 'post', 'en', [...HOSTS, 'leak-site.org']);
    expect(codeTexts(allowed)).toEqual(['https://leak-site.org/people', 'https://leak-site.org/people/someone']);
    expect(allowed).not.toContain(t('en', 'post.link_withheld'));
  });

  it("refuses a post when a platform's link no longer passes the link policy", () => {
    expect(renderPost(X, terms('account'), 'en', ['www.instagram.com'])).toEqual({ ok: false, refusal: 'link_refused' });
    expect(renderPost({ ...X, accountUrl: 'https://x.com/someone?s=20' }, terms('account'), 'en', HOSTS)).toEqual({ ok: false, refusal: 'link_refused' });
    expect(renderPost({ ...X, accountUrl: 'https://bit.ly/abcdef' }, terms('account'), 'en', HOSTS)).toEqual({ ok: false, refusal: 'link_refused' });
  });

  it('refuses a post URL the report does not have, and a post without an account link', () => {
    expect(renderPost({ ...X, url: X.accountUrl }, terms('post'), 'en', HOSTS)).toEqual({ ok: false, refusal: 'link_refused' });
    expect(renderPost({ ...X, url: null }, terms('post'), 'en', HOSTS)).toEqual({ ok: false, refusal: 'link_refused' });
    expect(renderPost({ ...X, accountUrl: null }, terms('account'), 'en', HOSTS)).toEqual({ ok: false, refusal: 'no_account' });
    const telegram: PostSubject = { platform: 'telegram', category: 'harassment', url: 'https://t.me/leak_channel', accountUrl: 'https://t.me/leak_channel' };
    expect(renderPost(telegram, terms('post'), 'en', HOSTS)).toEqual({ ok: false, refusal: 'link_refused' });
  });

  it('never renders suspected CSAM, whatever the mode', () => {
    for (const mode of ['account', 'post'] as const) {
      expect(renderPost({ ...X, category: 'csam' }, terms(mode), 'en', HOSTS)).toEqual({ ok: false, refusal: 'not_posted' });
    }
  });

  it('escapes the points, so they are text and never markup', () => {
    const text = renderPost(X, { linkMode: 'account', recommendedComment: '<a href="https://evil.test/">tap</a> & <b>' }, 'en', HOSTS);
    expect(text.ok && text.text).toContain('&lt;a href=&quot;https://evil.test/&quot;&gt;tap&lt;/a&gt; &amp; &lt;b&gt;');
    expect(text.ok && telegramHtmlProblems(text.text)).toEqual([]);
  });

  it('is valid Telegram HTML whose every tappable link is on the lists, for every category, platform and mode', () => {
    const subjects: PostSubject[] = [
      X,
      { platform: 'instagram', category: 'harassment', url: 'https://www.instagram.com/p/AbC123xyz', accountUrl: 'https://www.instagram.com/someone' },
      { platform: 'facebook', category: 'harassment', url: 'https://www.facebook.com/some.page/posts/123', accountUrl: 'https://www.facebook.com/some.page' },
      { platform: 'tiktok', category: 'harassment', url: 'https://www.tiktok.com/@someone/video/123', accountUrl: 'https://www.tiktok.com/@someone' },
      { platform: 'telegram', category: 'harassment', url: 'https://t.me/leak_channel/77', accountUrl: 'https://t.me/leak_channel' },
    ];
    for (const subject of subjects) {
      for (const category of CATEGORIES.filter((each) => each !== 'csam')) {
        for (const mode of ['account', 'post'] as const) {
          for (const locale of ['en', 'fa'] as const) {
            const text = rendered({ ...subject, category }, mode, locale);
            expect(telegramHtmlProblems(text), `${subject.platform} ${category} ${mode} ${locale}`).toEqual([]);
            expect(outgoingLinkProblems(text, HOSTS), `${subject.platform} ${category} ${mode} ${locale}`).toEqual([]);
          }
        }
      }
    }
  });
});

describe('renderBilingualPost', () => {
  it('is the Persian post, the divider, then the English one', () => {
    const result = renderBilingualPost(X, terms('post'), HOSTS);
    expect(result).toEqual({ ok: true, text: `${rendered(X, 'post', 'fa')}\n\n${POST_DIVIDER}\n\n${rendered(X, 'post', 'en')}` });
  });

  it('refuses what either locale refuses', () => {
    expect(renderBilingualPost({ ...X, category: 'csam' }, terms('account'), HOSTS)).toEqual({ ok: false, refusal: 'not_posted' });
  });

  it('fits Telegram with the longest blocks and 300 characters of points', () => {
    const longest: PostSubject = { platform: 'facebook', category: 'private_data', url: 'https://www.facebook.com/some.page/posts/123', accountUrl: 'https://www.facebook.com/some.page' };
    const result = renderBilingualPost(longest, { linkMode: 'post', recommendedComment: 'a'.repeat(300) }, HOSTS);
    expect(result.ok && visibleLength(result.text)).toBeLessThan(TELEGRAM_TEXT_LIMIT);
  });
});

describe('visibleLength, postProblems and sendable', () => {
  it('counts what Telegram counts: no tags, one character per entity', () => {
    expect(visibleLength('<b>a</b> &amp; <code>b</code> <a href="https://help.x.com/">c</a>')).toBe(7);
    expect(visibleLength('&lt;&gt;&quot;&#64;&#x41;')).toBe(5);
  });

  it('says how far a text is over the limit, and which links it may not carry', () => {
    const long = 'x'.repeat(TELEGRAM_TEXT_LIMIT + 3);
    expect(postProblems(long, HOSTS)).toEqual({ excess: 3, links: [] });
    expect(postProblems('x'.repeat(TELEGRAM_TEXT_LIMIT), HOSTS)).toEqual({ excess: 0, links: [] });
    expect(sendable(postProblems('x'.repeat(TELEGRAM_TEXT_LIMIT), HOSTS))).toBe(true);
    const linked = postProblems('see https://evil.test/ now', HOSTS);
    expect(linked.links.map((problem) => problem.reason)).toEqual(['not_listed']);
    expect(sendable(linked)).toBe(false);
  });
});

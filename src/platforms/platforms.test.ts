// Unit tests for the platforms' hosts and link shapes (src/platforms/platforms.ts):
// the exact aliases folded to each platform's canonical host, a platform's
// own domain refused when it is no alias, nothing matched by suffix, and the
// account and post shapes of every platform, with the account a post names
// where its URL carries the username, and the Telegram rules.
import { describe, expect, it } from 'vitest';
import { CANONICAL_HOSTS, classifyHost, classifyPath, HOST_ALIASES, isPlatform, PLATFORMS, type NamedPlatform } from './platforms';

const segmentsOf = (path: string): string[] => path.split('/').filter((segment) => segment !== '');
const classify = (platform: NamedPlatform, path: string, query = '') =>
  classifyPath(platform, segmentsOf(path), new URLSearchParams(query));

describe('the platforms', () => {
  it('are the five the bot knows and "other"', () => {
    expect(PLATFORMS).toEqual(['instagram', 'x', 'facebook', 'tiktok', 'telegram', 'other']);
    expect(isPlatform('telegram')).toBe(true);
    expect(isPlatform('youtube')).toBe(false);
    expect(isPlatform(undefined)).toBe(false);
  });

  it('each have one canonical host, which is one of their own aliases', () => {
    for (const [platform, host] of Object.entries(CANONICAL_HOSTS)) expect(HOST_ALIASES[host], host).toBe(platform);
  });
});

describe('classifyHost', () => {
  it.each([
    ['www.instagram.com', 'instagram', 'www.instagram.com'],
    ['instagram.com', 'instagram', 'www.instagram.com'],
    ['m.instagram.com', 'instagram', 'www.instagram.com'],
    ['x.com', 'x', 'x.com'],
    ['www.x.com', 'x', 'x.com'],
    ['mobile.x.com', 'x', 'x.com'],
    ['twitter.com', 'x', 'x.com'],
    ['mobile.twitter.com', 'x', 'x.com'],
    ['m.facebook.com', 'facebook', 'www.facebook.com'],
    ['facebook.com', 'facebook', 'www.facebook.com'],
    ['web.facebook.com', 'facebook', 'www.facebook.com'],
    ['mbasic.facebook.com', 'facebook', 'www.facebook.com'],
    ['tiktok.com', 'tiktok', 'www.tiktok.com'],
    ['m.tiktok.com', 'tiktok', 'www.tiktok.com'],
    ['t.me', 'telegram', 't.me'],
    ['telegram.me', 'telegram', 't.me'],
    ['telegram.dog', 'telegram', 't.me'],
  ])('folds %s to %s on %s', (host, platform, canonicalHost) => {
    expect(classifyHost(host)).toEqual({ kind: 'platform', platform, canonicalHost });
  });

  it.each([
    ['business.facebook.com', 'facebook'],
    ['developers.facebook.com', 'facebook'],
    ['help.instagram.com', 'instagram'],
    ['about.instagram.com', 'instagram'],
    ['instagr.am', 'instagram'],
    ['web.telegram.org', 'telegram'],
    ['telegram.org', 'telegram'],
    ['support.tiktok.com', 'tiktok'],
    ['help.x.com', 'x'],
    ['fb.watch', 'facebook'],
  ])('refuses %s, a domain of %s that is no alias', (host, platform) => {
    expect(classifyHost(host)).toEqual({ kind: 'platform_domain', platform });
  });

  it.each(['evilinstagram.com', 'instagram.com.evil-site.com', 'x.co', 'xx.com', 'facebook.co', 'tme.example.org', 't.me.evil-site.com', 'mytiktok.com'])(
    'takes %s as some other site: nothing is matched by suffix',
    (host) => {
      expect(classifyHost(host)).toEqual({ kind: 'other' });
    },
  );
});

describe('classifyPath on Instagram', () => {
  it('takes an account, and its posts with or without the username', () => {
    expect(classify('instagram', '/some.person_1/')).toEqual({ kind: 'account', path: 'some.person_1', accountPath: 'some.person_1' });
    expect(classify('instagram', '/p/AbC123xyz/')).toEqual({ kind: 'post', path: 'p/AbC123xyz', accountPath: null });
    expect(classify('instagram', '/reel/AbC123xyz')).toEqual({ kind: 'post', path: 'reel/AbC123xyz', accountPath: null });
    expect(classify('instagram', '/reels/AbC123xyz')).toEqual({ kind: 'post', path: 'reel/AbC123xyz', accountPath: null });
    expect(classify('instagram', '/tv/AbC123xyz')).toEqual({ kind: 'post', path: 'tv/AbC123xyz', accountPath: null });
    expect(classify('instagram', '/someone/p/AbC123xyz/')).toEqual({ kind: 'post', path: 'p/AbC123xyz', accountPath: 'someone' });
    expect(classify('instagram', '/stories/someone/3123456789/')).toEqual({
      kind: 'post',
      path: 'stories/someone/3123456789',
      accountPath: 'someone',
    });
    expect(classify('instagram', '/stories/highlights/17912345678901234/')).toEqual({
      kind: 'post',
      path: 'stories/highlights/17912345678901234',
      accountPath: null,
    });
  });

  it.each(['/', '/explore/', '/accounts/login/', '/p/', '/p/x', '/someone/extra/more', '/stories/highlights/x', '/direct/inbox', '/...', '/share/reel/AbC123xyz'])(
    'refuses %s as no account or post',
    (path) => {
      expect(classify('instagram', path)).toBe('not_a_target');
    },
  );
});

describe('classifyPath on X', () => {
  it('takes an account and a post, keeping only the post itself', () => {
    expect(classify('x', '/someone')).toEqual({ kind: 'account', path: 'someone', accountPath: 'someone' });
    expect(classify('x', '/someone/status/1234567890')).toEqual({ kind: 'post', path: 'someone/status/1234567890', accountPath: 'someone' });
    expect(classify('x', '/someone/status/1234567890/photo/1')).toEqual({
      kind: 'post',
      path: 'someone/status/1234567890',
      accountPath: 'someone',
    });
    expect(classify('x', '/someone/status/1234567890/analytics')).toMatchObject({ kind: 'post', path: 'someone/status/1234567890' });
    expect(classify('x', '/i/web/status/1234567890')).toEqual({ kind: 'post', path: 'i/web/status/1234567890', accountPath: null });
    expect(classify('x', '/i/status/1234567890')).toEqual({ kind: 'post', path: 'i/web/status/1234567890', accountPath: null });
  });

  it.each([
    '/',
    '/home',
    '/i',
    '/search',
    '/intent/tweet',
    '/someone/status/abc',
    '/someone/status/123/photo/x',
    '/someone/status/123/photo/1/extra',
    '/someone/likes',
    '/a_name_much_too_long_for_x',
  ])('refuses %s as no account or post', (path) => {
    expect(classify('x', path)).toBe('not_a_target');
  });
});

describe('classifyPath on Facebook', () => {
  it('takes a profile or Page, its posts and videos, people and pages paths, groups and share links', () => {
    expect(classify('facebook', '/some.person')).toEqual({ kind: 'account', path: 'some.person', accountPath: 'some.person' });
    expect(classify('facebook', '/some.page/posts/pfbid0abcdefghijklmnop')).toEqual({
      kind: 'post',
      path: 'some.page/posts/pfbid0abcdefghijklmnop',
      accountPath: 'some.page',
    });
    expect(classify('facebook', '/some.page/videos/1234567')).toMatchObject({ kind: 'post', accountPath: 'some.page' });
    expect(classify('facebook', '/some.page/videos/a-title/1234567')).toEqual({
      kind: 'post',
      path: 'some.page/videos/1234567',
      accountPath: 'some.page',
    });
    expect(classify('facebook', '/people/Some-Person/100012345678901/')).toEqual({
      kind: 'account',
      path: 'people/Some-Person/100012345678901',
      accountPath: 'people/Some-Person/100012345678901',
    });
    expect(classify('facebook', '/groups/somegroup')).toMatchObject({ kind: 'account', path: 'groups/somegroup' });
    expect(classify('facebook', '/groups/somegroup/posts/123456/')).toEqual({
      kind: 'post',
      path: 'groups/somegroup/posts/123456',
      accountPath: null,
    });
    expect(classify('facebook', '/share/p/AbCdEf12/')).toEqual({ kind: 'post', path: 'share/p/AbCdEf12', accountPath: null });
    expect(classify('facebook', '/share/AbCdEf12')).toEqual({ kind: 'post', path: 'share/AbCdEf12', accountPath: null });
    expect(classify('facebook', '/reel/1234567890')).toEqual({ kind: 'post', path: 'reel/1234567890', accountPath: null });
  });

  it('refuses the redirector l.php as a redirector, and a page that needs its stripped query as no target', () => {
    expect(classify('facebook', '/l.php', 'u=https%3A%2F%2Fevil-site.com')).toBe('redirector');
    for (const path of ['/profile.php', '/permalink.php', '/story.php', '/photo.php', '/watch', '/watch/', '/photo/', '/help/123', '/', '/abc']) {
      expect(classify('facebook', path), path).toBe('not_a_target');
    }
  });
});

describe('classifyPath on TikTok', () => {
  it('takes an account and its videos and photo posts', () => {
    expect(classify('tiktok', '/@someone')).toEqual({ kind: 'account', path: '@someone', accountPath: '@someone' });
    expect(classify('tiktok', '/@someone/video/7234567890123456789')).toEqual({
      kind: 'post',
      path: '@someone/video/7234567890123456789',
      accountPath: '@someone',
    });
    expect(classify('tiktok', '/@someone/photo/7234567890123456789')).toMatchObject({ kind: 'post', accountPath: '@someone' });
  });

  it('refuses its own short links as redirectors, and everything else as no target', () => {
    expect(classify('tiktok', '/t/ZTabcdef/')).toBe('redirector');
    for (const path of ['/', '/someone', '/discover/x', '/legal/report/privacy', '/@someone/live', '/@x', '/embed/v2/123']) {
      expect(classify('tiktok', path), path).toBe('not_a_target');
    }
  });
});

describe('classifyPath on Telegram', () => {
  it('takes t.me/<username> and t.me/<username>/<digits>, with the username and the post number', () => {
    expect(classify('telegram', '/some_channel')).toEqual({
      kind: 'account',
      path: 'some_channel',
      accountPath: 'some_channel',
      telegram: { username: 'some_channel', post: null },
    });
    expect(classify('telegram', '/some_channel/123')).toEqual({
      kind: 'post',
      path: 'some_channel/123',
      accountPath: 'some_channel',
      telegram: { username: 'some_channel', post: 123 },
    });
    expect(classify('telegram', '/some_channel/123', 'single')).toMatchObject({ kind: 'post', path: 'some_channel/123' });
    expect(classify('telegram', '/some_channel/123', 'comment=4')).toMatchObject({ kind: 'post' });
  });

  it.each([
    ['an invite link', '/+AbCdEfGh', ''],
    ['a joinchat link', '/joinchat/AbCdEfGh', ''],
    ['a bot start link', '/some_bot', 'start=payload'],
    ['a Mini App start link', '/some_bot', 'startapp=payload'],
    ['a group start link', '/some_bot', 'startgroup=x'],
    ['a Mini App launch', '/some_bot/myapp', ''],
    ['the web preview', '/s/some_channel', ''],
    ['a private channel link', '/c/1234567/89', ''],
    ['a sticker set', '/addstickers/someset', ''],
    ['a proxy', '/proxy', 'server=x'],
    ['a share link', '/share/url', 'url=x'],
    ['a username too short', '/abc', ''],
    ['a username ending in an underscore', '/some_', ''],
    ['a username starting with a digit', '/1channel', ''],
    ['a post number that is not one', '/some_channel/0', ''],
    ['three segments', '/some_channel/123/4', ''],
    ['the root', '/', ''],
  ])('refuses %s', (_label, path, query) => {
    expect(classify('telegram', path, query)).toBe('telegram');
  });
});

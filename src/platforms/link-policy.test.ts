// Unit tests for the link policy (src/platforms/link-policy.ts; critical
// invariant 4), one test per bypass class at intake (the scheme, userinfo,
// the port, raw IP addresses, non-public hosts, the exact host and the
// allowlist, punycode, redirectors and shorteners, the Telegram path rules,
// the query and fragment), the normalisation, platform detection and
// account derivation per platform, and the two lists every outgoing link
// is checked against: the configured target allowlist and the fixed
// TRUSTED_HELP_HOSTS.
import { describe, expect, it } from 'vitest';
import { DEFAULT_LINK_HOSTS } from '../config/schema';
import {
  analyseLink,
  checkReportedLink,
  deriveAccountUrl,
  detectPlatform,
  isSendableTargetLink,
  isTrustedHelpLink,
  linksIn,
  normaliseUrl,
  outgoingLinkProblems,
  REDIRECTOR_HOSTS,
  telegramTarget,
  TRUSTED_HELP_HOSTS,
} from './link-policy';

const HOSTS = DEFAULT_LINK_HOSTS;
const refusalOf = (raw: string, hosts: readonly string[] = HOSTS) => {
  const analysis = checkReportedLink(raw, hosts);
  return analysis.ok ? 'accepted' : analysis.refusal;
};
const urlOf = (raw: string, hosts: readonly string[] = HOSTS) => {
  const analysis = checkReportedLink(raw, hosts);
  return analysis.ok ? analysis.link.url : `refused: ${analysis.refusal}`;
};

describe('the intake policy, one bypass class at a time', () => {
  it('refuses what does not parse as a URL', () => {
    for (const raw of ['', 'not a link', 'https://', 'https://exa mple.com/x', '//instagram.com/someone']) {
      expect(refusalOf(raw), raw).toBe('not_a_link');
    }
  });

  it('refuses every scheme but https', () => {
    for (const raw of [
      'http://www.instagram.com/someone',
      'javascript:alert(1)',
      'tg://resolve?domain=some_channel',
      'data:text/html,hello',
      'ftp://www.instagram.com/someone',
      'mailto:someone@example.org',
      'intent://scan#Intent;end',
    ]) {
      expect(refusalOf(raw), raw).toBe('scheme');
    }
  });

  it('refuses userinfo, the host-confusion form included', () => {
    for (const raw of [
      'https://user:secret@www.instagram.com/someone',
      'https://user@www.instagram.com/someone',
      'https://www.instagram.com@evil-site.com/someone',
      'https://www.instagram.com:443@evil-site.com/someone',
    ]) {
      expect(refusalOf(raw), raw).toBe('userinfo');
    }
  });

  it('refuses a port, and takes the default 443 the parser drops', () => {
    expect(refusalOf('https://www.instagram.com:8443/someone')).toBe('port');
    expect(refusalOf('https://www.instagram.com:80/someone')).toBe('port');
    expect(urlOf('https://www.instagram.com:443/someone')).toBe('https://www.instagram.com/someone');
  });

  it('refuses a raw IP address in every form the parser reads', () => {
    for (const raw of ['https://127.0.0.1/x', 'https://[::1]/x', 'https://[2001:db8::1]/x', 'https://2130706433/x', 'https://0x7f.1/x', 'https://192.168.0.1/someone']) {
      expect(refusalOf(raw), raw).toBe('ip_address');
    }
  });

  it('refuses a host that is not public', () => {
    for (const raw of [
      'https://localhost/x',
      'https://intranet/x',
      'https://printer.local/x',
      'https://hidden.onion/x',
      'https://router.home.arpa/x',
      'https://db.internal/x',
      'https://instagram.com./someone',
      'https://exa--.com/x',
      'https://under_score.com/x',
      'https://site.x1/x',
    ]) {
      expect(refusalOf(raw), raw).toBe('not_public');
    }
  });

  it('matches the host exactly: a lookalike is some other site, never the platform', () => {
    for (const raw of ['https://evilinstagram.com/someone', 'https://instagram.com.evil-site.com/someone', 'https://x.com.evil-site.com/someone']) {
      const analysis = checkReportedLink(raw, HOSTS);
      expect(analysis.ok && analysis.link.platform, raw).toBe('other');
    }
  });

  it("refuses a platform's own domain that is no alias of its canonical host", () => {
    for (const raw of ['https://business.facebook.com/someone', 'https://help.instagram.com/someone', 'https://web.telegram.org/k/', 'https://instagr.am/p/AbC123xyz']) {
      expect(refusalOf(raw), raw).toBe('host');
    }
  });

  it('refuses a platform whose canonical host is not on ALLOWED_LINK_HOSTS, and still takes some other site', () => {
    const onlyInstagram = ['www.instagram.com'];
    expect(refusalOf('https://www.instagram.com/someone', onlyInstagram)).toBe('accepted');
    expect(refusalOf('https://x.com/someone', onlyInstagram)).toBe('host');
    expect(refusalOf('https://t.me/some_channel', onlyInstagram)).toBe('host');
    // The alias's own host on the list is not enough: the canonical one decides.
    expect(refusalOf('https://instagram.com/someone', ['instagram.com'])).toBe('host');
    expect(refusalOf('https://example-site.org/page', onlyInstagram)).toBe('accepted');
  });

  it('reads an internationalised host in punycode, so a homograph never passes as the platform', () => {
    const homograph = checkReportedLink('https://іnstagram.com/someone', HOSTS);
    expect(homograph.ok && homograph.link).toMatchObject({ platform: 'other', url: 'https://xn--nstagram-shh.com/someone' });
    // Fullwidth letters fold to ASCII in the parser: that is the real host.
    expect(urlOf('https://ｉｎｓｔａｇｒａｍ.com/someone')).toBe('https://www.instagram.com/someone');
  });

  it('refuses every redirector and shortener, the platforms\' own included', () => {
    for (const host of REDIRECTOR_HOSTS) expect(refusalOf(`https://${host}/abc`), host).toBe('redirector');
    expect(refusalOf('https://www.facebook.com/l.php?u=https%3A%2F%2Fevil-site.com')).toBe('redirector');
    expect(refusalOf('https://m.facebook.com/l.php?u=x')).toBe('redirector');
    expect(refusalOf('https://www.tiktok.com/t/ZTabcdef/')).toBe('redirector');
    for (const host of ['l.facebook.com', 'facebook.com/l.php', 'l.instagram.com', 't.co', 'vm.tiktok.com', 'fb.me', 'bit.ly']) {
      expect(REDIRECTOR_HOSTS.includes(host) || host === 'facebook.com/l.php', host).toBe(true);
    }
  });

  it('takes Telegram only as t.me/<username> or t.me/<username>/<digits>', () => {
    expect(urlOf('https://t.me/some_channel')).toBe('https://t.me/some_channel');
    expect(urlOf('https://telegram.me/some_channel/42?single')).toBe('https://t.me/some_channel/42');
    for (const raw of [
      'https://t.me/+AbCdEfGh',
      'https://t.me/joinchat/AbCdEfGh',
      'https://t.me/some_bot?start=payload',
      'https://t.me/some_bot?startapp=payload',
      'https://t.me/some_bot/myapp',
      'https://t.me/s/some_channel',
      'https://t.me/c/1234567/89',
    ]) {
      expect(refusalOf(raw), raw).toBe('telegram');
    }
  });

  it('strips the query, the tracking parameters with it, and the fragment', () => {
    expect(urlOf('https://www.instagram.com/someone/?igsh=abc&utm_source=x#top')).toBe('https://www.instagram.com/someone');
    expect(urlOf('https://x.com/someone/status/1234567890?s=20&t=abc')).toBe('https://x.com/someone/status/1234567890');
    expect(urlOf('https://example-site.org/a/b/?ref=x#y')).toBe('https://example-site.org/a/b');
  });

  it('refuses a platform path that is no account or post', () => {
    for (const raw of ['https://www.instagram.com/', 'https://x.com/home', 'https://www.facebook.com/profile.php?id=100012345', 'https://www.tiktok.com/discover']) {
      expect(refusalOf(raw), raw).toBe('not_a_target');
    }
  });

  it('takes any public site as "other", its path kept', () => {
    expect(checkReportedLink('https://Example-Site.org/Some/Page/', HOSTS)).toEqual({
      ok: true,
      link: { url: 'https://example-site.org/Some/Page', platform: 'other', kind: 'page', accountUrl: null, telegram: null },
    });
    expect(urlOf('https://example-site.org')).toBe('https://example-site.org');
  });
});

describe('normaliseUrl', () => {
  it.each([
    ['https://INSTAGRAM.com/someone/', 'https://www.instagram.com/someone'],
    ['HTTPS://www.instagram.com/someone?igsh=1', 'https://www.instagram.com/someone'],
    ['https://m.instagram.com/p/AbC123xyz/', 'https://www.instagram.com/p/AbC123xyz'],
    ['https://twitter.com/someone/status/123?s=20', 'https://x.com/someone/status/123'],
    ['https://mobile.twitter.com/someone', 'https://x.com/someone'],
    ['https://www.x.com/someone/status/123/photo/2', 'https://x.com/someone/status/123'],
    ['https://m.facebook.com/some.person/?ref=bookmarks', 'https://www.facebook.com/some.person'],
    ['https://facebook.com/some.page/posts/pfbid0abcdefghijklmnop/', 'https://www.facebook.com/some.page/posts/pfbid0abcdefghijklmnop'],
    ['https://tiktok.com/@someone/video/7234567890123456789?is_from_webapp=1', 'https://www.tiktok.com/@someone/video/7234567890123456789'],
    ['https://telegram.dog/some_channel/7', 'https://t.me/some_channel/7'],
  ])('%s is %s', (raw, normalised) => {
    expect(normaliseUrl(raw)).toBe(normalised);
  });

  it('is null for a link the policy refuses', () => {
    expect(normaliseUrl('http://www.instagram.com/someone')).toBeNull();
    expect(normaliseUrl('https://bit.ly/abc')).toBeNull();
  });
});

describe('detectPlatform', () => {
  it.each([
    ['https://www.instagram.com/someone', 'instagram'],
    ['https://twitter.com/someone', 'x'],
    ['https://m.facebook.com/someone', 'facebook'],
    ['https://www.tiktok.com/@someone', 'tiktok'],
    ['https://telegram.me/some_channel', 'telegram'],
    ['https://business.facebook.com/x', 'facebook'],
    ['https://example-site.org/x', 'other'],
    ['https://evilinstagram.com/someone', 'other'],
    ['not a link', 'other'],
  ])('%s is %s', (raw, platform) => {
    expect(detectPlatform(raw)).toBe(platform);
  });
});

describe('deriveAccountUrl', () => {
  it.each([
    ['https://x.com/someone/status/123', 'https://x.com/someone'],
    ['https://www.tiktok.com/@someone/video/7234567890123456789', 'https://www.tiktok.com/@someone'],
    ['https://t.me/some_channel/42', 'https://t.me/some_channel'],
    ['https://www.instagram.com/someone/p/AbC123xyz', 'https://www.instagram.com/someone'],
    ['https://www.instagram.com/stories/someone/3123456789', 'https://www.instagram.com/someone'],
    ['https://www.facebook.com/some.page/posts/123456', 'https://www.facebook.com/some.page'],
    ['https://www.instagram.com/someone/', 'https://www.instagram.com/someone'],
  ])('derives the account of %s: %s', (raw, account) => {
    expect(deriveAccountUrl(raw)).toBe(account);
  });

  it.each([
    'https://www.instagram.com/p/AbC123xyz/',
    'https://www.instagram.com/reel/AbC123xyz/',
    'https://www.facebook.com/share/p/AbCdEf12/',
    'https://www.facebook.com/groups/somegroup/permalink/123456/',
    'https://www.facebook.com/reel/1234567890',
    'https://x.com/i/web/status/123',
    'https://example-site.org/someone',
    'https://bit.ly/abc',
  ])('is null for %s, which carries no username', (raw) => {
    expect(deriveAccountUrl(raw)).toBeNull();
  });
});

describe('telegramTarget', () => {
  it('reads the username and the post number, for Telegram links only', () => {
    expect(telegramTarget('https://t.me/some_channel/42')).toEqual({ username: 'some_channel', post: 42 });
    expect(telegramTarget('https://t.me/some_channel')).toEqual({ username: 'some_channel', post: null });
    expect(telegramTarget('https://t.me/+AbCdEfGh')).toBeNull();
    expect(telegramTarget('https://x.com/someone')).toBeNull();
  });
});

describe('TRUSTED_HELP_HOSTS', () => {
  it('is the fixed list of the plan, frozen, entries included', () => {
    expect(TRUSTED_HELP_HOSTS.map(({ host, pathPrefix }) => (pathPrefix === undefined ? host : `${host}${pathPrefix}`))).toEqual([
      'help.instagram.com',
      'help.x.com',
      'www.facebook.com/help',
      'support.tiktok.com',
      'www.tiktok.com/legal',
      'telegram.org',
      'report.cybertip.org',
      'report.iwf.org.uk',
      'www.iwf.org.uk',
      'report.icmec.org',
      'www.icmec.org',
      'www.inhope.org',
      't.me/stopCA',
    ]);
    expect(Object.isFrozen(TRUSTED_HELP_HOSTS)).toBe(true);
    for (const entry of TRUSTED_HELP_HOSTS) expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (TRUSTED_HELP_HOSTS as TrustedMutable).push({ host: 'evil-site.com' });
    }).toThrow(TypeError);
  });

  it('is taken by isTrustedHelpLink with no list of its own: no configuration reaches it', () => {
    expect(isTrustedHelpLink.length).toBe(1);
  });
});
type TrustedMutable = { host: string; pathPrefix?: string }[];

describe('isTrustedHelpLink', () => {
  it.each([
    'https://help.instagram.com/contact/512241091300432',
    'https://help.x.com/forms/authenticity',
    'https://www.facebook.com/help/1561472897490627',
    'https://www.facebook.com/help',
    'https://support.tiktok.com/en/safety-hc/report-a-problem',
    'https://www.tiktok.com/legal/report/privacy',
    'https://telegram.org/safety',
    'https://report.cybertip.org/',
    'https://report.iwf.org.uk/en',
    'https://report.icmec.org/',
    'https://www.inhope.org/what-we-do/how-to-report',
    'https://t.me/stopCA',
  ])('takes %s', (raw) => {
    expect(isTrustedHelpLink(raw)).toBe(true);
  });

  it.each([
    ['http', 'http://help.x.com/forms/authenticity'],
    ['a query', 'https://help.x.com/forms?x=1'],
    ['an empty query', 'https://help.x.com/forms?'],
    ['a fragment', 'https://help.x.com/forms#top'],
    ['userinfo', 'https://someone@help.x.com/forms'],
    ['a port', 'https://help.x.com:8443/forms'],
    ['a Facebook path outside /help', 'https://www.facebook.com/l.php'],
    ['a path that only starts like /help', 'https://www.facebook.com/helpful.page'],
    ['a TikTok path outside /legal', 'https://www.tiktok.com/@someone'],
    ['another t.me path', 'https://t.me/some_channel'],
    ['a t.me path that only starts like /stopCA', 'https://t.me/stopCAx'],
    ['the case of a path', 'https://www.facebook.com/HELP/123'],
    ['a subdomain of a trusted host', 'https://evil.help.x.com/forms'],
    ['a lookalike', 'https://help.x.com.evil-site.com/forms'],
    ['a host that is the platform itself', 'https://www.instagram.com/someone'],
  ])('refuses %s', (_label, raw) => {
    expect(isTrustedHelpLink(raw)).toBe(false);
  });
});

describe('isSendableTargetLink', () => {
  it('takes a normalised target link whose host is allowed', () => {
    expect(isSendableTargetLink('https://www.instagram.com/someone', HOSTS)).toBe(true);
    expect(isSendableTargetLink('https://x.com/someone/status/123', HOSTS)).toBe(true);
    expect(isSendableTargetLink('https://www.youtube.com/watch', ['www.youtube.com'])).toBe(true);
  });

  it('refuses a Telegram target, a link not in its normalised form, an "other" host not listed, and anything the policy refuses', () => {
    expect(isSendableTargetLink('https://t.me/some_channel', HOSTS)).toBe(false);
    expect(isSendableTargetLink('https://instagram.com/someone', HOSTS)).toBe(false);
    expect(isSendableTargetLink('https://www.instagram.com/someone/', HOSTS)).toBe(false);
    expect(isSendableTargetLink('https://www.instagram.com/someone?igsh=1', HOSTS)).toBe(false);
    expect(isSendableTargetLink('https://example-site.org/page', HOSTS)).toBe(false);
    expect(isSendableTargetLink('https://bit.ly/abc', HOSTS)).toBe(false);
    expect(isSendableTargetLink('https://www.instagram.com/someone', [])).toBe(false);
  });
});

describe('linksIn', () => {
  it('finds hrefs, URLs, bare domains, email addresses and mentions, outside code and link text', () => {
    const html =
      'See <a href="https://help.x.com/forms/authenticity">help.x.com</a>, help.instagram.com/contact and https://evil-site.com/x. ' +
      'Write to someone@example.org or @somebody. <code>t.me/name</code> <code>https://evil-site.com/in-code</code>';
    expect(linksIn(html)).toEqual([
      { kind: 'href', text: 'https://help.x.com/forms/authenticity' },
      { kind: 'email', text: 'someone@example.org' },
      { kind: 'url', text: 'https://evil-site.com/x' },
      { kind: 'domain', text: 'help.instagram.com/contact' },
      { kind: 'mention', text: '@somebody' },
    ]);
  });

  it('finds them through entities, zero-width characters, fullwidth dots and schemes without slashes', () => {
    const found = linksIn('evil&#46;site.com x​.com evil．site tg:resolve mailto:a&#64;b.org &lt;b&gt;').map((link) => link.text);
    expect(found).toContain('evil.site.com');
    expect(found).toContain('x.com');
    expect(found).toContain('evil.site');
    expect(found).toContain('tg:resolve');
    expect(found.some((text) => text.includes('a@b.org'))).toBe(true);
  });

  it('finds nothing in prose, and nothing in a date, a time or a number', () => {
    expect(linksIn('Thank you. Your report (Instagram, 2027-01-15) has been received at 12.30; see /skip.')).toEqual([]);
  });
});

describe('outgoingLinkProblems', () => {
  it('passes the trusted links and the allowed target links, and nothing else', () => {
    const allowed = '<a href="https://report.cybertip.org/">NCMEC</a> <a href="https://www.instagram.com/someone">x</a>';
    expect(outgoingLinkProblems(allowed, HOSTS)).toEqual([]);
    expect(outgoingLinkProblems(allowed, [])).toEqual([
      { link: { kind: 'href', text: 'https://www.instagram.com/someone' }, reason: 'not_listed' },
    ]);
  });

  it('refuses a link off both lists, a bare domain off them, an email address and a mention', () => {
    const reasons = outgoingLinkProblems(
      '<a href="https://evil-site.com/">x</a> evil-site.com/p someone@example.org @somebody <a href="https://t.me/some_channel">c</a>',
      HOSTS,
    ).map(({ link, reason }) => `${link.kind}:${reason}`);
    expect(reasons).toEqual(['href:not_listed', 'href:not_listed', 'email:email', 'domain:not_listed', 'mention:mention']);
  });

  it('leaves code text alone: it is not tappable', () => {
    expect(outgoingLinkProblems('<code>https://evil-site.com/x</code> <code>@somebody</code>', [])).toEqual([]);
  });
});

describe('analyseLink', () => {
  it('is checkReportedLink without the allowlist', () => {
    expect(analyseLink('https://x.com/someone')).toEqual(checkReportedLink('https://x.com/someone', HOSTS));
    expect(analyseLink('https://x.com/someone').ok).toBe(true);
    expect(checkReportedLink('https://x.com/someone', []).ok).toBe(false);
  });
});

describe('the outgoing scan fails closed (the domain audit of U3)', () => {
  // Each form renders as a tappable link to evil-site.com: tdlib reads
  // single-quoted and bare attribute values in any order, and a formatting
  // entity inserts no character, so the text Telegram auto-links is joined.
  it.each([
    ['a single-quoted href', "<a href='https://evil-site.com/x'>x</a>"],
    ['a bare href', '<a href=https://evil-site.com/x>x</a>'],
    ['an href after another attribute', '<a title="t" href="https://evil-site.com/x">x</a>'],
    ['a bare domain an empty tag splits', 'evil-site<b></b>.com'],
    ['a label a tag splits', 'evil<b></b>-site.com'],
    ['a top-level label inside a formatting tag', 'evil-site.<b>com</b>'],
  ])('sees and refuses %s', (_label, html) => {
    expect(linksIn(html).map((link) => link.text).some((text) => text.includes('evil-site.com'))).toBe(true);
    expect(outgoingLinkProblems(html, []).map((problem) => problem.reason)).toEqual(['not_listed']);
    expect(outgoingLinkProblems(html, HOSTS).map((problem) => problem.reason)).toEqual(['not_listed']);
  });

  it('reads the href however it is written, and each href of the tag', () => {
    const hrefs = (html: string) => linksIn(html).filter((link) => link.kind === 'href').map((link) => link.text);
    expect(hrefs("<a href='https://evil-site.com/x'>x</a>")).toEqual(['https://evil-site.com/x']);
    expect(hrefs('<a href=https://evil-site.com/x>x</a>')).toEqual(['https://evil-site.com/x']);
    expect(hrefs('<A TITLE="t" HREF="https://evil-site.com/x">x</A>')).toEqual(['https://evil-site.com/x']);
    expect(hrefs('<a href = "https://help.x.com/a>b">x</a>')).toEqual(['https://help.x.com/a>b']);
    expect(hrefs('<a href="https://help.x.com/forms" href="https://evil-site.com/x">x</a>')).toEqual([
      'https://help.x.com/forms',
      'https://evil-site.com/x',
    ]);
    // A value that looks like an attribute is never read as one.
    expect(hrefs('<a title="href=https://help.x.com/forms" href="https://evil-site.com/x">x</a>')).toEqual(['https://evil-site.com/x']);
  });

  it('refuses an <a> without an href, or one it cannot read, with no host to excuse it', () => {
    for (const html of ['<a>evil.com</a>', '<a title="x">help.x.com</a>', '<a/href="https://help.x.com/forms">x</a>', '<a href="https://help.x.com/forms"/>x</a>']) {
      expect(outgoingLinkProblems(html, HOSTS).map((problem) => problem.reason), html).toContain('unreadable_anchor');
    }
    expect(outgoingLinkProblems('<a>evil.com</a>', HOSTS)).toEqual([{ link: { kind: 'anchor', text: '<a>' }, reason: 'unreadable_anchor' }]);
    expect(outgoingLinkProblems('<a href>x</a>', HOSTS)).toEqual([{ link: { kind: 'href', text: '' }, reason: 'not_listed' }]);
  });

  it('still passes an allowed link written with another attribute', () => {
    expect(outgoingLinkProblems('<a href="https://help.instagram.com/x" class="c">the help centre</a>', [])).toEqual([]);
    expect(outgoingLinkProblems("<a class='c' href='https://help.instagram.com/x'>the help centre</a>", [])).toEqual([]);
  });

  it('finds no mention after a letter, a tag between them or not', () => {
    expect(linksIn('foo<b></b>@bar')).toEqual([]);
    expect(linksIn('foo@bar')).toEqual([]);
    expect(outgoingLinkProblems('foo<b></b>@bar', [])).toEqual([]);
  });

  it('keeps code, pre and link text a boundary: no link is joined across them', () => {
    expect(linksIn('evil-site<code>x</code>.com')).toEqual([]);
    expect(linksIn('evil-site<pre>x</pre>.com')).toEqual([]);
  });
});

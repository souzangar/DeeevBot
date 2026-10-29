// @critical-path
// The link policy (critical invariant 4; doc/product/report-categories-and-routing.md,
// "The link policy"; doc/product/threat-model-seizure.md, control 3): the
// links the bot takes in at intake, and the links it may ever send to the
// channel, to a reporter or to a keyholder.
//
// At intake, analyseLink() and checkReportedLink() screen a reported link
// in this order, each a refusal class with its own test:
// - it parses with `new URL` (the WHATWG parser lower-cases the scheme and
//   the host, folds fullwidth letters, writes an internationalised host in
//   punycode and every IPv4 form as a dotted quad), else 'not_a_link';
// - https only ('scheme'); no userinfo ('userinfo'); no port, the parser
//   having dropped the default 443 ('port');
// - no raw IP address ('ip_address'), and a public hostname: two labels or
//   more, each a well-formed DNS label, a top-level label of letters (or
//   punycode) and none of the special-use names (localhost, .local, .onion
//   ...), else 'not_public';
// - no redirector or shortener host, the platforms' own included
//   (l.facebook.com, t.co, vm.tiktok.com, fb.me, bit.ly ...): 'redirector';
// - on a platform's own domain, an exact host of that platform's alias
//   table, folded to its canonical host ('host' otherwise), and a path of
//   one of its account or post shapes ('not_a_target'; a platform's own
//   redirect paths, facebook.com/l.php and tiktok.com/t/..., are
//   'redirector'; Telegram outside t.me/<username>[/<digits>] is
//   'telegram'), src/platforms/platforms.ts;
// - the query and the fragment are stripped, which also drops every
//   tracking parameter, and so is a trailing slash;
// - checkReportedLink() then requires a platform's canonical host to be on
//   ALLOWED_LINK_HOSTS, matched exactly ('host'); a link to any other
//   public site ("other") passes at intake, and is posted without a link
//   unless its host is on that list.
// The review card is the one place a URL of any host is shown, as code
// text, because the admins must see it.
//
// What the bot sends: every link in an outgoing message, tappable (an
// <a href>, or a URL, a bare domain, an email address or an @mention that
// Telegram would turn into one) is checked by outgoingLinkProblems()
// against two lists, and nothing else may pass. The scan fails closed: an
// <a> tag is read as tdlib reads it (an href double-quoted, single-quoted
// or bare, in any position), and one whose href cannot be read, or that
// has none (tdlib links such an <a> to its own text), is a problem
// whatever the lists say:
// - the configured target allowlist (isSendableTargetLink(): a link that
//   passes the intake policy above, already in its normalised form, on a
//   host of ALLOWED_LINK_HOSTS, and never a Telegram target, which is only
//   ever shown as code text);
// - TRUSTED_HELP_HOSTS, the fixed in-code list of the platforms' help
//   centres and the hotline portals the catalog links to (isTrustedHelpLink():
//   https, no userinfo, port, query or fragment, the exact host and, for
//   the three entries scoped to one, a path under its prefix). No
//   configuration and no admin text can extend it: it is a frozen constant
//   that nothing takes as a parameter.
// An email address or an @mention outside code text is never allowed.
// Text inside <code> is not tappable and is not scanned: the post's
// targets are code text, put there only from stored, policy-checked URLs.
import { normaliseForChecks } from '../review/text-policy';
import {
  CANONICAL_HOSTS,
  classifyHost,
  classifyPath,
  type Platform,
} from './platforms';

/** One entry of TRUSTED_HELP_HOSTS: an exact host, and the path a link must sit under, if scoped. */
export interface TrustedHelpHost {
  readonly host: string;
  /** A link's path must equal this or start with it and "/"; absent, any path. */
  readonly pathPrefix?: string;
}

const trusted = (host: string, pathPrefix?: string): TrustedHelpHost =>
  Object.freeze(pathPrefix === undefined ? { host } : { host, pathPrefix });

/**
 * The platforms' help centres and the hotline portals (the MVP plan,
 * section 4; doc/reference/csam-hotlines.md): the only hosts the catalog's
 * own links may point to.
 */
export const TRUSTED_HELP_HOSTS: readonly TrustedHelpHost[] = Object.freeze([
  trusted('help.instagram.com'),
  trusted('help.x.com'),
  trusted('www.facebook.com', '/help'),
  trusted('support.tiktok.com'),
  trusted('www.tiktok.com', '/legal'),
  trusted('telegram.org'),
  trusted('report.cybertip.org'),
  trusted('report.iwf.org.uk'),
  trusted('www.iwf.org.uk'),
  trusted('report.icmec.org'),
  trusted('www.icmec.org'),
  trusted('www.inhope.org'),
  trusted('t.me', '/stopCA'),
]);

/** Redirectors and shorteners, the platforms' own among them: never a target, never sent. */
export const REDIRECTOR_HOSTS: readonly string[] = Object.freeze([
  'l.facebook.com',
  'lm.facebook.com',
  'l.instagram.com',
  't.co',
  'vm.tiktok.com',
  'vt.tiktok.com',
  'fb.me',
  'fb.watch',
  'bit.ly',
  'tinyurl.com',
  'goo.gl',
  'ow.ly',
  'is.gd',
  'buff.ly',
  'cutt.ly',
  'rb.gy',
  'shorturl.at',
  't.ly',
  'tiny.cc',
  'rebrand.ly',
  'lnkd.in',
  'v.gd',
  's.id',
]);
const REDIRECTORS = new Set(REDIRECTOR_HOSTS);

/** Why a reported link is refused (see the header). */
export type LinkRefusal =
  | 'not_a_link'
  | 'scheme'
  | 'userinfo'
  | 'port'
  | 'ip_address'
  | 'not_public'
  | 'redirector'
  | 'host'
  | 'telegram'
  | 'not_a_target';

/** A Telegram target, which the bot only ever shows as code text: `@username`, `post 123`. */
export interface TelegramTarget {
  readonly username: string;
  readonly post: number | null;
}

/** A reported link that passed the policy. */
export interface ReportedLink {
  /** The normalised URL: https, the canonical host, the canonical path, no query, fragment or trailing slash. */
  readonly url: string;
  readonly platform: Platform;
  /** An account or a post on a named platform; a page of some other site. */
  readonly kind: 'account' | 'post' | 'page';
  /** The account's normalised URL, when the link names it (an account's is its own); else null. */
  readonly accountUrl: string | null;
  /** For a Telegram link, its username and post number; else null. */
  readonly telegram: TelegramTarget | null;
}

export type LinkAnalysis =
  | { readonly ok: true; readonly link: ReportedLink }
  | { readonly ok: false; readonly refusal: LinkRefusal };

const refused = (refusal: LinkRefusal): LinkAnalysis => ({ ok: false, refusal });

/** A DNS label: 1 to 63 letters, digits and hyphens, no hyphen at either end. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** A top-level label: letters only, or an internationalised one in punycode. */
const TOP_LABEL = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
/** Special-use and private top-level names: never a public site. */
const SPECIAL_USE = new Set([
  'localhost', 'local', 'localdomain', 'internal', 'intranet', 'lan', 'home', 'corp', 'private', 'test',
  'example', 'invalid', 'onion', 'arpa', 'alt',
]);
const DOTTED_QUAD = /^[0-9]+(?:\.[0-9]+){3}$/;

/** Whether the parsed host is an IP literal: the parser writes every IPv4 form as a dotted quad. */
const isIpLiteral = (host: string): boolean => host.startsWith('[') || DOTTED_QUAD.test(host);

/** Whether the parsed host is a public hostname (see the header). */
const isPublicHostname = (host: string): boolean => {
  if (host.length > 253) return false;
  const labels = host.split('.');
  const top = labels[labels.length - 1] ?? '';
  return labels.length >= 2 && labels.every((label) => LABEL.test(label)) && TOP_LABEL.test(top) && !SPECIAL_USE.has(top);
};

const parsed = (raw: string): URL | null => {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
};

/** The policy of the header, the allowlist aside: what `raw` is, or why it is refused. */
export function analyseLink(raw: string): LinkAnalysis {
  const url = parsed(raw);
  if (url === null) return refused('not_a_link');
  if (url.protocol !== 'https:') return refused('scheme');
  if (url.username !== '' || url.password !== '') return refused('userinfo');
  if (url.port !== '') return refused('port');
  const host = url.hostname;
  if (isIpLiteral(host)) return refused('ip_address');
  if (!isPublicHostname(host)) return refused('not_public');
  if (REDIRECTORS.has(host)) return refused('redirector');
  const hostClass = classifyHost(host);
  if (hostClass.kind === 'platform_domain') return refused('host');
  if (hostClass.kind === 'other') {
    const path = url.pathname.replace(/\/+$/, '');
    return {
      ok: true,
      link: { url: `https://${host}${path}`, platform: 'other', kind: 'page', accountUrl: null, telegram: null },
    };
  }
  const segments = url.pathname.split('/').filter((segment) => segment !== '');
  const target = classifyPath(hostClass.platform, segments, url.searchParams);
  if (typeof target === 'string') return refused(target);
  const base = `https://${hostClass.canonicalHost}/`;
  return {
    ok: true,
    link: {
      url: `${base}${target.path}`,
      platform: hostClass.platform,
      kind: target.kind,
      accountUrl: target.accountPath === null ? null : `${base}${target.accountPath}`,
      telegram: target.telegram ?? null,
    },
  };
}

/**
 * The intake policy: analyseLink(), and a named platform's canonical host on
 * `allowedHosts` (ALLOWED_LINK_HOSTS), matched exactly.
 */
export function checkReportedLink(raw: string, allowedHosts: readonly string[]): LinkAnalysis {
  const analysis = analyseLink(raw);
  if (!analysis.ok || analysis.link.platform === 'other') return analysis;
  return allowedHosts.includes(CANONICAL_HOSTS[analysis.link.platform]) ? analysis : refused('host');
}

/**
 * `raw` normalised: the scheme and the host lower-cased, a platform's www,
 * mobile and older hosts folded to its canonical one, the query (and every
 * tracking parameter with it) and the fragment stripped, the trailing
 * slash removed, a platform's path reduced to the segments that identify
 * its target. Null when the link does not pass analyseLink().
 */
export const normaliseUrl = (raw: string): string | null => {
  const analysis = analyseLink(raw);
  return analysis.ok ? analysis.link.url : null;
};

/** The platform `raw`'s host belongs to (its folded host or a domain it owns), else 'other'. */
export function detectPlatform(raw: string): Platform {
  const url = parsed(raw);
  if (url === null) return 'other';
  const hostClass = classifyHost(url.hostname);
  return hostClass.kind === 'other' ? 'other' : hostClass.platform;
}

/**
 * The normalised URL of the account `raw` names: its own for an account; a
 * post's account where its URL carries the username (X, TikTok, Telegram,
 * Instagram's /<user>/p/... and stories); null otherwise (Instagram's
 * /p/..., Facebook's share links, reels and group posts, any other site),
 * and null for a link the policy refuses.
 */
export const deriveAccountUrl = (raw: string): string | null => {
  const analysis = analyseLink(raw);
  return analysis.ok ? analysis.link.accountUrl : null;
};

/** The username and post number of a Telegram link that passes the policy, else null. */
export const telegramTarget = (raw: string): TelegramTarget | null => {
  const analysis = analyseLink(raw);
  return analysis.ok ? analysis.link.telegram : null;
};

/** Whether `raw` is a link to one of TRUSTED_HELP_HOSTS (see the header). */
export function isTrustedHelpLink(raw: string): boolean {
  const url = parsed(raw);
  if (url === null || url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') {
    return false;
  }
  // An empty query or fragment ("?" or "#" alone) is refused too.
  if (url.href.includes('?') || url.href.includes('#')) return false;
  return TRUSTED_HELP_HOSTS.some(
    ({ host, pathPrefix }) =>
      url.hostname === host &&
      (pathPrefix === undefined || url.pathname === pathPrefix || url.pathname.startsWith(`${pathPrefix}/`)),
  );
}

/**
 * Whether `raw` may be sent as a link to a target: it passes the intake
 * policy, is already in its normalised form, its host is on `allowedHosts`
 * and it is no Telegram target.
 */
export function isSendableTargetLink(raw: string, allowedHosts: readonly string[]): boolean {
  const analysis = checkReportedLink(raw, allowedHosts);
  if (!analysis.ok) return false;
  const { link } = analysis;
  if (link.platform === 'telegram' || link.url !== raw) return false;
  return link.platform !== 'other' || allowedHosts.includes(new URL(link.url).hostname);
}

/**
 * A link an outgoing message carries: what kind, and its text as written;
 * an 'anchor' is an <a> tag whose href could not be read, its source the
 * text.
 */
export interface FoundLink {
  readonly kind: 'href' | 'anchor' | 'url' | 'domain' | 'email' | 'mention';
  readonly text: string;
}

const ENTITIES: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"' };
const ENTITY = /&(lt|gt|amp|quot|#[0-9]{1,7}|#x[0-9A-Fa-f]{1,6});/g;

/** Telegram HTML's entities decoded. */
const decodeEntities = (text: string): string =>
  text.replace(ENTITY, (whole, name: string) => {
    if (name.startsWith('#x')) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith('#')) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return ENTITIES[name] ?? whole;
  });

/** An opening <a> tag, its quoted values read whole: a quoted value may hold a '>'. */
const ANCHOR = /<a\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
/** One attribute of a tag: a name and maybe a value, double-quoted, single-quoted or bare. */
const ATTRIBUTE = /\s*([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>=`]+)))?\s*/y;
// code, pre and a are tdlib's continuous entities, and Telegram drops an
// auto-detected link that intersects one, so each such block becomes a
// space: a real boundary. Every other tag (b, i, u, s, tg-spoiler,
// blockquote) can be split, and Telegram still auto-links text across it,
// so it is removed with no width at all.
const NOT_SCANNED = /<(code|pre|a)\b(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/\1\s*>/gi;
const TAG = /<(?:[^>"']|"[^"]*"|'[^']*')*>/g;
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
const SCHEME_URL = /\p{L}[\p{L}\p{N}+.-]*:\/\/[^\s<>"]+/gu;
const BARE_SCHEME = /(?<![\p{L}\p{N}])(?:tg|tel|sms|mailto|callto|intent):[^\s<>"]*/giu;
const DOMAIN =
  /(?<![\p{L}\p{N}_@.-])(?:[\p{L}\p{N}_](?:[\p{L}\p{N}_-]{0,61}[\p{L}\p{N}_])?\.)+\p{L}{2,}(?![\p{L}\p{N}_-])(?:\/[^\s<>"]*)?/gu;
const MENTION = /(?<![\p{L}\p{N}_])@[\p{L}\p{N}_]+/gu;
/** Trailing punctuation Telegram leaves out of a link. */
const TRAILING = /[.,;:!?)\]'"]+$/u;

/**
 * The href values of an <a> tag's attribute text (what follows `<a`), each
 * attribute read in turn, so a value is never searched for another; null
 * when the text does not read as attributes.
 */
const hrefsOf = (attributes: string): string[] | null => {
  const pattern = new RegExp(ATTRIBUTE.source, 'y');
  const hrefs: string[] = [];
  while (pattern.lastIndex < attributes.length) {
    const start = pattern.lastIndex;
    const match = pattern.exec(attributes);
    if (match === null || pattern.lastIndex === start) return null;
    if ((match[1] ?? '').toLowerCase() === 'href') hrefs.push(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return hrefs;
};

/** Collects the matches of `pattern` in `text` as `kind`, and returns `text` with them blanked. */
const take = (text: string, pattern: RegExp, kind: FoundLink['kind'], found: FoundLink[]): string =>
  text.replace(pattern, (match) => {
    found.push({ kind, text: match.replace(TRAILING, '') });
    return ' ';
  });

/**
 * The tappable links of the Telegram-HTML `html`: every href of every <a>
 * tag (an 'anchor' for a tag whose href could not be read, or that has
 * none), and outside code, pre and link text, with every other tag
 * removed, every URL, bare domain, email address and @mention Telegram
 * would make one of, found on the text as the admin free-text validator
 * normalises it (src/review/text-policy.ts).
 */
export function linksIn(html: string): FoundLink[] {
  const found: FoundLink[] = [];
  for (const match of html.matchAll(ANCHOR)) {
    const hrefs = hrefsOf(match[1] ?? '');
    if (hrefs === null || hrefs.length === 0) {
      found.push({ kind: 'anchor', text: match[0] });
      continue;
    }
    for (const href of hrefs) found.push({ kind: 'href', text: decodeEntities(href) });
  }
  let text = normaliseForChecks(decodeEntities(html.replace(NOT_SCANNED, ' ').replace(TAG, '')));
  text = take(text, EMAIL, 'email', found);
  text = take(text, SCHEME_URL, 'url', found);
  text = take(text, BARE_SCHEME, 'url', found);
  text = take(text, DOMAIN, 'domain', found);
  take(text, MENTION, 'mention', found);
  return found;
}

/** Why a link of an outgoing message may not be sent. */
export interface OutgoingLinkProblem {
  readonly link: FoundLink;
  readonly reason: 'not_listed' | 'unreadable_anchor' | 'email' | 'mention';
}

/**
 * Every link of `html` that may not be sent (see the header): on neither
 * TRUSTED_HELP_HOSTS nor, as a normalised target link, on
 * `allowedTargetHosts`; an <a> tag whose href could not be read, whatever
 * the lists; or an email address or an @mention. Empty: every link may go.
 * A message to a reporter passes no target host at all.
 */
export function outgoingLinkProblems(html: string, allowedTargetHosts: readonly string[]): OutgoingLinkProblem[] {
  const problems: OutgoingLinkProblem[] = [];
  for (const link of linksIn(html)) {
    if (link.kind === 'anchor') {
      problems.push({ link, reason: 'unreadable_anchor' });
      continue;
    }
    if (link.kind === 'email' || link.kind === 'mention') {
      problems.push({ link, reason: link.kind });
      continue;
    }
    const candidate = link.kind === 'domain' ? `https://${link.text}` : link.text;
    if (!isTrustedHelpLink(candidate) && !isSendableTargetLink(candidate, allowedTargetHosts)) {
      problems.push({ link, reason: 'not_listed' });
    }
  }
  return problems;
}

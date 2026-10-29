// @critical-path
// The platforms a reported link can belong to, and the shapes of their
// links (critical invariant 4; doc/product/report-categories-and-routing.md,
// "The link policy"; the MVP plan, section 4, "Intake"). The link policy
// (src/platforms/link-policy.ts) parses and screens a link first and hands
// this module its host and its path:
// - classifyHost(): which platform an exact host belongs to. Each platform
//   has ONE canonical host its links are stored and posted with, and a
//   fixed table of exact aliases folded to it (its www, mobile and older
//   domains: m.facebook.com, twitter.com, telegram.me); a host on one of a
//   platform's own domains that is not in that table (business.facebook.com,
//   help.instagram.com, web.telegram.org) is refused, never taken as some
//   "other" site. Nothing is matched by suffix but the domain ownership
//   test, which only ever refuses.
// - classifyPath(): what a path on a platform is. Only the shapes below are
//   accepted, an account or a post, so a platform-hosted redirect or a page
//   that needs its query (Facebook's profile.php?id=..., which the policy's
//   stripping would empty) is never taken as a target; the canonical path
//   keeps the identifying segments only. Telegram is stricter still: a
//   public username, t.me/<username>, or one of its posts,
//   t.me/<username>/<digits>, and nothing else (no invite, no joinchat, no
//   start or startapp parameter, no Mini App launch t.me/<name>/<app>):
//   a Telegram target is never sent as a link at all; the post shows it as
//   code text, which is why the username and the post number are parsed
//   here.
// The account a post URL names is derived where the URL carries the
// username (X, TikTok, Telegram, Instagram's /<user>/p/<code> and
// stories); Instagram's /p/<code> and Facebook's share links, reels and
// group posts carry none, and the reporter is asked for the account's link.

export const PLATFORMS = ['instagram', 'x', 'facebook', 'tiktok', 'telegram', 'other'] as const;
export type Platform = (typeof PLATFORMS)[number];
/** The platforms the bot knows: every one but "other", a site without its own rules here. */
export type NamedPlatform = Exclude<Platform, 'other'>;

export const isPlatform = (value: unknown): value is Platform =>
  typeof value === 'string' && (PLATFORMS as readonly string[]).includes(value);

/** The one host each platform's links are stored with, and posted with when allowed. */
export const CANONICAL_HOSTS: Readonly<Record<NamedPlatform, string>> = Object.freeze({
  instagram: 'www.instagram.com',
  x: 'x.com',
  facebook: 'www.facebook.com',
  tiktok: 'www.tiktok.com',
  telegram: 't.me',
});

/** The exact hosts whose links are folded to their platform's canonical host. */
export const HOST_ALIASES: Readonly<Record<string, NamedPlatform>> = Object.freeze({
  'www.instagram.com': 'instagram',
  'instagram.com': 'instagram',
  'm.instagram.com': 'instagram',
  'x.com': 'x',
  'www.x.com': 'x',
  'mobile.x.com': 'x',
  'twitter.com': 'x',
  'www.twitter.com': 'x',
  'mobile.twitter.com': 'x',
  'm.twitter.com': 'x',
  'www.facebook.com': 'facebook',
  'facebook.com': 'facebook',
  'm.facebook.com': 'facebook',
  'mobile.facebook.com': 'facebook',
  'web.facebook.com': 'facebook',
  'mbasic.facebook.com': 'facebook',
  'touch.facebook.com': 'facebook',
  'www.tiktok.com': 'tiktok',
  'tiktok.com': 'tiktok',
  'm.tiktok.com': 'tiktok',
  't.me': 'telegram',
  'telegram.me': 'telegram',
  'www.telegram.me': 'telegram',
  'telegram.dog': 'telegram',
});

/** The domains each platform owns: a host on one of them that is no alias is refused. */
export const PLATFORM_DOMAINS: Readonly<Record<string, NamedPlatform>> = Object.freeze({
  'instagram.com': 'instagram',
  'instagr.am': 'instagram',
  'cdninstagram.com': 'instagram',
  'x.com': 'x',
  'twitter.com': 'x',
  't.co': 'x',
  'twimg.com': 'x',
  'facebook.com': 'facebook',
  'fb.com': 'facebook',
  'fb.me': 'facebook',
  'fb.watch': 'facebook',
  'fbcdn.net': 'facebook',
  'tiktok.com': 'tiktok',
  'tiktokcdn.com': 'tiktok',
  't.me': 'telegram',
  'telegram.me': 'telegram',
  'telegram.dog': 'telegram',
  'telegram.org': 'telegram',
  'telesco.pe': 'telegram',
});

/** What an exact host is. */
export type HostClass =
  | { readonly kind: 'platform'; readonly platform: NamedPlatform; readonly canonicalHost: string }
  | { readonly kind: 'platform_domain'; readonly platform: NamedPlatform }
  | { readonly kind: 'other' };

/** The platform a host is owned by, if any: the host is the domain or ends in "." and the domain. */
const ownerOf = (host: string): NamedPlatform | undefined => {
  for (const [domain, platform] of Object.entries(PLATFORM_DOMAINS)) {
    if (host === domain || host.endsWith(`.${domain}`)) return platform;
  }
  return undefined;
};

/** What `host` (lower-cased, as the URL parser leaves it) is: see the header. */
export function classifyHost(host: string): HostClass {
  const alias = Object.hasOwn(HOST_ALIASES, host) ? HOST_ALIASES[host] : undefined;
  if (alias !== undefined) return { kind: 'platform', platform: alias, canonicalHost: CANONICAL_HOSTS[alias] };
  const owner = ownerOf(host);
  return owner === undefined ? { kind: 'other' } : { kind: 'platform_domain', platform: owner };
}

/** An accepted link's target on a named platform. */
export interface PlatformTarget {
  readonly kind: 'account' | 'post';
  /** The canonical path, without the leading or a trailing slash. */
  readonly path: string;
  /** The canonical path of the account the link names, when it names one; for an account, its own path. */
  readonly accountPath: string | null;
  /** Telegram only: the public username, and the post number of a post link. */
  readonly telegram?: { readonly username: string; readonly post: number | null };
}

/** Why a path on a named platform is refused. */
export type PathRefusal = 'not_a_target' | 'redirector' | 'telegram';

const account = (path: string): PlatformTarget => ({ kind: 'account', path, accountPath: path });
const post = (path: string, accountPath: string | null): PlatformTarget => ({ kind: 'post', path, accountPath });

const lower = (segment: string): string => segment.toLowerCase();

const INSTAGRAM_USERNAME = /^(?=.*[A-Za-z0-9_])[A-Za-z0-9._]{1,30}$/;
const INSTAGRAM_CODE = /^[A-Za-z0-9_-]{5,64}$/;
const INSTAGRAM_POST_KINDS = new Set(['p', 'reel', 'reels', 'tv']);
const INSTAGRAM_RESERVED = new Set([
  'p', 'reel', 'reels', 'tv', 'stories', 'explore', 'accounts', 'direct', 'about', 'legal', 'developer',
  'web', 'emails', 'challenge', 'ar', 'graphql', 'api', 'static', 'privacy', 'terms', 'session', 'oauth',
  'nametag', 's', 'share', 'invites', 'topics', 'directory', 'lite', 'download', 'help', 'press', 'jobs',
  'blog', 'threads', 'create', 'your_activity', 'linkshim', 'highlights',
]);
const DIGITS = /^[0-9]{1,25}$/;
/** An Instagram post's kind as its canonical path writes it: /reels/<code> is the same post as /reel/<code>. */
const postKind = (segment: string): string => (lower(segment) === 'reels' ? 'reel' : lower(segment));

const instagram = (segments: readonly string[]): PlatformTarget | PathRefusal => {
  const [first = '', second, third, ...rest] = segments;
  const firstIsUser = INSTAGRAM_USERNAME.test(first) && !INSTAGRAM_RESERVED.has(lower(first));
  if (segments.length === 1 && firstIsUser) return account(first);
  if (segments.length === 2 && INSTAGRAM_POST_KINDS.has(lower(first)) && INSTAGRAM_CODE.test(second ?? '')) {
    return post(`${postKind(first)}/${second ?? ''}`, null);
  }
  if (segments.length === 3 && firstIsUser && INSTAGRAM_POST_KINDS.has(lower(second ?? '')) && INSTAGRAM_CODE.test(third ?? '')) {
    return post(`${postKind(second ?? '')}/${third ?? ''}`, first);
  }
  if (rest.length === 0 && lower(first) === 'stories' && lower(second ?? '') === 'highlights' && DIGITS.test(third ?? '')) {
    return post(`stories/highlights/${third ?? ''}`, null);
  }
  if (
    rest.length === 0 &&
    lower(first) === 'stories' &&
    INSTAGRAM_USERNAME.test(second ?? '') &&
    !INSTAGRAM_RESERVED.has(lower(second ?? '')) &&
    DIGITS.test(third ?? '')
  ) {
    return post(`stories/${second ?? ''}/${third ?? ''}`, second ?? null);
  }
  return 'not_a_target';
};

const X_USERNAME = /^[A-Za-z0-9_]{1,15}$/;
const X_STATUS = /^[0-9]{1,20}$/;
const X_RESERVED = new Set([
  'i', 'home', 'explore', 'search', 'settings', 'notifications', 'messages', 'hashtag', 'intent', 'share',
  'compose', 'login', 'logout', 'signup', 'tos', 'privacy', 'about', 'jobs', 'download', 'account', 'lists',
  'topics', 'communities', 'premium', 'verified', 'bookmarks', 'help', 'rules', 'en',
]);
/** What may follow /<user>/status/<id>: one of the post's own pages, or its photo or video n. */
const X_STATUS_PAGES = new Set(['analytics', 'quotes', 'retweets', 'likes', 'history']);
const X_MEDIA = new Set(['photo', 'video']);
const MEDIA_INDEX = /^[0-9]{1,2}$/;

/** Whether `tail`, what follows /<user>/status/<id>, is nothing or one of the post's own pages. */
const isStatusTail = (tail: readonly string[]): boolean => {
  const [page = '', index = ''] = tail.map(lower);
  if (tail.length === 0) return true;
  if (tail.length === 1) return X_STATUS_PAGES.has(page);
  return tail.length === 2 && X_MEDIA.has(page) && MEDIA_INDEX.test(index);
};

const x = (segments: readonly string[]): PlatformTarget | PathRefusal => {
  const [first = '', second = '', third = '', fourth = '', ...rest] = segments;
  const firstIsUser = X_USERNAME.test(first) && !X_RESERVED.has(lower(first));
  if (segments.length === 1 && firstIsUser) return account(first);
  if (firstIsUser && lower(second) === 'status' && X_STATUS.test(third) && isStatusTail(segments.slice(3))) {
    return post(`${first}/status/${third}`, first);
  }
  if (lower(first) === 'i' && rest.length === 0) {
    if (segments.length === 4 && lower(second) === 'web' && lower(third) === 'status' && X_STATUS.test(fourth)) {
      return post(`i/web/status/${fourth}`, null);
    }
    if (segments.length === 3 && lower(second) === 'status' && X_STATUS.test(third)) return post(`i/web/status/${third}`, null);
  }
  return 'not_a_target';
};

const FACEBOOK_NAME = /^(?=.*[A-Za-z0-9])[A-Za-z0-9.]{5,50}$/;
const FACEBOOK_POST_ID = /^(?:[0-9]{1,25}|pfbid[0-9A-Za-z]{10,80})$/;
const FACEBOOK_GROUP = /^[A-Za-z0-9._-]{1,100}$/;
const FACEBOOK_SHARE_CODE = /^[A-Za-z0-9_-]{4,64}$/;
const FACEBOOK_SLUG = /^[A-Za-z0-9._%-]{1,200}$/;
const FACEBOOK_RESERVED = new Set([
  'groups', 'people', 'pages', 'share', 'reel', 'reels', 'watch', 'events', 'marketplace', 'gaming', 'help',
  'settings', 'login', 'privacy', 'policies', 'policy', 'legal', 'business', 'ads', 'messages',
  'notifications', 'friends', 'bookmarks', 'hashtag', 'search', 'home', 'stories', 'photo', 'photos', 'media',
  'dialog', 'plugins', 'sharer', 'tr', 'ajax', 'story', 'permalink', 'profile', 'video', 'videos', 'live',
  'fundraisers', 'games', 'jobs', 'saved', 'memories', 'l', 'lm', 'r', 'n', 'checkpoint', 'recover',
]);

const facebook = (segments: readonly string[]): PlatformTarget | PathRefusal => {
  const [first = '', second = '', third = '', fourth = ''] = segments;
  const head = lower(first);
  if (head === 'l.php') return 'redirector';
  // A page that names its target in the query, which the policy strips.
  if (head.endsWith('.php')) return 'not_a_target';
  const firstIsName = FACEBOOK_NAME.test(first) && !FACEBOOK_RESERVED.has(head);
  if (segments.length === 1 && firstIsName) return account(first);
  if (firstIsName && segments.length === 3 && ['posts', 'videos'].includes(lower(second)) && FACEBOOK_POST_ID.test(third)) {
    return post(`${first}/${lower(second)}/${third}`, first);
  }
  if (firstIsName && segments.length === 4 && lower(second) === 'videos' && FACEBOOK_SLUG.test(third) && DIGITS.test(fourth)) {
    return post(`${first}/videos/${fourth}`, first);
  }
  if ((head === 'people' || head === 'pages') && segments.length === 3 && FACEBOOK_SLUG.test(second) && DIGITS.test(third)) {
    return account(`${head}/${second}/${third}`);
  }
  if (head === 'groups' && FACEBOOK_GROUP.test(second)) {
    if (segments.length === 2) return account(`groups/${second}`);
    if (segments.length === 4 && ['posts', 'permalink'].includes(lower(third)) && FACEBOOK_POST_ID.test(fourth)) {
      return post(`groups/${second}/${lower(third)}/${fourth}`, null);
    }
  }
  if (head === 'share') {
    if (segments.length === 3 && ['p', 'v', 'r', 'g'].includes(lower(second)) && FACEBOOK_SHARE_CODE.test(third)) {
      return post(`share/${lower(second)}/${third}`, null);
    }
    if (segments.length === 2 && FACEBOOK_SHARE_CODE.test(second)) return post(`share/${second}`, null);
  }
  if (head === 'reel' && segments.length === 2 && DIGITS.test(second)) return post(`reel/${second}`, null);
  return 'not_a_target';
};

const TIKTOK_HANDLE = /^@[A-Za-z0-9._]{2,24}$/;

const tiktok = (segments: readonly string[]): PlatformTarget | PathRefusal => {
  const [first = '', second = '', third = ''] = segments;
  // www.tiktok.com/t/<code> is TikTok's own short link, a redirect.
  if (lower(first) === 't') return 'redirector';
  if (!TIKTOK_HANDLE.test(first)) return 'not_a_target';
  if (segments.length === 1) return account(first);
  if (segments.length === 3 && ['video', 'photo'].includes(lower(second)) && DIGITS.test(third)) {
    return post(`${first}/${lower(second)}/${third}`, first);
  }
  return 'not_a_target';
};

/** A public Telegram username: 4 to 32 characters, a letter first, no underscore last. */
const TELEGRAM_USERNAME = /^[A-Za-z][A-Za-z0-9_]{2,30}[A-Za-z0-9]$/;
const TELEGRAM_POST = /^[1-9][0-9]{0,9}$/;
/** t.me paths that are deep links, never a username. */
const TELEGRAM_RESERVED = new Set([
  'joinchat', 'addstickers', 'addemoji', 'addtheme', 'addlist', 'share', 'proxy', 'socks', 'login', 'boost',
  'contact', 'setlanguage', 'confirmphone', 'invoice', 'giftcode', 'premium_offer', 'premium_multigift',
]);
/** The only query parameters a t.me link may carry: a post's own view options. Anything else is refused. */
const TELEGRAM_QUERY_KEYS = new Set(['single', 'comment', 'thread']);

const telegram = (segments: readonly string[], query: URLSearchParams): PlatformTarget | PathRefusal => {
  for (const name of query.keys()) if (!TELEGRAM_QUERY_KEYS.has(name)) return 'telegram';
  const [username = '', number = ''] = segments;
  if (!TELEGRAM_USERNAME.test(username) || TELEGRAM_RESERVED.has(lower(username))) return 'telegram';
  if (segments.length === 1) return { ...account(username), telegram: { username, post: null } };
  if (segments.length === 2 && TELEGRAM_POST.test(number)) {
    return { ...post(`${username}/${number}`, username), telegram: { username, post: Number(number) } };
  }
  return 'telegram';
};

/**
 * What the path `segments` (the URL path split at "/", empty segments
 * dropped) is on `platform`; `query` is consulted for Telegram only, every
 * other platform's query being stripped by the policy.
 */
export function classifyPath(
  platform: NamedPlatform,
  segments: readonly string[],
  query: URLSearchParams,
): PlatformTarget | PathRefusal {
  switch (platform) {
    case 'instagram':
      return instagram(segments);
    case 'x':
      return x(segments);
    case 'facebook':
      return facebook(segments);
    case 'tiktok':
      return tiktok(segments);
    case 'telegram':
      return telegram(segments, query);
  }
}

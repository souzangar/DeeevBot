// @critical-path
// The text of an approved report's post (critical invariants 3 and 4; the
// MVP plan, sections 4 "Review" and "Rendering"; doc/product/report-categories-and-routing.md).
// The approval renders it, in both locales, before anything is written, and
// keeps it as `reports.broadcast_text`; the scheduling unit posts it.
//
// What a post carries, and nothing else:
// - a title: the platform and the admin's category (a "other" post names
//   the category only);
// - the targets the approval's link mode allows, each as non-tappable code
//   text: the account link, and for 'post' the post's URL too. A Telegram
//   target is never a link: the channel as `@username` and its post as
//   `post 123` (telegramTarget()). Every other link passes the link policy
//   again here (isSendableTargetLink() over ALLOWED_LINK_HOSTS): for a site
//   other than the five platforms a link that fails is left out and the
//   post says so, as the routing table states; for the five platforms a
//   link that fails refuses the post (the configuration changed since the
//   intake), which the admin is told;
// - the catalog's instruction block for the platform and the category
//   (src/platforms/instructions.ts: the generic block for "other");
// - the fixed warning line, never to follow instructions to visit other
//   links, join a chat or press Start;
// - the admin's recommended points under their fixed heading, escaped text
//   that passed the free-text validator (src/review/text-policy.ts).
// Never the reporter's reference, comment or flag, nor the approving
// admin's identity: nothing of them is an input here. Suspected CSAM has no
// post: renderPost() refuses it.
//
// The bilingual post is the Persian, a divider, then the English, in one
// message, so it must fit Telegram's 4096 characters after the entities are
// parsed: visibleLength() counts what Telegram counts (tags out, entities
// as one character, UTF-16 units, which is never fewer), and postProblems()
// says whether a text is too long or carries a tappable link off the two
// lists (outgoingLinkProblems(); code text is not tappable, which is why
// every target link is checked on its own above).
import { t, type Locale } from '../i18n/index';
import { instructionKey, PLATFORM_NAME_KEYS } from '../platforms/instructions';
import { isSendableTargetLink, outgoingLinkProblems, telegramTarget, type OutgoingLinkProblem } from '../platforms/link-policy';
import type { Platform } from '../platforms/platforms';
import { bidiIsolate, codeText, codeUrl, safeText } from '../telegram/render';
import { isPostedCategory, type Category, type LinkMode } from './categories';
import { CATEGORY_NAME_KEYS } from './names';

/** Telegram's bound on a message's text, in characters after the entities are parsed. */
export const TELEGRAM_TEXT_LIMIT = 4096;

/** What separates the Persian post from the English one. */
export const POST_DIVIDER = '────────────';

/** The report a post is about: its platform, the admin's category and its links. */
export interface PostSubject {
  readonly platform: Platform;
  /** The admin's categorisation, never the reporter's label. */
  readonly category: Category;
  readonly url: string | null;
  readonly accountUrl: string | null;
}

/** What the approval decided: the link mode and the admin's recommended points. */
export interface PostTerms {
  readonly linkMode: LinkMode;
  readonly recommendedComment: string;
}

/**
 * Why a post cannot be rendered: its category is never posted, it has no
 * account link yet, or a link of one of the five platforms fails the link
 * policy (or the link mode asks for a post URL the report does not have).
 */
export type PostRefusal = 'not_posted' | 'no_account' | 'link_refused';

export type PostRendering = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly refusal: PostRefusal };

/** A target line's value, as the post shows it: code text, isolated as a run in Persian. */
const asCode = (locale: Locale, html: string): string => (locale === 'fa' ? bidiIsolate(html) : html);

/** The target lines of `subject` under `mode` (see the header), or why there can be none. */
function targetLines(
  subject: PostSubject,
  mode: LinkMode,
  locale: Locale,
  allowedHosts: readonly string[],
): { readonly ok: true; readonly lines: string[] } | { readonly ok: false; readonly refusal: PostRefusal } {
  const { accountUrl, url, platform } = subject;
  if (accountUrl === null) return { ok: false, refusal: 'no_account' };
  const withPost = mode === 'post';
  if (withPost && (url === null || url === accountUrl)) return { ok: false, refusal: 'link_refused' };
  if (platform === 'telegram') {
    const channel = telegramTarget(accountUrl);
    if (channel === null) return { ok: false, refusal: 'link_refused' };
    const lines = [`${t(locale, 'post.channel')} ${asCode(locale, codeUrl(`@${channel.username}`))}`];
    if (withPost) {
      const target = url === null ? null : telegramTarget(url);
      if (target === null || target.post === null || target.username.toLowerCase() !== channel.username.toLowerCase()) {
        return { ok: false, refusal: 'link_refused' };
      }
      lines.push(`${t(locale, 'post.post')} ${asCode(locale, codeText(t(locale, 'post.telegram_post', { number: target.post })))}`);
    }
    return { ok: true, lines };
  }
  const links: ['post.account' | 'post.post', string][] = [['post.account', accountUrl]];
  if (withPost && url !== null) links.push(['post.post', url]);
  const lines: string[] = [];
  let withheld = false;
  for (const [label, link] of links) {
    if (isSendableTargetLink(link, allowedHosts)) {
      lines.push(`${t(locale, label)} ${asCode(locale, codeUrl(link))}`);
    } else if (platform === 'other') {
      withheld = true;
    } else {
      return { ok: false, refusal: 'link_refused' };
    }
  }
  if (withheld) lines.push(t(locale, 'post.link_withheld'));
  return { ok: true, lines };
}

/** The post of `subject` under `terms` in `locale` (see the header). */
export function renderPost(
  subject: PostSubject,
  terms: PostTerms,
  locale: Locale,
  allowedHosts: readonly string[],
): PostRendering {
  const { category, platform } = subject;
  if (!isPostedCategory(category)) return { ok: false, refusal: 'not_posted' };
  const targets = targetLines(subject, terms.linkMode, locale, allowedHosts);
  if (!targets.ok) return targets;
  const categoryName = t(locale, CATEGORY_NAME_KEYS[category]);
  const title =
    platform === 'other'
      ? t(locale, 'post.title_other', { category: categoryName })
      : t(locale, 'post.title', { platform: t(locale, PLATFORM_NAME_KEYS[platform]), category: categoryName });
  const text = [
    [title, ...targets.lines].join('\n'),
    t(locale, instructionKey(platform, category)),
    `<i>${t(locale, 'post.warning')}</i>`,
    `${t(locale, 'post.points_heading')}\n${safeText(terms.recommendedComment.trim())}`,
  ].join('\n\n');
  return { ok: true, text };
}

/** The bilingual post: the Persian, the divider, the English, in one message. */
export function renderBilingualPost(subject: PostSubject, terms: PostTerms, allowedHosts: readonly string[]): PostRendering {
  const persian = renderPost(subject, terms, 'fa', allowedHosts);
  if (!persian.ok) return persian;
  const english = renderPost(subject, terms, 'en', allowedHosts);
  if (!english.ok) return english;
  return { ok: true, text: `${persian.text}\n\n${POST_DIVIDER}\n\n${english.text}` };
}

const ENTITY = /&(?:lt|gt|amp|quot|#[0-9]{1,7}|#x[0-9A-Fa-f]{1,6});/g;
const TAG = /<(?:[^>"']|"[^"]*"|'[^']*')*>/g;

/** The length Telegram counts for the Telegram-HTML `html`: tags removed, each entity one character. */
export const visibleLength = (html: string): number => html.replace(TAG, '').replace(ENTITY, '_').length;

/** What keeps a text from being sent (see the header); both empty when nothing does. */
export interface TextProblems {
  /** How many characters it is over TELEGRAM_TEXT_LIMIT; 0 when it fits. */
  readonly excess: number;
  readonly links: readonly OutgoingLinkProblem[];
}

/** The problems of `text` as a message that may link only to `allowedHosts` and the help hosts. */
export function postProblems(text: string, allowedHosts: readonly string[]): TextProblems {
  return {
    excess: Math.max(0, visibleLength(text) - TELEGRAM_TEXT_LIMIT),
    links: outgoingLinkProblems(text, allowedHosts),
  };
}

/** Whether `problems` let the text go. */
export const sendable = (problems: TextProblems): boolean => problems.excess === 0 && problems.links.length === 0;

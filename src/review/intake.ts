// @critical-path
// The intake conversation's pure logic (critical invariants 3, 4 and 8;
// doc/product/report-lifecycle.md, "Intake"; the MVP plan, section 4). No
// I/O here: the Telegram handlers (src/telegram/intake.ts) read and write
// the draft through src/review/drafts.ts and act on what this module
// decides.
//
// - The steps of a draft (`drafts.step`): `url`, then `account` when the
//   account's link cannot be derived from the reported URL (the reporter
//   pastes it, or answers "I don't know" and the admin finds it), then
//   `category`, `affected` ("I am the affected person", yes or no) and
//   `comment`, optional and at most COMMENT_MAX_LENGTH characters; the
//   comment, or /skip, submits the report. A `url` draft exists only when
//   /language kept a locale before any link (the draft is otherwise created
//   with the link). /cancel drops the draft at any step.
// - Intake is text only: a message carrying anything but text (a photo, a
//   document, a sticker, a voice note, a poll, a story ...), a forward, a
//   message sent through an inline bot and a reply quoting another chat are
//   refused, never read: classifyMessage() says 'refused' and the handler
//   deletes them.
// - A command the intake does not know is not read: no draft, the same
//   answer as before intake existed, so a command meant for someone else
//   (a non-keyholder's /lockdown) gets byte for byte the answer any unknown
//   command gets; outside lockdown the handler deletes it on receipt, as it
//   deletes every message received in a private chat
//   (src/telegram/intake.ts).
// - A text at the URL step carries one link: the text itself when it is
//   one token (an address without a scheme, "instagram.com/name", is read
//   as https), else the one token with "://"; none is 'not_a_link', two
//   are 'one_link'. The link policy (src/platforms/link-policy.ts) decides
//   the rest.
// - A pressed button's data is `intake:` and its answer; parsePress() reads
//   only the exact forms pressData() writes, and a press counts only for
//   the step it answers: anything else is a stale press.
// - The limits by reporter reference (doc/product/review-and-abuse-controls.md):
//   members 5 open reports (pending, waiting for a decision) and 20 a day;
//   non-members 1 a day and, all of them together, 20 a day; a reference
//   with 3 or more rejections (rejections_30d) 1 a day; a blocked one
//   none. The open count is read from `reports` at each submit, never kept
//   as a running counter, so a decision in a later unit needs no
//   bookkeeping to free a member's slot.
// - A duplicate is a report whose link hash matches an open target: a
//   report in one of OPEN_TARGET_STATUSES, waiting for its decision or
//   approved and in the channel; a closed, retracted, expired, rejected or
//   routed one is not open, and a report in `closing` or `retracting` is
//   leaving the channel, so a new report of its target is reviewed afresh.
// - The acknowledgement deletes itself at ackDeleteAt(): 20 seconds after
//   it was sent, or 25 seconds after the handler started if that comes
//   first, so the wait ends inside the 30 seconds Workers grants a handler
//   after the response.
import type { Message } from 'grammy/types';
import type { Locale } from '../i18n/index';
import type { Platform } from '../platforms/platforms';
import { isCategory, type Category } from './categories';

/** The steps of a draft, in order. */
export const INTAKE_STEPS = ['url', 'account', 'category', 'affected', 'comment'] as const;
export type IntakeStep = (typeof INTAKE_STEPS)[number];

export const isIntakeStep = (value: unknown): value is IntakeStep =>
  typeof value === 'string' && (INTAKE_STEPS as readonly string[]).includes(value);

/** The longest comment, in characters (code points). */
export const COMMENT_MAX_LENGTH = 500;

/** The intake limits (see the header). */
export const INTAKE_LIMITS = Object.freeze({
  memberOpen: 5,
  memberPerDay: 20,
  nonMemberPerDay: 1,
  nonMemberGlobalPerDay: 20,
  throttleRejections: 3,
  throttledPerDay: 1,
});

/** The `counters` key of the day's non-member submissions, all reporters together. */
export const NON_MEMBER_COUNTER = 'intake_non_member';

/** The statuses of an open target, the ones a new report of the same link is merged into. */
export const OPEN_TARGET_STATUSES = Object.freeze(['pending', 'approved', 'posting', 'posted'] as const);

/** How long the acknowledgement stays, and the budget of the handler that sends it. */
export const ACK_LIFETIME_MS = 20_000;
export const HANDLER_BUDGET_MS = 25_000;

/** When the acknowledgement deletes itself (see the header). */
export const ackDeleteAt = (handlerStart: number, ackSentAt: number): number =>
  Math.min(handlerStart + HANDLER_BUDGET_MS, ackSentAt + ACK_LIFETIME_MS);

/** A draft as the store returns it, checked against its step. */
export interface Draft {
  /** The reporter reference of the chat (src/privacy/reporter-ref.ts), never the chat id. */
  readonly key: string;
  readonly step: IntakeStep;
  /** The reported link, normalised. */
  readonly url: string | null;
  readonly platform: Platform | null;
  /** The account's normalised link; null until known, and for good after "I don't know". */
  readonly accountUrl: string | null;
  readonly category: Category | null;
  readonly affectedPerson: boolean | null;
  readonly locale: Locale;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** What a draft at the comment step holds: everything a report needs but the comment. */
export interface CompleteDraft {
  readonly url: string;
  readonly platform: Platform;
  readonly accountUrl: string | null;
  readonly category: Category;
  readonly affectedPerson: boolean;
}

/** Whether `draft` holds what its step requires: the link from `account` on, the category from `affected`, the flag at `comment`. */
export function holdsItsStep(draft: Omit<Draft, 'key' | 'locale' | 'createdAt' | 'updatedAt'>): boolean {
  const at = INTAKE_STEPS.indexOf(draft.step);
  if (at >= INTAKE_STEPS.indexOf('account') && (draft.url === null || draft.platform === null)) return false;
  if (draft.step === 'account' && draft.accountUrl !== null) return false;
  if (at >= INTAKE_STEPS.indexOf('affected') && draft.category === null) return false;
  if (draft.step === 'comment' && draft.affectedPerson === null) return false;
  return true;
}

/** The draft's content for its report, when it is at the comment step. */
export function completeDraft(draft: Draft): CompleteDraft | null {
  const { url, platform, accountUrl, category, affectedPerson } = draft;
  if (draft.step !== 'comment' || url === null || platform === null || category === null || affectedPerson === null) {
    return null;
  }
  return { url, platform, accountUrl, category, affectedPerson };
}

/** What a reporter's message is to the intake. */
export type IntakeInput =
  | { readonly kind: 'refused' }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'skip' }
  | { readonly kind: 'command' }
  | { readonly kind: 'text'; readonly text: string };

/** A command at the start of a text: /name, or /name@bot. */
const COMMAND = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?=\s|$)/;

/**
 * What `message` is (see the header): 'refused' unless it is a text its
 * sender typed; /cancel and /skip, plain or addressed to this bot; any other
 * command; or a text.
 */
export function classifyMessage(message: Message, botUsername: string): IntakeInput {
  if (
    message.text === undefined ||
    message.forward_origin !== undefined ||
    message.via_bot !== undefined ||
    message.external_reply !== undefined
  ) {
    return { kind: 'refused' };
  }
  const command = COMMAND.exec(message.text);
  if (command === null) return { kind: 'text', text: message.text };
  const [, name = '', addressee] = command;
  if (addressee !== undefined && addressee.toLowerCase() !== botUsername.toLowerCase()) return { kind: 'command' };
  switch (name.toLowerCase()) {
    case 'cancel':
      return { kind: 'cancel' };
    case 'skip':
      return { kind: 'skip' };
    default:
      return { kind: 'command' };
  }
}

/** The link a text carries, or why there is none to take. */
export type LinkCandidate =
  | { readonly ok: true; readonly candidate: string }
  | { readonly ok: false; readonly refusal: 'not_a_link' | 'one_link' };

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
/** One token that reads as a host and maybe a path: "instagram.com/name". */
const HOST_LIKE = /^[^\s/?#.]+(?:\.[^\s/?#.]+)+(?:[/?#]\S*)?$/u;
/** Quotes and brackets a sentence puts before a link, and punctuation it leaves after one. */
const LEADING = /^[«“‘"'(\[<]+/u;
const TRAILING = /[.,;:!?'"»”’\]>]+$/u;

const count = (text: string, char: string): number => text.split(char).length - 1;

/**
 * `token` without the quotes and punctuation around it; a closing
 * parenthesis is taken off only when it closes none the token opened, so
 * a link that ends in one, as many wiki addresses do, is kept whole.
 */
const trimToken = (token: string): string => {
  let trimmed = token.replace(LEADING, '');
  for (;;) {
    const stripped = trimmed.replace(TRAILING, '');
    const next = stripped.endsWith(')') && count(stripped, ')') > count(stripped, '(') ? stripped.slice(0, -1) : stripped;
    if (next === trimmed) return next;
    trimmed = next;
  }
};

/** The one link `text` carries (see the header). */
export function extractLink(text: string): LinkCandidate {
  const tokens = text
    .trim()
    .split(/\s+/u)
    .filter((token) => token !== '')
    .map(trimToken)
    .filter((token) => token !== '');
  const [only] = tokens;
  if (tokens.length === 1 && only !== undefined) {
    if (SCHEME.test(only)) return { ok: true, candidate: only };
    return HOST_LIKE.test(only) ? { ok: true, candidate: `https://${only}` } : { ok: false, refusal: 'not_a_link' };
  }
  const links = tokens.filter((token) => token.includes('://'));
  const [link] = links;
  if (link === undefined) return { ok: false, refusal: 'not_a_link' };
  return links.length === 1 ? { ok: true, candidate: link } : { ok: false, refusal: 'one_link' };
}

/** The comment a text gives, or why it is refused. */
export type CommentCheck = { readonly ok: true; readonly comment: string | null } | { readonly ok: false };

/** The comment of `text`: trimmed, null when empty; refused over COMMENT_MAX_LENGTH characters. */
export function checkComment(text: string): CommentCheck {
  const comment = text.trim();
  if ([...comment].length > COMMENT_MAX_LENGTH) return { ok: false };
  return { ok: true, comment: comment === '' ? null : comment };
}

/** The prefix of every intake button's data. */
export const INTAKE_PREFIX = 'intake:';

/** A pressed intake button: what it answers. */
export type IntakePress =
  | { readonly kind: 'account_unknown' }
  | { readonly kind: 'category'; readonly category: Category }
  | { readonly kind: 'affected'; readonly affected: boolean };

/** A button's callback data: at most 31 bytes, under Telegram's 64. */
export function pressData(press: IntakePress): string {
  switch (press.kind) {
    case 'account_unknown':
      return `${INTAKE_PREFIX}account:unknown`;
    case 'category':
      return `${INTAKE_PREFIX}category:${press.category}`;
    case 'affected':
      return `${INTAKE_PREFIX}affected:${press.affected ? 'yes' : 'no'}`;
  }
}

/** The press `data` is, in exactly a form pressData() writes; else null. */
export function parsePress(data: string): IntakePress | null {
  if (data === `${INTAKE_PREFIX}account:unknown`) return { kind: 'account_unknown' };
  if (data === `${INTAKE_PREFIX}affected:yes`) return { kind: 'affected', affected: true };
  if (data === `${INTAKE_PREFIX}affected:no`) return { kind: 'affected', affected: false };
  const category = data.startsWith(`${INTAKE_PREFIX}category:`) ? data.slice(`${INTAKE_PREFIX}category:`.length) : null;
  return category !== null && isCategory(category) ? { kind: 'category', category } : null;
}

/** The step a press answers. */
export function stepOfPress(press: IntakePress): IntakeStep {
  switch (press.kind) {
    case 'account_unknown':
      return 'account';
    case 'category':
      return 'category';
    case 'affected':
      return 'affected';
  }
}

/** The step after the reported link: the account's link is asked for when it cannot be derived. */
export const stepAfterLink = (accountUrl: string | null): IntakeStep => (accountUrl === null ? 'account' : 'category');

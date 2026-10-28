// @critical-path
// The membership check (doc/product/review-and-abuse-controls.md, "Who may
// report, and the limits"; ADR 0003, "Membership is not authority"): whether
// a reporter is a member of the membership chat (MEMBERSHIP_CHAT_ID), which
// only selects their intake limits and never grants anything.
//
// - getChatMember(MEMBERSHIP_CHAT_ID, the update's user id): a member is
//   `creator`, `administrator`, `member`, or `restricted` with `is_member`
//   true; `left` and `kicked` are not.
// - A failed call is "not a member" and never throws: a 400 "user not
//   found" is an answer (cached, not logged); any other failure (a 403, a
//   429, a 5xx, a timeout) is logged by class and not cached, so the next
//   update asks again.
// - The answer is never stored (critical invariant 8). It is cached in
//   memory for MEMBERSHIP_TTL_MS, per isolate, keyed by the keyed reporter
//   reference (src/privacy/reporter-ref.ts), never by the id, in a map of at
//   most MEMBERSHIP_CACHE_LIMIT entries that drops its oldest first.
import type { ChatMember } from 'grammy/types';
import type { Clock } from '../clock';
import type { Config } from '../config/schema';
import type { Logger } from '../privacy/logger';
import { reporterRef } from '../privacy/reporter-ref';
import type { BotApiPort } from '../telegram/bot-api-port';
import { classifyTelegramError } from '../telegram/errors';

/** How long an answer is reused: 10 minutes. */
export const MEMBERSHIP_TTL_MS = 10 * 60 * 1000;
/** The most answers one isolate keeps. */
export const MEMBERSHIP_CACHE_LIMIT = 1000;

/** Whether a getChatMember answer is a member. */
export const isMemberStatus = (member: ChatMember): boolean => {
  switch (member.status) {
    case 'creator':
    case 'administrator':
    case 'member':
      return true;
    case 'restricted':
      return member.is_member;
    default:
      return false;
  }
};

/** A per-isolate cache of answers, keyed by reporter reference. */
export interface MembershipCache {
  /** The cached answer for `ref`, or undefined when there is none or it expired at `now`. */
  get(ref: string, now: number): boolean | undefined;
  set(ref: string, member: boolean, now: number): void;
  readonly size: number;
}

/** A cache of at most `limit` answers, each kept for `ttlMs`. */
export function createMembershipCache(limit = MEMBERSHIP_CACHE_LIMIT, ttlMs = MEMBERSHIP_TTL_MS): MembershipCache {
  const entries = new Map<string, { readonly member: boolean; readonly expiresAt: number }>();
  return {
    get: (ref, now) => {
      const entry = entries.get(ref);
      if (entry === undefined) return undefined;
      if (entry.expiresAt <= now) {
        entries.delete(ref);
        return undefined;
      }
      return entry.member;
    },
    set: (ref, member, now) => {
      // Re-inserted, the entry moves to the end of the insertion order.
      entries.delete(ref);
      while (entries.size >= limit) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
      entries.set(ref, { member, expiresAt: now + ttlMs });
    },
    get size() {
      return entries.size;
    },
  };
}

/** The isolate's own cache: it lives as long as the isolate does. */
const isolateCache = createMembershipCache();

export interface MembershipDeps {
  readonly api: Pick<BotApiPort, 'getChatMember'>;
  readonly config: Pick<Config, 'membershipChatId' | 'reporterRefKey'>;
  readonly clock: Clock;
  readonly logger: Logger;
  /** The isolate's cache unless given (tests pass their own). */
  readonly cache?: MembershipCache;
}

/** Whether `userId` is a member of the membership chat (see the header). Never throws. */
export async function membershipOf(deps: MembershipDeps, userId: number): Promise<boolean> {
  // A Telegram user id is a positive safe integer; anything else is no member.
  if (!Number.isSafeInteger(userId) || userId <= 0) return false;
  const cache = deps.cache ?? isolateCache;
  const ref = await reporterRef(userId, deps.config.reporterRefKey);
  const cached = cache.get(ref, deps.clock.now());
  if (cached !== undefined) return cached;
  let member: boolean;
  try {
    member = isMemberStatus(await deps.api.getChatMember(deps.config.membershipChatId, userId));
  } catch (error) {
    if (classifyTelegramError(error).kind !== 'user_not_found') {
      deps.logger.logError('membership.failed', error);
      return false;
    }
    member = false;
  }
  cache.set(ref, member, deps.clock.now());
  return member;
}

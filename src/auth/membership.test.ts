// Unit tests for the membership check (src/auth/membership.ts) over the
// fake Bot API: the member definition, the cache keyed by the reporter
// reference (never the id) with its time limit and size bound, and every
// failure answered "not a member" without throwing.
import { describe, expect, it } from 'vitest';
import { FAILURES, fakeBotApi, rateLimited } from '../../test/fakes/bot-api';
import { fakeClock } from '../../test/fakes/clock';
import { recordingLogger } from '../../test/fakes/logger';
import { IDS, testConfig } from '../../test/support/config';
import { reporterRef } from '../privacy/reporter-ref';
import { createBotApi } from '../telegram/api';
import {
  createMembershipCache,
  isMemberStatus,
  MEMBERSHIP_CACHE_LIMIT,
  MEMBERSHIP_TTL_MS,
  membershipOf,
} from './membership';

const NOW = 1_850_000_000_000;
const config = testConfig();

const setup = () => {
  const telegram = fakeBotApi();
  const clock = fakeClock(NOW);
  const log = recordingLogger();
  const cache = createMembershipCache();
  const deps = { api: createBotApi(config, telegram.fetch), config, clock, logger: log.logger, cache };
  return { telegram, clock, log, cache, deps };
};

describe('isMemberStatus', () => {
  it.each([
    ['creator', { status: 'creator' }, true],
    ['administrator', { status: 'administrator' }, true],
    ['member', { status: 'member' }, true],
    ['restricted and still a member', { status: 'restricted', is_member: true }, true],
    ['restricted and no longer a member', { status: 'restricted', is_member: false }, false],
    ['left', { status: 'left' }, false],
    ['kicked', { status: 'kicked' }, false],
  ])('%s', (_label, member, expected) => {
    expect(isMemberStatus(member as Parameters<typeof isMemberStatus>[0])).toBe(expected);
  });
});

describe('membershipOf', () => {
  it('asks getChatMember about the membership chat and answers from the member definition', async () => {
    const { telegram, deps } = setup();
    telegram.setMember(IDS.membershipChat, IDS.reporter, { status: 'member' });
    expect(await membershipOf(deps, IDS.reporter)).toBe(true);
    expect(telegram.callsOf('getChatMember')).toEqual([
      { method: 'getChatMember', chatId: IDS.membershipChat, payload: { chat_id: IDS.membershipChat, user_id: IDS.reporter } },
    ]);
    expect(await membershipOf(deps, IDS.stranger)).toBe(false);
  });

  it('caches an answer for ten minutes under the reporter reference, never the id', async () => {
    const { telegram, clock, cache, deps } = setup();
    telegram.setMember(IDS.membershipChat, IDS.reporter, { status: 'member' });
    await membershipOf(deps, IDS.reporter);
    await membershipOf(deps, IDS.reporter);
    expect(telegram.count('getChatMember')).toBe(1);
    const ref = await reporterRef(IDS.reporter, config.reporterRefKey);
    expect(cache.get(ref, clock.now())).toBe(true);
    expect(cache.get(String(IDS.reporter), clock.now())).toBeUndefined();
    clock.advance(MEMBERSHIP_TTL_MS);
    await membershipOf(deps, IDS.reporter);
    expect(telegram.count('getChatMember')).toBe(2);
  });

  it('answers "not a member" to a "user not found", caches it and logs nothing', async () => {
    const { telegram, log, deps } = setup();
    telegram.setMember(IDS.membershipChat, IDS.reporter, 'user_not_found');
    expect(await membershipOf(deps, IDS.reporter)).toBe(false);
    expect(await membershipOf(deps, IDS.reporter)).toBe(false);
    expect(telegram.count('getChatMember')).toBe(1);
    expect(log.lines).toEqual([]);
  });

  it.each([
    ['a 403', FAILURES.cantInitiateConversation],
    ['a 429', rateLimited(5)],
    ['a 5xx', FAILURES.serverError],
    ['a timeout', FAILURES.timeout],
    ['a network failure', FAILURES.networkFailure],
  ])('answers "not a member" to %s without throwing, logs its class and asks again next time', async (_label, outcome) => {
    const { telegram, log, deps } = setup();
    telegram.setMember(IDS.membershipChat, IDS.reporter, { status: 'member' });
    telegram.fail({ method: 'getChatMember' }, outcome, 1);
    expect(await membershipOf(deps, IDS.reporter)).toBe(false);
    expect(log.records()).toEqual([expect.objectContaining({ level: 'error', event: 'membership.failed' })]);
    expect(log.text()).not.toContain(String(IDS.reporter));
    expect(log.text()).not.toContain(String(IDS.membershipChat));
    expect(await membershipOf(deps, IDS.reporter)).toBe(true);
  });

  it('answers "not a member" for an id that is not a Telegram user id, without a call', async () => {
    const { telegram, deps } = setup();
    for (const id of [0, -IDS.reporter, 1.5, Number.NaN]) expect(await membershipOf(deps, id)).toBe(false);
    expect(telegram.count()).toBe(0);
  });
});

describe('createMembershipCache', () => {
  it('drops its oldest entry once full', () => {
    const cache = createMembershipCache(2, 1000);
    cache.set('a', true, 0);
    cache.set('b', false, 0);
    cache.set('c', true, 0);
    expect(cache.size).toBe(2);
    expect(cache.get('a', 0)).toBeUndefined();
    expect(cache.get('b', 0)).toBe(false);
    expect(cache.get('c', 0)).toBe(true);
  });

  it('refreshes an entry set again, and expires it after its time', () => {
    const cache = createMembershipCache(2, 1000);
    cache.set('a', true, 0);
    cache.set('b', true, 0);
    cache.set('a', false, 500);
    cache.set('c', true, 500);
    expect(cache.get('a', 600)).toBe(false);
    expect(cache.get('b', 600)).toBeUndefined();
    expect(cache.get('a', 1500)).toBeUndefined();
    expect(cache.size).toBe(1);
  });

  it('holds at most MEMBERSHIP_CACHE_LIMIT answers by default', () => {
    const cache = createMembershipCache();
    for (let index = 0; index < MEMBERSHIP_CACHE_LIMIT + 10; index += 1) cache.set(`ref-${index}`, true, 0);
    expect(cache.size).toBe(MEMBERSHIP_CACHE_LIMIT);
  });
});

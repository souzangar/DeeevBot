// Unit tests for the allowlist gates (src/auth/allowlist.ts): numeric ids
// only, the two lists disjoint, nothing but a positive safe integer ever
// matches.
import { describe, expect, it } from 'vitest';
import { IDS, testConfig } from '../../test/support/config';
import { isAdmin, isKeyholder } from './allowlist';

const config = testConfig();

describe('isAdmin', () => {
  it('admits exactly the ids on ADMIN_IDS', () => {
    expect(isAdmin(config, IDS.admin)).toBe(true);
    expect(isAdmin(config, IDS.secondAdmin)).toBe(true);
    for (const id of [IDS.keyholder, IDS.secondKeyholder, IDS.reporter, IDS.bot]) expect(isAdmin(config, id)).toBe(false);
  });

  it.each([
    ['no id', undefined],
    ['zero', 0],
    ['a negative id (a chat)', -IDS.admin],
    ['a fraction', IDS.admin + 0.5],
    ['NaN', Number.NaN],
    ['an unsafe integer', Number.MAX_SAFE_INTEGER + 2],
  ])('refuses %s', (_label, id) => {
    expect(isAdmin(config, id)).toBe(false);
  });

  it('never matches a string, whatever it holds (past the types)', () => {
    expect(isAdmin(config, String(IDS.admin) as unknown as number)).toBe(false);
  });
});

describe('isKeyholder', () => {
  it('admits exactly the ids on KEYHOLDER_IDS', () => {
    expect(isKeyholder(config, IDS.keyholder)).toBe(true);
    expect(isKeyholder(config, IDS.secondKeyholder)).toBe(true);
    for (const id of [IDS.admin, IDS.secondAdmin, IDS.reporter, undefined, 0]) {
      expect(isKeyholder(config, id)).toBe(false);
    }
  });

  it('is disjoint from isAdmin, since the configuration refuses an id in both lists', () => {
    for (const id of [...config.adminIds, ...config.keyholderIds]) {
      expect(isAdmin(config, id) && isKeyholder(config, id)).toBe(false);
    }
    expect(() => testConfig({ KEYHOLDER_IDS: String(IDS.admin) })).toThrow(/must not share an id/);
  });
});

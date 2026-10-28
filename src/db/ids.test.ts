// Unit tests for the random ids (src/db/ids.ts): the shape, that every
// letter is drawn without bias, and that the redacting logger keeps an id
// as itself (its report-id shape is the same one).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordingLogger } from '../../test/fakes/logger';
import { ID_LENGTH, ID_PATTERN, isId, randomId } from './ids';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('randomId', () => {
  it('is 20 lowercase letters a to z', () => {
    for (let draw = 0; draw < 200; draw += 1) {
      const id = randomId();
      expect(id).toHaveLength(ID_LENGTH);
      expect(id).toMatch(/^[a-z]{20}$/);
      expect(isId(id)).toBe(true);
    }
  });

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 2_000 }, () => randomId()));
    expect(ids.size).toBe(2_000);
  });

  it('draws every letter about equally often', () => {
    const counts = new Map<string, number>();
    for (let draw = 0; draw < 20_000; draw += 1) {
      for (const letter of randomId()) counts.set(letter, (counts.get(letter) ?? 0) + 1);
    }
    // 400,000 letters: about 15,385 each, give or take 121 (one standard
    // deviation); the bounds are five of them. A biased draw (byte % 26 over
    // all 256 bytes) would put w to z near 14,060, eleven deviations low.
    expect(counts.size).toBe(26);
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(14_780);
      expect(count).toBeLessThan(15_990);
    }
  });

  it('skips the bytes from 234 up, which would bias the letters', () => {
    const fills = [
      [234, 255, 0, 25, 26, ...Array<number>(27).fill(255)],
      Array.from({ length: 32 }, (_, index) => index),
    ];
    let call = 0;
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
      const fill = fills[Math.min(call, fills.length - 1)] ?? [];
      call += 1;
      if (array instanceof Uint8Array) array.set(fill.slice(0, array.length));
      return array;
    });
    // bytes 0, 25, 26 give a, z, a; then 0 to 16 give a to q
    expect(randomId()).toBe('aza' + 'abcdefghijklmnopq');
  });
});

describe('isId', () => {
  it.each([
    ['19 letters', 'a'.repeat(19)],
    ['21 letters', 'a'.repeat(21)],
    ['a digit', `${'a'.repeat(19)}1`],
    ['a capital', `${'a'.repeat(19)}A`],
    ['an underscore', `${'a'.repeat(19)}_`],
    ['a number', 12345],
  ])('refuses %s', (_label, value) => {
    expect(isId(value)).toBe(false);
    expect(ID_PATTERN.test(String(value))).toBe(false);
  });
});

describe('the logger and the id shape', () => {
  it('logs a generated id as itself', () => {
    const recorder = recordingLogger();
    const id = randomId();
    recorder.logger.log('update.failed', { reportId: id });
    expect(recorder.records()).toEqual([{ level: 'info', event: 'update.failed', reportId: id }]);
  });
});

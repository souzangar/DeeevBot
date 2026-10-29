// Unit tests for the keyed link hash (src/privacy/link-hash.ts; critical
// invariant 8): 64 lowercase hex characters, the HMAC-SHA-256 of "link:"
// and the normalised URL under the key, stable for one URL and key,
// different for another URL or key, never equal to a reporter reference,
// and refused for anything but an https URL, with no URL in the error.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { reporterRef } from './reporter-ref';
import { LINK_HASH_DOMAIN, linkHash } from './link-hash';

const KEY = 'unit-test-link-hash-key';
const URL_A = 'https://www.instagram.com/someone';

describe('linkHash', () => {
  it('is the hex HMAC-SHA-256 of "link:" and the URL under the key', async () => {
    const expected = createHmac('sha256', KEY).update(`${LINK_HASH_DOMAIN}${URL_A}`).digest('hex');
    expect(await linkHash(URL_A, KEY)).toBe(expected);
    expect(await linkHash(URL_A, KEY)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable for one URL and key, and differs for another URL or another key', async () => {
    expect(await linkHash(URL_A, KEY)).toBe(await linkHash(URL_A, KEY));
    expect(await linkHash(URL_A, KEY)).not.toBe(await linkHash('https://www.instagram.com/someone.else', KEY));
    expect(await linkHash(URL_A, KEY)).not.toBe(await linkHash(URL_A, `${KEY}-rotated`));
  });

  it('never equals a reporter reference under the same key', async () => {
    expect(await linkHash('https://x.com/424240031', KEY)).not.toBe(await reporterRef(424240031, KEY));
    const plain = createHmac('sha256', KEY).update(URL_A).digest('hex');
    expect(await linkHash(URL_A, KEY)).not.toBe(plain);
  });

  it('refuses anything but an https URL, and the error names no URL', async () => {
    for (const value of ['http://www.instagram.com/someone', 'www.instagram.com/someone', '424240031', '']) {
      const caught: unknown = await linkHash(value, KEY).catch((error: unknown) => error);
      expect(caught, value).toMatchObject({ code: 'UNEXPECTED' });
      if (value !== '') expect(String((caught as Error).message), value).not.toContain(value);
    }
  });
});

// Unit tests for the reporter reference: the hex HMAC-SHA-256 of the decimal
// user id under REPORTER_REF_KEY, checked against node:crypto (used here, in
// the test only; the module itself runs on WebCrypto).
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors/app-error';
import { reporterRef } from './reporter-ref';

// Fixture values are deliberately not secret-shaped: the commit gate's
// secret-shape scan covers test files too.
const KEY = 'unit-test-reporter-ref-key';
const ROTATED_KEY = 'unit-test-reporter-ref-key-rotated';
const USER_ID = 424242001;

/** The reference computed independently, with node:crypto. */
const vector = (userId: number, key: string): string =>
  createHmac('sha256', key).update(String(userId), 'utf8').digest('hex');

describe('reporterRef', () => {
  it('is the hex HMAC-SHA-256 of the decimal id under the key (vector from node:crypto)', async () => {
    expect(await reporterRef(USER_ID, KEY)).toBe(vector(USER_ID, KEY));
    expect(await reporterRef(1, KEY)).toBe(vector(1, KEY));
    expect(await reporterRef(Number.MAX_SAFE_INTEGER, KEY)).toBe(vector(Number.MAX_SAFE_INTEGER, KEY));
  });

  it('is 64 lowercase hex characters that do not contain the id', async () => {
    const ref = await reporterRef(USER_ID, KEY);
    expect(ref).toMatch(/^[0-9a-f]{64}$/);
    expect(ref).not.toContain(String(USER_ID));
  });

  it('is stable: the same id under the same key always gives the same reference', async () => {
    const refs = await Promise.all([1, 2, 3].map(() => reporterRef(USER_ID, KEY)));
    expect(new Set(refs).size).toBe(1);
  });

  it('changes with the key, so rotating the key severs every reference', async () => {
    const before = await reporterRef(USER_ID, KEY);
    const after = await reporterRef(USER_ID, ROTATED_KEY);
    expect(after).not.toBe(before);
    expect(after).toBe(vector(USER_ID, ROTATED_KEY));
  });

  it('differs between ids under one key', async () => {
    expect(await reporterRef(USER_ID, KEY)).not.toBe(await reporterRef(USER_ID + 1, KEY));
  });

  it('reads the key as UTF-8, non-ASCII characters included', async () => {
    const key = 'کلید-unit-test-key';
    expect(await reporterRef(USER_ID, key)).toBe(vector(USER_ID, key));
  });

  it.each([0, -424242001, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects %s with an AppError UNEXPECTED whose message holds no id',
    async (userId) => {
      const failure = reporterRef(userId, KEY);
      await expect(failure).rejects.toBeInstanceOf(AppError);
      await expect(failure).rejects.toMatchObject({
        code: 'UNEXPECTED',
        message: 'reporterRef takes a positive safe-integer user id',
      });
    },
  );
});

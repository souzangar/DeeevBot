// @critical-path
// The reporter reference (critical invariants 6 and 8;
// doc/product/retention-and-minimisation.md, "The reporter reference"): the
// hex HMAC-SHA-256 of a reporter's numeric Telegram id, written in decimal,
// under REPORTER_REF_KEY. It replaces the id once the decision notice is
// delivered or abandoned, and drives rate limits, rejection counts and
// blocks without identifying anyone from the database alone. Only the key's
// holder can re-identify a reference, so the key comes from the
// configuration (`config.reporterRefKey`) on every call and is never stored,
// cached, logged or returned; changing it severs every existing counter and
// block from its reference (doc/guides/operations-and-security.md, 1.4).
//
// WebCrypto (`crypto.subtle`) runs both on Workers and on Node 22, where it
// is `globalThis.crypto`. The key's bytes are the UTF-8 encoding of the
// configured string.
import { AppError } from '../errors/app-error';

const encoder = new TextEncoder();

const hex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');

/**
 * The reporter reference for `userId` under `key`: 64 lowercase hex
 * characters, stable for a given id and key. Rejects (an AppError
 * UNEXPECTED, whose message holds no id) anything but a positive safe
 * integer, since a Telegram user id is one.
 */
export async function reporterRef(userId: number, key: string): Promise<string> {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new AppError('UNEXPECTED', 'reporterRef takes a positive safe-integer user id');
  }
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', hmacKey, encoder.encode(String(userId))));
}

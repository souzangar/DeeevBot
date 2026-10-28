// @critical-path
// Random ids for reports (`reports.id`), for approvals
// (`approvals.approval_id`, written afresh by every approval and
// re-approval, so the post job's claim never keys on a timestamp) and for
// the cron's jobs (`jobs.id`): the MVP plan, section 3 ("Ids are random:
// callback data must not be forgeable or enumerable"). An id is 20
// lowercase ASCII letters a to z, about 94 bits of entropy, drawn with
// crypto.getRandomValues (WebCrypto, on Workers and on Node 22) by
// rejection sampling, so every letter is equally likely. It holds no
// digit, so the redacting logger's rule against runs of five digits never
// drops one, and the logger's report-id shape (src/privacy/logger.ts) is
// exactly this one; the D1 schema refuses any other shape in an id column.

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';

/** The length of every id. */
export const ID_LENGTH = 20;

/** The shape of every id. */
export const ID_PATTERN = /^[a-z]{20}$/;

/** The largest multiple of 26 not above 256: a byte at or above it is drawn again. */
const UNBIASED_BELOW = 234;

/** A fresh random id. */
export function randomId(): string {
  const bytes = new Uint8Array(32);
  let id = '';
  while (id.length < ID_LENGTH) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= UNBIASED_BELOW) continue;
      id += ALPHABET.charAt(byte % ALPHABET.length);
      if (id.length === ID_LENGTH) break;
    }
  }
  return id;
}

/** Whether `value` has the shape of an id. */
export const isId = (value: unknown): value is string => typeof value === 'string' && ID_PATTERN.test(value);

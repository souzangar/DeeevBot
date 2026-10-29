// @critical-path
// The keyed link hash (critical invariant 8;
// doc/product/retention-and-minimisation.md, "What survives";
// doc/architecture/adr-0006-data-model-and-module-layout.md): the hex
// HMAC-SHA-256 of a reported link's normalised URL (src/platforms/link-policy.ts,
// normaliseUrl), under REPORTER_REF_KEY. It identifies a target without
// storing it: the intake's duplicate check matches a new report against
// the open reports by it (reports.link_hash), and it outlives the report in
// the aggregate row (stats.link_hash), so a later card can say "previously
// reported, outcome X" after every URL is gone. Only the key's holder can
// test a guessed URL against it.
//
// The key is the reporter reference's, domain-separated: the message is
// "link:" and the URL, and a reference's message is a Telegram id written
// in decimal, which never starts with "link:", so a link hash never equals
// a reference. The key comes from the configuration on every call and is
// never stored, cached, logged or returned; changing it severs every
// stored hash from its target, as it does every reference. WebCrypto
// (`crypto.subtle`) runs on Workers and on Node 22.
import { AppError } from '../errors/app-error';

const encoder = new TextEncoder();

/** What is prefixed to the URL before it is hashed. */
export const LINK_HASH_DOMAIN = 'link:';

const hex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');

/**
 * The link hash of `normalisedUrl` under `key`: 64 lowercase hex
 * characters. Rejects (an AppError UNEXPECTED, whose message holds no URL)
 * anything but an https URL, since only a normalised link is ever hashed.
 */
export async function linkHash(normalisedUrl: string, key: string): Promise<string> {
  if (!normalisedUrl.startsWith('https://')) {
    throw new AppError('UNEXPECTED', 'linkHash takes a normalised https URL');
  }
  const hmacKey = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return hex(await crypto.subtle.sign('HMAC', hmacKey, encoder.encode(`${LINK_HASH_DOMAIN}${normalisedUrl}`)));
}

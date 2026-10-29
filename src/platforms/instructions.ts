// @critical-path
// The per-platform instruction blocks a post quotes (critical invariants 3
// and 4; doc/product/report-categories-and-routing.md, "Routing table"):
// instructionKey(platform, category) names the catalog key of the block,
// `instructions.<platform>.<slug>` with the routing table's instruction
// key as the slug, for the five platforms and for "other" (a site without
// a reference page); every platform's report of the category "other" uses
// the one fixed generic block, `instructions.generic`, since no admin
// writes instructions. Suspected CSAM has no block: it is never posted
// (the routing card is the admin's, in the venue), so the type takes the
// posted categories only and the function refuses csam past the types.
//
// The English text is the reference pages' "What the bot's instructions
// say" (doc/reference/platform-reporting-*.md), phrased as points to make
// in the member's own words, never a text to paste and never a promise of
// removal; the Persian is a draft for native review. A block's links are
// the catalog's own and sit on TRUSTED_HELP_HOSTS (src/platforms/link-policy.ts;
// the catalog test checks every one), and a Telegram block tells the
// member to find the channel through the app's search and never press
// Start. A post carries the Persian and the English block, so each stays
// within INSTRUCTION_BLOCK_MAX_LENGTH characters for the bilingual post to
// fit Telegram's 4096 (the review unit validates the whole post).
import { AppError } from '../errors/app-error';
import type { MessageKey } from '../i18n/en';
import type { PlainMessageKey } from '../i18n/index';
import type { PostedCategory } from '../review/categories';
import type { Platform } from './platforms';

/** Each posted category's instruction key in the routing table, "other" aside. */
export const INSTRUCTION_SLUGS = Object.freeze({
  private_data: 'private-information',
  child_safety: 'child-safety',
  harassment: 'harassment',
  intimate_images: 'intimate-images',
  impersonation: 'impersonation',
} as const satisfies Record<Exclude<PostedCategory, 'other'>, string>);

type Slug = (typeof INSTRUCTION_SLUGS)[keyof typeof INSTRUCTION_SLUGS];

/** The fixed generic block of the category "other", on every platform. */
export const GENERIC_INSTRUCTIONS = 'instructions.generic';

/** Every instruction block's catalog key. */
export type InstructionKey = `instructions.${Platform}.${Slug}` | typeof GENERIC_INSTRUCTIONS;

/** A block missing from the catalogs fails the build here. */
type MissingBlocks = Exclude<InstructionKey, MessageKey>;
export const EVERY_BLOCK_IS_IN_THE_CATALOG: [MissingBlocks] extends [never] ? true : MissingBlocks = true;

/** The longest a block may be, in characters, in either locale. */
export const INSTRUCTION_BLOCK_MAX_LENGTH = 1200;

/** The catalog key of the block a post of `category` about `platform` quotes. */
export function instructionKey(platform: Platform, category: PostedCategory): InstructionKey {
  if (category === 'other') return GENERIC_INSTRUCTIONS;
  if (!Object.hasOwn(INSTRUCTION_SLUGS, category)) {
    throw new AppError('UNEXPECTED', 'no instruction block exists for a category that is never posted');
  }
  return `instructions.${platform}.${INSTRUCTION_SLUGS[category]}`;
}

/** The catalog key of each platform's name, as the acknowledgement names a report. */
export const PLATFORM_NAME_KEYS: Readonly<Record<Platform, PlainMessageKey>> = Object.freeze({
  instagram: 'platform.instagram',
  x: 'platform.x',
  facebook: 'platform.facebook',
  tiktok: 'platform.tiktok',
  telegram: 'platform.telegram',
  other: 'platform.other',
});

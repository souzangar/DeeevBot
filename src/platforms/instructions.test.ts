// Unit tests for the instruction blocks (src/platforms/instructions.ts):
// a key for every platform and posted category, "other" on the generic
// block, none for suspected CSAM; every block present in both catalogs,
// within its length, linking only to TRUSTED_HELP_HOSTS, never promising
// removal; Telegram's blocks send the member to the app's search and never
// to Start; intimate images name no post.
import { describe, expect, it } from 'vitest';
import { en } from '../i18n/en';
import { fa } from '../i18n/fa';
import { LOCALES, t } from '../i18n/index';
import { CATEGORIES, isPostedCategory, type PostedCategory } from '../review/categories';
import {
  EVERY_BLOCK_IS_IN_THE_CATALOG,
  GENERIC_INSTRUCTIONS,
  INSTRUCTION_BLOCK_MAX_LENGTH,
  INSTRUCTION_SLUGS,
  instructionKey,
  PLATFORM_NAME_KEYS,
  type InstructionKey,
} from './instructions';
import { linksIn, outgoingLinkProblems } from './link-policy';
import { PLATFORMS } from './platforms';

const POSTED = CATEGORIES.filter(isPostedCategory);
const EVERY_KEY: InstructionKey[] = [
  ...new Set(PLATFORMS.flatMap((platform) => POSTED.map((category) => instructionKey(platform, category)))),
];
const textOf = (locale: (typeof LOCALES)[number], key: InstructionKey): string => t(locale, key);

describe('instructionKey', () => {
  it('names instructions.<platform>.<slug>, with the routing table\'s slugs', () => {
    expect(instructionKey('instagram', 'private_data')).toBe('instructions.instagram.private-information');
    expect(instructionKey('x', 'child_safety')).toBe('instructions.x.child-safety');
    expect(instructionKey('facebook', 'harassment')).toBe('instructions.facebook.harassment');
    expect(instructionKey('tiktok', 'intimate_images')).toBe('instructions.tiktok.intimate-images');
    expect(instructionKey('telegram', 'impersonation')).toBe('instructions.telegram.impersonation');
    expect(instructionKey('other', 'private_data')).toBe('instructions.other.private-information');
    expect(INSTRUCTION_SLUGS).toEqual({
      private_data: 'private-information',
      child_safety: 'child-safety',
      harassment: 'harassment',
      intimate_images: 'intimate-images',
      impersonation: 'impersonation',
    });
  });

  it('gives the category "other" the one generic block, on every platform', () => {
    for (const platform of PLATFORMS) expect(instructionKey(platform, 'other')).toBe(GENERIC_INSTRUCTIONS);
  });

  it('refuses suspected CSAM, which is never posted, past the types', () => {
    expect(() => instructionKey('instagram', 'csam' as PostedCategory)).toThrow(expect.objectContaining({ code: 'UNEXPECTED' }));
  });

  it('covers 31 blocks, each in both catalogs (the build pins it as well)', () => {
    expect(EVERY_BLOCK_IS_IN_THE_CATALOG).toBe(true);
    expect(EVERY_KEY).toHaveLength(PLATFORMS.length * 5 + 1);
    for (const key of EVERY_KEY) {
      expect(Object.hasOwn(en, key), key).toBe(true);
      expect(Object.hasOwn(fa, key), key).toBe(true);
    }
    const blocksInCatalog = Object.keys(en).filter((key) => key.startsWith('instructions.'));
    expect(blocksInCatalog.sort()).toEqual([...EVERY_KEY].sort());
  });
});

describe('the instruction blocks', () => {
  it.each(LOCALES)('stay within INSTRUCTION_BLOCK_MAX_LENGTH characters in %s, so the bilingual post fits', (locale) => {
    for (const key of EVERY_KEY) expect([...textOf(locale, key)].length, key).toBeLessThanOrEqual(INSTRUCTION_BLOCK_MAX_LENGTH);
  });

  it.each(LOCALES)('link only to TRUSTED_HELP_HOSTS in %s, and name no account', (locale) => {
    for (const key of EVERY_KEY) expect(outgoingLinkProblems(textOf(locale, key), []), key).toEqual([]);
  });

  it('link the privacy and impersonation forms the reference pages name', () => {
    const links = (key: InstructionKey) => linksIn(textOf('en', key)).map((link) => link.text);
    expect(links('instructions.instagram.private-information')).toContain('https://help.instagram.com/contact/512241091300432');
    expect(links('instructions.tiktok.private-information')).toContain('https://www.tiktok.com/legal/report/privacy');
    expect(links('instructions.facebook.private-information')).toContain('https://www.facebook.com/help/1561472897490627');
    expect(links('instructions.x.impersonation')).toContain('https://help.x.com/forms/authenticity');
    for (const platform of PLATFORMS) expect(links(instructionKey(platform, 'child_safety'))).toContain('https://report.cybertip.org/');
  });

  it('never promise removal, and ask for one report in the member\'s own words', () => {
    for (const key of EVERY_KEY) {
      const text = textOf('en', key);
      expect(text, key).not.toMatch(/will be (?:removed|deleted|taken down)|(?<!not )guarantees? (?:its |the )?removal/i);
      expect(text, key).toMatch(/own words/);
      expect(text, key).toMatch(/once|repeat/i);
    }
  });

  it("send the member to Telegram's own search, never to Start, on every Telegram block", () => {
    for (const category of POSTED.filter((posted) => posted !== 'other')) {
      const key = instructionKey('telegram', category);
      expect(textOf('en', key), key).toMatch(/Telegram's own search/);
      expect(textOf('en', key), key).toMatch(/Never press Start/);
      expect(textOf('fa', key), key).toMatch(/Start/);
    }
  });

  it('say on intimate images that the post itself is left out', () => {
    for (const platform of PLATFORMS) {
      expect(textOf('en', instructionKey(platform, 'intimate_images'))).toMatch(/post itself is left out of this message on purpose/);
    }
  });

  it('carry a heading and points to make, in Persian too', () => {
    for (const key of EVERY_KEY) {
      expect(textOf('en', key), key).toMatch(/^<b>[^<]+<\/b>\n• /);
      expect(textOf('fa', key), key).toMatch(/^<b>[^<]+<\/b>\n• /);
      expect(textOf('fa', key), key).not.toBe(textOf('en', key));
    }
  });
});

describe('PLATFORM_NAME_KEYS', () => {
  it('names every platform in both locales, as plain text', () => {
    for (const platform of PLATFORMS) {
      for (const locale of LOCALES) {
        const name = t(locale, PLATFORM_NAME_KEYS[platform]);
        expect(name, `${locale} ${platform}`).not.toMatch(/[<>&]/);
        expect(name.trim()).not.toBe('');
      }
    }
    expect(t('en', PLATFORM_NAME_KEYS.instagram)).toBe('Instagram');
    expect(t('en', PLATFORM_NAME_KEYS.other)).toBe('another platform');
  });
});

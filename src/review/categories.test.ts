// Unit tests for the categories and the routing table
// (src/review/categories.ts; critical invariants 3 and 7): the table is
// exactly doc/product/report-categories-and-routing.md's, suspected CSAM
// has no link mode at all, intimate images never the post, and the
// affected-person flag forces the account link for every category.
import { describe, expect, it } from 'vitest';
import { LOCALES, t } from '../i18n/index';
import { CATEGORIES, isCategory, isPostedCategory, LINK_MODES, linkModesFor, ROUTING } from './categories';

describe('the categories', () => {
  it('are the seven of the routing table, in the order intake offers them', () => {
    expect(CATEGORIES).toEqual(['private_data', 'child_safety', 'csam', 'harassment', 'intimate_images', 'impersonation', 'other']);
    expect(LINK_MODES).toEqual(['account', 'post']);
    expect(isCategory('csam')).toBe(true);
    expect(isCategory('spam')).toBe(false);
    expect(isCategory(undefined)).toBe(false);
    expect(isPostedCategory('csam')).toBe(false);
    expect(isPostedCategory('other')).toBe(true);
  });

  it('route as the table says: posted or not, and the link modes, the default first', () => {
    const table = Object.fromEntries(CATEGORIES.map((category) => [category, [ROUTING[category].posted, ROUTING[category].linkModes]]));
    expect(table).toEqual({
      private_data: [true, ['account', 'post']],
      child_safety: [true, ['account', 'post']],
      csam: [false, []],
      harassment: [true, ['account', 'post']],
      intimate_images: [true, ['account']],
      impersonation: [true, ['account', 'post']],
      other: [true, ['account', 'post']],
    });
  });

  it('are frozen, the link modes included', () => {
    expect(Object.isFrozen(ROUTING)).toBe(true);
    for (const category of CATEGORIES) {
      expect(Object.isFrozen(ROUTING[category])).toBe(true);
      expect(Object.isFrozen(ROUTING[category].linkModes)).toBe(true);
    }
  });

  it('carry plain-text labels in both locales, the CSAM one as the reporter sees it', () => {
    for (const category of CATEGORIES) {
      for (const locale of LOCALES) {
        const label = t(locale, ROUTING[category].labelKey);
        expect(label, `${locale} ${category}`).not.toMatch(/[<>&]/);
        expect([...label].length, `${locale} ${category}`).toBeLessThanOrEqual(48);
      }
    }
    expect(t('en', ROUTING.csam.labelKey)).toBe('Sexual content involving a minor');
  });
});

describe('linkModesFor', () => {
  it('offers nothing for suspected CSAM, with or without the flag', () => {
    expect(linkModesFor('csam', false)).toEqual([]);
    expect(linkModesFor('csam', true)).toEqual([]);
  });

  it('offers the account link only when the reporter is the affected person, for every posted category', () => {
    for (const category of CATEGORIES.filter(isPostedCategory)) expect(linkModesFor(category, true), category).toEqual(['account']);
  });

  it("offers the category's own set otherwise: never the post for intimate images", () => {
    expect(linkModesFor('intimate_images', false)).toEqual(['account']);
    expect(linkModesFor('private_data', false)).toEqual(['account', 'post']);
    expect(linkModesFor('other', false)).toEqual(['account', 'post']);
  });

  it('hands out sets no caller can change', () => {
    expect(Object.isFrozen(linkModesFor('harassment', true))).toBe(true);
    expect(Object.isFrozen(linkModesFor('csam', false))).toBe(true);
  });
});

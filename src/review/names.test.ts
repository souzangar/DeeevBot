// Unit tests for the review's names (src/review/names.ts): a plain-text
// name in both locales for every category, status, link mode and reason,
// one for every outcome a target can have had, and the generic one for an
// outcome code this unit does not know.
import { describe, expect, it } from 'vitest';
import { LOCALES, t } from '../i18n/index';
import { REJECT_REASONS } from './callbacks';
import { CATEGORIES, LINK_MODES } from './categories';
import { CATEGORY_NAME_KEYS, MODE_NAME_KEYS, outcomeNameKey, REASON_NAME_KEYS, STATUS_NAME_KEYS } from './names';
import { REPORT_STATUSES } from './reports';

const PLAIN = /^[^<>&"]+$/;

describe('the review names', () => {
  it('name every category, status, link mode and reason in both locales, as plain text', () => {
    const keys = [
      ...CATEGORIES.map((category) => CATEGORY_NAME_KEYS[category]),
      ...REPORT_STATUSES.map((status) => STATUS_NAME_KEYS[status]),
      ...LINK_MODES.map((mode) => MODE_NAME_KEYS[mode]),
      ...REJECT_REASONS.map((reason) => REASON_NAME_KEYS[reason]),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    for (const locale of LOCALES) for (const key of keys) expect(t(locale, key), `${locale} ${key}`).toMatch(PLAIN);
  });

  it("name each outcome a target can have had, and any other code by the generic name", () => {
    for (const code of ['taken_down', 'no_result', 'retracted', 'expired', 'no_decision', 'rejected', 'routed']) {
      expect(outcomeNameKey(code)).toBe(`review.outcome.${code}`);
    }
    for (const code of ['closed', 'something_new', 'toString', '']) expect(outcomeNameKey(code)).toBe('review.outcome.other');
  });
});

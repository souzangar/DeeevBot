// @critical-path
// The report categories and their routing, as data (critical invariants 3
// and 7; doc/product/report-categories-and-routing.md, "Categories" and
// "Routing table"). A reporter picks a category at intake, from the seven
// labels below; the admin confirms or changes it at review, and the
// admin's categorisation is the routing input: the reporter's label is a
// hint only.
//
// What each category's post may carry is its set of link modes:
// - 'account': the account link only;
// - 'post': the account link and the specific post URL, by the admin's
//   explicit opt-in, recorded with the approval.
// The first mode of a set is the default. Suspected CSAM (`csam`, labelled
// for the reporter as "sexual content involving a minor") is never posted:
// its set is empty, so no link mode, and so no approval, exists for it; it
// is routed instead (the routing card, unit U4). Intimate images shared
// without consent carry the account link only, never the post: a rule of
// the table, not a default. The affected-person flag ("I am the affected
// person") forces the account link only, for every category.
//
// Doxxing (Q2) and suspected CSAM (Q1, rule 7) are decisions of the owner,
// not amendable here without a new decision.
import type { PlainMessageKey } from '../i18n/index';

/** The categories, in the order the intake keyboard offers them. */
export const CATEGORIES = [
  'private_data',
  'child_safety',
  'csam',
  'harassment',
  'intimate_images',
  'impersonation',
  'other',
] as const;
export type Category = (typeof CATEGORIES)[number];

/** The categories whose approved reports are posted: every one but suspected CSAM. */
export type PostedCategory = Exclude<Category, 'csam'>;

/** What a post may carry: the account link, or the account link and the post URL. */
export const LINK_MODES = ['account', 'post'] as const;
export type LinkMode = (typeof LINK_MODES)[number];

export interface CategoryRoute {
  /** Whether an approved report of the category is posted to the channel at all. */
  readonly posted: boolean;
  /** The link modes an admin may pick, the default first; empty when nothing is posted. */
  readonly linkModes: readonly LinkMode[];
  /** The reporter's label at intake: a button text, so plain text without markup. */
  readonly labelKey: PlainMessageKey;
}

const route = (posted: boolean, linkModes: readonly LinkMode[], labelKey: PlainMessageKey): CategoryRoute =>
  Object.freeze({ posted, linkModes: Object.freeze([...linkModes]), labelKey });

/** The routing table of doc/product/report-categories-and-routing.md. */
export const ROUTING: Readonly<Record<Category, CategoryRoute>> = Object.freeze({
  private_data: route(true, ['account', 'post'], 'category.private_data'),
  child_safety: route(true, ['account', 'post'], 'category.child_safety'),
  csam: route(false, [], 'category.csam'),
  harassment: route(true, ['account', 'post'], 'category.harassment'),
  intimate_images: route(true, ['account'], 'category.intimate_images'),
  impersonation: route(true, ['account', 'post'], 'category.impersonation'),
  other: route(true, ['account', 'post'], 'category.other'),
});

export const isCategory = (value: unknown): value is Category =>
  typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value);

export const isPostedCategory = (value: unknown): value is PostedCategory => isCategory(value) && ROUTING[value].posted;

const ACCOUNT_ONLY: readonly LinkMode[] = Object.freeze(['account']);
const NOTHING: readonly LinkMode[] = Object.freeze([]);

/**
 * The link modes an admin may pick for a report of `category`, the default
 * first: none for suspected CSAM, whatever the flag; the account link only
 * when the reporter is the affected person; the category's own set
 * otherwise.
 */
export function linkModesFor(category: Category, affectedPerson: boolean): readonly LinkMode[] {
  const { posted, linkModes } = ROUTING[category];
  if (!posted) return NOTHING;
  return affectedPerson ? ACCOUNT_ONLY : linkModes;
}

// okf.config.mjs — THE project manifest for the div-report OKF docs bundle.
// Every gate script imports this file (resolved relative to the scripts, so
// the gates can run from the repo root regardless of where node is invoked).
export default {
  // Must be EXPLICITLY false — leaving it true, deleting the line, or
  // misspelling it all keep the gates refusing to run.
  template: false,

  okfVersion: '0.1',

  // Bundle root, relative to the repository root (gates run from repo root).
  // Keep in sync with DOC_ROOT in .claude/hooks/okf-guard.sh.
  docRoot: 'doc',

  // Directory names to skip entirely (raw exports, image dumps, site output).
  skipDirs: ['assets-raw', '.okf-site'],

  // Files with NO frontmatter: generated indexes and logs. The root index may
  // carry `okf_version` only.
  reservedFiles: ['index.md', 'log.md'],

  // Conventions doc filename at the bundle root (linked from the root index).
  conventionsFile: 'okf-conventions.md',

  // Root index heading and README stub.
  bundleTitle: 'div-report Knowledge Bundle (OKF)',
  readmeStub: {
    enabled: true,
    title: 'div-report Documentation',
    description: 'Entry point for the div-report docs bundle; start at index.md.',
  },

  // File extensions the prose-reference checker treats as bundle files, and
  // asset extensions excluded from basename resolution.
  refExtensions: ['md', 'json', 'html'],
  assetExcludeExts: ['.png', '.jpg', '.jpeg', '.gif', '.svg'],

  // Frontmatter `status` value that means "current" (anything else is tagged
  // in the generated listings).
  activeStatus: 'active',

  // Domain folders: name -> one-line description. Insertion order here IS
  // the order in the root index's Domains section. A folder on disk that is
  // not listed here indexes after these, alphabetically, with a warning —
  // add it here in the same change that creates it.
  folders: {
    product: 'What the bot does: the brief, user flows, report lifecycle, moderation policy.',
    architecture: 'System design, data model, and decision records.',
    guides: 'How-to guides and runbooks: operating the bot, admin procedures.',
    reference: 'External contracts and lookup material: Telegram Bot API notes, per-platform reporting instructions.',
    audits: 'Dated findings of reviews and security audits.',
    archive: 'Retired / superseded docs, kept for reference.',
  },

  // Pinned "Rules & Invariants" at the top of the root index. Entries are
  // docRoot-relative paths (preferred) or bare basenames (must be unique in
  // the bundle). A missing or ambiguous entry FAILS the build.
  rulesAndInvariants: [
    'architecture/critical-invariants.md',
    'product/threat-model-seizure.md',
    'product/retention-and-minimisation.md',
    'product/broadcast-consent-policy.md',
  ],
};

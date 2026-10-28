---
type: reference
title: "OKF Conventions"
description: "House profile for the div-report docs bundle: frontmatter fields, type vocabulary, naming, archive policy."
status: active
tags: [docs, conventions]
---

# OKF Conventions

This folder is an **Open Knowledge Format (OKF)** bundle. Every concept doc
lives under a domain folder and carries YAML frontmatter. Indexes
(`index.md` files and `README.md`) are **generated** by
`scripts/okf/build-index.mjs` — never edit them by hand; regenerate and
commit them.

## Frontmatter

```yaml
---
type: rule                 # REQUIRED — vocabulary below
title: "Human title"
description: "One-sentence summary; shown in generated index listings."
status: active             # active | deferred | archived | superseded
tags: [domain, topic]
timestamp: 2026-01-01T00:00:00Z
---
```

## `type` vocabulary

Authoritative list — extend it here before using a new value:

- `rule` — a binding invariant; read before touching the code path it names.
- `guide` — how-to material.
- `reference` — lookup material and external contracts (Telegram Bot API
  notes, per-platform reporting instructions).
- `runbook` — operational procedure (moderation, incident handling, deploys).
- `spec` — product or feature specification, including the project brief.
- `adr` — architecture decision record.
- `audit` — findings of a review or security audit, dated.

## Domain folders

`product/`, `architecture/`, `guides/`, `reference/`, `audits/`, `archive/`.
Their one-line descriptions live in `folders` in `scripts/okf/okf.config.mjs`;
a new folder is added there in the same change that creates it.

## Naming & structure

- Name files by **topic** (`broadcast-delivery-ledger.md`), never by team or
  channel prefix; audience belongs in frontmatter if it is ever needed.
- Dated audits prefix the filename with the date (`2026-10-28-...`).
- One H1 at the top of the body; structural markdown below.

## Lifecycle

- Retiring a doc → move it to `archive/` with `status: archived`. Never
  delete — history is part of the bundle.
- Binding rules worth pinning at the top of the root index go into
  `rulesAndInvariants` in the config (docRoot-relative paths preferred).

## The gate

```bash
node scripts/okf/build-index.mjs   # after adding/moving/retitling docs
node scripts/okf/check.mjs         # the full gate — CI should run this too
```

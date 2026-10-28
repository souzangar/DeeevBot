---
type: adr
title: "ADR 0005: Error-handling convention"
description: "One typed AppError shape, one code catalog mapped to i18n keys, a grammY boundary that never leaks report data, a classification of Telegram API errors, nothing swallowed, and the regression tests that pin it."
status: active
tags: [architecture, adr, errors, logging, grammy]
timestamp: 2026-10-28T00:00:00Z
---

# ADR 0005: Error-handling convention

## Context

Q9 of [Planning decisions](../product/planning-decisions-2026-10-28.md).
AGENTS.md and the critics' prompts judge work against "error-handling
rules" that CLAUDE.md's "Error handling" section did not define; the text
of this decision fills that section in the same change as this record. Catastrophic invariants 4
and 6 constrain the design: report data never reaches logs, and the
hosting platform's invocation logs count as logs.

## Decision

- Error surface shape. Every error leaves the system as one typed
  `AppError` with `code`, `message` (internal, never containing report
  data), optional `cause`, optional `userMessageKey`, and `retryable`.
  Never an ad-hoc string or a raw exception from a lower layer.
- Where codes live. Codes are registered in one catalog,
  `src/errors/catalog.ts`; each code maps to an i18n key for the
  user-facing text; throw sites never invent codes.
- Boundary. A grammY error middleware maps an `AppError` to a localised
  reply. An unknown error gets a generic reply and a log line with the
  error class only, never the update payload and never a GrammyError
  payload. The webhook handler acknowledges Telegram with 200 after
  handling so Telegram does not redeliver.
- Telegram API errors are classified. 429 persists progress and
  reschedules the broadcast step for now plus `retry_after`, with no
  in-invocation retry burst. 403 "bot was blocked by the user", 400 "chat
  not found" and "user is deactivated" unsubscribe the user and are not
  errors. 5xx and network errors retry with bounded backoff, then are
  recorded as a failed delivery.
- Nothing is swallowed. No empty `catch`; no log-and-continue on a
  failure that changes state. Broadcast failures are recorded per
  recipient and never abort the batch. A storage failure, a daily-cap
  error included, stops the broadcast in a resumable state, reschedules
  the step for 00:05 UTC plus jitter, and alerts the admin chat once.
- Tests. Every code path that maps an error has a unit test. "The
  boundary never leaks a URL or an id" is a regression test with a real
  GrammyError, whose payload carries the outgoing text and chat id.

## Consequences

- CLAUDE.md's "Error handling" section is filled from this text in the
  same commit as the docs and rules (round-2 suggestion S3 in the
  [planning review](../audits/2026-10-28-planning-review.md)).
- The redacting logger lives in `src/privacy/` and is the only logger;
  the Phase 2 tripwire patterns `console.(log|error|warn)(` in `src/` and
  `JSON.stringify((err|error|e))` catch the bypasses
  ([ADR 0006](./adr-0006-data-model-and-module-layout.md)).
- The i18n catalogs are the only source of user-facing text, so a new
  code needs a key in both `fa` and `en`.
- The broadcast engine's classification of Telegram errors is the same on
  Cloudflare and on the Node port
  ([ADR 0004](./adr-0004-storage-and-delivery-ledger.md)).

## Alternatives considered

- An RFC 9457 problem document or an error envelope with a stable code:
  the bot exposes no HTTP API of its own beyond the webhook endpoint,
  which only ever answers Telegram, so a typed class with a catalog gives
  the same single shape without an HTTP vocabulary.
- Retrying 429 within the invocation: rejected, see ADR 0004.
- Treating 403 and 400 send failures as errors to retry: rejected; they
  are consent and reachability signals and unsubscribe the user
  ([Broadcast consent policy](../product/broadcast-consent-policy.md)).
- Logging the failing update for diagnosis: rejected; the update carries
  the reporter's id and the URL, which invariant 6 keeps out of logs.

## Status

Accepted 2026-10-28.

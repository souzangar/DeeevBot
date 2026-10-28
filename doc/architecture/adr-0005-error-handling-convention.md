---
type: adr
title: "ADR 0005: Error-handling convention"
description: "One typed AppError shape, one code catalog mapped to i18n keys, a grammY boundary that never leaks report data, the classification of Telegram API failures into unambiguous ones (retried by reverting the post's claim) and ambiguous ones (never re-sent), the cap contract without a 00:05 reschedule, nothing swallowed, and the regression tests that pin it."
status: active
tags: [architecture, adr, errors, logging, grammy]
timestamp: 2026-10-28T00:00:00Z
---

# ADR 0005: Error-handling convention

## Context

Q9 of [Planning decisions](../product/planning-decisions-2026-10-28.md).
AGENTS.md and the critics' prompts judge work against "error-handling
rules" that CLAUDE.md's "Error handling" section did not define; the text
of this decision fills that section in the same change as this record.
Catastrophic invariants 4 and 6 constrain the design: report data never
reaches logs, and the hosting platform's invocation logs count as logs.
The scope reduction of the evening of 2026-10-28
([Threat model: seizure](../product/threat-model-seizure.md)) removed the
direct-message fan-out and with it the per-recipient failure handling;
what remains is one post per report, which must never be sent twice, and
the edits of that post.

## Decision

- Error surface shape. Every error leaves the system as one typed
  `AppError` with `code`, `message` (internal, never containing report
  data), optional `cause`, optional `userMessageKey`, and `retryable`.
  Never an ad-hoc string or a raw exception from a lower layer.
- Where codes live. Codes are registered in one catalog,
  `src/errors/catalog.ts`; each code maps to an i18n key for the
  user-facing text; throw sites never invent codes. An entry is
  `retryable` only where the failure provably did nothing
  (`TELEGRAM_RATE_LIMITED`); `TELEGRAM_TRANSIENT` is marked `ambiguous`
  ("Telegram may have accepted the request; never retried blindly") and is
  not retryable, so a job runner keyed on `retryable` can never re-send a
  timed-out post; the catalog test pins that no entry is both.
- Boundary. A grammY error middleware maps an `AppError` to a localised
  reply. An unknown error gets a generic reply and a log line with the
  error class only, never the update payload and never a GrammyError
  payload. The webhook handler acknowledges Telegram with 200 after
  handling so Telegram does not redeliver.
- Telegram API failures on a send are classified by whether Telegram
  provably did not accept the message. Unambiguous (Telegram answered and
  refused): a 429 reverts a post's claim (`posting` back to `approved`,
  `posting_started_at` cleared) in the same batch that reschedules the
  job for now plus `retry_after` and sets `meta.paused_until`, which
  every job send honours (a handler's single reply is not paused; a 429
  there is logged); a 400 or 403 (no post rights, chat not found) reverts
  the claim the same way, abandons the job, sets `needs_attention` and
  alerts the keyholders. Ambiguous (no answer, or one that may have
  followed an accepted send): a timeout, a network error or a 5xx on a
  send is never retried; the report stays `posting` without a message id
  and is alerted once, and a human resolves it with `/attach` or
  `/repost` ([Report lifecycle](../product/report-lifecycle.md)). The
  same holds for an invocation that dies between the send and the write
  that records it: reconciliation alerts, never re-sends.
- Edit failures. "Message is not modified" and "message to edit not
  found" are non-errors. Any other failure of a closure or retraction
  edit, past its bound, leaves the report in `closing` or `retracting`
  with its message id and correction intact, sets `needs_attention` and
  alerts; nothing is finalized while the post is unaddressed.
- The cap contract. A cron run that meets a Free-plan cap error stops
  without writing; the next minute's run picks the due work up again once
  the 00:00 UTC reset has passed, and the keyholders are alerted once.
  There is no reschedule to a fixed time of day. A cap error between a
  post's send and its id write is the ambiguous case above.
- Nothing is swallowed. No empty `catch`; no log-and-continue on a
  failure that changes state. The tick isolates failures per job: one
  failed job never stops the others, and each failure is recorded on its
  row (`attempts`, `needs_attention`) and alerted once (`alert_sent_at`).
  A failed keyholder alert is logged by class and retried by the next
  reconciliation, never dropped. A failed deletion of a reporter's
  message is retried once, then surfaced in the reply and logged by class.
- Tests. Every code path that maps an error has a unit test. "The
  boundary never leaks a URL or an id" is a regression test with a real
  GrammyError, whose payload carries the outgoing text and chat id. A 429
  reschedules without re-sending; a timed-out send is never re-sent; a
  cap error leaves the store unchanged.

## Consequences

- CLAUDE.md's "Error handling" section was filled from this text in the
  same commit as the docs and rules (round-2 suggestion S3 in the
  [planning review](../audits/2026-10-28-planning-review.md)) and is
  amended for the two failure classes in the same commit as this
  amendment: no retry of a timeout, a network error or a 5xx on a send,
  and no 00:05 UTC reschedule.
- The redacting logger lives in `src/privacy/` and is the only logger;
  eslint's `no-console` fails the build on any `console` call in `src/`,
  and the tripwire flags `console.*(` and `JSON.stringify(` of an error,
  a context or an update on the critical paths
  ([ADR 0006](./adr-0006-data-model-and-module-layout.md)).
- The i18n catalogs are the only source of user-facing text, so a new
  code needs a key in both `fa` and `en`.
- The classification of Telegram errors is the same on Cloudflare and on
  the Node port ([ADR 0004](./adr-0004-storage-and-delivery-ledger.md)).

## Alternatives considered

- An RFC 9457 problem document or an error envelope with a stable code:
  the bot exposes no HTTP API of its own beyond the webhook endpoint,
  which only ever answers Telegram, so a typed class with a catalog gives
  the same single shape without an HTTP vocabulary.
- Retrying 429 within the invocation: rejected, see ADR 0004.
- Retrying a timed-out, network-failed or 5xx send with bounded backoff
  (the first version of this record): rejected; Telegram may have
  accepted the send, and a second send is a second post that cannot be
  retracted as one. The human path with `/attach` and `/repost` replaces
  it.
- Rescheduling a cap-hit step for 00:05 UTC plus jitter (the first
  version): rejected with the fan-out it served; the minute cron picks
  the work up after the reset by itself.
- Logging the failing update for diagnosis: rejected; the update carries
  the reporter's id and the URL, which invariant 6 keeps out of logs.

## Status

Accepted 2026-10-28.

Amended 2026-10-28 (evening, the seizure threat): the two failure
classes, the edit failures, the cap contract, per-job isolation in the
tick.

Amended 2026-10-28 (Phase 3, unit U2, from the domain audit): the
catalog's `ambiguous` marker on `TELEGRAM_TRANSIENT`, which is no longer
`retryable`.

// @critical-path
// The Worker entry (doc/architecture/adr-0001-runtime-and-hosting.md): the
// HTTP handler and the cron handler. Phase 2 scaffold, no logic: the webhook
// route with its secret-token check arrives in Phase 3 (ADR 0003), the cron
// that drains the jobs table in D1 with the scheduling unit (ADR 0004,
// ADR 0006).

/** The bindings declared in wrangler.jsonc. Secrets are read through src/config/. */
export interface Env {
  readonly DB: D1Database;
}

const worker = {
  // Every request is answered 404 until the webhook route lands (Phase 3).
  fetch: (): Response => new Response(null, { status: 404 }),
  // Phase 3: the one-minute job cron and the nightly retention job.
  scheduled: (): void => undefined,
} satisfies ExportedHandler<Env>;

export default worker;

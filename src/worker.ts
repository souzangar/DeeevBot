// @critical-path
// The Worker entry (doc/architecture/adr-0001-runtime-and-hosting.md): the
// HTTP handler, the cron handler and the broadcaster Durable Object class.
// Phase 2 scaffold, no logic: the webhook route with its secret-token check
// arrives in Phase 3 (ADR 0003), the cron jobs and the broadcast engine with
// the data model (ADR 0004, ADR 0006).
import { DurableObject } from 'cloudflare:workers';

/** The bindings declared in wrangler.jsonc. Secrets are read through src/config/. */
export interface Env {
  readonly DB: D1Database;
  readonly BROADCASTER: DurableObjectNamespace<Broadcaster>;
}

/**
 * The broadcaster (ADR 0004): one Durable Object whose alarms drive the
 * broadcast step. Empty until Phase 3; it exists so that the BROADCASTER
 * binding and the v1 SQLite migration resolve.
 */
export class Broadcaster extends DurableObject<Env> {
  override alarm(): void {
    // Phase 3: the broadcast step() runs here.
  }
}

const worker = {
  // Every request is answered 404 until the webhook route lands (Phase 3).
  fetch: (): Response => new Response(null, { status: 404 }),
  // Phase 3: the nightly retention job and the stall detector.
  scheduled: (): void => undefined,
} satisfies ExportedHandler<Env>;

export default worker;

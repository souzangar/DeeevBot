// Workers-tier smoke test: boots src/worker.ts inside the Workers runtime
// through @cloudflare/vitest-plugin, with the D1 and Durable Object
// bindings from wrangler.jsonc, and checks the Phase 2 contract: every
// request is answered 404 until the webhook route lands in Phase 3.
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('worker entry', () => {
  it.each([
    ['GET', 'https://div-report.test/'],
    ['POST', 'https://div-report.test/webhook'],
  ])('answers %s %s with 404', async (method, url) => {
    const response = await SELF.fetch(url, { method });
    expect(response.status).toBe(404);
    await response.body?.cancel();
  });
});

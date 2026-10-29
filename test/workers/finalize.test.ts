// Workers tier: finalization (src/broadcast/finalize.ts; critical invariant
// 8) on the local D1 that miniflare runs, the engine the batch ships on: the
// conclusion of a closing report and its finalization in one D1 batch (the
// aggregate row upserted from a join, its days computed by SQLite's date(),
// the approval, prompt, job and merged row deleted through subqueries,
// every personal field nulled), nothing done to a report in another state,
// and the set-based finalization of rejected and routed rows with a
// rejection counted off its reference. The rows, ids and message ids are
// this file's own, so it shares the database with the others safely.
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { CONCLUDE_STATUS_STATEMENT, concludeStatements, finalizationStatements, rejectionDecayStatement } from '../../src/broadcast/finalize';
import { d1SqlDb } from '../../src/db/d1';
import { sql } from '../../src/db/sql';

const db = d1SqlDb(env.DB);
const NOW = Date.UTC(2027, 3, 20, 10, 0);
const CREATED = Date.UTC(2027, 0, 15, 9, 0);
const APPROVED = Date.UTC(2027, 0, 16, 9, 0);
const REF = 'd'.repeat(64);
const HASH = 'e'.repeat(64);

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe('finalization on D1', () => {
  it('concludes a closing report and finalizes it in one batch', async () => {
    const id = 'workersfinalizezzzzz';
    const merged = 'workersfinalmergedzz';
    const postMessageId = 991_001;
    await db.run(
      sql`INSERT INTO reports (id, status, platform, category, url, account_url, reporter_ref, link_hash, created_at, broadcast_text, link_mode, card_message_id, status_message_id, posting_started_at, posted_at, post_message_id, presses) VALUES (?, 'posted', 'x', 'harassment', 'https://x.com/someone/status/1', 'https://x.com/someone', ?, ?, ?, 'the post', 'account', 991002, 991003, ?, ?, ?, 12)`,
      [id, REF, HASH, CREATED, APPROVED + 60_000, APPROVED + 60_000, postMessageId],
    );
    await db.run(
      sql`INSERT INTO approvals (report_id, approval_id, admin_id, approved_at, link_mode, recommended_comment, starts_at) VALUES (?, 'workersfinalapproval', 424240011, ?, 'account', 'say it', ?)`,
      [id, APPROVED, APPROVED + 60_000],
    );
    await db.run(sql`UPDATE reports SET status = 'closing', outcome = 'taken_down' WHERE id = ?`, [id]);
    await db.run(sql`INSERT INTO admin_prompts (chat_id, prompt_message_id, admin_id, report_id, kind, created_at) VALUES (-1004242400041, 991004, 424240011, ?, 'retraction', ?)`, [id, NOW]);
    await db.run(sql`INSERT INTO jobs (id, kind, report_id, due_at, payload, attempts, created_at) VALUES ('workersfinaljobzzzzz', 'edit', ?, ?, '{"action":"close"}', 0, ?)`, [id, NOW, NOW]);
    await db.run(sql`INSERT INTO reports (id, status, platform, category, url, reporter_ref, link_hash, merged_into, created_at) VALUES (?, 'merged', 'x', 'harassment', 'https://x.com/someone/status/1', ?, ?, ?, ?)`, [merged, REF, HASH, id, CREATED]);

    const results = await db.batch(concludeStatements({ from: 'closing', to: 'closed', reportId: id, postMessageId, now: NOW }));
    expect(results[CONCLUDE_STATUS_STATEMENT]?.changes).toBe(1);
    expect(await db.first(sql`SELECT * FROM stats WHERE report_id = ?`, [id])).toEqual({
      report_id: id,
      category: 'harassment',
      platform: 'x',
      created_day: '2027-01-15',
      decided_day: '2027-01-16',
      closed_day: '2027-04-20',
      outcome: 'taken_down',
      presses: 12,
      link_hash: HASH,
    });
    expect(
      await db.first(
        sql`SELECT status, url, account_url, reporter_ref, link_hash, broadcast_text, link_mode, card_message_id, status_message_id, post_message_id, closed_at, data_deleted_at FROM reports WHERE id = ?`,
        [id],
      ),
    ).toEqual({
      status: 'closed',
      url: null,
      account_url: null,
      reporter_ref: null,
      link_hash: null,
      broadcast_text: null,
      link_mode: null,
      card_message_id: null,
      status_message_id: null,
      post_message_id: null,
      closed_at: NOW,
      data_deleted_at: NOW,
    });
    for (const table of [
      sql`SELECT count(*) AS n FROM approvals WHERE report_id = ?`,
      sql`SELECT count(*) AS n FROM admin_prompts WHERE report_id = ?`,
      sql`SELECT count(*) AS n FROM jobs WHERE report_id = ?`,
      sql`SELECT count(*) AS n FROM reports WHERE merged_into = ?`,
    ]) {
      expect(await db.first(table, [id])).toEqual({ n: 0 });
    }
    // A second batch changes nothing.
    const again = await db.batch(concludeStatements({ from: 'closing', to: 'closed', reportId: id, postMessageId, now: NOW + 1 }));
    expect(again.map((result) => result.changes)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it('finalizes rejected and routed rows in one set-based batch, a rejection counted off its reference', async () => {
    const rejected = 'workersrejectedzzzzz';
    const routed = 'workersroutedzzzzzzz';
    const ref = 'f'.repeat(64);
    for (const [id, status] of [
      [rejected, 'rejected'],
      [routed, 'routed'],
    ] as const) {
      await db.run(
        sql`INSERT INTO reports (id, status, platform, category, url, reporter_ref, link_hash, created_at, decided_at, decided_by) VALUES (?, ?, 'instagram', 'private_data', 'https://www.instagram.com/someone/', ?, ?, ?, ?, 424240012)`,
        [id, status, ref, HASH, CREATED, Date.UTC(2027, 1, 1, 12)],
      );
    }
    await db.run(sql`INSERT INTO reporter_stats (reporter_ref, rejections_30d, last_seen) VALUES (?, 3, '2027-04-01') ON CONFLICT (reporter_ref) DO UPDATE SET rejections_30d = 3`, [ref]);
    await db.batch([rejectionDecayStatement(rejected), ...finalizationStatements([rejected, routed], NOW, ['rejected', 'routed'])]);
    expect(await db.all(sql`SELECT report_id, decided_day, outcome FROM stats WHERE report_id IN (?, ?) ORDER BY report_id`, [rejected, routed])).toEqual([
      { report_id: rejected, decided_day: '2027-02-01', outcome: 'rejected' },
      { report_id: routed, decided_day: '2027-02-01', outcome: 'routed' },
    ]);
    expect(await db.all(sql`SELECT id, reporter_ref, decided_by, data_deleted_at FROM reports WHERE id IN (?, ?) ORDER BY id`, [rejected, routed])).toEqual([
      { id: rejected, reporter_ref: null, decided_by: null, data_deleted_at: NOW },
      { id: routed, reporter_ref: null, decided_by: null, data_deleted_at: NOW },
    ]);
    expect(await db.first(sql`SELECT rejections_30d FROM reporter_stats WHERE reporter_ref = ?`, [ref])).toEqual({ rejections_30d: 2 });
  });
});

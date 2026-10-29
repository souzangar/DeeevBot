// Rows for the review's SQL-level tests, written straight into a migrated
// database (test/support/database.ts): reports with the fields a test names
// and the rest as the intake writes them, approvals, prompts and the
// reporter counters. Ids have the shape src/db/ids.ts draws; references and
// hashes are 64 hex characters that are no keyed value of anything. Fixture
// values are never secret-shaped.
import { randomId } from '../../src/db/ids';
import { sql, type SqlDb, type SqlValue } from '../../src/db/sql';

/** A 64-hex reference or hash, distinct for each `n`. */
export const hex = (n: number, fill = 'a'): string => n.toString(16).padStart(64, fill);

const REPORT_COLUMNS = [
  'id',
  'status',
  'platform',
  'category',
  'url',
  'account_url',
  'comment',
  'affected_person',
  'reporter_ref',
  'merged_into',
  'link_hash',
  'created_at',
  'decided_at',
  'decided_by',
  'card_message_id',
  'status_message_id',
  'broadcast_text',
  'link_mode',
  'posting_started_at',
  'posted_at',
  'post_message_id',
] as const;
type ReportColumn = (typeof REPORT_COLUMNS)[number];

/** A report row: a pending X report of a post whose account is known, unless `fields` say otherwise. */
export async function insertReport(db: SqlDb, fields: Partial<Record<ReportColumn, SqlValue>> = {}): Promise<string> {
  const id = typeof fields.id === 'string' ? fields.id : randomId();
  const row: Record<ReportColumn, SqlValue> = {
    id,
    status: 'pending',
    platform: 'x',
    category: 'harassment',
    url: 'https://x.com/someone/status/1234567890',
    account_url: 'https://x.com/someone',
    comment: 'a comment of the reporter',
    affected_person: 0,
    reporter_ref: hex(1),
    merged_into: null,
    link_hash: hex(1, 'c'),
    created_at: 1_800_000_000_000,
    decided_at: null,
    decided_by: null,
    card_message_id: 7,
    status_message_id: null,
    broadcast_text: null,
    link_mode: null,
    posting_started_at: null,
    posted_at: null,
    post_message_id: null,
    ...fields,
  };
  // Columns written in a fixed order; the values are bound parameters.
  await db.run(
    sql`INSERT INTO reports (id, status, platform, category, url, account_url, comment, affected_person, reporter_ref, merged_into, link_hash, created_at, decided_at, decided_by, card_message_id, status_message_id, broadcast_text, link_mode, posting_started_at, posted_at, post_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    REPORT_COLUMNS.map((column) => row[column]),
  );
  return id;
}

/** An approval of report `reportId`, un-voided unless `voidedAt` is given; its random id. */
export async function insertApproval(
  db: SqlDb,
  reportId: string,
  fields: { readonly approvalId?: string; readonly adminId?: number; readonly approvedAt?: number; readonly startsAt?: number; readonly voidedAt?: number | null; readonly linkMode?: string } = {},
): Promise<string> {
  const approvalId = fields.approvalId ?? randomId();
  const approvedAt = fields.approvedAt ?? 1_800_000_000_000;
  await db.run(
    sql`INSERT INTO approvals (report_id, approval_id, admin_id, approved_at, link_mode, recommended_comment, starts_at, voided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [reportId, approvalId, fields.adminId ?? 424240011, approvedAt, fields.linkMode ?? 'account', 'say it is harassment', fields.startsAt ?? approvedAt + 1_800_000, fields.voidedAt ?? null],
  );
  return approvalId;
}

/** The reporter counters of reference `ref`, as the intake writes them. */
export async function insertReporterStats(db: SqlDb, ref: string, fields: { readonly rejections?: number; readonly blocked?: number } = {}): Promise<void> {
  await db.run(
    sql`INSERT INTO reporter_stats (reporter_ref, open_count, day, day_count, rejections_30d, blocked, last_seen) VALUES (?, 1, '2027-01-15', 1, ?, ?, '2027-01-15')`,
    [ref, fields.rejections ?? 0, fields.blocked ?? 0],
  );
}

/** The columns of report `id` a test asks for. */
export const reportRow = (db: SqlDb, id: string): Promise<Record<string, SqlValue> | null> =>
  db.first<Record<string, SqlValue>>(sql`SELECT * FROM reports WHERE id = ?`, [id]);

/** Every row of a table, for "nothing else was written" checks. */
export async function snapshot(db: SqlDb): Promise<Record<string, unknown>> {
  return {
    reports: await db.all(sql`SELECT * FROM reports ORDER BY id`),
    approvals: await db.all(sql`SELECT * FROM approvals ORDER BY report_id`),
    admin_prompts: await db.all(sql`SELECT * FROM admin_prompts ORDER BY chat_id, prompt_message_id`),
    jobs: await db.all(sql`SELECT * FROM jobs ORDER BY id`),
    reporter_stats: await db.all(sql`SELECT * FROM reporter_stats ORDER BY reporter_ref`),
    counters: await db.all(sql`SELECT * FROM counters ORDER BY day, key`),
    stats: await db.all(sql`SELECT * FROM stats ORDER BY report_id`),
    drafts: await db.all(sql`SELECT * FROM drafts ORDER BY draft_key`),
    meta: await db.all(sql`SELECT * FROM meta ORDER BY key`),
  };
}

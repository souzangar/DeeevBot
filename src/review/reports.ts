// @critical-path
// The review's reads of a report and its approval (critical invariants 1, 3
// and 8; doc/product/report-lifecycle.md; migrations/0001_init.sql). A row
// is read whole into a typed value and checked: a status, a platform or a
// category outside the schema's sets, or a value of the wrong type, is an
// AppError UNEXPECTED whose message names no value, never a guess.
//
// The reporter is only ever the keyed reference (`reporter_ref`), never an
// id: no column holds one. `comment` and `affected_person` are what the
// intake recorded until the decision nulls them; a null flag is read as
// "unknown", which the approval treats as "affected" (account link only),
// so a report whose flag a cancelled approval cleared is never posted with
// more than its account link.
//
// priorOutcome() is the "previously reported, outcome X" of the review
// card: the latest outcome of another report of the same target, by the
// keyed link hash, from the aggregate rows (`stats`, written at
// finalization) and from the decided reports not yet finalized (rejected,
// routed, closed, retracted, expired), so a target rejected yesterday shows
// as such today. The reporter is never told.
import { utcDay } from '../clock';
import { sql, type SqlDb, type SqlValue } from '../db/sql';
import { AppError } from '../errors/app-error';
import { isPlatform, type Platform } from '../platforms/platforms';
import { isCategory, LINK_MODES, type Category, type LinkMode } from './categories';

/** The statuses of the schema (migrations/0001_init.sql). */
export const REPORT_STATUSES = [
  'pending',
  'approved',
  'posting',
  'posted',
  'closing',
  'retracting',
  'closed',
  'retracted',
  'expired',
  'rejected',
  'routed',
  'merged',
] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const isReportStatus = (value: unknown): value is ReportStatus =>
  typeof value === 'string' && (REPORT_STATUSES as readonly string[]).includes(value);

/** A report, as the review reads it. */
export interface ReviewReport {
  readonly id: string;
  readonly status: ReportStatus;
  readonly platform: Platform;
  /** The reporter's label until an approval or a routing writes the admin's categorisation. */
  readonly category: Category;
  /** The reported link, normalised; null once deleted. */
  readonly url: string | null;
  /** The account's link, normalised; null when nobody gave it yet, and once deleted. */
  readonly accountUrl: string | null;
  readonly comment: string | null;
  /** The "I am the affected person" flag; null once a decision cleared it. */
  readonly affectedPerson: boolean | null;
  /** The keyed reporter reference; never an id. */
  readonly reporterRef: string | null;
  readonly mergedInto: string | null;
  readonly linkHash: string | null;
  readonly createdAt: number;
  readonly cardMessageId: number | null;
  readonly statusMessageId: number | null;
}

/** A report's approval record (critical invariant 1). */
export interface ApprovalRecord {
  readonly reportId: string;
  readonly approvalId: string;
  /** The approving admin's numeric id: an allowlisted admin's own, never shown to anyone. */
  readonly adminId: number;
  readonly approvedAt: number;
  readonly linkMode: LinkMode;
  readonly recommendedComment: string;
  readonly startsAt: number;
  readonly voidedAt: number | null;
}

interface ReportRow {
  readonly id: SqlValue;
  readonly status: SqlValue;
  readonly platform: SqlValue;
  readonly category: SqlValue;
  readonly url: SqlValue;
  readonly account_url: SqlValue;
  readonly comment: SqlValue;
  readonly affected_person: SqlValue;
  readonly reporter_ref: SqlValue;
  readonly merged_into: SqlValue;
  readonly link_hash: SqlValue;
  readonly created_at: SqlValue;
  readonly card_message_id: SqlValue;
  readonly status_message_id: SqlValue;
}

interface ApprovalRow {
  readonly report_id: SqlValue;
  readonly approval_id: SqlValue;
  readonly admin_id: SqlValue;
  readonly approved_at: SqlValue;
  readonly link_mode: SqlValue;
  readonly recommended_comment: SqlValue;
  readonly starts_at: SqlValue;
  readonly voided_at: SqlValue;
}

const READ_REPORT = sql`SELECT id, status, platform, category, url, account_url, comment, affected_person, reporter_ref, merged_into, link_hash, created_at, card_message_id, status_message_id FROM reports WHERE id = ?`;
const READ_APPROVAL = sql`SELECT report_id, approval_id, admin_id, approved_at, link_mode, recommended_comment, starts_at, voided_at FROM approvals WHERE report_id = ?`;
const SET_CARD = sql`UPDATE reports SET card_message_id = ? WHERE id = ? AND status = 'pending'`;
const SET_STATUS_CARD = sql`UPDATE reports SET status_message_id = ? WHERE id = ? AND status = 'approved'`;
const SET_ACCOUNT = sql`UPDATE reports SET account_url = ? WHERE id = ? AND status = 'pending' AND account_url IS NULL`;
const PRIOR_STATS = sql`SELECT outcome, COALESCE(closed_day, decided_day, created_day) AS day FROM stats WHERE link_hash = ? AND report_id <> ? ORDER BY day DESC, report_id LIMIT 1`;
const PRIOR_REPORTS = sql`SELECT status, outcome, COALESCE(decided_at, created_at) AS at FROM reports WHERE link_hash = ? AND id <> ? AND status IN ('rejected', 'routed', 'closed', 'retracted', 'expired') ORDER BY at DESC, id LIMIT 1`;

const corrupt = (table: string): AppError => new AppError('UNEXPECTED', `a ${table} row holds a value outside its type`);

const text = (value: SqlValue, table: string): string | null => {
  if (value === null || typeof value === 'string') return value;
  throw corrupt(table);
};
const integer = (value: SqlValue, table: string): number | null => {
  if (value === null || (typeof value === 'number' && Number.isSafeInteger(value))) return value;
  throw corrupt(table);
};
const required = <T>(value: T | null, table: string): T => {
  if (value === null) throw corrupt(table);
  return value;
};

function toReport(row: ReportRow): ReviewReport {
  const { id, status, platform, category, affected_person: affected } = row;
  if (typeof id !== 'string' || !isReportStatus(status) || !isPlatform(platform) || !isCategory(category)) {
    throw corrupt('reports');
  }
  if (affected !== null && affected !== 0 && affected !== 1) throw corrupt('reports');
  return {
    id,
    status,
    platform,
    category,
    url: text(row.url, 'reports'),
    accountUrl: text(row.account_url, 'reports'),
    comment: text(row.comment, 'reports'),
    affectedPerson: affected === null ? null : affected === 1,
    reporterRef: text(row.reporter_ref, 'reports'),
    mergedInto: text(row.merged_into, 'reports'),
    linkHash: text(row.link_hash, 'reports'),
    createdAt: required(integer(row.created_at, 'reports'), 'reports'),
    cardMessageId: integer(row.card_message_id, 'reports'),
    statusMessageId: integer(row.status_message_id, 'reports'),
  };
}

function toApproval(row: ApprovalRow): ApprovalRecord {
  const linkMode = row.link_mode;
  if (typeof linkMode !== 'string' || !(LINK_MODES as readonly string[]).includes(linkMode)) throw corrupt('approvals');
  return {
    reportId: required(text(row.report_id, 'approvals'), 'approvals'),
    approvalId: required(text(row.approval_id, 'approvals'), 'approvals'),
    adminId: required(integer(row.admin_id, 'approvals'), 'approvals'),
    approvedAt: required(integer(row.approved_at, 'approvals'), 'approvals'),
    linkMode: linkMode as LinkMode,
    recommendedComment: required(text(row.recommended_comment, 'approvals'), 'approvals'),
    startsAt: required(integer(row.starts_at, 'approvals'), 'approvals'),
    voidedAt: integer(row.voided_at, 'approvals'),
  };
}

/** Report `id`, or null when there is none. */
export async function readReport(db: SqlDb, id: string): Promise<ReviewReport | null> {
  const row = await db.first<ReportRow>(READ_REPORT, [id]);
  return row === null ? null : toReport(row);
}

/** The approval record of report `reportId`, voided or not, or null when there is none. */
export async function readApproval(db: SqlDb, reportId: string): Promise<ApprovalRecord | null> {
  const row = await db.first<ApprovalRow>(READ_APPROVAL, [reportId]);
  return row === null ? null : toApproval(row);
}

/** The approval record of report `reportId` when it is un-voided, else null. */
export async function liveApproval(db: SqlDb, reportId: string): Promise<ApprovalRecord | null> {
  const approval = await readApproval(db, reportId);
  return approval === null || approval.voidedAt !== null ? null : approval;
}

/** Records the review card's message id on a pending report; true when it did. */
export async function setCardMessage(db: SqlDb, reportId: string, messageId: number): Promise<boolean> {
  return (await db.run(SET_CARD, [messageId, reportId])).changes === 1;
}

/** Records the status card's message id on an approved report; true when it did. */
export async function setStatusMessage(db: SqlDb, reportId: string, messageId: number): Promise<boolean> {
  return (await db.run(SET_STATUS_CARD, [messageId, reportId])).changes === 1;
}

/** Records the account link an admin entered, on a pending report that had none; true when it did. */
export async function setAccountUrl(db: SqlDb, reportId: string, accountUrl: string): Promise<boolean> {
  return (await db.run(SET_ACCOUNT, [accountUrl, reportId])).changes === 1;
}

/**
 * The outcome of the latest other report of `report`'s target (see the
 * header): an outcome code such as 'rejected', 'routed' or 'taken_down', or
 * null when the target was not reported before, or the report has no hash.
 */
export async function priorOutcome(db: SqlDb, report: Pick<ReviewReport, 'id' | 'linkHash'>): Promise<string | null> {
  if (report.linkHash === null) return null;
  const decided = await db.first<{ status: SqlValue; outcome: SqlValue; at: SqlValue }>(PRIOR_REPORTS, [report.linkHash, report.id]);
  const aggregate = await db.first<{ outcome: SqlValue; day: SqlValue }>(PRIOR_STATS, [report.linkHash, report.id]);
  const decidedOutcome = decided === null ? null : typeof decided.outcome === 'string' ? decided.outcome : decided.status;
  const decidedDay = decided !== null && typeof decided.at === 'number' ? utcDay(decided.at) : null;
  const aggregateOutcome = aggregate !== null && typeof aggregate.outcome === 'string' ? aggregate.outcome : null;
  const aggregateDay = aggregate !== null && typeof aggregate.day === 'string' ? aggregate.day : null;
  if (typeof decidedOutcome !== 'string') return aggregateOutcome;
  if (aggregateOutcome === null || aggregateDay === null || decidedDay === null) return decidedOutcome;
  // The later of the two; on the same day, the report still in the table.
  return aggregateDay > decidedDay ? aggregateOutcome : decidedOutcome;
}

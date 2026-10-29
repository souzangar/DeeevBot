// @critical-path
// The force-reply prompts of the review (critical invariants 2, 4 and 8;
// the MVP plan, sections 3 and 4; migrations/0001_init.sql, 0002): a
// prompt is a message the bot sends into the venue asking the admin who
// pressed for a text (the account link a report lacks, the recommended
// points of a post), and one `admin_prompts` row keyed by (chat_id,
// prompt_message_id), since message ids are per chat. The row records who
// was asked (`admin_id`, the presser's allowlisted id), for which report,
// what is asked (`kind`), and what the admin chose before it: the confirmed
// `category` and, for the points, the `link_mode`. A reply is matched on
// the replier's allowlisted id plus `reply_to_message.message_id`, so only
// the admin who was asked can answer it; the replier is the approving admin.
//
// The only Telegram ids stored are the venue's chat id and the admin's own
// id, both deployment configuration (the rule-8 schema scan allows exactly
// these). A prompt row is deleted when its reply is captured or refused
// (a fresh prompt replaces it), when its admin goes Back, at every decision
// of its report, by the retention job after 24 hours, and with its report.
// Kinds this unit does not know (a retraction's, later) are read as they
// are and left to their own handler.
import { sql, type SqlDb, type SqlStatement, type SqlValue } from '../db/sql';
import { AppError } from '../errors/app-error';
import { isCategory, LINK_MODES, type Category, type LinkMode } from './categories';

/** The prompts of the approval: the account link a report lacks, and the recommended points. */
export const PROMPT_KINDS = ['account_link', 'recommended_comment'] as const;
export type PromptKind = (typeof PROMPT_KINDS)[number];

export const isPromptKind = (value: unknown): value is PromptKind =>
  typeof value === 'string' && (PROMPT_KINDS as readonly string[]).includes(value);

/** One prompt row. */
export interface AdminPrompt {
  readonly chatId: number;
  readonly promptMessageId: number;
  /** The admin who was asked: the only one whose reply counts. */
  readonly adminId: number;
  readonly reportId: string;
  /** One of PROMPT_KINDS, or another unit's kind, read as it is. */
  readonly kind: string;
  readonly category: Category | null;
  readonly linkMode: LinkMode | null;
  readonly createdAt: number;
}

interface PromptRow {
  readonly chat_id: SqlValue;
  readonly prompt_message_id: SqlValue;
  readonly admin_id: SqlValue;
  readonly report_id: SqlValue;
  readonly kind: SqlValue;
  readonly category: SqlValue;
  readonly link_mode: SqlValue;
  readonly created_at: SqlValue;
}

const INSERT = sql`INSERT INTO admin_prompts (chat_id, prompt_message_id, admin_id, report_id, kind, category, link_mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
const READ = sql`SELECT chat_id, prompt_message_id, admin_id, report_id, kind, category, link_mode, created_at FROM admin_prompts WHERE chat_id = ? AND prompt_message_id = ?`;
const OF_REPORT = sql`SELECT chat_id, prompt_message_id, admin_id, report_id, kind, category, link_mode, created_at FROM admin_prompts WHERE report_id = ? ORDER BY created_at, prompt_message_id`;
const DELETE_ONE = sql`DELETE FROM admin_prompts WHERE chat_id = ? AND prompt_message_id = ?`;
const DELETE_OF_ADMIN = sql`DELETE FROM admin_prompts WHERE report_id = ? AND admin_id = ? AND kind IN ('account_link', 'recommended_comment')`;

const corrupt = (): AppError => new AppError('UNEXPECTED', 'an admin_prompts row holds a value outside its type');

const integer = (value: SqlValue): number => {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  throw corrupt();
};

function toPrompt(row: PromptRow): AdminPrompt {
  const { report_id: reportId, kind, category, link_mode: linkMode } = row;
  if (typeof reportId !== 'string' || typeof kind !== 'string') throw corrupt();
  if (category !== null && !isCategory(category)) throw corrupt();
  if (linkMode !== null && (typeof linkMode !== 'string' || !(LINK_MODES as readonly string[]).includes(linkMode))) {
    throw corrupt();
  }
  return {
    chatId: integer(row.chat_id),
    promptMessageId: integer(row.prompt_message_id),
    adminId: integer(row.admin_id),
    reportId,
    kind,
    category,
    linkMode: linkMode as LinkMode | null,
    createdAt: integer(row.created_at),
  };
}

/** The insert of `prompt`, as a statement for a batch. */
export const insertPromptStatement = (prompt: AdminPrompt): SqlStatement => ({
  sql: INSERT,
  params: [
    prompt.chatId,
    prompt.promptMessageId,
    prompt.adminId,
    prompt.reportId,
    prompt.kind,
    prompt.category,
    prompt.linkMode,
    prompt.createdAt,
  ],
});

/** The deletion of the prompt of `chatId` and `promptMessageId`, as a statement for a batch. */
export const deletePromptStatement = (chatId: number, promptMessageId: number): SqlStatement => ({
  sql: DELETE_ONE,
  params: [chatId, promptMessageId],
});

/** Records `prompt`. */
export async function createPrompt(db: SqlDb, prompt: AdminPrompt): Promise<void> {
  const statement = insertPromptStatement(prompt);
  await db.run(statement.sql, statement.params);
}

/** The prompt sent as message `promptMessageId` of `chatId`, or null. */
export async function readPrompt(db: SqlDb, chatId: number, promptMessageId: number): Promise<AdminPrompt | null> {
  const row = await db.first<PromptRow>(READ, [chatId, promptMessageId]);
  return row === null ? null : toPrompt(row);
}

/** Every prompt of report `reportId`, oldest first. */
export async function promptsOf(db: SqlDb, reportId: string): Promise<AdminPrompt[]> {
  return (await db.all<PromptRow>(OF_REPORT, [reportId])).map(toPrompt);
}

/** Deletes the prompt of `chatId` and `promptMessageId`; true when there was one. */
export async function deletePrompt(db: SqlDb, chatId: number, promptMessageId: number): Promise<boolean> {
  return (await db.run(DELETE_ONE, [chatId, promptMessageId])).changes === 1;
}

/** Deletes the approval prompts admin `adminId` has open for report `reportId`; how many there were. */
export async function deleteAdminPrompts(db: SqlDb, reportId: string, adminId: number): Promise<number> {
  return (await db.run(DELETE_OF_ADMIN, [reportId, adminId])).changes;
}

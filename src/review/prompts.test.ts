// Unit tests for the review's force-reply prompts (src/review/prompts.ts),
// on node:sqlite with the D1 migrations: a prompt recorded under (chat,
// message) with who was asked and what they chose so far, read back typed,
// another unit's kind read as it is, a corrupt row refused, an admin's own
// approval prompts deleted and nobody else's, and every prompt going with
// its report.
import { describe, expect, it } from 'vitest';
import { fakeClock } from '../../test/fakes/clock';
import { migratedDatabase } from '../../test/support/database';
import { insertReport } from '../../test/support/review-rows';
import { IDS } from '../../test/support/variables';
import { sql } from '../db/sql';
import { AppError } from '../errors/app-error';
import {
  createPrompt,
  deleteAdminPrompts,
  deletePrompt,
  deletePromptStatement,
  insertPromptStatement,
  isPromptKind,
  promptsOf,
  readPrompt,
  type AdminPrompt,
} from './prompts';

const setup = () => migratedDatabase(fakeClock(1_800_000_000_000));

const prompt = (reportId: string, fields: Partial<AdminPrompt> = {}): AdminPrompt => ({
  chatId: IDS.adminChat,
  promptMessageId: 11,
  adminId: IDS.admin,
  reportId,
  kind: 'recommended_comment',
  category: 'harassment',
  linkMode: 'post',
  createdAt: 1_800_000_000_000,
  ...fields,
});

describe('the prompts store', () => {
  it('records a prompt under its chat and message, and reads it back', async () => {
    const { db } = setup();
    const reportId = await insertReport(db);
    await createPrompt(db, prompt(reportId));
    expect(await readPrompt(db, IDS.adminChat, 11)).toEqual(prompt(reportId));
    expect(await readPrompt(db, IDS.adminChat, 12)).toBeNull();
    expect(await readPrompt(db, IDS.reporter, 11)).toBeNull();
  });

  it("reads another unit's kind as it is, with no category or link mode", async () => {
    const { db } = setup();
    const reportId = await insertReport(db);
    await createPrompt(db, prompt(reportId, { kind: 'retraction', category: null, linkMode: null }));
    expect(await readPrompt(db, IDS.adminChat, 11)).toMatchObject({ kind: 'retraction', category: null, linkMode: null });
    expect(isPromptKind('retraction')).toBe(false);
    expect(isPromptKind('account_link')).toBe(true);
    expect(isPromptKind('recommended_comment')).toBe(true);
  });

  it('refuses a row whose category or link mode is outside its type', async () => {
    const { db, connection } = setup();
    const reportId = await insertReport(db);
    await createPrompt(db, prompt(reportId));
    connection.prepare("UPDATE admin_prompts SET category = 'everything'").run();
    await expect(readPrompt(db, IDS.adminChat, 11)).rejects.toBeInstanceOf(AppError);
  });

  it("lists a report's prompts, oldest first, and deletes one, or an admin's own approval prompts only", async () => {
    const { db } = setup();
    const reportId = await insertReport(db);
    await createPrompt(db, prompt(reportId, { promptMessageId: 11 }));
    await createPrompt(db, prompt(reportId, { promptMessageId: 12, kind: 'account_link', linkMode: null, createdAt: 1_800_000_000_001 }));
    await createPrompt(db, prompt(reportId, { promptMessageId: 13, adminId: IDS.secondAdmin, createdAt: 1_800_000_000_002 }));
    await createPrompt(db, prompt(reportId, { promptMessageId: 14, kind: 'retraction', category: null, linkMode: null, createdAt: 1_800_000_000_003 }));
    expect((await promptsOf(db, reportId)).map((each) => each.promptMessageId)).toEqual([11, 12, 13, 14]);
    expect(await deleteAdminPrompts(db, reportId, IDS.admin)).toBe(2);
    expect((await promptsOf(db, reportId)).map((each) => each.promptMessageId)).toEqual([13, 14]);
    expect(await deletePrompt(db, IDS.adminChat, 13)).toBe(true);
    expect(await deletePrompt(db, IDS.adminChat, 13)).toBe(false);
  });

  it('replaces a prompt in one batch, and the prompts go with their report', async () => {
    const { db } = setup();
    const reportId = await insertReport(db);
    await createPrompt(db, prompt(reportId));
    await db.batch([insertPromptStatement(prompt(reportId, { promptMessageId: 15 })), deletePromptStatement(IDS.adminChat, 11)]);
    expect((await promptsOf(db, reportId)).map((each) => each.promptMessageId)).toEqual([15]);
    await db.run(sql`DELETE FROM reports WHERE id = ?`, [reportId]);
    expect(await promptsOf(db, reportId)).toEqual([]);
  });
});

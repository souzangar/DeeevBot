// Describes a SQLite schema through sqlite_master and PRAGMAs the same way on
// both runtimes the project runs SQL on, node:sqlite and D1, so one expected
// description (test/support/expected-schema.ts) pins the schema migrations/
// builds on both: the columns, the CHECK constraints, the indexes, the
// foreign keys and the triggers. Test support only: the table names it
// writes into PRAGMA statements come from sqlite_master itself.

/** Runs one statement and returns its rows: each runtime's own call. */
export type RawQuery = (text: string) => Promise<readonly Record<string, unknown>[]>;

export interface TableDescription {
  readonly name: string;
  readonly withoutRowid: boolean;
  /** "name TYPE [NOT NULL] [DEFAULT x] [PKn]", in column order. */
  readonly columns: readonly string[];
  /** Every CHECK expression, a column's or the table's, in declaration order. */
  readonly checks: readonly string[];
  /** "name (columns) [UNIQUE] [PARTIAL] origin", by name. */
  readonly indexes: readonly string[];
  /** "column -> table(column) ON DELETE action", by column. */
  readonly foreignKeys: readonly string[];
  /** Each trigger on the table, its whole CREATE TRIGGER statement, by name. */
  readonly triggers: readonly string[];
}

/** Tables no schema of ours defines: SQLite's, Cloudflare's and the two migration ledgers. */
export const isOwnTable = (name: string): boolean =>
  !name.startsWith('sqlite_') &&
  !name.startsWith('_cf_') &&
  name !== 'd1_migrations' &&
  name !== 'schema_migrations';

const WITHOUT_ROWID = /\)\s*WITHOUT\s+ROWID\s*$/i;

/** A PRAGMA cell as text: they are strings, numbers or null. */
const cell = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  throw new Error('a PRAGMA cell is a string, a number or null');
};

/** SQL text on one line: each run of whitespace one space. */
const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

const QUOTES = new Set(["'", '"', '`', '[']);

/** The index just past the quoted run that starts at `start`; a doubled quote is an escaped one. */
const pastQuoted = (text: string, start: number): number => {
  const close = text.charAt(start) === '[' ? ']' : text.charAt(start);
  let index = start + 1;
  while (index < text.length) {
    if (text.charAt(index) === close) {
      if (close !== ']' && text.charAt(index + 1) === close) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  throw new Error('a CREATE statement holds an unterminated quote');
};

/** The index just past the comment that starts at `start`, or -1 if none starts there. */
const pastComment = (text: string, start: number): number => {
  const pair = text.slice(start, start + 2);
  if (pair === '--') {
    const end = text.indexOf('\n', start);
    return end === -1 ? text.length : end + 1;
  }
  if (pair === '/*') {
    const end = text.indexOf('*/', start + 2);
    if (end === -1) throw new Error('a CREATE statement holds an unterminated comment');
    return end + 2;
  }
  return -1;
};

/** The index of the parenthesis that closes the one at `open`, quotes and comments aside. */
const closingParenthesis = (text: string, open: number): number => {
  let depth = 0;
  let index = open;
  while (index < text.length) {
    const char = text.charAt(index);
    const past = pastComment(text, index);
    if (past !== -1) {
      index = past;
      continue;
    }
    if (QUOTES.has(char)) {
      index = pastQuoted(text, index);
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  throw new Error('a CREATE statement holds an unbalanced parenthesis');
};

const CHECK_AT = /CHECK\s*\(/iy;
const WORD_CHARACTER = /[A-Za-z0-9_$]/;

/**
 * The CHECK expressions of a CREATE TABLE statement, column and table
 * constraints alike, in declaration order, each on one line. Quoted text
 * and comments are skipped, so a CHECK inside a string or a name is not one.
 */
export function checksOf(createTable: string): string[] {
  const checks: string[] = [];
  let index = 0;
  while (index < createTable.length) {
    const char = createTable.charAt(index);
    const past = pastComment(createTable, index);
    if (past !== -1) {
      index = past;
      continue;
    }
    if (QUOTES.has(char)) {
      index = pastQuoted(createTable, index);
      continue;
    }
    CHECK_AT.lastIndex = index;
    if (!WORD_CHARACTER.test(createTable.charAt(index - 1)) && CHECK_AT.test(createTable)) {
      const open = CHECK_AT.lastIndex - 1;
      const close = closingParenthesis(createTable, open);
      checks.push(collapse(createTable.slice(open + 1, close)));
      index = close + 1;
      continue;
    }
    index += 1;
  }
  return checks;
}

const describeColumn = (row: Record<string, unknown>): string => {
  const parts = [cell(row.name)];
  // A column declared without a type has none to show.
  if (cell(row.type) !== '') parts.push(cell(row.type));
  if (Number(row.notnull) === 1) parts.push('NOT NULL');
  if (cell(row.dflt_value) !== '') parts.push(`DEFAULT ${cell(row.dflt_value)}`);
  if (Number(row.pk) > 0) parts.push(`PK${cell(row.pk)}`);
  return parts.join(' ');
};

/** The tables of the database `query` reads, sorted by name, ours only. */
export async function describeSchema(query: RawQuery): Promise<TableDescription[]> {
  const tables = (await query("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name"))
    .map((row) => ({ name: cell(row.name), sql: cell(row.sql) }))
    .filter((table) => isOwnTable(table.name));
  const triggers = (await query("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name")).map(
    (row) => ({ table: cell(row.tbl_name), sql: collapse(cell(row.sql)) }),
  );
  const described: TableDescription[] = [];
  for (const table of tables) {
    const columns = (await query(`PRAGMA table_info(${table.name})`)).map(describeColumn);
    const indexes: string[] = [];
    for (const index of await query(`PRAGMA index_list(${table.name})`)) {
      const name = cell(index.name);
      const indexColumns = (await query(`PRAGMA index_info(${name})`))
        .slice()
        .sort((a, b) => Number(a.seqno) - Number(b.seqno))
        .map((row) => cell(row.name));
      const parts = [`${name} (${indexColumns.join(', ')})`];
      if (Number(index.unique) === 1) parts.push('UNIQUE');
      if (Number(index.partial) === 1) parts.push('PARTIAL');
      parts.push(cell(index.origin));
      indexes.push(parts.join(' '));
    }
    const foreignKeys = (await query(`PRAGMA foreign_key_list(${table.name})`)).map(
      (row) => `${cell(row.from)} -> ${cell(row.table)}(${cell(row.to)}) ON DELETE ${cell(row.on_delete)}`,
    );
    described.push({
      name: table.name,
      withoutRowid: WITHOUT_ROWID.test(table.sql),
      columns,
      checks: checksOf(table.sql),
      indexes: indexes.sort(),
      foreignKeys: foreignKeys.sort(),
      triggers: triggers.filter((trigger) => trigger.table === table.name).map((trigger) => trigger.sql),
    });
  }
  return described;
}

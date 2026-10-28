// @critical-path
// The SQL port (doc/architecture/adr-0004-storage-and-delivery-ledger.md;
// critical invariant 8, and rule 1 through the approval rows it reaches):
// SqlDb over D1 (src/db/d1.ts) and over node:sqlite (src/db/node-sqlite.ts),
// with run, all, first, and batch, the ONLY multi-write primitive (one
// transaction: D1's batch, or BEGIN ... COMMIT on node:sqlite). D1 is the
// only store; the Node port runs the same SQL on a local SQLite file.
//
// No value is ever written into SQL text. A statement is SqlText, which only
// the `sql` tag mints: its interpolations are typed `never`, so `${value}`
// inside it fails the build, and it refuses one at run time too. An IN list
// is built from placeholders(n) and concatSql(). Every value is a bound
// parameter. checkStatement() runs before every statement on every adapter,
// so all of them refuse what D1 refuses, and node:sqlite would accept
// silently: a parameter count that differs from the placeholders
// (node:sqlite binds NULL to a missing one), a second statement in one text
// (node:sqlite runs only the first), more than MAX_BOUND_PARAMETERS
// parameters, named or numbered placeholders, and a value that is not a
// string, a finite number or null.
import { AppError } from '../errors/app-error';

/** A bound parameter or a column value. Booleans are written as 0 and 1. */
export type SqlValue = string | number | null;

/** A row as the drivers return it. */
export type SqlRow = Readonly<Record<string, SqlValue>>;

declare const SQL_TEXT: unique symbol;

/** SQL text that holds no value: minted by the `sql` tag (and joined by concatSql) only. */
export type SqlText = string & { readonly [SQL_TEXT]: 'SqlText' };

/** One statement of a batch. */
export interface SqlStatement {
  readonly sql: SqlText;
  readonly params: readonly SqlValue[];
}

/** What a write reports: the rows it inserted, updated or deleted. */
export interface SqlRunResult {
  readonly changes: number;
}

/** The asynchronous SQL port (D1, node:sqlite). Every failure is an AppError. */
export interface SqlDb {
  /** Runs one statement. */
  run(sql: SqlText, params?: readonly SqlValue[]): Promise<SqlRunResult>;
  /** The rows of one statement. */
  all<T extends object = SqlRow>(sql: SqlText, params?: readonly SqlValue[]): Promise<T[]>;
  /** The first row of one statement, or null. */
  first<T extends object = SqlRow>(sql: SqlText, params?: readonly SqlValue[]): Promise<T | null>;
  /**
   * Runs the statements in order in ONE transaction: all of them apply, or
   * a failure rolls every one back. The only multi-write primitive.
   */
  batch(statements: readonly SqlStatement[]): Promise<SqlRunResult[]>;
}

/** D1's limit on the bound parameters of one statement, applied on every adapter. */
export const MAX_BOUND_PARAMETERS = 100;

const refuse = (message: string): AppError => new AppError('UNEXPECTED', message);

/**
 * The tag every statement is written with: sql`SELECT ... WHERE id = ?`.
 * An interpolation is a type error and, past the types, an AppError
 * UNEXPECTED: values are bound parameters.
 */
export function sql(strings: TemplateStringsArray, ...values: never[]): SqlText {
  const [text] = strings;
  if (
    values.length > 0 ||
    strings.length !== 1 ||
    typeof text !== 'string' ||
    !Object.isFrozen(strings) ||
    !Array.isArray(strings.raw)
  ) {
    throw refuse('SQL text is written with the sql tag alone; a value is a bound parameter');
  }
  return text as SqlText;
}

/** "?, ?, ?": `count` placeholders, for an IN list of at most MAX_BOUND_PARAMETERS values. */
export function placeholders(count: number): SqlText {
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_BOUND_PARAMETERS) {
    throw refuse('placeholders() takes a count from 1 to MAX_BOUND_PARAMETERS');
  }
  return Array.from({ length: count }, () => '?').join(', ') as SqlText;
}

/** SQL text fragments joined: each is SqlText, so the whole still holds no value. */
export const concatSql = (...parts: readonly SqlText[]): SqlText => parts.join('') as SqlText;

/** The characters that open a named parameter in SQLite. */
const NAMED_PARAMETER = new Set([':', '@', '#', '$']);
/**
 * A character SQLite takes into a parameter name: a letter, a digit, `_`,
 * `$`, or any character beyond ASCII. A name may start with a digit, so
 * `:1` is a named parameter, which node:sqlite would bind NULL to.
 */
const PARAMETER_NAME = /[A-Za-z0-9_$\u0080-\uffff]/;
const DIGIT = /[0-9]/;
const SPACE = /\s/;

/** The index just past the quoted run that starts at `start` (`'`, `"`, backtick or `[`). */
const skipQuoted = (text: string, start: number): number => {
  const open = text.charAt(start);
  const close = open === '[' ? ']' : open;
  let index = start + 1;
  while (index < text.length) {
    if (text.charAt(index) === close) {
      // A doubled quote is an escaped one; `]` has no escape.
      if (close !== ']' && text.charAt(index + 1) === close) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  throw refuse('SQL text holds an unterminated quote');
};

/** The index just past the comment that starts at `start`, or -1 if none starts there. */
const skipComment = (text: string, start: number): number => {
  const pair = text.slice(start, start + 2);
  if (pair === '--') {
    const end = text.indexOf('\n', start);
    return end === -1 ? text.length : end + 1;
  }
  if (pair === '/*') {
    const end = text.indexOf('*/', start + 2);
    if (end === -1) throw refuse('SQL text holds an unterminated comment');
    return end + 2;
  }
  return -1;
};

/**
 * The number of `?` placeholders in one statement, quotes and comments
 * aside. Throws an AppError UNEXPECTED on a second statement after a `;`,
 * on a numbered (`?1`) or named (`:a`, `@a`, `#a`, `$a`, `:1`) placeholder
 * and on an unterminated quote or comment.
 */
export function countPlaceholders(text: string): number {
  let count = 0;
  let ended = false;
  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    const pastComment = skipComment(text, index);
    if (pastComment !== -1) {
      index = pastComment;
      continue;
    }
    if (ended && !SPACE.test(char)) throw refuse('SQL text holds more than one statement');
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      index = skipQuoted(text, index);
      continue;
    }
    const next = text.charAt(index + 1);
    if (char === ';') {
      ended = true;
    } else if (char === '?') {
      if (DIGIT.test(next)) throw refuse('SQL text uses a numbered placeholder; write ? only');
      count += 1;
    } else if (NAMED_PARAMETER.has(char) && PARAMETER_NAME.test(next)) {
      throw refuse('SQL text uses a named placeholder; write ? only');
    }
    index += 1;
  }
  return count;
}

/** Placeholder counts of the texts seen so far: statements are static, so this stays small. */
const counted = new Map<string, number>();
const COUNT_CACHE_LIMIT = 1024;

const isBindable = (value: unknown): value is SqlValue =>
  value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));

/**
 * Refuses, as an AppError UNEXPECTED, a statement the adapters must not run:
 * see the header. Every adapter calls it before every statement.
 */
export function checkStatement(text: SqlText, params: readonly unknown[]): void {
  let placeholderCount = counted.get(text);
  if (placeholderCount === undefined) {
    placeholderCount = countPlaceholders(text);
    if (counted.size < COUNT_CACHE_LIMIT) counted.set(text, placeholderCount);
  }
  if (params.length > MAX_BOUND_PARAMETERS) {
    throw refuse('a statement takes at most MAX_BOUND_PARAMETERS bound parameters');
  }
  if (params.length !== placeholderCount) {
    throw refuse(`a statement with ${placeholderCount} placeholders was given ${params.length} parameters`);
  }
  if (!params.every(isBindable)) {
    throw refuse('a bound parameter is a string, a finite number or null');
  }
}

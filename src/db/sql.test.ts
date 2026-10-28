// Unit tests for the SQL port's text rules (src/db/sql.ts): the `sql` tag,
// placeholders(), concatSql() and checkStatement(), and a scan of src/ that
// pins "no value is ever written into SQL text" for every later unit too:
// no template literal with a substitution carries SQL, and only
// src/db/sql.ts mints SqlText.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  checkStatement,
  concatSql,
  countPlaceholders,
  MAX_BOUND_PARAMETERS,
  placeholders,
  sql,
  type SqlText,
} from './sql';

describe('the sql tag', () => {
  it('returns the text of a template without substitutions', () => {
    expect(sql`SELECT 1 AS one`).toBe('SELECT 1 AS one');
    expect(sql`SELECT ?
      AS two`).toBe('SELECT ?\n      AS two');
  });

  it('refuses a substitution, a plain array and an unfrozen one (past the types)', () => {
    const tag = sql as unknown as (strings: TemplateStringsArray, ...values: unknown[]) => SqlText;
    const value = "x'; DROP TABLE reports; --";
    expect(() => tag`SELECT * FROM reports WHERE id = '${value}'`).toThrow(expect.objectContaining({ code: 'UNEXPECTED' }));
    const shaped = () => Object.assign(['SELECT 1'], { raw: ['SELECT 1'] });
    // A frozen array with raw strings is indistinguishable from a template's.
    expect(() => tag(Object.freeze(shaped()) as unknown as TemplateStringsArray)).not.toThrow();
    expect(() => tag(shaped() as unknown as TemplateStringsArray)).toThrow(expect.objectContaining({ code: 'UNEXPECTED' }));
    expect(() => tag(Object.freeze(['SELECT 1']) as unknown as TemplateStringsArray)).toThrow(expect.objectContaining({ code: 'UNEXPECTED' }));
  });
});

describe('placeholders and concatSql', () => {
  it('builds an IN list of bound parameters', () => {
    expect(placeholders(1)).toBe('?');
    expect(placeholders(3)).toBe('?, ?, ?');
    const text = concatSql(sql`SELECT id FROM reports WHERE id IN (`, placeholders(3), sql`)`);
    expect(text).toBe('SELECT id FROM reports WHERE id IN (?, ?, ?)');
    expect(() => checkStatement(text, [1, 2, 3])).not.toThrow();
  });

  it.each([0, -1, 1.5, MAX_BOUND_PARAMETERS + 1])('refuses %s placeholders', (count) => {
    expect(() => placeholders(count)).toThrow(expect.objectContaining({ code: 'UNEXPECTED' }));
  });
});

describe('countPlaceholders', () => {
  it('counts the ? outside quotes and comments', () => {
    expect(countPlaceholders('SELECT ? , ?')).toBe(2);
    expect(countPlaceholders("SELECT '?', \"?\", `?`, [?] FROM t WHERE a = ?")).toBe(1);
    expect(countPlaceholders("SELECT 'it''s ?' -- why?\n, ? /* not ? */")).toBe(1);
    expect(countPlaceholders("SELECT 'a;b' WHERE id NOT GLOB '*[^a-z]*'")).toBe(0);
    expect(countPlaceholders("SELECT json_extract(payload, '$.text'), '12:30', '@1' FROM jobs WHERE id = ?")).toBe(1);
  });

  it('accepts one trailing semicolon, whitespace and comments after it', () => {
    expect(countPlaceholders('SELECT ?;')).toBe(1);
    expect(countPlaceholders('SELECT ?;  -- done\n /* really */ ')).toBe(1);
  });

  it.each([
    ['a second statement', 'SELECT 1; SELECT 2'],
    ['an empty second statement', 'SELECT 1;;'],
    ['a quoted second statement', "SELECT 1; 'x'"],
    ['a numbered placeholder', 'SELECT ?1'],
    ['a named placeholder', 'SELECT :id'],
    ['an @ placeholder', 'SELECT @id'],
    ['a $ placeholder', 'SELECT $id'],
    ['a # placeholder', 'SELECT #id'],
    ['a named placeholder that starts with a digit', 'SELECT :1'],
    ['an @ placeholder that starts with a digit', 'SELECT @1'],
    ['a $ placeholder that starts with a digit', 'SELECT $1'],
    ['a placeholder named past ASCII', 'SELECT :\u00e9'],
    ['a $$ placeholder', 'SELECT $$'],
    ['an unterminated quote', "SELECT 'x"],
    ['an unterminated comment', 'SELECT 1 /* x'],
  ])('refuses %s', (_label, text) => {
    expect(() => countPlaceholders(text)).toThrow(expect.objectContaining({ code: 'UNEXPECTED' }));
  });
});

describe('checkStatement', () => {
  const twoParameters = sql`SELECT ? AS a, ? AS b`;

  it('accepts as many bound values as placeholders: strings, finite numbers, null', () => {
    expect(() => checkStatement(twoParameters, ['x', null])).not.toThrow();
    expect(() => checkStatement(twoParameters, [1.5, -7])).not.toThrow();
  });

  it('refuses a parameter count that differs from the placeholders (node:sqlite would bind NULL)', () => {
    expect(() => checkStatement(twoParameters, ['x'])).toThrow(expect.objectContaining({ code: 'UNEXPECTED' }));
    expect(() => checkStatement(twoParameters, ['x', 'y', 'z'])).toThrow(expect.objectContaining({ code: 'UNEXPECTED' }));
  });

  it('refuses more than MAX_BOUND_PARAMETERS parameters, D1 limit', () => {
    const text = concatSql(
      sql`SELECT 1 WHERE 1 IN (`,
      placeholders(MAX_BOUND_PARAMETERS),
      sql`) OR 1 IN (`,
      placeholders(1),
      sql`)`,
    );
    expect(() => checkStatement(text, Array.from({ length: MAX_BOUND_PARAMETERS + 1 }, () => 1))).toThrow(
      expect.objectContaining({ code: 'UNEXPECTED' }),
    );
  });

  it.each([
    ['undefined', undefined],
    ['a boolean', true],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a bigint', 1n],
    ['an object', { id: 1 }],
    ['a Date', new Date(0)],
  ])('refuses %s as a bound value (past the types)', (_label, value) => {
    expect(() => checkStatement(sql`SELECT ?`, [value])).toThrow(expect.objectContaining({ code: 'UNEXPECTED' }));
  });
});

describe('no value is written into SQL text anywhere in src/', () => {
  const SRC = fileURLToPath(new URL('..', import.meta.url).href);
  const MINTER = 'db/sql.ts';
  /** An SQL keyword as this codebase writes them: upper case. */
  const SQL_KEYWORD =
    /\b(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|PRAGMA|REPLACE|UPSERT|WHERE|VALUES|FROM|INTO|JOIN|SET|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/;

  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
    });

  interface Finding {
    readonly file: string;
    readonly line: number;
    readonly what: string;
  }

  /** Template literals with substitutions that carry SQL, and SqlText assertions outside the minter. */
  const findingsIn = (file: string, text: string): Finding[] => {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const found: Finding[] = [];
    const at = (node: ts.Node, what: string): void => {
      found.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, what });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isTemplateExpression(node)) {
        const literalText = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ');
        if (SQL_KEYWORD.test(literalText)) at(node, 'a substitution inside SQL text');
      }
      if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && file !== MINTER) {
        if (/\bSqlText\b/.test(node.type.getText(source))) at(node, 'SqlText minted outside src/db/sql.ts');
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  };

  const findings = (path: string): Finding[] =>
    findingsIn(relative(SRC, path).split('\\').join('/'), readFileSync(path, 'utf8'));

  it('finds no template substitution carrying SQL and no SqlText assertion outside the minter', () => {
    expect(sourceFiles(SRC).flatMap(findings)).toEqual([]);
  });

  it('flags each shape in a planted source, and nothing in a harmless one, so the scan is not vacuous', () => {
    const planted = [
      'const a = `SELECT * FROM reports WHERE id = ${id}`;',
      'const b = sql`DELETE FROM drafts WHERE chat_id = ${chatId}`;',
      'const c = text as SqlText;',
      'const d = <SqlText>text;',
    ].join('\n');
    expect(findingsIn('telegram/planted.ts', planted).map((finding) => [finding.line, finding.what])).toEqual([
      [1, 'a substitution inside SQL text'],
      [2, 'a substitution inside SQL text'],
      [3, 'SqlText minted outside src/db/sql.ts'],
      [4, 'SqlText minted outside src/db/sql.ts'],
    ]);
    const harmless = 'const e = `report ${id} failed`; const f = sql`SELECT 1`; const g = text as string;';
    expect(findingsIn('telegram/harmless.ts', harmless)).toEqual([]);
    expect(findingsIn(MINTER, 'const h = text as SqlText;')).toEqual([]);
    expect(sourceFiles(SRC).length).toBeGreaterThan(10);
    expect(sourceFiles(SRC).some((path) => path.endsWith(join('db', 'sql.ts')))).toBe(true);
  });
});

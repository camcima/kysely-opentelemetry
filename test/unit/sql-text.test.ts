import { describe, expect, it } from 'vitest';
import { LEXICONS } from '../../src/analysis/lexicon.js';
import {
  maskSqlText,
  maskSqlTextUnquotingIdentifiers,
  scrubSqlText,
} from '../../src/analysis/sql-text.js';

/**
 * maskSqlText replaces comments, string literals, and quoted identifiers with
 * spaces while preserving overall length and the position of every unmasked
 * character, so downstream regex scanners aren't fooled by quoted/commented
 * content. These cases pin the masking branches that the fingerprint/table
 * tests exercise only indirectly.
 */
describe('maskSqlText', () => {
  it('preserves input length and unmasked structure', () => {
    const input = "select id from orders where name = 'ada'";
    const masked = maskSqlText(input);
    expect(masked).toHaveLength(input.length);
    expect(masked.startsWith('select id from orders where name = ')).toBe(true);
    expect(masked).not.toContain('ada');
  });

  it('masks -- line comments to end of line only', () => {
    const masked = maskSqlText('select 1 -- secret\nfrom t');
    expect(masked).not.toContain('secret');
    expect(masked.endsWith('\nfrom t')).toBe(true);
    expect(masked.startsWith('select 1 ')).toBe(true);
  });

  it('masks /* block */ comments, and an unterminated one to end of input', () => {
    expect(maskSqlText('a /* x */ b')).toBe('a         b');
    const unterminated = maskSqlText('a /* x');
    expect(unterminated).toHaveLength('a /* x'.length);
    expect(unterminated).not.toContain('x');
  });

  it('masks MSSQL [bracket] identifiers, preserving length', () => {
    const input = 'select [order status] from t';
    const masked = maskSqlText(input);
    expect(masked).toHaveLength(input.length);
    expect(masked).not.toContain('order status');
    expect(masked.startsWith('select ')).toBe(true);
    expect(masked.endsWith(' from t')).toBe(true);
  });

  it('masks an unterminated [bracket to end of input', () => {
    const input = 'select [oops';
    const masked = maskSqlText(input);
    expect(masked).toHaveLength(input.length);
    expect(masked).not.toContain('oops');
    expect(masked.startsWith('select ')).toBe(true);
  });

  it('masks $tag$ dollar-quoted strings but preserves a lone $', () => {
    const masked = maskSqlText('select $tag$ secret $tag$ from t');
    expect(masked).not.toContain('secret');
    expect(masked.endsWith(' from t')).toBe(true);

    // A single $ that is not a dollar-quote tag is left intact.
    expect(maskSqlText('a $ b')).toBe('a $ b');
    expect(maskSqlText('cost = 5 $ usd')).toBe('cost = 5 $ usd');
  });

  it("honors backslash escapes in single-quoted strings so \\' does not terminate (MySQL)", () => {
    const input = "id = 'a\\'b' next";
    const masked = maskSqlText(input, LEXICONS.mysql);
    expect(masked).toHaveLength(input.length);
    expect(masked).not.toContain('a');
    expect(masked).not.toContain('b');
    expect(masked.startsWith('id = ')).toBe(true);
    expect(masked.endsWith(' next')).toBe(true);
  });

  it("treats a doubled '' quote as an escape, not a terminator", () => {
    const input = "note = 'O''Brien' end";
    const masked = maskSqlText(input);
    expect(masked).toHaveLength(input.length);
    expect(masked).not.toContain('Brien');
    expect(masked.startsWith('note = ')).toBe(true);
    expect(masked.endsWith(' end')).toBe(true);
  });

  it('masks double-quoted and backtick identifiers', () => {
    const dq = maskSqlText('select "weird col" from t');
    expect(dq).toHaveLength('select "weird col" from t'.length);
    expect(dq).not.toContain('weird col');

    const bt = maskSqlText('select `weird col` from t');
    expect(bt).toHaveLength('select `weird col` from t'.length);
    expect(bt).not.toContain('weird col');
  });

  it('masks an unterminated string literal to end of input', () => {
    const input = "id = 'never closed";
    const masked = maskSqlText(input);
    expect(masked).toHaveLength(input.length);
    expect(masked).not.toContain('never closed');
    expect(masked.startsWith('id = ')).toBe(true);
  });
});

/**
 * maskSqlTextUnquotingIdentifiers feeds the raw-SQL table scanner: comments
 * and string literals are blanked exactly like maskSqlText, but a quoted
 * identifier that holds one simple name is replaced by that bare name, so
 * `FROM "orders"` stays extractable. Anything else in an identifier region
 * (spaces, punctuation, or a table-clause keyword that could fabricate a
 * FROM/JOIN anchor) is replaced by a `?` sentinel — deliberately NOT a
 * space, so a scanner's \s+ can never bridge the gap to the next token.
 */
describe('maskSqlTextUnquotingIdentifiers', () => {
  it('unquotes simple double-quoted, backtick, and bracket identifiers', () => {
    expect(maskSqlTextUnquotingIdentifiers('SELECT * FROM "orders"')).toBe('SELECT * FROM orders');
    expect(maskSqlTextUnquotingIdentifiers('SELECT * FROM `orders`')).toBe('SELECT * FROM orders');
    expect(maskSqlTextUnquotingIdentifiers('SELECT * FROM [orders]')).toBe('SELECT * FROM orders');
  });

  it('keeps schema-qualified quoted names contiguous', () => {
    expect(maskSqlTextUnquotingIdentifiers('SELECT * FROM "public"."orders"')).toBe(
      'SELECT * FROM public.orders',
    );
  });

  it('still blanks comments and string literals', () => {
    const out = maskSqlTextUnquotingIdentifiers(
      'SELECT "a" FROM t WHERE x = \'secret\' -- FROM fake',
    );
    expect(out).toContain('SELECT a FROM t');
    expect(out).not.toContain('secret');
    expect(out).not.toContain('fake');
  });

  it('blanks non-simple identifier content instead of emitting fragments', () => {
    const out = maskSqlTextUnquotingIdentifiers('SELECT * FROM "my table" WHERE id = 1');
    expect(out).not.toContain('my');
    expect(out).not.toContain('table');
    expect(out).toContain('WHERE id = 1');
  });

  it('blanks identifiers whose name is a table-clause keyword (no fabricated anchors)', () => {
    const out = maskSqlTextUnquotingIdentifiers('SELECT "join" x FROM t');
    expect(out).not.toMatch(/\bjoin\b/i);
    expect(out).toContain('FROM t');
  });

  it('blanks an unterminated identifier to end of input (fail closed)', () => {
    const out = maskSqlTextUnquotingIdentifiers('SELECT "unterminated FROM secrets');
    expect(out).not.toContain('secrets');
    expect(out.startsWith('SELECT ')).toBe(true);
  });

  it('blanks identifiers containing doubled-quote escapes (not a simple name)', () => {
    const out = maskSqlTextUnquotingIdentifiers('SELECT "a""b" FROM t');
    expect(out).not.toContain('a""b');
    expect(out).toContain('FROM t');
  });

  it('honors ]] escapes in bracket identifiers as one region (MSSQL)', () => {
    const input = 'SELECT * FROM [a]]b] WHERE x = 1';
    const masked = maskSqlText(input);
    expect(masked).toHaveLength(input.length);
    expect(masked).not.toContain('a]]b');
    expect(masked).not.toContain('b]');
    expect(masked.endsWith(' WHERE x = 1')).toBe(true);

    const out = maskSqlTextUnquotingIdentifiers(input);
    expect(out).not.toContain('a]b');
    expect(out).not.toContain('b]');
    expect(out).toContain('WHERE x = 1');
  });
});

describe('scrubSqlText', () => {
  it('blanks line comments but preserves code', () => {
    const out = scrubSqlText('SELECT 1 -- email=alice@example.com\nFROM t');
    expect(out).not.toContain('alice@example.com');
    expect(out.replace(/\s+/g, ' ').trim()).toBe('SELECT 1 FROM t');
  });

  it('blanks block comments', () => {
    const out = scrubSqlText('SELECT 1 /* trace=abc123 */ FROM t');
    expect(out).not.toContain('abc123');
    expect(out.replace(/\s+/g, ' ').trim()).toBe('SELECT 1 FROM t');
  });

  it('replaces string literals with ?, including comment markers inside them', () => {
    expect(scrubSqlText("SELECT '--not a comment' FROM t")).toBe('SELECT ? FROM t');
    expect(scrubSqlText("SELECT '/* keep */' FROM t")).toBe('SELECT ? FROM t');
    expect(scrubSqlText('SELECT $tag$ -- inside $tag$ FROM t')).toBe('SELECT ? FROM t');
  });

  it('preserves quoted identifiers verbatim', () => {
    expect(scrubSqlText('SELECT "a--b", `c--d`, [e--f] FROM t')).toBe(
      'SELECT "a--b", `c--d`, [e--f] FROM t',
    );
  });

  it('blanks an unterminated block comment to end of input', () => {
    expect(scrubSqlText('SELECT 1 /* oops').trimEnd()).toBe('SELECT 1');
  });

  it('blanks an unterminated dollar-quote to end of input (fail closed)', () => {
    const out = scrubSqlText('SELECT 1 WHERE x = $foo$ -- email=alice@example.com');
    expect(out).not.toContain('alice@example.com');
    expect(out.trimEnd()).toBe('SELECT 1 WHERE x =');
  });

  it('blanks an unterminated string literal to end of input (fail closed)', () => {
    const out = scrubSqlText("SELECT 'abc -- pwd=hunter2");
    expect(out).not.toContain('hunter2');
    expect(out.trimEnd()).toBe('SELECT');
  });
});

/**
 * String and comment syntax differs per database. A scanner using the wrong
 * rules misplaces a literal's end and exposes the NEXT literal's contents as
 * code (review findings R2/R3), so each dialect gets explicit rules and an
 * unknown dialect fails closed.
 */
describe('dialect lexicons', () => {
  const secret = 'private@example.com';
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

  it("postgres: a backslash in an ordinary string is literal ('C:\\' is complete)", () => {
    const out = scrubSqlText(`WHERE path = 'C:\\' AND name = '${secret}'`, LEXICONS.postgresql);
    expect(out).toBe('WHERE path = ? AND name = ?');
  });

  it("postgres: E'' strings honor backslash escapes, and the E prefix is consumed", () => {
    const out = scrubSqlText(
      `WHERE a = E'it\\'s' AND b = e'x\\'' AND c = '${secret}'`,
      LEXICONS.postgresql,
    );
    expect(out).toBe('WHERE a = ? AND b = ? AND c = ?');
  });

  it("postgres: an identifier ending in e before a quote is not an E'' prefix", () => {
    const out = scrubSqlText(`WHERE d = date'C:\\' AND name = '${secret}'`, LEXICONS.postgresql);
    expect(out).toBe('WHERE d = date? AND name = ?');
  });

  it('mysql: backslash escapes a quote in every single-quoted string', () => {
    const out = scrubSqlText(`WHERE a = 'it\\'s' AND b = '${secret}'`, LEXICONS.mysql);
    expect(out).toBe('WHERE a = ? AND b = ?');
  });

  it('sqlite and mssql: a backslash is always literal', () => {
    for (const lexicon of [LEXICONS.sqlite, LEXICONS.mssql]) {
      const out = scrubSqlText(`WHERE path = 'C:\\' AND name = '${secret}'`, lexicon);
      expect(out).toBe('WHERE path = ? AND name = ?');
    }
  });

  it('unknown: a backslash inside a string blanks to end of input (fail closed)', () => {
    // Either reading could be right, so nothing after the ambiguous literal survives.
    const pg = scrubSqlText(`WHERE path = 'C:\\' AND name = '${secret}'`, LEXICONS.unknown);
    expect(norm(pg)).toBe('WHERE path =');
    const my = scrubSqlText(`WHERE a = 'it\\'s' AND b = '${secret}'`, LEXICONS.unknown);
    expect(norm(my)).toBe('WHERE a =');
    // A backslash-free literal is unambiguous and scrubs normally.
    expect(scrubSqlText("WHERE a = 'x' AND b = 1", LEXICONS.unknown)).toBe('WHERE a = ? AND b = 1');
  });

  it('defaults to the unknown lexicon when none is given', () => {
    expect(maskSqlText(`x = 'a\\' y = '${secret}'`)).not.toContain(secret);
    expect(scrubSqlText(`x = 'a\\' y = '${secret}'`).trim()).toBe('x =');
  });

  it('postgres, mssql and unknown: block comments nest', () => {
    for (const lexicon of [LEXICONS.postgresql, LEXICONS.mssql, LEXICONS.unknown]) {
      const out = scrubSqlText(`SELECT 1 /* a /* b */ ${secret} */ FROM t`, lexicon);
      expect(norm(out)).toBe('SELECT 1 FROM t');
    }
  });

  it('mysql and sqlite: block comments do not nest', () => {
    for (const lexicon of [LEXICONS.mysql, LEXICONS.sqlite]) {
      const out = scrubSqlText('SELECT 1 /* a /* b */ FROM t', lexicon);
      expect(norm(out)).toBe('SELECT 1 FROM t');
    }
  });

  it('mysql and unknown: # starts a line comment', () => {
    for (const lexicon of [LEXICONS.mysql, LEXICONS.unknown]) {
      const out = scrubSqlText(`SELECT 1 # ${secret}\nFROM t`, lexicon);
      expect(norm(out)).toBe('SELECT 1 FROM t');
    }
  });

  it('postgres, sqlite and mssql: # is not a comment', () => {
    for (const lexicon of [LEXICONS.postgresql, LEXICONS.sqlite, LEXICONS.mssql]) {
      expect(scrubSqlText('SELECT a # b FROM #tmp', lexicon)).toBe('SELECT a # b FROM #tmp');
    }
  });

  it('applies the lexicon to masking and identifier unquoting too', () => {
    const sql = `SELECT 1 /* a /* b */ ${secret} */ FROM t WHERE p = 'C:\\' AND n = '${secret}'`;
    expect(maskSqlText(sql, LEXICONS.postgresql)).not.toContain(secret);
    expect(maskSqlText(sql, LEXICONS.postgresql)).toContain('WHERE p =');
    expect(maskSqlTextUnquotingIdentifiers(sql, LEXICONS.postgresql)).not.toContain(secret);
    expect(maskSqlTextUnquotingIdentifiers(sql, LEXICONS.postgresql)).toContain('AND n =');
  });
});

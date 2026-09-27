import { describe, expect, it } from 'vitest';
import { fingerprintSql } from '../../src/analysis/fingerprint.js';
import { LEXICONS } from '../../src/analysis/lexicon.js';

describe('fingerprintSql', () => {
  it('replaces string literals', () => {
    expect(fingerprintSql("SELECT * FROM users WHERE email = 'bob@example.com'")).toBe(
      'SELECT * FROM users WHERE email = ?',
    );
  });

  it('handles escaped quotes inside strings', () => {
    expect(fingerprintSql("SELECT * FROM t WHERE name = 'O''Brien'")).toBe(
      'SELECT * FROM t WHERE name = ?',
    );
  });

  it('scrubs backslash-escaped quotes (MySQL) without leaking', () => {
    expect(fingerprintSql("SELECT * FROM t WHERE name = 'O\\'Brien'", LEXICONS.mysql)).toBe(
      'SELECT * FROM t WHERE name = ?',
    );
    expect(
      fingerprintSql("INSERT INTO t (pw) VALUES ('p\\'ssw0rd123secret')", LEXICONS.mysql),
    ).toBe('INSERT INTO t (pw) VALUES (?)');
  });

  it('leaves double-quoted text intact (identifiers in postgres/sqlite)', () => {
    expect(fingerprintSql('SELECT * FROM "orders" WHERE id = 1')).toBe(
      'SELECT * FROM "orders" WHERE id = ?',
    );
  });

  it('replaces dollar-quoted strings (tagged and untagged)', () => {
    expect(fingerprintSql('SELECT $$secret value$$')).toBe('SELECT ?');
    expect(fingerprintSql('SELECT $tag$ nested $$ inside $tag$')).toBe('SELECT ?');
  });

  it('replaces numeric, hex and uuid literals', () => {
    expect(fingerprintSql('SELECT * FROM t WHERE a = 42 AND b = 3.14 AND c = 0xDEADbeef')).toBe(
      'SELECT * FROM t WHERE a = ? AND b = ? AND c = ?',
    );
    expect(fingerprintSql("WHERE id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'")).toBe(
      'WHERE id = ?',
    );
    expect(fingerprintSql('WHERE id = a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11')).toBe('WHERE id = ?');
  });

  it('normalizes positional placeholders to ?', () => {
    expect(fingerprintSql('SELECT * FROM orders WHERE id = $1 AND status = $2')).toBe(
      'SELECT * FROM orders WHERE id = ? AND status = ?',
    );
    expect(fingerprintSql('SELECT * FROM orders WHERE id = @p1')).toBe(
      'SELECT * FROM orders WHERE id = ?',
    );
  });

  it('leaves ? placeholders intact', () => {
    expect(fingerprintSql('SELECT * FROM orders WHERE id = ?')).toBe(
      'SELECT * FROM orders WHERE id = ?',
    );
  });

  it('collapses IN lists of placeholders and literals', () => {
    expect(fingerprintSql('WHERE id IN (1, 2, 3)')).toBe('WHERE id IN (?)');
    expect(fingerprintSql('WHERE id IN ($1, $2, $3)')).toBe('WHERE id IN (?)');
    expect(fingerprintSql('WHERE id in (?,?,?)')).toBe('WHERE id IN (?)');
  });

  it('does not mangle identifiers containing digits', () => {
    expect(fingerprintSql('SELECT col1 FROM table2')).toBe('SELECT col1 FROM table2');
  });

  it('normalizes whitespace', () => {
    expect(fingerprintSql('SELECT *\n  FROM   orders\n WHERE id = 1')).toBe(
      'SELECT * FROM orders WHERE id = ?',
    );
  });

  it('does not catastrophically backtrack on an unterminated quote with backslashes', () => {
    const evil = "SELECT '" + '\\'.repeat(100);
    const start = performance.now();
    const result = fingerprintSql(evil);
    expect(performance.now() - start).toBeLessThan(500);
    expect(typeof result).toBe('string');
  });
});

describe('comment stripping', () => {
  it('removes line comments and their PII content', () => {
    expect(
      fingerprintSql('SELECT * FROM users WHERE id = 1 -- customer_email=alice@example.com'),
    ).toBe('SELECT * FROM users WHERE id = ?');
  });

  it('removes block comments and their content', () => {
    expect(fingerprintSql('SELECT 1 /* trace=abc123, request=xyz */ FROM t')).toBe(
      'SELECT ? FROM t',
    );
  });

  it('produces identical fingerprints regardless of comment content (grouping stability)', () => {
    const a = fingerprintSql('SELECT * FROM t WHERE id = $1 /* req=aaa111 */');
    const b = fingerprintSql('SELECT * FROM t WHERE id = $1 /* req=bbb222 */');
    expect(a).toBe(b);
    expect(a).toBe('SELECT * FROM t WHERE id = ?');
  });

  it('does not treat comment markers inside string literals as comments', () => {
    expect(fingerprintSql("SELECT '--keep', col FROM t")).toBe('SELECT ?, col FROM t');
    expect(fingerprintSql("SELECT '/* keep */', col FROM t")).toBe('SELECT ?, col FROM t');
  });

  it('preserves double-quoted identifiers containing comment markers', () => {
    expect(fingerprintSql('SELECT "a--b" FROM t')).toBe('SELECT "a--b" FROM t');
  });

  it('removes an unterminated block comment to end of input', () => {
    expect(fingerprintSql('SELECT 1 /* oops')).toBe('SELECT ?');
  });

  it('handles comments adjacent to literals', () => {
    expect(fingerprintSql("SELECT 'a'/* tag */ FROM t WHERE x = 1-- trailing")).toBe(
      'SELECT ? FROM t WHERE x = ?',
    );
  });

  it('does not leak comments trailing an unterminated dollar-quote (fail closed)', () => {
    const out = fingerprintSql('SELECT 1 WHERE x = $foo$ -- email=alice@example.com');
    expect(out).not.toContain('alice@example.com');
  });
});

describe('dialect-aware literal and comment scrubbing', () => {
  const secret = 'private@example.com';

  it('postgres: a literal ending in a backslash does not expose the next literal', () => {
    // Regression: MySQL escape rules applied to Postgres consumed 'C:\\' AND
    // name = ' as one literal and emitted the next literal's content as code.
    expect(
      fingerprintSql(
        `SELECT * FROM t WHERE path = 'C:\\' AND name = '${secret}'`,
        LEXICONS.postgresql,
      ),
    ).toBe('SELECT * FROM t WHERE path = ? AND name = ?');
  });

  it("postgres: E'' strings are one placeholder, with no stray E", () => {
    expect(fingerprintSql(`SELECT E'it\\'s', '${secret}'`, LEXICONS.postgresql)).toBe(
      'SELECT ?, ?',
    );
  });

  it('unknown dialect: an ambiguous backslash literal truncates rather than leaks', () => {
    expect(fingerprintSql(`SELECT * FROM t WHERE path = 'C:\\' AND name = '${secret}'`)).toBe(
      'SELECT * FROM t WHERE path =',
    );
  });

  it('postgres: nested block comments are stripped whole', () => {
    expect(fingerprintSql(`SELECT 1 /* outer /* inner */ ${secret} */`, LEXICONS.postgresql)).toBe(
      'SELECT ?',
    );
  });

  it('mysql: # comments are stripped', () => {
    expect(fingerprintSql(`SELECT 1 # ${secret}`, LEXICONS.mysql)).toBe('SELECT ?');
  });

  it('postgres: # stays an operator', () => {
    expect(fingerprintSql('SELECT a # b FROM t', LEXICONS.postgresql)).toBe('SELECT a # b FROM t');
  });

  it('grouping is independent of literal values and comment contents', () => {
    const pg = (v: string, tag: string) =>
      fingerprintSql(
        `SELECT 1 /* a /* ${tag} */ */ FROM t WHERE p = 'C:\\' AND n = '${v}'`,
        LEXICONS.postgresql,
      );
    expect(pg('alice', 'req=1')).toBe(pg('bob', 'req=2'));
    const my = (v: string, tag: string) =>
      fingerprintSql(`SELECT 1 # ${tag}\nFROM t WHERE p = 'a\\'b' AND n = '${v}'`, LEXICONS.mysql);
    expect(my('alice', 'req=1')).toBe(my('bob', 'req=2'));
  });
});

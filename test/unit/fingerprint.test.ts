import { describe, expect, it } from 'vitest';
import { fingerprintSql } from '../../src/analysis/fingerprint.js';

describe('fingerprintSql', () => {
  it('replaces string literals', () => {
    expect(fingerprintSql("SELECT * FROM users WHERE email = 'bob@example.com'"))
      .toBe('SELECT * FROM users WHERE email = ?');
  });

  it('handles escaped quotes inside strings', () => {
    expect(fingerprintSql("SELECT * FROM t WHERE name = 'O''Brien'"))
      .toBe('SELECT * FROM t WHERE name = ?');
  });

  it('scrubs backslash-escaped quotes (MySQL) without leaking', () => {
    expect(fingerprintSql("SELECT * FROM t WHERE name = 'O\\'Brien'"))
      .toBe('SELECT * FROM t WHERE name = ?');
    expect(fingerprintSql("INSERT INTO t (pw) VALUES ('p\\'ssw0rd123secret')"))
      .toBe('INSERT INTO t (pw) VALUES (?)');
  });

  it('leaves double-quoted text intact (identifiers in postgres/sqlite)', () => {
    expect(fingerprintSql('SELECT * FROM "orders" WHERE id = 1'))
      .toBe('SELECT * FROM "orders" WHERE id = ?');
  });

  it('replaces dollar-quoted strings (tagged and untagged)', () => {
    expect(fingerprintSql('SELECT $$secret value$$')).toBe('SELECT ?');
    expect(fingerprintSql('SELECT $tag$ nested $$ inside $tag$')).toBe('SELECT ?');
  });

  it('replaces numeric, hex and uuid literals', () => {
    expect(fingerprintSql('SELECT * FROM t WHERE a = 42 AND b = 3.14 AND c = 0xDEADbeef'))
      .toBe('SELECT * FROM t WHERE a = ? AND b = ? AND c = ?');
    expect(fingerprintSql("WHERE id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'")).toBe('WHERE id = ?');
    expect(fingerprintSql('WHERE id = a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11')).toBe('WHERE id = ?');
  });

  it('normalizes positional placeholders to ?', () => {
    expect(fingerprintSql('SELECT * FROM orders WHERE id = $1 AND status = $2'))
      .toBe('SELECT * FROM orders WHERE id = ? AND status = ?');
    expect(fingerprintSql('SELECT * FROM orders WHERE id = @p1'))
      .toBe('SELECT * FROM orders WHERE id = ?');
  });

  it('leaves ? placeholders intact', () => {
    expect(fingerprintSql('SELECT * FROM orders WHERE id = ?'))
      .toBe('SELECT * FROM orders WHERE id = ?');
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
    expect(fingerprintSql('SELECT *\n  FROM   orders\n WHERE id = 1'))
      .toBe('SELECT * FROM orders WHERE id = ?');
  });
});

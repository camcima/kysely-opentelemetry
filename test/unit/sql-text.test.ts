import { describe, expect, it } from 'vitest';
import { maskSqlText } from '../../src/analysis/sql-text.js';

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
    const masked = maskSqlText(input);
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

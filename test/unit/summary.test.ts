import { describe, expect, it } from 'vitest';
import { summarize } from '../../src/analysis/summary.js';

describe('summarize', () => {
  it('joins operation and tables with spaces', () => {
    expect(summarize('SELECT', ['orders'])).toBe('SELECT orders');
    expect(summarize('SELECT', ['orders', 'customers'])).toBe('SELECT orders customers');
  });

  it('falls back to unknown with no tables', () => {
    expect(summarize('CALL', [])).toBe('CALL unknown');
  });

  it('truncates to 255 chars', () => {
    const tables = Array.from({ length: 50 }, (_, i) => `very_long_table_name_${i}`);
    const summary = summarize('SELECT', tables);
    expect(summary.length).toBeLessThanOrEqual(255);
    expect(summary.startsWith('SELECT very_long_table_name_0')).toBe(true);
  });
});

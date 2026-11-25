import { describe, expect, it, vi } from 'vitest';
import { createAnalyzer } from '../../src/analysis/analyze.js';
import { normalizeOptions, type KyselyOtelOptions } from '../../src/options.js';
import { buildQueryAttributes } from '../../src/otel/attributes.js';
import { compileRaw } from '../helpers/compile.js';

// The scrubber is pure string processing and has no known way to throw, so
// the fail-closed path can only be reached by forcing it.
vi.mock('../../src/analysis/fingerprint.js', () => ({
  fingerprintSql: () => {
    throw new Error('scrubber failed');
  },
}));

const RAW = "SELECT * FROM users WHERE email = 'alice@example.com'";

function analyze(overrides: KyselyOtelOptions = {}) {
  const options = normalizeOptions(overrides);
  const ctx = createAnalyzer(options)(compileRaw(RAW));
  return { ctx, attrs: buildQueryAttributes(ctx, 'postgresql', options) };
}

describe('when the SQL scrubber throws', () => {
  it('omits query text, fingerprint and hash, and flags the span (sanitized mode)', () => {
    const { ctx, attrs } = analyze();
    expect(ctx.sanitizationError).toBe(true);
    expect(ctx.text).toBeUndefined();
    expect(attrs['kysely.query.sanitization_error']).toBe(true);
    expect(attrs['db.query.text']).toBeUndefined();
    expect(attrs['db.query.fingerprint']).toBeUndefined();
    expect(attrs['db.query.hash']).toBeUndefined();
    expect(JSON.stringify(attrs)).not.toContain('alice@example.com');
  });

  it('still emits the operation, summary and tables, which do not use the scrubber', () => {
    const { attrs } = analyze();
    expect(attrs['db.operation.name']).toBe('SELECT');
    expect(attrs['db.query.summary']).toBe('SELECT users');
    expect(attrs['db.collection.name']).toBe('users');
  });

  it('emits the compiled SQL in parameterized mode, which never relies on the scrubber', () => {
    // Documented: parameterized text is the raw compiled SQL and is emitted
    // regardless of any sanitization error.
    const { ctx, attrs } = analyze({ queryText: 'parameterized' });
    expect(ctx.sanitizationError).toBe(true);
    expect(attrs['db.query.text']).toBe(RAW);
    expect(attrs['kysely.query.sanitization_error']).toBe(true);
  });
});

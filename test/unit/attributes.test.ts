import { describe, expect, it } from 'vitest';
import { createAnalyzer } from '../../src/analysis/analyze.js';
import { normalizeOptions } from '../../src/options.js';
import { buildQueryAttributes } from '../../src/otel/attributes.js';
import { compile } from '../helpers/compile.js';

function attrsFor(overrides = {}) {
  const options = normalizeOptions(overrides);
  const ctx = createAnalyzer(options)(
    compile((db) => db.selectFrom('orders').selectAll().where('id', '=', 123)),
  );
  return { attrs: buildQueryAttributes(ctx, 'postgresql', options), ctx };
}

describe('buildQueryAttributes', () => {
  it('emits the full default attribute set', () => {
    const { attrs, ctx } = attrsFor();
    expect(attrs).toEqual({
      'db.system.name': 'postgresql',
      'db.operation.name': 'SELECT',
      'db.query.summary': 'SELECT orders',
      'db.query.text': ctx.fingerprint,
      'db.collection.name': 'orders',
      'db.query.fingerprint': ctx.fingerprint,
      'db.query.hash': ctx.hash,
      'kysely.query.tables': ['orders'],
      'kysely.query.parameter_count': 1,
    });
  });

  it('never includes parameter values', () => {
    const { attrs } = attrsFor();
    expect(JSON.stringify(attrs)).not.toContain('123');
  });

  it('honors feature toggles', () => {
    const { attrs } = attrsFor({ summary: false, tables: false, hash: false, fingerprint: false, queryText: 'off' });
    expect(attrs['db.query.summary']).toBeUndefined();
    expect(attrs['db.collection.name']).toBeUndefined();
    expect(attrs['kysely.query.tables']).toBeUndefined();
    expect(attrs['db.query.hash']).toBeUndefined();
    expect(attrs['db.query.fingerprint']).toBeUndefined();
    expect(attrs['db.query.text']).toBeUndefined();
  });

  it('merges the custom attributes hook and swallows hook failures', () => {
    const ok = attrsFor({ attributes: () => ({ 'my.attr': 'x' }) });
    expect(ok.attrs['my.attr']).toBe('x');

    const throwing = attrsFor({
      attributes: () => {
        throw new Error('boom');
      },
    });
    expect(throwing.attrs['db.operation.name']).toBe('SELECT'); // still built
  });
});

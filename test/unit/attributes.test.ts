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

  it('emits connection-level attributes when configured, omits them by default', () => {
    const configured = attrsFor({ namespace: 'shop', serverAddress: 'db.internal', serverPort: 5432 });
    expect(configured.attrs['db.namespace']).toBe('shop');
    expect(configured.attrs['server.address']).toBe('db.internal');
    expect(configured.attrs['server.port']).toBe(5432);

    const defaults = attrsFor();
    expect(defaults.attrs).not.toHaveProperty('db.namespace');
    expect(defaults.attrs).not.toHaveProperty('server.address');
    expect(defaults.attrs).not.toHaveProperty('server.port');
  });

  it('flags table-list truncation on the span', () => {
    const options = normalizeOptions();
    const cq = compile((db) => {
      let qb = db.selectFrom('t0').selectAll();
      for (let i = 1; i < 30; i += 1) {
        qb = qb.innerJoin(`t${i}`, `t${i}.id`, 't0.id') as typeof qb;
      }
      return qb;
    });
    const ctx = createAnalyzer(options)(cq);
    expect(ctx.tablesTruncated).toBe(true);
    const attrs = buildQueryAttributes(ctx, 'postgresql', options);
    expect(attrs['kysely.query.tables_truncated']).toBe(true);

    const { attrs: normal } = attrsFor();
    expect(normal).not.toHaveProperty('kysely.query.tables_truncated');
  });
});

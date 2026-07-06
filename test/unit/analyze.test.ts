import { describe, expect, it } from 'vitest';
import { createAnalyzer } from '../../src/analysis/analyze.js';
import { normalizeOptions } from '../../src/options.js';
import { compile, compileRaw } from '../helpers/compile.js';

const analyze = createAnalyzer(normalizeOptions());

describe('createAnalyzer', () => {
  it('produces a full QueryContext for a builder query', () => {
    const cq = compile((db) => db.selectFrom('orders').selectAll().where('id', '=', 123));
    const ctx = analyze(cq);
    expect(ctx.operation).toBe('SELECT');
    expect(ctx.tables).toEqual(['orders']);
    expect(ctx.primaryTable).toBe('orders');
    expect(ctx.summary).toBe('SELECT orders');
    expect(ctx.fingerprint).toBe('select * from "orders" where "id" = ?');
    expect(ctx.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(ctx.isRaw).toBe(false);
    expect(ctx.sanitizationError).toBe(false);
    expect(ctx.text).toBe(ctx.fingerprint);
    expect(ctx.parameters).toEqual([123]);
  });

  it('flags raw queries and uses best-effort tables', () => {
    const ctx = analyze(compileRaw("SELECT * FROM orders WHERE status = 'paid'"));
    expect(ctx.isRaw).toBe(true);
    expect(ctx.tables).toEqual(['orders']);
    expect(ctx.fingerprint).toBe('SELECT * FROM orders WHERE status = ?');
  });

  it('caches analysis by sql but not parameters', () => {
    const a = analyze(compile((db) => db.selectFrom('t').selectAll().where('id', '=', 1)));
    const b = analyze(compile((db) => db.selectFrom('t').selectAll().where('id', '=', 2)));
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.parameters).toEqual([1]);
    expect(b.parameters).toEqual([2]);
  });

  it('queryText off omits text', () => {
    const analyzeOff = createAnalyzer(normalizeOptions({ queryText: 'off' }));
    const ctx = analyzeOff(compile((db) => db.selectFrom('t').selectAll()));
    expect(ctx.text).toBeUndefined();
  });

  it('queryText parameterized emits compiled sql as-is', () => {
    const analyzeParam = createAnalyzer(normalizeOptions({ queryText: 'parameterized' }));
    const cq = compile((db) => db.selectFrom('t').selectAll().where('id', '=', 1));
    expect(analyzeParam(cq).text).toBe(cq.sql);
  });

  it('redact hook runs last and a throwing hook omits text', () => {
    const analyzeRedact = createAnalyzer(
      normalizeOptions({ redact: (sql) => sql.replace('orders', '[t]') }),
    );
    const ctx = analyzeRedact(compile((db) => db.selectFrom('orders').selectAll()));
    expect(ctx.text).toContain('[t]');
    expect(ctx.fingerprint).toContain('orders'); // fingerprint unaffected by redact

    const analyzeThrow = createAnalyzer(
      normalizeOptions({
        redact: () => {
          throw new Error('boom');
        },
      }),
    );
    expect(analyzeThrow(compile((db) => db.selectFrom('orders').selectAll())).text).toBeUndefined();
  });

  it('truncates fingerprint and text to maxQueryTextLength', () => {
    const analyzeShort = createAnalyzer(normalizeOptions({ maxQueryTextLength: 10 }));
    const ctx = analyzeShort(compile((db) => db.selectFrom('a_rather_long_table_name').selectAll()));
    expect(ctx.fingerprint.length).toBeLessThanOrEqual(10);
    expect((ctx.text ?? '').length).toBeLessThanOrEqual(10);
  });
});

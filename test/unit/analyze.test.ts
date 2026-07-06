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
    const ctx = analyzeShort(
      compile((db) => db.selectFrom('a_rather_long_table_name').selectAll()),
    );
    expect(ctx.fingerprint.length).toBeLessThanOrEqual(10);
    expect((ctx.text ?? '').length).toBeLessThanOrEqual(10);
  });

  it('hashes the full fingerprint, not the truncated one (no prefix collisions)', () => {
    const analyzeShort = createAnalyzer(normalizeOptions({ maxQueryTextLength: 12 }));
    const a = analyzeShort(compile((db) => db.selectFrom('orders_alpha').selectAll()));
    const b = analyzeShort(compile((db) => db.selectFrom('orders_beta').selectAll()));
    expect(a.fingerprint).toBe(b.fingerprint); // both truncated to the same 12-char prefix
    expect(a.hash).not.toBe(b.hash); // but hashes differ (computed pre-truncation)
  });

  it('freezes the cached tables array to protect the LRU', () => {
    const ctx = analyze(compile((db) => db.selectFrom('orders').selectAll()));
    expect(Object.isFrozen(ctx.tables)).toBe(true);
  });

  it('does not confuse a raw query with a builder query that compiles to identical sql', () => {
    const freshAnalyze = createAnalyzer(normalizeOptions());
    const builder = compile((db) => db.selectFrom('orders').selectAll());
    const raw = compileRaw(builder.sql);
    expect(raw.sql).toBe(builder.sql); // precondition: identical SQL text
    expect(freshAnalyze(raw).isRaw).toBe(true); // raw analyzed first, seeds the cache
    expect(freshAnalyze(builder).isRaw).toBe(false); // must NOT be served the raw entry
  });

  it('does not cache very large sql (memory bound) but still analyzes it', () => {
    const freshAnalyze = createAnalyzer(normalizeOptions());
    const bigSql = `SELECT * FROM orders WHERE note = '${'x'.repeat(40_000)}'`;
    const a = freshAnalyze(compileRaw(bigSql));
    const b = freshAnalyze(compileRaw(bigSql));
    expect(a.operation).toBe('SELECT');
    expect(a.tables).toEqual(['orders']);
    expect(a.tables).not.toBe(b.tables); // distinct analyses — not served from cache

    const small = freshAnalyze(compile((db) => db.selectFrom('orders').selectAll()));
    const smallAgain = freshAnalyze(compile((db) => db.selectFrom('orders').selectAll()));
    expect(small.tables).toBe(smallAgain.tables); // small SQL still uses the cache
  });
});

import { describe, expect, it } from 'vitest';
import { extractTables, extractTablesFromRawSql } from '../../src/analysis/tables.js';
import { compile } from '../helpers/compile.js';

describe('extractTables', () => {
  it('extracts the FROM table', () => {
    const cq = compile((db) => db.selectFrom('orders').selectAll());
    expect(extractTables(cq.query).tables).toEqual(['orders']);
  });

  it('extracts join tables in first-seen order, deduped', () => {
    const cq = compile((db) =>
      db
        .selectFrom('orders')
        .innerJoin('customers', 'customers.id', 'orders.customer_id')
        .leftJoin('customers as c2', 'c2.id', 'orders.customer_id')
        .selectAll(),
    );
    expect(extractTables(cq.query).tables).toEqual(['orders', 'customers']);
  });

  it('extracts tables from subqueries and CTEs', () => {
    const cq = compile((db) =>
      db
        .with('recent', (qb) => qb.selectFrom('events').selectAll())
        .selectFrom('recent')
        .selectAll(),
    );
    expect(extractTables(cq.query).tables).toContain('events');
  });

  it('qualifies schema-prefixed tables', () => {
    const cq = compile((db) => db.selectFrom('archive.orders').selectAll());
    expect(extractTables(cq.query).tables).toEqual(['archive.orders']);
  });

  it('extracts insert/update/delete targets', () => {
    const ins = compile((db) => db.insertInto('orders').values({ id: 1 }));
    expect(extractTables(ins.query).tables).toEqual(['orders']);
    const upd = compile((db) => db.updateTable('users').set({ id: 1 }));
    expect(extractTables(upd.query).tables).toEqual(['users']);
  });

  it('caps at 20 tables and flags truncation', () => {
    const cq = compile((db) => {
      let qb = db.selectFrom('t0').selectAll();
      for (let i = 1; i < 30; i += 1) {
        qb = qb.innerJoin(`t${i}`, `t${i}.id`, 't0.id') as typeof qb;
      }
      return qb;
    });
    const result = extractTables(cq.query);
    expect(result.tables).toHaveLength(20);
    expect(result.truncated).toBe(true);
  });

  it('reports truncated: false under the cap', () => {
    const cq = compile((db) => db.selectFrom('orders').selectAll());
    expect(extractTables(cq.query).truncated).toBe(false);
    expect(extractTablesFromRawSql('SELECT * FROM orders').truncated).toBe(false);
  });
});

describe('extractTablesFromRawSql', () => {
  it('finds FROM/JOIN/INTO/UPDATE targets', () => {
    expect(extractTablesFromRawSql('SELECT * FROM orders JOIN customers ON 1=1').tables).toEqual([
      'orders',
      'customers',
    ]);
    expect(extractTablesFromRawSql('INSERT INTO shipping_details VALUES (1)').tables).toEqual([
      'shipping_details',
    ]);
    expect(extractTablesFromRawSql('UPDATE public.users SET a = 1').tables).toEqual([
      'public.users',
    ]);
  });

  it('returns empty for unparsable SQL', () => {
    expect(extractTablesFromRawSql('CALL refresh()').tables).toEqual([]);
  });

  it('caps raw-SQL extraction at 20 tables and flags truncation', () => {
    const joins = Array.from({ length: 30 }, (_, i) => `JOIN t${i} ON 1=1`).join(' ');
    const result = extractTablesFromRawSql(`SELECT * FROM t_base ${joins}`);
    expect(result.tables).toHaveLength(20);
    expect(result.truncated).toBe(true);
  });

  it('excludes CTE aliases and puts main-statement tables before CTE-body tables', () => {
    const { tables } = extractTablesFromRawSql(
      'WITH agg AS (SELECT * FROM raw_events) INSERT INTO summary SELECT * FROM agg',
    );
    expect(tables).toEqual(['summary', 'raw_events']);
  });

  it('excludes all aliases of a multi-CTE query', () => {
    const { tables } = extractTablesFromRawSql(
      'WITH a AS (SELECT 1 FROM x), b AS (SELECT 2 FROM y) SELECT * FROM a JOIN b ON 1=1 JOIN z ON 1=1',
    );
    expect(tables).toEqual(['z', 'x', 'y']);
  });

  it('handles RECURSIVE and column-list CTE aliases', () => {
    const { tables } = extractTablesFromRawSql(
      'WITH RECURSIVE tree (id, parent) AS (SELECT id, parent FROM nodes) SELECT * FROM tree',
    );
    expect(tables).toEqual(['nodes']);
  });

  it('does not extract table names from comments or string literals', () => {
    expect(extractTablesFromRawSql('SELECT * FROM orders -- FROM fake_table\n').tables).toEqual([
      'orders',
    ]);
    expect(
      extractTablesFromRawSql("SELECT * FROM orders WHERE note = 'copied FROM haha'").tables,
    ).toEqual(['orders']);
  });
});

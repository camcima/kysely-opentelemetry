import { describe, expect, it } from 'vitest';
import { extractTables, extractTablesFromRawSql } from '../../src/analysis/tables.js';
import { compile } from '../helpers/compile.js';

describe('extractTables', () => {
  it('extracts the FROM table', () => {
    const cq = compile((db) => db.selectFrom('orders').selectAll());
    expect(extractTables(cq.query)).toEqual(['orders']);
  });

  it('extracts join tables in first-seen order, deduped', () => {
    const cq = compile((db) =>
      db
        .selectFrom('orders')
        .innerJoin('customers', 'customers.id', 'orders.customer_id')
        .leftJoin('customers as c2', 'c2.id', 'orders.customer_id')
        .selectAll(),
    );
    expect(extractTables(cq.query)).toEqual(['orders', 'customers']);
  });

  it('extracts tables from subqueries and CTEs', () => {
    const cq = compile((db) =>
      db
        .with('recent', (qb) => qb.selectFrom('events').selectAll())
        .selectFrom('recent')
        .selectAll(),
    );
    expect(extractTables(cq.query)).toContain('events');
  });

  it('qualifies schema-prefixed tables', () => {
    const cq = compile((db) => db.selectFrom('archive.orders').selectAll());
    expect(extractTables(cq.query)).toEqual(['archive.orders']);
  });

  it('extracts insert/update/delete targets', () => {
    const ins = compile((db) => db.insertInto('orders').values({ id: 1 }));
    expect(extractTables(ins.query)).toEqual(['orders']);
    const upd = compile((db) => db.updateTable('users').set({ id: 1 }));
    expect(extractTables(upd.query)).toEqual(['users']);
  });

  it('caps at 20 tables', () => {
    const cq = compile((db) => {
      let qb = db.selectFrom('t0').selectAll();
      for (let i = 1; i < 30; i += 1) {
        qb = qb.innerJoin(`t${i}`, `t${i}.id`, 't0.id') as typeof qb;
      }
      return qb;
    });
    expect(extractTables(cq.query)).toHaveLength(20);
  });
});

describe('extractTablesFromRawSql', () => {
  it('finds FROM/JOIN/INTO/UPDATE targets', () => {
    expect(extractTablesFromRawSql('SELECT * FROM orders JOIN customers ON 1=1')).toEqual([
      'orders',
      'customers',
    ]);
    expect(extractTablesFromRawSql('INSERT INTO shipping_details VALUES (1)')).toEqual([
      'shipping_details',
    ]);
    expect(extractTablesFromRawSql('UPDATE public.users SET a = 1')).toEqual(['public.users']);
  });

  it('returns empty for unparsable SQL', () => {
    expect(extractTablesFromRawSql('CALL refresh()')).toEqual([]);
  });
});

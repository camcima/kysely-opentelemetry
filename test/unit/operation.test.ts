import { describe, expect, it } from 'vitest';
import { operationName } from '../../src/analysis/operation.js';
import { compile, compileRaw } from '../helpers/compile.js';

describe('operationName', () => {
  it('maps DML query node kinds', () => {
    const select = compile((db) => db.selectFrom('orders').selectAll());
    expect(operationName(select.query, select.sql)).toBe('SELECT');

    const insert = compile((db) => db.insertInto('orders').values({ id: 1 }));
    expect(operationName(insert.query, insert.sql)).toBe('INSERT');

    const update = compile((db) => db.updateTable('orders').set({ id: 2 }).where('id', '=', 1));
    expect(operationName(update.query, update.sql)).toBe('UPDATE');

    const del = compile((db) => db.deleteFrom('orders').where('id', '=', 1));
    expect(operationName(del.query, del.sql)).toBe('DELETE');
  });

  it('maps DDL node kinds to spaced verbs', () => {
    const create = compile((db) => db.schema.createTable('t').addColumn('id', 'integer'));
    expect(operationName(create.query, create.sql)).toBe('CREATE TABLE');

    const drop = compile((db) => db.schema.dropTable('t'));
    expect(operationName(drop.query, drop.sql)).toBe('DROP TABLE');
  });

  it('derives raw SQL operation from the first keyword', () => {
    const cq = compileRaw('CALL refresh_customer_stats()');
    expect(operationName(cq.query, cq.sql)).toBe('CALL');
  });

  it('falls back to SQL for unrecognizable raw text', () => {
    const cq = compileRaw('!!!');
    expect(operationName(cq.query, cq.sql)).toBe('SQL');
  });
});

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

  it('names a raw CTE query after its main verb, not WITH', () => {
    const select = compileRaw('WITH recent AS (SELECT * FROM orders) SELECT * FROM recent');
    expect(operationName(select.query, select.sql)).toBe('SELECT');

    const del = compileRaw(
      'WITH stale AS (SELECT id FROM orders WHERE created < now()) DELETE FROM orders WHERE id IN (SELECT id FROM stale)',
    );
    expect(operationName(del.query, del.sql)).toBe('DELETE');
  });

  it('handles RECURSIVE and multiple raw CTEs', () => {
    const recursive = compileRaw('WITH RECURSIVE tree AS (SELECT 1) SELECT * FROM tree');
    expect(operationName(recursive.query, recursive.sql)).toBe('SELECT');

    const multi = compileRaw(
      'WITH a AS (SELECT 1), b AS (SELECT 2) INSERT INTO log SELECT * FROM a',
    );
    expect(operationName(multi.query, multi.sql)).toBe('INSERT');
  });

  it('sees past a data-modifying raw CTE to the outer verb', () => {
    const cq = compileRaw(
      'WITH moved AS (DELETE FROM orders WHERE done RETURNING *) INSERT INTO archive SELECT * FROM moved',
    );
    expect(operationName(cq.query, cq.sql)).toBe('INSERT');
  });

  it('falls back to WITH when a raw CTE has no recognizable outer verb', () => {
    const cq = compileRaw('WITH t AS (SELECT 1)');
    expect(operationName(cq.query, cq.sql)).toBe('WITH');
  });

  it('ignores verbs inside SQL comments', () => {
    const line = compileRaw('WITH t AS (SELECT 1) -- then delete stale rows\nSELECT * FROM t');
    expect(operationName(line.query, line.sql)).toBe('SELECT');

    const block = compileRaw(
      'WITH a AS (SELECT 1), /* delete expired rows */ b AS (SELECT 2) INSERT INTO log SELECT * FROM a',
    );
    expect(operationName(block.query, block.sql)).toBe('INSERT');
  });

  it('skips leading comments when finding the first keyword', () => {
    const line = compileRaw('-- note\nSELECT 1');
    expect(operationName(line.query, line.sql)).toBe('SELECT');

    const block = compileRaw('/* hint */ WITH t AS (SELECT 1) SELECT * FROM t');
    expect(operationName(block.query, block.sql)).toBe('SELECT');
  });

  it('is not confused by parentheses inside string literals', () => {
    const cq = compileRaw(
      "WITH x AS (SELECT ':)' AS s, id FROM a UNION SELECT one FROM b) DELETE FROM t",
    );
    expect(operationName(cq.query, cq.sql)).toBe('DELETE');
  });

  it('is not confused by quoted identifiers named like verbs', () => {
    const dq = compileRaw('WITH "select" AS (SELECT 1) INSERT INTO t SELECT * FROM "select"');
    expect(operationName(dq.query, dq.sql)).toBe('INSERT');

    const bt = compileRaw('WITH `select` AS (SELECT 1) INSERT INTO t SELECT * FROM `select`');
    expect(operationName(bt.query, bt.sql)).toBe('INSERT');
  });

  it('is not confused by dollar-quoted bodies with unbalanced parens', () => {
    const cq = compileRaw(
      'WITH f AS (SELECT $tag$ ) delete $tag$ AS body FROM x) INSERT INTO t SELECT 1',
    );
    expect(operationName(cq.query, cq.sql)).toBe('INSERT');
  });

  it('falls back to WITH on an unterminated string rather than guessing', () => {
    const cq = compileRaw("WITH t AS (SELECT 'oops) DELETE FROM x");
    expect(operationName(cq.query, cq.sql)).toBe('WITH');
  });

  it('does not route with_-prefixed identifiers into the CTE scanner', () => {
    const cq = compileRaw('with_helper_refresh()');
    expect(operationName(cq.query, cq.sql)).toBe('WITH_HELPER_REFRESH');
  });
});

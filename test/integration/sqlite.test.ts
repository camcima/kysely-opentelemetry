import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { observeDialect } from '../../src/index.js';
import { setupOtel } from '../helpers/otel.js';

let otel: ReturnType<typeof setupOtel>;
let db: Kysely<any>;

beforeEach(async () => {
  otel = setupOtel();
  db = new Kysely<any>({
    dialect: observeDialect(new SqliteDialect({ database: new Database(':memory:') })),
  });
  await db.schema
    .createTable('orders')
    .addColumn('id', 'integer', (col) => col.primaryKey())
    .addColumn('status', 'text')
    .execute();
  otel.spanExporter.reset();
});

afterEach(async () => {
  await db.destroy();
  await otel.teardown();
});

describe('sqlite end-to-end', () => {
  it('traces insert, select, update, delete with sqlite system name', async () => {
    await db.insertInto('orders').values({ id: 1, status: 'paid' }).execute();
    await db.selectFrom('orders').selectAll().where('id', '=', 1).execute();
    await db.updateTable('orders').set({ status: 'shipped' }).where('id', '=', 1).execute();
    await db.deleteFrom('orders').where('id', '=', 1).execute();

    const spans = otel.spanExporter.getFinishedSpans();
    expect(spans.map((s) => s.name)).toEqual([
      'INSERT orders',
      'SELECT orders',
      'UPDATE orders',
      'DELETE orders',
    ]);
    for (const span of spans) {
      expect(span.attributes['db.system.name']).toBe('sqlite');
      expect(JSON.stringify(span.attributes)).not.toContain('paid');
    }
    const update = spans.find((s) => s.name === 'UPDATE orders')!;
    expect(update.attributes['kysely.query.affected_rows']).toBe(1);
  });

  it('traces a committed transaction with nested query spans', async () => {
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('orders').values({ id: 2, status: 'new' }).execute();
    });
    const spans = otel.spanExporter.getFinishedSpans();
    const tx = spans.find((s) => s.name === 'TRANSACTION')!;
    expect(tx.attributes['kysely.transaction.outcome']).toBe('committed');
    const insert = spans.find((s) => s.name === 'INSERT orders')!;
    expect(insert.parentSpanContext?.spanId).toBe(tx.spanContext().spanId);
  });

  it('traces a failed query with error status and rethrows', async () => {
    await expect(db.selectFrom('missing_table').selectAll().execute()).rejects.toThrow();
    const span = otel.spanExporter
      .getFinishedSpans()
      .find((s) => s.name === 'SELECT missing_table')!;
    expect(span.status.code).toBe(2); // SpanStatusCode.ERROR
  });

  it('traces streamed queries', async () => {
    await db
      .insertInto('orders')
      .values([{ id: 3 }, { id: 4 }])
      .execute();
    otel.spanExporter.reset();
    const rows: unknown[] = [];
    for await (const row of db.selectFrom('orders').selectAll().stream()) {
      rows.push(row);
    }
    expect(rows).toHaveLength(2);
    const span = otel.spanExporter.getFinishedSpans().find((s) => s.name === 'SELECT orders')!;
    expect(span.attributes['db.response.returned_rows']).toBe(2);
  });
});

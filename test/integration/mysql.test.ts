import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { Kysely, MysqlDialect, sql } from 'kysely';
import { createPool, type Pool } from 'mysql2';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { observeDialect } from '../../src/index.js';
import { setupOtel } from '../helpers/otel.js';

let container: StartedMySqlContainer;
let pool: Pool;
let otel: ReturnType<typeof setupOtel>;
let db: Kysely<any>;

beforeAll(async () => {
  container = await new MySqlContainer('mysql:8.4').start();
  pool = createPool({ uri: container.getConnectionUri() });
}, 240_000);

afterAll(async () => {
  // IMPORTANT (lesson from Task 17/Postgres): the pool MUST be closed before
  // the container is stopped. Stopping the container while mysql2 still has
  // open connections in the pool causes an unhandled "connection terminated"
  // style error and a non-zero process exit even though all tests pass.
  // mysql2's `createPool` returns the callback-style Pool, whose `end()` takes
  // a callback rather than returning a promise, so we wrap it here.
  await new Promise<void>((resolve, reject) => {
    pool.end((err) => (err ? reject(err) : resolve()));
  });
  await container.stop();
});

beforeEach(async () => {
  otel = setupOtel();
  // A fresh Kysely/observeDialect wrapper is built around the *shared* pool
  // for every test. We must NOT call db.destroy() in afterEach: Kysely's
  // MysqlDriver.destroy() ends the underlying pool, which would break every
  // subsequent test sharing that same pool (same trap documented in Task 17).
  db = new Kysely<any>({ dialect: observeDialect(new MysqlDialect({ pool })) });
  await sql`CREATE TABLE IF NOT EXISTS orders (id int PRIMARY KEY, status varchar(32))`.execute(db);
  await sql`TRUNCATE orders`.execute(db);
  otel.spanExporter.reset();
});

afterEach(async () => {
  await otel.teardown();
});

describe('mysql end-to-end', () => {
  it('traces CRUD with mysql system name', async () => {
    await db.insertInto('orders').values({ id: 1, status: 'paid' }).execute();
    await db.selectFrom('orders').selectAll().where('id', '=', 1).execute();

    const select = otel.spanExporter.getFinishedSpans().find((s) => s.name === 'SELECT orders')!;
    expect(select.attributes['db.system.name']).toBe('mysql');
    expect(JSON.stringify(select.attributes)).not.toContain('paid');
  });

  it('reports affected rows on update', async () => {
    await db.insertInto('orders').values({ id: 2, status: 'new' }).execute();
    await db.updateTable('orders').set({ status: 'done' }).where('id', '=', 2).execute();
    const update = otel.spanExporter.getFinishedSpans().find((s) => s.name === 'UPDATE orders')!;
    expect(update.attributes['kysely.query.affected_rows']).toBe(1);
  });

  it('traces committed transactions with nesting', async () => {
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('orders').values({ id: 3, status: 'tx' }).execute();
    });
    const spans = otel.spanExporter.getFinishedSpans();
    const tx = spans.find((s) => s.name === 'TRANSACTION')!;
    const insert = spans.find((s) => s.name === 'INSERT orders')!;
    expect(tx.attributes['kysely.transaction.outcome']).toBe('committed');
    expect(insert.parentSpanContext?.spanId).toBe(tx.spanContext().spanId);
  });
});

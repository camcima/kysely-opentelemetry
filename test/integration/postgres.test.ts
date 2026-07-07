import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { observeDialect } from '../../src/index.js';
import { setupOtel } from '../helpers/otel.js';

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let otel: ReturnType<typeof setupOtel>;
let db: Kysely<any>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
}, 180_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  otel = setupOtel();
  db = new Kysely<any>({ dialect: observeDialect(new PostgresDialect({ pool })) });
  await sql`CREATE TABLE IF NOT EXISTS orders (id int PRIMARY KEY, status text)`.execute(db);
  await sql`TRUNCATE orders`.execute(db);
  otel.spanExporter.reset();
});

afterEach(async () => {
  await otel.teardown();
});

describe('postgres end-to-end', () => {
  it('traces CRUD with postgresql system name and pool acquire timing', async () => {
    await db.insertInto('orders').values({ id: 1, status: 'paid' }).execute();
    await db.selectFrom('orders').selectAll().where('status', '=', 'paid').execute();

    const spans = otel.spanExporter.getFinishedSpans();
    const select = spans.find((s) => s.name === 'SELECT orders')!;
    expect(select.attributes['db.system.name']).toBe('postgresql');
    expect(select.attributes['db.query.fingerprint']).toContain('= ?');
    expect(JSON.stringify(select.attributes)).not.toContain('paid');

    const waitTime = await otel.findMetric('db.client.connection.wait_time');
    expect(waitTime).toBeDefined();
    expect((waitTime!.dataPoints[0] as any).attributes['db.client.connection.pool.name']).toBe(
      'postgresql',
    );
  });

  it('traces rolled-back transactions', async () => {
    await expect(
      db.transaction().execute(async (trx) => {
        await trx.insertInto('orders').values({ id: 2, status: 'x' }).execute();
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');
    const tx = otel.spanExporter.getFinishedSpans().find((s) => s.name === 'TRANSACTION')!;
    expect(tx.attributes['kysely.transaction.outcome']).toBe('rolled_back');
  });

  it('captures postgres error codes as error.type', async () => {
    await db.insertInto('orders').values({ id: 3, status: 'a' }).execute();
    await expect(
      db.insertInto('orders').values({ id: 3, status: 'b' }).execute(),
    ).rejects.toThrow();
    const failed = otel.spanExporter
      .getFinishedSpans()
      .find((s) => s.attributes['error.type'] !== undefined)!;
    expect(failed.attributes['error.type']).toBe('23505'); // unique_violation
  });

  it('flags raw sql queries', async () => {
    await sql`SELECT count(*) FROM orders WHERE status = ${'paid'}`.execute(db);
    const span = otel.spanExporter.getFinishedSpans().at(-1)!;
    expect(span.attributes['kysely.query.raw']).toBe(true);
    expect(span.attributes['kysely.query.tables']).toEqual(['orders']);
    expect(JSON.stringify(span.attributes)).not.toContain('paid');
  });
});

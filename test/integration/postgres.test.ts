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

  it('cancels an aborted query on the server through the wrapped connection', async () => {
    // Kysely 0.29 calls collectSessionInfo() and cancelQuery() on the
    // connection the driver handed out, which is the ObservedConnection.
    const controller = new AbortController();
    const query = sql`SELECT pg_sleep(30)`.execute(db, {
      signal: controller.signal,
      inflightQueryAbortStrategy: 'cancel query',
    });
    await new Promise((resolve) => setTimeout(resolve, 300)); // let it reach the server
    controller.abort();
    await expect(query).rejects.toThrow();

    // pg_cancel_backend reached the real pg connection: the sleep stops server-side.
    await expect
      .poll(
        async () => {
          const { rows } = await sql<{ n: number }>`
            SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE state = 'active' AND query LIKE 'SELECT pg_sleep%'`.execute(db);
          return rows[0]!.n;
        },
        { timeout: 5_000 },
      )
      .toBe(0);
    // The cancelled query's span records Postgres's query_canceled code.
    await expect
      .poll(
        () =>
          otel.spanExporter
            .getFinishedSpans()
            .find((s) => s.attributes['db.query.text'] === 'SELECT pg_sleep(?)')?.attributes[
            'error.type'
          ],
        { timeout: 5_000 },
      )
      .toBe('57014');
  });

  it('flags raw sql queries', async () => {
    await sql`SELECT count(*) FROM orders WHERE status = ${'paid'}`.execute(db);
    const span = otel.spanExporter.getFinishedSpans().at(-1)!;
    expect(span.attributes['kysely.query.raw']).toBe(true);
    expect(span.attributes['kysely.query.tables']).toEqual(['orders']);
    expect(JSON.stringify(span.attributes)).not.toContain('paid');
  });
});

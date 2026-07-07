import {
  MSSQLServerContainer,
  type StartedMSSQLServerContainer,
} from '@testcontainers/mssqlserver';
import { Kysely, MssqlDialect, sql } from 'kysely';
import * as Tarn from 'tarn';
import * as Tedious from 'tedious';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { observeDialect } from '../../src/index.js';
import { setupOtel } from '../helpers/otel.js';

let container: StartedMSSQLServerContainer;
let otel: ReturnType<typeof setupOtel>;
let db: Kysely<any>;

// Kysely's MssqlDialect owns its own tarn pool, so we build a fresh dialect
// (and pool, min: 0) per test and destroy it in afterEach — that also lets each
// test's db pick up the per-test in-memory tracer provider from setupOtel().
function makeDialect(): MssqlDialect {
  return new MssqlDialect({
    tarn: { ...Tarn, options: { min: 0, max: 5 } },
    tedious: {
      ...Tedious,
      connectionFactory: () =>
        new Tedious.Connection({
          authentication: {
            type: 'default',
            options: { userName: container.getUsername(), password: container.getPassword() },
          },
          options: {
            database: container.getDatabase(),
            port: container.getPort(),
            trustServerCertificate: true,
          },
          server: container.getHost(),
        }),
    },
    validateConnections: false,
  });
}

beforeAll(async () => {
  container = await new MSSQLServerContainer('mcr.microsoft.com/mssql/server:2022-latest')
    .acceptLicense()
    .start();
}, 300_000);

afterAll(async () => {
  await container.stop();
});

beforeEach(async () => {
  otel = setupOtel();
  db = new Kysely<any>({ dialect: observeDialect(makeDialect()) });
  await sql`IF OBJECT_ID('dbo.orders', 'U') IS NULL CREATE TABLE orders (id int PRIMARY KEY, status nvarchar(32))`.execute(
    db,
  );
  await sql`DELETE FROM orders`.execute(db);
  otel.spanExporter.reset();
});

afterEach(async () => {
  await db.destroy();
  await otel.teardown();
});

describe('mssql end-to-end', () => {
  it('traces CRUD with microsoft.sql_server system name and no parameter leak', async () => {
    await db.insertInto('orders').values({ id: 1, status: 'paid' }).execute();
    await db.selectFrom('orders').selectAll().where('id', '=', 1).execute();

    const select = otel.spanExporter.getFinishedSpans().find((s) => s.name === 'SELECT orders')!;
    expect(select.attributes['db.system.name']).toBe('microsoft.sql_server');
    expect(JSON.stringify(select.attributes)).not.toContain('paid');
  });

  it('traces committed transactions with query spans nested under TRANSACTION', async () => {
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('orders').values({ id: 2, status: 'tx' }).execute();
    });
    const spans = otel.spanExporter.getFinishedSpans();
    const tx = spans.find((s) => s.name === 'TRANSACTION')!;
    const insert = spans.find((s) => s.name === 'INSERT orders')!;
    expect(tx.attributes['kysely.transaction.outcome']).toBe('committed');
    expect(insert.parentSpanContext?.spanId).toBe(tx.spanContext().spanId);
  });

  it('captures a failed query as error status with an error.type', async () => {
    await db.insertInto('orders').values({ id: 3, status: 'a' }).execute();
    await expect(
      db.insertInto('orders').values({ id: 3, status: 'b' }).execute(),
    ).rejects.toThrow();

    const failed = otel.spanExporter
      .getFinishedSpans()
      .find((s) => s.attributes['error.type'] !== undefined)!;
    expect(failed).toBeDefined();
    expect(failed.status.code).toBe(2); // SpanStatusCode.ERROR
  });
});

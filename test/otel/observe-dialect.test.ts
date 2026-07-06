import { Kysely, type CompiledQuery } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { observeDialect, ObservedDialect } from '../../src/index.js';
import { createFakeDialect } from '../helpers/fake-dialect.js';
import { setupOtel } from '../helpers/otel.js';

let otel: ReturnType<typeof setupOtel>;

beforeEach(() => {
  otel = setupOtel();
});

afterEach(async () => {
  await otel.teardown();
});

function makeDb(script?: (cq: CompiledQuery) => { rows: any[] }, options = {}) {
  const { dialect, driver } = createFakeDialect(script);
  const db = new Kysely<any>({ dialect: observeDialect(dialect, options) });
  return { db, driver };
}

describe('observeDialect end-to-end', () => {
  it('emits a span for a query executed through Kysely', async () => {
    const { db } = makeDb(() => ({ rows: [{ id: 1, secret: 'hunter2' }] }));
    await db.selectFrom('orders').selectAll().where('customer_email', '=', 'bob@example.com').execute();

    const spans = otel.spanExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe('SELECT orders');
    expect(spans[0]!.attributes['db.system.name']).toBe('postgresql'); // auto-detected
  });

  it('NO-PII: parameter values and row data never appear in any attribute', async () => {
    const { db } = makeDb(() => ({ rows: [{ secret: 'hunter2' }] }));
    await db
      .selectFrom('users')
      .selectAll()
      .where('email', '=', 'bob@example.com')
      .where('ssn', '=', '123-45-6789')
      .execute();

    for (const span of otel.spanExporter.getFinishedSpans()) {
      const all = JSON.stringify(span.attributes) + JSON.stringify(span.events);
      expect(all).not.toContain('bob@example.com');
      expect(all).not.toContain('123-45-6789');
      expect(all).not.toContain('hunter2');
    }
  });

  it('transaction produces nested spans through the Kysely transaction API', async () => {
    const { db } = makeDb();
    await db.transaction().execute(async (trx) => {
      await trx.selectFrom('orders').selectAll().execute();
    });
    const spans = otel.spanExporter.getFinishedSpans();
    const tx = spans.find((s) => s.name === 'TRANSACTION')!;
    const query = spans.find((s) => s.name === 'SELECT orders')!;
    expect(tx.attributes['kysely.transaction.outcome']).toBe('committed');
    expect(query.parentSpanContext?.spanId).toBe(tx.spanContext().spanId);
  });

  it('records the duration metric end-to-end', async () => {
    const { db } = makeDb();
    await db.selectFrom('orders').selectAll().execute();
    const metricData = await otel.collectMetrics();
    const metric = metricData
      .flatMap((rm) => rm.scopeMetrics)
      .flatMap((sm) => sm.metrics)
      .find((m) => m.descriptor.name === 'db.client.operation.duration');
    expect(metric).toBeDefined();
  });

  it('enabled: false returns the dialect untouched (zero overhead, zero spans)', async () => {
    const { dialect } = createFakeDialect();
    const observed = observeDialect(dialect, { enabled: false });
    expect(observed).toBe(dialect);
  });

  it('metrics: false emits spans but no metric', async () => {
    const { db } = makeDb(undefined, { metrics: false });
    await db.selectFrom('orders').selectAll().execute();
    expect(otel.spanExporter.getFinishedSpans()).toHaveLength(1);
    const metricData = await otel.collectMetrics();
    const metric = metricData
      .flatMap((rm) => rm.scopeMetrics)
      .flatMap((sm) => sm.metrics)
      .find((m) => m.descriptor.name === 'db.client.operation.duration');
    expect(metric).toBeUndefined();
  });

  it('dbSystem option overrides auto-detection', async () => {
    const { db } = makeDb(undefined, { dbSystem: 'cockroachdb' });
    await db.selectFrom('orders').selectAll().execute();
    expect(otel.spanExporter.getFinishedSpans()[0]!.attributes['db.system.name']).toBe('cockroachdb');
  });

  it('query errors propagate unchanged to the caller', async () => {
    const boom = new Error('connection reset');
    const { db } = makeDb(() => {
      throw boom;
    });
    await expect(db.selectFrom('orders').selectAll().execute()).rejects.toBe(boom);
  });

  it('returns an already-observed dialect unchanged (no double instrumentation)', () => {
    const { dialect } = createFakeDialect();
    const once = observeDialect(dialect);
    expect(observeDialect(once)).toBe(once);
  });

  it('ObservedDialect is directly constructible with public options', async () => {
    const { dialect } = createFakeDialect();
    const db = new Kysely<any>({ dialect: new ObservedDialect(dialect, { dbSystem: 'cockroachdb' }) });
    await db.selectFrom('orders').selectAll().execute();
    expect(otel.spanExporter.getFinishedSpans()[0]!.attributes['db.system.name']).toBe('cockroachdb');
  });
});

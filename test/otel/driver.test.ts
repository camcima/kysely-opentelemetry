import { metrics, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAnalyzer } from '../../src/analysis/analyze.js';
import { ObservedConnection } from '../../src/observed-connection.js';
import { ObservedDriver } from '../../src/observed-driver.js';
import { normalizeOptions, type KyselyOtelOptions } from '../../src/options.js';
import {
  createDurationHistogram,
  createWaitTimeHistogram,
  resolveWaitTimeAttributes,
} from '../../src/otel/metrics.js';
import { compile } from '../helpers/compile.js';
import { createFakeDialect } from '../helpers/fake-dialect.js';
import { setupOtel } from '../helpers/otel.js';

let otel: ReturnType<typeof setupOtel>;

beforeEach(() => {
  otel = setupOtel();
});

afterEach(async () => {
  await otel.teardown();
});

function makeDriver(
  overrides: KyselyOtelOptions = {},
  script: () => { rows: any[] } = () => ({ rows: [] }),
) {
  const options = normalizeOptions(overrides);
  const { driver: fakeDriver } = createFakeDialect(script);
  const meter = metrics.getMeter('test');
  const driver = new ObservedDriver(fakeDriver, {
    options,
    analyze: createAnalyzer(options),
    tracer: trace.getTracer('test'),
    ...(options.metrics.operationDuration && { histogram: createDurationHistogram(meter) }),
    ...(options.metrics.connectionWaitTime && {
      waitTimeHistogram: createWaitTimeHistogram(meter),
      waitTimeAttributes: resolveWaitTimeAttributes(options, 'postgresql'),
    }),
    dbSystem: 'postgresql',
  });
  return { driver, fakeDriver };
}

const SELECT = compile((db) => db.selectFrom('orders').selectAll());

describe('ObservedDriver connection wrapping', () => {
  it('wraps acquired connections, reusing one wrapper per inner connection', async () => {
    const { driver } = makeDriver();
    const first = await driver.acquireConnection();
    await driver.releaseConnection(first);
    const second = await driver.acquireConnection();
    expect(first).toBeInstanceOf(ObservedConnection);
    expect(second).toBe(first);
  });

  it('records acquire duration on the wrapper for the first query span', async () => {
    const { driver, fakeDriver } = makeDriver();
    fakeDriver.acquireDelayMs = 15;
    const connection = (await driver.acquireConnection()) as ObservedConnection;
    expect(connection.acquireDurationMs).toBeGreaterThanOrEqual(10);
  });

  it('records the connection wait_time metric on acquire with a pool name', async () => {
    const { driver } = makeDriver({ serverAddress: 'db.internal', serverPort: 5432 });
    await driver.acquireConnection();
    const metric = await otel.findMetric('db.client.connection.wait_time');
    expect(metric).toBeDefined();
    const point = metric!.dataPoints[0] as any;
    expect(point.value.count).toBe(1);
    expect(point.attributes['db.client.connection.pool.name']).toBe('db.internal:5432');
  });

  it('records no wait_time metric when metrics are disabled', async () => {
    const { driver } = makeDriver({ metrics: false });
    await driver.acquireConnection();
    expect(await otel.findMetric('db.client.connection.wait_time')).toBeUndefined();
  });

  it('records the wait_time value in seconds reflecting the real elapsed wait', async () => {
    const { driver, fakeDriver } = makeDriver();
    fakeDriver.acquireDelayMs = 15;
    await driver.acquireConnection();
    const metric = await otel.findMetric('db.client.connection.wait_time');
    const point = metric!.dataPoints[0] as any;
    // Guards the ms→s conversion: a double-conversion or dropped measurement
    // would record ~0.000015 or 0, a missed conversion would record ~15.
    expect(point.value.sum).toBeGreaterThanOrEqual(0.01);
    expect(point.value.sum).toBeLessThan(2);
  });

  it('always passes the INNER connection to the inner driver', async () => {
    const { driver, fakeDriver } = makeDriver();
    const connection = await driver.acquireConnection();
    await driver.beginTransaction(connection, {});
    await driver.commitTransaction(connection);
    await driver.beginTransaction(connection, {});
    await driver.rollbackTransaction(connection);
    await driver.releaseConnection(connection);
    expect(fakeDriver.calls.filter((c) => c.endsWith(':WRAPPED'))).toEqual([]);
  });
});

describe('ObservedDriver transaction spans', () => {
  it('wraps begin→commit in a TRANSACTION span with query spans as children', async () => {
    const { driver } = makeDriver();
    const connection = await driver.acquireConnection();
    await driver.beginTransaction(connection, {});
    await connection.executeQuery(SELECT);
    await driver.commitTransaction(connection);

    const spans = otel.spanExporter.getFinishedSpans();
    const txSpan = spans.find((s) => s.name === 'TRANSACTION')!;
    const querySpan = spans.find((s) => s.name === 'SELECT orders')!;
    expect(txSpan).toBeDefined();
    expect(txSpan.kind).toBe(SpanKind.CLIENT);
    expect(txSpan.attributes['kysely.transaction.outcome']).toBe('committed');
    expect(querySpan.parentSpanContext?.spanId).toBe(txSpan.spanContext().spanId);
  });

  it('marks rollback outcome', async () => {
    const { driver } = makeDriver();
    const connection = await driver.acquireConnection();
    await driver.beginTransaction(connection, {});
    await driver.rollbackTransaction(connection);
    const txSpan = otel.spanExporter.getFinishedSpans().find((s) => s.name === 'TRANSACTION')!;
    expect(txSpan.attributes['kysely.transaction.outcome']).toBe('rolled_back');
  });

  it('ends the span with error status when begin fails', async () => {
    const { driver, fakeDriver } = makeDriver();
    const connection = await driver.acquireConnection();
    fakeDriver.beginTransaction = async () => {
      throw new Error('begin failed');
    };
    await expect(driver.beginTransaction(connection, {})).rejects.toThrow('begin failed');
    const txSpan = otel.spanExporter.getFinishedSpans().find((s) => s.name === 'TRANSACTION')!;
    expect(txSpan.status.code).toBe(SpanStatusCode.ERROR);
    expect((connection as ObservedConnection).transactionSpan).toBeUndefined();
  });

  it('emits no transaction spans when disabled', async () => {
    const { driver } = makeDriver({ transactions: false });
    const connection = await driver.acquireConnection();
    await driver.beginTransaction(connection, {});
    await driver.commitTransaction(connection);
    expect(
      otel.spanExporter.getFinishedSpans().find((s) => s.name === 'TRANSACTION'),
    ).toBeUndefined();
  });

  it('queries outside a transaction have no TRANSACTION parent', async () => {
    const { driver } = makeDriver();
    const connection = await driver.acquireConnection();
    await driver.beginTransaction(connection, {});
    await driver.commitTransaction(connection);
    await connection.executeQuery(SELECT);
    const querySpan = otel.spanExporter.getFinishedSpans().find((s) => s.name === 'SELECT orders')!;
    expect(querySpan.parentSpanContext).toBeUndefined();
  });

  it('parents queries to a user-created span inside the transaction, not TRANSACTION', async () => {
    const { driver } = makeDriver();
    const connection = await driver.acquireConnection();
    await driver.beginTransaction(connection, {});
    const tracer = trace.getTracer('user');
    await tracer.startActiveSpan('user-step', async (userSpan) => {
      await connection.executeQuery(SELECT);
      userSpan.end();
    });
    await driver.commitTransaction(connection);

    const spans = otel.spanExporter.getFinishedSpans();
    const querySpan = spans.find((s) => s.name === 'SELECT orders')!;
    const userSpan = spans.find((s) => s.name === 'user-step')!;
    expect(querySpan.parentSpanContext?.spanId).toBe(userSpan.spanContext().spanId);
  });

  it('stamps connection-level attributes on transaction spans', async () => {
    const { driver } = makeDriver({
      namespace: 'shop',
      serverAddress: 'db.internal',
      serverPort: 5432,
    });
    const connection = await driver.acquireConnection();
    await driver.beginTransaction(connection, {});
    await driver.commitTransaction(connection);
    const txSpan = otel.spanExporter.getFinishedSpans().find((s) => s.name === 'TRANSACTION')!;
    expect(txSpan.attributes['db.namespace']).toBe('shop');
    expect(txSpan.attributes['server.address']).toBe('db.internal');
    expect(txSpan.attributes['server.port']).toBe(5432);
  });
});

describe('ObservedDriver stream span backstop', () => {
  it('ends abandoned stream spans when the connection is released', async () => {
    const { driver } = makeDriver({}, () => ({ rows: [{ id: 1 }, { id: 2 }] }));
    const connection = (await driver.acquireConnection()) as ObservedConnection;
    const iterator = connection.streamQuery(SELECT, 1);
    await iterator.next(); // start the stream, then abandon it without return()
    expect(otel.spanExporter.getFinishedSpans()).toHaveLength(0);
    await driver.releaseConnection(connection);
    const spans = otel.spanExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes['kysely.stream.outcome']).toBe('released_unfinished');
  });
});

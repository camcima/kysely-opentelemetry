import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAnalyzer } from '../../src/analysis/analyze.js';
import { ObservedConnection } from '../../src/observed-connection.js';
import { ObservedDriver } from '../../src/observed-driver.js';
import { normalizeOptions, type KyselyOtelOptions } from '../../src/options.js';
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

function makeDriver(overrides: KyselyOtelOptions = {}) {
  const options = normalizeOptions(overrides);
  const { driver: fakeDriver } = createFakeDialect(() => ({ rows: [] }));
  const driver = new ObservedDriver(fakeDriver, {
    options,
    analyze: createAnalyzer(options),
    tracer: trace.getTracer('test'),
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

  it('records acquire duration on the wrapper', async () => {
    const { driver, fakeDriver } = makeDriver();
    fakeDriver.acquireDelayMs = 15;
    const connection = (await driver.acquireConnection()) as ObservedConnection;
    expect(connection.acquireDurationMs).toBeGreaterThanOrEqual(10);
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
    expect(otel.spanExporter.getFinishedSpans().find((s) => s.name === 'TRANSACTION')).toBeUndefined();
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
});

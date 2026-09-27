import { diag, metrics, type Histogram, type Tracer } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { Kysely, type CompiledQuery } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAnalyzer } from '../../src/analysis/analyze.js';
import { observeDialect } from '../../src/index.js';
import { ObservedConnection } from '../../src/observed-connection.js';
import { ObservedDriver } from '../../src/observed-driver.js';
import { normalizeOptions } from '../../src/options.js';
import { createDurationHistogram } from '../../src/otel/metrics.js';
import { compile } from '../helpers/compile.js';
import { createFakeDialect, FakeConnection } from '../helpers/fake-dialect.js';

/**
 * Telemetry must never change a database outcome: a success stays a
 * success, a database error reaches the caller with its identity intact,
 * and the database call runs exactly once. A custom SpanProcessor whose
 * onEnd throws is a real trigger — the SDK does not guard processors, so
 * the error escapes span.end().
 */

const throwingProcessor: SpanProcessor = {
  onStart() {},
  onEnd() {
    throw new Error('span processor onEnd failed');
  },
  forceFlush: async () => {},
  shutdown: async () => {},
};

function throwingEndTracer(): Tracer {
  return new BasicTracerProvider({ spanProcessors: [throwingProcessor] }).getTracer('test');
}

const SELECT = compile((db) => db.selectFrom('orders').selectAll());

function makeConnection(
  script: (cq: CompiledQuery) => { rows: any[] } = () => ({ rows: [{ id: 1 }] }),
  deps: { tracer?: Tracer; histogram?: Histogram } = {},
) {
  const options = normalizeOptions();
  const inner = new FakeConnection(script as any);
  const connection = new ObservedConnection(inner, {
    options,
    analyze: createAnalyzer(options),
    tracer: deps.tracer ?? throwingEndTracer(),
    ...(deps.histogram && { histogram: deps.histogram }),
    dbSystem: 'postgresql',
  });
  return { connection, inner };
}

beforeEach(() => {
  vi.spyOn(diag, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('span finalization failures (R4)', () => {
  it('a successful query stays successful and runs once', async () => {
    const { connection, inner } = makeConnection();
    await expect(connection.executeQuery(SELECT)).resolves.toMatchObject({ rows: [{ id: 1 }] });
    expect(inner.executed).toHaveLength(1);
  });

  it('a failed query rejects with the original database error', async () => {
    const dbError = new Error('duplicate key');
    const { connection } = makeConnection(() => {
      throw dbError;
    });
    await expect(connection.executeQuery(SELECT)).rejects.toBe(dbError);
  });

  it('a stream yields every row, on completion and on early break', async () => {
    const { connection } = makeConnection(() => ({ rows: [{ id: 1 }, { id: 2 }] }));
    const rows: unknown[] = [];
    for await (const chunk of connection.streamQuery(SELECT, 1)) rows.push(...chunk.rows);
    expect(rows).toHaveLength(2);

    const early = connection.streamQuery(SELECT, 1);
    await early.next();
    await expect(early.return!()).resolves.toMatchObject({ done: true });
  });

  it('a stream whose inner streamQuery throws synchronously rethrows that error', () => {
    const dbError = new Error('streaming not supported');
    const { connection, inner } = makeConnection();
    (inner as any).streamQuery = () => {
      throw dbError;
    };
    expect(() => connection.streamQuery(SELECT, 1)).toThrow(dbError);
  });

  it('a committed transaction reports success and commits once', async () => {
    const options = normalizeOptions();
    const { driver: fakeDriver } = createFakeDialect();
    const driver = new ObservedDriver(fakeDriver, {
      options,
      analyze: createAnalyzer(options),
      tracer: throwingEndTracer(),
      dbSystem: 'postgresql',
    });
    const connection = await driver.acquireConnection();
    await driver.beginTransaction(connection, {});
    await expect(driver.commitTransaction(connection)).resolves.toBeUndefined();
    expect(fakeDriver.calls.filter((c) => c.startsWith('commit'))).toHaveLength(1);

    await driver.beginTransaction(connection, {});
    await expect(driver.rollbackTransaction(connection)).resolves.toBeUndefined();
  });
});

describe('diagnostic logger failures (R4)', () => {
  it('a throwing diag logger never escapes a telemetry failure path', async () => {
    vi.mocked(diag.warn).mockImplementation(() => {
      throw new Error('logger failed');
    });
    const histogram = createDurationHistogram(metrics.getMeter('test'));
    histogram.record = () => {
      throw new Error('metric export failed');
    };
    const tracer = new BasicTracerProvider().getTracer('test'); // healthy spans
    const { connection } = makeConnection(undefined, { tracer, histogram });
    await expect(connection.executeQuery(SELECT)).resolves.toMatchObject({ rows: [{ id: 1 }] });
  });
});

describe('telemetry setup failures (R6)', () => {
  const providerFailure = () => {
    throw new Error('provider failed');
  };

  function makeDb(options: Parameters<typeof observeDialect>[1]) {
    const { dialect } = createFakeDialect(() => ({ rows: [{ id: 1 }] }));
    return new Kysely<any>({ dialect: observeDialect(dialect, options) });
  }

  it('never touches the meter provider when metrics are disabled', () => {
    const getMeter = vi.fn(providerFailure);
    expect(() => makeDb({ metrics: false, meterProvider: { getMeter } })).not.toThrow();
    expect(getMeter).not.toHaveBeenCalled();
  });

  it('a throwing meter provider leaves queries and tracing working', async () => {
    const exporter = new InMemorySpanExporter();
    const tracerProvider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const db = makeDb({ tracerProvider, meterProvider: { getMeter: providerFailure } });
    await expect(db.selectFrom('orders').selectAll().execute()).resolves.toEqual([{ id: 1 }]);
    expect(exporter.getFinishedSpans()).toHaveLength(1);
  });

  it('a throwing tracer provider leaves queries and metrics working', async () => {
    const record = vi.fn();
    const meterProvider = { getMeter: () => ({ createHistogram: () => ({ record }) }) } as any;
    const db = makeDb({ tracerProvider: { getTracer: providerFailure }, meterProvider });
    await expect(db.selectFrom('orders').selectAll().execute()).resolves.toEqual([{ id: 1 }]);
    expect(record).toHaveBeenCalled();
  });

  it('one histogram failing to initialize does not disable the other', async () => {
    const recorded: string[] = [];
    const meterProvider = {
      getMeter: () => ({
        createHistogram: (name: string) => {
          if (name === 'db.client.connection.wait_time') providerFailure();
          return { record: () => recorded.push(name) };
        },
      }),
    } as any;
    const db = makeDb({ meterProvider });
    await expect(db.selectFrom('orders').selectAll().execute()).resolves.toEqual([{ id: 1 }]);
    expect(recorded).toEqual(['db.client.operation.duration']);
  });
});

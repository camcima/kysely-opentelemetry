import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { CompiledQuery } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAnalyzer } from '../../src/analysis/analyze.js';
import { ObservedConnection } from '../../src/observed-connection.js';
import { normalizeOptions } from '../../src/options.js';
import { createDurationHistogram } from '../../src/otel/metrics.js';
import { compile } from '../helpers/compile.js';
import { FakeConnection } from '../helpers/fake-dialect.js';
import { setupOtel } from '../helpers/otel.js';

let otel: ReturnType<typeof setupOtel>;

beforeEach(() => {
  otel = setupOtel();
});

afterEach(async () => {
  await otel.teardown();
});

function makeConnection(script = (_cq: CompiledQuery) => ({ rows: [{ id: 1 }] })) {
  const options = normalizeOptions();
  const inner = new FakeConnection(script as any);
  const connection = new ObservedConnection(inner, {
    options,
    analyze: createAnalyzer(options),
    tracer: trace.getTracer('test'),
    histogram: createDurationHistogram(),
    dbSystem: 'postgresql',
  });
  return { connection, inner };
}

const SELECT = compile((db) => db.selectFrom('orders').selectAll().where('id', '=', 7));

describe('ObservedConnection.executeQuery', () => {
  it('creates a CLIENT span named from the summary with full attributes', async () => {
    const { connection } = makeConnection();
    const result = await connection.executeQuery(SELECT);
    expect(result.rows).toEqual([{ id: 1 }]);

    const spans = otel.spanExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.name).toBe('SELECT orders');
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.attributes['db.system.name']).toBe('postgresql');
    expect(span.attributes['db.operation.name']).toBe('SELECT');
    expect(span.attributes['db.query.hash']).toMatch(/^[0-9a-f]{16}$/);
    expect(span.attributes['db.response.returned_rows']).toBe(1);
    expect(span.attributes['kysely.query.parameter_count']).toBe(1);
    expect(JSON.stringify(span.attributes)).not.toContain('7'); // no parameter values
  });

  it('records the duration histogram', async () => {
    const { connection } = makeConnection();
    await connection.executeQuery(SELECT);
    const metricData = await otel.collectMetrics();
    const metric = metricData
      .flatMap((rm) => rm.scopeMetrics)
      .flatMap((sm) => sm.metrics)
      .find((m) => m.descriptor.name === 'db.client.operation.duration');
    expect(metric).toBeDefined();
    const point = (metric!.dataPoints[0] ?? {}) as any;
    expect(point.attributes['db.query.summary']).toBe('SELECT orders');
    expect(point.value.count).toBe(1);
  });

  it('records errors, sets status, rethrows unchanged, and still ends the span', async () => {
    const boom = Object.assign(new Error('dup key'), { code: '23505' });
    const { connection } = makeConnection(() => {
      throw boom;
    });
    await expect(connection.executeQuery(SELECT)).rejects.toBe(boom);

    const spans = otel.spanExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0]!.attributes['error.type']).toBe('23505');
  });

  it('emits acquire duration on the first query only', async () => {
    const { connection } = makeConnection();
    connection.acquireDurationMs = 12.5;
    await connection.executeQuery(SELECT);
    await connection.executeQuery(SELECT);
    const spans = otel.spanExporter.getFinishedSpans();
    expect(spans[0]!.attributes['kysely.pool.acquire_duration_ms']).toBe(12.5);
    expect(spans[1]!.attributes['kysely.pool.acquire_duration_ms']).toBeUndefined();
  });

  it('executes un-instrumented when analysis fails (safety invariant)', async () => {
    const options = normalizeOptions();
    const inner = new FakeConnection(() => ({ rows: [] }));
    const connection = new ObservedConnection(inner, {
      options,
      analyze: () => {
        throw new Error('analyzer exploded');
      },
      tracer: trace.getTracer('test'),
      dbSystem: 'postgresql',
    });
    const result = await connection.executeQuery(SELECT);
    expect(result.rows).toEqual([]);
    expect(otel.spanExporter.getFinishedSpans()).toHaveLength(0);
  });
});

describe('ObservedConnection.streamQuery', () => {
  it('ends the span when iteration completes and counts streamed rows', async () => {
    const { connection } = makeConnection(() => ({ rows: [{ id: 1 }, { id: 2 }, { id: 3 }] }));
    const rows: unknown[] = [];
    for await (const chunk of connection.streamQuery(SELECT, 1)) {
      rows.push(...chunk.rows);
      expect(otel.spanExporter.getFinishedSpans()).toHaveLength(0); // still open mid-stream
    }
    expect(rows).toHaveLength(3);
    const spans = otel.spanExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes['db.response.returned_rows']).toBe(3);
    // Backstop-only marker: a normally-completed stream is never tagged.
    expect(spans[0]!.attributes['kysely.stream.outcome']).toBeUndefined();
  });

  it('ends the span with error status when the stream throws', async () => {
    const boom = new Error('stream broke');
    const { connection } = makeConnection(() => {
      throw boom;
    });
    await expect(async () => {
      for await (const _ of connection.streamQuery(SELECT, 1)) {
        // never reached
      }
    }).rejects.toBe(boom);
    const spans = otel.spanExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('ends the span when the consumer breaks early', async () => {
    const { connection } = makeConnection(() => ({ rows: [{ id: 1 }, { id: 2 }] }));
    for await (const _ of connection.streamQuery(SELECT, 1)) {
      break; // triggers iterator.return()
    }
    expect(otel.spanExporter.getFinishedSpans()).toHaveLength(1);
  });

  it('throw() without an argument raises a real Error, not undefined', async () => {
    const { connection } = makeConnection(() => ({ rows: [{ id: 1 }, { id: 2 }] }));
    const iterator = connection.streamQuery(SELECT, 1);
    await iterator.next();
    await expect(iterator.throw!()).rejects.toBeInstanceOf(Error);
    const spans = otel.spanExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.status.code).toBe(SpanStatusCode.ERROR);
  });
});

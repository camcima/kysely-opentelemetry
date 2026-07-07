import { ValueType, type Attributes, type Histogram, type Meter } from '@opentelemetry/api';
import type { QueryContext } from '../analysis/analyze.js';
import type { NormalizedOptions } from '../options.js';
import {
  ATTR_DB_COLLECTION,
  ATTR_DB_NAMESPACE,
  ATTR_DB_OPERATION,
  ATTR_DB_QUERY_SUMMARY,
  ATTR_DB_SYSTEM,
  ATTR_ERROR_TYPE,
  ATTR_POOL_NAME,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
} from './attributes.js';

/** Shared latency buckets (seconds), spanning sub-ms cache hits to multi-second stalls. */
const LATENCY_BUCKETS_SECONDS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10];

/** Semconv db.client.operation.duration histogram (seconds). */
export function createDurationHistogram(meter: Meter): Histogram {
  return meter.createHistogram('db.client.operation.duration', {
    description: 'Duration of database client operations.',
    unit: 's',
    valueType: ValueType.DOUBLE,
    advice: {
      explicitBucketBoundaries: LATENCY_BUCKETS_SECONDS,
    },
  });
}

/** Semconv db.client.connection.wait_time histogram (seconds). */
export function createWaitTimeHistogram(meter: Meter): Histogram {
  return meter.createHistogram('db.client.connection.wait_time', {
    description: 'The time it took to obtain an open connection from the pool.',
    unit: 's',
    valueType: ValueType.DOUBLE,
    advice: {
      explicitBucketBoundaries: LATENCY_BUCKETS_SECONDS,
    },
  });
}

/**
 * Attributes for the wait_time histogram, computed ONCE at createDriver time
 * (they depend only on construction-time constants) and frozen so the same
 * object is shared by every recording — no per-acquisition allocation.
 * db.client.connection.pool.name is required by semconv; when the `poolName`
 * option is not set, a stable, low-cardinality name is derived from the
 * connection options (address/port/namespace), falling back to the db system
 * (semconv's own recommended fallback format).
 */
export function resolveWaitTimeAttributes(
  options: NormalizedOptions,
  dbSystem: string,
): Attributes {
  return Object.freeze({
    [ATTR_DB_SYSTEM]: dbSystem,
    [ATTR_POOL_NAME]: options.poolName ?? derivePoolName(options, dbSystem),
  });
}

function derivePoolName(options: NormalizedOptions, dbSystem: string): string {
  const { serverAddress, serverPort, namespace } = options;
  if (serverAddress !== undefined) {
    const host = serverPort !== undefined ? `${serverAddress}:${serverPort}` : serverAddress;
    return namespace !== undefined ? `${host}/${namespace}` : host;
  }
  return namespace ?? dbSystem;
}

export function recordDuration(
  histogram: Histogram,
  ctx: QueryContext,
  dbSystem: string,
  options: NormalizedOptions,
  durationMs: number,
  errType?: string,
): void {
  const attrs: Attributes = {
    [ATTR_DB_SYSTEM]: dbSystem,
    [ATTR_DB_OPERATION]: ctx.operation,
  };
  if (options.namespace !== undefined) attrs[ATTR_DB_NAMESPACE] = options.namespace;
  if (options.serverAddress !== undefined) attrs[ATTR_SERVER_ADDRESS] = options.serverAddress;
  if (options.serverPort !== undefined) attrs[ATTR_SERVER_PORT] = options.serverPort;
  if (options.summary) attrs[ATTR_DB_QUERY_SUMMARY] = ctx.summary;
  if (ctx.primaryTable !== undefined) attrs[ATTR_DB_COLLECTION] = ctx.primaryTable;
  if (errType !== undefined) attrs[ATTR_ERROR_TYPE] = errType;
  histogram.record(durationMs / 1000, attrs);
}

import { metrics, ValueType, type Attributes, type Histogram } from '@opentelemetry/api';
import type { QueryContext } from '../analysis/analyze.js';
import type { NormalizedOptions } from '../options.js';
import { VERSION } from '../version.js';
import {
  ATTR_DB_COLLECTION,
  ATTR_DB_NAMESPACE,
  ATTR_DB_OPERATION,
  ATTR_DB_QUERY_SUMMARY,
  ATTR_DB_SYSTEM,
  ATTR_ERROR_TYPE,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
} from './attributes.js';

/** Semconv db.client.operation.duration histogram (seconds). */
export function createDurationHistogram(): Histogram {
  return metrics.getMeter('kysely-opentelemetry', VERSION).createHistogram(
    'db.client.operation.duration',
    {
      description: 'Duration of database client operations.',
      unit: 's',
      valueType: ValueType.DOUBLE,
      advice: {
        explicitBucketBoundaries: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10],
      },
    },
  );
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

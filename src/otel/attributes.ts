import type { Attributes } from '@opentelemetry/api';
import type { QueryContext } from '../analysis/analyze.js';
import type { NormalizedOptions } from '../options.js';

// Semconv attributes
export const ATTR_DB_SYSTEM = 'db.system.name';
export const ATTR_DB_OPERATION = 'db.operation.name';
export const ATTR_DB_QUERY_SUMMARY = 'db.query.summary';
export const ATTR_DB_QUERY_TEXT = 'db.query.text';
export const ATTR_DB_COLLECTION = 'db.collection.name';
export const ATTR_RETURNED_ROWS = 'db.response.returned_rows';
export const ATTR_ERROR_TYPE = 'error.type';
// Custom attributes
export const ATTR_DB_QUERY_FINGERPRINT = 'db.query.fingerprint';
export const ATTR_DB_QUERY_HASH = 'db.query.hash';
export const ATTR_TABLES = 'kysely.query.tables';
export const ATTR_PARAMETER_COUNT = 'kysely.query.parameter_count';
export const ATTR_RAW = 'kysely.query.raw';
export const ATTR_SANITIZATION_ERROR = 'kysely.query.sanitization_error';
export const ATTR_AFFECTED_ROWS = 'kysely.query.affected_rows';
export const ATTR_ACQUIRE_DURATION = 'kysely.pool.acquire_duration_ms';
export const ATTR_TRANSACTION_OUTCOME = 'kysely.transaction.outcome';
export const ATTR_STREAM_OUTCOME = 'kysely.stream.outcome';

export function buildQueryAttributes(
  ctx: QueryContext,
  dbSystem: string,
  options: NormalizedOptions,
): Attributes {
  const attrs: Attributes = {
    [ATTR_DB_SYSTEM]: dbSystem,
    [ATTR_DB_OPERATION]: ctx.operation,
    [ATTR_PARAMETER_COUNT]: ctx.parameters.length,
  };
  if (options.summary) attrs[ATTR_DB_QUERY_SUMMARY] = ctx.summary;
  if (ctx.text !== undefined) attrs[ATTR_DB_QUERY_TEXT] = ctx.text;
  if (options.tables && ctx.primaryTable !== undefined) attrs[ATTR_DB_COLLECTION] = ctx.primaryTable;
  if (options.tables && ctx.tables.length > 0) attrs[ATTR_TABLES] = ctx.tables;
  if (options.fingerprint && ctx.fingerprint && !ctx.sanitizationError) {
    attrs[ATTR_DB_QUERY_FINGERPRINT] = ctx.fingerprint;
  }
  if (options.hash && ctx.hash) attrs[ATTR_DB_QUERY_HASH] = ctx.hash;
  if (ctx.isRaw) attrs[ATTR_RAW] = true;
  if (ctx.sanitizationError) attrs[ATTR_SANITIZATION_ERROR] = true;
  if (options.attributes) {
    try {
      Object.assign(attrs, options.attributes(ctx));
    } catch {
      // user hook failure must never break instrumentation
    }
  }
  return attrs;
}

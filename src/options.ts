import type { Attributes } from '@opentelemetry/api';
import type { QueryContext } from './analysis/analyze.js';

export interface KyselyOtelOptions {
  /** Kill switch. When false, observeDialect returns the dialect untouched. Default true. */
  enabled?: boolean;
  /** Override db.system.name auto-detection (e.g. 'postgresql'). */
  dbSystem?: string;
  /** db.query.text emission. Default 'sanitized'. */
  queryText?: 'off' | 'sanitized' | 'parameterized';
  /** Max chars for db.query.text and db.query.fingerprint. Default 4096. */
  maxQueryTextLength?: number;
  fingerprint?: boolean;
  summary?: boolean;
  tables?: boolean;
  hash?: boolean;
  /** Emit the db.client.operation.duration histogram. Default true. */
  metrics?: boolean;
  /** Emit TRANSACTION spans. Default true. */
  transactions?: boolean;
  /** span.recordException on query failure. Default true. */
  recordExceptions?: boolean;
  /** Custom attributes hook. Failures are swallowed. Cardinality/PII is the caller's responsibility. */
  attributes?: (ctx: QueryContext) => Attributes;
  /** Extra query-text scrubbing, runs last in all emitting modes. Throwing omits db.query.text. */
  redact?: (sql: string) => string;
}

export interface NormalizedOptions {
  readonly enabled: boolean;
  readonly dbSystem?: string;
  readonly queryText: 'off' | 'sanitized' | 'parameterized';
  readonly maxQueryTextLength: number;
  readonly fingerprint: boolean;
  readonly summary: boolean;
  readonly tables: boolean;
  readonly hash: boolean;
  readonly metrics: boolean;
  readonly transactions: boolean;
  readonly recordExceptions: boolean;
  readonly attributes?: (ctx: QueryContext) => Attributes;
  readonly redact?: (sql: string) => string;
}

export function normalizeOptions(options: KyselyOtelOptions = {}): NormalizedOptions {
  return {
    enabled: options.enabled ?? true,
    ...(options.dbSystem !== undefined && { dbSystem: options.dbSystem }),
    queryText: options.queryText ?? 'sanitized',
    maxQueryTextLength: options.maxQueryTextLength ?? 4096,
    fingerprint: options.fingerprint ?? true,
    summary: options.summary ?? true,
    tables: options.tables ?? true,
    hash: options.hash ?? true,
    metrics: options.metrics ?? true,
    transactions: options.transactions ?? true,
    recordExceptions: options.recordExceptions ?? true,
    ...(options.attributes !== undefined && { attributes: options.attributes }),
    ...(options.redact !== undefined && { redact: options.redact }),
  };
}

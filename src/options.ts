import type { Attributes, MeterProvider, TracerProvider } from '@opentelemetry/api';
import type { QueryContext } from './analysis/analyze.js';

export interface KyselyOtelOptions {
  /** Kill switch. When false, observeDialect returns the dialect untouched. Default true. */
  enabled?: boolean;
  /** Override db.system.name auto-detection (e.g. 'postgresql'). */
  dbSystem?: string;
  /** Emitted as db.namespace on spans and metrics (e.g. the database name). Not auto-detectable from a dialect. */
  namespace?: string;
  /** Emitted as server.address on spans and metrics (e.g. the DB host). */
  serverAddress?: string;
  /** Emitted as server.port on spans and metrics. */
  serverPort?: number;
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
  /** Use this TracerProvider instead of the global @opentelemetry/api registry. */
  tracerProvider?: TracerProvider;
  /** Use this MeterProvider instead of the global @opentelemetry/api registry. */
  meterProvider?: MeterProvider;
}

export interface NormalizedOptions {
  readonly enabled: boolean;
  readonly dbSystem?: string;
  readonly namespace?: string;
  readonly serverAddress?: string;
  readonly serverPort?: number;
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
  readonly tracerProvider?: TracerProvider;
  readonly meterProvider?: MeterProvider;
}

export function normalizeOptions(options: KyselyOtelOptions = {}): NormalizedOptions {
  return {
    enabled: options.enabled ?? true,
    ...(options.dbSystem !== undefined && { dbSystem: options.dbSystem }),
    ...(options.namespace !== undefined && { namespace: options.namespace }),
    ...(options.serverAddress !== undefined && { serverAddress: options.serverAddress }),
    ...(options.serverPort !== undefined && { serverPort: options.serverPort }),
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
    ...(options.tracerProvider !== undefined && { tracerProvider: options.tracerProvider }),
    ...(options.meterProvider !== undefined && { meterProvider: options.meterProvider }),
  };
}

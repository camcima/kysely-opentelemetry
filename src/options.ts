import type { Attributes, MeterProvider, TracerProvider } from '@opentelemetry/api';
import type { QueryContext } from './analysis/analyze.js';
import { warnLimited } from './otel/spans.js';

const DEFAULT_MAX_QUERY_TEXT_LENGTH = 4096;

export interface MetricsOptions {
  /** Emit the db.client.operation.duration histogram. Default true. */
  operationDuration?: boolean;
  /** Emit the db.client.connection.wait_time histogram. Default true. */
  connectionWaitTime?: boolean;
}

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
  /** db.client.connection.pool.name on the wait_time metric. Default: derived
   *  as serverAddress[:serverPort][/namespace], falling back to the db system
   *  name. Set this when several pools share one endpoint (e.g. read-write vs
   *  read-only) so their series stay separable. */
  poolName?: string;
  /** db.query.text emission. Default 'sanitized'. */
  queryText?: 'off' | 'sanitized' | 'parameterized';
  /** Max chars for db.query.text and db.query.fingerprint. Must be a finite
   *  non-negative number (fractions truncate); invalid values fall back to the
   *  default with a diagnostic warning. Default 4096. */
  maxQueryTextLength?: number;
  fingerprint?: boolean;
  summary?: boolean;
  tables?: boolean;
  hash?: boolean;
  /** Metric emission: `true`/`false` gates all histograms together, or pass
   *  an object to gate db.client.operation.duration and
   *  db.client.connection.wait_time independently. Default true (all). */
  metrics?: boolean | MetricsOptions;
  /** Emit TRANSACTION spans. Default true. */
  transactions?: boolean;
  /** span.recordException on query failure. Default true. */
  recordExceptions?: boolean;
  /** Skip observing a query (no span, no metric) by returning false.
   *  Fail-open: a throwing filter observes the query anyway. */
  shouldObserve?: (ctx: QueryContext) => boolean;
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
  readonly poolName?: string;
  readonly queryText: 'off' | 'sanitized' | 'parameterized';
  readonly maxQueryTextLength: number;
  readonly fingerprint: boolean;
  readonly summary: boolean;
  readonly tables: boolean;
  readonly hash: boolean;
  readonly metrics: Readonly<Required<MetricsOptions>>;
  readonly transactions: boolean;
  readonly recordExceptions: boolean;
  readonly shouldObserve?: (ctx: QueryContext) => boolean;
  readonly attributes?: (ctx: QueryContext) => Attributes;
  readonly redact?: (sql: string) => string;
  readonly tracerProvider?: TracerProvider;
  readonly meterProvider?: MeterProvider;
}

/** A negative value has surprising String.prototype.slice semantics (-1 keeps
 *  all but the last char) and Infinity removes the cap entirely — both defeat
 *  the intended bound, so invalid input falls back to the default loudly. */
function normalizeMaxQueryTextLength(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_QUERY_TEXT_LENGTH;
  if (!Number.isFinite(value) || value < 0) {
    warnLimited('invalid maxQueryTextLength; using default 4096', value);
    return DEFAULT_MAX_QUERY_TEXT_LENGTH;
  }
  return Math.trunc(value);
}

export function normalizeOptions(options: KyselyOtelOptions = {}): NormalizedOptions {
  return {
    enabled: options.enabled ?? true,
    ...(options.dbSystem !== undefined && { dbSystem: options.dbSystem }),
    ...(options.namespace !== undefined && { namespace: options.namespace }),
    ...(options.serverAddress !== undefined && { serverAddress: options.serverAddress }),
    ...(options.serverPort !== undefined && { serverPort: options.serverPort }),
    ...(options.poolName !== undefined && { poolName: options.poolName }),
    queryText: options.queryText ?? 'sanitized',
    maxQueryTextLength: normalizeMaxQueryTextLength(options.maxQueryTextLength),
    fingerprint: options.fingerprint ?? true,
    summary: options.summary ?? true,
    tables: options.tables ?? true,
    hash: options.hash ?? true,
    metrics: normalizeMetrics(options.metrics ?? true),
    transactions: options.transactions ?? true,
    recordExceptions: options.recordExceptions ?? true,
    ...(options.shouldObserve !== undefined && { shouldObserve: options.shouldObserve }),
    ...(options.attributes !== undefined && { attributes: options.attributes }),
    ...(options.redact !== undefined && { redact: options.redact }),
    ...(options.tracerProvider !== undefined && { tracerProvider: options.tracerProvider }),
    ...(options.meterProvider !== undefined && { meterProvider: options.meterProvider }),
  };
}

function normalizeMetrics(metrics: boolean | MetricsOptions): Readonly<Required<MetricsOptions>> {
  if (typeof metrics === 'boolean') {
    return { operationDuration: metrics, connectionWaitTime: metrics };
  }
  return {
    operationDuration: metrics.operationDuration ?? true,
    connectionWaitTime: metrics.connectionWaitTime ?? true,
  };
}

import { trace } from '@opentelemetry/api';
import type {
  DatabaseIntrospector,
  Dialect,
  DialectAdapter,
  Driver,
  Kysely,
  QueryCompiler,
} from 'kysely';
import { createAnalyzer } from './analysis/analyze.js';
import { ObservedDriver } from './observed-driver.js';
import type { ObservedConnectionDeps } from './observed-connection.js';
import { normalizeOptions, type KyselyOtelOptions, type NormalizedOptions } from './options.js';
import { createDurationHistogram } from './otel/metrics.js';
import { detectDbSystem } from './otel/system.js';
import { VERSION } from './version.js';

export class ObservedDialect implements Dialect {
  constructor(
    private readonly inner: Dialect,
    private readonly options: NormalizedOptions,
  ) {}

  createDriver(): Driver {
    const deps: ObservedConnectionDeps = {
      options: this.options,
      analyze: createAnalyzer(this.options),
      tracer: trace.getTracer('kysely-opentelemetry', VERSION),
      ...(this.options.metrics && { histogram: createDurationHistogram() }),
      dbSystem: this.options.dbSystem ?? detectDbSystem(this.inner),
    };
    return new ObservedDriver(this.inner.createDriver(), deps);
  }

  createQueryCompiler(): QueryCompiler {
    return this.inner.createQueryCompiler();
  }

  createAdapter(): DialectAdapter {
    return this.inner.createAdapter();
  }

  createIntrospector(db: Kysely<any>): DatabaseIntrospector {
    return this.inner.createIntrospector(db);
  }
}

/**
 * Wrap a Kysely dialect with OpenTelemetry instrumentation.
 * With `enabled: false` the original dialect is returned untouched.
 */
export function observeDialect(dialect: Dialect, options?: KyselyOtelOptions): Dialect {
  const normalized = normalizeOptions(options);
  if (!normalized.enabled) return dialect;
  return new ObservedDialect(dialect, normalized);
}

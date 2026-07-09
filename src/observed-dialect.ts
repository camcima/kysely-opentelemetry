import { metrics, trace } from '@opentelemetry/api';
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
import {
  createDurationHistogram,
  createWaitTimeHistogram,
  resolveWaitTimeAttributes,
} from './otel/metrics.js';
import { detectDbSystem } from './otel/system.js';
import { VERSION } from './version.js';

/** Cross-copy idempotency marker. `instanceof` fails when two physical copies
 *  of this package are loaded (pnpm-linked duplicates, or one app loading
 *  both the ESM and CJS builds); Symbol.for is process-global, so any copy
 *  recognizes any other copy's wrapper. The explicit `unique symbol`
 *  annotation is required for use as a computed class-property key (TS1166). */
const OBSERVED_MARKER: unique symbol = Symbol.for('kysely-opentelemetry.observed');

export class ObservedDialect implements Dialect {
  private readonly options: NormalizedOptions;
  readonly [OBSERVED_MARKER] = true;

  /**
   * @param inner The dialect to instrument.
   * @param options Instrumentation options. Note: `enabled: false` is honored
   * only by the `observeDialect()` factory — constructing an `ObservedDialect`
   * directly always instruments. When `observeDialect()` is called on an
   * already-wrapped dialect, the existing wrapper is returned and these
   * options are ignored.
   */
  constructor(
    private readonly inner: Dialect,
    options: KyselyOtelOptions = {},
  ) {
    this.options = normalizeOptions(options);
  }

  createDriver(): Driver {
    const tracerProvider = this.options.tracerProvider ?? trace;
    const meterProvider = this.options.meterProvider ?? metrics;
    const meter = meterProvider.getMeter('kysely-opentelemetry', VERSION);
    const dbSystem = this.options.dbSystem ?? detectDbSystem(this.inner);
    const deps: ObservedConnectionDeps = {
      options: this.options,
      analyze: createAnalyzer(this.options),
      tracer: tracerProvider.getTracer('kysely-opentelemetry', VERSION),
      ...(this.options.metrics.operationDuration && {
        histogram: createDurationHistogram(meter),
      }),
      ...(this.options.metrics.connectionWaitTime && {
        waitTimeHistogram: createWaitTimeHistogram(meter),
        waitTimeAttributes: resolveWaitTimeAttributes(this.options, dbSystem),
      }),
      dbSystem,
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
 * Wrapping an already-observed dialect returns it unchanged.
 */
export function observeDialect(dialect: Dialect, options?: KyselyOtelOptions): Dialect {
  if (isObserved(dialect)) return dialect;
  if (!(options?.enabled ?? true)) return dialect;
  return new ObservedDialect(dialect, options);
}

function isObserved(dialect: Dialect): boolean {
  return (
    dialect instanceof ObservedDialect ||
    (dialect as unknown as Record<PropertyKey, unknown>)[OBSERVED_MARKER] === true
  );
}

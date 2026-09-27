import {
  metrics,
  ProxyTracerProvider,
  trace,
  type Attributes,
  type Histogram,
  type Meter,
  type Tracer,
} from '@opentelemetry/api';
import type {
  DatabaseIntrospector,
  Dialect,
  DialectAdapter,
  Driver,
  Kysely,
  QueryCompiler,
} from 'kysely';
import { createAnalyzer } from './analysis/analyze.js';
import { lexiconFor } from './analysis/lexicon.js';
import { ObservedDriver } from './observed-driver.js';
import type { ObservedConnectionDeps } from './observed-connection.js';
import { normalizeOptions, type KyselyOtelOptions, type NormalizedOptions } from './options.js';
import { warnLimited } from './otel/diagnostics.js';
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
    const dbSystem = this.options.dbSystem ?? detectDbSystem(this.inner);
    const deps: ObservedConnectionDeps = {
      options: this.options,
      analyze: createAnalyzer(this.options, lexiconFor(dbSystem)),
      tracer: this.resolveTracer(),
      ...this.resolveHistograms(dbSystem),
      dbSystem,
    };
    // Outside any guard: a failing dialect or driver is the application's
    // error, not a telemetry one, and must propagate unchanged.
    return new ObservedDriver(this.inner.createDriver(), deps);
  }

  /** Telemetry setup must never prevent the database from being used: an
   *  injected provider that throws degrades to a no-op tracer. */
  private resolveTracer(): Tracer {
    try {
      return (this.options.tracerProvider ?? trace).getTracer('kysely-opentelemetry', VERSION);
    } catch (error) {
      warnLimited('tracer provider failed; tracing disabled', error);
      // A ProxyTracerProvider with no delegate hands out no-op tracers.
      return new ProxyTracerProvider().getTracer('kysely-opentelemetry', VERSION);
    }
  }

  /** Resolves the meter only when a metric is enabled, and creates each
   *  histogram independently so one failing signal keeps the others. */
  private resolveHistograms(
    dbSystem: string,
  ): Pick<ObservedConnectionDeps, 'histogram' | 'waitTimeHistogram' | 'waitTimeAttributes'> {
    const { operationDuration, connectionWaitTime } = this.options.metrics;
    if (!operationDuration && !connectionWaitTime) return {};
    let meter: Meter;
    try {
      meter = (this.options.meterProvider ?? metrics).getMeter('kysely-opentelemetry', VERSION);
    } catch (error) {
      warnLimited('meter provider failed; metrics disabled', error);
      return {};
    }
    const histograms: {
      histogram?: Histogram;
      waitTimeHistogram?: Histogram;
      waitTimeAttributes?: Attributes;
    } = {};
    if (operationDuration) {
      try {
        histograms.histogram = createDurationHistogram(meter);
      } catch (error) {
        warnLimited('failed to create operation duration histogram', error);
      }
    }
    if (connectionWaitTime) {
      try {
        histograms.waitTimeHistogram = createWaitTimeHistogram(meter);
        histograms.waitTimeAttributes = resolveWaitTimeAttributes(this.options, dbSystem);
      } catch (error) {
        warnLimited('failed to create connection wait_time histogram', error);
      }
    }
    return histograms;
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
 * Wrapping an already-observed dialect returns it unchanged; options passed
 * on such a call are discarded, with a diagnostic warning so a config that
 * silently fails to apply is debuggable.
 */
export function observeDialect(dialect: Dialect, options?: KyselyOtelOptions): Dialect {
  if (isObserved(dialect)) {
    if (options !== undefined && Object.keys(options).length > 0) {
      warnLimited('observeDialect called on an already-observed dialect; options are ignored');
    }
    return dialect;
  }
  if (!(options?.enabled ?? true)) return dialect;
  return new ObservedDialect(dialect, options);
}

function isObserved(dialect: Dialect): boolean {
  return (
    dialect instanceof ObservedDialect ||
    (dialect as unknown as Record<PropertyKey, unknown>)[OBSERVED_MARKER] === true
  );
}

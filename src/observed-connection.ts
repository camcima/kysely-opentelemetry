import {
  context,
  SpanKind,
  trace,
  type Context,
  type Histogram,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import type { CompiledQuery, DatabaseConnection, QueryResult } from 'kysely';
import type { Analyzer, QueryContext } from './analysis/analyze.js';
import type { NormalizedOptions } from './options.js';
import {
  ATTR_ACQUIRE_DURATION,
  ATTR_AFFECTED_ROWS,
  ATTR_RETURNED_ROWS,
  ATTR_STREAM_OUTCOME,
  buildQueryAttributes,
} from './otel/attributes.js';
import { recordDuration } from './otel/metrics.js';
import { recordError, warnLimited } from './otel/spans.js';

export interface ObservedConnectionDeps {
  readonly options: NormalizedOptions;
  readonly analyze: Analyzer;
  readonly tracer: Tracer;
  readonly histogram?: Histogram;
  readonly dbSystem: string;
}

interface StartedQuery {
  readonly span: Span;
  readonly ctx: QueryContext;
  readonly spanContext: Context;
  readonly startTime: number;
}

export class ObservedConnection implements DatabaseConnection {
  /** Transaction state, managed by ObservedDriver (Task 14). Declared
   *  `| undefined` (not optional) because they are explicitly assigned
   *  undefined, which exactOptionalPropertyTypes forbids on `?:` fields. */
  transactionSpan: Span | undefined = undefined;
  transactionContext: Context | undefined = undefined;
  /** Span active when the transaction began; when the active span at query
   *  time differs, the user opened their own span inside the callback. */
  transactionParentSpan: Span | undefined = undefined;
  /** Set by ObservedDriver on acquire; consumed by the first query span. */
  acquireDurationMs: number | undefined = undefined;
  /** endSpan closures of streams still open on this connection; drained by
   *  endOpenStreamSpans() when the lease ends (abandoned manual iterators). */
  readonly #openStreamEnders = new Set<(error?: unknown, forced?: boolean) => void>();

  // Optional Kysely 0.29 members, forwarded only when the inner connection has them.
  cancelQuery?: NonNullable<DatabaseConnection['cancelQuery']>;
  collectSessionInfo?: NonNullable<DatabaseConnection['collectSessionInfo']>;
  killSession?: NonNullable<DatabaseConnection['killSession']>;

  constructor(
    readonly inner: DatabaseConnection,
    private readonly deps: ObservedConnectionDeps,
  ) {
    if (inner.cancelQuery) this.cancelQuery = (provider) => inner.cancelQuery!(provider);
    if (inner.collectSessionInfo) this.collectSessionInfo = () => inner.collectSessionInfo!();
    if (inner.killSession) this.killSession = (provider) => inner.killSession!(provider);
  }

  async executeQuery<R>(
    compiledQuery: CompiledQuery,
    options?: Parameters<DatabaseConnection['executeQuery']>[1],
  ): Promise<QueryResult<R>> {
    const started = this.startQuery(compiledQuery);
    if (!started) return this.inner.executeQuery<R>(compiledQuery, options);

    const { span, ctx, spanContext, startTime } = started;
    try {
      const result = await context.with(spanContext, () =>
        this.inner.executeQuery<R>(compiledQuery, options),
      );
      this.finishSuccess(ctx, startTime);
      setResultAttributes(span, result);
      return result;
    } catch (error) {
      this.finishFailure(span, ctx, startTime, error);
      throw error;
    } finally {
      span.end();
    }
  }

  streamQuery<R>(
    compiledQuery: CompiledQuery,
    chunkSize: number,
    options?: Parameters<DatabaseConnection['streamQuery']>[2],
  ): AsyncIterableIterator<QueryResult<R>> {
    const started = this.startQuery(compiledQuery);
    if (!started) return this.inner.streamQuery<R>(compiledQuery, chunkSize, options);

    const { span, ctx, spanContext, startTime } = started;
    const inner = context.with(spanContext, () =>
      this.inner.streamQuery<R>(compiledQuery, chunkSize, options),
    );
    let rowCount = 0;
    let ended = false;

    const endSpan = (error?: unknown, forced = false): void => {
      if (ended) return;
      ended = true;
      this.#openStreamEnders.delete(endSpan);
      try {
        if (error === undefined) {
          if (forced) {
            try {
              span.setAttribute(ATTR_STREAM_OUTCOME, 'released_unfinished');
            } catch (e) {
              warnLimited('failed to set stream outcome attribute', e);
            }
          }
          try {
            span.setAttribute(ATTR_RETURNED_ROWS, rowCount);
          } catch (e) {
            warnLimited('failed to set stream row-count attribute', e);
          }
          this.finishSuccess(ctx, startTime);
        } else {
          this.finishFailure(span, ctx, startTime, error);
        }
      } finally {
        span.end();
      }
    };
    this.#openStreamEnders.add(endSpan);

    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next(): Promise<IteratorResult<QueryResult<R>>> {
        try {
          const result = await context.with(spanContext, () => inner.next());
          if (result.done) {
            endSpan();
          } else if (Array.isArray(result.value?.rows)) {
            rowCount += result.value.rows.length;
          }
          return result;
        } catch (error) {
          endSpan(error);
          throw error;
        }
      },
      async return(value?: unknown): Promise<IteratorResult<QueryResult<R>>> {
        endSpan();
        if (inner.return) return inner.return(value);
        return { done: true, value: undefined };
      },
      async throw(error?: unknown): Promise<IteratorResult<QueryResult<R>>> {
        const reason = error ?? new Error('stream aborted');
        endSpan(reason);
        if (inner.throw) return inner.throw(reason);
        throw reason;
      },
    };
  }

  /** Defensive backstop: a stream span must never outlive its connection
   *  lease. Called by ObservedDriver.releaseConnection. */
  endOpenStreamSpans(): void {
    for (const end of [...this.#openStreamEnders]) end(undefined, true);
  }

  private startQuery(compiledQuery: CompiledQuery): StartedQuery | undefined {
    try {
      const ctx = this.deps.analyze(compiledQuery);
      const parent = this.pickParent();
      const attributes = buildQueryAttributes(ctx, this.deps.dbSystem, this.deps.options);
      if (this.acquireDurationMs !== undefined) {
        attributes[ATTR_ACQUIRE_DURATION] = this.acquireDurationMs;
        this.acquireDurationMs = undefined;
      }
      const span = this.deps.tracer.startSpan(
        ctx.summary,
        { kind: SpanKind.CLIENT, attributes },
        parent,
      );
      return { span, ctx, spanContext: trace.setSpan(parent, span), startTime: performance.now() };
    } catch (error) {
      warnLimited('query span creation failed (query executed unobserved)', error);
      return undefined;
    }
  }

  /** Inside a transaction, parent queries to the TRANSACTION span — unless
   *  the user opened their own span since BEGIN, in which case their
   *  hierarchy wins (the TRANSACTION span can never be in the ambient
   *  context, so the two lineages cannot be combined). */
  private pickParent(): Context {
    const active = context.active();
    if (this.transactionContext === undefined) return active;
    return trace.getSpan(active) === this.transactionParentSpan ? this.transactionContext : active;
  }

  private finishSuccess(ctx: QueryContext, startTime: number): void {
    try {
      if (this.deps.histogram) {
        recordDuration(
          this.deps.histogram,
          ctx,
          this.deps.dbSystem,
          this.deps.options,
          performance.now() - startTime,
        );
      }
    } catch (error) {
      warnLimited('failed to record duration metric', error);
    }
  }

  private finishFailure(span: Span, ctx: QueryContext, startTime: number, error: unknown): void {
    try {
      const errType = recordError(span, error, this.deps.options);
      if (this.deps.histogram) {
        recordDuration(
          this.deps.histogram,
          ctx,
          this.deps.dbSystem,
          this.deps.options,
          performance.now() - startTime,
          errType,
        );
      }
    } catch (err) {
      warnLimited('failed to record query failure telemetry', err);
    }
  }
}

function setResultAttributes(span: Span, result: QueryResult<unknown>): void {
  try {
    if (Array.isArray(result.rows)) span.setAttribute(ATTR_RETURNED_ROWS, result.rows.length);
    if (result.numAffectedRows !== undefined) {
      span.setAttribute(ATTR_AFFECTED_ROWS, Number(result.numAffectedRows));
    }
  } catch (error) {
    warnLimited('failed to set result attributes', error);
  }
}

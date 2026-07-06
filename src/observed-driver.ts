import { context, SpanKind, trace, type Attributes } from '@opentelemetry/api';
import type { DatabaseConnection, Driver, TransactionSettings } from 'kysely';
import { ObservedConnection, type ObservedConnectionDeps } from './observed-connection.js';
import {
  ATTR_DB_NAMESPACE,
  ATTR_DB_SYSTEM,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  ATTR_TRANSACTION_OUTCOME,
} from './otel/attributes.js';
import { recordError, warnLimited } from './otel/spans.js';

export class ObservedDriver implements Driver {
  readonly #wrappers = new WeakMap<DatabaseConnection, ObservedConnection>();

  // Optional Kysely 0.28+ members, forwarded (unwrapped) only when the inner driver has them.
  savepoint?: NonNullable<Driver['savepoint']>;
  rollbackToSavepoint?: NonNullable<Driver['rollbackToSavepoint']>;
  releaseSavepoint?: NonNullable<Driver['releaseSavepoint']>;

  constructor(
    private readonly inner: Driver,
    private readonly deps: ObservedConnectionDeps,
  ) {
    if (inner.savepoint) {
      this.savepoint = (c, name, compile) => inner.savepoint!(unwrap(c), name, compile);
    }
    if (inner.rollbackToSavepoint) {
      this.rollbackToSavepoint = (c, name, compile) =>
        inner.rollbackToSavepoint!(unwrap(c), name, compile);
    }
    if (inner.releaseSavepoint) {
      this.releaseSavepoint = (c, name, compile) =>
        inner.releaseSavepoint!(unwrap(c), name, compile);
    }
  }

  init(options?: Parameters<Driver['init']>[0]): Promise<void> {
    return this.inner.init(options);
  }

  async acquireConnection(
    options?: Parameters<Driver['acquireConnection']>[0],
  ): Promise<DatabaseConnection> {
    const start = performance.now();
    const connection = await this.inner.acquireConnection(options);
    const duration = performance.now() - start;
    let wrapper = this.#wrappers.get(connection);
    if (!wrapper) {
      wrapper = new ObservedConnection(connection, this.deps);
      this.#wrappers.set(connection, wrapper);
    }
    wrapper.acquireDurationMs = duration;
    return wrapper;
  }

  async beginTransaction(
    connection: DatabaseConnection,
    settings: TransactionSettings,
  ): Promise<void> {
    const wrapper = asWrapper(connection);
    if (this.deps.options.transactions && wrapper) this.startTransactionSpan(wrapper);
    try {
      await this.inner.beginTransaction(unwrap(connection), settings);
    } catch (error) {
      if (wrapper) this.endTransactionSpan(wrapper, 'begin_failed', error);
      throw error;
    }
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    const wrapper = asWrapper(connection);
    try {
      await this.inner.commitTransaction(unwrap(connection));
      if (wrapper) this.endTransactionSpan(wrapper, 'committed');
    } catch (error) {
      if (wrapper) this.endTransactionSpan(wrapper, 'commit_failed', error);
      throw error;
    }
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    const wrapper = asWrapper(connection);
    try {
      await this.inner.rollbackTransaction(unwrap(connection));
      if (wrapper) this.endTransactionSpan(wrapper, 'rolled_back');
    } catch (error) {
      if (wrapper) this.endTransactionSpan(wrapper, 'rollback_failed', error);
      throw error;
    }
  }

  async releaseConnection(
    connection: DatabaseConnection,
    options?: Parameters<Driver['releaseConnection']>[1],
  ): Promise<void> {
    const wrapper = asWrapper(connection);
    // Defensive: spans must never outlive their connection lease.
    wrapper?.endOpenStreamSpans();
    if (wrapper?.transactionSpan) this.endTransactionSpan(wrapper, 'released_unfinished');
    return this.inner.releaseConnection(unwrap(connection), options);
  }

  destroy(options?: Parameters<Driver['destroy']>[0]): Promise<void> {
    return this.inner.destroy(options);
  }

  private startTransactionSpan(wrapper: ObservedConnection): void {
    try {
      const parent = context.active();
      const attributes: Attributes = { [ATTR_DB_SYSTEM]: this.deps.dbSystem };
      const { namespace, serverAddress, serverPort } = this.deps.options;
      if (namespace !== undefined) attributes[ATTR_DB_NAMESPACE] = namespace;
      if (serverAddress !== undefined) attributes[ATTR_SERVER_ADDRESS] = serverAddress;
      if (serverPort !== undefined) attributes[ATTR_SERVER_PORT] = serverPort;
      const span = this.deps.tracer.startSpan(
        'TRANSACTION',
        { kind: SpanKind.CLIENT, attributes },
        parent,
      );
      wrapper.transactionSpan = span;
      wrapper.transactionParentSpan = trace.getSpan(parent);
      wrapper.transactionContext = trace.setSpan(parent, span);
    } catch (error) {
      warnLimited('failed to start transaction span', error);
    }
  }

  private endTransactionSpan(
    wrapper: ObservedConnection,
    outcome: string,
    error?: unknown,
  ): void {
    const span = wrapper.transactionSpan;
    wrapper.transactionSpan = undefined;
    wrapper.transactionContext = undefined;
    wrapper.transactionParentSpan = undefined;
    if (!span) return;
    try {
      span.setAttribute(ATTR_TRANSACTION_OUTCOME, outcome);
      if (error !== undefined) recordError(span, error, this.deps.options);
    } catch (err) {
      warnLimited('failed to finalize transaction span', err);
    } finally {
      span.end();
    }
  }
}

function asWrapper(connection: DatabaseConnection): ObservedConnection | undefined {
  return connection instanceof ObservedConnection ? connection : undefined;
}

function unwrap(connection: DatabaseConnection): DatabaseConnection {
  return connection instanceof ObservedConnection ? connection.inner : connection;
}

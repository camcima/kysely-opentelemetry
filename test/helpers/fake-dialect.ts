import {
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
  type TransactionSettings,
} from 'kysely';

export type QueryScript = (compiledQuery: CompiledQuery) => QueryResult<any>;

export class FakeConnection implements DatabaseConnection {
  readonly executed: CompiledQuery[] = [];

  constructor(private readonly script: QueryScript) {}

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    this.executed.push(compiledQuery);
    return this.script(compiledQuery) as QueryResult<R>;
  }

  async *streamQuery<R>(
    compiledQuery: CompiledQuery,
    _chunkSize: number,
  ): AsyncIterableIterator<QueryResult<R>> {
    this.executed.push(compiledQuery);
    const result = this.script(compiledQuery) as QueryResult<R>;
    for (const row of result.rows) yield { rows: [row] };
  }
}

export class FakeDriver implements Driver {
  readonly connection: FakeConnection;
  readonly calls: string[] = [];
  /** Artificial delay for acquireConnection, for pool-timing tests. */
  acquireDelayMs = 0;

  constructor(script: QueryScript) {
    this.connection = new FakeConnection(script);
  }

  async init(): Promise<void> {
    this.calls.push('init');
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    this.calls.push('acquire');
    if (this.acquireDelayMs > 0) await new Promise((r) => setTimeout(r, this.acquireDelayMs));
    return this.connection;
  }

  async beginTransaction(connection: DatabaseConnection, _settings: TransactionSettings): Promise<void> {
    this.calls.push(`begin:${connection === this.connection ? 'inner' : 'WRAPPED'}`);
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    this.calls.push(`commit:${connection === this.connection ? 'inner' : 'WRAPPED'}`);
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    this.calls.push(`rollback:${connection === this.connection ? 'inner' : 'WRAPPED'}`);
  }

  async releaseConnection(connection: DatabaseConnection): Promise<void> {
    this.calls.push(`release:${connection === this.connection ? 'inner' : 'WRAPPED'}`);
  }

  async destroy(): Promise<void> {
    this.calls.push('destroy');
  }
}

export function createFakeDialect(script: QueryScript = () => ({ rows: [] })): {
  dialect: Dialect;
  driver: FakeDriver;
} {
  const driver = new FakeDriver(script);
  const dialect: Dialect = {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => driver,
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  };
  return { dialect, driver };
}

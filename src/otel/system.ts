import { MssqlAdapter, MysqlAdapter, PostgresAdapter, SqliteAdapter, type Dialect } from 'kysely';

/**
 * Detect the OTel db.system.name value from the wrapped dialect's adapter.
 * instanceof survives minification and covers community dialects that
 * extend the built-in adapters.
 */
export function detectDbSystem(dialect: Dialect): string {
  try {
    const adapter = dialect.createAdapter();
    if (adapter instanceof PostgresAdapter) return 'postgresql';
    if (adapter instanceof MysqlAdapter) return 'mysql';
    if (adapter instanceof MssqlAdapter) return 'microsoft.sql_server';
    if (adapter instanceof SqliteAdapter) return 'sqlite';
  } catch {
    // fall through to the generic value
  }
  return 'other_sql';
}

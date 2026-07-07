import { MssqlAdapter, MysqlAdapter, PostgresAdapter, SqliteAdapter, type Dialect } from 'kysely';
import { warnLimited } from './spans.js';

const ADAPTER_NAME_TO_SYSTEM: Record<string, string> = {
  PostgresAdapter: 'postgresql',
  MysqlAdapter: 'mysql',
  MssqlAdapter: 'microsoft.sql_server',
  SqliteAdapter: 'sqlite',
};

/**
 * Detect the OTel db.system.name value from the wrapped dialect's adapter.
 * instanceof survives minification and covers community dialects that
 * extend the built-in adapters. When the consumer's kysely is a different
 * module instance than ours (pnpm/npm link, workspace version skew),
 * every instanceof misses, so we fall back to matching constructor names
 * up the prototype chain — that identity-independent check does not
 * survive minification, hence it runs second.
 */
export function detectDbSystem(dialect: Dialect): string {
  try {
    const adapter = dialect.createAdapter();
    if (adapter instanceof PostgresAdapter) return 'postgresql';
    if (adapter instanceof MysqlAdapter) return 'mysql';
    if (adapter instanceof MssqlAdapter) return 'microsoft.sql_server';
    if (adapter instanceof SqliteAdapter) return 'sqlite';
    const byName = detectByConstructorName(adapter);
    if (byName !== undefined) return byName;
  } catch {
    // fall through to the generic value
  }
  warnLimited(
    'db.system.name could not be detected from the dialect adapter; using "other_sql". ' +
      'If your database is PostgreSQL/MySQL/MSSQL/SQLite, this usually means duplicated ' +
      'kysely module instances (pnpm/npm link, workspace version skew) or a minified ' +
      'bundle. Set the dbSystem option to override.',
  );
  return 'other_sql';
}

function detectByConstructorName(adapter: object): string | undefined {
  for (
    let proto: unknown = Object.getPrototypeOf(adapter);
    proto !== null && proto !== undefined;
    proto = Object.getPrototypeOf(proto)
  ) {
    const name = (proto as { constructor?: { name?: unknown } }).constructor?.name;
    if (typeof name === 'string') {
      const system = ADAPTER_NAME_TO_SYSTEM[name];
      if (system !== undefined) return system;
    }
  }
  return undefined;
}

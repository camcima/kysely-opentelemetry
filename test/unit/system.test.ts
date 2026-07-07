import { diag } from '@opentelemetry/api';
import { MssqlAdapter, MysqlAdapter, PostgresAdapter, SqliteAdapter, type Dialect } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { detectDbSystem } from '../../src/otel/system.js';

function dialectWithAdapter(adapter: unknown): Dialect {
  return { createAdapter: () => adapter } as unknown as Dialect;
}

describe('detectDbSystem', () => {
  it('detects the four built-in adapters', () => {
    expect(detectDbSystem(dialectWithAdapter(new PostgresAdapter()))).toBe('postgresql');
    expect(detectDbSystem(dialectWithAdapter(new MysqlAdapter()))).toBe('mysql');
    expect(detectDbSystem(dialectWithAdapter(new SqliteAdapter()))).toBe('sqlite');
    expect(detectDbSystem(dialectWithAdapter(new MssqlAdapter()))).toBe('microsoft.sql_server');
  });

  it('detects adapter subclasses (community dialects extend built-ins)', () => {
    class NeonAdapter extends PostgresAdapter {}
    expect(detectDbSystem(dialectWithAdapter(new NeonAdapter()))).toBe('postgresql');
  });

  it('falls back to other_sql on unknown or throwing adapters', () => {
    expect(detectDbSystem(dialectWithAdapter({}))).toBe('other_sql');
    expect(
      detectDbSystem({
        createAdapter: () => {
          throw new Error('boom');
        },
      } as unknown as Dialect),
    ).toBe('other_sql');
  });

  it('detects by constructor name when instanceof misses (duplicated kysely copies)', () => {
    // Same class names as kysely's adapters, different class identity —
    // simulates a second kysely module instance (pnpm/npm link, version skew).
    const DupPostgres = class PostgresAdapter {};
    const DupMysql = class MysqlAdapter {};
    const DupMssql = class MssqlAdapter {};
    const DupSqlite = class SqliteAdapter {};
    expect(detectDbSystem(dialectWithAdapter(new DupPostgres()))).toBe('postgresql');
    expect(detectDbSystem(dialectWithAdapter(new DupMysql()))).toBe('mysql');
    expect(detectDbSystem(dialectWithAdapter(new DupMssql()))).toBe('microsoft.sql_server');
    expect(detectDbSystem(dialectWithAdapter(new DupSqlite()))).toBe('sqlite');
  });

  it('walks the prototype chain for subclasses of a duplicated adapter class', () => {
    const DupPostgres = class PostgresAdapter {};
    class NeonAdapter extends DupPostgres {}
    expect(detectDbSystem(dialectWithAdapter(new NeonAdapter()))).toBe('postgresql');
  });

  it('warns through diag when detection falls back to other_sql', () => {
    const spy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    detectDbSystem(dialectWithAdapter({}));
    expect(spy).toHaveBeenCalledTimes(1);
    const message = String(spy.mock.calls[0]![0]);
    expect(message).toContain('other_sql');
    expect(message).toContain('dbSystem');
    spy.mockRestore();
  });

  it('does not warn when detection succeeds', () => {
    const spy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    detectDbSystem(dialectWithAdapter(new PostgresAdapter()));
    const DupPostgres = class PostgresAdapter {};
    detectDbSystem(dialectWithAdapter(new DupPostgres()));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

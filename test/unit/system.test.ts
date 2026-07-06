import { MssqlAdapter, MysqlAdapter, PostgresAdapter, SqliteAdapter, type Dialect } from 'kysely';
import { describe, expect, it } from 'vitest';
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
});

import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
  type CompiledQuery,
} from 'kysely';

/** Kysely instance that compiles real queries without a database. */
export const db = new Kysely<any>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (k) => new PostgresIntrospector(k),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

export function compile(build: (k: Kysely<any>) => { compile(): CompiledQuery }): CompiledQuery {
  return build(db).compile();
}

export function compileRaw(rawSql: string): CompiledQuery {
  return sql.raw(rawSql).compile(db);
}

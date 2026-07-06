# kysely-opentelemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `kysely-opentelemetry` v0.1.0 — a zero-dependency npm package that wraps a Kysely dialect and emits semconv-compliant OpenTelemetry CLIENT spans and a duration histogram with stable grouping keys (summary/fingerprint/hash), per `docs/superpowers/specs/2026-07-06-kysely-opentelemetry-design.md`.

**Architecture:** Explicit wrapper composition (`observeDialect`) over Kysely's public `Dialect`/`Driver`/`DatabaseConnection` interfaces. AST-first query analysis from `compiledQuery.query` (Kysely's `RootOperationNode`), regex sanitizer as defense-in-depth only. Pure `analysis/` layer (no OTel imports) feeding an `otel/` layer that touches only `@opentelemetry/api`.

**Tech Stack:** TypeScript (strict), pnpm, tsup (dual ESM/CJS), vitest, `@opentelemetry/api` (peer), kysely (peer), testcontainers + better-sqlite3 for integration tests, GitHub Actions CI.

## Global Constraints

- Package name: `kysely-opentelemetry`, version `0.1.0`, MIT license.
- Zero runtime dependencies. Peers: `"kysely": ">=0.27 <0.30"`, `"@opentelemetry/api": ">=1.8"`. OTel SDK packages appear ONLY in devDependencies (tests).
- Never import from `@opentelemetry/sdk-*` in `src/`. Only `@opentelemetry/api`.
- Never emit raw parameter values through any code path. No option enables it.
- Instrumentation must never break a query: every analysis/OTel step is guarded; on internal failure the query executes un-instrumented and a rate-limited `diag.warn` fires (never `console`, never a thrown error).
- Query errors are rethrown unchanged, never wrapped.
- Attribute names are fixed constants (see Task 11) — no user overrides.
- Truncation limits: query text & fingerprint 4096 chars (`maxQueryTextLength` default), summary 255 chars, tables list 20 entries.
- Kysely 0.27 compatibility: `Driver.savepoint`/`rollbackToSavepoint`/`releaseSavepoint` and `DatabaseConnection.cancelQuery`/`collectSessionInfo`/`killSession` are optional and only exist in newer versions — wrappers define them conditionally (only when the inner object has them) and always unwrap connections before delegating.
- All source files use ESM imports with explicit `.js` extensions (tsup + NodeNext interop).
- Conventional commit messages (`feat:`, `test:`, `chore:`, `docs:`, `ci:`).

## Verified Kysely 0.29.3 interfaces (source of truth for wrapper signatures)

```ts
interface Dialect {
  createDriver(): Driver;
  createQueryCompiler(): QueryCompiler;
  createAdapter(): DialectAdapter;
  createIntrospector(db: Kysely<any>): DatabaseIntrospector;
}
interface Driver {
  init(options?: AbortableOperationOptions): Promise<void>;
  acquireConnection(options?: AbortableOperationOptions): Promise<DatabaseConnection>;
  beginTransaction(connection: DatabaseConnection, settings: TransactionSettings): Promise<void>;
  commitTransaction(connection: DatabaseConnection): Promise<void>;
  rollbackTransaction(connection: DatabaseConnection): Promise<void>;
  savepoint?(connection, savepointName: string, compileQuery): Promise<void>;          // 0.28+
  rollbackToSavepoint?(connection, savepointName: string, compileQuery): Promise<void>; // 0.28+
  releaseSavepoint?(connection, savepointName: string, compileQuery): Promise<void>;    // 0.28+
  releaseConnection(connection: DatabaseConnection, options?): Promise<void>;
  destroy(options?): Promise<void>;
}
interface DatabaseConnection {
  executeQuery<R>(compiledQuery: CompiledQuery, options?): Promise<QueryResult<R>>;
  streamQuery<R>(compiledQuery: CompiledQuery, chunkSize: number, options?): AsyncIterableIterator<QueryResult<R>>;
  cancelQuery?(controlConnectionProvider): Promise<void>;   // 0.29+
  collectSessionInfo?(): Promise<void>;                     // 0.29+
  killSession?(controlConnectionProvider): Promise<void>;   // 0.29+
}
interface CompiledQuery<O = unknown> {
  readonly query: RootOperationNode;  // the AST — kind: 'SelectQueryNode' | 'RawNode' | ...
  readonly queryId: QueryId;
  readonly sql: string;
  readonly parameters: ReadonlyArray<unknown>;
}
interface QueryResult<O> {
  readonly numAffectedRows?: bigint;
  readonly numChangedRows?: bigint;
  readonly insertId?: bigint;
  readonly rows: O[];
}
// TableNode: { kind: 'TableNode', table: { kind: 'SchemableIdentifierNode',
//              schema?: { name: string }, identifier: { name: string } } }
```

Pass generic `options` params through verbatim; type them as `Parameters<Driver['init']>[0]`-style or plain optional `unknown` is NOT acceptable — use the actual Kysely types where exported, else copy the wrapper method signature from the inner interface member (`Driver['acquireConnection']` etc.).

## File Structure

```
package.json  tsconfig.json  tsup.config.ts  vitest.config.ts  eslint.config.js  .gitignore
src/
  index.ts                 public exports
  version.ts               VERSION constant
  options.ts               KyselyOtelOptions, NormalizedOptions, normalizeOptions
  observed-dialect.ts      ObservedDialect + observeDialect()
  observed-driver.ts       ObservedDriver (WeakMap wrapping, unwrap, acquire timing, tx spans)
  observed-connection.ts   ObservedConnection (executeQuery + streamQuery spans)
  analysis/
    lru.ts fingerprint.ts hash.ts operation.ts tables.ts summary.ts analyze.ts
  otel/
    system.ts attributes.ts spans.ts metrics.ts
test/
  helpers/compile.ts       DummyDriver-based Kysely instance → real CompiledQuery objects
  helpers/fake-dialect.ts  scripted fake dialect
  helpers/otel.ts          in-memory tracer/meter setup + teardown
  unit/                    one test file per analysis/otel module
  otel/                    end-to-end wrapper tests via InMemorySpanExporter
  integration/             sqlite.test.ts postgres.test.ts mysql.test.ts
.github/workflows/ci.yml
README.md
```

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `eslint.config.js`, `.gitignore`, `LICENSE`, `src/version.ts`, `src/index.ts`, `test/unit/smoke.test.ts`

**Interfaces:**
- Produces: `src/version.ts` exporting `export const VERSION = '0.1.0'`; working `pnpm test:unit`, `pnpm build`, `pnpm typecheck` commands all later tasks rely on.

- [ ] **Step 1: Write config files**

`package.json`:

```json
{
  "name": "kysely-opentelemetry",
  "version": "0.1.0",
  "description": "OpenTelemetry instrumentation for Kysely: semconv-compliant spans and metrics with stable query grouping keys",
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "files": ["dist"],
  "sideEffects": false,
  "engines": { "node": ">=18" },
  "keywords": ["kysely", "opentelemetry", "otel", "tracing", "observability", "sql", "database"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run test/unit test/otel",
    "test:unit": "vitest run test/unit test/otel",
    "test:integration": "vitest run test/integration",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src test"
  },
  "peerDependencies": {
    "kysely": ">=0.27 <0.30",
    "@opentelemetry/api": ">=1.8"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "declaration": true,
    "skipLibCheck": true,
    "noEmit": true,
    "lib": ["ES2022"],
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

`tsup.config.ts`:

```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node18',
});
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
```

`eslint.config.js`:

```js
import tseslint from 'typescript-eslint';

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  { ignores: ['dist/**', 'docs/**'] },
);
```

`.gitignore`:

```
node_modules/
dist/
*.tsbuildinfo
```

`LICENSE`: standard MIT license text with `Copyright (c) 2026 Carlos Cima`.

`src/version.ts`:

```ts
export const VERSION = '0.1.0';
```

`src/index.ts` (placeholder, replaced in Task 15):

```ts
export { VERSION } from './version.js';
```

- [ ] **Step 2: Install dev dependencies**

Run:

```bash
pnpm add -D typescript tsup vitest eslint typescript-eslint @types/node \
  kysely@0.29.3 @opentelemetry/api \
  @opentelemetry/sdk-trace-base @opentelemetry/sdk-metrics @opentelemetry/context-async-hooks \
  better-sqlite3 @types/better-sqlite3 pg @types/pg mysql2 \
  @testcontainers/postgresql @testcontainers/mysql
```

Expected: succeeds; `pnpm-lock.yaml` created. (kysely and @opentelemetry/api are installed as dev deps for local building/testing; they remain peers for consumers.)

- [ ] **Step 3: Write smoke test**

`test/unit/smoke.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { VERSION } from '../../src/version.js';

describe('scaffolding', () => {
  it('exposes the package version', () => {
    expect(VERSION).toBe('0.1.0');
  });
});
```

- [ ] **Step 4: Verify toolchain**

Run: `pnpm test:unit && pnpm typecheck && pnpm build`
Expected: 1 test passes; typecheck clean; `dist/index.js`, `dist/index.cjs`, `dist/index.d.ts` produced.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold package with pnpm, tsup, vitest, eslint"
```

---

### Task 2: LRU cache

**Files:**
- Create: `src/analysis/lru.ts`
- Test: `test/unit/lru.test.ts`

**Interfaces:**
- Produces: `class LruCache<K, V> { constructor(maxSize: number); get(key: K): V | undefined; set(key: K, value: V): void; readonly size: number }`

- [ ] **Step 1: Write the failing test**

`test/unit/lru.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { LruCache } from '../../src/analysis/lru.js';

describe('LruCache', () => {
  it('stores and retrieves values', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('missing')).toBeUndefined();
  });

  it('evicts the least recently used entry when full', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
    expect(cache.size).toBe(2);
  });

  it('get refreshes recency', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a');
    cache.set('c', 3);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
  });

  it('overwriting a key does not evict', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 9);
    expect(cache.get('a')).toBe(9);
    expect(cache.get('b')).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/lru.test.ts`
Expected: FAIL — cannot resolve `src/analysis/lru.js`.

- [ ] **Step 3: Write minimal implementation**

`src/analysis/lru.ts`:

```ts
/**
 * Minimal Map-based LRU. Map preserves insertion order; re-inserting on
 * get() makes the first key the least recently used.
 */
export class LruCache<K, V> {
  readonly #map = new Map<K, V>();

  constructor(private readonly maxSize: number) {}

  get size(): number {
    return this.#map.size;
  }

  get(key: K): V | undefined {
    if (!this.#map.has(key)) return undefined;
    const value = this.#map.get(key) as V;
    this.#map.delete(key);
    this.#map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.#map.has(key)) {
      this.#map.delete(key);
    } else if (this.#map.size >= this.maxSize) {
      const oldest = this.#map.keys().next();
      if (!oldest.done) this.#map.delete(oldest.value);
    }
    this.#map.set(key, value);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/lru.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/analysis/lru.ts test/unit/lru.test.ts
git commit -m "feat: add internal LRU cache"
```

---

### Task 3: Fingerprint hash

**Files:**
- Create: `src/analysis/hash.ts`
- Test: `test/unit/hash.test.ts`

**Interfaces:**
- Produces: `function hashFingerprint(fingerprint: string): string` — first 16 hex chars of SHA-256.

- [ ] **Step 1: Write the failing test**

`test/unit/hash.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { hashFingerprint } from '../../src/analysis/hash.js';

describe('hashFingerprint', () => {
  it('returns the first 16 hex chars of sha256', () => {
    // sha256('') = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    expect(hashFingerprint('')).toBe('e3b0c44298fc1c14');
  });

  it('is deterministic and 16 chars', () => {
    const a = hashFingerprint('SELECT * FROM orders WHERE id = ?');
    expect(a).toBe(hashFingerprint('SELECT * FROM orders WHERE id = ?'));
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('differs for different fingerprints', () => {
    expect(hashFingerprint('SELECT a')).not.toBe(hashFingerprint('SELECT b'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/hash.test.ts`
Expected: FAIL — cannot resolve `src/analysis/hash.js`.

- [ ] **Step 3: Write minimal implementation**

`src/analysis/hash.ts`:

```ts
import { createHash } from 'node:crypto';

export function hashFingerprint(fingerprint: string): string {
  return createHash('sha256').update(fingerprint).digest('hex').slice(0, 16);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/hash.test.ts`
Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/analysis/hash.ts test/unit/hash.test.ts
git commit -m "feat: add sha256 fingerprint hash"
```

---

### Task 4: SQL fingerprinting

**Files:**
- Create: `src/analysis/fingerprint.ts`
- Test: `test/unit/fingerprint.test.ts`

**Interfaces:**
- Produces: `function fingerprintSql(sql: string): string` — literals and placeholders normalized to `?`, IN lists collapsed, whitespace normalized. Pure, no truncation (caller truncates).

- [ ] **Step 1: Write the failing test**

`test/unit/fingerprint.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fingerprintSql } from '../../src/analysis/fingerprint.js';

describe('fingerprintSql', () => {
  it('replaces string literals', () => {
    expect(fingerprintSql("SELECT * FROM users WHERE email = 'bob@example.com'"))
      .toBe('SELECT * FROM users WHERE email = ?');
  });

  it('handles escaped quotes inside strings', () => {
    expect(fingerprintSql("SELECT * FROM t WHERE name = 'O''Brien'"))
      .toBe('SELECT * FROM t WHERE name = ?');
  });

  it('replaces dollar-quoted strings (tagged and untagged)', () => {
    expect(fingerprintSql('SELECT $$secret value$$')).toBe('SELECT ?');
    expect(fingerprintSql('SELECT $tag$ nested $$ inside $tag$')).toBe('SELECT ?');
  });

  it('replaces numeric, hex and uuid literals', () => {
    expect(fingerprintSql('SELECT * FROM t WHERE a = 42 AND b = 3.14 AND c = 0xDEADbeef'))
      .toBe('SELECT * FROM t WHERE a = ? AND b = ? AND c = ?');
    expect(fingerprintSql("WHERE id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'")).toBe('WHERE id = ?');
    expect(fingerprintSql('WHERE id = a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11')).toBe('WHERE id = ?');
  });

  it('normalizes positional placeholders to ?', () => {
    expect(fingerprintSql('SELECT * FROM orders WHERE id = $1 AND status = $2'))
      .toBe('SELECT * FROM orders WHERE id = ? AND status = ?');
    expect(fingerprintSql('SELECT * FROM orders WHERE id = @p1'))
      .toBe('SELECT * FROM orders WHERE id = ?');
  });

  it('leaves ? placeholders intact', () => {
    expect(fingerprintSql('SELECT * FROM orders WHERE id = ?'))
      .toBe('SELECT * FROM orders WHERE id = ?');
  });

  it('collapses IN lists of placeholders and literals', () => {
    expect(fingerprintSql('WHERE id IN (1, 2, 3)')).toBe('WHERE id IN (?)');
    expect(fingerprintSql('WHERE id IN ($1, $2, $3)')).toBe('WHERE id IN (?)');
    expect(fingerprintSql('WHERE id in (?,?,?)')).toBe('WHERE id IN (?)');
  });

  it('does not mangle identifiers containing digits', () => {
    expect(fingerprintSql('SELECT col1 FROM table2')).toBe('SELECT col1 FROM table2');
  });

  it('normalizes whitespace', () => {
    expect(fingerprintSql('SELECT *\n  FROM   orders\n WHERE id = 1'))
      .toBe('SELECT * FROM orders WHERE id = ?');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/fingerprint.test.ts`
Expected: FAIL — cannot resolve `src/analysis/fingerprint.js`.

- [ ] **Step 3: Write minimal implementation**

`src/analysis/fingerprint.ts`:

```ts
/**
 * Regex-based SQL normalization. Kysely parameterizes all builder values,
 * so literal scrubbing here is defense-in-depth for sql.raw / sql.lit
 * fragments. Order matters: strings before placeholders before numbers
 * ($1 must not be half-eaten by the numeric rule).
 */
const DOLLAR_QUOTED = /\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g;
const SINGLE_QUOTED = /'(?:''|[^'])*'/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX = /\b0x[0-9a-f]+\b/gi;
const PLACEHOLDER = /\$\d+|@p\d+\b/gi;
const NUMBER = /\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/gi;
const IN_LIST = /\bIN\s*\(\s*\?(?:\s*,\s*\?)*\s*\)/gi;
const WHITESPACE = /\s+/g;

export function fingerprintSql(sql: string): string {
  return sql
    .replace(DOLLAR_QUOTED, '?')
    .replace(SINGLE_QUOTED, '?')
    .replace(UUID, '?')
    .replace(HEX, '?')
    .replace(PLACEHOLDER, '?')
    .replace(NUMBER, '?')
    .replace(IN_LIST, 'IN (?)')
    .replace(WHITESPACE, ' ')
    .trim();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/fingerprint.test.ts`
Expected: 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/analysis/fingerprint.ts test/unit/fingerprint.test.ts
git commit -m "feat: add regex SQL fingerprinting"
```

---

### Task 5: Operation name from AST

**Files:**
- Create: `src/analysis/operation.ts`, `test/helpers/compile.ts`
- Test: `test/unit/operation.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `function operationName(node: RootOperationNode, sql: string): string`; test helper `compile(build: (db: Kysely<any>) => { compile(): CompiledQuery }): CompiledQuery` and `compileRaw(sql: string): CompiledQuery` in `test/helpers/compile.ts` (used by Tasks 6, 8, 10, 11).

- [ ] **Step 1: Write the compile helper**

`test/helpers/compile.ts`:

```ts
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
```

- [ ] **Step 2: Write the failing test**

`test/unit/operation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { operationName } from '../../src/analysis/operation.js';
import { compile, compileRaw } from '../helpers/compile.js';

describe('operationName', () => {
  it('maps DML query node kinds', () => {
    const select = compile((db) => db.selectFrom('orders').selectAll());
    expect(operationName(select.query, select.sql)).toBe('SELECT');

    const insert = compile((db) => db.insertInto('orders').values({ id: 1 }));
    expect(operationName(insert.query, insert.sql)).toBe('INSERT');

    const update = compile((db) => db.updateTable('orders').set({ id: 2 }).where('id', '=', 1));
    expect(operationName(update.query, update.sql)).toBe('UPDATE');

    const del = compile((db) => db.deleteFrom('orders').where('id', '=', 1));
    expect(operationName(del.query, del.sql)).toBe('DELETE');
  });

  it('maps DDL node kinds to spaced verbs', () => {
    const create = compile((db) => db.schema.createTable('t').addColumn('id', 'integer'));
    expect(operationName(create.query, create.sql)).toBe('CREATE TABLE');

    const drop = compile((db) => db.schema.dropTable('t'));
    expect(operationName(drop.query, drop.sql)).toBe('DROP TABLE');
  });

  it('derives raw SQL operation from the first keyword', () => {
    const cq = compileRaw('CALL refresh_customer_stats()');
    expect(operationName(cq.query, cq.sql)).toBe('CALL');
  });

  it('falls back to SQL for unrecognizable raw text', () => {
    const cq = compileRaw('!!!');
    expect(operationName(cq.query, cq.sql)).toBe('SQL');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run test/unit/operation.test.ts`
Expected: FAIL — cannot resolve `src/analysis/operation.js`.

- [ ] **Step 4: Write minimal implementation**

`src/analysis/operation.ts`:

```ts
import type { RootOperationNode } from 'kysely';

const FIRST_KEYWORD = /[A-Za-z]+/;

/**
 * 'SelectQueryNode' → 'SELECT', 'CreateTableNode' → 'CREATE TABLE'.
 * RawNode → first keyword of the SQL text, or 'SQL' when none.
 */
export function operationName(node: RootOperationNode, sql: string): string {
  if (node.kind === 'RawNode') {
    const keyword = FIRST_KEYWORD.exec(sql)?.[0];
    return keyword ? keyword.toUpperCase() : 'SQL';
  }
  return node.kind
    .replace(/(Query)?Node$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toUpperCase();
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run test/unit/operation.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/analysis/operation.ts test/unit/operation.test.ts test/helpers/compile.ts
git commit -m "feat: derive operation name from Kysely AST"
```

---

### Task 6: Table extraction

**Files:**
- Create: `src/analysis/tables.ts`
- Test: `test/unit/tables.test.ts`

**Interfaces:**
- Consumes: `compile`/`compileRaw` from `test/helpers/compile.ts` (Task 5).
- Produces: `function extractTables(node: object): string[]` (generic AST walk, deduped, first-seen order, max 20, schema-qualified when schema present) and `function extractTablesFromRawSql(sql: string): string[]` (best-effort regex).

- [ ] **Step 1: Write the failing test**

`test/unit/tables.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { extractTables, extractTablesFromRawSql } from '../../src/analysis/tables.js';
import { compile } from '../helpers/compile.js';

describe('extractTables', () => {
  it('extracts the FROM table', () => {
    const cq = compile((db) => db.selectFrom('orders').selectAll());
    expect(extractTables(cq.query)).toEqual(['orders']);
  });

  it('extracts join tables in first-seen order, deduped', () => {
    const cq = compile((db) =>
      db
        .selectFrom('orders')
        .innerJoin('customers', 'customers.id', 'orders.customer_id')
        .leftJoin('customers as c2', 'c2.id', 'orders.customer_id')
        .selectAll(),
    );
    expect(extractTables(cq.query)).toEqual(['orders', 'customers']);
  });

  it('extracts tables from subqueries and CTEs', () => {
    const cq = compile((db) =>
      db
        .with('recent', (qb) => qb.selectFrom('events').selectAll())
        .selectFrom('recent')
        .selectAll(),
    );
    expect(extractTables(cq.query)).toContain('events');
  });

  it('qualifies schema-prefixed tables', () => {
    const cq = compile((db) => db.selectFrom('archive.orders').selectAll());
    expect(extractTables(cq.query)).toEqual(['archive.orders']);
  });

  it('extracts insert/update/delete targets', () => {
    const ins = compile((db) => db.insertInto('orders').values({ id: 1 }));
    expect(extractTables(ins.query)).toEqual(['orders']);
    const upd = compile((db) => db.updateTable('users').set({ id: 1 }));
    expect(extractTables(upd.query)).toEqual(['users']);
  });

  it('caps at 20 tables', () => {
    const cq = compile((db) => {
      let qb = db.selectFrom('t0').selectAll();
      for (let i = 1; i < 30; i += 1) {
        qb = qb.innerJoin(`t${i}`, `t${i}.id`, 't0.id') as typeof qb;
      }
      return qb;
    });
    expect(extractTables(cq.query)).toHaveLength(20);
  });
});

describe('extractTablesFromRawSql', () => {
  it('finds FROM/JOIN/INTO/UPDATE targets', () => {
    expect(extractTablesFromRawSql('SELECT * FROM orders JOIN customers ON 1=1')).toEqual([
      'orders',
      'customers',
    ]);
    expect(extractTablesFromRawSql('INSERT INTO shipping_details VALUES (1)')).toEqual([
      'shipping_details',
    ]);
    expect(extractTablesFromRawSql('UPDATE public.users SET a = 1')).toEqual(['public.users']);
  });

  it('returns empty for unparsable SQL', () => {
    expect(extractTablesFromRawSql('CALL refresh()')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/tables.test.ts`
Expected: FAIL — cannot resolve `src/analysis/tables.js`.

- [ ] **Step 3: Write minimal implementation**

`src/analysis/tables.ts`:

```ts
export const MAX_TABLES = 20;

interface TableNodeShape {
  kind: 'TableNode';
  table: { schema?: { name: string }; identifier: { name: string } };
}

/**
 * Generic recursive walk over the operation-node tree collecting every
 * TableNode. Walking generically (instead of per-clause) covers joins,
 * subqueries, CTEs and dialect-specific nodes for free.
 */
export function extractTables(node: object): string[] {
  const tables: string[] = [];
  walk(node, tables, new Set<string>());
  return tables;
}

function walk(value: unknown, tables: string[], seen: Set<string>): void {
  if (tables.length >= MAX_TABLES || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, tables, seen);
    return;
  }
  const node = value as { kind?: string };
  if (node.kind === 'TableNode') {
    const { table } = node as unknown as TableNodeShape;
    const name = table.schema
      ? `${table.schema.name}.${table.identifier.name}`
      : table.identifier.name;
    if (!seen.has(name)) {
      seen.add(name);
      tables.push(name);
    }
    return;
  }
  for (const child of Object.values(node)) walk(child, tables, seen);
}

const RAW_TABLE = /\b(?:from|join|into|update)\s+(?:only\s+)?([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)/gi;

/** Best-effort extraction for RawNode queries. */
export function extractTablesFromRawSql(sql: string): string[] {
  const tables: string[] = [];
  const seen = new Set<string>();
  const regex = new RegExp(RAW_TABLE.source, RAW_TABLE.flags);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(sql)) !== null && tables.length < MAX_TABLES) {
    const name = match[1];
    if (name && !seen.has(name)) {
      seen.add(name);
      tables.push(name);
    }
  }
  return tables;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/tables.test.ts`
Expected: 8 tests PASS. (If the alias test surfaces `c2`-style alias handling issues, the assertion is on real Kysely output — adjust the implementation, not the test intent: aliases must not appear, base table names must.)

- [ ] **Step 5: Commit**

```bash
git add src/analysis/tables.ts test/unit/tables.test.ts
git commit -m "feat: extract table names from Kysely AST and raw SQL"
```

---

### Task 7: Query summary

**Files:**
- Create: `src/analysis/summary.ts`
- Test: `test/unit/summary.test.ts`

**Interfaces:**
- Produces: `function summarize(operation: string, tables: string[]): string` — `"{OPERATION} {tables…}"`, `unknown` fallback, 255-char cap.

- [ ] **Step 1: Write the failing test**

`test/unit/summary.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { summarize } from '../../src/analysis/summary.js';

describe('summarize', () => {
  it('joins operation and tables with spaces', () => {
    expect(summarize('SELECT', ['orders'])).toBe('SELECT orders');
    expect(summarize('SELECT', ['orders', 'customers'])).toBe('SELECT orders customers');
  });

  it('falls back to unknown with no tables', () => {
    expect(summarize('CALL', [])).toBe('CALL unknown');
  });

  it('truncates to 255 chars', () => {
    const tables = Array.from({ length: 50 }, (_, i) => `very_long_table_name_${i}`);
    const summary = summarize('SELECT', tables);
    expect(summary.length).toBeLessThanOrEqual(255);
    expect(summary.startsWith('SELECT very_long_table_name_0')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/summary.test.ts`
Expected: FAIL — cannot resolve `src/analysis/summary.js`.

- [ ] **Step 3: Write minimal implementation**

`src/analysis/summary.ts`:

```ts
export const MAX_SUMMARY_LENGTH = 255;

export function summarize(operation: string, tables: string[]): string {
  const target = tables.length > 0 ? tables.join(' ') : 'unknown';
  return `${operation} ${target}`.slice(0, MAX_SUMMARY_LENGTH);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/summary.test.ts`
Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/analysis/summary.ts test/unit/summary.test.ts
git commit -m "feat: add db.query.summary generation"
```

---

### Task 8: Options normalization

**Files:**
- Create: `src/options.ts`
- Test: `test/unit/options.test.ts`

**Interfaces:**
- Consumes: `QueryContext` type from Task 10 — to avoid a forward dependency, `options.ts` declares the hook with a type-only import from `./analysis/analyze.js`; Task 10 creates that module. Until Task 10 lands, use a local `interface QueryContextLike` placeholder REPLACED in Task 10 (see its Step 5).
- Produces:

```ts
export interface KyselyOtelOptions {
  enabled?: boolean;
  dbSystem?: string;
  queryText?: 'off' | 'sanitized' | 'parameterized';
  maxQueryTextLength?: number;
  fingerprint?: boolean;
  summary?: boolean;
  tables?: boolean;
  hash?: boolean;
  metrics?: boolean;
  transactions?: boolean;
  recordExceptions?: boolean;
  attributes?: (ctx: QueryContext) => Attributes;
  redact?: (sql: string) => string;
}
export interface NormalizedOptions { /* same fields, required except dbSystem/attributes/redact */ }
export function normalizeOptions(options?: KyselyOtelOptions): NormalizedOptions;
```

- [ ] **Step 1: Write the failing test**

`test/unit/options.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { normalizeOptions } from '../../src/options.js';

describe('normalizeOptions', () => {
  it('applies safe defaults', () => {
    const opts = normalizeOptions();
    expect(opts).toMatchObject({
      enabled: true,
      queryText: 'sanitized',
      maxQueryTextLength: 4096,
      fingerprint: true,
      summary: true,
      tables: true,
      hash: true,
      metrics: true,
      transactions: true,
      recordExceptions: true,
    });
    expect(opts.dbSystem).toBeUndefined();
    expect(opts.attributes).toBeUndefined();
    expect(opts.redact).toBeUndefined();
  });

  it('honors overrides', () => {
    const redact = (sql: string) => sql;
    const opts = normalizeOptions({ enabled: false, queryText: 'off', metrics: false, redact });
    expect(opts.enabled).toBe(false);
    expect(opts.queryText).toBe('off');
    expect(opts.metrics).toBe(false);
    expect(opts.redact).toBe(redact);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/options.test.ts`
Expected: FAIL — cannot resolve `src/options.js`.

- [ ] **Step 3: Write minimal implementation**

`src/options.ts` (the `QueryContextLike` placeholder is temporary; Task 10 Step 5 replaces it with `import type { QueryContext }`):

```ts
import type { Attributes } from '@opentelemetry/api';

/** Replaced by `import type { QueryContext } from './analysis/analyze.js'` in Task 10. */
export interface QueryContextLike {
  readonly sql: string;
  readonly parameters: ReadonlyArray<unknown>;
}

export interface KyselyOtelOptions {
  /** Kill switch. When false, observeDialect returns the dialect untouched. Default true. */
  enabled?: boolean;
  /** Override db.system.name auto-detection (e.g. 'postgresql'). */
  dbSystem?: string;
  /** db.query.text emission. Default 'sanitized'. */
  queryText?: 'off' | 'sanitized' | 'parameterized';
  /** Max chars for db.query.text and db.query.fingerprint. Default 4096. */
  maxQueryTextLength?: number;
  fingerprint?: boolean;
  summary?: boolean;
  tables?: boolean;
  hash?: boolean;
  /** Emit the db.client.operation.duration histogram. Default true. */
  metrics?: boolean;
  /** Emit TRANSACTION spans. Default true. */
  transactions?: boolean;
  /** span.recordException on query failure. Default true. */
  recordExceptions?: boolean;
  /** Custom attributes hook. Failures are swallowed. Cardinality/PII is the caller's responsibility. */
  attributes?: (ctx: QueryContextLike) => Attributes;
  /** Extra query-text scrubbing, runs last in all emitting modes. Throwing omits db.query.text. */
  redact?: (sql: string) => string;
}

export interface NormalizedOptions {
  readonly enabled: boolean;
  readonly dbSystem?: string;
  readonly queryText: 'off' | 'sanitized' | 'parameterized';
  readonly maxQueryTextLength: number;
  readonly fingerprint: boolean;
  readonly summary: boolean;
  readonly tables: boolean;
  readonly hash: boolean;
  readonly metrics: boolean;
  readonly transactions: boolean;
  readonly recordExceptions: boolean;
  readonly attributes?: (ctx: QueryContextLike) => Attributes;
  readonly redact?: (sql: string) => string;
}

export function normalizeOptions(options: KyselyOtelOptions = {}): NormalizedOptions {
  return {
    enabled: options.enabled ?? true,
    ...(options.dbSystem !== undefined && { dbSystem: options.dbSystem }),
    queryText: options.queryText ?? 'sanitized',
    maxQueryTextLength: options.maxQueryTextLength ?? 4096,
    fingerprint: options.fingerprint ?? true,
    summary: options.summary ?? true,
    tables: options.tables ?? true,
    hash: options.hash ?? true,
    metrics: options.metrics ?? true,
    transactions: options.transactions ?? true,
    recordExceptions: options.recordExceptions ?? true,
    ...(options.attributes !== undefined && { attributes: options.attributes }),
    ...(options.redact !== undefined && { redact: options.redact }),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/options.test.ts`
Expected: 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/options.ts test/unit/options.test.ts
git commit -m "feat: add options interface with safe defaults"
```

---

### Task 9: db.system.name auto-detection

**Files:**
- Create: `src/otel/system.ts`
- Test: `test/unit/system.test.ts`

**Interfaces:**
- Produces: `function detectDbSystem(dialect: Dialect): string` — `'postgresql' | 'mysql' | 'sqlite' | 'microsoft.sql_server' | 'other_sql'` via `instanceof` on `dialect.createAdapter()`.

- [ ] **Step 1: Write the failing test**

`test/unit/system.test.ts`:

```ts
import {
  MssqlAdapter,
  MysqlAdapter,
  PostgresAdapter,
  SqliteAdapter,
  type Dialect,
} from 'kysely';
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/system.test.ts`
Expected: FAIL — cannot resolve `src/otel/system.js`.

- [ ] **Step 3: Write minimal implementation**

`src/otel/system.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/system.test.ts`
Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/otel/system.ts test/unit/system.test.ts
git commit -m "feat: auto-detect db.system.name from dialect adapter"
```

---

### Task 10: Query analyzer

**Files:**
- Create: `src/analysis/analyze.ts`
- Modify: `src/options.ts` (replace `QueryContextLike` with the real `QueryContext` type import)
- Test: `test/unit/analyze.test.ts`

**Interfaces:**
- Consumes: `LruCache` (Task 2), `hashFingerprint` (Task 3), `fingerprintSql` (Task 4), `operationName` (Task 5), `extractTables`/`extractTablesFromRawSql` (Task 6), `summarize` (Task 7), `NormalizedOptions`/`normalizeOptions` (Task 8).
- Produces:

```ts
export interface QueryAnalysis {
  readonly operation: string;
  readonly tables: string[];
  readonly primaryTable?: string;
  readonly summary: string;
  readonly fingerprint: string;
  readonly hash: string;
  readonly isRaw: boolean;
  readonly sanitizationError: boolean;
  readonly text?: string;
}
export interface QueryContext extends QueryAnalysis {
  readonly sql: string;
  readonly parameters: ReadonlyArray<unknown>;
}
export type Analyzer = (compiledQuery: CompiledQuery) => QueryContext;
export function createAnalyzer(options: NormalizedOptions): Analyzer;
```

- [ ] **Step 1: Write the failing test**

`test/unit/analyze.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createAnalyzer } from '../../src/analysis/analyze.js';
import { normalizeOptions } from '../../src/options.js';
import { compile, compileRaw } from '../helpers/compile.js';

const analyze = createAnalyzer(normalizeOptions());

describe('createAnalyzer', () => {
  it('produces a full QueryContext for a builder query', () => {
    const cq = compile((db) => db.selectFrom('orders').selectAll().where('id', '=', 123));
    const ctx = analyze(cq);
    expect(ctx.operation).toBe('SELECT');
    expect(ctx.tables).toEqual(['orders']);
    expect(ctx.primaryTable).toBe('orders');
    expect(ctx.summary).toBe('SELECT orders');
    expect(ctx.fingerprint).toBe('select * from "orders" where "id" = ?');
    expect(ctx.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(ctx.isRaw).toBe(false);
    expect(ctx.sanitizationError).toBe(false);
    expect(ctx.text).toBe(ctx.fingerprint);
    expect(ctx.parameters).toEqual([123]);
  });

  it('flags raw queries and uses best-effort tables', () => {
    const ctx = analyze(compileRaw("SELECT * FROM orders WHERE status = 'paid'"));
    expect(ctx.isRaw).toBe(true);
    expect(ctx.tables).toEqual(['orders']);
    expect(ctx.fingerprint).toBe('SELECT * FROM orders WHERE status = ?');
  });

  it('caches analysis by sql but not parameters', () => {
    const a = analyze(compile((db) => db.selectFrom('t').selectAll().where('id', '=', 1)));
    const b = analyze(compile((db) => db.selectFrom('t').selectAll().where('id', '=', 2)));
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.parameters).toEqual([1]);
    expect(b.parameters).toEqual([2]);
  });

  it('queryText off omits text', () => {
    const analyzeOff = createAnalyzer(normalizeOptions({ queryText: 'off' }));
    const ctx = analyzeOff(compile((db) => db.selectFrom('t').selectAll()));
    expect(ctx.text).toBeUndefined();
  });

  it('queryText parameterized emits compiled sql as-is', () => {
    const analyzeParam = createAnalyzer(normalizeOptions({ queryText: 'parameterized' }));
    const cq = compile((db) => db.selectFrom('t').selectAll().where('id', '=', 1));
    expect(analyzeParam(cq).text).toBe(cq.sql);
  });

  it('redact hook runs last and a throwing hook omits text', () => {
    const analyzeRedact = createAnalyzer(
      normalizeOptions({ redact: (sql) => sql.replace('orders', '[t]') }),
    );
    const ctx = analyzeRedact(compile((db) => db.selectFrom('orders').selectAll()));
    expect(ctx.text).toContain('[t]');
    expect(ctx.fingerprint).toContain('orders'); // fingerprint unaffected by redact

    const analyzeThrow = createAnalyzer(
      normalizeOptions({
        redact: () => {
          throw new Error('boom');
        },
      }),
    );
    expect(analyzeThrow(compile((db) => db.selectFrom('orders').selectAll())).text).toBeUndefined();
  });

  it('truncates fingerprint and text to maxQueryTextLength', () => {
    const analyzeShort = createAnalyzer(normalizeOptions({ maxQueryTextLength: 10 }));
    const ctx = analyzeShort(compile((db) => db.selectFrom('a_rather_long_table_name').selectAll()));
    expect(ctx.fingerprint.length).toBeLessThanOrEqual(10);
    expect((ctx.text ?? '').length).toBeLessThanOrEqual(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/analyze.test.ts`
Expected: FAIL — cannot resolve `src/analysis/analyze.js`.

- [ ] **Step 3: Write minimal implementation**

`src/analysis/analyze.ts`:

```ts
import type { CompiledQuery } from 'kysely';
import type { NormalizedOptions } from '../options.js';
import { fingerprintSql } from './fingerprint.js';
import { hashFingerprint } from './hash.js';
import { LruCache } from './lru.js';
import { operationName } from './operation.js';
import { summarize } from './summary.js';
import { extractTables, extractTablesFromRawSql } from './tables.js';

export interface QueryAnalysis {
  readonly operation: string;
  readonly tables: string[];
  readonly primaryTable?: string;
  readonly summary: string;
  readonly fingerprint: string;
  readonly hash: string;
  readonly isRaw: boolean;
  readonly sanitizationError: boolean;
  readonly text?: string;
}

export interface QueryContext extends QueryAnalysis {
  readonly sql: string;
  readonly parameters: ReadonlyArray<unknown>;
}

export type Analyzer = (compiledQuery: CompiledQuery) => QueryContext;

const CACHE_SIZE = 10_000;

export function createAnalyzer(options: NormalizedOptions): Analyzer {
  const cache = new LruCache<string, QueryAnalysis>(CACHE_SIZE);
  return (compiledQuery) => {
    let analysis = cache.get(compiledQuery.sql);
    if (!analysis) {
      analysis = analyzeSql(compiledQuery, options);
      cache.set(compiledQuery.sql, analysis);
    }
    return { ...analysis, sql: compiledQuery.sql, parameters: compiledQuery.parameters };
  };
}

function analyzeSql(compiledQuery: CompiledQuery, options: NormalizedOptions): QueryAnalysis {
  const { sql, query } = compiledQuery;
  const isRaw = query.kind === 'RawNode';
  const operation = operationName(query, sql);
  const tables = options.tables
    ? isRaw
      ? extractTablesFromRawSql(sql)
      : extractTables(query)
    : [];
  const summary = summarize(operation, tables);

  let fingerprint = '';
  let sanitizationError = false;
  if (options.fingerprint || options.hash || options.queryText === 'sanitized') {
    try {
      fingerprint = fingerprintSql(sql).slice(0, options.maxQueryTextLength);
    } catch {
      sanitizationError = true;
    }
  }
  const hash = options.hash && !sanitizationError ? hashFingerprint(fingerprint) : '';
  const text = buildQueryText(sql, fingerprint, sanitizationError, options);

  return {
    operation,
    tables,
    ...(tables[0] !== undefined && { primaryTable: tables[0] }),
    summary,
    fingerprint,
    hash,
    isRaw,
    sanitizationError,
    ...(text !== undefined && { text }),
  };
}

function buildQueryText(
  sql: string,
  fingerprint: string,
  sanitizationError: boolean,
  options: NormalizedOptions,
): string | undefined {
  if (options.queryText === 'off') return undefined;
  if (options.queryText === 'sanitized' && sanitizationError) return undefined;
  let text =
    options.queryText === 'sanitized' ? fingerprint : sql.slice(0, options.maxQueryTextLength);
  if (options.redact) {
    try {
      text = options.redact(text);
    } catch {
      return undefined; // safe failure: omit rather than risk leaking
    }
  }
  return text;
}
```

- [ ] **Step 4: Replace the placeholder type in options.ts**

In `src/options.ts`, delete the `QueryContextLike` interface and change both hook signatures to use the real type:

```ts
import type { QueryContext } from './analysis/analyze.js';
// attributes?: (ctx: QueryContext) => Attributes;   (in both interfaces)
```

(Type-only circular import between options.ts and analyze.ts is fine — TypeScript erases it.)

- [ ] **Step 5: Run tests to verify everything passes**

Run: `pnpm vitest run test/unit && pnpm typecheck`
Expected: all unit tests PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/analysis/analyze.ts src/options.ts test/unit/analyze.test.ts
git commit -m "feat: add cached query analyzer producing QueryContext"
```

---

### Task 11: Attribute constants and builder

**Files:**
- Create: `src/otel/attributes.ts`
- Test: `test/unit/attributes.test.ts`

**Interfaces:**
- Consumes: `QueryContext` (Task 10), `NormalizedOptions` (Task 8).
- Produces: exported `ATTR_*` string constants (exact values below) and `function buildQueryAttributes(ctx: QueryContext, dbSystem: string, options: NormalizedOptions): Attributes`.

- [ ] **Step 1: Write the failing test**

`test/unit/attributes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createAnalyzer } from '../../src/analysis/analyze.js';
import { normalizeOptions } from '../../src/options.js';
import { buildQueryAttributes } from '../../src/otel/attributes.js';
import { compile } from '../helpers/compile.js';

function attrsFor(overrides = {}) {
  const options = normalizeOptions(overrides);
  const ctx = createAnalyzer(options)(
    compile((db) => db.selectFrom('orders').selectAll().where('id', '=', 123)),
  );
  return { attrs: buildQueryAttributes(ctx, 'postgresql', options), ctx };
}

describe('buildQueryAttributes', () => {
  it('emits the full default attribute set', () => {
    const { attrs, ctx } = attrsFor();
    expect(attrs).toEqual({
      'db.system.name': 'postgresql',
      'db.operation.name': 'SELECT',
      'db.query.summary': 'SELECT orders',
      'db.query.text': ctx.fingerprint,
      'db.collection.name': 'orders',
      'db.query.fingerprint': ctx.fingerprint,
      'db.query.hash': ctx.hash,
      'kysely.query.tables': ['orders'],
      'kysely.query.parameter_count': 1,
    });
  });

  it('never includes parameter values', () => {
    const { attrs } = attrsFor();
    expect(JSON.stringify(attrs)).not.toContain('123');
  });

  it('honors feature toggles', () => {
    const { attrs } = attrsFor({ summary: false, tables: false, hash: false, fingerprint: false, queryText: 'off' });
    expect(attrs['db.query.summary']).toBeUndefined();
    expect(attrs['db.collection.name']).toBeUndefined();
    expect(attrs['kysely.query.tables']).toBeUndefined();
    expect(attrs['db.query.hash']).toBeUndefined();
    expect(attrs['db.query.fingerprint']).toBeUndefined();
    expect(attrs['db.query.text']).toBeUndefined();
  });

  it('merges the custom attributes hook and swallows hook failures', () => {
    const ok = attrsFor({ attributes: () => ({ 'my.attr': 'x' }) });
    expect(ok.attrs['my.attr']).toBe('x');

    const throwing = attrsFor({
      attributes: () => {
        throw new Error('boom');
      },
    });
    expect(throwing.attrs['db.operation.name']).toBe('SELECT'); // still built
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/attributes.test.ts`
Expected: FAIL — cannot resolve `src/otel/attributes.js`.

- [ ] **Step 3: Write minimal implementation**

`src/otel/attributes.ts`:

```ts
import type { Attributes } from '@opentelemetry/api';
import type { QueryContext } from '../analysis/analyze.js';
import type { NormalizedOptions } from '../options.js';

// Semconv attributes
export const ATTR_DB_SYSTEM = 'db.system.name';
export const ATTR_DB_OPERATION = 'db.operation.name';
export const ATTR_DB_QUERY_SUMMARY = 'db.query.summary';
export const ATTR_DB_QUERY_TEXT = 'db.query.text';
export const ATTR_DB_COLLECTION = 'db.collection.name';
export const ATTR_RETURNED_ROWS = 'db.response.returned_rows';
export const ATTR_ERROR_TYPE = 'error.type';
// Custom attributes
export const ATTR_DB_QUERY_FINGERPRINT = 'db.query.fingerprint';
export const ATTR_DB_QUERY_HASH = 'db.query.hash';
export const ATTR_TABLES = 'kysely.query.tables';
export const ATTR_PARAMETER_COUNT = 'kysely.query.parameter_count';
export const ATTR_RAW = 'kysely.query.raw';
export const ATTR_SANITIZATION_ERROR = 'kysely.query.sanitization_error';
export const ATTR_AFFECTED_ROWS = 'kysely.query.affected_rows';
export const ATTR_ACQUIRE_DURATION = 'kysely.pool.acquire_duration_ms';
export const ATTR_TRANSACTION_OUTCOME = 'kysely.transaction.outcome';

export function buildQueryAttributes(
  ctx: QueryContext,
  dbSystem: string,
  options: NormalizedOptions,
): Attributes {
  const attrs: Attributes = {
    [ATTR_DB_SYSTEM]: dbSystem,
    [ATTR_DB_OPERATION]: ctx.operation,
    [ATTR_PARAMETER_COUNT]: ctx.parameters.length,
  };
  if (options.summary) attrs[ATTR_DB_QUERY_SUMMARY] = ctx.summary;
  if (ctx.text !== undefined) attrs[ATTR_DB_QUERY_TEXT] = ctx.text;
  if (options.tables && ctx.primaryTable !== undefined) attrs[ATTR_DB_COLLECTION] = ctx.primaryTable;
  if (options.tables && ctx.tables.length > 0) attrs[ATTR_TABLES] = ctx.tables;
  if (options.fingerprint && ctx.fingerprint && !ctx.sanitizationError) {
    attrs[ATTR_DB_QUERY_FINGERPRINT] = ctx.fingerprint;
  }
  if (options.hash && ctx.hash) attrs[ATTR_DB_QUERY_HASH] = ctx.hash;
  if (ctx.isRaw) attrs[ATTR_RAW] = true;
  if (ctx.sanitizationError) attrs[ATTR_SANITIZATION_ERROR] = true;
  if (options.attributes) {
    try {
      Object.assign(attrs, options.attributes(ctx));
    } catch {
      // user hook failure must never break instrumentation
    }
  }
  return attrs;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/attributes.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/otel/attributes.ts test/unit/attributes.test.ts
git commit -m "feat: add span attribute constants and builder"
```

---

### Task 12: Span error helpers and duration metric

**Files:**
- Create: `src/otel/spans.ts`, `src/otel/metrics.ts`
- Test: `test/unit/spans.test.ts`

**Interfaces:**
- Consumes: `ATTR_*` constants (Task 11), `QueryContext` (Task 10), `NormalizedOptions` (Task 8), `VERSION` (Task 1).
- Produces:

```ts
// spans.ts
export function errorType(error: unknown): string;                       // db error code → constructor name → '_OTHER'
export function recordError(span: Span, error: unknown, options: NormalizedOptions): string; // returns errorType
export function warnOnce(error: unknown): void;                          // rate-limited diag.warn (max 10 total)
// metrics.ts
export function createDurationHistogram(): Histogram;                    // 'db.client.operation.duration', unit 's'
export function recordDuration(histogram: Histogram, ctx: QueryContext, dbSystem: string, durationMs: number, errType?: string): void;
```

- [ ] **Step 1: Write the failing test**

`test/unit/spans.test.ts`:

```ts
import { SpanStatusCode, type Span } from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';
import { normalizeOptions } from '../../src/options.js';
import { errorType, recordError } from '../../src/otel/spans.js';

function fakeSpan() {
  return {
    setAttribute: vi.fn(),
    setStatus: vi.fn(),
    recordException: vi.fn(),
  } as unknown as Span & { setAttribute: any; setStatus: any; recordException: any };
}

describe('errorType', () => {
  it('prefers a string db error code', () => {
    const err = Object.assign(new Error('dup'), { code: '23505' });
    expect(errorType(err)).toBe('23505');
  });

  it('falls back to the constructor name', () => {
    class QueryTimeoutError extends Error {}
    expect(errorType(new QueryTimeoutError('t'))).toBe('QueryTimeoutError');
  });

  it('falls back to _OTHER for non-errors', () => {
    expect(errorType('boom')).toBe('_OTHER');
    expect(errorType(undefined)).toBe('_OTHER');
  });
});

describe('recordError', () => {
  it('sets attributes, status and exception', () => {
    const span = fakeSpan();
    const err = new Error('bad query');
    const type = recordError(span, err, normalizeOptions());
    expect(type).toBe('Error');
    expect(span.setAttribute).toHaveBeenCalledWith('error.type', 'Error');
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'bad query' });
    expect(span.recordException).toHaveBeenCalledWith(err);
  });

  it('skips recordException when disabled', () => {
    const span = fakeSpan();
    recordError(span, new Error('x'), normalizeOptions({ recordExceptions: false }));
    expect(span.recordException).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/spans.test.ts`
Expected: FAIL — cannot resolve `src/otel/spans.js`.

- [ ] **Step 3: Write minimal implementation**

`src/otel/spans.ts`:

```ts
import { diag, SpanStatusCode, type Span } from '@opentelemetry/api';
import type { NormalizedOptions } from '../options.js';
import { ATTR_ERROR_TYPE } from './attributes.js';

/** Semconv error.type: db error code, else error class name, else '_OTHER'. */
export function errorType(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
    if (error instanceof Error) return error.constructor.name;
  }
  return '_OTHER';
}

export function recordError(span: Span, error: unknown, options: NormalizedOptions): string {
  const type = errorType(error);
  span.setAttribute(ATTR_ERROR_TYPE, type);
  span.setStatus({
    code: SpanStatusCode.ERROR,
    ...(error instanceof Error && { message: error.message }),
  });
  if (options.recordExceptions && error instanceof Error) span.recordException(error);
  return type;
}

const MAX_WARNINGS = 10;
let warnCount = 0;

/** Instrumentation-internal failures: warn through OTel diagnostics, capped. */
export function warnOnce(error: unknown): void {
  if (warnCount >= MAX_WARNINGS) return;
  warnCount += 1;
  diag.warn('kysely-opentelemetry: instrumentation error (query executed unobserved)', error);
}
```

`src/otel/metrics.ts`:

```ts
import { metrics, ValueType, type Attributes, type Histogram } from '@opentelemetry/api';
import type { QueryContext } from '../analysis/analyze.js';
import { VERSION } from '../version.js';
import {
  ATTR_DB_COLLECTION,
  ATTR_DB_OPERATION,
  ATTR_DB_QUERY_SUMMARY,
  ATTR_DB_SYSTEM,
  ATTR_ERROR_TYPE,
} from './attributes.js';

/** Semconv db.client.operation.duration histogram (seconds). */
export function createDurationHistogram(): Histogram {
  return metrics.getMeter('kysely-opentelemetry', VERSION).createHistogram(
    'db.client.operation.duration',
    {
      description: 'Duration of database client operations.',
      unit: 's',
      valueType: ValueType.DOUBLE,
      advice: {
        explicitBucketBoundaries: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10],
      },
    },
  );
}

export function recordDuration(
  histogram: Histogram,
  ctx: QueryContext,
  dbSystem: string,
  durationMs: number,
  errType?: string,
): void {
  const attrs: Attributes = {
    [ATTR_DB_SYSTEM]: dbSystem,
    [ATTR_DB_OPERATION]: ctx.operation,
    [ATTR_DB_QUERY_SUMMARY]: ctx.summary,
  };
  if (ctx.primaryTable !== undefined) attrs[ATTR_DB_COLLECTION] = ctx.primaryTable;
  if (errType !== undefined) attrs[ATTR_ERROR_TYPE] = errType;
  histogram.record(durationMs / 1000, attrs);
}
```

(The metric path is asserted end-to-end in Task 15's OTel tests; unit tests here cover the span helpers, which contain the branching logic.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/spans.test.ts && pnpm typecheck`
Expected: 5 tests PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/otel/spans.ts src/otel/metrics.ts test/unit/spans.test.ts
git commit -m "feat: add span error recording and duration histogram"
```

---

### Task 13: ObservedConnection

**Files:**
- Create: `src/observed-connection.ts`, `test/helpers/otel.ts`, `test/helpers/fake-dialect.ts`
- Test: `test/otel/connection.test.ts`

**Interfaces:**
- Consumes: `Analyzer`/`QueryContext` (Task 10), `buildQueryAttributes` + `ATTR_*` (Task 11), `recordError`/`warnOnce` (Task 12), `recordDuration` (Task 12), `NormalizedOptions` (Task 8).
- Produces:

```ts
export interface ObservedConnectionDeps {
  readonly options: NormalizedOptions;
  readonly analyze: Analyzer;
  readonly tracer: Tracer;
  readonly histogram?: Histogram;
  readonly dbSystem: string;
}
export class ObservedConnection implements DatabaseConnection {
  readonly inner: DatabaseConnection;            // Task 14 unwraps via this
  transactionSpan: Span | undefined;             // set/cleared by Task 14
  transactionContext: Context | undefined;       // set/cleared by Task 14
  acquireDurationMs: number | undefined;         // set by Task 14, consumed by first query span
  constructor(inner: DatabaseConnection, deps: ObservedConnectionDeps);
}
```

- [ ] **Step 1: Write the OTel test helper**

`test/helpers/otel.ts`:

```ts
import { context, metrics, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

export function setupOtel() {
  const spanExporter = new InMemorySpanExporter();
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });
  trace.setGlobalTracerProvider(tracerProvider);

  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const meterProvider = new MeterProvider({
    readers: [
      new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 3_600_000 }),
    ],
  });
  metrics.setGlobalMeterProvider(meterProvider);

  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);

  return {
    spanExporter,
    metricExporter,
    async collectMetrics() {
      await meterProvider.forceFlush();
      return metricExporter.getMetrics();
    },
    async teardown() {
      await tracerProvider.shutdown();
      await meterProvider.shutdown();
      contextManager.disable();
      trace.disable();
      metrics.disable();
      context.disable();
    },
  };
}
```

- [ ] **Step 2: Write the fake dialect helper**

`test/helpers/fake-dialect.ts`:

```ts
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
```

- [ ] **Step 3: Write the failing test**

`test/otel/connection.test.ts`:

```ts
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { CompiledQuery } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAnalyzer } from '../../src/analysis/analyze.js';
import { ObservedConnection } from '../../src/observed-connection.js';
import { normalizeOptions } from '../../src/options.js';
import { createDurationHistogram } from '../../src/otel/metrics.js';
import { compile } from '../helpers/compile.js';
import { FakeConnection } from '../helpers/fake-dialect.js';
import { setupOtel } from '../helpers/otel.js';

let otel: ReturnType<typeof setupOtel>;

beforeEach(() => {
  otel = setupOtel();
});

afterEach(async () => {
  await otel.teardown();
});

function makeConnection(script = (cq: CompiledQuery) => ({ rows: [{ id: 1 }] })) {
  const options = normalizeOptions();
  const inner = new FakeConnection(script as any);
  const connection = new ObservedConnection(inner, {
    options,
    analyze: createAnalyzer(options),
    tracer: trace.getTracer('test'),
    histogram: createDurationHistogram(),
    dbSystem: 'postgresql',
  });
  return { connection, inner };
}

const SELECT = compile((db) => db.selectFrom('orders').selectAll().where('id', '=', 7));

describe('ObservedConnection.executeQuery', () => {
  it('creates a CLIENT span named from the summary with full attributes', async () => {
    const { connection } = makeConnection();
    const result = await connection.executeQuery(SELECT);
    expect(result.rows).toEqual([{ id: 1 }]);

    const spans = otel.spanExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.name).toBe('SELECT orders');
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.attributes['db.system.name']).toBe('postgresql');
    expect(span.attributes['db.operation.name']).toBe('SELECT');
    expect(span.attributes['db.query.hash']).toMatch(/^[0-9a-f]{16}$/);
    expect(span.attributes['db.response.returned_rows']).toBe(1);
    expect(span.attributes['kysely.query.parameter_count']).toBe(1);
    expect(JSON.stringify(span.attributes)).not.toContain('7'); // no parameter values
  });

  it('records the duration histogram', async () => {
    const { connection } = makeConnection();
    await connection.executeQuery(SELECT);
    const metricData = await otel.collectMetrics();
    const metric = metricData
      .flatMap((rm) => rm.scopeMetrics)
      .flatMap((sm) => sm.metrics)
      .find((m) => m.descriptor.name === 'db.client.operation.duration');
    expect(metric).toBeDefined();
    const point = (metric!.dataPoints[0] ?? {}) as any;
    expect(point.attributes['db.query.summary']).toBe('SELECT orders');
    expect(point.value.count).toBe(1);
  });

  it('records errors, sets status, rethrows unchanged, and still ends the span', async () => {
    const boom = Object.assign(new Error('dup key'), { code: '23505' });
    const { connection } = makeConnection(() => {
      throw boom;
    });
    await expect(connection.executeQuery(SELECT)).rejects.toBe(boom);

    const spans = otel.spanExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0]!.attributes['error.type']).toBe('23505');
  });

  it('emits acquire duration on the first query only', async () => {
    const { connection } = makeConnection();
    connection.acquireDurationMs = 12.5;
    await connection.executeQuery(SELECT);
    await connection.executeQuery(SELECT);
    const spans = otel.spanExporter.getFinishedSpans();
    expect(spans[0]!.attributes['kysely.pool.acquire_duration_ms']).toBe(12.5);
    expect(spans[1]!.attributes['kysely.pool.acquire_duration_ms']).toBeUndefined();
  });

  it('executes un-instrumented when analysis fails (safety invariant)', async () => {
    const options = normalizeOptions();
    const inner = new FakeConnection(() => ({ rows: [] }));
    const connection = new ObservedConnection(inner, {
      options,
      analyze: () => {
        throw new Error('analyzer exploded');
      },
      tracer: trace.getTracer('test'),
      dbSystem: 'postgresql',
    });
    const result = await connection.executeQuery(SELECT);
    expect(result.rows).toEqual([]);
    expect(otel.spanExporter.getFinishedSpans()).toHaveLength(0);
  });
});

describe('ObservedConnection.streamQuery', () => {
  it('ends the span when iteration completes and counts streamed rows', async () => {
    const { connection } = makeConnection(() => ({ rows: [{ id: 1 }, { id: 2 }, { id: 3 }] }));
    const rows: unknown[] = [];
    for await (const chunk of connection.streamQuery(SELECT, 1)) {
      rows.push(...chunk.rows);
      expect(otel.spanExporter.getFinishedSpans()).toHaveLength(0); // still open mid-stream
    }
    expect(rows).toHaveLength(3);
    const spans = otel.spanExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes['db.response.returned_rows']).toBe(3);
  });

  it('ends the span with error status when the stream throws', async () => {
    const boom = new Error('stream broke');
    const { connection } = makeConnection(() => {
      throw boom;
    });
    await expect(async () => {
      for await (const _ of connection.streamQuery(SELECT, 1)) {
        // never reached
      }
    }).rejects.toBe(boom);
    const spans = otel.spanExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('ends the span when the consumer breaks early', async () => {
    const { connection } = makeConnection(() => ({ rows: [{ id: 1 }, { id: 2 }] }));
    for await (const _ of connection.streamQuery(SELECT, 1)) {
      break; // triggers iterator.return()
    }
    expect(otel.spanExporter.getFinishedSpans()).toHaveLength(1);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm vitest run test/otel/connection.test.ts`
Expected: FAIL — cannot resolve `src/observed-connection.js`.

- [ ] **Step 5: Write the implementation**

`src/observed-connection.ts`:

```ts
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
  buildQueryAttributes,
} from './otel/attributes.js';
import { recordDuration } from './otel/metrics.js';
import { recordError, warnOnce } from './otel/spans.js';

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
  /** Set by ObservedDriver on acquire; consumed by the first query span. */
  acquireDurationMs: number | undefined = undefined;

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
      this.finishSuccess(span, ctx, startTime);
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
    const self = this;
    let rowCount = 0;
    let ended = false;

    const endSpan = (error?: unknown): void => {
      if (ended) return;
      ended = true;
      try {
        if (error === undefined) {
          span.setAttribute(ATTR_RETURNED_ROWS, rowCount);
          self.finishSuccess(span, ctx, startTime);
        } else {
          self.finishFailure(span, ctx, startTime, error);
        }
      } finally {
        span.end();
      }
    };

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
        endSpan(error ?? new Error('stream aborted'));
        if (inner.throw) return inner.throw(error);
        throw error;
      },
    };
  }

  private startQuery(compiledQuery: CompiledQuery): StartedQuery | undefined {
    try {
      const ctx = this.deps.analyze(compiledQuery);
      const parent = this.transactionContext ?? context.active();
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
      warnOnce(error);
      return undefined;
    }
  }

  private finishSuccess(span: Span, ctx: QueryContext, startTime: number): void {
    try {
      if (this.deps.histogram) {
        recordDuration(this.deps.histogram, ctx, this.deps.dbSystem, performance.now() - startTime);
      }
    } catch (error) {
      warnOnce(error);
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
          performance.now() - startTime,
          errType,
        );
      }
    } catch (err) {
      warnOnce(err);
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
    warnOnce(error);
  }
}
```

Note: on Kysely 0.27 `Parameters<...>[1]` resolves to `undefined`-ish types that still typecheck; the pass-through is verbatim either way.

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm vitest run test/otel/connection.test.ts && pnpm typecheck`
Expected: 8 tests PASS, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/observed-connection.ts test/helpers/otel.ts test/helpers/fake-dialect.ts test/otel/connection.test.ts
git commit -m "feat: add ObservedConnection with query and stream spans"
```

---

### Task 14: ObservedDriver

**Files:**
- Create: `src/observed-driver.ts`
- Test: `test/otel/driver.test.ts`

**Interfaces:**
- Consumes: `ObservedConnection`/`ObservedConnectionDeps` (Task 13), `ATTR_DB_SYSTEM`/`ATTR_TRANSACTION_OUTCOME` (Task 11), `recordError`/`warnOnce` (Task 12).
- Produces: `class ObservedDriver implements Driver { constructor(inner: Driver, deps: ObservedConnectionDeps) }`. Guarantees: one `ObservedConnection` per inner connection (WeakMap); inner driver only ever sees inner connections; transaction span covers begin→commit/rollback with query spans as children.

- [ ] **Step 1: Write the failing test**

`test/otel/driver.test.ts`:

```ts
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAnalyzer } from '../../src/analysis/analyze.js';
import { ObservedConnection } from '../../src/observed-connection.js';
import { ObservedDriver } from '../../src/observed-driver.js';
import { normalizeOptions, type KyselyOtelOptions } from '../../src/options.js';
import { compile } from '../helpers/compile.js';
import { createFakeDialect } from '../helpers/fake-dialect.js';
import { setupOtel } from '../helpers/otel.js';

let otel: ReturnType<typeof setupOtel>;

beforeEach(() => {
  otel = setupOtel();
});

afterEach(async () => {
  await otel.teardown();
});

function makeDriver(overrides: KyselyOtelOptions = {}) {
  const options = normalizeOptions(overrides);
  const { driver: fakeDriver } = createFakeDialect(() => ({ rows: [] }));
  const driver = new ObservedDriver(fakeDriver, {
    options,
    analyze: createAnalyzer(options),
    tracer: trace.getTracer('test'),
    dbSystem: 'postgresql',
  });
  return { driver, fakeDriver };
}

const SELECT = compile((db) => db.selectFrom('orders').selectAll());

describe('ObservedDriver connection wrapping', () => {
  it('wraps acquired connections, reusing one wrapper per inner connection', async () => {
    const { driver } = makeDriver();
    const first = await driver.acquireConnection();
    await driver.releaseConnection(first);
    const second = await driver.acquireConnection();
    expect(first).toBeInstanceOf(ObservedConnection);
    expect(second).toBe(first);
  });

  it('records acquire duration on the wrapper', async () => {
    const { driver, fakeDriver } = makeDriver();
    fakeDriver.acquireDelayMs = 15;
    const connection = (await driver.acquireConnection()) as ObservedConnection;
    expect(connection.acquireDurationMs).toBeGreaterThanOrEqual(10);
  });

  it('always passes the INNER connection to the inner driver', async () => {
    const { driver, fakeDriver } = makeDriver();
    const connection = await driver.acquireConnection();
    await driver.beginTransaction(connection, {});
    await driver.commitTransaction(connection);
    await driver.beginTransaction(connection, {});
    await driver.rollbackTransaction(connection);
    await driver.releaseConnection(connection);
    expect(fakeDriver.calls.filter((c) => c.endsWith(':WRAPPED'))).toEqual([]);
  });
});

describe('ObservedDriver transaction spans', () => {
  it('wraps begin→commit in a TRANSACTION span with query spans as children', async () => {
    const { driver } = makeDriver();
    const connection = await driver.acquireConnection();
    await driver.beginTransaction(connection, {});
    await connection.executeQuery(SELECT);
    await driver.commitTransaction(connection);

    const spans = otel.spanExporter.getFinishedSpans();
    const txSpan = spans.find((s) => s.name === 'TRANSACTION')!;
    const querySpan = spans.find((s) => s.name === 'SELECT orders')!;
    expect(txSpan).toBeDefined();
    expect(txSpan.kind).toBe(SpanKind.CLIENT);
    expect(txSpan.attributes['kysely.transaction.outcome']).toBe('committed');
    expect(querySpan.parentSpanContext?.spanId).toBe(txSpan.spanContext().spanId);
  });

  it('marks rollback outcome', async () => {
    const { driver } = makeDriver();
    const connection = await driver.acquireConnection();
    await driver.beginTransaction(connection, {});
    await driver.rollbackTransaction(connection);
    const txSpan = otel.spanExporter.getFinishedSpans().find((s) => s.name === 'TRANSACTION')!;
    expect(txSpan.attributes['kysely.transaction.outcome']).toBe('rolled_back');
  });

  it('ends the span with error status when begin fails', async () => {
    const { driver, fakeDriver } = makeDriver();
    const connection = await driver.acquireConnection();
    fakeDriver.beginTransaction = async () => {
      throw new Error('begin failed');
    };
    await expect(driver.beginTransaction(connection, {})).rejects.toThrow('begin failed');
    const txSpan = otel.spanExporter.getFinishedSpans().find((s) => s.name === 'TRANSACTION')!;
    expect(txSpan.status.code).toBe(SpanStatusCode.ERROR);
    expect((connection as ObservedConnection).transactionSpan).toBeUndefined();
  });

  it('emits no transaction spans when disabled', async () => {
    const { driver } = makeDriver({ transactions: false });
    const connection = await driver.acquireConnection();
    await driver.beginTransaction(connection, {});
    await driver.commitTransaction(connection);
    expect(otel.spanExporter.getFinishedSpans().find((s) => s.name === 'TRANSACTION')).toBeUndefined();
  });

  it('queries outside a transaction have no TRANSACTION parent', async () => {
    const { driver } = makeDriver();
    const connection = await driver.acquireConnection();
    await driver.beginTransaction(connection, {});
    await driver.commitTransaction(connection);
    await connection.executeQuery(SELECT);
    const querySpan = otel.spanExporter.getFinishedSpans().find((s) => s.name === 'SELECT orders')!;
    expect(querySpan.parentSpanContext).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/otel/driver.test.ts`
Expected: FAIL — cannot resolve `src/observed-driver.js`.

- [ ] **Step 3: Write the implementation**

`src/observed-driver.ts`:

```ts
import { context, SpanKind, trace } from '@opentelemetry/api';
import type { DatabaseConnection, Driver, TransactionSettings } from 'kysely';
import { ObservedConnection, type ObservedConnectionDeps } from './observed-connection.js';
import { ATTR_DB_SYSTEM, ATTR_TRANSACTION_OUTCOME } from './otel/attributes.js';
import { recordError, warnOnce } from './otel/spans.js';

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
    // Defensive: a transaction span must never outlive its connection lease.
    if (wrapper?.transactionSpan) this.endTransactionSpan(wrapper, 'released_unfinished');
    return this.inner.releaseConnection(unwrap(connection), options);
  }

  destroy(options?: Parameters<Driver['destroy']>[0]): Promise<void> {
    return this.inner.destroy(options);
  }

  private startTransactionSpan(wrapper: ObservedConnection): void {
    try {
      const parent = context.active();
      const span = this.deps.tracer.startSpan(
        'TRANSACTION',
        { kind: SpanKind.CLIENT, attributes: { [ATTR_DB_SYSTEM]: this.deps.dbSystem } },
        parent,
      );
      wrapper.transactionSpan = span;
      wrapper.transactionContext = trace.setSpan(parent, span);
    } catch (error) {
      warnOnce(error);
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
    if (!span) return;
    try {
      span.setAttribute(ATTR_TRANSACTION_OUTCOME, outcome);
      if (error !== undefined) recordError(span, error, this.deps.options);
    } catch (err) {
      warnOnce(err);
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/otel/driver.test.ts && pnpm typecheck`
Expected: 8 tests PASS, typecheck clean. (If `parentSpanContext` is named differently in the installed `@opentelemetry/sdk-trace-base` version, check its `ReadableSpan` type — older versions expose `parentSpanId` instead; assert on whichever the installed major provides.)

- [ ] **Step 5: Commit**

```bash
git add src/observed-driver.ts test/otel/driver.test.ts
git commit -m "feat: add ObservedDriver with transaction spans and pool acquire timing"
```

---

### Task 15: ObservedDialect and public API

**Files:**
- Create: `src/observed-dialect.ts`
- Modify: `src/index.ts` (replace placeholder with real exports)
- Test: `test/otel/observe-dialect.test.ts`

**Interfaces:**
- Consumes: `ObservedDriver` (Task 14), `ObservedConnectionDeps` (Task 13), `createAnalyzer` (Task 10), `detectDbSystem` (Task 9), `normalizeOptions`/`KyselyOtelOptions` (Task 8), `createDurationHistogram` (Task 12), `VERSION` (Task 1).
- Produces: the public API — `function observeDialect(dialect: Dialect, options?: KyselyOtelOptions): Dialect`. Re-exports from `src/index.ts`: `observeDialect`, `KyselyOtelOptions`, `QueryContext`, `VERSION`, and all `ATTR_*` constants.

- [ ] **Step 1: Write the failing test**

`test/otel/observe-dialect.test.ts` — end-to-end through a real `Kysely` instance:

```ts
import { Kysely, type CompiledQuery } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { observeDialect } from '../../src/index.js';
import { createFakeDialect } from '../helpers/fake-dialect.js';
import { setupOtel } from '../helpers/otel.js';

let otel: ReturnType<typeof setupOtel>;

beforeEach(() => {
  otel = setupOtel();
});

afterEach(async () => {
  await otel.teardown();
});

function makeDb(script?: (cq: CompiledQuery) => { rows: any[] }, options = {}) {
  const { dialect, driver } = createFakeDialect(script);
  const db = new Kysely<any>({ dialect: observeDialect(dialect, options) });
  return { db, driver };
}

describe('observeDialect end-to-end', () => {
  it('emits a span for a query executed through Kysely', async () => {
    const { db } = makeDb(() => ({ rows: [{ id: 1, secret: 'hunter2' }] }));
    await db.selectFrom('orders').selectAll().where('customer_email', '=', 'bob@example.com').execute();

    const spans = otel.spanExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe('SELECT orders');
    expect(spans[0]!.attributes['db.system.name']).toBe('postgresql'); // auto-detected
  });

  it('NO-PII: parameter values and row data never appear in any attribute', async () => {
    const { db } = makeDb(() => ({ rows: [{ secret: 'hunter2' }] }));
    await db
      .selectFrom('users')
      .selectAll()
      .where('email', '=', 'bob@example.com')
      .where('ssn', '=', '123-45-6789')
      .execute();

    for (const span of otel.spanExporter.getFinishedSpans()) {
      const all = JSON.stringify(span.attributes) + JSON.stringify(span.events);
      expect(all).not.toContain('bob@example.com');
      expect(all).not.toContain('123-45-6789');
      expect(all).not.toContain('hunter2');
    }
  });

  it('transaction produces nested spans through the Kysely transaction API', async () => {
    const { db } = makeDb();
    await db.transaction().execute(async (trx) => {
      await trx.selectFrom('orders').selectAll().execute();
    });
    const spans = otel.spanExporter.getFinishedSpans();
    const tx = spans.find((s) => s.name === 'TRANSACTION')!;
    const query = spans.find((s) => s.name === 'SELECT orders')!;
    expect(tx.attributes['kysely.transaction.outcome']).toBe('committed');
    expect(query.parentSpanContext?.spanId).toBe(tx.spanContext().spanId);
  });

  it('records the duration metric end-to-end', async () => {
    const { db } = makeDb();
    await db.selectFrom('orders').selectAll().execute();
    const metricData = await otel.collectMetrics();
    const metric = metricData
      .flatMap((rm) => rm.scopeMetrics)
      .flatMap((sm) => sm.metrics)
      .find((m) => m.descriptor.name === 'db.client.operation.duration');
    expect(metric).toBeDefined();
  });

  it('enabled: false returns the dialect untouched (zero overhead, zero spans)', async () => {
    const { dialect } = createFakeDialect();
    const observed = observeDialect(dialect, { enabled: false });
    expect(observed).toBe(dialect);
  });

  it('metrics: false emits spans but no metric', async () => {
    const { db } = makeDb(undefined, { metrics: false });
    await db.selectFrom('orders').selectAll().execute();
    expect(otel.spanExporter.getFinishedSpans()).toHaveLength(1);
    const metricData = await otel.collectMetrics();
    const metric = metricData
      .flatMap((rm) => rm.scopeMetrics)
      .flatMap((sm) => sm.metrics)
      .find((m) => m.descriptor.name === 'db.client.operation.duration');
    expect(metric).toBeUndefined();
  });

  it('dbSystem option overrides auto-detection', async () => {
    const { db } = makeDb(undefined, { dbSystem: 'cockroachdb' });
    await db.selectFrom('orders').selectAll().execute();
    expect(otel.spanExporter.getFinishedSpans()[0]!.attributes['db.system.name']).toBe('cockroachdb');
  });

  it('query errors propagate unchanged to the caller', async () => {
    const boom = new Error('connection reset');
    const { db } = makeDb(() => {
      throw boom;
    });
    await expect(db.selectFrom('orders').selectAll().execute()).rejects.toBe(boom);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/otel/observe-dialect.test.ts`
Expected: FAIL — `observeDialect` is not exported from `src/index.js`.

- [ ] **Step 3: Write the implementation**

`src/observed-dialect.ts`:

```ts
import { trace } from '@opentelemetry/api';
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
import { createDurationHistogram } from './otel/metrics.js';
import { detectDbSystem } from './otel/system.js';
import { VERSION } from './version.js';

export class ObservedDialect implements Dialect {
  constructor(
    private readonly inner: Dialect,
    private readonly options: NormalizedOptions,
  ) {}

  createDriver(): Driver {
    const deps: ObservedConnectionDeps = {
      options: this.options,
      analyze: createAnalyzer(this.options),
      tracer: trace.getTracer('kysely-opentelemetry', VERSION),
      ...(this.options.metrics && { histogram: createDurationHistogram() }),
      dbSystem: this.options.dbSystem ?? detectDbSystem(this.inner),
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
 */
export function observeDialect(dialect: Dialect, options?: KyselyOtelOptions): Dialect {
  const normalized = normalizeOptions(options);
  if (!normalized.enabled) return dialect;
  return new ObservedDialect(dialect, normalized);
}
```

`src/index.ts` (full replacement):

```ts
export { observeDialect, ObservedDialect } from './observed-dialect.js';
export type { KyselyOtelOptions } from './options.js';
export type { QueryContext } from './analysis/analyze.js';
export { VERSION } from './version.js';
export {
  ATTR_ACQUIRE_DURATION,
  ATTR_AFFECTED_ROWS,
  ATTR_DB_COLLECTION,
  ATTR_DB_OPERATION,
  ATTR_DB_QUERY_FINGERPRINT,
  ATTR_DB_QUERY_HASH,
  ATTR_DB_QUERY_SUMMARY,
  ATTR_DB_QUERY_TEXT,
  ATTR_DB_SYSTEM,
  ATTR_ERROR_TYPE,
  ATTR_PARAMETER_COUNT,
  ATTR_RAW,
  ATTR_RETURNED_ROWS,
  ATTR_SANITIZATION_ERROR,
  ATTR_TABLES,
  ATTR_TRANSACTION_OUTCOME,
} from './otel/attributes.js';
```

- [ ] **Step 4: Run the full suite and build**

Run: `pnpm test:unit && pnpm typecheck && pnpm build && pnpm lint`
Expected: all tests PASS, typecheck clean, dist builds, lint clean.

- [ ] **Step 5: Commit**

```bash
git add src/observed-dialect.ts src/index.ts test/otel/observe-dialect.test.ts
git commit -m "feat: add observeDialect public API"
```

---

### Task 16: SQLite integration test

**Files:**
- Test: `test/integration/sqlite.test.ts`

**Interfaces:**
- Consumes: `observeDialect` (Task 15), `setupOtel` (Task 13).

- [ ] **Step 1: Write the test**

`test/integration/sqlite.test.ts`:

```ts
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { observeDialect } from '../../src/index.js';
import { setupOtel } from '../helpers/otel.js';

let otel: ReturnType<typeof setupOtel>;
let db: Kysely<any>;

beforeEach(async () => {
  otel = setupOtel();
  db = new Kysely<any>({
    dialect: observeDialect(new SqliteDialect({ database: new Database(':memory:') })),
  });
  await db.schema
    .createTable('orders')
    .addColumn('id', 'integer', (col) => col.primaryKey())
    .addColumn('status', 'text')
    .execute();
  otel.spanExporter.reset();
});

afterEach(async () => {
  await db.destroy();
  await otel.teardown();
});

describe('sqlite end-to-end', () => {
  it('traces insert, select, update, delete with sqlite system name', async () => {
    await db.insertInto('orders').values({ id: 1, status: 'paid' }).execute();
    await db.selectFrom('orders').selectAll().where('id', '=', 1).execute();
    await db.updateTable('orders').set({ status: 'shipped' }).where('id', '=', 1).execute();
    await db.deleteFrom('orders').where('id', '=', 1).execute();

    const spans = otel.spanExporter.getFinishedSpans();
    expect(spans.map((s) => s.name)).toEqual([
      'INSERT orders',
      'SELECT orders',
      'UPDATE orders',
      'DELETE orders',
    ]);
    for (const span of spans) {
      expect(span.attributes['db.system.name']).toBe('sqlite');
      expect(JSON.stringify(span.attributes)).not.toContain('paid');
    }
    const update = spans.find((s) => s.name === 'UPDATE orders')!;
    expect(update.attributes['kysely.query.affected_rows']).toBe(1);
  });

  it('traces a committed transaction with nested query spans', async () => {
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('orders').values({ id: 2, status: 'new' }).execute();
    });
    const spans = otel.spanExporter.getFinishedSpans();
    const tx = spans.find((s) => s.name === 'TRANSACTION')!;
    expect(tx.attributes['kysely.transaction.outcome']).toBe('committed');
    const insert = spans.find((s) => s.name === 'INSERT orders')!;
    expect(insert.parentSpanContext?.spanId).toBe(tx.spanContext().spanId);
  });

  it('traces a failed query with error status and rethrows', async () => {
    await expect(db.selectFrom('missing_table').selectAll().execute()).rejects.toThrow();
    const span = otel.spanExporter.getFinishedSpans().find((s) => s.name === 'SELECT missing_table')!;
    expect(span.status.code).toBe(2); // SpanStatusCode.ERROR
  });

  it('traces streamed queries', async () => {
    await db.insertInto('orders').values([{ id: 3 }, { id: 4 }]).execute();
    otel.spanExporter.reset();
    const rows: unknown[] = [];
    for await (const row of db.selectFrom('orders').selectAll().stream()) {
      rows.push(row);
    }
    expect(rows).toHaveLength(2);
    const span = otel.spanExporter.getFinishedSpans().find((s) => s.name === 'SELECT orders')!;
    expect(span.attributes['db.response.returned_rows']).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm vitest run test/integration/sqlite.test.ts`
Expected: 4 tests PASS. This is a REAL end-to-end path — failures here mean wrapper bugs, not test bugs. Debug the wrapper.

- [ ] **Step 3: Commit**

```bash
git add test/integration/sqlite.test.ts
git commit -m "test: add sqlite end-to-end integration tests"
```

---

### Task 17: PostgreSQL integration test (testcontainers)

**Files:**
- Test: `test/integration/postgres.test.ts`

**Interfaces:**
- Consumes: `observeDialect` (Task 15), `setupOtel` (Task 13). Requires Docker running locally.

- [ ] **Step 1: Write the test**

`test/integration/postgres.test.ts`:

```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { observeDialect } from '../../src/index.js';
import { setupOtel } from '../helpers/otel.js';

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let otel: ReturnType<typeof setupOtel>;
let db: Kysely<any>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
}, 180_000);

afterAll(async () => {
  await container.stop();
});

beforeEach(async () => {
  otel = setupOtel();
  db = new Kysely<any>({ dialect: observeDialect(new PostgresDialect({ pool })) });
  await sql`CREATE TABLE IF NOT EXISTS orders (id int PRIMARY KEY, status text)`.execute(db);
  await sql`TRUNCATE orders`.execute(db);
  otel.spanExporter.reset();
});

afterEach(async () => {
  await otel.teardown();
});

describe('postgres end-to-end', () => {
  it('traces CRUD with postgresql system name and pool acquire timing', async () => {
    await db.insertInto('orders').values({ id: 1, status: 'paid' }).execute();
    await db.selectFrom('orders').selectAll().where('status', '=', 'paid').execute();

    const spans = otel.spanExporter.getFinishedSpans();
    const select = spans.find((s) => s.name === 'SELECT orders')!;
    expect(select.attributes['db.system.name']).toBe('postgresql');
    expect(select.attributes['db.query.fingerprint']).toContain('= ?');
    expect(JSON.stringify(select.attributes)).not.toContain('paid');

    const first = spans[0]!;
    expect(first.attributes['kysely.pool.acquire_duration_ms']).toBeTypeOf('number');
  });

  it('traces rolled-back transactions', async () => {
    await expect(
      db.transaction().execute(async (trx) => {
        await trx.insertInto('orders').values({ id: 2, status: 'x' }).execute();
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');
    const tx = otel.spanExporter.getFinishedSpans().find((s) => s.name === 'TRANSACTION')!;
    expect(tx.attributes['kysely.transaction.outcome']).toBe('rolled_back');
  });

  it('captures postgres error codes as error.type', async () => {
    await db.insertInto('orders').values({ id: 3, status: 'a' }).execute();
    await expect(
      db.insertInto('orders').values({ id: 3, status: 'b' }).execute(),
    ).rejects.toThrow();
    const failed = otel.spanExporter
      .getFinishedSpans()
      .find((s) => s.attributes['error.type'] !== undefined)!;
    expect(failed.attributes['error.type']).toBe('23505'); // unique_violation
  });

  it('flags raw sql queries', async () => {
    await sql`SELECT count(*) FROM orders WHERE status = ${'paid'}`.execute(db);
    const span = otel.spanExporter.getFinishedSpans().at(-1)!;
    expect(span.attributes['kysely.query.raw']).toBe(true);
    expect(span.attributes['kysely.query.tables']).toEqual(['orders']);
    expect(JSON.stringify(span.attributes)).not.toContain('paid');
  });
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm vitest run test/integration/postgres.test.ts`
Expected: 4 tests PASS (first run pulls the postgres:16-alpine image; needs Docker).

- [ ] **Step 3: Commit**

```bash
git add test/integration/postgres.test.ts
git commit -m "test: add postgres testcontainers integration tests"
```

---

### Task 18: MySQL integration test (testcontainers)

**Files:**
- Test: `test/integration/mysql.test.ts`

**Interfaces:**
- Consumes: `observeDialect` (Task 15), `setupOtel` (Task 13). Requires Docker running locally.

- [ ] **Step 1: Write the test**

`test/integration/mysql.test.ts`:

```ts
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { Kysely, MysqlDialect, sql } from 'kysely';
import { createPool, type Pool } from 'mysql2';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { observeDialect } from '../../src/index.js';
import { setupOtel } from '../helpers/otel.js';

let container: StartedMySqlContainer;
let pool: Pool;
let otel: ReturnType<typeof setupOtel>;
let db: Kysely<any>;

beforeAll(async () => {
  container = await new MySqlContainer('mysql:8.4').start();
  pool = createPool({ uri: container.getConnectionUri() });
}, 240_000);

afterAll(async () => {
  await container.stop();
});

beforeEach(async () => {
  otel = setupOtel();
  db = new Kysely<any>({ dialect: observeDialect(new MysqlDialect({ pool })) });
  await sql`CREATE TABLE IF NOT EXISTS orders (id int PRIMARY KEY, status varchar(32))`.execute(db);
  await sql`TRUNCATE orders`.execute(db);
  otel.spanExporter.reset();
});

afterEach(async () => {
  await otel.teardown();
});

describe('mysql end-to-end', () => {
  it('traces CRUD with mysql system name', async () => {
    await db.insertInto('orders').values({ id: 1, status: 'paid' }).execute();
    await db.selectFrom('orders').selectAll().where('id', '=', 1).execute();

    const select = otel.spanExporter.getFinishedSpans().find((s) => s.name === 'SELECT orders')!;
    expect(select.attributes['db.system.name']).toBe('mysql');
    expect(JSON.stringify(select.attributes)).not.toContain('paid');
  });

  it('reports affected rows on update', async () => {
    await db.insertInto('orders').values({ id: 2, status: 'new' }).execute();
    await db.updateTable('orders').set({ status: 'done' }).where('id', '=', 2).execute();
    const update = otel.spanExporter.getFinishedSpans().find((s) => s.name === 'UPDATE orders')!;
    expect(update.attributes['kysely.query.affected_rows']).toBe(1);
  });

  it('traces committed transactions with nesting', async () => {
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('orders').values({ id: 3, status: 'tx' }).execute();
    });
    const spans = otel.spanExporter.getFinishedSpans();
    const tx = spans.find((s) => s.name === 'TRANSACTION')!;
    const insert = spans.find((s) => s.name === 'INSERT orders')!;
    expect(tx.attributes['kysely.transaction.outcome']).toBe('committed');
    expect(insert.parentSpanContext?.spanId).toBe(tx.spanContext().spanId);
  });
});
```

- [ ] **Step 2: Run the full integration suite**

Run: `pnpm test:integration`
Expected: sqlite + postgres + mysql tests all PASS.

- [ ] **Step 3: Commit**

```bash
git add test/integration/mysql.test.ts
git commit -m "test: add mysql testcontainers integration tests"
```

---

### Task 19: README

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: the public API exactly as shipped in Task 15. Every code sample must compile against it.

- [ ] **Step 1: Write README.md**

Structure (write real content for each section, using the exact API from Task 15):

1. **Title + one-paragraph pitch**: OpenTelemetry instrumentation for Kysely — semconv-compliant CLIENT spans, a `db.client.operation.duration` histogram, and stable grouping keys (`db.query.summary`, `db.query.fingerprint`, `db.query.hash`) with production-safe defaults (no parameter values, sanitized query text).
2. **Install**: `npm install kysely-opentelemetry` + peer requirements (`kysely >=0.27 <0.30`, `@opentelemetry/api >=1.8`, plus a configured OTel SDK — link to `@opentelemetry/sdk-node` docs).
3. **Quick start** (plain Kysely + pg), copied verbatim from the spec §4 example, with the emitted-attributes block from the spec §23.
4. **NestJS usage**: `useFactory` provider example (no dedicated module — state this explicitly and show the factory pattern from the design spec).
5. **Configuration reference**: table of all `KyselyOtelOptions` fields with defaults, plus a paragraph each on `attributes` and `redact` hooks with a cardinality/PII warning.
6. **Emitted telemetry reference**: the attribute table from the design spec §5.1 and the metric description from §5.2.
7. **TraceQL cookbook**: the five queries from the design-phase spec (top queries by p95, by total DB time, by count, by error rate, DB time by route), each using `span.db.query.hash != nil` selectors.
8. **Interaction with driver-level instrumentation**: nested-spans diagram (HTTP → Kysely → pg) and an explicit double-counting warning for dashboards.
9. **Safety model**: sanitized-by-default, no parameter capture, safe-failure behavior (`kysely.query.sanitization_error`), instrumentation-never-breaks-queries invariant.
10. **License**: MIT.

- [ ] **Step 2: Verify README code samples compile**

Copy each TypeScript sample into `test/readme-samples.type-test.ts` temporarily, run `pnpm typecheck`, then delete the file. Fix samples (not the API) on mismatch.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add README with quick start, config and TraceQL cookbook"
```

---

### Task 20: CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the pnpm scripts defined in Task 1 (`test:unit`, `test:integration`, `typecheck`, `lint`, `build`).

- [ ] **Step 1: Write the workflow**

`.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        node: [18, 20, 22]
        kysely: ['0.27', '0.28', '0.29']
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm add -D kysely@${{ matrix.kysely }}
      - run: pnpm test:unit

  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm build

  integration:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm test:integration
```

(Testcontainers uses the Docker daemon that ubuntu-latest runners provide out of the box — no service containers needed. The kysely-matrix job intentionally skips typecheck: type-level drift across 0.27–0.29 is expected; runtime behavior is what the matrix verifies.)

- [ ] **Step 2: Validate workflow syntax locally**

Run: `npx --yes @action-validator/cli .github/workflows/ci.yml || true` — treat parser errors as failures, warnings as acceptable. If the validator is unavailable, review the YAML by eye against the structure above.

- [ ] **Step 3: Commit and push**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add test matrix, quality and integration workflows"
git push -u origin main
```

Then verify the workflow runs green on GitHub (`gh run watch` or `gh run list --limit 1`).

---

## Final verification (after all tasks)

1. `pnpm test:unit && pnpm test:integration && pnpm typecheck && pnpm lint && pnpm build` — all green.
2. `npm pack --dry-run` — tarball contains only `dist/`, `README.md`, `LICENSE`, `package.json`.
3. Grep gate — each must return nothing:
   - `grep -rn "@opentelemetry/sdk" src/` (SDK leak into runtime code)
   - `grep -rn "console\." src/` (console usage — diag only)
4. Confirm spec coverage against `docs/superpowers/specs/2026-07-06-kysely-opentelemetry-design.md` §11 success criteria.

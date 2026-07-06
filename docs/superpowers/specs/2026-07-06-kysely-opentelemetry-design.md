# kysely-opentelemetry — Design

**Date**: 2026-07-06
**Status**: Approved
**Package**: `kysely-opentelemetry` (npm)

## 1. Purpose

Production-safe OpenTelemetry instrumentation for [Kysely](https://kysely.dev). Wraps a Kysely dialect and emits semconv-compliant CLIENT spans and metrics with stable, low-cardinality grouping keys (summary, fingerprint, hash), so users can answer: which queries are slowest, which consume the most DB time, which HTTP routes trigger them, and which query patterns fail — in Grafana Tempo, Jaeger, Honeycomb, Datadog, or any OTel backend, without leaking parameter values or PII.

No dedicated Kysely OTel instrumentation exists on npm (verified 2026-07-06); this fills that gap.

## 2. Core decisions

These were settled during design review and brainstorming; they override the earlier draft spec where they differ.

1. **AST-first analysis, no SQL parser track.** `compiledQuery.query` is Kysely's `RootOperationNode` — a full AST available at the interception point. Operation, tables, and summary come from the AST (exact, free). Kysely compiles all builder values to bind parameters, so `compiledQuery.sql` is already parameterized; the regex sanitizer exists only as defense-in-depth for `sql.raw`/`sql.lit` fragments. No pg-parser/WASM adapters, no parse timeouts, ever.
2. **Explicit wrapper attachment** (`observeDialect(dialect, options?)`): composition over Kysely's public `Dialect`/`Driver`/`DatabaseConnection` interfaces. No module patching, no `InstrumentationBase`. Works in ESM, CJS, Bun, bundlers. A future zero-touch patching layer could be added on top without breaking this.
3. **Maximum API trim.** One public function, ~12 flat options, fixed attribute names (shareable dashboards). No `spanMode`, no `spanName` strategies, no per-attribute name overrides, no NestJS module (README `useFactory` example instead), no callsite capture in v0.1.
4. **v0.1 includes** transaction spans, pool-acquire timing, and the `db.client.operation.duration` metric (sampling-immune aggregates), alongside the core span-per-query wrapper.
5. **Tooling**: pnpm + tsup (dual ESM/CJS + types) + vitest. Testcontainers (PostgreSQL, MySQL) from day one, plus better-sqlite3 in-process.
6. **Dependencies**: zero runtime deps. Peers: `kysely >=0.27 <0.30`, `@opentelemetry/api >=1.8`. Never depend on the OTel SDK (SDK packages appear only in devDependencies for tests).

## 3. Architecture

### 3.1 Module layout

```
src/
  index.ts                 public surface: observeDialect() + option/context types
  options.ts               KyselyOtelOptions, defaults, normalization
  observed-dialect.ts      Dialect wrapper → creates ObservedDriver
  observed-driver.ts       Driver wrapper: connection wrapping (WeakMap),
                           pool-acquire timing, transaction spans, unwrapping
  observed-connection.ts   DatabaseConnection wrapper: executeQuery + streamQuery
  analysis/
    analyze.ts             CompiledQuery → QueryContext (orchestrates, LRU-cached)
    operation.ts           query.kind → SELECT/INSERT/UPDATE/DELETE/MERGE/DDL/RAW
    tables.ts              OperationNode walk → table names (+ primary table)
    summary.ts             operation + tables → "SELECT orders customers"
    fingerprint.ts         placeholder normalization + literal sanitizer + IN-collapse
    hash.ts                sha256(fingerprint) 16-hex-char prefix (node:crypto)
    lru.ts                 small internal LRU (no dependency)
  otel/
    system.ts              dialect adapter class → db.system.name auto-detection
    attributes.ts          QueryContext → span/metric attributes
    spans.ts               span lifecycle + error recording helpers
    metrics.ts             db.client.operation.duration histogram
```

Each module has one purpose and a narrow interface; `analysis/` is pure (no OTel imports), `otel/` consumes `QueryContext` and touches only `@opentelemetry/api`.

### 3.2 Data flow (per query)

1. `ObservedConnection.executeQuery(compiledQuery)` calls `analyze(compiledQuery)` — pure, LRU-cached by `compiledQuery.sql` — producing a `QueryContext` (operation, tables, primary table, summary, fingerprint, hash, sanitized text, raw-node flag).
2. Start a `SpanKind.CLIENT` span named from the summary. All analysis attributes are attached at span start so they survive process death mid-query.
3. Delegate to the inner connection.
4. On completion: set result attributes (`db.response.returned_rows` / affected rows), record the duration histogram, end the span. On failure: set `ERROR` status, `error.type`, `recordException` (if enabled), end the span, rethrow the original error unchanged.

`streamQuery` wraps the returned async iterable: the span ends when iteration completes, errors, or is abandoned (`finally` in the iterator), not when the stream is created.

### 3.3 Driver wrapper details

- **One wrapper per inner connection**, cached in a `WeakMap<DatabaseConnection, ObservedConnection>`, so driver identity checks hold across acquire/release cycles.
- **Always unwrap** before delegating to the inner driver — `beginTransaction`, `commitTransaction`, `rollbackTransaction`, and `releaseConnection` all receive the wrapper from Kysely and must pass the inner connection down (inner drivers cast to their own connection class).
- **Transactions**: `beginTransaction` starts a `TRANSACTION` span (kind CLIENT, `db.system.name`, per-connection state). Query spans on that connection parent to it via its stored context. `commit`/`rollback` end it with `kysely.transaction.outcome = committed | rolled_back`. Sound because Kysely pins a transaction to one connection.
- **Pool acquire timing**: `acquireConnection` is timed; duration is emitted as `kysely.pool.acquire_duration_ms` on the first query span executed after that acquisition only (one acquisition serves many queries).

### 3.4 Safety invariant

Instrumentation must never break a query. Every analysis/OTel step is guarded; on internal failure the query executes un-instrumented and the failure is reported via `diag.warn` (OTel diagnostics, rate-limited per failure site) — never `console`, never a thrown error.

## 4. Public API

```ts
import { observeDialect } from 'kysely-opentelemetry';

const db = new Kysely<Database>({
  dialect: observeDialect(new PostgresDialect({ pool }), {
    /* all optional */
  }),
});
```

```ts
interface KyselyOtelOptions {
  enabled?: boolean;                    // kill switch, default true
  dbSystem?: string;                    // override auto-detection
  queryText?: 'off' | 'sanitized' | 'parameterized';  // default 'sanitized'
  maxQueryTextLength?: number;          // default 4096 (text + fingerprint)
  fingerprint?: boolean;                // default true
  summary?: boolean;                    // default true
  tables?: boolean;                     // default true
  hash?: boolean;                       // default true
  metrics?: boolean;                    // default true
  transactions?: boolean;               // default true
  recordExceptions?: boolean;           // default true
  attributes?: (ctx: QueryContext) => Attributes;  // custom-attribute escape hatch
  redact?: (sql: string) => string;     // extra query-text scrubbing escape hatch
}
```

`QueryContext` (exposed to the `attributes` hook) carries: `sql`, `parameters` (readonly, count only used internally), `operation`, `tables`, `primaryTable`, `summary`, `fingerprint`, `hash`, `isRaw`.

`queryText` modes: `parameterized` = compiled SQL as-is (already placeholder-parameterized by Kysely); `sanitized` (default) = additionally scrub literals from raw fragments; `off` = no `db.query.text` at all. The `redact` hook runs last, whenever query text would be emitted (both `sanitized` and `parameterized` modes); it does not affect the fingerprint.

## 5. Emitted telemetry

### 5.1 Span attributes

| Attribute | Source / notes |
|---|---|
| `db.system.name` | auto-detected from dialect adapter class (`postgresql`, `mysql`, `sqlite`, `microsoft.sql_server`) or `dbSystem` option |
| `db.operation.name` | AST `query.kind` |
| `db.query.summary` | operation + tables; also the span name; ≤255 chars |
| `db.query.text` | sanitized compiled SQL, ≤4096 chars, mode-dependent |
| `db.collection.name` | primary (first) table — semconv, backends key on it |
| `db.query.fingerprint` | custom grouping key, ≤4096 chars |
| `db.query.hash` | custom, 16 hex chars |
| `kysely.query.tables` | string[], ≤20 entries, deduped, first-seen order |
| `kysely.query.parameter_count` | always emitted (number, zero risk) |
| `kysely.query.raw` | `true` when root node is `RawNode` (analysis best-effort) |
| `kysely.query.sanitization_error` | `true` when sanitizer failed (then `db.query.text` omitted) |
| `kysely.pool.acquire_duration_ms` | first query span after acquisition only |
| `db.response.returned_rows` | on completion: `result.rows.length` |
| `kysely.query.affected_rows` | on completion, mutations only: `Number(result.numAffectedRows)` when defined |
| `error.type` | on failure: error constructor name, or DB error `code` when exposed |

Transaction span: name `TRANSACTION`, kind CLIENT, `db.system.name`, `kysely.transaction.outcome`.

### 5.2 Metric

`db.client.operation.duration` — histogram, unit seconds, semconv bucket boundaries. Attributes (low-cardinality only): `db.system.name`, `db.operation.name`, `db.query.summary`, `db.collection.name`, `error.type`. Recorded for every query even when the span is unsampled — aggregates stay accurate under trace sampling.

## 6. Query analysis

Pure pipeline in `analysis/`, LRU-cached (10,000 entries) by `compiledQuery.sql`:

- **Operation**: `query.kind` → `SELECT`/`INSERT`/`UPDATE`/`DELETE`/`MERGE`; DDL nodes map to their verb (`CREATE TABLE`, `ALTER TABLE`, …); `RawNode` → first SQL keyword.
- **Tables**: recursive `OperationNode` walk over `from`/`into`/`joins`/`using`/`with` collecting `TableNode` identifiers; cap 20, dedupe, first-seen order; first = primary. `RawNode` root: best-effort regex on `FROM`/`JOIN`/`INTO`/`UPDATE` targets + `kysely.query.raw = true`.
- **Summary**: `"{OPERATION} {tables…}"` (e.g. `SELECT orders customers`); no tables → `{OPERATION} unknown`; truncate 255.
- **Fingerprint** (from `compiledQuery.sql`): normalize placeholders (`$1`, `?`, `@p1` → `?`); sanitize literals — dollar-quoted strings, single-quoted strings, UUIDs, hex, numerics (defense-in-depth for raw fragments); collapse `IN (?, ?, …)` → `IN (?)`; normalize whitespace; truncate 4096.
- **Hash**: `sha256(fingerprint)`, first 16 hex chars.

## 7. Error handling

- Query errors are rethrown unchanged, never wrapped.
- Span on failure: `ERROR` status + `error.type` + `recordException` (option-gated).
- Sanitizer failure: omit `db.query.text`, set `kysely.query.sanitization_error = true`.
- Instrumentation failure: query proceeds un-instrumented; rate-limited `diag.warn`.

## 8. Security requirements

- Never emit raw parameter values, in any mode, through any code path. No option exists to enable it in v0.1.
- Default `queryText: 'sanitized'`; literals scrubbed from raw fragments.
- Truncation limits: text/fingerprint 4096, summary 255, tables 20.
- The `attributes` hook is the user's responsibility; documentation warns about cardinality and PII.

## 9. Testing

- **Unit (vitest)**: every `analysis/` module. Fingerprint corpus: dollar-quoting, nested/escaped quotes, huge IN lists, already-parameterized SQL, unicode. AST walks across all query node kinds built with the real Kysely builder. Summary/hash determinism.
- **OTel integration**: `InMemorySpanExporter` + in-memory metric reader against a scripted fake dialect. Asserts: span kind/name/attributes; transaction parent-child nesting; streamQuery span lifecycle; error paths; spans always end; metric recorded for unsampled spans; **no-PII test** — no parameter value string ever appears in any exported attribute.
- **Database integration**: testcontainers PostgreSQL + MySQL, better-sqlite3 in-process. Real traces for select/insert/update/delete/transaction/stream/error on each.
- **CI (GitHub Actions)**: lint + typecheck + unit/OTel tests on Node 18/20/22 × Kysely 0.27/0.28/0.29; container tests on Node 22.

## 10. v0.1 deliverables

- `observeDialect` with everything in this document.
- README: quick start, plain-Kysely + NestJS `useFactory` examples, attribute reference, TraceQL query cookbook (top queries by p95/total time/count/error rate, DB time by route), double-counting warning for users with driver-level instrumentation.
- Dual ESM/CJS + types via tsup; `sideEffects: false`.

**Deferred to v0.2+**: Grafana dashboard JSON, callsite capture (requires a companion `KyselyPlugin` — user stack frames are gone by `executeQuery` time), benchmarks, Bun CI lane, MSSQL container tests.

## 11. Success criteria

A user can install the package, wrap their dialect in one line, and immediately answer — in any OTel backend, without leaking a single parameter value:

- Which queries are slowest (p95) and which consume the most total DB time?
- Which HTTP routes and services trigger them (via standard trace context)?
- Which query fingerprints fail most?
- Which tables are involved in the worst patterns?
- Are aggregates trustworthy under trace sampling? (Yes — via the metric.)

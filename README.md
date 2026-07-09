<div align="center">

<picture>
  <img alt="kysely-opentelemetry" src="assets/logo.svg" width="640">
</picture>

<br>

[![CI](https://github.com/camcima/kysely-opentelemetry/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/camcima/kysely-opentelemetry/actions/workflows/ci.yml)
[![CodeQL](https://github.com/camcima/kysely-opentelemetry/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/camcima/kysely-opentelemetry/actions/workflows/codeql.yml)
[![codecov](https://codecov.io/gh/camcima/kysely-opentelemetry/graph/badge.svg)](https://codecov.io/gh/camcima/kysely-opentelemetry)
[![npm version](https://img.shields.io/npm/v/kysely-opentelemetry)](https://www.npmjs.com/package/kysely-opentelemetry)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20%20%7C%2022%20%7C%2024-green.svg)](https://nodejs.org/)

</div>

OpenTelemetry instrumentation for [Kysely](https://kysely.dev). Wraps any Kysely `Dialect` and emits semantic-convention-compliant `CLIENT` spans plus a `db.client.operation.duration` histogram, tagged with stable, low-cardinality grouping keys — `db.query.summary`, `db.query.fingerprint`, `db.query.hash` — so you can answer "which queries are slowest?", "which consume the most DB time?", and "which query patterns fail?" in Grafana Tempo, Jaeger, Honeycomb, Datadog, or any OTel backend. Production-safe by default: no parameter values are ever captured, and query text is sanitized before it leaves the process.

## Install

```bash
npm install kysely-opentelemetry
```

Peer requirements:

| Package              | Version        |
| -------------------- | -------------- |
| `kysely`             | `>=0.27 <0.30` |
| `@opentelemetry/api` | `>=1.8`        |

You also need a configured OpenTelemetry SDK in your process (this package only calls into `@opentelemetry/api`; it never creates a tracer/meter provider itself). If you don't have one yet, see [`@opentelemetry/sdk-node`](https://www.npmjs.com/package/@opentelemetry/sdk-node). By default it uses the process-global tracer/meter registries; pass the `tracerProvider`/`meterProvider` options to route telemetry through explicit providers instead.

## Quick start

```ts
import { Pool } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import { observeDialect } from 'kysely-opentelemetry';

interface Database {
  orders: {
    id: number;
    customer_id: number;
    status: string;
  };
}

const db = new Kysely<Database>({
  dialect: observeDialect(
    new PostgresDialect({
      pool: new Pool({ connectionString: process.env.DATABASE_URL }),
    }),
  ),
});

await db.selectFrom('orders').selectAll().where('status', '=', 'paid').execute();
```

That query produces one `CLIENT` span named `SELECT orders` with attributes like:

```
db.system.name               = "postgresql"
db.operation.name            = "SELECT"
db.query.summary             = "SELECT orders"
db.query.text                = "select * from \"orders\" where \"status\" = ?"
db.collection.name           = "orders"
db.query.fingerprint         = "select * from \"orders\" where \"status\" = ?"
db.query.hash                = "6161107caaa26845"
kysely.query.tables           = ["orders"]
kysely.query.parameter_count = 1
db.response.returned_rows    = 12
```

Notice there is no `'paid'` anywhere — the parameter value never reaches the span. `db.query.text` and `db.query.fingerprint` show the sanitized, placeholder-normalized SQL (identical here because the default `queryText: 'sanitized'` mode reuses the fingerprint).

Want a runnable end-to-end setup instead of a snippet? [`kysely-opentelemetry-examples`](https://github.com/camcima/kysely-opentelemetry-examples) wires this library into an Express + Kysely + Postgres app with a Docker Compose stack (OTel Collector, Tempo, Prometheus, Grafana), a pre-provisioned dashboard built on the grouping keys, and an in-process smoke test that asserts the full telemetry contract — including that no bind-parameter value ever reaches a span.

## NestJS usage

There is no dedicated NestJS module. Wire `observeDialect` into your existing database provider with `useFactory`:

```ts
// database.provider.ts
import { Pool } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import { observeDialect } from 'kysely-opentelemetry';
// `Database` is your Kysely schema interface (the same one from Quick Start above).
import type { Database } from './types';

export const KYSELY = Symbol('KYSELY');

export const kyselyProvider = {
  provide: KYSELY,
  useFactory: (): Kysely<Database> =>
    new Kysely<Database>({
      dialect: observeDialect(
        new PostgresDialect({
          pool: new Pool({ connectionString: process.env.DATABASE_URL }),
        }),
      ),
    }),
};
```

Add `kyselyProvider` to your module's `providers` (and `exports`, if other modules inject `KYSELY`). Because `observeDialect` returns a plain Kysely `Dialect`, nothing else in your NestJS wiring changes — no interceptor, no extra decorator, no lifecycle hook.

## Configuration reference

All options are optional; every default is production-safe as shipped.

| Option               | Type                                      | Default         | Description                                                                                                                                                                                                                                                                                                                 |
| -------------------- | ----------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`            | `boolean`                                 | `true`          | Kill switch. When `false`, `observeDialect` returns the wrapped dialect completely untouched — zero overhead, zero spans.                                                                                                                                                                                                   |
| `dbSystem`           | `string`                                  | auto-detected   | Override the auto-detected `db.system.name` (e.g. for a community dialect that isn't recognized, or when detection falls back to `other_sql` — see [If `db.system.name` shows `other_sql`](#if-dbsystemname-shows-other_sql)).                                                                                              |
| `namespace`          | `string`                                  | —               | Emitted as `db.namespace` on all spans and the duration metric (typically the database name). Cannot be auto-detected from a dialect.                                                                                                                                                                                       |
| `serverAddress`      | `string`                                  | —               | Emitted as `server.address` on all spans and the duration metric.                                                                                                                                                                                                                                                           |
| `serverPort`         | `number`                                  | —               | Emitted as `server.port` on all spans and the duration metric.                                                                                                                                                                                                                                                              |
| `poolName`           | `string`                                  | derived         | `db.client.connection.pool.name` on the wait_time metric. Defaults to `serverAddress[:serverPort][/namespace]`, else the db system name. Set it when several pools share one endpoint (e.g. read-write vs read-only) so their series stay separable.                                                                        |
| `queryText`          | `'off' \| 'sanitized' \| 'parameterized'` | `'sanitized'`   | Controls `db.query.text`. `'sanitized'` emits the scrubbed fingerprint; `'parameterized'` emits the compiled SQL as-is (already placeholder-parameterized by Kysely for builder queries); `'off'` omits `db.query.text` entirely.                                                                                           |
| `maxQueryTextLength` | `number`                                  | `4096`          | Max characters for `db.query.text` and `db.query.fingerprint`. Invalid values (negative or non-finite) fall back to the default with a diagnostic warning; fractional values are truncated.                                                                                                                                 |
| `fingerprint`        | `boolean`                                 | `true`          | Emit `db.query.fingerprint`.                                                                                                                                                                                                                                                                                                |
| `summary`            | `boolean`                                 | `true`          | Emit `db.query.summary` on spans **and** on the duration metric. The span _name_ still uses the summary regardless (spans need a name); set this to `false` to keep the summary out of metric/attribute cardinality.                                                                                                        |
| `tables`             | `boolean`                                 | `true`          | Emit `db.collection.name` and `kysely.query.tables`.                                                                                                                                                                                                                                                                        |
| `hash`               | `boolean`                                 | `true`          | Emit `db.query.hash`.                                                                                                                                                                                                                                                                                                       |
| `metrics`            | `boolean \| MetricsOptions`               | `true`          | Metric emission. `true`/`false` gates all histograms together; pass `{ operationDuration?, connectionWaitTime? }` to gate `db.client.operation.duration` and `db.client.connection.wait_time` independently.                                                                                                                |
| `transactions`       | `boolean`                                 | `true`          | Emit `TRANSACTION` spans around `db.transaction()`.                                                                                                                                                                                                                                                                         |
| `recordExceptions`   | `boolean`                                 | `true`          | Call `span.recordException()` on query failure (in addition to setting `ERROR` status and `error.type`). This records the driver's own error (message + stack), which may echo a submitted value — see [Safety model](#safety-model). The span status `message` is always set to `error.message` regardless of this option. |
| `attributes`         | `(ctx: QueryContext) => Attributes`       | —               | Custom-attribute escape hatch, merged onto the span after all built-in attributes.                                                                                                                                                                                                                                          |
| `redact`             | `(sql: string) => string`                 | —               | Extra query-text scrubbing, applied last, in every emitting mode.                                                                                                                                                                                                                                                           |
| `shouldObserve`      | `(ctx: QueryContext) => boolean`          | —               | Return `false` to skip a query entirely (no span, no metric). Fail-open: if the filter throws, the query is observed.                                                                                                                                                                                                       |
| `tracerProvider`     | `TracerProvider`                          | global registry | Route spans through this provider instead of the global `@opentelemetry/api` registry.                                                                                                                                                                                                                                      |
| `meterProvider`      | `MeterProvider`                           | global registry | Route the duration metric through this provider instead of the global registry.                                                                                                                                                                                                                                             |

### The `attributes` hook

```ts
observeDialect(dialect, {
  attributes: (ctx) => ({
    'app.tenant_id': currentTenantId(),
  }),
});
```

`ctx` (`QueryContext`) exposes `sql`, `parameters`, `operation`, `tables`, `tablesTruncated`, `primaryTable`, `summary`, `fingerprint`, `hash`, `isRaw`, `sanitizationError`, and `text`. If the hook throws, the failure is swallowed and the span is still emitted without the extra attributes — instrumentation must never break a query.

**Warning:** whatever this hook returns is emitted as-is. Cardinality and PII are entirely your responsibility — never derive an attribute from `ctx.parameters` or from `ctx.sql`/`ctx.fingerprint` in a way that could leak a raw value, and avoid high-cardinality values (user IDs, emails, request IDs) as span attributes if your backend charges or indexes by attribute cardinality. Prefer low-cardinality dimensions (tenant tier, region, feature flag) here.

### The `redact` hook

```ts
observeDialect(dialect, {
  redact: (sql) => sql.replace(/api_keys/g, '[redacted_table]'),
});
```

Runs last, on whatever text `queryText` would otherwise emit (`sanitized` or `parameterized`), and does **not** affect `db.query.fingerprint`, `db.query.hash`, or table extraction. If it throws, `db.query.text` is omitted for that query rather than risking a leak — instrumentation degrades safely instead of failing the query.

**Warning:** a `redact` hook that runs a slow or unbounded regex on every query's SQL text runs on your hot path; keep it fast and defensive (bounded regexes, no unbounded backtracking).

### The `shouldObserve` hook

```ts
observeDialect(dialect, {
  // Skip health checks and other noise — no span, no metric.
  shouldObserve: (ctx) => !/^\s*select\s+1\b/i.test(ctx.sql),
});
```

Prefer an anchored, case-insensitive match over strict equality (`ctx.sql !== 'select 1'`): real health-check probes vary in casing and shape (`SELECT 1`, `select 1;`, `SELECT 1 AS ok`), and an exact comparison silently stops matching the moment the probe changes. The filter runs on the hot path before span creation; keep it cheap — a small anchored regex like the one above is fine, an unbounded backtracking regex is not. It receives the same `QueryContext` as the `attributes` hook.

### If `db.system.name` shows `other_sql`

`db.system.name` is auto-detected from the dialect's adapter: first by `instanceof` against Kysely's built-in adapter classes (survives minification, covers community dialects that extend them), then — when every `instanceof` misses — by matching adapter class names up the prototype chain. When both fail, the value falls back to `other_sql` and a rate-limited `diag.warn` reports it.

If you use PostgreSQL/MySQL/MSSQL/SQLite and still see `other_sql`, the usual cause is **duplicated `kysely` module instances**: your app's `kysely` and the copy this library resolves are different module instances, so `instanceof` always fails, and a minified bundle also defeats the class-name fallback. This happens with `npm link`/`file:` installs during local development, pnpm workspaces with version skew, or monorepos pinning two `kysely` versions. Two fixes:

- **Dedupe `kysely`** so only one copy resolves (e.g. `npm dedupe`, pnpm overrides, or aligning versions across the workspace) — this fixes the root cause.
- **Set the `dbSystem` option** (e.g. `dbSystem: 'postgresql'`) to bypass detection entirely — always safe, and the right call for community dialects that don't extend a built-in adapter.

## Emitted telemetry reference

### Span attributes

| Attribute                         | Emitted when                                                                       | Notes                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db.system.name`                  | always                                                                             | Auto-detected from the dialect adapter class (`postgresql`, `mysql`, `sqlite`, `microsoft.sql_server`, or `other_sql`), or the `dbSystem` override. Seeing `other_sql` unexpectedly? See [If `db.system.name` shows `other_sql`](#if-dbsystemname-shows-other_sql).                                                                       |
| `db.namespace`                    | `namespace` option set                                                             | The configured database name.                                                                                                                                                                                                                                                                                                             |
| `server.address` / `server.port`  | `serverAddress` / `serverPort` option set                                          | The configured DB host/port.                                                                                                                                                                                                                                                                                                              |
| `db.operation.name`               | always                                                                             | Derived from the AST node kind (`SELECT`, `INSERT`, `UPDATE`, `DELETE`, `CREATE TABLE`, …) or the first keyword of raw SQL. For a raw `WITH …` query it resolves to the statement's main verb, not `WITH` (comments, string literals, and quoted identifiers are masked before scanning; the scanner falls back to `WITH` when in doubt). |
| `db.query.summary`                | `summary: true` (default)                                                          | `"{OPERATION} {tables…}"`, e.g. `SELECT orders`; also the span name; ≤255 chars.                                                                                                                                                                                                                                                          |
| `db.query.text`                   | `queryText !== 'off'` (in `'sanitized'` mode, also requires no sanitization error) | Sanitized or parameterized SQL text, ≤`maxQueryTextLength` chars. In `'parameterized'` mode it is the raw compiled SQL and is emitted regardless of any sanitization error.                                                                                                                                                               |
| `db.collection.name`              | `tables: true` (default) and a primary table was found                             | The first (primary) table.                                                                                                                                                                                                                                                                                                                |
| `db.query.fingerprint`            | `fingerprint: true` (default) and no sanitization error                            | Placeholder-normalized, literal-scrubbed SQL shape; stable grouping key across parameter values; ≤`maxQueryTextLength` chars.                                                                                                                                                                                                             |
| `db.query.hash`                   | `hash: true` (default)                                                             | FNV-1a 64-bit hash of the fingerprint, 16 hex chars — a compact grouping key for dashboards/alerts.                                                                                                                                                                                                                                       |
| `kysely.query.tables`             | `tables: true` (default) and at least one table was found                          | All tables involved, deduped, first-seen order, capped at 20.                                                                                                                                                                                                                                                                             |
| `kysely.query.tables_truncated`   | more than 20 tables were referenced                                                | `true`; the `kysely.query.tables` list is capped and not exhaustive for this query.                                                                                                                                                                                                                                                       |
| `kysely.query.parameter_count`    | always                                                                             | Number of bind parameters — never the values themselves.                                                                                                                                                                                                                                                                                  |
| `kysely.query.raw`                | the query's root AST node is a `RawNode`                                           | `true` when the query came from `sql`/`sql.raw` rather than the query builder.                                                                                                                                                                                                                                                            |
| `kysely.query.sanitization_error` | the fingerprint sanitizer threw                                                    | `true`; `db.query.text` is omitted for that query.                                                                                                                                                                                                                                                                                        |
| `kysely.pool.acquire_duration_ms` | on the first query span after a connection acquisition                             | Trace-side twin of the `wait_time` metric (works with `metrics: false`). One acquisition can serve many queries; the value is consumed by the first query on the lease even if that query is filtered, so it never misattributes to a later span.                                                                                         |
| `db.response.returned_rows`       | on successful completion                                                           | `result.rows.length`.                                                                                                                                                                                                                                                                                                                     |
| `kysely.query.affected_rows`      | on successful completion, when the driver reports it                               | `Number(result.numAffectedRows)`.                                                                                                                                                                                                                                                                                                         |
| `error.type`                      | on failure                                                                         | The DB driver's error `code` when exposed (e.g. Postgres `23505`), else the error's constructor name, else `_OTHER`.                                                                                                                                                                                                                      |
| `kysely.stream.outcome`           | on a stream span force-closed at connection release                                | `released_unfinished` — set only when a manually-driven stream iterator is abandoned and its span is force-closed as the connection returns to the pool; absent on streams that complete, error, or `break` normally.                                                                                                                     |

Transaction spans (`transactions: true`, default) are named `TRANSACTION`, kind `CLIENT`, and carry `db.system.name`, `db.namespace` / `server.address` / `server.port` (when configured), plus `kysely.transaction.outcome` (`committed` | `rolled_back` | `begin_failed` | `commit_failed` | `rollback_failed` | `released_unfinished`). Query spans issued inside `db.transaction()` are children of the transaction span — unless you open your own span inside the transaction callback, in which case queries nest under _your_ span instead. (The two hierarchies cannot be combined: the driver cannot inject the `TRANSACTION` span into your ambient context, so when you create spans of your own, your hierarchy wins and the `TRANSACTION` span remains a sibling that still carries the outcome attribute.)

### Metrics

Both are `Histogram`s (unit: seconds, bucket boundaries `[0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10]`), gated by the `metrics` option (default `true`; per-histogram via the object form), and recorded regardless of trace sampling so aggregates stay accurate even when only a fraction of traces are kept.

- **`db.client.operation.duration`** — one record per query. Attributes are deliberately low-cardinality: `db.system.name`, `db.operation.name`, `db.query.summary` (when `summary: true`, default), `db.collection.name` (when known), `db.namespace` / `server.address` / `server.port` (when configured), and `error.type` (on failure).
- **`db.client.connection.wait_time`** — the time spent obtaining a connection from the pool, one record per acquisition (an acquisition can serve many queries). Attributes: `db.system.name` and the semconv-required `db.client.connection.pool.name`. Kysely does not expose a pool name, so it is the `poolName` option when set, else synthesized from the configured connection info — `server.address[:server.port][/db.namespace]`, falling back to the db system name — to stay stable and low-cardinality.

## TraceQL cookbook

These queries assume a Tempo-style backend with TraceQL. Every query filters on `span.db.query.hash != nil` to select only spans this library produced, then groups by the stable keys.

**Top queries by p95 latency:**

```traceql
{ span.db.query.hash != nil } | quantile_over_time(duration, .95) by (span.db.query.hash, span.db.query.summary)
```

**Top queries by total DB time:**

```traceql
{ span.db.query.hash != nil } | sum_over_time(duration) by (span.db.query.hash, span.db.query.summary)
```

**Top queries by count:**

```traceql
{ span.db.query.hash != nil } | count_over_time() by (span.db.query.hash, span.db.query.summary)
```

**Top queries by error rate:**

```traceql
{ span.db.query.hash != nil && status = error } | count_over_time() by (span.db.query.hash, span.db.query.summary)
```

**DB time by HTTP route** (standard trace context links the query span to its parent HTTP span):

```traceql
{ span.db.query.hash != nil } | sum_over_time(duration) by (resource.service.name, span.http.route)
```

Swap `by (...)` groupings or add `topk(10, ...)` depending on your backend's TraceQL metrics dialect. The equivalent PromQL-style query against the `db.client.operation.duration` metric (for backends that expose metrics rather than span aggregation) groups by `db_system_name`, `db_operation_name`, `db_query_summary`, and `db_collection_name` instead.

## Interaction with driver-level instrumentation

If you also run driver-level OpenTelemetry instrumentation (e.g. `@opentelemetry/instrumentation-pg`, `@opentelemetry/instrumentation-mysql2`), you will see **nested** spans, not duplicates:

```
HTTP request span (e.g. express/fastify/nestjs instrumentation)
└── SELECT orders                       (this library — kysely-opentelemetry)
    └── pg.query                        (driver-level instrumentation, e.g. instrumentation-pg)
```

Each layer instruments a different boundary — this library instruments Kysely's `DatabaseConnection`, the driver instrumentation instruments the underlying client library — so both spans are legitimate and additive in the trace view.

**ESM apps:** this library works in ESM without any special setup (it wraps the dialect directly; nothing is monkey-patched). But the _driver- and HTTP-level_ instrumentations shown above (`@opentelemetry/instrumentation-http`, `-express`, `-pg`, …) patch modules at load time, and in an ESM app they silently fail to patch unless Node is started with the OpenTelemetry ESM loader hook — e.g. `node --import ./register-otel.mjs app.mjs` where the register file calls `module.register('@opentelemetry/instrumentation/hook.mjs', ...)`, or the equivalent `--experimental-loader` flag for older Node versions (see the [OTel JS ESM support doc](https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/esm-support.md)). The symptom is exactly the trace tree above minus the HTTP and `pg.query` spans: your Kysely spans appear, but parentless and with no driver child.

**Double-counting warning:** if you build dashboards or alerts on _duration_ or _count_, decide which layer is your source of truth and use only that layer's spans/metrics for aggregation. Summing `db.client.operation.duration` from this library **and** an equivalent driver-level metric for the same logical query will double-count DB time. This library's grouping keys (`db.query.summary`, `db.query.fingerprint`, `db.query.hash`) are generally more useful for aggregation than driver-level spans, since driver instrumentation typically only has the final parameterized SQL string to group by (higher cardinality, no stable hash).

## Safety model

- **Sanitized by default.** `queryText: 'sanitized'` is the default; no code path in this library requires you to opt out of safety to get useful telemetry.
- **Comments are stripped.** SQL comments (`--` and `/* … */`) are removed before fingerprinting, so query-tagging comments (trace IDs, request IDs, sqlcommenter-style annotations) never appear in `db.query.text`, `db.query.fingerprint`, or `db.query.hash`, and cannot fragment query grouping.
- **No parameter capture, ever.** Bind parameter values that this library reads (the parameters array, row data) are never emitted, in any mode, through any attribute, span event, or metric — there is no option to enable it. Only `kysely.query.parameter_count` (a number) is emitted.
- **Safe failure.** If the fingerprint sanitizer cannot process a query's SQL, `db.query.text` is omitted and `kysely.query.sanitization_error = true` is set instead of emitting unsanitized text.
- **Instrumentation never breaks a query.** Every analysis and OTel call is wrapped; if instrumentation itself throws internally, the query still executes un-instrumented and a rate-limited `diag.warn` (OpenTelemetry diagnostics, never `console`) reports it. Query errors are always rethrown to the caller unchanged — this library never wraps, swallows, or alters them.
- **Driver error messages are a separate channel.** On query/transaction failure, the span status `message` is always set to `error.message` from the database driver, and (when `recordExceptions: true`, the default) `span.recordException(error)` records that same driver error (message + stack) as a span event. This is the driver's own error, not something this library extracts — but driver error text (e.g. Postgres constraint/type-violation messages) can echo a submitted value. If you have strict data-governance requirements, set `recordExceptions: false` to drop the exception event; note the span status `message` still carries `error.message` regardless, since there is no toggle to suppress it in v0.1.

### Known limitations

- **Fingerprint scrubbing is defense-in-depth for raw SQL only.** Kysely compiles all query-builder values to bind parameters, so builder-generated queries never contain inline literals in the first place. The regex-based fingerprint scrubber exists to sanitize hand-written `sql`/`sql.raw` fragments; it handles single-quoted string literals (including MySQL's backslash-escape syntax) but **intentionally does not scrub double-quoted text**, because in Postgres and SQLite double quotes delimit identifiers (e.g. `"orders"`) — scrubbing them would corrupt fingerprints and break table extraction. A consequence: a MySQL double-quoted string literal embedded in hand-written raw SQL is not scrubbed. Use bind parameters (preferred) or single-quoted literals in raw SQL on MySQL.
- **Raw-SQL string literals ending in a backslash corrupt that query's fingerprint on Postgres.** The scrubber treats `\'` as an escaped quote (MySQL semantics). Under Postgres's default `standard_conforming_strings = on`, a backslash is a literal character, so a hand-written literal like `'C:\'` makes the scrubber over-consume into the next literal — the fingerprint (and sanitized `db.query.text`) for that query loses the SQL between the two literals. Grouping keys remain stable (the corruption is deterministic), and no parameter value leaks. Builder queries are unaffected. Use bind parameters in raw SQL to avoid this entirely.
- **CTE names appear in `kysely.query.tables`.** A query like `db.with('recent', (qb) => qb.selectFrom('events')...).selectFrom('recent')...` lists `recent` alongside real tables (`events`), because at the compiled-AST level a `selectFrom('recent')` reference to a CTE is indistinguishable from a reference to a physical table.
- **Manually-driven streamed queries can leave a span open.** Consuming `.stream()` with `for await` (the normal usage pattern) always closes the span correctly on completion, error, or early `break`. If you instead manually drive the returned async iterator and abandon it without exhausting it or calling `.return()`, the span stays open until the connection lease ends — when the connection is released back to the pool, the library force-closes any stream spans still open on it. A span force-closed this way is tagged `kysely.stream.outcome = "released_unfinished"` so abandoned streams stay queryable and distinguishable from ones that completed normally.

## License

MIT

# kysely-opentelemetry

OpenTelemetry instrumentation for [Kysely](https://kysely.dev). Wraps any Kysely `Dialect` and emits semantic-convention-compliant `CLIENT` spans plus a `db.client.operation.duration` histogram, tagged with stable, low-cardinality grouping keys — `db.query.summary`, `db.query.fingerprint`, `db.query.hash` — so you can answer "which queries are slowest?", "which consume the most DB time?", and "which query patterns fail?" in Grafana Tempo, Jaeger, Honeycomb, Datadog, or any OTel backend. Production-safe by default: no parameter values are ever captured, and query text is sanitized before it leaves the process.

## Install

```bash
npm install kysely-opentelemetry
```

Peer requirements:

| Package | Version |
|---|---|
| `kysely` | `>=0.27 <0.30` |
| `@opentelemetry/api` | `>=1.8` |

You also need a configured OpenTelemetry SDK in your process (this package only calls into `@opentelemetry/api`; it never creates a tracer/meter provider itself). If you don't have one yet, see [`@opentelemetry/sdk-node`](https://www.npmjs.com/package/@opentelemetry/sdk-node).

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
db.query.hash                = "3f2a9c8b1d4e5f6a"
kysely.query.tables           = ["orders"]
kysely.query.parameter_count = 1
db.response.returned_rows    = 12
```

Notice there is no `'paid'` anywhere — the parameter value never reaches the span. `db.query.text` and `db.query.fingerprint` show the sanitized, placeholder-normalized SQL (identical here because the default `queryText: 'sanitized'` mode reuses the fingerprint).

## NestJS usage

There is no dedicated NestJS module. Wire `observeDialect` into your existing database provider with `useFactory`:

```ts
// database.provider.ts
import { Pool } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import { observeDialect } from 'kysely-opentelemetry';

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

| Option | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `true` | Kill switch. When `false`, `observeDialect` returns the wrapped dialect completely untouched — zero overhead, zero spans. |
| `dbSystem` | `string` | auto-detected | Override the auto-detected `db.system.name` (e.g. for a community dialect that isn't recognized). |
| `queryText` | `'off' \| 'sanitized' \| 'parameterized'` | `'sanitized'` | Controls `db.query.text`. `'sanitized'` emits the scrubbed fingerprint; `'parameterized'` emits the compiled SQL as-is (already placeholder-parameterized by Kysely for builder queries); `'off'` omits `db.query.text` entirely. |
| `maxQueryTextLength` | `number` | `4096` | Max characters for `db.query.text` and `db.query.fingerprint`. |
| `fingerprint` | `boolean` | `true` | Emit `db.query.fingerprint`. |
| `summary` | `boolean` | `true` | Emit `db.query.summary` (also used as the span name regardless of this flag). |
| `tables` | `boolean` | `true` | Emit `db.collection.name` and `kysely.query.tables`. |
| `hash` | `boolean` | `true` | Emit `db.query.hash`. |
| `metrics` | `boolean` | `true` | Emit the `db.client.operation.duration` histogram. |
| `transactions` | `boolean` | `true` | Emit `TRANSACTION` spans around `db.transaction()`. |
| `recordExceptions` | `boolean` | `true` | Call `span.recordException()` on query failure (in addition to setting `ERROR` status and `error.type`). |
| `attributes` | `(ctx: QueryContext) => Attributes` | — | Custom-attribute escape hatch, merged onto the span after all built-in attributes. |
| `redact` | `(sql: string) => string` | — | Extra query-text scrubbing, applied last, in every emitting mode. |

### The `attributes` hook

```ts
observeDialect(dialect, {
  attributes: (ctx) => ({
    'app.tenant_id': currentTenantId(),
  }),
});
```

`ctx` (`QueryContext`) exposes `sql`, `parameters`, `operation`, `tables`, `primaryTable`, `summary`, `fingerprint`, `hash`, `isRaw`, and `sanitizationError`. If the hook throws, the failure is swallowed and the span is still emitted without the extra attributes — instrumentation must never break a query.

**Warning:** whatever this hook returns is emitted as-is. Cardinality and PII are entirely your responsibility — never derive an attribute from `ctx.parameters` or from `ctx.sql`/`ctx.fingerprint` in a way that could leak a raw value, and avoid high-cardinality values (user IDs, emails, request IDs) as span attributes if your backend charges or indexes by attribute cardinality. Prefer low-cardinality dimensions (tenant tier, region, feature flag) here.

### The `redact` hook

```ts
observeDialect(dialect, {
  redact: (sql) => sql.replace(/api_keys/g, '[redacted_table]'),
});
```

Runs last, on whatever text `queryText` would otherwise emit (`sanitized` or `parameterized`), and does **not** affect `db.query.fingerprint`, `db.query.hash`, or table extraction. If it throws, `db.query.text` is omitted for that query rather than risking a leak — instrumentation degrades safely instead of failing the query.

**Warning:** a `redact` hook that runs a slow or unbounded regex on every query's SQL text runs on your hot path; keep it fast and defensive (bounded regexes, no unbounded backtracking).

## Emitted telemetry reference

### Span attributes

| Attribute | Emitted when | Notes |
|---|---|---|
| `db.system.name` | always | Auto-detected from the dialect adapter class (`postgresql`, `mysql`, `sqlite`, `microsoft.sql_server`, or `other_sql`), or the `dbSystem` override. |
| `db.operation.name` | always | Derived from the AST node kind (`SELECT`, `INSERT`, `UPDATE`, `DELETE`, `CREATE TABLE`, …) or the first keyword of raw SQL. |
| `db.query.summary` | `summary: true` (default) | `"{OPERATION} {tables…}"`, e.g. `SELECT orders`; also the span name; ≤255 chars. |
| `db.query.text` | `queryText !== 'off'` and no sanitization error | Sanitized or parameterized SQL text, ≤`maxQueryTextLength` chars. |
| `db.collection.name` | `tables: true` (default) and a primary table was found | The first (primary) table. |
| `db.query.fingerprint` | `fingerprint: true` (default) and no sanitization error | Placeholder-normalized, literal-scrubbed SQL shape; stable grouping key across parameter values; ≤`maxQueryTextLength` chars. |
| `db.query.hash` | `hash: true` (default) | `sha256(fingerprint)`, first 16 hex chars — a compact grouping key for dashboards/alerts. |
| `kysely.query.tables` | `tables: true` (default) and at least one table was found | All tables involved, deduped, first-seen order, capped at 20. |
| `kysely.query.parameter_count` | always | Number of bind parameters — never the values themselves. |
| `kysely.query.raw` | the query's root AST node is a `RawNode` | `true` when the query came from `sql`/`sql.raw` rather than the query builder. |
| `kysely.query.sanitization_error` | the fingerprint sanitizer threw | `true`; `db.query.text` is omitted for that query. |
| `kysely.pool.acquire_duration_ms` | on the first query span after a connection acquisition | One acquisition can serve many queries; only the first sees this attribute. |
| `db.response.returned_rows` | on successful completion | `result.rows.length`. |
| `kysely.query.affected_rows` | on successful completion, when the driver reports it | `Number(result.numAffectedRows)`. |
| `error.type` | on failure | The DB driver's error `code` when exposed (e.g. Postgres `23505`), else the error's constructor name, else `_OTHER`. |

Transaction spans (`transactions: true`, default) are named `TRANSACTION`, kind `CLIENT`, and carry `db.system.name` plus `kysely.transaction.outcome` (`committed` | `rolled_back` | `begin_failed` | `commit_failed` | `rollback_failed` | `released_unfinished`). Query spans issued inside `db.transaction()` are children of the transaction span.

### Metric

`db.client.operation.duration` — a `Histogram` (unit: seconds, semconv bucket boundaries `[0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10]`), recorded for **every** query regardless of trace sampling, so aggregates stay accurate even when only a fraction of traces are kept. Attributes are deliberately low-cardinality: `db.system.name`, `db.operation.name`, `db.query.summary`, `db.collection.name` (when known), and `error.type` (on failure).

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

**Double-counting warning:** if you build dashboards or alerts on *duration* or *count*, decide which layer is your source of truth and use only that layer's spans/metrics for aggregation. Summing `db.client.operation.duration` from this library **and** an equivalent driver-level metric for the same logical query will double-count DB time. This library's grouping keys (`db.query.summary`, `db.query.fingerprint`, `db.query.hash`) are generally more useful for aggregation than driver-level spans, since driver instrumentation typically only has the final parameterized SQL string to group by (higher cardinality, no stable hash).

## Safety model

- **Sanitized by default.** `queryText: 'sanitized'` is the default; no code path in this library requires you to opt out of safety to get useful telemetry.
- **No parameter capture, ever.** Bind parameter values are never emitted, in any mode, through any attribute, span event, or metric — there is no option to enable it. Only `kysely.query.parameter_count` (a number) is emitted.
- **Safe failure.** If the fingerprint sanitizer cannot process a query's SQL, `db.query.text` is omitted and `kysely.query.sanitization_error = true` is set instead of emitting unsanitized text.
- **Instrumentation never breaks a query.** Every analysis and OTel call is wrapped; if instrumentation itself throws internally, the query still executes un-instrumented and a rate-limited `diag.warn` (OpenTelemetry diagnostics, never `console`) reports it. Query errors are always rethrown to the caller unchanged — this library never wraps, swallows, or alters them.

### Known limitations

- **Fingerprint scrubbing is defense-in-depth for raw SQL only.** Kysely compiles all query-builder values to bind parameters, so builder-generated queries never contain inline literals in the first place. The regex-based fingerprint scrubber exists to sanitize hand-written `sql`/`sql.raw` fragments; it handles single-quoted string literals (including MySQL's backslash-escape syntax) but **intentionally does not scrub double-quoted text**, because in Postgres and SQLite double quotes delimit identifiers (e.g. `"orders"`) — scrubbing them would corrupt fingerprints and break table extraction. A consequence: a MySQL double-quoted string literal embedded in hand-written raw SQL is not scrubbed. Use bind parameters (preferred) or single-quoted literals in raw SQL on MySQL.
- **CTE names appear in `kysely.query.tables`.** A query like `db.with('recent', (qb) => qb.selectFrom('events')...).selectFrom('recent')...` lists `recent` alongside real tables (`events`), because at the compiled-AST level a `selectFrom('recent')` reference to a CTE is indistinguishable from a reference to a physical table.
- **Manually-driven streamed queries can leave a span open.** Consuming `.stream()` with `for await` (the normal usage pattern) always closes the span correctly on completion, error, or early `break`. If you instead manually drive the returned async iterator and abandon it without exhausting it or calling `.return()`, the span can remain open — a limitation of the JS async-iterator protocol, which has no way to signal abandonment.

## License

MIT

# Architecture review — 2026-07-09

## Scope and approach

This review covers the current `src/` implementation, its public configuration
surface, unit/OTel tests, integration-test coverage, CI workflow, and package
build configuration. Findings are based on static inspection; no production
workload or deployed telemetry backend was available.

The library has a pleasingly narrow architecture: a `Dialect` wrapper owns
configuration and telemetry dependencies; a `Driver` wrapper owns connection
leases and transactions; and a `DatabaseConnection` wrapper owns query/stream
lifecycle. Analysis is isolated and bounded with a byte-limited LRU. The
project also has unusually good test and CI hygiene for an early release:
Node 20/22/24 and Kysely 0.27/0.28/0.29 are exercised in CI, while PostgreSQL,
MySQL, SQLite, and MSSQL have integration coverage.

## Findings

### 1. Critical — default “sanitized” telemetry preserves SQL comments

`fingerprintSql` normalizes literals and whitespace, but it does not remove or
replace line or block comments ([`src/analysis/fingerprint.ts`](../src/analysis/fingerprint.ts)).
The default `queryText: 'sanitized'` then emits that fingerprint as
`db.query.text` ([`src/analysis/analyze.ts`](../src/analysis/analyze.ts)).

For example, the current code deterministically turns:

```sql
SELECT 1 /* customer_email=alice@example.com, request=abc123 */
```

into a fingerprint equivalent to:

```sql
SELECT ? /* customer_email=alice@example.com, request=abc? */
```

The email remains in both `db.query.text` and `db.query.fingerprint`; the
comment also changes `db.query.hash`. This violates the documented
production-safe/sanitized-by-default posture and can create an unbounded number
of query groups when SQL-commenting middleware adds trace IDs or request IDs.
It is particularly important because comments are a common mechanism for query
tagging and application diagnostics.

Recommendation: replace the regex-only sanitizer with a small lexical scanner
that recognizes comments and literals per supported dialect, removes comments
before fingerprinting, and fails closed (omit text/fingerprint) for malformed
input it cannot confidently tokenize. Add tests for `--` and `/* ... */`
comments containing PII and dynamic IDs, including comments adjacent to
literals/placeholders. Reuse a common tokenization primitive for fingerprinting
and raw-SQL analysis rather than maintaining unrelated scanners.

### 2. High — the default failure path exports driver error messages that may contain submitted values

`recordError` always writes `error.message` to the span status and, by default,
records the whole error as an exception event
([`src/otel/spans.ts`](../src/otel/spans.ts)). Many database drivers include
offending values in constraint, type-conversion, or server error messages. The
README explicitly acknowledges this risk, but `recordExceptions: false` only
removes the exception event; it still exports the status message.

This is an intentional policy, not an accidental code path, but it materially
weakens the library's “no parameter capture” safety expectation. The risk is
active in the defaults and cannot be fully disabled by configuration.

Recommendation: set only `ERROR` status plus `error.type` by default, without
a status message or exception event. Offer an explicitly opt-in diagnostic
option (for example `captureErrorDetails`) for both error message and exception
recording, with clear PII guidance. Add integration tests that provoke a driver
error whose message includes a supplied value and assert the default exported
span contains none of it.

### 3. Medium — a synchronous `streamQuery` failure leaves a span open and unreported

After creating a span, `ObservedConnection.streamQuery` calls the inner
iterator factory outside a `try`/`catch`
([`src/observed-connection.ts`](../src/observed-connection.ts)). An
implementation is allowed to throw synchronously while creating an
`AsyncIterableIterator` (for example, unsupported streaming or immediate
validation failure). In that case, no `endSpan` callback has been registered:
the query span is never ended, no error status is recorded, and no failure
duration metric is emitted.

Existing stream tests cover errors thrown while advancing an async generator,
which is the usual path, but not this synchronous factory failure.

Recommendation: wrap creation of the inner iterator in `try`/`catch`; on
failure call `finishFailure`, end the span, and rethrow the original error.
Similarly, run delegated `next`, `return`, and `throw` under `spanContext` and
close the span after the inner iterator has completed its cleanup, so its full
lifetime and nested driver telemetry are represented accurately.

### 4. Medium — `maxQueryTextLength` is not validated, allowing a configuration mistake to defeat the intended cap

`normalizeOptions` accepts any JavaScript number for `maxQueryTextLength`
([`src/options.ts`](../src/options.ts)); that value is passed straight to
`String.prototype.slice` in the analysis pipeline
([`src/analysis/analyze.ts`](../src/analysis/analyze.ts)). A negative value
has surprising semantics: `-1` retains all but the final character, rather
than emitting no more than one character. `Infinity` removes the effective
length cap altogether. Either can result from a bad environment-derived
configuration and can export unexpectedly large SQL or increase memory/egress
costs.

Recommendation: validate configuration at the public boundary. Require a
finite, non-negative integer, and either throw a descriptive startup error or
clamp to a documented safe maximum. Add boundary tests for `0`, negative,
fractional, `NaN`, and `Infinity` values.

### 5. Low — raw-SQL table extraction misses quoted identifiers and several common statement forms

The raw-SQL extractor first masks quoted identifiers and then uses a regex that
only accepts bare identifiers after `FROM`, `JOIN`, `INTO`, and `UPDATE`
([`src/analysis/tables.ts`](../src/analysis/tables.ts)). Thus common raw SQL
such as `SELECT * FROM "orders"`, `SELECT * FROM [dbo].[orders]`, or
`SELECT * FROM \`orders\`` gets an `unknown` summary and no
`db.collection.name`. It also cannot report targets of statements such as
`DELETE`, `TRUNCATE`, `CREATE`, `ALTER`, or `DROP` when expressed as raw SQL.

The README describes raw extraction as best-effort, so this does not affect
query-builder statements and is not a correctness defect in execution. It does
however reduce the value of the library's principal grouping attributes for a
very common raw-SQL case.

Recommendation: extend the lexer proposed in finding 1 to yield identifier
tokens (including dialect quoting) while still masking string/comment contents,
then implement a deliberately bounded raw-SQL extractor over those tokens.
Document the supported grammar and add per-dialect quoted-identifier tests.

### 6. Low — wrapper idempotency is limited to one installed copy of the package

`observeDialect` identifies an existing wrapper with
`dialect instanceof ObservedDialect` ([`src/observed-dialect.ts`](../src/observed-dialect.ts)).
That check fails when two physical copies/versions of this package are loaded,
which is realistic in linked packages and monorepos. A second copy then wraps
the first, producing nested duplicate query spans and duplicate metric records.

Recommendation: use a `Symbol.for(...)` capability marker (validated
defensively) on the wrapper in addition to `instanceof`, or deliberately throw
when a dialect advertises that it is already observed. Include a test using a
wrapper-like object to establish the cross-copy contract.

## Additional observations and opportunities

- The current abstractions appropriately preserve Kysely's driver surface,
  including optional savepoint and connection APIs. Keeping the wrappers thin
  makes compatibility maintenance tractable.
- The byte-bounded LRU and the “do not cache huge SQL” rule are sound defenses
  against a common instrumentation memory failure mode. The stated 16 MiB cap
  is approximate, since JavaScript engine string storage is implementation
  dependent; describe it as a budget/heuristic rather than a hard heap cap.
- `db.query.summary` deliberately includes table names and is a metric label by
  default. This is useful, but table names can be tenant- or shard-derived in
  some deployments. Consider an opt-in metric dimension or a separate
  `summary`/`metricSummary` setting so operators can preserve low cardinality
  without losing span detail.
- The `attributes` hook receives raw SQL and parameter values. The README warns
  users, but a safer public API would expose a redacted context by default and
  reserve raw values for an explicitly named advanced/unsafe hook. That would
  make the secure path easier to use correctly.

## Verification performed

The local quality suite completed successfully on 2026-07-09:

```text
pnpm test       # 18 files, 162 tests passed
pnpm typecheck  # passed
pnpm lint       # passed
pnpm build      # ESM, CJS, and declarations built successfully
```

These results show the current tested contract is healthy; they do not cover
the comment-sanitization, synchronous stream-factory, or invalid-option cases
described above.

## Disposition (2026-07-09)

| Finding | Outcome |
|---------|---------|
| 1 (comments in sanitized text) | Fixed — `fingerprintSql` strips comments via the pre-existing `sql-text.ts` scanner (no new lexer was needed). |
| 2 (error messages exported) | Default kept (matches mainstream OTel DB instrumentations); added `recordErrorMessages: false` opt-out. |
| 3 (sync streamQuery throw) | Fixed — inner iterator creation wrapped; note all built-in Kysely drivers are async generators, so this only affected third-party dialects. |
| 4 (maxQueryTextLength) | Fixed — invalid values fall back to the default with a diagnostic warning. |
| 5 (raw-SQL quoted identifiers) | Deferred — Low severity, documented best-effort. Correction: `DELETE FROM x` **is** extracted (the regex matches `from`); only TRUNCATE/CREATE/ALTER/DROP targets are missed. |
| 6 (instanceof idempotency) | Fixed — `Symbol.for('kysely-opentelemetry.observed')` marker recognized across package copies. |

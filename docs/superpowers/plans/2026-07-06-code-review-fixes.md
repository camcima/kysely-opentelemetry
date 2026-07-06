# Code-Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Address all 15 findings from the 2026-07-06 architectural review: 4 bugs, 6 design concerns, and 5 improvements, without breaking the existing public API or the "instrumentation never breaks a query" invariant.

**Architecture:** Each finding is an isolated task against the existing layered design (dialect → driver → connection → analysis/otel helpers). No new files except one new test file; no new runtime dependencies. Options grow a few optional fields; two internal function signatures change (`recordDuration`, `createDurationHistogram`) — both are internal, only their in-repo call sites and tests need updates.

**Tech Stack:** TypeScript 5.9 (strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`), ESM with NodeNext resolution (all relative imports need `.js` suffix), vitest, `@opentelemetry/api` + `kysely` as peers only.

## Global Constraints

- Node `>=18`; peer ranges stay `kysely >=0.27 <0.30`, `@opentelemetry/api >=1.8`.
- No new runtime dependencies. Only `@opentelemetry/api` and `kysely` may be imported from `src/` (plus `node:crypto`).
- All relative imports in `src/` and `test/` MUST end in `.js` (NodeNext resolution).
- `exactOptionalPropertyTypes` is on: never assign `undefined` to a `?:` property; use conditional spread (`...(x !== undefined && { x })`) in object literals, or declare fields as `T | undefined` (not `?:`) when they are explicitly assigned `undefined`.
- Safety invariant: instrumentation must never break, wrap, or swallow a query error; every new OTel/user-hook touchpoint must be wrapped in try/catch like existing code.
- After each task: `pnpm test` (unit + otel suites), `pnpm typecheck`, `pnpm lint` must all pass.
- Commit after each task with a conventional-commit message.
- Do NOT run `pnpm test:integration` per task (needs Docker/testcontainers); it is a final optional verification only.

---

### Task 1: LRU cache key must include the query kind (bug — cache poisoning)

The analyzer cache is keyed on `compiledQuery.sql` alone, but the analysis depends on `query.kind`: a `sql.raw('select * from "orders"')` and a builder query compiling to the identical string differ in `isRaw` and use different table-extraction paths. Whichever runs first poisons the cache entry for the other.

**Files:**
- Modify: `src/analysis/analyze.ts:39-47`
- Test: `test/unit/analyze.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: no signature changes; `createAnalyzer(options: NormalizedOptions): Analyzer` unchanged.

- [ ] **Step 1: Write the failing test**

Add to the `describe('createAnalyzer', ...)` block in `test/unit/analyze.test.ts`:

```ts
  it('does not confuse a raw query with a builder query that compiles to identical sql', () => {
    const freshAnalyze = createAnalyzer(normalizeOptions());
    const builder = compile((db) => db.selectFrom('orders').selectAll());
    const raw = compileRaw(builder.sql);
    expect(raw.sql).toBe(builder.sql); // precondition: identical SQL text
    expect(freshAnalyze(raw).isRaw).toBe(true); // raw analyzed first, seeds the cache
    expect(freshAnalyze(builder).isRaw).toBe(false); // must NOT be served the raw entry
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/analyze.test.ts -t 'does not confuse'`
Expected: FAIL — `expected true to be false` on the last assertion (the builder query is served the poisoned raw entry).

- [ ] **Step 3: Fix the cache key**

In `src/analysis/analyze.ts`, replace the body of the function returned by `createAnalyzer`:

```ts
export function createAnalyzer(options: NormalizedOptions): Analyzer {
  const cache = new LruCache<string, QueryAnalysis>(CACHE_SIZE);
  return (compiledQuery) => {
    // Key on kind + sql: a raw query and a builder query can compile to the
    // identical SQL string yet analyze differently (isRaw, table extraction).
    const key = `${compiledQuery.query.kind}\0${compiledQuery.sql}`;
    let analysis = cache.get(key);
    if (!analysis) {
      analysis = analyzeSql(compiledQuery, options);
      cache.set(key, analysis);
    }
    return { ...analysis, sql: compiledQuery.sql, parameters: compiledQuery.parameters };
  };
}
```

- [ ] **Step 4: Run the full check suite**

Run: `pnpm vitest run test/unit/analyze.test.ts && pnpm typecheck && pnpm lint`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/analysis/analyze.ts test/unit/analyze.test.ts
git commit -m "fix: include query kind in analyzer cache key to prevent raw/builder collision"
```

---

### Task 2: Replace `warnOnce` with context-scoped `warnLimited` (design — misleading semantics)

`warnOnce` warns 10 times (not once), the counter is global across every failure category and never resets — after 10 warnings of any kind, a brand-new failure class is silent forever — and the message hardcodes "query executed unobserved" even at call sites where the query WAS observed. Replace with a per-context cap and accurate per-call-site messages.

**Files:**
- Modify: `src/otel/spans.ts:26-34`
- Modify: `src/observed-driver.ts` (2 call sites + import)
- Modify: `src/observed-connection.ts` (4 call sites + import)
- Test: `test/unit/spans.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `warnLimited(context: string, error: unknown): void` exported from `src/otel/spans.ts`. `warnOnce` is deleted (internal API; no deprecation needed at v0.1). Later tasks (3, 12) call `warnLimited` with this exact signature.

- [ ] **Step 1: Write the failing test**

In `test/unit/spans.test.ts`, replace the entire `describe('warnOnce', ...)` block with:

```ts
describe('warnLimited', () => {
  it('routes to diag.warn with a context prefix and caps per context, not globally', () => {
    const spy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 12; i++) warnLimited('test-context-a', new Error(`boom ${i}`));
    warnLimited('test-context-b', new Error('other failure'));
    const aCalls = spy.mock.calls.filter(([msg]) => String(msg).includes('test-context-a'));
    const bCalls = spy.mock.calls.filter(([msg]) => String(msg).includes('test-context-b'));
    expect(aCalls).toHaveLength(10); // 11th and 12th suppressed
    expect(bCalls).toHaveLength(1); // a fresh context is NOT silenced by another context's cap
    expect(String(aCalls[0]![0])).toContain('kysely-opentelemetry');
    spy.mockRestore();
  });
});
```

Also update the import at the top of the file: change `warnOnce` to `warnLimited` in the import from `../../src/otel/spans.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/spans.test.ts`
Expected: FAIL — `warnLimited` is not exported.

- [ ] **Step 3: Implement `warnLimited`**

In `src/otel/spans.ts`, replace the `MAX_WARNINGS`/`warnCount`/`warnOnce` block (lines 26-34) with:

```ts
const MAX_WARNINGS_PER_CONTEXT = 10;
const warnCounts = new Map<string, number>();

/**
 * Instrumentation-internal failures: warn through OTel diagnostics, capped
 * per context string so one noisy failure class cannot silence the others.
 */
export function warnLimited(context: string, error: unknown): void {
  const count = warnCounts.get(context) ?? 0;
  if (count >= MAX_WARNINGS_PER_CONTEXT) return;
  warnCounts.set(context, count + 1);
  diag.warn(`kysely-opentelemetry: ${context}`, error);
}
```

- [ ] **Step 4: Update all call sites**

In `src/observed-driver.ts`:
- Change the import: `import { recordError, warnLimited } from './otel/spans.js';`
- In `startTransactionSpan` catch: `warnLimited('failed to start transaction span', error);`
- In `endTransactionSpan` catch: `warnLimited('failed to finalize transaction span', err);`

In `src/observed-connection.ts`:
- Change the import: `import { recordError, warnLimited } from './otel/spans.js';`
- In `streamQuery`'s `endSpan`, the inner catch around `setAttribute`: `warnLimited('failed to set stream row-count attribute', e);`
- In `startQuery` catch: `warnLimited('query span creation failed (query executed unobserved)', error);`
- In `finishSuccess` catch: `warnLimited('failed to record duration metric', error);`
- In `finishFailure` catch: `warnLimited('failed to record query failure telemetry', err);`
- In `setResultAttributes` catch: `warnLimited('failed to set result attributes', error);`

- [ ] **Step 5: Run the full check suite**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/otel/spans.ts src/observed-driver.ts src/observed-connection.ts test/unit/spans.test.ts
git commit -m "fix: cap instrumentation warnings per failure context with accurate messages"
```

---

### Task 3: Stream iterator hardening — no `throw undefined`, defensive span close on release (bugs)

Two related stream fixes: (a) the iterator's `throw()` handler rethrows `undefined` when called without an argument and the inner iterator has no `throw`; (b) a manually-driven iterator abandoned without `return()`/`throw()` leaks an un-ended span. Fix (a) by synthesizing a real Error; fix (b) with a backstop in `releaseConnection`, mirroring the existing `released_unfinished` treatment of transaction spans.

**Files:**
- Modify: `src/observed-connection.ts` (stream span registry, `throw()` handler)
- Modify: `src/observed-driver.ts:87-95` (`releaseConnection`)
- Modify: `README.md` (Known limitations, stream bullet)
- Test: `test/otel/connection.test.ts`, `test/otel/driver.test.ts`

**Interfaces:**
- Consumes: `warnLimited` from Task 2 (already in place).
- Produces: `ObservedConnection.endOpenStreamSpans(): void` — public method called by `ObservedDriver.releaseConnection`.

- [ ] **Step 1: Write the failing tests**

Add to `describe('ObservedConnection.streamQuery', ...)` in `test/otel/connection.test.ts`:

```ts
  it('throw() without an argument raises a real Error, not undefined', async () => {
    const { connection } = makeConnection(() => ({ rows: [{ id: 1 }, { id: 2 }] }));
    const iterator = connection.streamQuery(SELECT, 1);
    await iterator.next();
    await expect(iterator.throw!()).rejects.toBeInstanceOf(Error);
    const spans = otel.spanExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.status.code).toBe(SpanStatusCode.ERROR);
  });
```

In `test/otel/driver.test.ts`, first make the fake script injectable — replace the `makeDriver` helper with:

```ts
function makeDriver(
  overrides: KyselyOtelOptions = {},
  script: () => { rows: any[] } = () => ({ rows: [] }),
) {
  const options = normalizeOptions(overrides);
  const { driver: fakeDriver } = createFakeDialect(script);
  const driver = new ObservedDriver(fakeDriver, {
    options,
    analyze: createAnalyzer(options),
    tracer: trace.getTracer('test'),
    dbSystem: 'postgresql',
  });
  return { driver, fakeDriver };
}
```

Then add a new describe block at the end of `test/otel/driver.test.ts`:

```ts
describe('ObservedDriver stream span backstop', () => {
  it('ends abandoned stream spans when the connection is released', async () => {
    const { driver } = makeDriver({}, () => ({ rows: [{ id: 1 }, { id: 2 }] }));
    const connection = (await driver.acquireConnection()) as ObservedConnection;
    const iterator = connection.streamQuery(SELECT, 1);
    await iterator.next(); // start the stream, then abandon it without return()
    expect(otel.spanExporter.getFinishedSpans()).toHaveLength(0);
    await driver.releaseConnection(connection);
    expect(otel.spanExporter.getFinishedSpans()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/otel/connection.test.ts test/otel/driver.test.ts`
Expected: both new tests FAIL — `throw()` rejects with `undefined` (not an Error instance), and the abandoned-stream test sees 0 finished spans after release.

- [ ] **Step 3: Implement in `ObservedConnection`**

In `src/observed-connection.ts`, add a private field after the existing `acquireDurationMs` declaration:

```ts
  /** endSpan closures of streams still open on this connection; drained by
   *  endOpenStreamSpans() when the lease ends (abandoned manual iterators). */
  readonly #openStreamEnders = new Set<(error?: unknown) => void>();
```

In `streamQuery`, register/unregister the `endSpan` closure — replace the `endSpan` definition and the `throw` handler:

```ts
    const endSpan = (error?: unknown): void => {
      if (ended) return;
      ended = true;
      this.#openStreamEnders.delete(endSpan);
      try {
        if (error === undefined) {
          try {
            span.setAttribute(ATTR_RETURNED_ROWS, rowCount);
          } catch (e) {
            warnLimited('failed to set stream row-count attribute', e);
          }
          this.finishSuccess(ctx, startTime);
        } else {
          this.finishFailure(span, ctx, startTime, error);
        }
      } finally {
        span.end();
      }
    };
    this.#openStreamEnders.add(endSpan);
```

Replace the returned iterator's `throw` handler:

```ts
      async throw(error?: unknown): Promise<IteratorResult<QueryResult<R>>> {
        const reason = error ?? new Error('stream aborted');
        endSpan(reason);
        if (inner.throw) return inner.throw(reason);
        throw reason;
      },
```

Add a public method after `streamQuery`:

```ts
  /** Defensive backstop: a stream span must never outlive its connection
   *  lease. Called by ObservedDriver.releaseConnection. */
  endOpenStreamSpans(): void {
    for (const end of [...this.#openStreamEnders]) end();
  }
```

(The spread copy is required: each `end()` deletes itself from the set while iterating.)

- [ ] **Step 4: Call the backstop from `releaseConnection`**

In `src/observed-driver.ts`, replace `releaseConnection`:

```ts
  async releaseConnection(
    connection: DatabaseConnection,
    options?: Parameters<Driver['releaseConnection']>[1],
  ): Promise<void> {
    const wrapper = asWrapper(connection);
    // Defensive: spans must never outlive their connection lease.
    wrapper?.endOpenStreamSpans();
    if (wrapper?.transactionSpan) this.endTransactionSpan(wrapper, 'released_unfinished');
    return this.inner.releaseConnection(unwrap(connection), options);
  }
```

- [ ] **Step 5: Update the README limitation bullet**

In `README.md` → "Known limitations", replace the final sentence of the streamed-queries bullet ("If you instead manually drive the returned async iterator … no way to signal abandonment.") with:

```markdown
If you instead manually drive the returned async iterator and abandon it without exhausting it or calling `.return()`, the span stays open until the connection lease ends — when the connection is released back to the pool, the library force-closes any stream spans still open on it.
```

- [ ] **Step 6: Run the full check suite**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all PASS (including the three pre-existing stream tests).

- [ ] **Step 7: Commit**

```bash
git add src/observed-connection.ts src/observed-driver.ts test/otel/connection.test.ts test/otel/driver.test.ts README.md
git commit -m "fix: close abandoned stream spans on connection release and never rethrow undefined"
```

---

### Task 4: Document the Postgres backslash-string fingerprint caveat (bug — documented, not fixed)

The `SINGLE_QUOTED` regex treats `\'` as an escaped quote (MySQL semantics). In Postgres's default mode (`standard_conforming_strings = on`) a backslash is literal, so `'C:\'` is a complete string and the scrubber over-consumes through the next literal, corrupting the fingerprint. Decision: keep the MySQL-compatible regex (changing it would break MySQL scrubbing) and document the mirror-image limitation, pinned by a test. Only reachable via hand-written raw SQL containing backslash-before-quote — builder queries never inline literals.

**Files:**
- Modify: `src/analysis/fingerprint.ts` (comment block only)
- Modify: `README.md` (Known limitations)
- Test: `test/unit/fingerprint.test.ts` (pinning test)

**Interfaces:**
- Consumes/Produces: none — no behavior change.

- [ ] **Step 1: Write the pinning test (passes immediately — it documents current behavior)**

Add to `test/unit/fingerprint.test.ts` (it imports `fingerprintSql` from `../../src/analysis/fingerprint.js`; add the import if a fresh describe block is created):

```ts
describe('known limitation: Postgres standard_conforming_strings', () => {
  it('a literal backslash before a closing quote over-consumes into the next literal', () => {
    // In Postgres (standard_conforming_strings = on) 'C:\' is a complete
    // string, but the scrubber applies MySQL escape semantics, so it consumes
    // through the next quote and swallows the SQL between the two literals.
    // Pinned so any future regex change surfaces here deliberately.
    const result = fingerprintSql("SELECT * FROM t WHERE path = 'C:\\' AND name = 'x'");
    expect(result).toBe("SELECT * FROM t WHERE path = ?x'");
  });
});
```

- [ ] **Step 2: Run the test — verify the pinned expectation is accurate**

Run: `pnpm vitest run test/unit/fingerprint.test.ts`
Expected: PASS. If it fails, the actual output tells you the true current behavior — update the pinned string to match reality (the point is to pin, not to prescribe), and note the discrepancy in the task report.

- [ ] **Step 3: Extend the comment in `fingerprint.ts`**

In `src/analysis/fingerprint.ts`, after the existing paragraph ending "…a MySQL \"...\"-quoted string literal in hand-written raw SQL is a known, documented limitation.", add to the same comment block:

```ts
// The mirror-image caveat: \' is treated as an escaped quote (MySQL
// semantics), but in Postgres's default standard_conforming_strings mode a
// backslash is a literal character, so a raw-SQL literal ending in a
// backslash ('C:\') makes the scrubber over-consume into the next literal
// and corrupt that query's fingerprint. Builder queries are unaffected
// (values are always bind parameters). Pinned in fingerprint.test.ts.
```

- [ ] **Step 4: Add the README limitation bullet**

In `README.md` → "Known limitations", after the existing "Fingerprint scrubbing is defense-in-depth…" bullet, add:

```markdown
- **Raw-SQL string literals ending in a backslash corrupt that query's fingerprint on Postgres.** The scrubber treats `\'` as an escaped quote (MySQL semantics). Under Postgres's default `standard_conforming_strings = on`, a backslash is a literal character, so a hand-written literal like `'C:\'` makes the scrubber over-consume into the next literal — the fingerprint (and sanitized `db.query.text`) for that query loses the SQL between the two literals. Grouping keys remain stable (the corruption is deterministic), and no parameter value leaks. Builder queries are unaffected. Use bind parameters in raw SQL to avoid this entirely.
```

- [ ] **Step 5: Run the full check suite**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/analysis/fingerprint.ts test/unit/fingerprint.test.ts README.md
git commit -m "docs: pin and document the Postgres backslash-string fingerprint limitation"
```

---

### Task 5: Metrics must respect `summary: false` (design — cardinality control)

`recordDuration` emits `db.query.summary` on every histogram data point regardless of the `summary` option — but metric attributes are exactly where cardinality costs money. Gate it on `options.summary`. (The span *name* intentionally still uses the summary — spans need a name — and that stays documented.)

**Files:**
- Modify: `src/otel/metrics.ts:27-42` (`recordDuration` gains an `options` parameter)
- Modify: `src/observed-connection.ts` (`finishSuccess`, `finishFailure` call sites)
- Modify: `README.md` (options table, Metric section)
- Test: `test/unit/metrics.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `recordDuration(histogram: Histogram, ctx: QueryContext, dbSystem: string, options: NormalizedOptions, durationMs: number, errType?: string): void` — Task 10 adds attributes inside this same function and relies on the `options` parameter existing.

- [ ] **Step 1: Write the failing test**

In `test/unit/metrics.test.ts`, add `import { normalizeOptions } from '../../src/options.js';` and update the two existing `recordDuration` calls to the new signature:

```ts
    recordDuration(h, ctx({ primaryTable: 'orders' }), 'postgresql', normalizeOptions(), 250);
```

```ts
    recordDuration(h, ctx(), 'mysql', normalizeOptions(), 100, 'QueryFailedError');
```

Then add:

```ts
  it('omits db.query.summary when summary: false', () => {
    const h = fakeHistogram();
    recordDuration(h, ctx(), 'postgresql', normalizeOptions({ summary: false }), 100);
    const [, attrs] = h.record.mock.calls[0];
    expect(attrs).not.toHaveProperty('db.query.summary');
    expect(attrs['db.operation.name']).toBe('SELECT'); // rest of the attrs intact
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/metrics.test.ts`
Expected: FAIL — compile error on arity, then after the signature change exists, the `summary: false` assertion is the real gate.

- [ ] **Step 3: Change `recordDuration`**

In `src/otel/metrics.ts`, add `import type { NormalizedOptions } from '../options.js';` and replace `recordDuration`:

```ts
export function recordDuration(
  histogram: Histogram,
  ctx: QueryContext,
  dbSystem: string,
  options: NormalizedOptions,
  durationMs: number,
  errType?: string,
): void {
  const attrs: Attributes = {
    [ATTR_DB_SYSTEM]: dbSystem,
    [ATTR_DB_OPERATION]: ctx.operation,
  };
  if (options.summary) attrs[ATTR_DB_QUERY_SUMMARY] = ctx.summary;
  if (ctx.primaryTable !== undefined) attrs[ATTR_DB_COLLECTION] = ctx.primaryTable;
  if (errType !== undefined) attrs[ATTR_ERROR_TYPE] = errType;
  histogram.record(durationMs / 1000, attrs);
}
```

- [ ] **Step 4: Update the call sites**

In `src/observed-connection.ts`:

`finishSuccess`:

```ts
  private finishSuccess(ctx: QueryContext, startTime: number): void {
    try {
      if (this.deps.histogram) {
        recordDuration(
          this.deps.histogram,
          ctx,
          this.deps.dbSystem,
          this.deps.options,
          performance.now() - startTime,
        );
      }
    } catch (error) {
      warnLimited('failed to record duration metric', error);
    }
  }
```

`finishFailure` — the `recordDuration` call becomes:

```ts
        recordDuration(
          this.deps.histogram,
          ctx,
          this.deps.dbSystem,
          this.deps.options,
          performance.now() - startTime,
          errType,
        );
```

- [ ] **Step 5: Update the README**

Options table, `summary` row description:

```markdown
| `summary` | `boolean` | `true` | Emit `db.query.summary` on spans **and** on the duration metric. The span *name* still uses the summary regardless (spans need a name); set this to `false` to keep the summary out of metric/attribute cardinality. |
```

Metric section (the sentence starting "Attributes are deliberately low-cardinality:"): replace the bare item "`db.query.summary`" in that attribute list with "`db.query.summary` (when `summary: true`, default)".

- [ ] **Step 6: Run the full check suite**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/otel/metrics.ts src/observed-connection.ts test/unit/metrics.test.ts README.md
git commit -m "fix: respect summary option on the duration metric's attributes"
```

---

### Task 6: Prefer user-created spans over the TRANSACTION span as query parent (design)

Query spans inside a transaction always parent to the TRANSACTION span captured at BEGIN, silently flattening any span hierarchy the user creates inside the transaction callback. Heuristic fix: remember which span was active at BEGIN; at query time, if the currently active span differs, the user has opened their own span since — parent to the active context instead.

**Files:**
- Modify: `src/observed-connection.ts` (new field + parent-selection logic in `startQuery`)
- Modify: `src/observed-driver.ts` (`startTransactionSpan` records the begin-time span; `endTransactionSpan` clears it)
- Modify: `README.md` (transaction-spans paragraph)
- Test: `test/otel/driver.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ObservedConnection.transactionParentSpan: Span | undefined` — public field managed by `ObservedDriver`, same pattern as the existing `transactionSpan`/`transactionContext` fields.

- [ ] **Step 1: Write the failing test**

Add to `describe('ObservedDriver transaction spans', ...)` in `test/otel/driver.test.ts`:

```ts
  it('parents queries to a user-created span inside the transaction, not TRANSACTION', async () => {
    const { driver } = makeDriver();
    const connection = await driver.acquireConnection();
    await driver.beginTransaction(connection, {});
    const tracer = trace.getTracer('user');
    await tracer.startActiveSpan('user-step', async (userSpan) => {
      await connection.executeQuery(SELECT);
      userSpan.end();
    });
    await driver.commitTransaction(connection);

    const spans = otel.spanExporter.getFinishedSpans();
    const querySpan = spans.find((s) => s.name === 'SELECT orders')!;
    const userSpan = spans.find((s) => s.name === 'user-step')!;
    expect(querySpan.parentSpanContext?.spanId).toBe(userSpan.spanContext().spanId);
  });
```

(The existing test "wraps begin→commit in a TRANSACTION span with query spans as children" must keep passing: with no user span, queries still parent to TRANSACTION.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/otel/driver.test.ts`
Expected: the new test FAILS — the query span's parent is the TRANSACTION span, not `user-step`.

- [ ] **Step 3: Record the begin-time span in the driver**

In `src/observed-driver.ts`, `startTransactionSpan` — set the new field alongside the existing two:

```ts
  private startTransactionSpan(wrapper: ObservedConnection): void {
    try {
      const parent = context.active();
      const span = this.deps.tracer.startSpan(
        'TRANSACTION',
        { kind: SpanKind.CLIENT, attributes: { [ATTR_DB_SYSTEM]: this.deps.dbSystem } },
        parent,
      );
      wrapper.transactionSpan = span;
      wrapper.transactionParentSpan = trace.getSpan(parent);
      wrapper.transactionContext = trace.setSpan(parent, span);
    } catch (error) {
      warnLimited('failed to start transaction span', error);
    }
  }
```

In `endTransactionSpan`, clear it with the others:

```ts
    const span = wrapper.transactionSpan;
    wrapper.transactionSpan = undefined;
    wrapper.transactionContext = undefined;
    wrapper.transactionParentSpan = undefined;
```

- [ ] **Step 4: Add the field and parent-selection logic in the connection**

In `src/observed-connection.ts`, add after `transactionContext`:

```ts
  /** Span active when the transaction began; when the active span at query
   *  time differs, the user opened their own span inside the callback. */
  transactionParentSpan: Span | undefined = undefined;
```

In `startQuery`, replace `const parent = this.transactionContext ?? context.active();` with `const parent = this.pickParent();` and add the private method after `startQuery`:

```ts
  /** Inside a transaction, parent queries to the TRANSACTION span — unless
   *  the user opened their own span since BEGIN, in which case their
   *  hierarchy wins (the TRANSACTION span can never be in the ambient
   *  context, so the two lineages cannot be combined). */
  private pickParent(): Context {
    const active = context.active();
    if (this.transactionContext === undefined) return active;
    return trace.getSpan(active) === this.transactionParentSpan ? this.transactionContext : active;
  }
```

- [ ] **Step 5: Update the README**

Replace the last sentence of the transaction-spans paragraph (after the span-attributes table, "Query spans issued inside `db.transaction()` are children of the transaction span.") with:

```markdown
Query spans issued inside `db.transaction()` are children of the transaction span — unless you open your own span inside the transaction callback, in which case queries nest under *your* span instead. (The two hierarchies cannot be combined: the driver cannot inject the `TRANSACTION` span into your ambient context, so when you create spans of your own, your hierarchy wins and the `TRANSACTION` span remains a sibling that still carries the outcome attribute.)
```

- [ ] **Step 6: Run the full check suite**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all PASS — including the pre-existing transaction-children and outside-transaction tests.

- [ ] **Step 7: Commit**

```bash
git add src/observed-connection.ts src/observed-driver.ts test/otel/driver.test.ts README.md
git commit -m "fix: parent transaction queries under user-created spans when present"
```

---

### Task 7: Make `ObservedDialect` publicly constructible + double-wrap guard (design — API shape)

`ObservedDialect` is exported but its constructor demands `NormalizedOptions`, which is not exported — users can't legally instantiate it. Widen the constructor to `KyselyOtelOptions` (non-breaking: `NormalizedOptions` is structurally assignable to it). Also guard `observeDialect` against double-wrapping.

**Files:**
- Modify: `src/observed-dialect.ts`
- Test: `test/otel/observe-dialect.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `new ObservedDialect(inner: Dialect, options?: KyselyOtelOptions)` — public constructor. `observeDialect(dialect, options)` returns `dialect` unchanged when it is already an `ObservedDialect`.

- [ ] **Step 1: Write the failing tests**

In `test/otel/observe-dialect.test.ts`, add `ObservedDialect` to the src import (`import { observeDialect, ObservedDialect } from '../../src/index.js';`) and add to the describe block:

```ts
  it('returns an already-observed dialect unchanged (no double instrumentation)', () => {
    const { dialect } = createFakeDialect();
    const once = observeDialect(dialect);
    expect(observeDialect(once)).toBe(once);
  });

  it('ObservedDialect is directly constructible with public options', async () => {
    const { dialect } = createFakeDialect();
    const db = new Kysely<any>({ dialect: new ObservedDialect(dialect, { dbSystem: 'cockroachdb' }) });
    await db.selectFrom('orders').selectAll().execute();
    expect(otel.spanExporter.getFinishedSpans()[0]!.attributes['db.system.name']).toBe('cockroachdb');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/otel/observe-dialect.test.ts`
Expected: the double-wrap test FAILS (`observeDialect(once)` returns a new wrapper); the constructor test fails typecheck (`KyselyOtelOptions` is not `NormalizedOptions`).

- [ ] **Step 3: Implement**

In `src/observed-dialect.ts`, replace the class head and `observeDialect`:

```ts
export class ObservedDialect implements Dialect {
  private readonly options: NormalizedOptions;

  constructor(
    private readonly inner: Dialect,
    options: KyselyOtelOptions = {},
  ) {
    this.options = normalizeOptions(options);
  }
```

(`createDriver` and the passthrough methods are unchanged — they already read `this.options`.)

```ts
/**
 * Wrap a Kysely dialect with OpenTelemetry instrumentation.
 * With `enabled: false` the original dialect is returned untouched.
 * Wrapping an already-observed dialect returns it unchanged.
 */
export function observeDialect(dialect: Dialect, options?: KyselyOtelOptions): Dialect {
  if (dialect instanceof ObservedDialect) return dialect;
  if (!(options?.enabled ?? true)) return dialect;
  return new ObservedDialect(dialect, options);
}
```

Remove the now-unused `normalized` variable and adjust imports if needed (`normalizeOptions` is still used, now inside the constructor).

- [ ] **Step 4: Run the full check suite**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/observed-dialect.ts test/otel/observe-dialect.test.ts
git commit -m "feat: public ObservedDialect constructor and double-wrap guard"
```

---

### Task 8: Bound analyzer-cache memory by skipping huge SQL (design)

The LRU bounds entry *count* (10,000) but not bytes — keys are full compiled SQL strings, so pathological workloads (multi-hundred-KB raw statements) could pin ~GBs. Skip cache admission for SQL over 32 KB: re-analysis cost is proportional to the string anyway, so huge one-off statements gain little from caching.

**Files:**
- Modify: `src/analysis/analyze.ts`
- Test: `test/unit/analyze.test.ts`

**Interfaces:**
- Consumes: Task 1's `key` variable (same function body).
- Produces: no signature changes.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/analyze.test.ts`:

```ts
  it('does not cache very large sql (memory bound) but still analyzes it', () => {
    const freshAnalyze = createAnalyzer(normalizeOptions());
    const bigSql = `SELECT * FROM orders WHERE note = '${'x'.repeat(40_000)}'`;
    const a = freshAnalyze(compileRaw(bigSql));
    const b = freshAnalyze(compileRaw(bigSql));
    expect(a.operation).toBe('SELECT');
    expect(a.tables).toEqual(['orders']);
    expect(a.tables).not.toBe(b.tables); // distinct analyses — not served from cache

    const small = freshAnalyze(compile((db) => db.selectFrom('orders').selectAll()));
    const smallAgain = freshAnalyze(compile((db) => db.selectFrom('orders').selectAll()));
    expect(small.tables).toBe(smallAgain.tables); // small SQL still uses the cache
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/analyze.test.ts -t 'very large sql'`
Expected: FAIL — `a.tables` IS `b.tables` (second call served from cache).

- [ ] **Step 3: Implement the admission cap**

In `src/analysis/analyze.ts`, add below `CACHE_SIZE`:

```ts
/** SQL longer than this is analyzed but not cached: 10k huge keys would be a
 *  real memory sink, and re-analysis cost is proportional to the string. */
const MAX_CACHED_SQL_LENGTH = 32_768;
```

And gate `cache.set` in the analyzer:

```ts
    if (!analysis) {
      analysis = analyzeSql(compiledQuery, options);
      if (compiledQuery.sql.length <= MAX_CACHED_SQL_LENGTH) cache.set(key, analysis);
    }
```

- [ ] **Step 4: Run the full check suite**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/analysis/analyze.ts test/unit/analyze.test.ts
git commit -m "fix: skip analyzer-cache admission for SQL over 32KB to bound memory"
```

---

### Task 9: Pin `VERSION` to `package.json` (design — drift risk)

`src/version.ts` hardcodes `'0.1.0'` alongside `package.json`'s `"version": "0.1.0"` with nothing keeping them in sync. Add a test that fails on drift (chosen over build-time injection: zero build complexity, works for both ESM/CJS outputs, and version bumps are release-time events where tests run anyway).

**Files:**
- Create: `test/unit/version.test.ts`

**Interfaces:**
- Consumes: `VERSION` from `src/version.ts` (existing).
- Produces: nothing.

- [ ] **Step 1: Write the test**

Create `test/unit/version.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../../src/version.js';

describe('VERSION', () => {
  it('matches package.json — update src/version.ts when bumping the package version', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm vitest run test/unit/version.test.ts`
Expected: PASS (both are currently `0.1.0`). Sanity-check the guard actually bites: temporarily change `VERSION` to `'0.0.0'`, re-run, confirm FAIL, then revert.

- [ ] **Step 3: Commit**

```bash
git add test/unit/version.test.ts
git commit -m "test: guard src/version.ts against drifting from package.json"
```

---

### Task 10: Connection-level semconv attributes — `db.namespace`, `server.address`, `server.port` (improvement)

A dialect wrapper cannot discover the database name or host, but they are the correlation keys most backends use (Datadog DBM, Tempo service graphs). Accept them via options and stamp them on query spans, transaction spans, and the duration metric.

**Files:**
- Modify: `src/options.ts` (3 new options)
- Modify: `src/otel/attributes.ts` (3 new constants + emission in `buildQueryAttributes`)
- Modify: `src/otel/metrics.ts` (emission in `recordDuration`)
- Modify: `src/observed-driver.ts` (emission on transaction spans)
- Modify: `src/index.ts` (export new constants)
- Modify: `README.md` (options table + attributes table + metric section)
- Test: `test/unit/attributes.test.ts`, `test/unit/metrics.test.ts`, `test/otel/driver.test.ts`, `test/unit/options.test.ts`

**Interfaces:**
- Consumes: Task 5's `recordDuration(..., options, ...)` parameter.
- Produces: `KyselyOtelOptions.namespace?: string`, `serverAddress?: string`, `serverPort?: number` (mirrored readonly-optional on `NormalizedOptions`); exported constants `ATTR_DB_NAMESPACE = 'db.namespace'`, `ATTR_SERVER_ADDRESS = 'server.address'`, `ATTR_SERVER_PORT = 'server.port'`.

- [ ] **Step 1: Write the failing tests**

`test/unit/attributes.test.ts` — add to the describe block:

```ts
  it('emits connection-level attributes when configured, omits them by default', () => {
    const configured = attrsFor({ namespace: 'shop', serverAddress: 'db.internal', serverPort: 5432 });
    expect(configured.attrs['db.namespace']).toBe('shop');
    expect(configured.attrs['server.address']).toBe('db.internal');
    expect(configured.attrs['server.port']).toBe(5432);

    const defaults = attrsFor();
    expect(defaults.attrs).not.toHaveProperty('db.namespace');
    expect(defaults.attrs).not.toHaveProperty('server.address');
    expect(defaults.attrs).not.toHaveProperty('server.port');
  });
```

NOTE: this addition breaks the existing `'emits the full default attribute set'` test only if written with `toEqual` — it does not; no change needed there.

`test/unit/metrics.test.ts` — add:

```ts
  it('emits connection-level attributes when configured', () => {
    const h = fakeHistogram();
    const options = normalizeOptions({ namespace: 'shop', serverAddress: 'db.internal', serverPort: 5432 });
    recordDuration(h, ctx(), 'postgresql', options, 100);
    const [, attrs] = h.record.mock.calls[0];
    expect(attrs['db.namespace']).toBe('shop');
    expect(attrs['server.address']).toBe('db.internal');
    expect(attrs['server.port']).toBe(5432);
  });
```

`test/otel/driver.test.ts` — add to the transaction-spans describe block:

```ts
  it('stamps connection-level attributes on transaction spans', async () => {
    const { driver } = makeDriver({ namespace: 'shop', serverAddress: 'db.internal', serverPort: 5432 });
    const connection = await driver.acquireConnection();
    await driver.beginTransaction(connection, {});
    await driver.commitTransaction(connection);
    const txSpan = otel.spanExporter.getFinishedSpans().find((s) => s.name === 'TRANSACTION')!;
    expect(txSpan.attributes['db.namespace']).toBe('shop');
    expect(txSpan.attributes['server.address']).toBe('db.internal');
    expect(txSpan.attributes['server.port']).toBe(5432);
  });
```

`test/unit/options.test.ts` — in `'applies safe defaults'`, add:

```ts
    expect(opts.namespace).toBeUndefined();
    expect(opts.serverAddress).toBeUndefined();
    expect(opts.serverPort).toBeUndefined();
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/attributes.test.ts test/unit/metrics.test.ts test/otel/driver.test.ts`
Expected: typecheck failures on the unknown options, then attribute assertions fail.

- [ ] **Step 3: Add the options**

`src/options.ts` — add to `KyselyOtelOptions` (after `dbSystem`):

```ts
  /** Emitted as db.namespace on spans and metrics (e.g. the database name). Not auto-detectable from a dialect. */
  namespace?: string;
  /** Emitted as server.address on spans and metrics (e.g. the DB host). */
  serverAddress?: string;
  /** Emitted as server.port on spans and metrics. */
  serverPort?: number;
```

Add to `NormalizedOptions` (after `dbSystem`):

```ts
  readonly namespace?: string;
  readonly serverAddress?: string;
  readonly serverPort?: number;
```

Add to `normalizeOptions` (after the `dbSystem` spread):

```ts
    ...(options.namespace !== undefined && { namespace: options.namespace }),
    ...(options.serverAddress !== undefined && { serverAddress: options.serverAddress }),
    ...(options.serverPort !== undefined && { serverPort: options.serverPort }),
```

- [ ] **Step 4: Emit on query spans, metrics, and transaction spans**

`src/otel/attributes.ts` — add to the semconv constants block:

```ts
export const ATTR_DB_NAMESPACE = 'db.namespace';
export const ATTR_SERVER_ADDRESS = 'server.address';
export const ATTR_SERVER_PORT = 'server.port';
```

In `buildQueryAttributes`, after the initial `attrs` literal:

```ts
  if (options.namespace !== undefined) attrs[ATTR_DB_NAMESPACE] = options.namespace;
  if (options.serverAddress !== undefined) attrs[ATTR_SERVER_ADDRESS] = options.serverAddress;
  if (options.serverPort !== undefined) attrs[ATTR_SERVER_PORT] = options.serverPort;
```

`src/otel/metrics.ts` — in `recordDuration`, import the three new constants and add the same three lines after the `attrs` literal (before the `options.summary` line).

`src/observed-driver.ts` — import `Attributes` type from `@opentelemetry/api` and the three new constants from `./otel/attributes.js`; in `startTransactionSpan`, build the attributes before `startSpan`:

```ts
      const attributes: Attributes = { [ATTR_DB_SYSTEM]: this.deps.dbSystem };
      const { namespace, serverAddress, serverPort } = this.deps.options;
      if (namespace !== undefined) attributes[ATTR_DB_NAMESPACE] = namespace;
      if (serverAddress !== undefined) attributes[ATTR_SERVER_ADDRESS] = serverAddress;
      if (serverPort !== undefined) attributes[ATTR_SERVER_PORT] = serverPort;
      const span = this.deps.tracer.startSpan(
        'TRANSACTION',
        { kind: SpanKind.CLIENT, attributes },
        parent,
      );
```

`src/index.ts` — add `ATTR_DB_NAMESPACE`, `ATTR_SERVER_ADDRESS`, `ATTR_SERVER_PORT` to the exported constants list (keep alphabetical order: `ATTR_DB_NAMESPACE` after `ATTR_DB_COLLECTION`; the `ATTR_SERVER_*` pair after `ATTR_SANITIZATION_ERROR`).

- [ ] **Step 5: Update the README**

Options table — add after the `dbSystem` row:

```markdown
| `namespace` | `string` | — | Emitted as `db.namespace` on all spans and the duration metric (typically the database name). Cannot be auto-detected from a dialect. |
| `serverAddress` | `string` | — | Emitted as `server.address` on all spans and the duration metric. |
| `serverPort` | `number` | — | Emitted as `server.port` on all spans and the duration metric. |
```

Span-attributes table — add after the `db.system.name` row:

```markdown
| `db.namespace` | `namespace` option set | The configured database name. |
| `server.address` / `server.port` | `serverAddress` / `serverPort` option set | The configured DB host/port. |
```

Metric section — extend the attribute list sentence: `…, db.collection.name (when known), db.namespace / server.address / server.port (when configured), and error.type (on failure).`

- [ ] **Step 6: Run the full check suite**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/options.ts src/otel/attributes.ts src/otel/metrics.ts src/observed-driver.ts src/index.ts test/unit/attributes.test.ts test/unit/metrics.test.ts test/unit/options.test.ts test/otel/driver.test.ts README.md
git commit -m "feat: db.namespace, server.address and server.port via options"
```

---

### Task 11: Tracer/meter provider injection (improvement)

Everything currently goes through the global `@opentelemetry/api` registries. Accept optional `tracerProvider`/`meterProvider` for tests and multi-provider apps; globals stay the default.

**Files:**
- Modify: `src/options.ts` (2 new options)
- Modify: `src/observed-dialect.ts` (`createDriver` resolves providers)
- Modify: `src/otel/metrics.ts` (`createDurationHistogram` takes a `Meter`)
- Modify: `test/otel/connection.test.ts` (call-site update)
- Modify: `README.md` (options table + SDK paragraph)
- Test: `test/otel/observe-dialect.test.ts`, `test/unit/options.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `KyselyOtelOptions.tracerProvider?: TracerProvider`, `meterProvider?: MeterProvider` (types from `@opentelemetry/api`); `createDurationHistogram(meter: Meter): Histogram` — Task 12's tests call `createDurationHistogram(metrics.getMeter('test'))`.

- [ ] **Step 1: Write the failing test**

In `test/otel/observe-dialect.test.ts`, add imports:

```ts
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
```

Add to the describe block:

```ts
  it('routes spans and metrics through injected providers instead of the globals', async () => {
    const spanExporter = new InMemorySpanExporter();
    const tracerProvider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(spanExporter)],
    });
    const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const meterProvider = new MeterProvider({
      readers: [
        new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 3_600_000 }),
      ],
    });

    const { db } = makeDb(undefined, { tracerProvider, meterProvider });
    await db.selectFrom('orders').selectAll().execute();

    expect(otel.spanExporter.getFinishedSpans()).toHaveLength(0); // global registry untouched
    expect(spanExporter.getFinishedSpans()).toHaveLength(1);
    await meterProvider.forceFlush();
    const metric = metricExporter
      .getMetrics()
      .flatMap((rm) => rm.scopeMetrics)
      .flatMap((sm) => sm.metrics)
      .find((m) => m.descriptor.name === 'db.client.operation.duration');
    expect(metric).toBeDefined();
    await tracerProvider.shutdown();
    await meterProvider.shutdown();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/otel/observe-dialect.test.ts`
Expected: FAIL — unknown options at typecheck / spans land in the global exporter.

- [ ] **Step 3: Add the options**

`src/options.ts` — extend the api import: `import type { Attributes, MeterProvider, TracerProvider } from '@opentelemetry/api';`

Add to `KyselyOtelOptions` (after `redact`):

```ts
  /** Use this TracerProvider instead of the global @opentelemetry/api registry. */
  tracerProvider?: TracerProvider;
  /** Use this MeterProvider instead of the global @opentelemetry/api registry. */
  meterProvider?: MeterProvider;
```

Add to `NormalizedOptions`:

```ts
  readonly tracerProvider?: TracerProvider;
  readonly meterProvider?: MeterProvider;
```

Add to `normalizeOptions`:

```ts
    ...(options.tracerProvider !== undefined && { tracerProvider: options.tracerProvider }),
    ...(options.meterProvider !== undefined && { meterProvider: options.meterProvider }),
```

- [ ] **Step 4: Resolve providers in `createDriver` and pass a `Meter` to the histogram factory**

`src/otel/metrics.ts` — change the import and factory signature:

```ts
import { ValueType, type Attributes, type Histogram, type Meter } from '@opentelemetry/api';
```

```ts
/** Semconv db.client.operation.duration histogram (seconds). */
export function createDurationHistogram(meter: Meter): Histogram {
  return meter.createHistogram('db.client.operation.duration', {
    description: 'Duration of database client operations.',
    unit: 's',
    valueType: ValueType.DOUBLE,
    advice: {
      explicitBucketBoundaries: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10],
    },
  });
}
```

(Remove the now-unused `VERSION` import from `metrics.ts` if nothing else uses it.)

`src/observed-dialect.ts` — add `metrics` to the api import (`import { metrics, trace } from '@opentelemetry/api';`) and replace `createDriver`:

```ts
  createDriver(): Driver {
    const tracerProvider = this.options.tracerProvider ?? trace;
    const meterProvider = this.options.meterProvider ?? metrics;
    const deps: ObservedConnectionDeps = {
      options: this.options,
      analyze: createAnalyzer(this.options),
      tracer: tracerProvider.getTracer('kysely-opentelemetry', VERSION),
      ...(this.options.metrics && {
        histogram: createDurationHistogram(meterProvider.getMeter('kysely-opentelemetry', VERSION)),
      }),
      dbSystem: this.options.dbSystem ?? detectDbSystem(this.inner),
    };
    return new ObservedDriver(this.inner.createDriver(), deps);
  }
```

- [ ] **Step 5: Update the in-repo call site**

`test/otel/connection.test.ts` — add `metrics` to the api import (`import { metrics, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';`) and in `makeConnection` change:

```ts
    histogram: createDurationHistogram(metrics.getMeter('test')),
```

- [ ] **Step 6: Update the README**

Options table — add after `redact`:

```markdown
| `tracerProvider` | `TracerProvider` | global registry | Route spans through this provider instead of the global `@opentelemetry/api` registry. |
| `meterProvider` | `MeterProvider` | global registry | Route the duration metric through this provider instead of the global registry. |
```

In the paragraph "You also need a configured OpenTelemetry SDK…", append this sentence:

> By default it uses the process-global tracer/meter registries; pass the `tracerProvider`/`meterProvider` options to route telemetry through explicit providers instead.

- [ ] **Step 7: Run the full check suite**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/options.ts src/otel/metrics.ts src/observed-dialect.ts test/otel/observe-dialect.test.ts test/otel/connection.test.ts README.md
git commit -m "feat: optional tracerProvider/meterProvider injection"
```

---

### Task 12: `shouldObserve` query filter (improvement)

No way to skip noise (health-check `SELECT 1`s, migrations) short of disabling everything. Add a fail-open predicate: returning `false` skips both the span and the metric for that query; a throwing filter must not disable instrumentation.

**Files:**
- Modify: `src/options.ts` (1 new option)
- Modify: `src/observed-connection.ts` (`startQuery` consults the filter)
- Modify: `README.md` (options table + hook subsection)
- Test: `test/otel/connection.test.ts`, `test/unit/options.test.ts`

**Interfaces:**
- Consumes: `createDurationHistogram(meter)` signature from Task 11.
- Produces: `KyselyOtelOptions.shouldObserve?: (ctx: QueryContext) => boolean`.

- [ ] **Step 1: Write the failing tests**

In `test/otel/connection.test.ts`, add `import type { QueryContext } from '../../src/analysis/analyze.js';` and a new describe block:

```ts
describe('shouldObserve filter', () => {
  function makeFiltered(shouldObserve: (ctx: QueryContext) => boolean) {
    const options = normalizeOptions({ shouldObserve });
    const inner = new FakeConnection((() => ({ rows: [] })) as any);
    return new ObservedConnection(inner, {
      options,
      analyze: createAnalyzer(options),
      tracer: trace.getTracer('test'),
      histogram: createDurationHistogram(metrics.getMeter('test')),
      dbSystem: 'postgresql',
    });
  }

  it('skips span and metric when the filter returns false', async () => {
    const connection = makeFiltered((ctx) => ctx.summary !== 'SELECT orders');
    const result = await connection.executeQuery(SELECT);
    expect(result.rows).toEqual([]); // query still executes
    expect(otel.spanExporter.getFinishedSpans()).toHaveLength(0);
    const metricData = await otel.collectMetrics();
    const metric = metricData
      .flatMap((rm) => rm.scopeMetrics)
      .flatMap((sm) => sm.metrics)
      .find((m) => m.descriptor.name === 'db.client.operation.duration');
    expect(metric?.dataPoints ?? []).toHaveLength(0);
  });

  it('observes when the filter returns true, and fails open when it throws', async () => {
    const observing = makeFiltered(() => true);
    await observing.executeQuery(SELECT);
    expect(otel.spanExporter.getFinishedSpans()).toHaveLength(1);

    const throwing = makeFiltered(() => {
      throw new Error('broken filter');
    });
    await throwing.executeQuery(SELECT);
    expect(otel.spanExporter.getFinishedSpans()).toHaveLength(2); // still observed
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/otel/connection.test.ts`
Expected: FAIL — `shouldObserve` is not a known option.

- [ ] **Step 3: Add the option**

`src/options.ts` — add to `KyselyOtelOptions` (before `attributes`):

```ts
  /** Skip observing a query (no span, no metric) by returning false.
   *  Fail-open: a throwing filter observes the query anyway. */
  shouldObserve?: (ctx: QueryContext) => boolean;
```

Add to `NormalizedOptions`:

```ts
  readonly shouldObserve?: (ctx: QueryContext) => boolean;
```

Add to `normalizeOptions`:

```ts
    ...(options.shouldObserve !== undefined && { shouldObserve: options.shouldObserve }),
```

- [ ] **Step 4: Consult the filter in `startQuery`**

In `src/observed-connection.ts`, at the top of `startQuery`'s `try` block, after `const ctx = this.deps.analyze(compiledQuery);`:

```ts
      if (this.deps.options.shouldObserve && !safeShouldObserve(this.deps.options.shouldObserve, ctx)) {
        return undefined;
      }
```

And add the module-level helper at the bottom of the file (next to `setResultAttributes`):

```ts
function safeShouldObserve(
  filter: (ctx: QueryContext) => boolean,
  ctx: QueryContext,
): boolean {
  try {
    return filter(ctx);
  } catch {
    return true; // fail-open: a broken filter must not disable instrumentation
  }
}
```

(Returning `undefined` from `startQuery` reuses the existing unobserved-execution path in both `executeQuery` and `streamQuery` — the query runs, no span, no metric.)

- [ ] **Step 5: Update the README**

Options table — add after `redact`:

```markdown
| `shouldObserve` | `(ctx: QueryContext) => boolean` | — | Return `false` to skip a query entirely (no span, no metric). Fail-open: if the filter throws, the query is observed. |
```

After "The `redact` hook" subsection, add:

````markdown
### The `shouldObserve` hook

```ts
observeDialect(dialect, {
  // Skip health checks and other noise — no span, no metric.
  shouldObserve: (ctx) => ctx.sql !== 'select 1',
});
```

The filter runs on the hot path before span creation; keep it cheap. It receives the same `QueryContext` as the `attributes` hook.
````

- [ ] **Step 6: Run the full check suite**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/options.ts src/observed-connection.ts test/otel/connection.test.ts README.md
git commit -m "feat: shouldObserve filter to skip spans and metrics per query"
```

---

### Task 13: `kysely.query.tables_truncated` attribute (improvement — honest signal)

Table extraction silently caps at 20 tables. Surface the truncation so `kysely.query.tables` is never mistaken for exhaustive.

**Files:**
- Modify: `src/analysis/tables.ts` (both extractors return `{ tables, truncated }`)
- Modify: `src/analysis/analyze.ts` (thread `tablesTruncated` through `QueryAnalysis`)
- Modify: `src/otel/attributes.ts` (new constant + emission)
- Modify: `src/index.ts` (export constant)
- Modify: `test/unit/metrics.test.ts` (the `ctx()` helper gains the new required field)
- Modify: `README.md` (attributes table)
- Test: `test/unit/tables.test.ts`, `test/unit/attributes.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `extractTables(node): TableExtraction` and `extractTablesFromRawSql(sql): TableExtraction` where `TableExtraction = { readonly tables: string[]; readonly truncated: boolean }`; `QueryAnalysis.tablesTruncated: boolean` (therefore also on `QueryContext`); exported constant `ATTR_TABLES_TRUNCATED = 'kysely.query.tables_truncated'`.

- [ ] **Step 1: Update existing tests to the new return shape and add truncation tests**

In `test/unit/tables.test.ts`, every existing assertion changes from `extractTables(x)` to `extractTables(x).tables` (and same for `extractTablesFromRawSql`). Update all of them, then replace the `'caps at 20 tables'` test and add a raw-SQL twin:

```ts
  it('caps at 20 tables and flags truncation', () => {
    const cq = compile((db) => {
      let qb = db.selectFrom('t0').selectAll();
      for (let i = 1; i < 30; i += 1) {
        qb = qb.innerJoin(`t${i}`, `t${i}.id`, 't0.id') as typeof qb;
      }
      return qb;
    });
    const result = extractTables(cq.query);
    expect(result.tables).toHaveLength(20);
    expect(result.truncated).toBe(true);
  });

  it('reports truncated: false under the cap', () => {
    const cq = compile((db) => db.selectFrom('orders').selectAll());
    expect(extractTables(cq.query).truncated).toBe(false);
    expect(extractTablesFromRawSql('SELECT * FROM orders').truncated).toBe(false);
  });
```

And in the raw-SQL describe block:

```ts
  it('caps raw-SQL extraction at 20 tables and flags truncation', () => {
    const joins = Array.from({ length: 30 }, (_, i) => `JOIN t${i} ON 1=1`).join(' ');
    const result = extractTablesFromRawSql(`SELECT * FROM t_base ${joins}`);
    expect(result.tables).toHaveLength(20);
    expect(result.truncated).toBe(true);
  });
```

In `test/unit/attributes.test.ts`, add:

```ts
  it('flags table-list truncation on the span', () => {
    const options = normalizeOptions();
    const cq = compile((db) => {
      let qb = db.selectFrom('t0').selectAll();
      for (let i = 1; i < 30; i += 1) {
        qb = qb.innerJoin(`t${i}`, `t${i}.id`, 't0.id') as typeof qb;
      }
      return qb;
    });
    const ctx = createAnalyzer(options)(cq);
    expect(ctx.tablesTruncated).toBe(true);
    const attrs = buildQueryAttributes(ctx, 'postgresql', options);
    expect(attrs['kysely.query.tables_truncated']).toBe(true);

    const { attrs: normal } = attrsFor();
    expect(normal).not.toHaveProperty('kysely.query.tables_truncated');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/tables.test.ts test/unit/attributes.test.ts`
Expected: FAIL — `.tables`/`.truncated` don't exist on `string[]`; `tablesTruncated` unknown.

- [ ] **Step 3: Rework `tables.ts`**

Replace `src/analysis/tables.ts` content (keep `MAX_TABLES`, `TableNodeShape`, `RAW_TABLE` as-is):

```ts
export const MAX_TABLES = 20;

export interface TableExtraction {
  readonly tables: string[];
  /** True when the query referenced more tables than the MAX_TABLES cap. */
  readonly truncated: boolean;
}

interface TableNodeShape {
  kind: 'TableNode';
  table: { schema?: { name: string }; identifier: { name: string } };
}

/**
 * Generic recursive walk over the operation-node tree collecting every
 * TableNode. Walking generically (instead of per-clause) covers joins,
 * subqueries, CTEs and dialect-specific nodes for free.
 */
export function extractTables(node: object): TableExtraction {
  const tables: string[] = [];
  const state = { truncated: false };
  walk(node, tables, new Set<string>(), state);
  return { tables, truncated: state.truncated };
}

function walk(
  value: unknown,
  tables: string[],
  seen: Set<string>,
  state: { truncated: boolean },
): void {
  if (state.truncated || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, tables, seen, state);
    return;
  }
  const node = value as { kind?: string };
  if (node.kind === 'TableNode') {
    const { table } = node as unknown as TableNodeShape;
    const name = table.schema
      ? `${table.schema.name}.${table.identifier.name}`
      : table.identifier.name;
    if (!seen.has(name)) {
      if (tables.length >= MAX_TABLES) {
        state.truncated = true; // a 21st distinct table exists; stop walking
        return;
      }
      seen.add(name);
      tables.push(name);
    }
    return;
  }
  for (const [key, child] of Object.entries(node)) {
    // ReferenceNode.table qualifies a column reference (e.g. `c2.id`) and may
    // carry an alias rather than a base table name — it is not a table
    // location (FROM/JOIN/INTO/UPDATE target), so it must not be collected.
    if (node.kind === 'ReferenceNode' && key === 'table') continue;
    walk(child, tables, seen, state);
  }
}

const RAW_TABLE =
  /\b(?:from|join|into|update)\s+(?:only\s+)?([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)/gi;

/** Best-effort extraction for RawNode queries. */
export function extractTablesFromRawSql(sql: string): TableExtraction {
  const tables: string[] = [];
  const seen = new Set<string>();
  let truncated = false;
  const regex = new RegExp(RAW_TABLE.source, RAW_TABLE.flags);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(sql)) !== null) {
    const name = match[1];
    if (!name || seen.has(name)) continue;
    if (tables.length >= MAX_TABLES) {
      truncated = true;
      break;
    }
    seen.add(name);
    tables.push(name);
  }
  return { tables, truncated };
}
```

(Note the walk-cap behavior changes subtly: previously the walk stopped as soon as 20 tables were *collected*; now it keeps walking until it proves a 21st distinct table exists, then stops. The cost is bounded by AST size and only paid by >20-table queries.)

- [ ] **Step 4: Thread through `analyze.ts`**

In `src/analysis/analyze.ts`, add `tablesTruncated` to `QueryAnalysis`:

```ts
export interface QueryAnalysis {
  readonly operation: string;
  readonly tables: string[];
  readonly tablesTruncated: boolean;
  readonly primaryTable?: string;
  readonly summary: string;
  readonly fingerprint: string;
  readonly hash: string;
  readonly isRaw: boolean;
  readonly sanitizationError: boolean;
  readonly text?: string;
}
```

In `analyzeSql`, replace the tables computation and the return's tables fields:

```ts
  const extraction = options.tables
    ? isRaw
      ? extractTablesFromRawSql(sql)
      : extractTables(query)
    : { tables: [], truncated: false };
  const { tables } = extraction;
  // Frozen so a mutating consumer of ctx.tables cannot corrupt the shared
  // LRU entry returned by reference on every cache hit for this SQL.
  Object.freeze(tables);
```

and in the returned object add, right after `tables,`:

```ts
    tablesTruncated: extraction.truncated,
```

- [ ] **Step 5: Emit the attribute**

`src/otel/attributes.ts` — add the constant next to `ATTR_TABLES`:

```ts
export const ATTR_TABLES_TRUNCATED = 'kysely.query.tables_truncated';
```

In `buildQueryAttributes`, after the `ATTR_TABLES` line:

```ts
  if (options.tables && ctx.tablesTruncated) attrs[ATTR_TABLES_TRUNCATED] = true;
```

`src/index.ts` — add `ATTR_TABLES_TRUNCATED` to the export list (after `ATTR_TABLES`).

- [ ] **Step 6: Fix the metrics test helper**

In `test/unit/metrics.test.ts`, the `ctx()` factory must include the new required field — add `tablesTruncated: false,` alongside `tables: []`.

- [ ] **Step 7: Update the README**

Attributes table — after the `kysely.query.tables` row:

```markdown
| `kysely.query.tables_truncated` | more than 20 tables were referenced | `true`; the `kysely.query.tables` list is capped and not exhaustive for this query. |
```

Also extend the `attributes`-hook `ctx` field list ("`ctx` (`QueryContext`) exposes …") to include `tablesTruncated` after `tables`.

- [ ] **Step 8: Run the full check suite**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add src/analysis/tables.ts src/analysis/analyze.ts src/otel/attributes.ts src/index.ts test/unit/tables.test.ts test/unit/attributes.test.ts test/unit/metrics.test.ts README.md
git commit -m "feat: kysely.query.tables_truncated attribute for capped table lists"
```

---

### Task 14: Point top-level `types` at the CJS declarations (improvement — packaging)

Top-level `main` is the CJS build but `types` points at the ESM declaration file. Legacy (`node10`) TypeScript resolution pairs top-level `types` with `main`, so it should reference `index.d.cts`. The `exports` map (used by modern resolution) is already correct and unchanged.

**Files:**
- Modify: `package.json:9`

**Interfaces:**
- Consumes/Produces: none.

- [ ] **Step 1: Make the change**

In `package.json`, change:

```json
  "types": "./dist/index.d.ts",
```

to:

```json
  "types": "./dist/index.d.cts",
```

- [ ] **Step 2: Verify the referenced file is actually produced**

Run: `pnpm build && ls dist/`
Expected: `index.d.cts` is listed (tsup `dts: true` with `format: ['esm', 'cjs']` emits both `index.d.ts` and `index.d.cts`).

- [ ] **Step 3: Verify packaging resolution**

Run: `npx -y @arethetypeswrong/cli --pack .`
Expected: no errors for the `node10`, `node16 (cjs)`, `node16 (esm)`, and `bundler` resolution modes. (If the tool is unavailable offline, the `ls` check in Step 2 plus `pnpm typecheck` is the fallback verification.)

- [ ] **Step 4: Run the full check suite and commit**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all PASS.

```bash
git add package.json
git commit -m "fix: point legacy types field at the CJS declaration file"
```

---

### Task 15: Final verification sweep

**Files:** none (verification only).

- [ ] **Step 1: Full local suite**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build`
Expected: all PASS, clean build.

- [ ] **Step 2: Integration tests (only if Docker is available)**

Run: `docker info >/dev/null 2>&1 && pnpm test:integration || echo 'Docker unavailable — skipped (CI will run these)'`
Expected: PASS or an explicit skip message. Do not fail the plan on unavailable Docker; the CI integration workflow covers it.

- [ ] **Step 3: Review the diff as a whole**

Run: `git log --oneline main@{u}..HEAD 2>/dev/null || git log --oneline -15` and `git diff main@{u}...HEAD --stat 2>/dev/null || git diff HEAD~14 --stat`
Confirm: 14 commits, each mapping to one task; no stray files (nothing under `.superpowers/` or `dist/` staged).

# Architecture Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Address the verified findings from `docs/architecture-review-2026-07-09.md`: strip SQL comments from sanitized telemetry (finding 1), clamp `maxQueryTextLength` (finding 4), make wrapper idempotency survive dual package copies (finding 6), guard against synchronous `streamQuery` throws (finding 3), and add an opt-out for error-message capture (finding 2, keeping the current default). Finding 5 (quoted identifiers in raw-SQL table extraction) is **deliberately deferred**: it is Low severity, documented best-effort, and the review's claim about `DELETE` targets was factually wrong — `DELETE FROM x` already extracts `x`.

**Architecture:** The comment fix reuses the existing character-level scanner in `src/analysis/sql-text.ts` (the review asked for a new lexer without noticing this one exists): the scanner is parametrized so `maskSqlText` (existing behavior) and a new `stripSqlComments` (comments→spaces, everything else verbatim) share one walk. `fingerprintSql` runs `stripSqlComments` before its regex pipeline. All other fixes are small, local changes with unit/OTel tests.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`), vitest, @opentelemetry/api, Kysely. No new dependencies.

## Global Constraints

- No new runtime or dev dependencies.
- ESM source with `.js` suffixes on relative imports (e.g. `from './sql-text.js'`).
- `exactOptionalPropertyTypes` is on: never assign a possibly-undefined value to an optional property; use the conditional-spread pattern already used in `src/options.ts`.
- Instrumentation must never throw into the app's query path. Config normalization runs at `observeDialect()` time and must **warn and fall back** (via `warnLimited`), not throw.
- Test commands: single file `pnpm exec vitest run <path>`; full gate `pnpm test && pnpm typecheck && pnpm lint && pnpm build`.
- Conventional commit messages matching repo history (`fix:`, `feat:`, `test:`, `docs:`). End every commit message with the `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.
- Do not change the public behavior of `maskSqlText` — `operation.ts` and `tables.ts` depend on its exact space-preserving output.

---

### Task 1: Parametrize the SQL scanner and add `stripSqlComments`

**Files:**
- Modify: `src/analysis/sql-text.ts`
- Test: `test/unit/sql-text.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export function stripSqlComments(sql: string): string` — replaces `--` line comments and `/* */` block comments with an equal number of spaces; copies string literals, quoted identifiers, dollar-quoted strings, and code through **verbatim**. Comment markers inside quoted regions are not treated as comments. Unterminated comments blank to end of input. `maskSqlText(sql: string): string` keeps its exact current behavior.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/sql-text.test.ts` (it already imports from `../../src/analysis/sql-text.js`; extend that import):

```ts
import { maskSqlText, stripSqlComments } from '../../src/analysis/sql-text.js';

describe('stripSqlComments', () => {
  it('blanks line comments but preserves the rest verbatim', () => {
    const out = stripSqlComments('SELECT 1 -- email=alice@example.com\nFROM t');
    expect(out).not.toContain('alice@example.com');
    expect(out.replace(/\s+/g, ' ').trim()).toBe('SELECT 1 FROM t');
    expect(out).toHaveLength('SELECT 1 -- email=alice@example.com\nFROM t'.length);
  });

  it('blanks block comments', () => {
    const out = stripSqlComments('SELECT 1 /* trace=abc123 */ FROM t');
    expect(out).not.toContain('abc123');
    expect(out.replace(/\s+/g, ' ').trim()).toBe('SELECT 1 FROM t');
  });

  it('preserves string literals verbatim, including comment markers inside them', () => {
    expect(stripSqlComments("SELECT '--not a comment' FROM t")).toBe(
      "SELECT '--not a comment' FROM t",
    );
    expect(stripSqlComments("SELECT '/* keep */' FROM t")).toBe("SELECT '/* keep */' FROM t");
  });

  it('preserves quoted identifiers and dollar-quoted strings verbatim', () => {
    expect(stripSqlComments('SELECT "a--b", `c--d`, [e--f] FROM t')).toBe(
      'SELECT "a--b", `c--d`, [e--f] FROM t',
    );
    expect(stripSqlComments('SELECT $tag$ -- inside $tag$ FROM t')).toBe(
      'SELECT $tag$ -- inside $tag$ FROM t',
    );
  });

  it('blanks an unterminated block comment to end of input', () => {
    const out = stripSqlComments('SELECT 1 /* oops');
    expect(out.trimEnd()).toBe('SELECT 1');
    expect(out).toHaveLength('SELECT 1 /* oops'.length);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run test/unit/sql-text.test.ts`
Expected: FAIL — `stripSqlComments` is not exported.

- [ ] **Step 3: Refactor the scanner and implement `stripSqlComments`**

Replace the body of `src/analysis/sql-text.ts` below the `DOLLAR_TAG` constant. Keep the existing file-header doc comment; add one sentence to it: "`stripSqlComments` shares the same scanner but blanks only comments, leaving all quoted content and code verbatim."

```ts
type SqlRegion = 'comment' | 'string' | 'identifier';

export function maskSqlText(sql: string): string {
  return transformSql(sql, () => true);
}

/** Blanks only comments (to spaces, preserving length); strings, quoted
 *  identifiers, and dollar-quoted regions pass through verbatim. Comment
 *  markers inside quoted regions are never treated as comments. */
export function stripSqlComments(sql: string): string {
  return transformSql(sql, (region) => region === 'comment');
}

function transformSql(sql: string, shouldMask: (region: SqlRegion) => boolean): string {
  const out: string[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      i = emit(sql, out, i, sql.indexOf('\n', i + 2), shouldMask('comment'));
    } else if (ch === '/' && next === '*') {
      const close = sql.indexOf('*/', i + 2);
      i = emit(sql, out, i, close === -1 ? -1 : close + 2, shouldMask('comment'));
    } else if (ch === "'") {
      i = emitQuoted(sql, out, i, "'", true, shouldMask('string'));
    } else if (ch === '"') {
      i = emitQuoted(sql, out, i, '"', false, shouldMask('identifier'));
    } else if (ch === '`') {
      i = emitQuoted(sql, out, i, '`', false, shouldMask('identifier'));
    } else if (ch === '[') {
      const close = sql.indexOf(']', i + 1);
      i = emit(sql, out, i, close === -1 ? -1 : close + 1, shouldMask('identifier'));
    } else if (ch === '$') {
      const tag = DOLLAR_TAG.exec(sql.slice(i))?.[0];
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length);
        i = emit(sql, out, i, close === -1 ? -1 : close + tag.length, shouldMask('string'));
      } else {
        out.push(ch);
        i += 1;
      }
    } else {
      out.push(ch);
      i += 1;
    }
  }
  return out.join('');
}

/** Emits [from, to) — or to end of input when `to` is -1 — as spaces when
 *  masking, verbatim otherwise; returns the next scan position. */
function emit(sql: string, out: string[], from: number, to: number, mask: boolean): number {
  const end = to === -1 ? sql.length : to;
  for (let i = from; i < end; i += 1) out.push(mask ? ' ' : sql[i]!);
  return end;
}

/** Scans a quoted region starting at `start` (which holds `quote`), honoring
 *  doubled-quote escapes and, for single quotes, backslash escapes. */
function emitQuoted(
  sql: string,
  out: string[],
  start: number,
  quote: string,
  backslashEscapes: boolean,
  mask: boolean,
): number {
  let i = start + 1;
  while (i < sql.length) {
    const ch = sql[i];
    if (backslashEscapes && ch === '\\') {
      i += 2;
    } else if (ch === quote) {
      if (sql[i + 1] === quote) {
        i += 2; // doubled quote is an escaped quote, not a terminator
      } else {
        return emit(sql, out, start, i + 1, mask);
      }
    } else {
      i += 1;
    }
  }
  return emit(sql, out, start, -1, mask); // unterminated: mask/copy to end
}
```

Delete the old `maskUntil` and `maskQuoted` functions — `emit`/`emitQuoted` replace them.

- [ ] **Step 4: Run the full unit-test file to verify new tests pass and `maskSqlText` regressions didn't appear**

Run: `pnpm exec vitest run test/unit/sql-text.test.ts test/unit/tables.test.ts test/unit/operation.test.ts`
Expected: PASS (all — the existing `maskSqlText`, table-extraction, and operation tests exercise the refactored walker).

- [ ] **Step 5: Commit**

```bash
git add src/analysis/sql-text.ts test/unit/sql-text.test.ts
git commit -m "feat(analysis): add stripSqlComments sharing the maskSqlText scanner"
```

---

### Task 2: Strip comments in `fingerprintSql` (review finding 1)

**Files:**
- Modify: `src/analysis/fingerprint.ts`
- Test: `test/unit/fingerprint.test.ts`, `test/otel/connection.test.ts`

**Interfaces:**
- Consumes: `stripSqlComments(sql: string): string` from Task 1.
- Produces: `fingerprintSql(sql: string): string` — unchanged signature; output now never contains `--` or `/* */` comment content. `db.query.text` (sanitized mode), `db.query.fingerprint`, and `db.query.hash` become comment-invariant automatically via `src/analysis/analyze.ts` (no change needed there).

- [ ] **Step 1: Write the failing unit tests**

Append to `test/unit/fingerprint.test.ts`:

```ts
describe('comment stripping', () => {
  it('removes line comments and their PII content', () => {
    expect(
      fingerprintSql('SELECT * FROM users WHERE id = 1 -- customer_email=alice@example.com'),
    ).toBe('SELECT * FROM users WHERE id = ?');
  });

  it('removes block comments and their content', () => {
    expect(fingerprintSql('SELECT 1 /* trace=abc123, request=xyz */ FROM t')).toBe(
      'SELECT ? FROM t',
    );
  });

  it('produces identical fingerprints regardless of comment content (grouping stability)', () => {
    const a = fingerprintSql('SELECT * FROM t WHERE id = $1 /* req=aaa111 */');
    const b = fingerprintSql('SELECT * FROM t WHERE id = $1 /* req=bbb222 */');
    expect(a).toBe(b);
    expect(a).toBe('SELECT * FROM t WHERE id = ?');
  });

  it('does not treat comment markers inside string literals as comments', () => {
    expect(fingerprintSql("SELECT '--keep', col FROM t")).toBe('SELECT ?, col FROM t');
    expect(fingerprintSql("SELECT '/* keep */', col FROM t")).toBe('SELECT ?, col FROM t');
  });

  it('preserves double-quoted identifiers containing comment markers', () => {
    expect(fingerprintSql('SELECT "a--b" FROM t')).toBe('SELECT "a--b" FROM t');
  });

  it('removes an unterminated block comment to end of input', () => {
    expect(fingerprintSql('SELECT 1 /* oops')).toBe('SELECT ?');
  });

  it('handles comments adjacent to literals', () => {
    expect(fingerprintSql("SELECT 'a'/* tag */ FROM t WHERE x = 1-- trailing")).toBe(
      'SELECT ? FROM t WHERE x = ?',
    );
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm exec vitest run test/unit/fingerprint.test.ts`
Expected: FAIL on the new `comment stripping` describe block; all pre-existing tests PASS.

- [ ] **Step 3: Implement**

In `src/analysis/fingerprint.ts`, add the import and prepend the strip:

```ts
import { stripSqlComments } from './sql-text.js';
```

```ts
export function fingerprintSql(sql: string): string {
  return stripSqlComments(sql)
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

Extend the file-header doc comment with one sentence: "Comments are blanked first via `stripSqlComments` (same scanner as `maskSqlText`), so query-tagging comments (trace/request IDs, sqlcommenter) never reach the fingerprint, sanitized text, or hash."

- [ ] **Step 4: Run unit tests to verify they pass**

Run: `pnpm exec vitest run test/unit/fingerprint.test.ts test/unit/analyze.test.ts test/unit/hash.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing end-to-end span test**

Append to the `describe('ObservedConnection.executeQuery', ...)` block in `test/otel/connection.test.ts`:

```ts
it('NO-PII: comment content never reaches span attributes in sanitized mode', async () => {
  const { connection } = makeConnection();
  const raw = CompiledQuery.raw(
    'SELECT * FROM orders -- customer_email=alice@example.com trace=zzTRACEzz',
    [],
  );
  await connection.executeQuery(raw);

  const span = otel.spanExporter.getFinishedSpans()[0]!;
  const all = JSON.stringify(span.attributes);
  expect(all).not.toContain('alice@example.com');
  expect(all).not.toContain('zzTRACEzz');
  expect(span.attributes['db.query.text']).toBe('SELECT * FROM orders');
});
```

(`CompiledQuery` is already imported in this file.)

- [ ] **Step 6: Run the OTel test file — it should already pass (the unit fix covers it); confirm**

Run: `pnpm exec vitest run test/otel/connection.test.ts`
Expected: PASS. (If it fails, the analyze pipeline is not routing through `fingerprintSql` as expected — investigate before proceeding.)

- [ ] **Step 7: Update README**

In `README.md`, in the Safety model section (around line 272-281), add a bullet after the "Sanitized by default." bullet:

```markdown
- **Comments are stripped.** SQL comments (`--` and `/* … */`) are removed before fingerprinting, so query-tagging comments (trace IDs, request IDs, sqlcommenter-style annotations) never appear in `db.query.text`, `db.query.fingerprint`, or `db.query.hash`, and cannot fragment query grouping.
```

- [ ] **Step 8: Commit**

```bash
git add src/analysis/fingerprint.ts test/unit/fingerprint.test.ts test/otel/connection.test.ts README.md
git commit -m "fix(analysis): strip SQL comments from fingerprints and sanitized query text"
```

---

### Task 3: Validate `maxQueryTextLength` (review finding 4)

**Files:**
- Modify: `src/options.ts`
- Test: `test/unit/options.test.ts`

**Interfaces:**
- Consumes: `warnLimited(context: string)` from `src/otel/spans.js` (runtime-safe import: `spans.ts` only imports types from `options.ts`, so no runtime cycle).
- Produces: `NormalizedOptions.maxQueryTextLength` is always a finite non-negative integer. Invalid input (negative, `NaN`, `±Infinity`) falls back to the default `4096` with a one-time diagnostic warning; fractional values truncate.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/options.test.ts`:

```ts
describe('maxQueryTextLength validation', () => {
  it('accepts valid values, truncating fractions', () => {
    expect(normalizeOptions({ maxQueryTextLength: 0 }).maxQueryTextLength).toBe(0);
    expect(normalizeOptions({ maxQueryTextLength: 100 }).maxQueryTextLength).toBe(100);
    expect(normalizeOptions({ maxQueryTextLength: 1.9 }).maxQueryTextLength).toBe(1);
  });

  it('falls back to the default for negative, NaN, and non-finite values', () => {
    expect(normalizeOptions({ maxQueryTextLength: -1 }).maxQueryTextLength).toBe(4096);
    expect(normalizeOptions({ maxQueryTextLength: Number.NaN }).maxQueryTextLength).toBe(4096);
    expect(normalizeOptions({ maxQueryTextLength: Infinity }).maxQueryTextLength).toBe(4096);
    expect(normalizeOptions({ maxQueryTextLength: -Infinity }).maxQueryTextLength).toBe(4096);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run test/unit/options.test.ts`
Expected: FAIL — `-1` currently passes through as `-1`, `Infinity` as `Infinity`.

- [ ] **Step 3: Implement**

In `src/options.ts`:

```ts
import { warnLimited } from './otel/spans.js';

const DEFAULT_MAX_QUERY_TEXT_LENGTH = 4096;

/** A negative value has surprising String.prototype.slice semantics (-1 keeps
 *  all but the last char) and Infinity removes the cap entirely — both defeat
 *  the intended bound, so invalid input falls back to the default loudly. */
function normalizeMaxQueryTextLength(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_QUERY_TEXT_LENGTH;
  if (!Number.isFinite(value) || value < 0) {
    warnLimited('invalid maxQueryTextLength; using default 4096', value);
    return DEFAULT_MAX_QUERY_TEXT_LENGTH;
  }
  return Math.trunc(value);
}
```

**Constraint:** `warnLimited` context keys MUST be static literals (documented invariant at `src/otel/spans.ts:27-28` — dynamic keys grow the warn-count map unbounded). The rejected value is passed as the second argument, which is logged but never used as a map key.

In `normalizeOptions`, replace:

```ts
maxQueryTextLength: options.maxQueryTextLength ?? 4096,
```

with:

```ts
maxQueryTextLength: normalizeMaxQueryTextLength(options.maxQueryTextLength),
```

Update the JSDoc on `KyselyOtelOptions.maxQueryTextLength` to:

```ts
/** Max chars for db.query.text and db.query.fingerprint. Must be a finite
 *  non-negative number (fractions truncate); invalid values fall back to the
 *  default with a diagnostic warning. Default 4096. */
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run test/unit/options.test.ts`
Expected: PASS.

- [ ] **Step 5: Update README**

In the `README.md` options table, extend the `maxQueryTextLength` row's description with: "Invalid values (negative or non-finite) fall back to the default with a diagnostic warning; fractional values are truncated."

- [ ] **Step 6: Commit**

```bash
git add src/options.ts test/unit/options.test.ts README.md
git commit -m "fix(options): validate maxQueryTextLength, falling back to the default on invalid input"
```

---

### Task 4: Guard synchronous `streamQuery` failures (review finding 3)

**Files:**
- Modify: `src/observed-connection.ts:106-109`
- Test: `test/otel/connection.test.ts`

**Interfaces:**
- Consumes: existing private members `finishFailure(span, ctx, startTime, error)` and the `started` destructuring in `streamQuery`.
- Produces: no API change. A synchronous throw from the inner dialect's `streamQuery` now ends the span with `ERROR` status, records the failure duration metric, and rethrows the original error.

Note: all four built-in Kysely drivers implement `streamQuery` as `async *` generators, which never throw synchronously — this guards third-party dialects that use plain methods, as the `DatabaseConnection` interface permits.

- [ ] **Step 1: Write the failing test**

Append to the `describe('ObservedConnection.streamQuery', ...)` block in `test/otel/connection.test.ts`:

```ts
it('ends the span with error status when the inner streamQuery throws synchronously', async () => {
  const boom = new Error('streaming not supported');
  const { connection, inner } = makeConnection();
  (inner as any).streamQuery = () => {
    throw boom;
  };

  expect(() => connection.streamQuery(SELECT, 1)).toThrow(boom);

  const spans = otel.spanExporter.getFinishedSpans();
  expect(spans).toHaveLength(1);
  expect(spans[0]!.status.code).toBe(SpanStatusCode.ERROR);
  expect(spans[0]!.attributes['error.type']).toBe('Error');

  const metric = await otel.findMetric('db.client.operation.duration');
  expect((metric!.dataPoints[0] as any).attributes['error.type']).toBe('Error');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run test/otel/connection.test.ts`
Expected: FAIL — the error propagates but `getFinishedSpans()` is empty (span leaked open).

- [ ] **Step 3: Implement**

In `src/observed-connection.ts`, replace:

```ts
const inner = context.with(spanContext, () =>
  this.inner.streamQuery<R>(compiledQuery, chunkSize, options),
);
```

with:

```ts
// Built-in dialects use async generators (never throw here), but the
// interface permits a plain method that throws synchronously — without
// this guard that span would leak open, unregistered in #openStreamEnders.
let inner: AsyncIterableIterator<QueryResult<R>>;
try {
  inner = context.with(spanContext, () =>
    this.inner.streamQuery<R>(compiledQuery, chunkSize, options),
  );
} catch (error) {
  this.finishFailure(span, ctx, startTime, error);
  span.end();
  throw error;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run test/otel/connection.test.ts test/otel/driver.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/observed-connection.ts test/otel/connection.test.ts
git commit -m "fix(stream): end the query span when the inner streamQuery throws synchronously"
```

---

### Task 5: Cross-copy idempotency marker (review finding 6)

**Files:**
- Modify: `src/observed-dialect.ts`
- Test: `test/otel/observe-dialect.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `observeDialect` recognizes wrappers from **any** loaded copy of this package (pnpm-linked duplicates, dual ESM/CJS loading) via a `Symbol.for('kysely-opentelemetry.observed')` instance property set to `true` on `ObservedDialect`, checked in addition to `instanceof`.

- [ ] **Step 1: Write the failing test**

Append to `test/otel/observe-dialect.test.ts`:

```ts
it('does not re-wrap a dialect observed by another copy of the package', () => {
  const { dialect } = createFakeDialect();
  // Simulates an ObservedDialect from a second physical copy (pnpm link,
  // dual ESM/CJS load): not instanceof our class, but carrying the marker.
  const foreignWrapper = {
    ...dialect,
    [Symbol.for('kysely-opentelemetry.observed')]: true,
  } as unknown as Dialect;
  expect(observeDialect(foreignWrapper)).toBe(foreignWrapper);
});

it('re-wraps an object whose marker is present but not `true` (defensive validation)', () => {
  const { dialect } = createFakeDialect();
  const bogus = {
    ...dialect,
    [Symbol.for('kysely-opentelemetry.observed')]: 'yes',
  } as unknown as Dialect;
  expect(observeDialect(bogus)).not.toBe(bogus);
});
```

Add `type Dialect` to the existing `kysely` import in that file, and `observeDialect` is already imported.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run test/otel/observe-dialect.test.ts`
Expected: FAIL — the foreign wrapper gets wrapped again (`observeDialect` returns a new `ObservedDialect`).

- [ ] **Step 3: Implement**

In `src/observed-dialect.ts`:

```ts
/** Cross-copy idempotency marker. `instanceof` fails when two physical copies
 *  of this package are loaded (pnpm-linked duplicates, or one app loading
 *  both the ESM and CJS builds); Symbol.for is process-global, so any copy
 *  recognizes any other copy's wrapper. The explicit `unique symbol`
 *  annotation is required for use as a computed class-property key (TS1166). */
const OBSERVED_MARKER: unique symbol = Symbol.for('kysely-opentelemetry.observed');
```

In the `ObservedDialect` class body, add:

```ts
readonly [OBSERVED_MARKER] = true;
```

Replace the first line of `observeDialect`:

```ts
export function observeDialect(dialect: Dialect, options?: KyselyOtelOptions): Dialect {
  if (isObserved(dialect)) return dialect;
  if (!(options?.enabled ?? true)) return dialect;
  return new ObservedDialect(dialect, options);
}

function isObserved(dialect: Dialect): boolean {
  return (
    dialect instanceof ObservedDialect ||
    (dialect as Record<PropertyKey, unknown>)[OBSERVED_MARKER] === true
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run test/otel/observe-dialect.test.ts`
Expected: PASS, including the pre-existing same-copy idempotency test.

- [ ] **Step 5: Commit**

```bash
git add src/observed-dialect.ts test/otel/observe-dialect.test.ts
git commit -m "fix(dialect): recognize wrappers from other package copies via Symbol.for marker"
```

---

### Task 6: `recordErrorMessages` opt-out (review finding 2)

**Files:**
- Modify: `src/options.ts`, `src/otel/spans.ts`
- Test: `test/unit/spans.test.ts`, `test/unit/options.test.ts`

**Interfaces:**
- Consumes: `NormalizedOptions` from Task 3's version of `src/options.ts`.
- Produces: `KyselyOtelOptions.recordErrorMessages?: boolean` (default `true`) and `NormalizedOptions.recordErrorMessages: boolean`. When `false`, `recordError` sets `ERROR` status **without** a message; `error.type` and `recordExceptions` behavior are unchanged. Applies everywhere `recordError` is called (query, stream, and transaction failure paths).

Design note: the default stays `true` — setting the status message from the driver error matches mainstream OTel DB instrumentations. This task only adds the missing off switch for strict data-governance deployments.

- [ ] **Step 1: Write the failing tests**

Append to the `describe('recordError', ...)` block in `test/unit/spans.test.ts`:

```ts
it('omits the status message when recordErrorMessages is false', () => {
  const span = fakeSpan();
  recordError(
    span,
    new Error('value "alice@example.com" violates constraint'),
    normalizeOptions({ recordErrorMessages: false }),
  );
  expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR });
  expect(span.setAttribute).toHaveBeenCalledWith('error.type', 'Error');
});
```

In `test/unit/options.test.ts`, add `recordErrorMessages: true,` to the `toMatchObject` block in the `applies safe defaults` test (next to `recordExceptions: true`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run test/unit/spans.test.ts test/unit/options.test.ts`
Expected: FAIL — `recordErrorMessages` is not a known option; status includes the message.

- [ ] **Step 3: Implement**

In `src/options.ts`, add to `KyselyOtelOptions` (after `recordExceptions`):

```ts
/** Set error.message as the span status message on failure. Default true.
 *  Driver error text can echo a submitted value (e.g. constraint messages);
 *  set false — together with recordExceptions: false — for a strict
 *  no-value-capture posture. */
recordErrorMessages?: boolean;
```

Add to `NormalizedOptions`: `readonly recordErrorMessages: boolean;`

Add to the return of `normalizeOptions` (after `recordExceptions`):

```ts
recordErrorMessages: options.recordErrorMessages ?? true,
```

In `src/otel/spans.ts`, change `recordError`'s `setStatus` call to:

```ts
span.setStatus({
  code: SpanStatusCode.ERROR,
  ...(options.recordErrorMessages &&
    error instanceof Error && { message: error.message }),
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run test/unit/spans.test.ts test/unit/options.test.ts`
Expected: PASS.

- [ ] **Step 5: Update README**

Three edits in `README.md`:

1. Options table — in the `recordExceptions` row, replace the final sentence "The span status `message` is always set to `error.message` regardless of this option." with "Pair with `recordErrorMessages: false` to also suppress the span status message."
2. Options table — add a row directly below `recordExceptions`:

```markdown
| `recordErrorMessages` | `boolean` | `true` | Set the span status `message` to the driver's `error.message` on failure. Driver error text can echo a submitted value; set `false` (with `recordExceptions: false`) for a strict no-value-capture posture. `error.type` is always recorded. |
```

3. Safety model — in the "Driver error messages are a separate channel." bullet, replace "note the span status `message` still carries `error.message` regardless, since there is no toggle to suppress it in v0.1" with "and `recordErrorMessages: false` to suppress the span status message, leaving only `ERROR` status and `error.type`".

- [ ] **Step 6: Commit**

```bash
git add src/options.ts src/otel/spans.ts test/unit/spans.test.ts test/unit/options.test.ts README.md
git commit -m "feat(options): add recordErrorMessages opt-out for span status messages"
```

---

### Task 7: Full verification and review-document disposition

**Files:**
- Modify: `docs/architecture-review-2026-07-09.md`

**Interfaces:**
- Consumes: all prior tasks committed.
- Produces: a green full quality gate and a disposition record in the review document.

- [ ] **Step 1: Run the full quality gate**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build`
Expected: all PASS (162+ tests — the baseline 162 plus the ~17 added by Tasks 1-6).

- [ ] **Step 2: Append a disposition section to the review document**

Append to `docs/architecture-review-2026-07-09.md`:

```markdown
## Disposition (2026-07-09)

| Finding | Outcome |
|---------|---------|
| 1 (comments in sanitized text) | Fixed — `fingerprintSql` strips comments via the pre-existing `sql-text.ts` scanner (no new lexer was needed). |
| 2 (error messages exported) | Default kept (matches mainstream OTel DB instrumentations); added `recordErrorMessages: false` opt-out. |
| 3 (sync streamQuery throw) | Fixed — inner iterator creation wrapped; note all built-in Kysely drivers are async generators, so this only affected third-party dialects. |
| 4 (maxQueryTextLength) | Fixed — invalid values fall back to the default with a diagnostic warning. |
| 5 (raw-SQL quoted identifiers) | Deferred — Low severity, documented best-effort. Correction: `DELETE FROM x` **is** extracted (the regex matches `from`); only TRUNCATE/CREATE/ALTER/DROP targets are missed. |
| 6 (instanceof idempotency) | Fixed — `Symbol.for('kysely-opentelemetry.observed')` marker recognized across package copies. |
```

- [ ] **Step 3: Commit**

```bash
git add docs/architecture-review-2026-07-09.md
git commit -m "docs: record disposition of architecture-review findings"
```

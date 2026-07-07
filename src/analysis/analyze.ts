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
  readonly tablesTruncated: boolean;
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

/** SQL longer than this is analyzed but not cached: 10k huge keys would be a
 *  real memory sink, and re-analysis cost is proportional to the string. */
const MAX_CACHED_SQL_LENGTH = 32_768;

/** Hard memory ceiling for the cache, independent of entry count. The count
 *  limit alone permits ~400MB worst case (10k entries near the per-entry cap);
 *  this bounds it honestly. Typical workloads stay well under it and are
 *  governed by CACHE_SIZE. */
const CACHE_MAX_BYTES = 16 * 1024 * 1024;

/** Approximate retained bytes for a cache entry. JS strings are UTF-16, so
 *  ~2 bytes per code unit; exact accounting is unnecessary for a memory bound. */
function analysisBytes(key: string, a: QueryAnalysis): number {
  let units =
    key.length + a.operation.length + a.summary.length + a.fingerprint.length + a.hash.length;
  if (a.text !== undefined) units += a.text.length;
  for (const table of a.tables) units += table.length;
  return units * 2;
}

/**
 * Builds an Analyzer that caches the sql-derived parts of a QueryContext
 * (everything except per-call parameters) in a bounded LRU keyed by the
 * query kind plus compiled sql. Identical query shapes with different bind
 * values hit the cache and only pay for re-attaching `parameters`; SQL over
 * MAX_CACHED_SQL_LENGTH is analyzed but not cached, to bound memory.
 */
export function createAnalyzer(options: NormalizedOptions): Analyzer {
  const cache = new LruCache<string, QueryAnalysis>(CACHE_SIZE, {
    maxBytes: CACHE_MAX_BYTES,
    sizeOf: analysisBytes,
  });
  return (compiledQuery) => {
    // Key on kind + sql: a raw query and a builder query can compile to the
    // identical SQL string yet analyze differently (isRaw, table extraction).
    const key = `${compiledQuery.query.kind}\0${compiledQuery.sql}`;
    let analysis = cache.get(key);
    if (!analysis) {
      analysis = analyzeSql(compiledQuery, options);
      if (compiledQuery.sql.length <= MAX_CACHED_SQL_LENGTH) cache.set(key, analysis);
    }
    return { ...analysis, sql: compiledQuery.sql, parameters: compiledQuery.parameters };
  };
}

function analyzeSql(compiledQuery: CompiledQuery, options: NormalizedOptions): QueryAnalysis {
  const { sql, query } = compiledQuery;
  const isRaw = query.kind === 'RawNode';
  const operation = operationName(query, sql);
  const extraction = options.tables
    ? isRaw
      ? extractTablesFromRawSql(sql)
      : extractTables(query)
    : { tables: [], truncated: false };
  const { tables } = extraction;
  // Frozen so a mutating consumer of ctx.tables cannot corrupt the shared
  // LRU entry returned by reference on every cache hit for this SQL.
  Object.freeze(tables);
  const summary = summarize(operation, tables);

  let fingerprint = '';
  let hash = '';
  let sanitizationError = false;
  if (options.fingerprint || options.hash || options.queryText === 'sanitized') {
    try {
      const full = fingerprintSql(sql);
      // Hash the UNtruncated fingerprint: truncating first would collide two
      // distinct queries that share a prefix under a small maxQueryTextLength.
      if (options.hash) hash = hashFingerprint(full);
      fingerprint = full.slice(0, options.maxQueryTextLength);
    } catch {
      sanitizationError = true;
    }
  }
  const text = buildQueryText(sql, fingerprint, sanitizationError, options);

  return {
    operation,
    tables,
    tablesTruncated: extraction.truncated,
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
      // Re-truncate: a redact hook may lengthen the string past the cap.
      text = options.redact(text).slice(0, options.maxQueryTextLength);
    } catch {
      return undefined; // safe failure: omit rather than risk leaking
    }
  }
  return text;
}

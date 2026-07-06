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

/**
 * Builds an Analyzer that caches the sql-derived parts of a QueryContext
 * (everything except per-call parameters) in a bounded LRU keyed by the
 * compiled sql string. Identical query shapes with different bind values
 * hit the cache and only pay for re-attaching `parameters`.
 */
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

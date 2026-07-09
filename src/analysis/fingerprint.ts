/**
 * Regex-based SQL normalization. Kysely parameterizes all builder values,
 * so literal scrubbing here is defense-in-depth for sql.raw / sql.lit
 * fragments. Order matters: strings before placeholders before numbers
 * ($1 must not be half-eaten by the numeric rule).
 *
 * Comments are blanked first via `stripSqlComments` (same scanner as `maskSqlText`),
 * so query-tagging comments (trace/request IDs, sqlcommenter) never reach the
 * fingerprint, sanitized text, or hash.
 */
// Double-quoted text is intentionally NOT scrubbed: in Postgres/SQLite it
// delimits identifiers (e.g. "orders"), and scrubbing would corrupt the
// fingerprint and table extraction. Values must reach us as bind parameters
// (Kysely's default) or single-quoted literals; a MySQL "..."-quoted string
// literal in hand-written raw SQL is a known, documented limitation.
//
// SINGLE_QUOTED handles both SQL-standard '' doubling and backslash escapes
// (\'), which MySQL supports. The character class excludes backslash so each
// input char matches exactly one alternation branch — an ambiguous branch
// (where a lone backslash could match both \\. and the catch-all) causes
// catastrophic backtracking (ReDoS) on unterminated quotes.
//
// The mirror-image caveat: \' is treated as an escaped quote (MySQL
// semantics), but in Postgres's default standard_conforming_strings mode a
// backslash is a literal character, so a raw-SQL literal ending in a
// backslash ('C:\') makes the scrubber over-consume into the next literal
// and corrupt that query's fingerprint. Builder queries are unaffected
// (values are always bind parameters). Pinned in fingerprint.test.ts.

import { stripSqlComments } from './sql-text.js';

const DOLLAR_QUOTED = /\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g;
const SINGLE_QUOTED = /'(?:[^'\\]|\\.|'')*'/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX = /\b0x[0-9a-f]+\b/gi;
const PLACEHOLDER = /\$\d+|@p\d+\b/gi;
const NUMBER = /\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/gi;
const IN_LIST = /\bIN\s*\(\s*\?(?:\s*,\s*\?)*\s*\)/gi;
const WHITESPACE = /\s+/g;

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

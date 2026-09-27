/**
 * SQL normalization. Kysely parameterizes all builder values, so literal
 * scrubbing here is defense-in-depth for sql.raw / sql.lit fragments.
 *
 * Comments and string literals are handled first by `scrubSqlText` — the
 * same dialect-aware scanner as `maskSqlText` — so query-tagging comments
 * (trace/request IDs, sqlcommenter) never reach the fingerprint, sanitized
 * text, or hash, and a literal's end is placed by the database's own rules
 * (Postgres 'C:\' is complete; MySQL 'it\'s' is one literal). One scanner
 * means comment and literal boundaries can never disagree. The regexes below
 * then only see code. Order matters: placeholders before numbers ($1 must
 * not be half-eaten by the numeric rule).
 */
// Double-quoted text is intentionally NOT scrubbed: in Postgres/SQLite it
// delimits identifiers (e.g. "orders"), and scrubbing would corrupt the
// fingerprint and table extraction. Values must reach us as bind parameters
// (Kysely's default) or single-quoted literals; a MySQL "..."-quoted string
// literal in hand-written raw SQL is a known, documented limitation.

import { LEXICONS, type SqlLexicon } from './lexicon.js';
import { scrubSqlText } from './sql-text.js';

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX = /\b0x[0-9a-f]+\b/gi;
const PLACEHOLDER = /\$\d+|@p\d+\b/gi;
const NUMBER = /\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/gi;
const IN_LIST = /\bIN\s*\(\s*\?(?:\s*,\s*\?)*\s*\)/gi;
const WHITESPACE = /\s+/g;

export function fingerprintSql(sql: string, lexicon: SqlLexicon = LEXICONS.unknown): string {
  return scrubSqlText(sql, lexicon)
    .replace(UUID, '?')
    .replace(HEX, '?')
    .replace(PLACEHOLDER, '?')
    .replace(NUMBER, '?')
    .replace(IN_LIST, 'IN (?)')
    .replace(WHITESPACE, ' ')
    .trim();
}

/**
 * Regex-based SQL normalization. Kysely parameterizes all builder values,
 * so literal scrubbing here is defense-in-depth for sql.raw / sql.lit
 * fragments. Order matters: strings before placeholders before numbers
 * ($1 must not be half-eaten by the numeric rule).
 */
const DOLLAR_QUOTED = /\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g;
const SINGLE_QUOTED = /'(?:''|[^'])*'/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX = /\b0x[0-9a-f]+\b/gi;
const PLACEHOLDER = /\$\d+|@p\d+\b/gi;
const NUMBER = /\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/gi;
const IN_LIST = /\bIN\s*\(\s*\?(?:\s*,\s*\?)*\s*\)/gi;
const WHITESPACE = /\s+/g;

export function fingerprintSql(sql: string): string {
  return sql
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

import type { RootOperationNode } from 'kysely';
import { maskSqlText } from './sql-text.js';

// Includes underscores/digits so an identifier-led raw statement (e.g. a
// call to `with_helper_refresh()`) is named by its full token instead of
// being truncated to a prefix that collides with the WITH keyword.
const FIRST_KEYWORD = /[A-Za-z_][A-Za-z0-9_]*/;
const MAIN_VERBS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE']);

/**
 * 'SelectQueryNode' → 'SELECT', 'CreateTableNode' → 'CREATE TABLE'.
 * RawNode → first keyword of the SQL text (comments masked out), or 'SQL'
 * when none.
 */
export function operationName(node: RootOperationNode, sql: string): string {
  if (node.kind === 'RawNode') {
    const masked = maskSqlText(sql);
    const keyword = FIRST_KEYWORD.exec(masked)?.[0]?.toUpperCase();
    if (!keyword) return 'SQL';
    return keyword === 'WITH' ? mainVerbAfterCte(masked) : keyword;
  }
  return node.kind
    .replace(/(Query)?Node$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toUpperCase();
}

/**
 * A raw `WITH ...` query's real operation is the statement after the CTE
 * list, not the literal first keyword. On masked SQL (comments, strings, and
 * quoted identifiers already blanked by maskSqlText) CTE bodies are exactly
 * the parenthesized regions, so the first DML verb at paren-depth 0 is the
 * main statement's. Falls back to 'WITH' when no outer verb is found.
 */
function mainVerbAfterCte(masked: string): string {
  const tokens = /[()]|[A-Za-z_][A-Za-z0-9_]*/g;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = tokens.exec(masked)) !== null) {
    const token = match[0];
    if (token === '(') {
      depth += 1;
    } else if (token === ')') {
      if (depth > 0) depth -= 1;
    } else if (depth === 0 && MAIN_VERBS.has(token.toUpperCase())) {
      return token.toUpperCase();
    }
  }
  return 'WITH';
}

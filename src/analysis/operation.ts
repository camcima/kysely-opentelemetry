import type { RootOperationNode } from 'kysely';

const FIRST_KEYWORD = /[A-Za-z]+/;

/**
 * 'SelectQueryNode' → 'SELECT', 'CreateTableNode' → 'CREATE TABLE'.
 * RawNode → first keyword of the SQL text, or 'SQL' when none.
 */
export function operationName(node: RootOperationNode, sql: string): string {
  if (node.kind === 'RawNode') {
    const keyword = FIRST_KEYWORD.exec(sql)?.[0];
    return keyword ? keyword.toUpperCase() : 'SQL';
  }
  return node.kind
    .replace(/(Query)?Node$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toUpperCase();
}

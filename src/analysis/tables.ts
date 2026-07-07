import { maskSqlText } from './sql-text.js';

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

/** `alias AS (` / `alias (cols) AS [NOT] [MATERIALIZED] (` — a CTE definition. */
const CTE_ALIAS =
  /\b([A-Za-z_][\w$]*)\s*(?:\([^()]*\))?\s+as\s+(?:not\s+)?(?:materialized\s+)?\(/gi;

/**
 * Best-effort extraction for RawNode queries, on masked SQL so table-like
 * words inside comments and string literals are never matched. CTE aliases
 * are excluded (they are not real tables), and tables referenced by the main
 * statement (paren-depth 0) are ordered before tables that only appear
 * inside CTE bodies/subqueries — so `primaryTable`/`db.collection.name`
 * agrees with the operation verb for `WITH ... INSERT INTO target ...`.
 */
export function extractTablesFromRawSql(sql: string): TableExtraction {
  const masked = maskSqlText(sql);
  const aliases = collectCteAliases(masked);
  const topLevel: string[] = [];
  const nested: string[] = [];
  const seen = new Map<string, number>(); // name → paren depth of first sighting
  const regex = new RegExp(RAW_TABLE.source, RAW_TABLE.flags);
  let pos = 0;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(masked)) !== null) {
    for (; pos < match.index; pos += 1) {
      const ch = masked[pos];
      if (ch === '(') depth += 1;
      else if (ch === ')' && depth > 0) depth -= 1;
    }
    const name = match[1];
    if (!name || aliases.has(name.toLowerCase())) continue;
    const seenDepth = seen.get(name);
    if (seenDepth === undefined) {
      seen.set(name, depth);
      (depth === 0 ? topLevel : nested).push(name);
    } else if (depth === 0 && seenDepth > 0) {
      // First sighting was inside a CTE body; a depth-0 reference promotes it.
      nested.splice(nested.indexOf(name), 1);
      topLevel.push(name);
      seen.set(name, 0);
    }
  }
  const all = [...topLevel, ...nested];
  return { tables: all.slice(0, MAX_TABLES), truncated: all.length > MAX_TABLES };
}

/** CTE alias names of a masked `WITH ...` query, lowercased; empty otherwise. */
function collectCteAliases(masked: string): Set<string> {
  const aliases = new Set<string>();
  if (!/^\s*with\b/i.test(masked)) return aliases;
  const regex = new RegExp(CTE_ALIAS.source, CTE_ALIAS.flags);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(masked)) !== null) aliases.add(match[1]!.toLowerCase());
  return aliases;
}

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

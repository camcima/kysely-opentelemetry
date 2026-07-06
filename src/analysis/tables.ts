export const MAX_TABLES = 20;

interface TableNodeShape {
  kind: 'TableNode';
  table: { schema?: { name: string }; identifier: { name: string } };
}

/**
 * Generic recursive walk over the operation-node tree collecting every
 * TableNode. Walking generically (instead of per-clause) covers joins,
 * subqueries, CTEs and dialect-specific nodes for free.
 */
export function extractTables(node: object): string[] {
  const tables: string[] = [];
  walk(node, tables, new Set<string>());
  return tables;
}

function walk(value: unknown, tables: string[], seen: Set<string>): void {
  if (tables.length >= MAX_TABLES || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, tables, seen);
    return;
  }
  const node = value as { kind?: string };
  if (node.kind === 'TableNode') {
    const { table } = node as unknown as TableNodeShape;
    const name = table.schema
      ? `${table.schema.name}.${table.identifier.name}`
      : table.identifier.name;
    if (!seen.has(name)) {
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
    walk(child, tables, seen);
  }
}

const RAW_TABLE =
  /\b(?:from|join|into|update)\s+(?:only\s+)?([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)/gi;

/** Best-effort extraction for RawNode queries. */
export function extractTablesFromRawSql(sql: string): string[] {
  const tables: string[] = [];
  const seen = new Set<string>();
  const regex = new RegExp(RAW_TABLE.source, RAW_TABLE.flags);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(sql)) !== null && tables.length < MAX_TABLES) {
    const name = match[1];
    if (name && !seen.has(name)) {
      seen.add(name);
      tables.push(name);
    }
  }
  return tables;
}

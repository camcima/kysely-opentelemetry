/**
 * Replaces SQL comments, string literals, and quoted identifiers with spaces,
 * preserving length and the position of every unmasked character, so
 * downstream scanners (verb detection, table extraction, paren-depth
 * tracking) can run plain regexes over the result without being fooled by
 * quoted or commented content.
 *
 * Masked constructs: `-- line` comments, slash-star block comments
 * (non-nested), `'...'` string literals (`''` doubling and `\'` escapes),
 * `"..."` and
 * `` `...` `` quoted identifiers, `[...]` bracket identifiers, and
 * `$tag$...$tag$` dollar-quoted strings. An unterminated construct is always
 * blanked to the end of the input — conservative and fail-closed: better to
 * see less than to misread (or leak) whatever follows.
 *
 * `stripSqlComments` shares the same scanner but blanks only comments,
 * leaving all *terminated* quoted content and code verbatim.
 * `maskSqlTextUnquotingIdentifiers` blanks comments and strings but replaces
 * a quoted identifier holding one simple name with that bare name (dropping
 * the quotes), so the raw-SQL table scanner can see `FROM "orders"`; it does
 * NOT preserve length. Unterminated regions are blanked to end of input in
 * every mode, so a comment (or anything else) trailing an unterminated
 * string, identifier, or dollar-quote can never leak through.
 */
const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

/** One bare SQL name: what a quoted identifier must contain to be unquoted. */
const SIMPLE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/** Names that, emitted bare, could fabricate a table-clause anchor for the
 *  raw-SQL table scanner (`SELECT "join" x FROM t` must not read as a JOIN).
 *  Identifiers with these names stay blanked instead of unquoted. */
const TABLE_CLAUSE_KEYWORDS = new Set(['from', 'join', 'into', 'update', 'only', 'truncate']);

type SqlRegion = 'comment' | 'string' | 'identifier';

type RegionAction = 'blank' | 'keep' | 'unquote';

export function maskSqlText(sql: string): string {
  return transformSql(sql, () => 'blank');
}

/** Blanks only comments (to spaces, preserving length); terminated strings,
 *  quoted identifiers, and dollar-quoted regions pass through verbatim.
 *  Comment markers inside quoted regions are never treated as comments. An
 *  unterminated string, identifier, or dollar-quote is blanked to end of
 *  input (fail-closed), so any trailing content — including what looks like
 *  a comment — can never leak through. */
export function stripSqlComments(sql: string): string {
  return transformSql(sql, (region) => (region === 'comment' ? 'blank' : 'keep'));
}

/** Like maskSqlText, but a quoted identifier containing one simple,
 *  non-keyword name is replaced by that bare name (quotes dropped) so the
 *  raw-SQL table scanner can extract `FROM "orders"`. Any other identifier
 *  content becomes a `?` sentinel (non-whitespace, so a scanner's \s+ can
 *  never bridge the gap to the next keyword). Output length is NOT
 *  preserved; callers must scan the transformed string only, never map
 *  positions back. */
export function maskSqlTextUnquotingIdentifiers(sql: string): string {
  return transformSql(sql, (region) => (region === 'identifier' ? 'unquote' : 'blank'));
}

function transformSql(sql: string, actionFor: (region: SqlRegion) => RegionAction): string {
  const out: string[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      i = emit(sql, out, i, sql.indexOf('\n', i + 2), actionFor('comment'));
    } else if (ch === '/' && next === '*') {
      const close = sql.indexOf('*/', i + 2);
      i = emit(sql, out, i, close === -1 ? -1 : close + 2, actionFor('comment'));
    } else if (ch === "'") {
      i = emitQuoted(sql, out, i, "'", true, actionFor('string'));
    } else if (ch === '"') {
      i = emitQuoted(sql, out, i, '"', false, actionFor('identifier'));
    } else if (ch === '`') {
      i = emitQuoted(sql, out, i, '`', false, actionFor('identifier'));
    } else if (ch === '[') {
      const close = sql.indexOf(']', i + 1);
      i = emit(sql, out, i, close === -1 ? -1 : close + 1, actionFor('identifier'));
    } else if (ch === '$') {
      const tag = DOLLAR_TAG.exec(sql.slice(i))?.[0];
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length);
        i = emit(sql, out, i, close === -1 ? -1 : close + tag.length, actionFor('string'));
      } else {
        out.push(ch);
        i += 1;
      }
    } else {
      out.push(ch);
      i += 1;
    }
  }
  return out.join('');
}

/** Emits [from, to) — or to end of input when `to` is -1 — according to
 *  `action`; returns the next scan position. An unterminated region
 *  (`to === -1`) is always blanked regardless of the action (fail closed) so
 *  a comment/PII trailing an unterminated string, identifier, or
 *  dollar-quote can never leak through a verbatim-copy or unquote path.
 *  'unquote' assumes single-character delimiters on both ends, which holds
 *  for every region routed to it (quote pairs and brackets — never comments
 *  or dollar-quotes). */
function emit(sql: string, out: string[], from: number, to: number, action: RegionAction): number {
  const end = to === -1 ? sql.length : to;
  if (to === -1 || action === 'blank') {
    for (let i = from; i < end; i += 1) out.push(' ');
  } else if (action === 'keep') {
    for (let i = from; i < end; i += 1) out.push(sql[i]!);
  } else {
    const content = sql.slice(from + 1, end - 1);
    if (SIMPLE_IDENTIFIER.test(content) && !TABLE_CLAUSE_KEYWORDS.has(content.toLowerCase())) {
      out.push(content);
    } else {
      // A non-whitespace, non-word sentinel: a blank here would let a
      // scanner's \s+ bridge the gap and misread the NEXT token as a table
      // name (`FROM "my table" WHERE` must not extract WHERE).
      out.push('?');
    }
  }
  return end;
}

/** Scans a quoted region starting at `start` (which holds `quote`), honoring
 *  doubled-quote escapes and, for single quotes, backslash escapes. */
function emitQuoted(
  sql: string,
  out: string[],
  start: number,
  quote: string,
  backslashEscapes: boolean,
  action: RegionAction,
): number {
  let i = start + 1;
  while (i < sql.length) {
    const ch = sql[i];
    if (backslashEscapes && ch === '\\') {
      i += 2;
    } else if (ch === quote) {
      if (sql[i + 1] === quote) {
        i += 2; // doubled quote is an escaped quote, not a terminator
      } else {
        return emit(sql, out, start, i + 1, action);
      }
    } else {
      i += 1;
    }
  }
  return emit(sql, out, start, -1, action); // unterminated: blank to end
}

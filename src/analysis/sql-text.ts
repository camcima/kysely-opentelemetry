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
 * `$tag$...$tag$` dollar-quoted strings. An unterminated construct masks to
 * the end of the input — conservative: better to see less than to misread.
 *
 * `stripSqlComments` shares the same scanner but blanks only comments,
 * leaving all quoted content and code verbatim.
 */
const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

type SqlRegion = 'comment' | 'string' | 'identifier';

export function maskSqlText(sql: string): string {
  return transformSql(sql, () => true);
}

/** Blanks only comments (to spaces, preserving length); strings, quoted
 *  identifiers, and dollar-quoted regions pass through verbatim. Comment
 *  markers inside quoted regions are never treated as comments. */
export function stripSqlComments(sql: string): string {
  return transformSql(sql, (region) => region === 'comment');
}

function transformSql(sql: string, shouldMask: (region: SqlRegion) => boolean): string {
  const out: string[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      i = emit(sql, out, i, sql.indexOf('\n', i + 2), shouldMask('comment'));
    } else if (ch === '/' && next === '*') {
      const close = sql.indexOf('*/', i + 2);
      i = emit(sql, out, i, close === -1 ? -1 : close + 2, shouldMask('comment'));
    } else if (ch === "'") {
      i = emitQuoted(sql, out, i, "'", true, shouldMask('string'));
    } else if (ch === '"') {
      i = emitQuoted(sql, out, i, '"', false, shouldMask('identifier'));
    } else if (ch === '`') {
      i = emitQuoted(sql, out, i, '`', false, shouldMask('identifier'));
    } else if (ch === '[') {
      const close = sql.indexOf(']', i + 1);
      i = emit(sql, out, i, close === -1 ? -1 : close + 1, shouldMask('identifier'));
    } else if (ch === '$') {
      const tag = DOLLAR_TAG.exec(sql.slice(i))?.[0];
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length);
        i = emit(sql, out, i, close === -1 ? -1 : close + tag.length, shouldMask('string'));
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

/** Emits [from, to) — or to end of input when `to` is -1 — as spaces when
 *  masking, verbatim otherwise; returns the next scan position. */
function emit(sql: string, out: string[], from: number, to: number, mask: boolean): number {
  const end = to === -1 ? sql.length : to;
  for (let i = from; i < end; i += 1) out.push(mask ? ' ' : sql[i]!);
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
  mask: boolean,
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
        return emit(sql, out, start, i + 1, mask);
      }
    } else {
      i += 1;
    }
  }
  return emit(sql, out, start, -1, mask); // unterminated: mask/copy to end
}

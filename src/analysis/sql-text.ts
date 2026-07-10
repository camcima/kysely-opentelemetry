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
 * leaving all *terminated* quoted content and code verbatim. Unterminated
 * regions are blanked to end of input regardless, the same as `maskSqlText`,
 * so a comment (or anything else) trailing an unterminated string,
 * identifier, or dollar-quote can never leak through.
 */
const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

type SqlRegion = 'comment' | 'string' | 'identifier';

export function maskSqlText(sql: string): string {
  return transformSql(sql, () => true);
}

/** Blanks only comments (to spaces, preserving length); terminated strings,
 *  quoted identifiers, and dollar-quoted regions pass through verbatim.
 *  Comment markers inside quoted regions are never treated as comments. An
 *  unterminated string, identifier, or dollar-quote is blanked to end of
 *  input (fail-closed), so any trailing content — including what looks like
 *  a comment — can never leak through. */
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
 *  masking, verbatim otherwise; returns the next scan position. An
 *  unterminated region (`to === -1`) is always blanked regardless of the
 *  caller's mask decision (fail closed) so a comment/PII trailing an
 *  unterminated string, identifier, or dollar-quote can never leak through
 *  `stripSqlComments`'s verbatim-copy path. */
function emit(sql: string, out: string[], from: number, to: number, mask: boolean): number {
  const end = to === -1 ? sql.length : to;
  const blank = mask || to === -1;
  for (let i = from; i < end; i += 1) out.push(blank ? ' ' : sql[i]!);
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

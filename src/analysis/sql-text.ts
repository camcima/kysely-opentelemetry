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
 */
const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

export function maskSqlText(sql: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      i = maskUntil(sql, out, i, sql.indexOf('\n', i + 2));
    } else if (ch === '/' && next === '*') {
      const close = sql.indexOf('*/', i + 2);
      i = maskUntil(sql, out, i, close === -1 ? -1 : close + 2);
    } else if (ch === "'") {
      i = maskQuoted(sql, out, i, "'", true);
    } else if (ch === '"') {
      i = maskQuoted(sql, out, i, '"', false);
    } else if (ch === '`') {
      i = maskQuoted(sql, out, i, '`', false);
    } else if (ch === '[') {
      const close = sql.indexOf(']', i + 1);
      i = maskUntil(sql, out, i, close === -1 ? -1 : close + 1);
    } else if (ch === '$') {
      const tag = DOLLAR_TAG.exec(sql.slice(i))?.[0];
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length);
        i = maskUntil(sql, out, i, close === -1 ? -1 : close + tag.length);
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

/** Pushes spaces for [from, to) — or to end of input when `to` is -1 — and
 *  returns the next scan position. */
function maskUntil(sql: string, out: string[], from: number, to: number): number {
  const end = to === -1 ? sql.length : to;
  for (let i = from; i < end; i += 1) out.push(' ');
  return end;
}

/** Masks a quoted region starting at `start` (which holds `quote`), honoring
 *  doubled-quote escapes and, for single quotes, backslash escapes. */
function maskQuoted(
  sql: string,
  out: string[],
  start: number,
  quote: string,
  backslashEscapes: boolean,
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
        return maskUntil(sql, out, start, i + 1);
      }
    } else {
      i += 1;
    }
  }
  return maskUntil(sql, out, start, -1); // unterminated: mask to end
}

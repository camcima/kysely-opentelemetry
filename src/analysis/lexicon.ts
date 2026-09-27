/**
 * Per-database lexical rules for the SQL text scanner. Getting these wrong
 * is a privacy bug, not a cosmetic one: a scanner that misplaces a string
 * literal's end reads the NEXT literal's contents as code and emits them in
 * the fingerprint and sanitized text.
 */
export interface SqlLexicon {
  /**
   * What a backslash inside a single-quoted string does:
   * - `escape`: always escapes the next character (MySQL default).
   * - `literal`: never special ('C:\' is a complete string).
   * - `e-strings`: escapes only inside `E'...'` strings; ordinary strings
   *   are literal (Postgres with standard_conforming_strings = on, the
   *   default since 9.1 and what Kysely's Postgres compiler assumes).
   * - `ambiguous`: the dialect is unknown, so the literal's end cannot be
   *   placed safely; the scanner blanks to end of input (fail closed).
   */
  readonly backslash: 'escape' | 'literal' | 'e-strings' | 'ambiguous';
  /** Block comments nest (`/* a /* b *\/ still comment *\/`). */
  readonly nestedBlockComments: boolean;
  /** `#` starts a line comment (MySQL). Elsewhere it is an operator or a
   *  temp-table prefix, so it must not be stripped. */
  readonly hashComments: boolean;
}

export const LEXICONS = {
  postgresql: { backslash: 'e-strings', nestedBlockComments: true, hashComments: false },
  mysql: { backslash: 'escape', nestedBlockComments: false, hashComments: true },
  sqlite: { backslash: 'literal', nestedBlockComments: false, hashComments: false },
  mssql: { backslash: 'literal', nestedBlockComments: true, hashComments: false },
  /** Fail closed on every axis: each choice can only blank more text. */
  unknown: { backslash: 'ambiguous', nestedBlockComments: true, hashComments: true },
} as const satisfies Record<string, SqlLexicon>;

const BY_DB_SYSTEM: Readonly<Record<string, SqlLexicon>> = {
  postgresql: LEXICONS.postgresql,
  mysql: LEXICONS.mysql,
  mariadb: LEXICONS.mysql,
  sqlite: LEXICONS.sqlite,
  'microsoft.sql_server': LEXICONS.mssql,
};

/** Lexical rules for an OTel `db.system.name`; unknown systems fail closed. */
export function lexiconFor(dbSystem: string): SqlLexicon {
  return Object.hasOwn(BY_DB_SYSTEM, dbSystem) ? BY_DB_SYSTEM[dbSystem]! : LEXICONS.unknown;
}

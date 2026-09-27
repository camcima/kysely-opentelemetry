import { describe, expect, it } from 'vitest';
import { LEXICONS, lexiconFor } from '../../src/analysis/lexicon.js';

describe('lexiconFor', () => {
  it('maps each detected db.system.name to its lexical rules', () => {
    expect(lexiconFor('postgresql')).toBe(LEXICONS.postgresql);
    expect(lexiconFor('mysql')).toBe(LEXICONS.mysql);
    expect(lexiconFor('mariadb')).toBe(LEXICONS.mysql);
    expect(lexiconFor('sqlite')).toBe(LEXICONS.sqlite);
    expect(lexiconFor('microsoft.sql_server')).toBe(LEXICONS.mssql);
  });

  it('falls back to the fail-closed unknown lexicon', () => {
    expect(lexiconFor('other_sql')).toBe(LEXICONS.unknown);
    expect(lexiconFor('cockroachdb')).toBe(LEXICONS.unknown);
  });
});

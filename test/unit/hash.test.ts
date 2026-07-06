import { describe, expect, it } from 'vitest';
import { hashFingerprint } from '../../src/analysis/hash.js';

describe('hashFingerprint', () => {
  it('returns the first 16 hex chars of sha256', () => {
    // sha256('') = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    expect(hashFingerprint('')).toBe('e3b0c44298fc1c14');
  });

  it('is deterministic and 16 chars', () => {
    const a = hashFingerprint('SELECT * FROM orders WHERE id = ?');
    expect(a).toBe(hashFingerprint('SELECT * FROM orders WHERE id = ?'));
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('differs for different fingerprints', () => {
    expect(hashFingerprint('SELECT a')).not.toBe(hashFingerprint('SELECT b'));
  });
});

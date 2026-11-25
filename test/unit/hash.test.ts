import { describe, expect, it } from 'vitest';
import { hashFingerprint } from '../../src/analysis/hash.js';

describe('hashFingerprint', () => {
  // Known-answer tests against the published FNV-1a 64-bit reference vectors.
  // These values are a stable contract: the hash is a persisted grouping key,
  // so changing the algorithm would silently re-key every existing dashboard.
  it('matches the FNV-1a 64-bit reference vectors', () => {
    expect(hashFingerprint('')).toBe('cbf29ce484222325');
    expect(hashFingerprint('a')).toBe('af63dc4c8601ec8c');
    expect(hashFingerprint('foobar')).toBe('85944171f73967e8');
  });

  it('is deterministic and always 16 lowercase hex chars', () => {
    const a = hashFingerprint('SELECT * FROM orders WHERE id = ?');
    expect(a).toBe(hashFingerprint('SELECT * FROM orders WHERE id = ?'));
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('zero-pads to a full 16 chars when the high bytes are zero', () => {
    // Regression guard: BigInt.toString(16) drops leading zeros, so a hash
    // whose top nibbles are zero must still be padded to a fixed width.
    expect(hashFingerprint('4')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('differs for different fingerprints', () => {
    expect(hashFingerprint('SELECT a')).not.toBe(hashFingerprint('SELECT b'));
  });

  it('agrees with a straightforward BigInt FNV-1a over varied inputs', () => {
    // Differential guard for the 32-bit-limb implementation: thousands of
    // inputs make both halves hit leading-zero and carry edge cases.
    const reference = (s: string): string => {
      let h = 0xcbf29ce484222325n;
      for (const b of new TextEncoder().encode(s)) {
        h ^= BigInt(b);
        h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
      }
      return h.toString(16).padStart(16, '0');
    };
    const alphabet = ['a', 'Z', '0', ' ', '?', '"', 'é', '中', '😀', '\uD800', '\u0000', 'ÿ'];
    let seed = 1;
    const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
    for (let n = 0; n < 5000; n += 1) {
      let s = '';
      const len = next() % 40;
      for (let i = 0; i < len; i += 1) s += alphabet[next() % alphabet.length];
      expect(hashFingerprint(s)).toBe(reference(s));
    }
  });

  it('hashes UTF-8 bytes so non-ASCII identifiers are handled', () => {
    expect(hashFingerprint('select "café"')).toMatch(/^[0-9a-f]{16}$/);
    expect(hashFingerprint('select "café"')).not.toBe(hashFingerprint('select "cafe"'));
  });
});

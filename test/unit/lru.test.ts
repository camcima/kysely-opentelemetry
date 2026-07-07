import { describe, expect, it } from 'vitest';
import { LruCache } from '../../src/analysis/lru.js';

describe('LruCache', () => {
  it('stores and retrieves values', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('missing')).toBeUndefined();
  });

  it('evicts the least recently used entry when full', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
    expect(cache.size).toBe(2);
  });

  it('get refreshes recency', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a');
    cache.set('c', 3);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
  });

  it('overwriting a key does not evict', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 9);
    expect(cache.get('a')).toBe(9);
    expect(cache.get('b')).toBe(2);
  });

  describe('byte budget', () => {
    const bytes = { maxBytes: 10, sizeOf: (_k: string, v: string) => v.length };

    it('evicts the oldest entries until the total is within the byte budget', () => {
      const cache = new LruCache<string, string>(100, bytes);
      cache.set('a', 'xxxx'); // 4 bytes
      cache.set('b', 'yyyy'); // 8 total
      cache.set('c', 'zzzz'); // would be 12 > 10, so 'a' is evicted
      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBe('yyyy');
      expect(cache.get('c')).toBe('zzzz');
    });

    it('counts the byte budget by value size, not entry count', () => {
      const cache = new LruCache<string, string>(100, bytes);
      cache.set('a', 'aaaaaaaaaa'); // 10 bytes, fills the budget
      cache.set('b', 'b'); // pushes over, evicts 'a' despite count being far below 100
      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBe('b');
    });

    it('refreshed entries survive byte eviction', () => {
      const cache = new LruCache<string, string>(100, bytes);
      cache.set('a', 'aaaa');
      cache.set('b', 'bbbb');
      cache.get('a'); // 'a' now most-recently-used
      cache.set('c', 'cccc'); // evicts LRU 'b', not 'a'
      expect(cache.get('a')).toBe('aaaa');
      expect(cache.get('b')).toBeUndefined();
    });

    it('reclaims the old size when a key is overwritten', () => {
      const cache = new LruCache<string, string>(100, bytes);
      cache.set('a', 'aaaa'); // 4
      cache.set('b', 'bbbb'); // 8
      cache.set('a', 'AA'); // a: 4→2, total 6, nothing evicted
      expect(cache.get('a')).toBe('AA');
      expect(cache.get('b')).toBe('bbbb');
    });

    it('still stores a lone entry larger than the whole budget (no infinite eviction)', () => {
      const cache = new LruCache<string, string>(100, bytes);
      cache.set('big', 'this value is way over ten bytes');
      expect(cache.get('big')).toBe('this value is way over ten bytes');
    });
  });
});

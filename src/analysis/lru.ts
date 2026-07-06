/**
 * Minimal Map-based LRU. Map preserves insertion order; re-inserting on
 * get() makes the first key the least recently used.
 */
export class LruCache<K, V> {
  readonly #map = new Map<K, V>();

  constructor(private readonly maxSize: number) {}

  get size(): number {
    return this.#map.size;
  }

  get(key: K): V | undefined {
    if (!this.#map.has(key)) return undefined;
    const value = this.#map.get(key) as V;
    this.#map.delete(key);
    this.#map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.#map.has(key)) {
      this.#map.delete(key);
    } else if (this.#map.size >= this.maxSize) {
      const oldest = this.#map.keys().next();
      if (!oldest.done) this.#map.delete(oldest.value);
    }
    this.#map.set(key, value);
  }
}

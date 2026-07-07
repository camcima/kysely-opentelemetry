/**
 * Minimal Map-based LRU. Map preserves insertion order; re-inserting on
 * get() makes the first key the least recently used.
 *
 * An optional byte budget bounds total memory honestly: with a `sizeOf` cost
 * function, entries are evicted oldest-first until the summed cost fits
 * `maxBytes`, independently of the entry-count limit. This guards the case the
 * count limit alone permits a large heap (10k entries each holding a large
 * value). A single entry whose own cost exceeds the budget is still stored
 * (there is nothing older to evict), so lookups never fail outright.
 *
 * `sizeOf` must be pure and cheap: an entry's cost is recomputed from the
 * stored value at eviction/overwrite time rather than cached in parallel
 * state, so the byte accounting cannot drift.
 */
export interface LruByteBudget<K, V> {
  readonly maxBytes: number;
  readonly sizeOf: (key: K, value: V) => number;
}

export class LruCache<K, V> {
  readonly #map = new Map<K, V>();
  #totalBytes = 0;

  constructor(
    private readonly maxSize: number,
    private readonly budget?: LruByteBudget<K, V>,
  ) {}

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
    if (this.#map.has(key)) this.#evict(key);
    const cost = this.budget ? this.budget.sizeOf(key, value) : 0;
    // Evict oldest-first until this insert fits both limits. The size > 0
    // guard keeps a lone oversized value from looping with nothing to evict.
    while (this.#map.size > 0 && this.#exceedsLimits(cost)) {
      this.#evict(this.#map.keys().next().value as K);
    }
    this.#map.set(key, value);
    this.#totalBytes += cost;
  }

  #exceedsLimits(pendingCost: number): boolean {
    if (this.#map.size >= this.maxSize) return true;
    return this.budget !== undefined && this.#totalBytes + pendingCost > this.budget.maxBytes;
  }

  #evict(key: K): void {
    if (this.budget) this.#totalBytes -= this.budget.sizeOf(key, this.#map.get(key) as V);
    this.#map.delete(key);
  }
}

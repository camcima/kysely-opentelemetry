/**
 * FNV-1a 64-bit hash of the fingerprint, as 16 lowercase hex chars.
 *
 * This is a query-grouping key, not a security primitive, so a fast
 * non-cryptographic hash is the right tool. FNV-1a is chosen over node:crypto
 * so the package stays runtime-agnostic (Cloudflare Workers, Deno, Bun) — the
 * only dependency is TextEncoder, a Web standard available everywhere Kysely
 * runs. The output width and value are a stable contract (see hash.test.ts).
 *
 * The 64-bit state is kept as two unsigned 32-bit halves rather than a BigInt:
 * this runs on the query hot path, synchronously, over the whole fingerprint,
 * and per-byte BigInt arithmetic made it roughly 8x slower.
 */
const OFFSET_HI = 0xcbf29ce4;
const OFFSET_LO = 0x84222325;
// FNV prime 0x100000001b3 = 2^40 + 0x1b3.
const PRIME_LO = 0x1b3;
const TWO_POW_32 = 0x100000000;

const encoder = new TextEncoder();

export function hashFingerprint(fingerprint: string): string {
  let hi = OFFSET_HI;
  let lo = OFFSET_LO;
  const bytes = encoder.encode(fingerprint);
  // Indexed, not for...of: the iterator protocol doubles the loop's cost.
  for (let i = 0; i < bytes.length; i += 1) {
    lo = (lo ^ bytes[i]!) >>> 0;
    // hash * prime = hash * 0x1b3 + (hash << 40), mod 2^64. lo * 0x1b3 is
    // below 2^41, so it is exact as a double; its overflow carries into hi,
    // and the << 40 term only reaches hi (as lo << 8).
    const loProduct = lo * PRIME_LO;
    hi = (Math.imul(hi, PRIME_LO) + Math.floor(loProduct / TWO_POW_32) + (lo << 8)) >>> 0;
    lo = loProduct >>> 0;
  }
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

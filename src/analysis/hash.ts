/**
 * FNV-1a 64-bit hash of the fingerprint, as 16 lowercase hex chars.
 *
 * This is a query-grouping key, not a security primitive, so a fast
 * non-cryptographic hash is the right tool. FNV-1a is chosen over node:crypto
 * so the package stays runtime-agnostic (Cloudflare Workers, Deno, Bun) — the
 * only dependency is TextEncoder, a Web standard available everywhere Kysely
 * runs. The output width and value are a stable contract (see hash.test.ts).
 */
const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

const encoder = new TextEncoder();

export function hashFingerprint(fingerprint: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (const byte of encoder.encode(fingerprint)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash.toString(16).padStart(16, '0');
}

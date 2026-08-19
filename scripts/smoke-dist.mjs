import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

/**
 * Loads BOTH built entry points the way real consumers do — require() for
 * the CJS build, import() for the ESM build — and asserts the public API is
 * present and consistent. publint/attw validate the package metadata
 * statically; this catches what only execution can (a build that parses but
 * exports nothing, or ESM/CJS builds that drift apart). Run after `pnpm
 * build`.
 */
const require = createRequire(import.meta.url);
const cjs = require('../dist/index.cjs');
const esm = await import('../dist/index.js');

for (const [flavor, mod] of [
  ['cjs', cjs],
  ['esm', esm],
]) {
  assert.equal(typeof mod.observeDialect, 'function', `${flavor}: observeDialect missing`);
  assert.equal(typeof mod.ObservedDialect, 'function', `${flavor}: ObservedDialect missing`);
  assert.equal(typeof mod.VERSION, 'string', `${flavor}: VERSION missing`);
  assert.equal(typeof mod.ATTR_DB_QUERY_HASH, 'string', `${flavor}: attribute constants missing`);
}
assert.equal(cjs.VERSION, esm.VERSION, 'ESM and CJS builds report different VERSIONs');

console.log(`dist smoke OK: ESM + CJS both export the public API (v${esm.VERSION})`);

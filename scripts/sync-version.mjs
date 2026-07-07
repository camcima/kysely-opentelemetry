import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Rewrites src/version.ts from package.json's version so the runtime VERSION
 * constant (used as the OTel instrumentation-scope version) never drifts from
 * the published package version. Run automatically on release via the
 * release-it `after:bump` hook, and available manually as `pnpm sync-version`.
 * A `version.test.ts` guard fails CI if the two ever fall out of sync.
 *
 * Writes unconditionally (idempotent) so a missing src/version.ts is
 * regenerated rather than crashing the script whose job is to produce it.
 */
const pkgUrl = new URL('../package.json', import.meta.url);
const versionFileUrl = new URL('../src/version.ts', import.meta.url);

const { version } = JSON.parse(readFileSync(pkgUrl, 'utf8'));
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/.test(version)) {
  throw new Error(
    `package.json "version" is not a valid semver string: ${JSON.stringify(version)}`,
  );
}

writeFileSync(versionFileUrl, `export const VERSION = '${version}';\n`);
console.log(`src/version.ts synced to ${version}`);

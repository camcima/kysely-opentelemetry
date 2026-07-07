import { describe, expect, it } from 'vitest';
import { VERSION } from '../../src/version.js';

describe('scaffolding', () => {
  it('exposes the package version as a semver string', () => {
    // Assert the shape, not a literal value: the exact-sync check against
    // package.json lives in version.test.ts. Hardcoding a version here made
    // the suite fail on every release bump (it shipped broken in v0.1.1).
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?$/);
  });
});

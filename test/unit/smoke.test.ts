import { describe, expect, it } from 'vitest';
import { VERSION } from '../../src/version.js';

describe('scaffolding', () => {
  it('exposes the package version', () => {
    expect(VERSION).toBe('0.1.0');
  });
});

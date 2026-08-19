import { diag } from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';
import { warnLimited } from '../../src/otel/diagnostics.js';

describe('warnLimited', () => {
  it('routes to diag.warn with a context prefix and caps per context, not globally', () => {
    const spy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 12; i++) warnLimited('test-context-a', new Error(`boom ${i}`));
    warnLimited('test-context-b', new Error('other failure'));
    const aCalls = spy.mock.calls.filter(([msg]) => String(msg).includes('test-context-a'));
    const bCalls = spy.mock.calls.filter(([msg]) => String(msg).includes('test-context-b'));
    expect(aCalls).toHaveLength(10); // 11th and 12th suppressed
    expect(bCalls).toHaveLength(1); // a fresh context is NOT silenced by another context's cap
    expect(String(aCalls[0]![0])).toContain('kysely-opentelemetry');
    spy.mockRestore();
  });
});

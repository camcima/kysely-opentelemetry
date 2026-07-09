import { diag, SpanStatusCode, type Span } from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';
import { normalizeOptions } from '../../src/options.js';
import { errorType, recordError, warnLimited } from '../../src/otel/spans.js';

function fakeSpan() {
  return {
    setAttribute: vi.fn(),
    setStatus: vi.fn(),
    recordException: vi.fn(),
  } as unknown as Span & { setAttribute: any; setStatus: any; recordException: any };
}

describe('errorType', () => {
  it('prefers a string db error code', () => {
    const err = Object.assign(new Error('dup'), { code: '23505' });
    expect(errorType(err)).toBe('23505');
  });

  it('falls back to the constructor name', () => {
    class QueryTimeoutError extends Error {}
    expect(errorType(new QueryTimeoutError('t'))).toBe('QueryTimeoutError');
  });

  it('falls back to _OTHER for non-errors', () => {
    expect(errorType('boom')).toBe('_OTHER');
    expect(errorType(undefined)).toBe('_OTHER');
  });

  it('falls through non-string or empty code to the constructor name', () => {
    const numeric = Object.assign(new TypeError('x'), { code: 500 });
    expect(errorType(numeric)).toBe('TypeError');
    const empty = Object.assign(new RangeError('x'), { code: '' });
    expect(errorType(empty)).toBe('RangeError');
  });
});

describe('recordError', () => {
  it('sets attributes, status and exception', () => {
    const span = fakeSpan();
    const err = new Error('bad query');
    const type = recordError(span, err, normalizeOptions());
    expect(type).toBe('Error');
    expect(span.setAttribute).toHaveBeenCalledWith('error.type', 'Error');
    expect(span.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: 'bad query',
    });
    expect(span.recordException).toHaveBeenCalledWith(err);
  });

  it('skips recordException when disabled', () => {
    const span = fakeSpan();
    recordError(span, new Error('x'), normalizeOptions({ recordExceptions: false }));
    expect(span.recordException).not.toHaveBeenCalled();
  });

  it('omits the status message when recordErrorMessages is false', () => {
    const span = fakeSpan();
    recordError(
      span,
      new Error('value "alice@example.com" violates constraint'),
      normalizeOptions({ recordErrorMessages: false }),
    );
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR });
    expect(span.setAttribute).toHaveBeenCalledWith('error.type', 'Error');
  });
});

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

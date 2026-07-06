import { SpanStatusCode, type Span } from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';
import { normalizeOptions } from '../../src/options.js';
import { errorType, recordError } from '../../src/otel/spans.js';

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
});

describe('recordError', () => {
  it('sets attributes, status and exception', () => {
    const span = fakeSpan();
    const err = new Error('bad query');
    const type = recordError(span, err, normalizeOptions());
    expect(type).toBe('Error');
    expect(span.setAttribute).toHaveBeenCalledWith('error.type', 'Error');
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'bad query' });
    expect(span.recordException).toHaveBeenCalledWith(err);
  });

  it('skips recordException when disabled', () => {
    const span = fakeSpan();
    recordError(span, new Error('x'), normalizeOptions({ recordExceptions: false }));
    expect(span.recordException).not.toHaveBeenCalled();
  });
});

import { diag, SpanStatusCode, type Span } from '@opentelemetry/api';
import type { NormalizedOptions } from '../options.js';
import { ATTR_ERROR_TYPE } from './attributes.js';

/** Semconv error.type: db error code, else error class name, else '_OTHER'. */
export function errorType(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
    if (error instanceof Error) return error.constructor.name;
  }
  return '_OTHER';
}

export function recordError(span: Span, error: unknown, options: NormalizedOptions): string {
  const type = errorType(error);
  span.setAttribute(ATTR_ERROR_TYPE, type);
  span.setStatus({
    code: SpanStatusCode.ERROR,
    ...(error instanceof Error && { message: error.message }),
  });
  if (options.recordExceptions && error instanceof Error) span.recordException(error);
  return type;
}

const MAX_WARNINGS = 10;
let warnCount = 0;

/** Instrumentation-internal failures: warn through OTel diagnostics, capped. */
export function warnOnce(error: unknown): void {
  if (warnCount >= MAX_WARNINGS) return;
  warnCount += 1;
  diag.warn('kysely-opentelemetry: instrumentation error (query executed unobserved)', error);
}

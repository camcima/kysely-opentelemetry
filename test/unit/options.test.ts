import { metrics, trace } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';
import { normalizeOptions } from '../../src/options.js';

describe('normalizeOptions', () => {
  it('applies safe defaults', () => {
    const opts = normalizeOptions();
    expect(opts).toMatchObject({
      enabled: true,
      queryText: 'sanitized',
      maxQueryTextLength: 4096,
      fingerprint: true,
      summary: true,
      tables: true,
      hash: true,
      metrics: true,
      transactions: true,
      recordExceptions: true,
    });
    expect(opts.dbSystem).toBeUndefined();
    expect(opts.attributes).toBeUndefined();
    expect(opts.redact).toBeUndefined();
    expect(opts.namespace).toBeUndefined();
    expect(opts.serverAddress).toBeUndefined();
    expect(opts.serverPort).toBeUndefined();
    expect(opts.tracerProvider).toBeUndefined();
    expect(opts.meterProvider).toBeUndefined();
  });

  it('honors overrides', () => {
    const redact = (sql: string) => sql;
    const opts = normalizeOptions({ enabled: false, queryText: 'off', metrics: false, redact });
    expect(opts.enabled).toBe(false);
    expect(opts.queryText).toBe('off');
    expect(opts.metrics).toBe(false);
    expect(opts.redact).toBe(redact);
  });

  it('passes through an injected tracerProvider/meterProvider', () => {
    const tracerProvider = trace.getTracerProvider();
    const meterProvider = metrics.getMeterProvider();
    const opts = normalizeOptions({ tracerProvider, meterProvider });
    expect(opts.tracerProvider).toBe(tracerProvider);
    expect(opts.meterProvider).toBe(meterProvider);
  });
});

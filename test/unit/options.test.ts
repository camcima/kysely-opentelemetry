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
      metrics: { operationDuration: true, connectionWaitTime: true },
      transactions: true,
      recordExceptions: true,
    });
    expect(opts.dbSystem).toBeUndefined();
    expect(opts.attributes).toBeUndefined();
    expect(opts.redact).toBeUndefined();
    expect(opts.shouldObserve).toBeUndefined();
    expect(opts.namespace).toBeUndefined();
    expect(opts.serverAddress).toBeUndefined();
    expect(opts.serverPort).toBeUndefined();
    expect(opts.poolName).toBeUndefined();
    expect(opts.tracerProvider).toBeUndefined();
    expect(opts.meterProvider).toBeUndefined();
  });

  it('normalizes metrics booleans and per-metric objects', () => {
    expect(normalizeOptions({ metrics: false }).metrics).toEqual({
      operationDuration: false,
      connectionWaitTime: false,
    });
    expect(normalizeOptions({ metrics: { connectionWaitTime: false } }).metrics).toEqual({
      operationDuration: true,
      connectionWaitTime: false,
    });
    expect(normalizeOptions({ metrics: { operationDuration: false } }).metrics).toEqual({
      operationDuration: false,
      connectionWaitTime: true,
    });
  });

  it('passes through poolName', () => {
    expect(normalizeOptions({ poolName: 'read-replica' }).poolName).toBe('read-replica');
  });

  it('honors overrides', () => {
    const redact = (sql: string) => sql;
    const shouldObserve = () => true;
    const opts = normalizeOptions({
      enabled: false,
      queryText: 'off',
      metrics: false,
      redact,
      shouldObserve,
    });
    expect(opts.enabled).toBe(false);
    expect(opts.queryText).toBe('off');
    expect(opts.metrics).toEqual({ operationDuration: false, connectionWaitTime: false });
    expect(opts.redact).toBe(redact);
    expect(opts.shouldObserve).toBe(shouldObserve);
  });

  it('passes through an injected tracerProvider/meterProvider', () => {
    const tracerProvider = trace.getTracerProvider();
    const meterProvider = metrics.getMeterProvider();
    const opts = normalizeOptions({ tracerProvider, meterProvider });
    expect(opts.tracerProvider).toBe(tracerProvider);
    expect(opts.meterProvider).toBe(meterProvider);
  });
});

import type { Histogram } from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';
import { recordDuration, resolveWaitTimeAttributes } from '../../src/otel/metrics.js';
import type { QueryContext } from '../../src/analysis/analyze.js';
import { normalizeOptions } from '../../src/options.js';

function fakeHistogram() {
  return { record: vi.fn() } as unknown as Histogram & { record: any };
}

function ctx(overrides: Partial<QueryContext> = {}): QueryContext {
  return {
    sql: 'select 1',
    parameters: [],
    operation: 'SELECT',
    tables: [],
    tablesTruncated: false,
    summary: 'SELECT orders',
    fingerprint: 'select ?',
    hash: 'abc',
    isRaw: false,
    sanitizationError: false,
    ...overrides,
  } as QueryContext;
}

describe('recordDuration', () => {
  it('records milliseconds as seconds with low-cardinality attributes', () => {
    const h = fakeHistogram();
    recordDuration(h, ctx({ primaryTable: 'orders' }), 'postgresql', normalizeOptions(), 250);
    expect(h.record).toHaveBeenCalledTimes(1);
    const [value, attrs] = h.record.mock.calls[0];
    expect(value).toBeCloseTo(0.25);
    expect(attrs).toMatchObject({
      'db.system.name': 'postgresql',
      'db.operation.name': 'SELECT',
      'db.query.summary': 'SELECT orders',
      'db.collection.name': 'orders',
    });
    expect(attrs).not.toHaveProperty('error.type');
  });

  it('omits db.collection.name when there is no primary table, and includes error.type when given', () => {
    const h = fakeHistogram();
    recordDuration(h, ctx(), 'mysql', normalizeOptions(), 100, 'QueryFailedError');
    const [, attrs] = h.record.mock.calls[0];
    expect(attrs).not.toHaveProperty('db.collection.name');
    expect(attrs['error.type']).toBe('QueryFailedError');
  });

  it('omits db.query.summary when summary: false', () => {
    const h = fakeHistogram();
    recordDuration(h, ctx(), 'postgresql', normalizeOptions({ summary: false }), 100);
    const [, attrs] = h.record.mock.calls[0];
    expect(attrs).not.toHaveProperty('db.query.summary');
    expect(attrs['db.operation.name']).toBe('SELECT'); // rest of the attrs intact
  });

  it('emits connection-level attributes when configured', () => {
    const h = fakeHistogram();
    const options = normalizeOptions({
      namespace: 'shop',
      serverAddress: 'db.internal',
      serverPort: 5432,
    });
    recordDuration(h, ctx(), 'postgresql', options, 100);
    const [, attrs] = h.record.mock.calls[0];
    expect(attrs['db.namespace']).toBe('shop');
    expect(attrs['server.address']).toBe('db.internal');
    expect(attrs['server.port']).toBe(5432);
  });
});

describe('resolveWaitTimeAttributes', () => {
  it('tags db.system.name and derives the pool name from address, port, and namespace', () => {
    const attrs = resolveWaitTimeAttributes(
      normalizeOptions({ serverAddress: 'db.internal', serverPort: 5432, namespace: 'shop' }),
      'postgresql',
    );
    expect(attrs['db.system.name']).toBe('postgresql');
    expect(attrs['db.client.connection.pool.name']).toBe('db.internal:5432/shop');
  });

  it('uses the address alone when port and namespace are absent', () => {
    const attrs = resolveWaitTimeAttributes(
      normalizeOptions({ serverAddress: 'db.internal' }),
      'postgresql',
    );
    expect(attrs['db.client.connection.pool.name']).toBe('db.internal');
  });

  it('uses the namespace when there is no server address', () => {
    const attrs = resolveWaitTimeAttributes(normalizeOptions({ namespace: 'shop' }), 'postgresql');
    expect(attrs['db.client.connection.pool.name']).toBe('shop');
  });

  it('falls back to the db system name when no connection info is configured', () => {
    const attrs = resolveWaitTimeAttributes(normalizeOptions(), 'postgresql');
    expect(attrs['db.client.connection.pool.name']).toBe('postgresql');
  });

  it('honors an explicit poolName option over any derivation', () => {
    const attrs = resolveWaitTimeAttributes(
      normalizeOptions({ poolName: 'read-replica', serverAddress: 'db.internal' }),
      'postgresql',
    );
    expect(attrs['db.client.connection.pool.name']).toBe('read-replica');
  });

  it('returns a frozen object safe to share across recordings', () => {
    const attrs = resolveWaitTimeAttributes(normalizeOptions(), 'postgresql');
    expect(Object.isFrozen(attrs)).toBe(true);
  });
});

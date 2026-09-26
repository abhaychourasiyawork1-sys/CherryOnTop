import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMarketingApp, type MarketingApp } from './app.js';
import { createMarketingDb } from './db.js';
import { createTelemetryStore } from './telemetry.js';

const SESSION = 'session-1234abcd';

function event(overrides: Record<string, unknown> = {}) {
  return { event: 'hero_cta_clicked', path: '/', timestamp: new Date().toISOString(), ...overrides };
}

describe('POST /api/analytics', () => {
  let app: MarketingApp;

  beforeEach(() => {
    app = buildMarketingApp({ dbPath: ':memory:', trustProxy: false });
  });

  afterEach(async () => {
    await app.close();
  });

  function post(payload: unknown) {
    return app.inject({ method: 'POST', url: '/api/analytics', payload: payload as Record<string, unknown> });
  }

  function rows() {
    return app.marketingDb.raw.prepare('SELECT * FROM marketing_events').all() as Array<Record<string, string>>;
  }

  it('persists a valid batch with only approved columns', async () => {
    const response = await post({
      sessionId: SESSION,
      events: [event(), event({ event: 'architecture_explored', metadata: { layer: 'runtime' } })],
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: 2 });
    const stored = rows();
    expect(stored).toHaveLength(2);
    expect(Object.keys(stored[0] ?? {}).sort()).toEqual(['created_at', 'event', 'id', 'metadata', 'path', 'session_id']);
    expect(JSON.parse(stored[1]?.metadata ?? '{}')).toEqual({ layer: 'runtime' });
  });

  it('rejects malformed bodies', async () => {
    expect((await post({ events: 'nope' })).statusCode).toBe(400);
    expect((await post({ sessionId: SESSION, events: [{ path: '/' }] })).statusCode).toBe(400);
    expect(rows()).toHaveLength(0);
  });

  it('rejects unknown event names', async () => {
    const response = await post({ sessionId: SESSION, events: [event({ event: 'custom_free_text' })] });
    expect(response.statusCode).toBe(400);
    expect(rows()).toHaveLength(0);
  });

  it('rejects empty and oversized batches', async () => {
    expect((await post({ sessionId: SESSION, events: [] })).statusCode).toBe(400);
    const tooMany = Array.from({ length: 21 }, () => event());
    expect((await post({ sessionId: SESSION, events: tooMany })).statusCode).toBe(400);
    expect(rows()).toHaveLength(0);
  });

  it('rejects PII fields and PII-like metadata', async () => {
    expect((await post({ sessionId: SESSION, events: [event({ email: 'a@example.com' })] })).statusCode).toBe(400);
    expect(
      (await post({ sessionId: SESSION, events: [event({ metadata: { email: 'a@example.com' } })] })).statusCode,
    ).toBe(400);
    expect(
      (await post({ sessionId: SESSION, events: [event({ metadata: { repository: 'acme/app' } })] })).statusCode,
    ).toBe(400);
    expect((await post({ sessionId: SESSION, events: [event({ metadata: { model: 'x' } })] })).statusCode).toBe(400);
    expect(
      (await post({ sessionId: SESSION, events: [event({ metadata: { note: 'me@example.com' } })] })).statusCode,
    ).toBe(400);
    expect(rows()).toHaveLength(0);
  });

  it('does not store user agent or IP', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/analytics',
      headers: { 'user-agent': 'SecretAgent/1.0', 'x-forwarded-for': '203.0.113.9' },
      payload: { sessionId: SESSION, events: [event()] },
    });
    const serialized = JSON.stringify(rows());
    expect(serialized).not.toContain('SecretAgent');
    expect(serialized).not.toContain('203.0.113.9');
  });
});

describe('telemetry retention', () => {
  it('deletes events older than the retention period', () => {
    const db = createMarketingDb(':memory:');
    const store = createTelemetryStore(db);
    const now = new Date('2026-09-26T00:00:00.000Z');
    store.insertBatch(SESSION, [
      { event: 'hero_cta_clicked', path: '/', timestamp: '2026-08-01T00:00:00.000Z' },
      { event: 'video_started', path: '/', timestamp: '2026-09-25T00:00:00.000Z' },
    ]);
    expect(store.deleteOlderThan(30, now)).toBe(1);
    expect(store.count()).toBe(1);
    db.close();
  });
});

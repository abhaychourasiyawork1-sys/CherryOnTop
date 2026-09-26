import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { buildMarketingApp, type MarketingApp } from './app.js';

function freshApp(overrides: Record<string, unknown> = {}): MarketingApp {
  return buildMarketingApp({ dbPath: ':memory:', trustProxy: false, ...overrides });
}

describe('marketing app', () => {
  let app: MarketingApp;

  beforeEach(() => {
    app = freshApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns health status without filesystem details', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual({ status: 'ok' });
    expect(JSON.stringify(body)).not.toMatch(/\.db|\/home|\/Users/i);
  });

  it('accepts a valid waitlist submission', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/waitlist',
      payload: { email: 'valid@example.com' },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: true });
  });

  it('normalizes whitespace/case before storing', async () => {
    await app.inject({ method: 'POST', url: '/api/waitlist', payload: { email: '  Norm@Example.COM ' } });
    const row = app.marketingDb.raw.prepare('SELECT email FROM waitlist_signups').get() as { email: string };
    expect(row.email).toBe('norm@example.com');
  });

  it('returns the same success shape for duplicate emails', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/waitlist',
      payload: { email: 'dup@example.com' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/waitlist',
      payload: { email: 'dup@example.com' },
    });
    expect(first.statusCode).toBe(second.statusCode);
    expect(first.json()).toEqual(second.json());
    const row = app.marketingDb.raw.prepare('SELECT COUNT(*) as count FROM waitlist_signups').get() as {
      count: number;
    };
    expect(row.count).toBe(1);
  });

  it('rejects invalid email with a 400 and no sensitive details', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/waitlist',
      payload: { email: 'not-an-email' },
    });
    expect(response.statusCode).toBe(400);
    const text = response.body;
    expect(text).not.toMatch(/sqlite|stack|SQL|at Object/i);
  });

  it('rejects oversized payloads', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/waitlist',
      payload: { email: 'big@example.com', honeypot: 'x'.repeat(30_000) },
    });
    expect(response.statusCode).toBe(413);
  });

  it('accepts honeypot submissions with a generic success but does not persist them', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/waitlist',
      payload: { email: 'honeypot@example.com', honeypot: 'i am a bot' },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: true });
    const row = app.marketingDb.raw
      .prepare('SELECT COUNT(*) as count FROM waitlist_signups WHERE email = ?')
      .get('honeypot@example.com') as { count: number };
    expect(row.count).toBe(0);
  });

  it('rate limits burst traffic from the same client', async () => {
    const results: number[] = [];
    for (let i = 0; i < 25; i += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/waitlist',
        payload: { email: `burst${i}@example.com` },
      });
      results.push(response.statusCode);
    }
    expect(results).toContain(429);
  });

  it('does not expose internal runtime or tRPC routes', async () => {
    const trpc = await app.inject({ method: 'GET', url: '/trpc/health' });
    expect(trpc.statusCode).toBe(404);
    const internal = await app.inject({ method: 'GET', url: '/api/internal/jobs' });
    expect(internal.statusCode).toBe(404);
  });

  it('requires a JSON content type', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/waitlist',
      headers: { 'content-type': 'text/plain' },
      payload: 'email=plain@example.com',
    });
    expect(response.statusCode).toBe(400);
  });
});

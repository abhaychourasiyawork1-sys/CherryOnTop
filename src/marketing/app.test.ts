import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { buildMarketingApp, type MarketingApp } from './app.js';
import { loadMarketingConfig } from './config.js';

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

describe('production wiring: site + API from one process', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const siteDir = path.join(repoRoot, 'site', 'dist');
  let tmpDir: string;
  let app: MarketingApp;
  let origin: string;

  beforeAll(async () => {
    if (!fs.existsSync(path.join(siteDir, 'index.html'))) {
      execSync('npm --prefix site run build', { cwd: repoRoot, stdio: 'ignore' });
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-wiring-'));
    app = buildMarketingApp({ dbPath: path.join(tmpDir, 'marketing.db'), siteDir, trustProxy: false });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no listener address');
    origin = `http://127.0.0.1:${address.port}`;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('serves the landing HTML at / without long-lived caching', async () => {
    const response = await fetch(`${origin}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/text\/html/);
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.headers.get('content-security-policy')).toMatch(/default-src 'self'/);
    const html = await response.text();
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('AI teams you can hold accountable.');
  });

  it('serves hashed static assets with immutable caching', async () => {
    const html = await (await fetch(`${origin}/`)).text();
    const assetPath = /(?:src|href)="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
    expect(assetPath).toBeDefined();
    const response = await fetch(`${origin}${assetPath}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/javascript/);
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('serves public media with byte-range support', async () => {
    const response = await fetch(`${origin}/media/cherryontop-promo.mp4`, { headers: { Range: 'bytes=0-99' } });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(response.headers.get('content-range')).toMatch(/^bytes 0-99\/\d+$/);
    expect((await response.arrayBuffer()).byteLength).toBe(100);
  });

  it('answers health and waitlist on the same origin', async () => {
    const health = await fetch(`${origin}/api/health`);
    expect(health.status).toBe(200);
    expect(health.headers.get('cache-control')).toBe('no-store');
    expect(await health.json()).toEqual({ status: 'ok' });

    const waitlist = await fetch(`${origin}/api/waitlist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'wiring@example.com' }),
    });
    expect(waitlist.status).toBe(202);
    expect(await waitlist.json()).toEqual({ accepted: true });
  });

  it('publishes the benchmark methodology document linked from the page', async () => {
    const response = await fetch(`${origin}/docs/marketing/benchmarks.md`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/text\/markdown/);
    expect(await response.text()).toMatch(/SWE-bench Verified/);
  });

  it('returns a normal 404 for unknown non-API routes', async () => {
    const response = await fetch(`${origin}/does-not-exist`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('<div id="root">');
  });

  it('never falls back to HTML for unknown /api routes', async () => {
    const response = await fetch(`${origin}/api/does-not-exist`);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toMatch(/application\/json/);
    expect(await response.json()).toEqual({ error: 'not_found' });
  });

  it('does not serve files outside the site directory', async () => {
    const response = await fetch(`${origin}/%2e%2e/%2e%2e/package.json`);
    expect(response.status).toBe(404);
  });
});

describe('launch security audit', () => {
  let app: MarketingApp;

  beforeEach(() => {
    app = buildMarketingApp({ dbPath: ':memory:', trustProxy: false });
  });

  afterEach(async () => {
    await app.close();
  });

  it('never persists raw client IPs', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/waitlist',
      remoteAddress: '203.0.113.77',
      headers: { 'x-forwarded-for': '198.51.100.9' },
      payload: { email: 'ip-audit@example.com' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/analytics',
      remoteAddress: '203.0.113.77',
      payload: {
        sessionId: 'session-ip-audit',
        events: [{ event: 'hero_cta_clicked', path: '/', timestamp: new Date().toISOString() }],
      },
    });
    const raw = app.marketingDb.raw;
    const dump = JSON.stringify([
      raw.prepare('SELECT * FROM waitlist_signups').all(),
      raw.prepare('SELECT * FROM marketing_events').all(),
    ]);
    expect(dump).toContain('ip-audit@example.com');
    expect(dump).not.toMatch(/203\.0\.113\.77|198\.51\.100\.9/);
  });

  it('keeps the marketing DB limited to waitlist and telemetry tables', () => {
    const tables = app.marketingDb.raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toEqual(['marketing_events', 'waitlist_signups']);
  });

  it('sends CSP and hardening headers on API responses', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.headers['content-security-policy']).toMatch(/default-src 'self'/);
    expect(response.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('adds an explicitly configured media origin to CSP media-src only', async () => {
    const withMedia = buildMarketingApp({ dbPath: ':memory:', mediaOrigin: 'https://media.example.net' });
    const response = await withMedia.inject({ method: 'GET', url: '/api/health' });
    await withMedia.close();
    expect(response.headers['content-security-policy']).toMatch(/media-src 'self' https:\/\/media\.example\.net/);
    expect(response.headers['content-security-policy']).toMatch(/script-src 'self'(;|$)/);
  });

  it('does not leak internal error details in public responses', async () => {
    app.marketingDb.raw.exec('DROP TABLE waitlist_signups');
    const response = await app.inject({
      method: 'POST',
      url: '/api/waitlist',
      payload: { email: 'broken@example.com' },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'internal_error' });
    expect(response.body).not.toMatch(/sqlite|no such table|at \w+ \(|\.ts:/i);
  });

  it('keeps MARKETING_TRUST_PROXY off unless explicitly set to "true"', () => {
    expect(loadMarketingConfig({}).trustProxy).toBe(false);
    expect(loadMarketingConfig({ MARKETING_TRUST_PROXY: '1' }).trustProxy).toBe(false);
    expect(loadMarketingConfig({ MARKETING_TRUST_PROXY: 'yes' }).trustProxy).toBe(false);
    expect(loadMarketingConfig({ MARKETING_TRUST_PROXY: 'true' }).trustProxy).toBe(true);
  });

  it('defaults to a dedicated marketing database file', () => {
    expect(path.basename(loadMarketingConfig({}).dbPath)).toBe('marketing.db');
  });

  it('rejects malformed JSON without echoing internals', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/waitlist',
      headers: { 'content-type': 'application/json' },
      payload: '{"email":',
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toMatch(/Unexpected|JSON|at \w+ \(/);
  });
});

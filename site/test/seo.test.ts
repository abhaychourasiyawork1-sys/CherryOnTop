// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'vite';

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Test-only origin (reserved .test TLD); never committed as the canonical domain.
const ORIGIN = 'https://cherryontop.example.test';
const TITLE = 'CherryOnTop — AI teams you can hold accountable.';
const DESCRIPTION = 'Give autonomous AI work a goal, a mandate, a budget, and a way to prove the result.';

async function buildSite(origin: string | undefined): Promise<string> {
  const outDir = mkdtempSync(join(tmpdir(), 'cot-seo-'));
  const previous = process.env.VITE_SITE_ORIGIN;
  if (origin === undefined) delete process.env.VITE_SITE_ORIGIN;
  else process.env.VITE_SITE_ORIGIN = origin;
  try {
    await build({
      root: siteRoot,
      configFile: join(siteRoot, 'vite.config.ts'),
      logLevel: 'silent',
      build: { outDir, emptyOutDir: true },
    });
  } finally {
    if (previous === undefined) delete process.env.VITE_SITE_ORIGIN;
    else process.env.VITE_SITE_ORIGIN = previous;
  }
  return outDir;
}

function meta(html: string, attr: 'name' | 'property', key: string): string | undefined {
  const match = html.match(new RegExp(`<meta\\s+${attr}="${key}"\\s+content="([^"]*)"`));
  return match?.[1];
}

describe('SEO build output with a configured origin', () => {
  let outDir: string;
  let html: string;

  beforeAll(async () => {
    outDir = await buildSite(ORIGIN);
    html = readFileSync(join(outDir, 'index.html'), 'utf8');
  }, 120_000);

  afterAll(() => rmSync(outDir, { recursive: true, force: true }));

  it('has the product title and description', () => {
    expect(html).toContain(`<title>${TITLE}</title>`);
    expect(html).toMatch(new RegExp(`name="description"\\s+content="${DESCRIPTION}"`));
  });

  it('has a canonical link on the configured origin', () => {
    expect(html).toContain(`<link rel="canonical" href="${ORIGIN}/" />`);
  });

  it('has Open Graph title, description, url and absolute image', () => {
    expect(meta(html, 'property', 'og:title')).toBe(TITLE);
    expect(meta(html, 'property', 'og:description')).toBe(DESCRIPTION);
    expect(meta(html, 'property', 'og:url')).toBe(`${ORIGIN}/`);
    expect(meta(html, 'property', 'og:image')).toBe(`${ORIGIN}/og-image.svg`);
    expect(existsSync(join(outDir, 'og-image.svg'))).toBe(true);
  });

  it('has a Twitter large-image card', () => {
    expect(meta(html, 'name', 'twitter:card')).toBe('summary_large_image');
    expect(meta(html, 'name', 'twitter:title')).toBe(TITLE);
    expect(meta(html, 'name', 'twitter:image')).toBe(`${ORIGIN}/og-image.svg`);
  });

  it('ships robots.txt pointing at the sitemap, with the API disallowed', () => {
    const robots = readFileSync(join(outDir, 'robots.txt'), 'utf8');
    expect(robots).toMatch(/User-agent: \*/);
    expect(robots).toContain('Disallow: /api/');
    expect(robots).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
    expect(meta(html, 'name', 'robots')).toBe('index, follow');
  });

  it('ships a sitemap listing the page on the configured origin', () => {
    const sitemap = readFileSync(join(outDir, 'sitemap.xml'), 'utf8');
    expect(sitemap).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(sitemap).toContain(`<loc>${ORIGIN}/</loc>`);
  });

  it('leaves no unresolved origin placeholder anywhere', () => {
    for (const file of ['index.html', 'robots.txt', 'sitemap.xml']) {
      expect(readFileSync(join(outDir, file), 'utf8')).not.toContain('%SITE_ORIGIN%');
    }
  });

  it('uses product language only, without superlatives or model names', () => {
    const copy = [html, readFileSync(join(outDir, 'og-image.svg'), 'utf8')].join('\n').toLowerCase();
    for (const banned of ['best', 'fastest', 'open source', 'open-source', 'gpt', 'claude', 'gemini', 'openai', 'anthropic']) {
      expect(copy, banned).not.toMatch(new RegExp(`\\b${banned}\\b`));
    }
  });
});

describe('SEO build output without an origin', () => {
  let outDir: string;

  beforeAll(async () => {
    outDir = await buildSite(undefined);
  }, 120_000);

  afterAll(() => rmSync(outDir, { recursive: true, force: true }));

  it('ships no fake domain: no canonical, no og:url, no sitemap, no Sitemap line', () => {
    const html = readFileSync(join(outDir, 'index.html'), 'utf8');
    expect(html).not.toContain('rel="canonical"');
    expect(html).not.toContain('og:url');
    expect(html).not.toContain('%SITE_ORIGIN%');
    expect(meta(html, 'property', 'og:image')).toBe('/og-image.svg');
    expect(existsSync(join(outDir, 'sitemap.xml'))).toBe(false);
    const robots = readFileSync(join(outDir, 'robots.txt'), 'utf8');
    expect(robots).toContain('User-agent: *');
    expect(robots).not.toContain('Sitemap:');
  });
});

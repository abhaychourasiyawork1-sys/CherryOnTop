import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const marketingApiUrl = process.env.MARKETING_API_URL ?? 'http://127.0.0.1:4178';

/**
 * Templates the production origin into index.html, robots.txt and sitemap.xml.
 * `%SITE_ORIGIN%` is replaced with VITE_SITE_ORIGIN; without it, origin-dependent tags
 * (canonical, og:url) are dropped, share-image URLs stay root-relative, the sitemap is
 * not shipped and robots.txt omits its Sitemap line, so no placeholder domain ever ships.
 */
function siteOrigin(): Plugin {
  const origin = (process.env.VITE_SITE_ORIGIN ?? '').trim().replace(/\/+$/, '');
  return {
    name: 'cherryontop-site-origin',
    transformIndexHtml(html) {
      if (origin) return html.replaceAll('%SITE_ORIGIN%', origin);
      return html
        .split('\n')
        .filter((line) => !/(rel="canonical"|property="og:url").*%SITE_ORIGIN%/.test(line))
        .join('\n')
        .replaceAll('%SITE_ORIGIN%', '');
    },
    writeBundle(options) {
      // Public files are copied verbatim before bundle write; template them in place.
      const outDir = options.dir ?? 'dist';
      const robots = join(outDir, 'robots.txt');
      const sitemap = join(outDir, 'sitemap.xml');
      if (existsSync(robots)) {
        const text = readFileSync(robots, 'utf8');
        writeFileSync(
          robots,
          origin
            ? text.replaceAll('%SITE_ORIGIN%', origin)
            : text
                .split('\n')
                .filter((line) => !line.includes('%SITE_ORIGIN%'))
                .join('\n'),
        );
      }
      if (existsSync(sitemap)) {
        if (origin) {
          writeFileSync(sitemap, readFileSync(sitemap, 'utf8').replaceAll('%SITE_ORIGIN%', origin));
        } else {
          rmSync(sitemap);
          this.warn('VITE_SITE_ORIGIN is unset: sitemap.xml omitted and canonical/og:url dropped.');
        }
      }
    },
  };
}

/**
 * Publishes the tracked benchmark methodology document with the site, so the public
 * benchmark section's methodology link (/docs/marketing/benchmarks.md) resolves in production.
 */
function benchmarkEvidenceDoc(): Plugin {
  const source = fileURLToPath(new URL('../docs/marketing/benchmarks.md', import.meta.url));
  return {
    name: 'cherryontop-benchmark-doc',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'docs/marketing/benchmarks.md', source: readFileSync(source, 'utf8') });
    },
  };
}

export default defineConfig({
  plugins: [react(), siteOrigin(), benchmarkEvidenceDoc()],
  server: {
    proxy: {
      '/api': {
        target: marketingApiUrl,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/env.ts'],
    css: false,
    include: ['test/**/*.{test,spec}.?(c|m)[jt]s?(x)', 'test/setup.ts'],
  },
});

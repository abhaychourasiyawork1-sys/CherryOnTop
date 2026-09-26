import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.vtt': 'text/vtt; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.woff2': 'font/woff2',
};

export const HTML_CACHE_CONTROL = 'no-cache';
export const HASHED_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const PUBLIC_FILE_CACHE_CONTROL = 'public, max-age=3600';

function cacheControlFor(relativePath: string): string {
  if (relativePath.endsWith('.html')) return HTML_CACHE_CONTROL;
  // Vite emits content-hashed file names under assets/.
  if (relativePath.startsWith('assets/')) return HASHED_ASSET_CACHE_CONTROL;
  return PUBLIC_FILE_CACHE_CONTROL;
}

/** Resolves a URL path to a regular file inside `root`, or null. Never escapes `root`. */
export function resolveStaticFile(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const relative = decoded === '/' || decoded === '' ? 'index.html' : decoded.replace(/^\/+/, '');
  const candidate = path.resolve(root, relative);
  if (candidate !== root && !candidate.startsWith(root + path.sep)) return null;
  try {
    const stat = fs.statSync(candidate);
    if (stat.isFile()) return candidate;
    if (stat.isDirectory()) {
      const index = path.join(candidate, 'index.html');
      return fs.statSync(index, { throwIfNoEntry: false })?.isFile() ? index : null;
    }
  } catch {
    return null;
  }
  return null;
}

function sendFile(request: FastifyRequest, reply: FastifyReply, root: string, file: string): FastifyReply {
  const relative = path.relative(root, file).split(path.sep).join('/');
  const size = fs.statSync(file).size;
  reply.header('Content-Type', CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
  reply.header('Cache-Control', cacheControlFor(relative));
  reply.header('Accept-Ranges', 'bytes');

  // Single byte-range support so browsers can seek the promo video.
  const range = request.headers.range;
  const match = typeof range === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (match && (match[1] !== '' || match[2] !== '')) {
    let start: number;
    let end: number;
    if (match[1] === '') {
      start = Math.max(0, size - Number(match[2]));
      end = size - 1;
    } else {
      start = Number(match[1]);
      end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
    }
    if (start > end || start >= size) {
      reply.header('Content-Range', `bytes */${size}`);
      return reply.code(416).send();
    }
    reply.header('Content-Range', `bytes ${start}-${end}/${size}`);
    reply.header('Content-Length', end - start + 1);
    reply.code(206);
    return request.method === 'HEAD' ? reply.send() : reply.send(fs.createReadStream(file, { start, end }));
  }

  reply.header('Content-Length', size);
  return request.method === 'HEAD' ? reply.send() : reply.send(fs.createReadStream(file));
}

/**
 * Serves the built site from `siteDir`. Must be registered after the `/api/*` routes:
 * unknown `/api/*` paths get a JSON 404 and never fall back to HTML.
 */
export function registerStaticSite(app: FastifyInstance, siteDir: string): void {
  const root = path.resolve(siteDir);

  app.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split('?')[0] ?? '/';
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      return reply.code(404).send({ error: 'not_found' });
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      const file = resolveStaticFile(root, pathname);
      if (file) return sendFile(request, reply, root, file);
    }
    reply.header('Cache-Control', HTML_CACHE_CONTROL);
    return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
  });
}

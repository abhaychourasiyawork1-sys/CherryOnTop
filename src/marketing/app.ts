import Fastify, { type FastifyInstance } from 'fastify';
import { loadMarketingConfig, type MarketingConfig } from './config.js';
import { createMarketingDb, type MarketingDb } from './db.js';
import { createRateLimiter } from './rate-limit.js';
import { waitlistRequestSchema } from './schemas.js';
import { addToWaitlist } from './waitlist.js';

const MAX_BODY_BYTES = 20 * 1024;
const WAITLIST_RATE_LIMIT = { windowMs: 60_000, max: 20 };

export interface MarketingApp extends FastifyInstance {
  marketingDb: MarketingDb;
}

export function buildMarketingApp(configOverrides: Partial<MarketingConfig> = {}): MarketingApp {
  const config: MarketingConfig = { ...loadMarketingConfig(process.env), ...configOverrides };
  const db = createMarketingDb(config.dbPath);
  const limiter = createRateLimiter(WAITLIST_RATE_LIMIT);

  const fastify = Fastify({
    trustProxy: config.trustProxy,
    bodyLimit: MAX_BODY_BYTES,
    logger: false,
  });
  const app = fastify as unknown as MarketingApp;

  app.marketingDb = db;

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    reply.header(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "img-src 'self' data:",
        "media-src 'self'",
        "font-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self'",
        "connect-src 'self'",
      ].join('; '),
    );
    if (config.allowedOrigin) {
      reply.header('Access-Control-Allow-Origin', config.allowedOrigin);
    }
    return payload;
  });

  app.get('/api/health', async () => ({ status: 'ok' }));

  app.post('/api/waitlist', async (request, reply) => {
    if (request.headers['content-type']?.includes('application/json') !== true) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    if (!limiter.consume(request.ip)) {
      return reply.code(429).send({ error: 'rate_limited' });
    }

    const parsed = waitlistRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    if (config.consentVersion && parsed.data.consentVersion !== config.consentVersion) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    try {
      const result = addToWaitlist(db, parsed.data);
      return reply.code(202).send(result);
    } catch {
      return reply.code(500).send({ error: 'internal_error' });
    }
  });

  app.setErrorHandler((error: { statusCode?: number }, _request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (statusCode === 413) {
      reply.code(413).send({ error: 'payload_too_large' });
      return;
    }
    reply.code(statusCode >= 400 && statusCode < 500 ? statusCode : 500).send({ error: 'request_error' });
  });

  app.addHook('onClose', async () => {
    db.close();
  });

  return app;
}

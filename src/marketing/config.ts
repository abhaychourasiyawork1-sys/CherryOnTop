import os from 'node:os';
import path from 'node:path';

export interface MarketingConfig {
  port: number;
  host: string;
  dbPath: string;
  siteDir: string;
  allowedOrigin?: string;
  trustProxy: boolean;
  consentVersion?: string;
  /** Extra origin allowed by CSP `media-src` when the promo video is hosted elsewhere. */
  mediaOrigin?: string;
}

const DEFAULT_DB_PATH = path.join(os.homedir(), '.cherryontop', 'marketing.db');

export function loadMarketingConfig(env: NodeJS.ProcessEnv): MarketingConfig {
  return {
    port: Number(env.MARKETING_PORT ?? 4178),
    host: env.MARKETING_HOST ?? '127.0.0.1',
    dbPath: env.MARKETING_DB_PATH ?? DEFAULT_DB_PATH,
    siteDir: env.MARKETING_SITE_DIR ?? 'site/dist',
    allowedOrigin: env.MARKETING_ALLOWED_ORIGIN,
    trustProxy: env.MARKETING_TRUST_PROXY === 'true',
    consentVersion: env.MARKETING_CONSENT_VERSION,
    mediaOrigin: env.MARKETING_MEDIA_ORIGIN || undefined,
  };
}

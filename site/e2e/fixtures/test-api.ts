/**
 * E2E server fixture: the real marketing API (waitlist + analytics) on a temporary
 * SQLite database, serving the built site from site/dist on the same origin — the
 * production arrangement. Started by playwright.config.ts `webServer`.
 *
 *   E2E_PORT=4173 node --import tsx e2e/fixtures/test-api.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMarketingApp } from '../../../src/marketing/app';

export const E2E_PORT = Number(process.env.E2E_PORT ?? 4173);
export const E2E_ORIGIN = `http://127.0.0.1:${E2E_PORT}`;

async function main(): Promise<void> {
  const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist');
  if (!fs.existsSync(path.join(siteDir, 'index.html'))) {
    throw new Error(`site build missing at ${siteDir}; run npm run build first`);
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cherryontop-e2e-'));
  const app = buildMarketingApp({
    dbPath: path.join(tmpDir, 'marketing.db'),
    siteDir,
    trustProxy: false,
    consentVersion: undefined,
  });

  const stop = async (): Promise<void> => {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(0);
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());

  await app.listen({ port: E2E_PORT, host: '127.0.0.1' });
  console.log(`e2e marketing fixture listening on ${E2E_ORIGIN}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}

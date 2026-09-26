import { buildMarketingApp } from '../src/marketing/app.js';
import { loadMarketingConfig } from '../src/marketing/config.js';

// Public marketing service only: waitlist + analytics APIs and the built site.
// Deliberately independent of the runtime daemon's startup (no Kubernetes, no adapters, no tRPC).
const config = loadMarketingConfig(process.env);
const app = buildMarketingApp(config);

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  // eslint-disable-next-line no-console
  console.log(`marketing server received ${signal}, closing`);
  let exitCode = 0;
  try {
    // Closes the listener and, via the onClose hook, the marketing SQLite database.
    await app.close();
  } catch (error: unknown) {
    exitCode = 1;
    // eslint-disable-next-line no-console
    console.error('marketing server shutdown failed', error);
  }
  process.exit(exitCode);
}

process.once('SIGINT', (signal) => void shutdown(signal));
process.once('SIGTERM', (signal) => void shutdown(signal));

app
  .listen({ port: config.port, host: config.host })
  .then(() => {
    // eslint-disable-next-line no-console
    console.log(`marketing server listening on http://${config.host}:${config.port} (site: ${config.siteDir})`);
  })
  .catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error('failed to start marketing server', error);
    process.exit(1);
  });

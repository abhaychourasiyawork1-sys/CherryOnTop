import { buildMarketingApp } from '../src/marketing/app.js';
import { loadMarketingConfig } from '../src/marketing/config.js';

const config = loadMarketingConfig(process.env);
const app = buildMarketingApp(config);

async function shutdown(signal: string): Promise<void> {
  try {
    await app.close();
  } finally {
    process.exit(0);
  }
  void signal;
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

app
  .listen({ port: config.port, host: config.host })
  .then(() => {
    // eslint-disable-next-line no-console
    console.log(`marketing server listening on http://${config.host}:${config.port}`);
  })
  .catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error('failed to start marketing server', error);
    process.exit(1);
  });

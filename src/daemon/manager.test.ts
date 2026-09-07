import { describe, it, expect, afterAll } from 'vitest';
import { startDaemon, stopDaemon, daemonStatus } from './manager.js';

// Integration test: drives the real pm2 daemon against the built entry script,
// so it needs `npm run build` first and is slower than the rest of the suite.
process.env.ORG_DB_PATH = new URL('../../test-daemon.db', import.meta.url).pathname;
// Its own pm2 app name and port. Without these the test drove the *user's*
// daemon: `stopDaemon()` killed whatever run was in flight, so running the
// suite while using the tool destroyed the work in progress.
process.env.ORG_DAEMON_NAME = 'org-daemon-test';
process.env.ORG_DAEMON_PORT = '4179';

describe('daemon manager', () => {
  afterAll(async () => {
    await stopDaemon().catch(() => {});
  });

  it('reports not running before start', async () => {
    await stopDaemon().catch(() => {});
    const status = await daemonStatus();
    expect(status.running).toBe(false);
  });

  it('starts the daemon and reports it running with a pid', async () => {
    await startDaemon();
    await new Promise((r) => setTimeout(r, 1500));
    const status = await daemonStatus();
    expect(status.running).toBe(true);
    expect(typeof status.pid).toBe('number');
  }, 20000);

  it('stops the daemon and reports not running', async () => {
    await stopDaemon();
    const status = await daemonStatus();
    expect(status.running).toBe(false);
  });
});

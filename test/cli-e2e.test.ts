import { describe, it, expect, afterAll } from 'vitest';
import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import { stopDaemon } from '../src/daemon/manager.js';

const CLI = './dist/cli/index.js';
const TEST_DB = fileURLToPath(new URL('../test-e2e.db', import.meta.url));
const ENV = { ORG_DB_PATH: TEST_DB, ORG_DAEMON_PORT: '4188', ORG_DAEMON_NAME: 'org-daemon-e2e' };

// Distinct pm2 app name + port so this file does not race the manager integration test.
Object.assign(process.env, ENV);

describe('CLI end-to-end', () => {
  afterAll(async () => {
    await stopDaemon().catch(() => {});
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      rmSync(TEST_DB + suffix, { force: true });
    }
  });

  it('org run creates a node, org tree lists it', async () => {
    await stopDaemon().catch(() => {});
    const runResult = await execa('node', [CLI, 'run', 'end-to-end test goal'], { env: ENV });
    expect(runResult.stdout).toContain('Root node created:');

    const treeResult = await execa('node', [CLI, 'tree'], { env: ENV });
    expect(treeResult.stdout).toContain('end-to-end test goal');
  }, 30000);
});

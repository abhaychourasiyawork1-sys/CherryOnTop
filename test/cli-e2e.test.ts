import { describe, it, expect, afterAll } from 'vitest';
import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import { stopDaemon } from '../src/daemon/manager.js';

const CLI = './dist/cli/index.js';
const TEST_DB = fileURLToPath(new URL('../test-e2e.db', import.meta.url));
// A node now drives itself into a real Kubernetes dispatch with no external
// event, so this e2e run needs the stopgap image (the default runner image is
// unpublished and would leave a Job stuck in ContainerCreating).
// The key is a placeholder: this run uses the stopgap image, which never calls
// the API. It is present because `org run` refuses to dispatch without one —
// that guard is the fix for a daemon holding a stale, keyless environment.
const ENV = {
  ORG_DB_PATH: TEST_DB, ORG_DAEMON_PORT: '4188', ORG_DAEMON_NAME: 'org-daemon-e2e',
  ORG_RUNNER_IMAGE: 'busybox:1.36', ORG_WORKTREE_PATH: '/tmp',
  ANTHROPIC_API_KEY: 'sk-ant-e2e-placeholder',
};

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

    // Let the node reach a terminal state before afterAll kills the daemon:
    // stopping it mid-dispatch orphans the Job, Secret and NetworkPolicy it
    // created, since the cleanup runs in the daemon that is about to die.
    for (let i = 0; i < 40; i++) {
      const { stdout } = await execa('node', [CLI, 'tree'], { env: ENV });
      if (/COMPLETE|FAILED/.test(stdout)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }, 60000);
});

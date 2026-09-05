import os from 'node:os';
import type { Command } from 'commander';
import { toContainerPath } from '../../k8s/kind.js';
import { daemonStatus, startDaemon, stopDaemon } from '../../daemon/manager.js';
import { createDaemonClient } from '../../daemon/client.js';
import { hasOauthCredentials } from '../../execution/credentials.js';
import { nonNegativeNumber, resolveRepoPath } from '../validation.js';

async function waitForDaemon(retries = 20): Promise<void> {
  const client = createDaemonClient();
  for (let i = 0; i < retries; i++) {
    try {
      await client.daemon.ping.query();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error('Daemon did not become ready in time');
}

export function registerRunCommand(program: Command): void {
  program
    .command('run <goal>')
    .description('Create a root accountable node for the given goal')
    .option('--spawn', 'allow this node to delegate to child nodes', false)
    .option('--budget <usd>', 'budget in USD (a child costs 1; below that, delegation escalates)', nonNegativeNumber('--budget'), 0)
    .option('--max-children <n>', 'maximum children, which also bounds delegation depth', nonNegativeNumber('--max-children'), 0)
    .option('--repo <path>', 'local repository the node should operate on (defaults to the current directory)')
    .action(async (goal: string, options: { spawn: boolean; budget: number; maxChildren: number; repo?: string }) => {
      // Validated here, at the boundary closest to the user, so a path the
      // sandbox cannot see fails before a node is ever created. The .git check
      // is the second half of that guard: the mounted directory is handed to an
      // agent running with permission prompts disabled, so "the directory I
      // happened to be standing in" is not good enough.
      let repo: string;
      let repoPath: string;
      try {
        repo = resolveRepoPath(options.repo);
        repoPath = toContainerPath(repo);
      } catch (err) {
        console.error(`${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
        return;
      }
      const status = await daemonStatus();
      if (!status.running) {
        console.log('Daemon not running — starting...');
        await startDaemon();
      }
      await waitForDaemon();
      let client = createDaemonClient();

      const oauth = hasOauthCredentials(os.homedir());
      if (!oauth && !process.env.ANTHROPIC_API_KEY) {
        console.error('No Claude authentication found — every step would fail inside the sandbox.');
        console.error('Either run `claude login` to use your subscription, or export ANTHROPIC_API_KEY=sk-ant-...  (see `org doctor`)');
        process.exitCode = 1;
        return;
      }
      // Only the ANTHROPIC_API_KEY env-var path can go stale: the daemon
      // captures its environment once, at start, so exporting the key after
      // the daemon is already running leaves it invisible until a restart. The
      // OAuth path has no such gap — credentials.ts reads the subscription's
      // file fresh from disk on every single dispatch.
      if (!oauth && !(await client.daemon.ping.query()).hasApiKey) {
        console.log('Daemon was started without ANTHROPIC_API_KEY — restarting it so this run can authenticate...');
        await stopDaemon();
        await startDaemon();
        await waitForDaemon();
        client = createDaemonClient();
      }
      const result = await client.node.create.mutate({
        goal,
        definition_of_done: [goal],
        authority: {
          tools: [],
          spawn_children: options.spawn,
          max_child_count: options.maxChildren,
          budget_usd: options.budget,
        },
        constraints: [],
        repoPath,
      });
      console.log(`Root node created: ${result.id}`);
      console.log(`Operating on: ${repo} (mounted at ${repoPath} inside the sandbox)`);
    });
}

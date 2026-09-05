import path from 'node:path';
import type { Command } from 'commander';
import { toContainerPath } from '../../k8s/kind.js';
import { daemonStatus, startDaemon } from '../../daemon/manager.js';
import { createDaemonClient } from '../../daemon/client.js';

function nonNegativeNumber(label: string) {
  return (raw: string): number => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${label} must be a non-negative number, got "${raw}"`);
    }
    return value;
  };
}

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
      // sandbox cannot see fails before a node is ever created.
      const repoPath = toContainerPath(path.resolve(options.repo ?? process.cwd()));
      const status = await daemonStatus();
      if (!status.running) {
        console.log('Daemon not running — starting...');
        await startDaemon();
      }
      await waitForDaemon();
      const client = createDaemonClient();
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
      console.log(`Operating on: ${path.resolve(options.repo ?? process.cwd())} (mounted at ${repoPath} inside the sandbox)`);
    });
}

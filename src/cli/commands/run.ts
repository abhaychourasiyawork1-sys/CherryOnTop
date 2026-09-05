import type { Command } from 'commander';
import { daemonStatus, startDaemon } from '../../daemon/manager.js';
import { createDaemonClient } from '../../daemon/client.js';

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
    .option('--budget <usd>', 'budget in USD (a child costs 1; below that, delegation escalates)', '0')
    .option('--max-children <n>', 'maximum children, which also bounds delegation depth', '0')
    .action(async (goal: string, options: { spawn: boolean; budget: string; maxChildren: string }) => {
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
          max_child_count: Number(options.maxChildren),
          budget_usd: Number(options.budget),
        },
        constraints: [],
      });
      console.log(`Root node created: ${result.id}`);
    });
}

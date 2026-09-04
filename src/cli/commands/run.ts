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
    .action(async (goal: string) => {
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
        authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 0 },
        constraints: [],
      });
      console.log(`Root node created: ${result.id}`);
    });
}

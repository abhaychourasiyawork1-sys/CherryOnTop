import type { Command } from 'commander';
import { createDaemonClient } from '../../daemon/client.js';

export function registerTreeCommand(program: Command): void {
  program
    .command('tree')
    .description('Show the organization tree')
    .action(async () => {
      const client = createDaemonClient();
      const nodeList = await client.node.tree.query();
      for (const node of nodeList) {
        console.log(`${node.id}  ${node.state}  ${node.goal}`);
      }
    });
}

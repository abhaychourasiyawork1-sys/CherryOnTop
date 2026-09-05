import type { Command } from 'commander';
import { createDaemonClient } from '../../daemon/client.js';

export function registerCommitmentCommand(program: Command): void {
  program
    .command('commitment <nodeId>')
    .description('List commitments for a node')
    .action(async (nodeId: string) => {
      const client = createDaemonClient();
      const commitments = await client.commitment.listForNode.query({ nodeId });
      if (commitments.length === 0) {
        console.log('No commitments for this node.');
        return;
      }
      for (const c of commitments) {
        console.log(`${c.id}  ${c.status.padEnd(10)} ${c.goal}`);
      }
    });
}

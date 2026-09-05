import type { Command } from 'commander';
import { createDaemonClient } from '../../daemon/client.js';

export function registerDecisionCommand(program: Command): void {
  program
    .command('decision <nodeId>')
    .description('Show evidence-backed decisions for a node, with their full score breakdown')
    .action(async (nodeId: string) => {
      const client = createDaemonClient();
      const decisions = await client.decision.listForNode.query({ nodeId });
      if (decisions.length === 0) {
        console.log('No decisions recorded for this node.');
        return;
      }
      for (const d of decisions) {
        console.log(`${d.id}  ${d.outcome}`);
        for (const [key, value] of Object.entries(d.breakdown)) {
          console.log(`  ${key}: ${value}`);
        }
      }
    });
}

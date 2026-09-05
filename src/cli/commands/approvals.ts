import type { Command } from 'commander';
import { createDaemonClient } from '../../daemon/client.js';

export function registerApprovalsCommand(program: Command): void {
  program
    .command('approvals')
    .description('List pending authority-boundary escalations awaiting approval')
    .action(async () => {
      const client = createDaemonClient();
      const pending = await client.node.listPendingApprovals.query();
      if (pending.length === 0) {
        console.log('No pending approvals.');
        return;
      }
      for (const approval of pending) {
        console.log(`${approval.id}  node=${approval.nodeId}  ${approval.reason}`);
        console.log(`  org approve ${approval.id}   |   org reject ${approval.id}`);
      }
    });
}

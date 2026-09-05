import type { Command } from 'commander';
import { createDaemonClient } from '../../daemon/client.js';

export function registerApproveCommand(program: Command): void {
  program
    .command('approve <approvalId>')
    .description('Approve a pending authority-boundary escalation')
    .action(async (approvalId: string) => {
      const client = createDaemonClient();
      await client.node.resolveApproval.mutate({ approvalId, decision: 'approved' });
      console.log(`Approved ${approvalId}.`);
    });

  program
    .command('reject <approvalId>')
    .description('Reject a pending authority-boundary escalation')
    .action(async (approvalId: string) => {
      const client = createDaemonClient();
      await client.node.resolveApproval.mutate({ approvalId, decision: 'rejected' });
      console.log(`Rejected ${approvalId}.`);
    });
}

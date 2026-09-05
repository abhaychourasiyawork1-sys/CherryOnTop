import type { Command } from 'commander';
import { createDaemonClient } from '../../daemon/client.js';

async function resolve(approvalId: string, decision: 'approved' | 'rejected'): Promise<void> {
  const client = createDaemonClient();
  try {
    await client.node.resolveApproval.mutate({ approvalId, decision });
  } catch (err) {
    console.error(`Could not ${decision === 'approved' ? 'approve' : 'reject'} ${approvalId}: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`${decision === 'approved' ? 'Approved' : 'Rejected'} ${approvalId}.`);
}

export function registerApproveCommand(program: Command): void {
  program
    .command('approve <approvalId>')
    .description('Approve a pending authority-boundary escalation')
    .action((approvalId: string) => resolve(approvalId, 'approved'));

  program
    .command('reject <approvalId>')
    .description('Reject a pending authority-boundary escalation')
    .action((approvalId: string) => resolve(approvalId, 'rejected'));
}

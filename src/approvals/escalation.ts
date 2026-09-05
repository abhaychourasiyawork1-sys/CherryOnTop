import { randomUUID } from 'node:crypto';
import notifier from 'node-notifier';

export interface EscalationDeps {
  insertApproval: (record: { id: string; nodeId: string; reason: string; status: 'pending'; createdAt: string }) => void;
  notify: (message: string) => void;
}

function realNotify(message: string): void {
  // A test run should not pop desktop notifications on whoever is running it.
  if (process.env.NODE_ENV === 'test') return;
  notifier.notify({ title: 'Accountable Org — approval needed', message });
}

export async function escalate(
  nodeId: string,
  reason: string,
  deps: Partial<EscalationDeps> = {},
): Promise<string> {
  const id = randomUUID();
  const insertApproval = deps.insertApproval ?? (() => {
    throw new Error('escalate() called without an insertApproval dependency in production wiring');
  });
  const notify = deps.notify ?? realNotify;

  insertApproval({ id, nodeId, reason, status: 'pending', createdAt: new Date().toISOString() });
  notify(`Node ${nodeId} needs approval: ${reason} — run \`org approve ${id}\` or \`org reject ${id}\``);
  return id;
}

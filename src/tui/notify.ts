import notifier from 'node-notifier';

// Session-scoped: /notify toggles it, and it deliberately does not persist —
// a preference that survives invisibly is worse than one you set when you care.
let enabled = true;

export function toggleNotify(): boolean {
  enabled = !enabled;
  return enabled;
}

export function notifyApprovalNeeded(nodeId: string, goal: string): void {
  if (!enabled) return;
  notifier.notify({ title: 'org — approval needed', message: `${nodeId.slice(0, 8)} · ${goal}` });
}

export function notifyFinished(nodeId: string, goal: string, state: string): void {
  if (!enabled) return;
  notifier.notify({ title: `org — ${state.toLowerCase()}`, message: `${nodeId.slice(0, 8)} · ${goal}` });
}

import type { OrgEvent } from './eventLog.js';

export interface LedgerEntry {
  key: string;
  kind: 'decision' | 'artifact' | 'denial' | 'approval';
  nodeId: string;
  at: string;
  title: string;
  detail?: string;
  decision?: { id: string; type: string; outcome: string; breakdown: Record<string, number>; createdAt: string };
}

export interface LedgerInput {
  nodeIds: string[];
  events: OrgEvent[];
  decisions: { id: string; nodeId: string; type: string; outcome: string; breakdown: Record<string, number>; createdAt: string }[];
  artifacts: { id: string; nodeId: string; kind: string; path: string | null; summary: string; createdAt: string }[];
  approvals: { id: string; nodeId: string; reason: string; status: string; createdAt: string; resolvedAt?: string }[];
}

export function outcomeTitle(outcome: string): string {
  if (outcome === 'DELEGATE') return 'Delegated the work';
  if (outcome === 'SELF_EXECUTE') return 'Did the work itself';
  if (outcome === 'ESCALATE') return 'Stopped and asked you';
  return outcome;
}

export function approvalTitle(status: string): string {
  if (status === 'approved') return 'You allowed it';
  if (status === 'rejected') return 'You refused it';
  if (status === 'cancelled') return 'Withdrawn — the run stopped first';
  return 'Waiting on you';
}

function clipText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`;
}

/**
 * Everything on one case's record, newest first.
 *
 * Every source is scoped to this case's own agents. The event stream is
 * window-wide — every open case shares it — so an unscoped filter puts another
 * case's refusal into this one's record, which is the worst possible defect in
 * a view called Proof.
 */
export function toLedgerEntries(input: LedgerInput): LedgerEntry[] {
  const mine = new Set(input.nodeIds);
  const entries: LedgerEntry[] = [];

  for (const decision of input.decisions) {
    if (!mine.has(decision.nodeId)) continue;
    entries.push({
      key: `d-${decision.id}`, kind: 'decision', nodeId: decision.nodeId, at: decision.createdAt,
      title: decision.type === 'runtime_selection' ? `Chose ${decision.outcome}` : outcomeTitle(decision.outcome),
      decision,
    });
  }

  for (const artifact of input.artifacts) {
    if (!mine.has(artifact.nodeId)) continue;
    entries.push({
      key: `a-${artifact.id}`, kind: 'artifact', nodeId: artifact.nodeId, at: artifact.createdAt,
      title: artifact.path ?? clipText(artifact.summary, 80),
      detail: artifact.kind.replace('_', ' '),
    });
  }

  for (const approval of input.approvals) {
    if (!mine.has(approval.nodeId)) continue;
    entries.push({
      key: `p-${approval.id}`, kind: 'approval', nodeId: approval.nodeId,
      at: approval.resolvedAt ?? approval.createdAt,
      title: approvalTitle(approval.status),
      detail: approval.reason,
    });
  }

  for (const event of input.events) {
    if (event.type !== 'authority.denied' || !mine.has(event.nodeId)) continue;
    const tool = (event.payload as { tool?: string } | null)?.tool ?? 'a tool';
    entries.push({
      key: `x-${event.id}`, kind: 'denial', nodeId: event.nodeId, at: event.createdAt,
      title: `Refused ${tool}`,
      detail: 'Its mandate does not grant this tool.',
    });
  }

  return entries.sort((a, b) => b.at.localeCompare(a.at));
}

export type Lens = 'all' | 'decisions' | 'produced' | 'authority' | 'people';

export function matchesLens(entry: LedgerEntry, lens: Lens): boolean {
  if (lens === 'all') return true;
  if (lens === 'decisions') return entry.kind === 'decision';
  if (lens === 'produced') return entry.kind === 'artifact';
  if (lens === 'authority') return entry.kind === 'denial' || entry.kind === 'approval';
  return entry.kind === 'approval';
}

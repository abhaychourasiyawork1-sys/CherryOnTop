import { useMemo } from 'react';
import { daemon } from './client.js';
import { useDaemonQuery } from './useDaemonQuery.js';
import { mergeEvents, type OrgEvent } from './eventLog.js';
import type { OrgNode } from './useOrg.js';
import type { DecisionRow } from './decisionView.js';
import type { ArtifactRow, DodProgress } from './run.js';
import type { CaseFile } from '../panels/CaseHeader.js';

/** Reads scoped to one case. Each takes a `stamp` that changes only when
 *  something in *that* case changed, so one busy run does not make every other
 *  case on screen re-read the daemon on each of its events. */

export function caseStamp(subtree: OrgNode[]): string {
  let latest = '';
  let cost = 0;
  for (const node of subtree) {
    if (node.updatedAt > latest) latest = node.updatedAt;
    cost += node.costUsd;
  }
  return `${subtree.length}|${latest}|${cost.toFixed(4)}`;
}

export type CaseSummary = CaseFile & {
  artifacts: ArtifactRow[];
  approvals: { id: string; nodeId: string; reason: string; status: string; createdAt: string; resolvedAt?: string }[];
  answer: string | null;
  dod: CaseFile['dod'] & { progress: DodProgress };
};

export function useCaseFile(caseId: string | null, stamp: string) {
  return useDaemonQuery<CaseSummary | null>(
    () => (caseId ? daemon().case.file.query({ id: caseId }) as Promise<CaseSummary> : Promise.resolve(null)),
    [caseId, stamp],
  );
}

export interface CaseReceipt {
  node: OrgNode;
  nodes: OrgNode[];
  mandate: { id: string; name: string; constraints: string[] } | null;
  decisions: DecisionRow[];
  artifacts: (ArtifactRow & { eventId?: number | null })[];
  approvals: { id: string; nodeId: string; reason: string; status: string; createdAt: string; resolvedAt?: string }[];
  dod: { items: { id: string; nodeId: string; text: string; state: 'met' | 'unmet' | 'unverified'; checkedAt: string | null; note: string | null; artifactId: string | null }[]; progress: DodProgress };
  costUsd: number;
  budgetUsd: number;
  answer: string | null;
}

export function useCaseReceipt(caseId: string | null, stamp: string) {
  return useDaemonQuery<CaseReceipt | null>(
    () => (caseId ? daemon().case.receipt.query({ id: caseId }) as unknown as Promise<CaseReceipt> : Promise.resolve(null)),
    [caseId, stamp],
  );
}

/** A case's whole history plus whatever has arrived live since it was read. */
export function useCaseEvents(caseId: string | null, stamp: string, live: OrgEvent[], scope: Set<string>, limit?: number) {
  // `limit` keeps the newest events only — enough for "what happened last"
  // without paying for a whole transcript.
  const history = useDaemonQuery<OrgEvent[]>(
    () => (caseId ? daemon().events.forCase.query({ id: caseId, ...(limit ? { limit } : {}) }) as Promise<OrgEvent[]> : Promise.resolve([])),
    [caseId, stamp, limit],
  );
  const events = useMemo(
    () => mergeEvents(history.data ?? [], live.filter((event) => scope.has(event.nodeId))),
    [history.data, live, scope],
  );
  return { events, loading: history.loading && !history.data, error: history.error };
}

import { eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { events, approvals } from '../schema.js';
import { listNodes, subtreeNodeIds, type NodeRecord } from './nodes.js';
import { getSubtreeCosts, budgetHealth } from './stats.js';
import { listDodForNode, dodProgress, type DodItemRecord } from './dod.js';
import { listMandates } from './mandates.js';

export type CaseOutcome =
  | 'running' | 'waiting' | 'interrupted' | 'complete' | 'failed' | 'cancelled';

export interface CaseSummary {
  id: string;
  goal: string;
  state: string;
  outcome: CaseOutcome;
  mandateId: string | null;
  mandateName: string | null;
  runtime: string | null;
  repoPath: string | null;
  agents: number;
  costUsd: number;
  budgetUsd: number;
  budgetHealth: number;
  durationMs: number;
  dod: ReturnType<typeof dodProgress>;
  pendingApprovals: number;
  /** Times a person actually decided something on this case. The number that
   *  answers "did a human touch this?" without reading the log. */
  humanDecisions: number;
  /** Tool calls refused because the mandate did not permit them. */
  denials: number;
  createdAt: string;
  updatedAt: string;
}

export interface CaseFilters {
  search?: string;
  outcomes?: CaseOutcome[];
  mandateIds?: string[];
  runtimes?: string[];
  repoPaths?: string[];
  /** 'met' keeps only cases whose whole definition of done is met; 'unmet'
   *  keeps the ones with something outstanding. */
  dod?: 'met' | 'outstanding';
  intervened?: boolean;
  minCostUsd?: number;
  maxCostUsd?: number;
  since?: string;
  until?: string;
}

function outcomeOf(node: NodeRecord, pending: number): CaseOutcome {
  if (node.state === 'COMPLETE') return 'complete';
  if (node.state === 'FAILED') return 'failed';
  if (node.state === 'CANCELLED') return 'cancelled';
  if (node.state === 'INTERRUPTED') return 'interrupted';
  return pending > 0 ? 'waiting' : 'running';
}

/**
 * Every run ever, as rows a person can search.
 *
 * ponytail: the whole node table is read and filtered in JS. An organization is
 * tens of nodes and a machine's history is thousands of rows, so this is one
 * scan against an index-free SQLite file and comfortably fast. Push the filters
 * into SQL when a real user's history makes the scan show up in a profile.
 */
export function listCases(db: Db, filters: CaseFilters = {}): CaseSummary[] {
  const all = listNodes(db);
  const roots = all.filter((node) => node.parentId === null);
  if (roots.length === 0) return [];

  const costs = getSubtreeCosts(db);
  const mandateNames = new Map(listMandates(db).map((m) => [m.id, m.name]));

  const allApprovals = db.select().from(approvals).all();
  const denialRows = db.select().from(events).where(eq(events.type, 'authority.denied')).all();

  const summaries = roots.map((root) => {
    const subtree = subtreeNodeIds(db, root.id);
    const ids = new Set(subtree);
    const mine = allApprovals.filter((a) => ids.has(a.nodeId));
    const pending = mine.filter((a) => a.status === 'pending').length;

    // The whole subtree's definition of done, not just the root's: a case is
    // done when the organization is done, and a child's unmet item is the
    // case's unmet item.
    const items: DodItemRecord[] = subtree.flatMap((id) => listDodForNode(db, id));

    const costUsd = costs.get(root.id) ?? 0;
    const budgetUsd = root.contract.authority.budget_usd;

    return {
      id: root.id,
      goal: root.goal,
      state: root.state,
      outcome: outcomeOf(root, pending),
      mandateId: root.mandateId ?? null,
      mandateName: root.mandateId ? mandateNames.get(root.mandateId) ?? null : null,
      runtime: root.runtime ?? null,
      repoPath: root.repoPath ?? null,
      agents: subtree.length,
      costUsd,
      budgetUsd,
      budgetHealth: budgetHealth(costUsd, budgetUsd),
      durationMs: Math.max(0, Date.parse(root.updatedAt) - Date.parse(root.createdAt)),
      dod: dodProgress(items),
      pendingApprovals: pending,
      humanDecisions: mine.filter((a) => a.status === 'approved' || a.status === 'rejected').length,
      denials: denialRows.filter((row) => ids.has(row.nodeId)).length,
      createdAt: root.createdAt,
      updatedAt: root.updatedAt,
    } satisfies CaseSummary;
  });

  return summaries.filter((c) => matches(c, filters))
    // Newest first: the run you just started is the one you want to see.
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function matches(c: CaseSummary, f: CaseFilters): boolean {
  if (f.search && !c.goal.toLowerCase().includes(f.search.toLowerCase())) return false;
  if (f.outcomes?.length && !f.outcomes.includes(c.outcome)) return false;
  if (f.mandateIds?.length && !(c.mandateId && f.mandateIds.includes(c.mandateId))) return false;
  if (f.runtimes?.length && !(c.runtime && f.runtimes.includes(c.runtime))) return false;
  if (f.repoPaths?.length && !(c.repoPath && f.repoPaths.includes(c.repoPath))) return false;
  // A case with no definition-of-done rows is not "fully met" — it is unknown,
  // and answering "yes" to `dod: met` for it would be the checklist lying.
  if (f.dod === 'met' && !(c.dod.total > 0 && c.dod.met === c.dod.total)) return false;
  if (f.dod === 'outstanding' && c.dod.total > 0 && c.dod.met === c.dod.total) return false;
  if (f.intervened !== undefined && (c.humanDecisions > 0) !== f.intervened) return false;
  if (f.minCostUsd !== undefined && c.costUsd < f.minCostUsd) return false;
  if (f.maxCostUsd !== undefined && c.costUsd > f.maxCostUsd) return false;
  if (f.since && c.createdAt < f.since) return false;
  if (f.until && c.createdAt > f.until) return false;
  return true;
}

/** The distinct values the Cases filters offer, taken from what actually
 *  exists. A filter for a runtime nothing ever ran under is noise. */
export function caseFacets(db: Db): { runtimes: string[]; repoPaths: string[]; mandates: { id: string; name: string }[] } {
  const roots = listNodes(db).filter((node) => node.parentId === null);
  const mandates = listMandates(db);
  const used = new Set(roots.map((r) => r.mandateId).filter(Boolean));
  return {
    runtimes: [...new Set(listNodes(db).map((n) => n.runtime).filter((r): r is string => Boolean(r)))].sort(),
    repoPaths: [...new Set(roots.map((r) => r.repoPath).filter((p): p is string => Boolean(p)))].sort(),
    mandates: mandates.filter((m) => used.has(m.id)).map((m) => ({ id: m.id, name: m.name })),
  };
}

/** Everything the attention queue watches, in one pass. Not only approvals:
 *  "what needs me" is also a run that blew its budget, one that went quiet, one
 *  a restart parked, and one that finished without meeting what it promised. */
export type AttentionKind = 'approval' | 'over_budget' | 'stalled' | 'interrupted' | 'dod_unmet' | 'denied';

export interface AttentionItem {
  kind: AttentionKind;
  nodeId: string;
  caseId: string;
  caseGoal: string;
  nodeGoal: string;
  detail: string;
  approvalId?: string;
  at: string;
}

const RUNNING_TERMINAL = new Set(['COMPLETE', 'FAILED', 'CANCELLED', 'INTERRUPTED']);

export function listAttention(
  db: Db,
  now = Date.now(),
  stalledAfterMs = 5 * 60_000,
): AttentionItem[] {
  const all = listNodes(db);
  const byId = new Map(all.map((n) => [n.id, n]));
  const rootOf = (node: NodeRecord): NodeRecord => {
    let current = node;
    const seen = new Set<string>();
    while (current.parentId && !seen.has(current.id)) {
      seen.add(current.id);
      current = byId.get(current.parentId) ?? current;
    }
    return current;
  };
  const costs = getSubtreeCosts(db);
  const items: AttentionItem[] = [];

  const add = (node: NodeRecord, kind: AttentionKind, detail: string, at: string, approvalId?: string) => {
    const root = rootOf(node);
    items.push({ kind, nodeId: node.id, caseId: root.id, caseGoal: root.goal, nodeGoal: node.goal, detail, at, approvalId });
  };

  for (const approval of db.select().from(approvals).where(eq(approvals.status, 'pending')).all()) {
    const node = byId.get(approval.nodeId);
    if (node) add(node, 'approval', approval.reason, approval.createdAt, approval.id);
  }

  for (const node of all) {
    const cost = costs.get(node.id) ?? 0;
    const budget = node.contract.authority.budget_usd;
    if (budget > 0 && cost > budget) {
      add(node, 'over_budget', `Spent $${cost.toFixed(2)} against a $${budget.toFixed(2)} ceiling`, node.updatedAt);
    }
    if (node.state === 'INTERRUPTED') {
      add(node, 'interrupted', 'Stopped when the daemon did. Its work is kept — resume to carry on.', node.updatedAt);
    }
    if (!RUNNING_TERMINAL.has(node.state) && now - Date.parse(node.updatedAt) > stalledAfterMs) {
      const minutes = Math.round((now - Date.parse(node.updatedAt)) / 60_000);
      add(node, 'stalled', `No progress for ${minutes} minutes`, node.updatedAt);
    }
    if (node.state === 'COMPLETE') {
      const unmet = listDodForNode(db, node.id).filter((item) => item.state === 'unmet');
      if (unmet.length > 0) {
        add(node, 'dod_unmet', `Finished with ${unmet.length} of its checks unmet`, node.updatedAt);
      }
    }
  }

  for (const row of db.select().from(events).where(eq(events.type, 'authority.denied')).all()) {
    const node = byId.get(row.nodeId);
    const tool = (row.payload as { tool?: string } | null)?.tool ?? 'a tool';
    if (node) add(node, 'denied', `Reached for ${tool}, which its mandate does not permit`, row.createdAt);
  }

  return items.sort((a, b) => rank(a.kind) - rank(b.kind) || b.at.localeCompare(a.at));
}

/** What to look at first. Ordered by who is blocked: a person deciding beats
 *  money already spent, which beats a run that merely went quiet. */
const ORDER: AttentionKind[] = ['approval', 'interrupted', 'over_budget', 'denied', 'dod_unmet', 'stalled'];
function rank(kind: AttentionKind): number {
  return ORDER.indexOf(kind);
}

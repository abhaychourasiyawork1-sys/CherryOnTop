import { isTerminal } from './state.js';
import { titleOf, phaseOf } from './run.js';
import type { OrgNode } from './useOrg.js';
import type { OrgEvent } from './eventLog.js';

/** The organization's plan for one case, as work rather than tickets.
 *
 *  A delegating root's plan *is* its children — each is a piece of work some
 *  agent is accountable for. A root that did the work itself has the runtime's
 *  execution template for its task class instead. Either way the plan is read
 *  from the record, and every change to it (a step pruned, a failed piece
 *  handed to a fresh agent) is a revision with a stated reason, so an abandoned
 *  step never silently disappears. */

export type StepStatus = 'done' | 'active' | 'pending' | 'failed' | 'replaced' | 'stopped';

export interface PlanStep {
  id: string;
  title: string;
  status: StepStatus;
  nodeId: string | null;
  /** Work under this step, for "3 sub-steps". */
  depth: number;
  replacedBy?: string;
}

export interface PlanRevision {
  id: string;
  at: string;
  change: 'removed' | 'replaced' | 'split';
  what: string;
  reason: string;
}

export interface Plan {
  steps: PlanStep[];
  revisions: PlanRevision[];
  source: 'agents' | 'template' | 'none';
}

function statusOf(node: OrgNode): StepStatus {
  if (node.state === 'COMPLETE') return 'done';
  if (node.state === 'FAILED') return node.supersededBy ? 'replaced' : 'failed';
  if (node.state === 'CANCELLED') return 'stopped';
  if (node.state === 'CREATED') return 'pending';
  return 'active';
}

export function planOf(root: OrgNode, subtree: OrgNode[], events: OrgEvent[]): Plan {
  const children = subtree
    .filter((node) => node.parentId === root.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const revisions: PlanRevision[] = [];
  for (const event of events) {
    if (event.nodeId !== root.id && !children.some((child) => child.id === event.nodeId)) continue;
    const payload = event.payload as { removed?: { name: string; reason: string }[]; groups?: string[][] } | null;
    if (event.type === 'execution.plan') {
      for (const removed of payload?.removed ?? []) {
        revisions.push({ id: `${event.id}:${removed.name}`, at: event.createdAt, change: 'removed', what: removed.name, reason: removed.reason });
      }
    }
    if (event.type === 'delegation.scheduled' && event.nodeId === root.id) {
      const count = (payload?.groups ?? []).flat().length;
      if (count > 1) revisions.push({ id: `${event.id}`, at: event.createdAt, change: 'split', what: `Split into ${count} pieces`, reason: 'The work divides into independent parts.' });
    }
  }
  for (const child of children) {
    if (child.supersededBy) {
      revisions.push({
        id: `replaced:${child.id}`, at: child.updatedAt, change: 'replaced',
        what: titleOf(child.goal), reason: 'It failed, so a fresh agent took the work over.',
      });
    }
  }
  revisions.sort((a, b) => a.at.localeCompare(b.at));

  if (children.length > 0) {
    const below = (id: string): number => subtree.filter((node) => node.parentId === id).length;
    return {
      source: 'agents',
      revisions,
      steps: children.map((child) => ({
        id: child.id,
        title: titleOf(child.goal),
        status: statusOf(child),
        nodeId: child.id,
        depth: below(child.id),
        ...(child.supersededBy ? { replacedBy: child.supersededBy } : {}),
      })),
    };
  }

  const template = [...events].reverse().find((event) => event.nodeId === root.id && event.type === 'execution.plan');
  const steps = (template?.payload as { steps?: { name: string }[] } | undefined)?.steps ?? [];
  if (steps.length === 0) return { steps: [], revisions, source: 'none' };

  const phase = phaseOf(root, subtree);
  const activeIndex = phase === 'investigating' ? 0 : steps.length - 1;
  return {
    source: 'template',
    revisions,
    steps: steps.map((step, index) => ({
      id: `${root.id}:${index}`,
      title: step.name.replace(/^./, (c) => c.toUpperCase()),
      nodeId: null,
      depth: 0,
      status: root.state === 'COMPLETE' ? 'done'
        : isTerminal(root.state) ? (index < activeIndex ? 'done' : root.state === 'FAILED' ? 'failed' : 'stopped')
          : index < activeIndex ? 'done' : index === activeIndex ? 'active' : 'pending',
    })),
  };
}

export const STEP_MARK: Record<StepStatus, string> = {
  done: '✓',
  active: '●',
  pending: '○',
  failed: '✕',
  replaced: '↻',
  stopped: '–',
};

export const STEP_LABEL: Record<StepStatus, string> = {
  done: 'Done',
  active: 'In progress',
  pending: 'Not started',
  failed: 'Failed',
  replaced: 'Replaced',
  stopped: 'Stopped',
};

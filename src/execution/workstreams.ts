/** Which pieces of work can happen at once, and what they would each pay to
 *  find out the same thing.
 *
 *  The rule this exists to *not* implement is `multi_workstream -> parallel`.
 *  Running N children concurrently is the most expensive thing this runtime can
 *  do and the easiest to justify badly: it looks like a latency win, and on a
 *  broad goal it is mostly N sandboxes re-reading the same repository. A
 *  measured fan-out here cost five times one dispatch and answered a fifth of
 *  the question each, which is why the default child cap is two.
 *
 *  So parallelism is a *candidate*, priced like any other: latency saved
 *  against coordination paid, and the coordination is real — every extra branch
 *  pays for the context it needs, and branches that need the same context pay
 *  for it more than once.
 *
 *  Four kinds of dependency, kept apart because they have opposite
 *  consequences:
 *
 *   - **input / output / validation** dependencies *order* work. B needs what A
 *     produced, so B cannot start until A has.
 *   - **information** dependencies do not. Two branches needing to understand
 *     the same module can run at once — they just should not both pay to
 *     discover it, which is what `sharedEvidenceIds` is for.
 *
 *  Collapsing those into one "depends on" edge is the mistake that makes a
 *  scheduler either serialize everything (treating shared knowledge as an
 *  ordering constraint) or race (treating a real ordering constraint as shared
 *  knowledge). The first is slow; the second is a corrupted worktree.
 *
 *  Deterministic and total: no model, no clock, no I/O. */
import { clamp01 } from '../efficiency/policy-types.js';
import { actionCandidate, type ActionCandidate } from '../decision/actions.js';
import type { EconomicState } from '../decision/state.js';

export interface WorkstreamNode {
  id: string;
  /** Work whose *output* this consumes. Orders. */
  inputDependencies: string[];
  /** Knowledge this needs. Does not order — two branches can learn the same
   *  thing at the same time, and the point is that they should not have to. */
  informationDependencies: string[];
  /** Work that consumes *this* one's output. Orders, in the other direction. */
  outputDependencies: string[];
  /** Work whose result this must be checked against. Orders. */
  validationDependencies: string[];
  /** Paths this will change. Two branches writing the same path is not a cost,
   *  it is a correctness failure. */
  writePaths: string[];
}

export interface WorkstreamPlan {
  nodes: WorkstreamNode[];
  /** Knowledge more than one branch needs. Acquiring it once and handing it to
   *  all of them is the saving parallelism has to beat its own coordination
   *  cost with. */
  sharedEvidenceIds: string[];
  /** Branches that may run together, in the order the groups must run.
   *  A plan with one node per group is a serial plan, and that is a perfectly
   *  good answer. */
  parallelGroups: string[][];
  /** Why anything was kept apart, in a form a person can act on. */
  serializationReasons: string[];
  /** How many times over the shared knowledge would be paid for if every branch
   *  went and found it itself. Zero when nothing is shared. */
  informationDuplication: number;
}

export const EMPTY_PLAN: WorkstreamPlan = {
  nodes: [], sharedEvidenceIds: [], parallelGroups: [],
  serializationReasons: [], informationDuplication: 0,
};

function normalize(node: WorkstreamNode): WorkstreamNode {
  return {
    id: node.id,
    inputDependencies: [...new Set(node.inputDependencies ?? [])].sort(),
    informationDependencies: [...new Set(node.informationDependencies ?? [])].sort(),
    outputDependencies: [...new Set(node.outputDependencies ?? [])].sort(),
    validationDependencies: [...new Set(node.validationDependencies ?? [])].sort(),
    writePaths: [...new Set(node.writePaths ?? [])].sort(),
  };
}

/** Who must wait for whom.
 *
 *  Built once, as directed edges, rather than asked pairwise. The direction is
 *  the part that is easy to get wrong: an *output* dependency is stated from
 *  the producing side — "B consumes mine" — and orders B after A, while an
 *  *input* dependency says the same thing from the other end. Detecting that a
 *  pair is ordered without knowing which way round it goes is worse than not
 *  detecting it, because the scheduler then runs them in whichever order the
 *  sort happened to produce.
 *
 *  Information dependencies contribute nothing here. Including them is how a
 *  scheduler serializes two branches that merely need to understand the same
 *  module — which is most of them, on any real goal. */
function orderingEdges(nodes: WorkstreamNode[], known: Set<string>): Map<string, Set<string>> {
  const waits = new Map<string, Set<string>>(nodes.map((node) => [node.id, new Set<string>()]));
  const require = (waiter: string, prerequisite: string) => {
    if (!known.has(prerequisite) || !known.has(waiter) || waiter === prerequisite) return;
    waits.get(waiter)!.add(prerequisite);
  };
  for (const node of nodes) {
    for (const id of node.inputDependencies) require(node.id, id);
    for (const id of node.validationDependencies) require(node.id, id);
    // Stated from the producing side, and therefore reversed here.
    for (const id of node.outputDependencies) require(id, node.id);
  }
  return waits;
}

/** Two branches that must not run together, and why.
 *
 *  Ordering is already handled by the edges above, so this is only about
 *  branches that are free to run in either order and must not run at the *same
 *  time*. Today that is exactly one thing. */
function conflictBetween(a: WorkstreamNode, b: WorkstreamNode): string | null {
  const overlap = a.writePaths.filter((path) => b.writePaths.includes(path));
  if (overlap.length === 0) return null;
  // Not a cost. Two branches writing one file produce a tree neither of them
  // expected, and no amount of latency saved is worth that.
  const [first, second] = [a.id, b.id].sort();
  return `write_conflict:${first}+${second}:${overlap.join(',')}`;
}

export interface PlanWorkstreamsInput {
  nodes: WorkstreamNode[];
  /** What one piece of shared knowledge costs to acquire, in tokens. Used only
   *  to price duplication; absent means the caller does not know, and
   *  duplication is reported as a count of redundant acquisitions instead. */
  evidenceTokenCost?: (evidenceId: string) => number;
}

/** The schedule, and what it would cost to ignore it. */
export function planWorkstreams(input: PlanWorkstreamsInput): WorkstreamPlan {
  const nodes = (input.nodes ?? []).map(normalize)
    // Deterministic input order, so the same plan comes out of the same set
    // whatever order the caller happened to build it in.
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (nodes.length === 0) return { ...EMPTY_PLAN };

  const known = new Set(nodes.map((node) => node.id));
  const waits = orderingEdges(nodes, known);

  // What each branch needs to know, and how many branches need it.
  const needCounts = new Map<string, number>();
  for (const node of nodes) {
    for (const evidence of node.informationDependencies) {
      needCounts.set(evidence, (needCounts.get(evidence) ?? 0) + 1);
    }
  }
  const sharedEvidenceIds = [...needCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort();

  // What it would cost to let every branch find it itself. The saving shared
  // evidence offers, and the number parallelism has to beat with it.
  const informationDuplication = sharedEvidenceIds.reduce((sum, id) => {
    const redundant = (needCounts.get(id) ?? 1) - 1;
    return sum + redundant * (input.evidenceTokenCost?.(id) ?? 1);
  }, 0);

  const serializationReasons: string[] = [];
  const parallelGroups: string[][] = [];
  const scheduled = new Set<string>();

  // Layered: everything whose ordering constraints are already satisfied can go
  // in this round, minus whatever conflicts with something already in it.
  let guard = nodes.length + 1;
  while (scheduled.size < nodes.length && guard-- > 0) {
    const ready = nodes.filter((node) =>
      !scheduled.has(node.id) && [...waits.get(node.id)!].every((id) => scheduled.has(id)));

    if (ready.length === 0) {
      // A cycle. Every remaining branch waits for another that is waiting for
      // it. Scheduling them one at a time is not correct, but it is *safe* —
      // and refusing to plan at all would take down a dispatch over a graph
      // this module did not build.
      const remaining = nodes.filter((node) => !scheduled.has(node.id));
      serializationReasons.push(`dependency_cycle:${remaining.map((n) => n.id).join(',')}`);
      for (const node of remaining) {
        parallelGroups.push([node.id]);
        scheduled.add(node.id);
      }
      break;
    }

    const group: WorkstreamNode[] = [];
    for (const node of ready) {
      const blocker = group.map((other) => conflictBetween(other, node)).find(Boolean);
      if (blocker) { serializationReasons.push(blocker); continue; }
      group.push(node);
    }

    // Waiting for an earlier branch is an ordering fact, not a conflict, and is
    // recorded once per branch that waits rather than per pair.
    for (const node of group) {
      const waiting = [...waits.get(node.id)!].sort();
      if (waiting.length > 0) {
        serializationReasons.push(`ordered_after:${node.id}<-${waiting.join(',')}`);
      }
    }

    parallelGroups.push(group.map((node) => node.id).sort());
    for (const node of group) scheduled.add(node.id);
  }

  return {
    nodes,
    sharedEvidenceIds,
    parallelGroups,
    serializationReasons: [...new Set(serializationReasons)].sort(),
    informationDuplication,
  };
}

/** Everything that cannot proceed if this branch fails, transitively.
 *
 *  The distinction this exists to draw: a branch that failed takes down what
 *  depended on its *output*, and nothing else. Two branches that merely needed
 *  to understand the same module are unrelated — one failing says nothing about
 *  the other, and cancelling it would throw away work that was going fine.
 *
 *  That is why information dependencies contribute no ordering edges: they
 *  would make every branch on a shared-context goal a dependent of every other,
 *  and one failure would cancel the lot. */
export function dependentsOf(nodes: WorkstreamNode[], failedId: string): string[] {
  const normalized = nodes.map(normalize);
  const known = new Set(normalized.map((node) => node.id));
  const waits = orderingEdges(normalized, known);

  const fallen = new Set<string>([failedId]);
  // Repeat until nothing new falls: a dependent of a dependent is also lost,
  // and the graph is small enough that a fixed point is cheaper than a
  // traversal nobody can read.
  for (let round = 0; round < normalized.length; round++) {
    let grew = false;
    for (const node of normalized) {
      if (fallen.has(node.id)) continue;
      if ([...waits.get(node.id)!].some((id) => fallen.has(id))) {
        fallen.add(node.id);
        grew = true;
      }
    }
    if (!grew) break;
  }

  fallen.delete(failedId);
  return [...fallen].sort();
}

/** What running a group concurrently costs in coordination.
 *
 *  Every branch beyond the first pays for its own context, and branches that
 *  need the same knowledge pay for it more than once unless it is acquired and
 *  shared. Reported per group rather than per plan, because that is the
 *  granularity the decision is made at. */
export function coordinationCostOf(
  plan: WorkstreamPlan,
  group: string[],
  contextTokensPerBranch: number,
): number {
  const extraBranches = Math.max(0, group.length - 1);
  const shared = new Set(plan.sharedEvidenceIds);
  const duplicated = plan.nodes
    .filter((node) => group.includes(node.id))
    .reduce((sum, node) => sum + node.informationDependencies.filter((id) => shared.has(id)).length, 0);
  return extraBranches * Math.max(0, contextTokensPerBranch) + Math.max(0, duplicated - shared.size);
}

export interface SchedulingCandidateInput {
  plan: WorkstreamPlan;
  state: EconomicState;
  /** What one branch's context costs. The dominant term in coordination. */
  contextTokensPerBranch: number;
  /** How long one branch is expected to take. The dominant term in what
   *  parallelism buys. */
  branchLatencyMs: number;
}

/** Parallelizing and serializing, as options the engine ranks against
 *  everything else.
 *
 *  Deliberately produced as a *pair* whenever a group has more than one member:
 *  the alternative to running them together is running them in order, and a
 *  scheduler that only ever proposes the fast option has not made a decision. */
export function schedulingCandidates(input: SchedulingCandidateInput): ActionCandidate[] {
  const { plan, state } = input;
  const out: ActionCandidate[] = [];

  for (const [index, group] of plan.parallelGroups.entries()) {
    if (group.length < 2) continue;

    const coordination = coordinationCostOf(plan, group, input.contextTokensPerBranch);
    // What running them together saves: the wall-clock of all but the longest.
    const latencySaved = Math.max(0, (group.length - 1) * Math.max(0, input.branchLatencyMs));

    out.push(actionCandidate({
      id: `schedule:parallel:${index}`,
      kind: 'parallelize',
      capability: 'execution.workstreams',
      expectedLatencyBenefit: latencySaved,
      // Sharing the evidence is the token saving; it exists whether or not the
      // branches run at once, and is claimed here because this is the decision
      // that makes it available.
      expectedTokenBenefit: plan.informationDuplication,
      coordinationCost: coordination,
      // More branches, more ways for one of them to go wrong.
      failureRisk: clamp01((group.length - 1) * 0.1),
      confidence: state.trajectory.orchestrationConfidence,
      metadata: { group, sharedEvidenceIds: plan.sharedEvidenceIds },
    }));

    out.push(actionCandidate({
      id: `schedule:serial:${index}`,
      kind: 'serialize',
      capability: 'execution.workstreams',
      // Running in order costs no coordination and buys no latency. It is the
      // honest null option, and it wins whenever coordination outweighs the
      // wall-clock — which on a goal whose branches all read the same module is
      // most of the time.
      expectedTokenBenefit: coordination,
      latencyCost: latencySaved,
      confidence: state.trajectory.orchestrationConfidence,
      metadata: { group },
    }));
  }

  return out;
}

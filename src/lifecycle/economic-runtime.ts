/** Where the control plane meets the agent — and where it mostly gets out of
 *  the way.
 *
 *  The architectural commitment this file has to keep is the uncomfortable one:
 *  **the agent is the reasoner, and this is not.** It does not plan, it does not
 *  choose what to read, it does not decide what the work is. It looks at what
 *  the run has already told the runtime, asks whether there is a material
 *  economic opportunity, and in almost every case answers no and returns
 *  nothing. `CONTINUE` is a genuine no-op: the dispatch that follows is
 *  byte-identical to the one that would have happened without any of this.
 *
 *  It also does not own the loop. The CLI owns the loop; `node-actor-manager`
 *  owns the state machine; this is called *at* a boundary those already
 *  established — the moment before a dispatch is built — and returns a decision
 *  the caller may act on. Nothing here starts a sandbox, cancels one, or
 *  changes what state the machine is in.
 *
 *  A separate module rather than three hundred more lines in a sixteen-hundred
 *  line file, because the boundary between "the runtime's state machine" and
 *  "the economic control plane" is exactly the boundary that has to stay legible
 *  for the invariants above to be checkable at all.
 *
 *  Total, everywhere. Every path that could fail returns "no intervention"
 *  rather than throwing: an optimizer that can fail a dispatch by failing to
 *  optimize is worse than no optimizer. */
import type { Db } from '../db/client.js';
import { listEventsForNode } from '../db/queries/events.js';
import { turnsForNode, tokensForNode } from '../db/queries/tokens.js';
import { listDodForNode } from '../db/queries/dod.js';
import type { StructuredEvent } from '../adapters/adapter.js';
import { executionSnapshot } from '../efficiency/progress-signals.js';
import { compareTrajectory, EMPTY_SNAPSHOT, type ExecutionSnapshot } from '../decision/trajectory.js';
import { executionPolicyForGoal } from '../efficiency/policy.js';
import { activePolicyChanges } from '../learning/policy-experiments.js';
import { taskEconomicsFor } from '../efficiency/task-economics.js';
import { judgeTask } from '../intelligence/task-judge.js';
import {
  initialEconomicState, normalizeEconomicState, type EconomicState, type EvidenceRef,
} from '../decision/state.js';
import {
  runDecisionCycle, INITIAL_CADENCE,
  type OrchestrationCadence, type OrchestrationCycleResult,
} from '../decision/orchestration-loop.js';
import { actionCandidate, type ActionCandidate, type ActionDecision } from '../decision/actions.js';
import { registerCandidateSource, historicalEvidenceSource, stateDerivedCandidates } from '../decision/deep-path.js';
import { allocateBudget } from '../decision/budget.js';
import { evaluateRecovery, recoveryCandidate, type RecoveryTombstone } from '../recovery/engine.js';
import { queryKnowledge } from '../evidence/store.js';
import { evaluateHistoricalEvidence } from '../evidence/reuse.js';
import { repoIdentity } from '../execution/git-state.js';

/** What one turn of a dispatch costs, before any run has measured it.
 *
 *  Used only until a node has turns of its own to divide by, at which point its
 *  own measured rate replaces this. Deliberately on the low side: it multiplies
 *  into the task's assumed budget, and overstating a budget makes every
 *  opportunity look affordable. */
const ASSUMED_TOKENS_PER_TURN = 8_000;

/** Ceiling used when the deployment has turned the turn breaker off entirely
 *  (`ORG_MAX_TURNS_EXECUTE=0` is the documented "uncapped"). An uncapped run
 *  still needs *some* denominator for "what fraction of the budget is gone", and
 *  this is it — a scale, not a limit, and nothing is stopped by reaching it. */
const UNCAPPED_TURN_SCALE = 100;

/** Per-node working memory for the loop.
 *
 *  Keyed by node rather than held globally: a daemon runs many nodes at once,
 *  and a shared cadence would let a quiet node silence a struggling one. Cleared
 *  when a node ends, so a long-lived daemon does not accumulate one entry per
 *  node it has ever run. */
interface NodeMemory {
  cadence: OrchestrationCadence;
  previous: ExecutionSnapshot;
  sequence: number;
  /** What previous attempts on this node ruled out. Held per node and discarded
   *  with it: a tombstone is only about the run that produced it, and one run's
   *  dead end says nothing about another's. */
  tombstones: RecoveryTombstone[];
  /** Set when this turn's decision was a justified `recover` and it was
   *  actually carried out (the failed strategy tombstoned, a pivot pointer
   *  handed to the next dispatch). Read once by the spend guard's stall check
   *  and cleared — the whole reason it exists: a stall STOP and a justified
   *  pivot can describe the exact same state, and the pivot must get the turn
   *  it was priced for rather than the guard undoing it in the same breath. */
  recoveredThisTurn: boolean;
}

const memory = new Map<string, NodeMemory>();

function memoryFor(nodeId: string): NodeMemory {
  let entry = memory.get(nodeId);
  if (!entry) {
    entry = {
      cadence: INITIAL_CADENCE, previous: EMPTY_SNAPSHOT, sequence: 0, tombstones: [],
      recoveredThisTurn: false,
    };
    memory.set(nodeId, entry);
  }
  return entry;
}

/** Marks that this node's decision cycle just carried out a justified
 *  `recover`. Exported for `carryOut` alone — everywhere else reads the flag,
 *  never sets it. */
export function markRecovered(nodeId: string): void {
  memoryFor(nodeId).recoveredThisTurn = true;
}

/** Reads and clears the flag in one step: a pivot buys the *next* dispatch
 *  attempt a pass on the stall guard, not every attempt from here on. */
export function consumeRecoveryFlag(nodeId: string): boolean {
  const entry = memory.get(nodeId);
  if (!entry?.recoveredThisTurn) return false;
  entry.recoveredThisTurn = false;
  return true;
}

/** Called when a node reaches a terminal state. Exported so the lifecycle can
 *  say so explicitly rather than this module guessing from an absence. */
export function forgetNode(nodeId: string): void {
  memory.delete(nodeId);
}

/** Exists for tests and for `doctor`: a leak here is a slow memory climb in a
 *  daemon that runs for weeks, which is the kind of bug that should be a
 *  failing assertion rather than an incident. */
export function trackedNodeCount(): number {
  return memory.size;
}

/** Records what an attempt ruled out, so the next one does not walk the same
 *  dead end — or pay again for what the first established. */
export function recordRecoveryAttempt(nodeId: string, tombstone: RecoveryTombstone): void {
  memoryFor(nodeId).tombstones.push(tombstone);
}

export function recoveryHistory(nodeId: string): RecoveryTombstone[] {
  return [...(memory.get(nodeId)?.tombstones ?? [])];
}

/** How this run is currently failing, in the stable form the trajectory
 *  fingerprint uses. Null when it is not failing in any one identifiable way —
 *  in which case there is no retry to evaluate, only work to continue. */
function failureSignatureOf(snapshot: ExecutionSnapshot): string | null {
  if (snapshot.failureSignatures.length === 0) return null;
  // The most frequent signature: a run dying three ways has a dominant problem,
  // and retrying against "whatever failed last" would re-target on noise.
  const counts = new Map<string, number>();
  for (const signature of snapshot.failureSignatures) {
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a, countA], [b, countB]) => countB - countA || (a < b ? -1 : 1))[0][0];
}

/** The run's own tool stream, as the events table holds it. */
function execEvents(db: Db, nodeId: string): StructuredEvent[] {
  return listEventsForNode(db, nodeId)
    .filter((row) => row.type.startsWith('exec.'))
    .map((row) => ({ type: row.type.slice('exec.'.length), payload: row.payload } as StructuredEvent));
}

/** What the run has read or worked in, as evidence references.
 *
 *  Derived from the fingerprint rather than from a second pass over the event
 *  log: the snapshot already extracted exactly these subjects, and a second
 *  extraction would be a second answer to "what has this run seen". */
function evidenceFrom(snapshot: ExecutionSnapshot, revision?: string): EvidenceRef[] {
  const seen = new Map<string, EvidenceRef>();
  const add = (target: string, kind: EvidenceRef['kind'], confidence: number) => {
    const id = `observed:${target}`;
    // A target both worked in and searched for is one piece of evidence, and
    // the stronger reading of it wins.
    const existing = seen.get(id);
    if (existing && existing.confidence >= confidence) return;
    seen.set(id, { id, kind, source: `run:${target}`, confidence, repositoryRevision: revision });
  };
  // Something edited or verified is a fact about the tree. Something merely
  // searched for is an observation — the run looked, which is weaker evidence
  // that it found.
  for (const target of snapshot.activeTargets) add(target, 'fact', 0.9);
  for (const target of snapshot.searchTargets) add(target, 'observation', 0.6);
  return [...seen.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Whether anything has actually proved the work.
 *
 *  Read off the definition of done, which is the runtime's existing answer to
 *  "is this finished?" and already refuses to go green on a status flag alone.
 *  Reusing it rather than inventing a parallel notion is what stops the
 *  economic layer and the accountability layer from disagreeing about whether a
 *  task succeeded. */
function validationOf(db: Db, nodeId: string): EconomicState['validation'] {
  try {
    const items = listDodForNode(db, nodeId);
    if (items.length === 0) return { required: false, confidence: 0, status: 'unknown' };
    if (items.some((item) => item.state === 'unmet')) return { required: true, confidence: 1, status: 'failed' };
    const met = items.filter((item) => item.state === 'met').length;
    if (met === items.length) return { required: true, confidence: 1, status: 'passed' };
    return { required: true, confidence: met / items.length, status: 'pending' };
  } catch {
    return { required: true, confidence: 0, status: 'unknown' };
  }
}

export interface ExecutionBoundaryInput {
  nodeId: string;
  goal: string;
  /** Which repository this run is about. Scopes every read of stored
   *  knowledge: a claim about a different repository is not stale, it is
   *  irrelevant. */
  repository?: string;
  /** Files the context selection judged worth opening, if one was just made.
   *
   *  Passed in rather than recomputed: the selection has already priced these
   *  against the repository inventory, and asking a candidate source to do it
   *  again would mean a second scan and a second answer. */
  fullArtifactRequests?: Array<{ path: string; tokens: number; expectedNetValue: number }>;
  /** Already-spent dollars, from the caller, which has them. Kept out of this
   *  module so it does not acquire a second way to ask what a node cost. */
  spentUsd?: number;
  repositoryRevision?: string;
}

/** The state, assembled from what the runtime already records.
 *
 *  Nothing here is new telemetry. Turns and tokens come from the rows
 *  `recordUsage` already writes; the trajectory comes from the tool stream the
 *  live event handler already appends; doubt comes from the same pre-task
 *  signals the context planner already derives; validation comes from the
 *  definition of done the runtime already tracks. That it *can* be assembled
 *  from what exists is the evidence that the state contract describes this
 *  runtime rather than a different one. */
/** How far the node's observable record has moved: the number of runtime
 *  events it has produced. Side-effect free, and it only grows, so a System-1
 *  judgment made against an earlier count can be recognised as stale.
 *  (`EconomicState.version` cannot serve here: this module rebuilds the state
 *  from scratch at every boundary, so it is always 0.) */
export function observedStateVersion(db: Db, nodeId: string): number {
  return execEvents(db, nodeId).length;
}

/** `commit: false` reads the state without advancing the node's trajectory
 *  memory. Any read that is not a boundary evaluation (a System-1 question
 *  asked mid-run) must use it: committing would replace the snapshot the next
 *  boundary compares against, and an identical snapshot reads as "repeating
 *  the same ground". */
export function economicStateFor(db: Db, input: ExecutionBoundaryInput, options: { commit?: boolean } = {}): EconomicState {
  const commit = options.commit ?? true;
  const entry = memoryFor(input.nodeId);
  const signals = taskEconomicsFor(input.goal, judgeTask(input.goal));
  // Validated learning, applied to the economic inputs and nothing else. Empty
  // until a policy candidate has actually cleared its promotion gate, which is
  // the deterministic fallback this whole subsystem is built around.
  const policy = executionPolicyForGoal(input.goal, undefined, activePolicyChanges(db));

  const consumedTokens = tokensForNode(db, input.nodeId);
  const turns = turnsForNode(db, input.nodeId);

  const sequence = entry.sequence + 1;
  const events = execEvents(db, input.nodeId);
  const snapshot = executionSnapshot({
    events,
    sequence,
    tokensConsumed: consumedTokens,
  });
  const trajectory = compareTrajectory(entry.previous, snapshot);
  if (commit) {
    entry.sequence = sequence;
    entry.previous = snapshot;
  }

  const evidence = evidenceFrom(snapshot, input.repositoryRevision);
  const validation = validationOf(db, input.nodeId);

  // The task's own measured rate once it has one, and an assumption until then.
  // Self-calibrating on purpose: a cheap task and an expensive one should not be
  // judged against the same denominator, and the only honest source for which
  // this is is the task itself.
  const tokensPerTurn = turns > 0 ? consumedTokens / turns : ASSUMED_TOKENS_PER_TURN;
  const turnScale = policy.hardTurnCap > 0 ? policy.hardTurnCap : UNCAPPED_TURN_SCALE;
  const totalTokenBudget = Math.max(consumedTokens, Math.round(turnScale * tokensPerTurn));

  const doubt = Math.min(1, Math.max(0, 1 - signals.confidence));
  const base = initialEconomicState({
    goal: input.goal,
    repository: input.repository,
    repositoryRevision: input.repositoryRevision,
    totalTokenBudget,
    validationRequired: validation.required,
  });

  return normalizeEconomicState({
    ...base,
    // The run's own event count, the same number `observedStateVersion`
    // reports. The state is rebuilt from scratch at every boundary, so without
    // this it was always 0, and `runDecisionCycle`'s cadence (which backs off
    // in *versions*) marked every boundary after a node's first as `not_due`:
    // the deep path, recovery and evidence candidates, and System-1's
    // next-action refinement only ever ran at a node's first dispatch.
    version: events.length,
    evidence,
    uncertainty: {
      target: doubt,
      // Evidence in hand is what resolves "where does this live". The run
      // having read nothing and the run having read twenty files are different
      // states, and only the first is one context can help with.
      structural: Math.max(0, (signals.hasExplicitAnchors ? doubt * 0.5 : doubt) - trajectory.informationGain),
      behavioral: signals.investigationLikelihood,
      validation: validation.status === 'passed' ? 0 : Math.max(0, signals.verificationNeed - validation.confidence),
    },
    resources: {
      ...base.resources,
      consumedTokens,
      // The default share of the *task's* budget, deliberately not
      // `policy.optimizationBudget`. That number is the context planner's own
      // allowance — a tenth of the context ceiling, a hundred tokens or so —
      // and using it here made the screen's bar (one deep evaluation over the
      // allowance remaining) sit at nearly 1, so no opportunity short of
      // certainty ever cleared it. Choosing context is one thing the
      // orchestrator spends on, not the whole of what it may spend.
    },
    trajectory: {
      progress: trajectory.progress,
      informationGain: trajectory.informationGain,
      explorationPressure: trajectory.explorationPressure,
      failurePressure: trajectory.failurePressure,
      stateSimilarity: trajectory.stateSimilarity,
      // How much the orchestrator trusts its own reading. A run that has taken
      // no action yet has told us nothing, and an orchestrator reading nothing
      // must be *less* willing to intervene, never more — so this is low early
      // and rises as the trace becomes real, capped by how well we understood
      // the goal in the first place.
      orchestrationConfidence: Math.min(
        signals.confidence,
        Math.min(1, snapshot.totalActions / 5),
      ),
    },
    validation,
    constraints: { ...base.constraints, qualityFloor: base.constraints.qualityFloor },
  });
}

export interface EconomicRuntime {
  /** The decision, or `undefined` when there is nothing to do.
   *
   *  `undefined` and a `continue` decision mean the same thing to the caller and
   *  are deliberately both possible: the first says the cycle did not run, the
   *  second says it ran and found nothing. Only the second costs anything, and
   *  keeping them distinct is what makes the orchestration overhead in the
   *  ledger attributable. */
  onExecutionBoundary(input: ExecutionBoundaryInput): Promise<ActionDecision | undefined>;
}

export interface BoundaryOutcome {
  decision?: ActionDecision;
  state: EconomicState;
  cycle: OrchestrationCycleResult;
}

/** One boundary evaluation, with everything it produced.
 *
 *  The richer sibling of `onExecutionBoundary`: the interface the plan names
 *  returns a decision, and the lifecycle also needs the state and the cost to
 *  record them. Returning both from one call rather than exposing two entry
 *  points keeps "the state a decision was made against" and "the decision"
 *  inseparable, which is what makes a ledger entry checkable afterwards. */
export function evaluateBoundary(db: Db, input: ExecutionBoundaryInput): BoundaryOutcome {
  const unreserved = economicStateFor(db, input);
  const entry = memoryFor(input.nodeId);
  const additionalCandidates = [
    ...evidenceCandidates(input, unreserved),
    ...recoveryCandidates(unreserved, entry),
  ];
  const state = withReserves(unreserved, additionalCandidates);
  const cycle = runDecisionCycle(state, { cadence: entry.cadence, additionalCandidates });
  entry.cadence = cycle.cadence;
  return { decision: cycle.decision, state, cycle };
}

/** Holds back what proving and retrying would cost, when there is something to
 *  prove or something to retry — and nothing otherwise.
 *
 *  `allocateBudget` has been able to compute this since it was written and had
 *  no caller, so `resources.recoveryReserve` was `0` on every production state.
 *  Everything downstream that reads it — `utility.ts`, which excludes the
 *  reserve from what any non-recovery action may afford, and
 *  `evidence-actions.ts`, which floors exploration at it — was therefore
 *  enforcing a reserve of nothing. That is the gap Section 5's "the
 *  verification reserve cannot be consumed by ordinary exploration" names.
 *
 *  Conditional on purpose, which is what keeps it compatible with this
 *  runtime's stated default that **holding nothing back is the default**: the
 *  buckets are filled from opportunities that exist *right now*. A task with no
 *  validation requirement and no failure behind it proposes neither candidate,
 *  both buckets come back zero, and the allocation is exactly what it was
 *  before this function existed. When the run starts failing, or has something
 *  unproven, the reserve appears — and disappears again when the reason does,
 *  without anything having to remember to release it.
 *
 *  The candidates are the deep path's own, imported rather than restated: a
 *  reserve priced on a different estimate from the one the engine ranks with
 *  would fund a validation the engine would never choose. */
function withReserves(state: EconomicState, additional: ActionCandidate[]): EconomicState {
  const opportunities = [...stateDerivedCandidates(state), ...additional];
  const allocation = allocateBudget({ state, opportunities });
  // One number, because `utility.ts` reads one. Both buckets are money the run
  // must not spend on looking around: the distinction between them matters to
  // whoever reads the allocation, not to what exploration may afford.
  const reserve = allocation.recoveryReserve + allocation.validation;
  if (reserve <= 0) return state;
  return normalizeEconomicState({
    ...state,
    resources: { ...state.resources, recoveryReserve: reserve },
  });
}

/** Retrying, as a comparable action — and one that knows what the previous
 *  attempt established.
 *
 *  The generic `deep:recover` candidate the deep path builds from state signals
 *  alone is a reasonable estimate and knows nothing about what has already been
 *  ruled out. This one does, which is what makes a second attempt cheaper than
 *  the first rather than a repeat of it. Both are offered; the engine takes
 *  whichever prices better, and on a node with history that is this one. */
function recoveryCandidates(state: EconomicState, entry: NodeMemory): ActionCandidate[] {
  const failureSignature = failureSignatureOf(entry.previous);
  if (!failureSignature) return [];
  const evaluation = evaluateRecovery({ state, failureSignature, tombstones: entry.tombstones });
  if (!evaluation.justified) return [];
  const candidate = recoveryCandidate(evaluation, state);
  // Carried in metadata rather than recomputed: `carryOut` needs the same
  // signature to tombstone the strategy it is about to rule out, and asking a
  // failure it has already been evaluated against a second time would be
  // another read of `entry.previous` after this turn has already moved on.
  return [{ ...candidate, metadata: { ...candidate.metadata, failureSignature } }];
}

/** The selector's "this one is worth opening" verdicts, as comparable actions.
 *
 *  This is the join the whole evidence story turns on. The selector can price a
 *  file read but must not perform one; the decision layer can compare a file
 *  read against validating, retrying or doing nothing, but knows nothing about
 *  files. Translating one into the other here — and nowhere else — is what
 *  keeps both of those true. */
function evidenceCandidates(input: ExecutionBoundaryInput, state: EconomicState): ActionCandidate[] {
  return (input.fullArtifactRequests ?? []).map((request) => actionCandidate({
    // Stable across boundaries for one file, so two cycles cannot rank the same
    // request differently for want of an id.
    id: `evidence:${request.path}`,
    kind: 'acquire_evidence',
    capability: 'evidence.read-file',
    // The selector's own net value, plus what it cost — the candidate contract
    // wants benefit and cost apart, and the selector reports them combined.
    expectedTokenBenefit: Math.max(0, request.expectedNetValue + request.tokens),
    tokenCost: request.tokens,
    // Reading a file cannot make the result more likely to be wrong. What it
    // can do is cost tokens for nothing, which is the `tokenCost` above.
    qualityRisk: 0,
    expectedInformationGain: state.uncertainty.structural,
    confidence: state.trajectory.orchestrationConfidence,
    metadata: { path: request.path, source: 'context-selection' },
  }));
}

/** Makes stored knowledge visible to the deep path.
 *
 *  Registered rather than imported directly by `deep-path.ts`, because the
 *  direction matters: the decision layer asks whether knowledge is worth
 *  retrieving, and the store has no opinion about the decision. Bound to a
 *  database here — the only layer that has one — and replaced rather than
 *  appended on a second call, so two runtimes in one process do not produce two
 *  copies of every candidate. */
export function registerEvidenceSources(db: Db): () => void {
  return registerCandidateSource('historical-evidence', historicalEvidenceSource({
    lookup: (query) => queryKnowledge(db, query),
    evaluate: (item, state) => evaluateHistoricalEvidence({ item, state }),
  }));
}

/** The runtime the lifecycle holds.
 *
 *  A factory rather than a singleton because it closes over a database handle,
 *  and a process that opens two databases — which the tests do — must not have
 *  one of them silently answering for the other. */
export function createEconomicRuntime(db: Db): EconomicRuntime {
  registerEvidenceSources(db);
  return {
    async onExecutionBoundary(input) {
      try {
        return evaluateBoundary(db, input).decision;
      } catch (err) {
        console.error(`The economic runtime failed at a boundary for ${input.nodeId}; the dispatch proceeds unchanged:`, err);
        return undefined;
      }
    },
  };
}

/** Whether a decision asks the caller to do anything at all.
 *
 *  The one place that knows `continue` is a no-op, so no caller has to
 *  re-derive it — and so that adding a kind that *is* a no-op is one edit
 *  rather than a hunt through call sites. */
export function isIntervention(decision: ActionDecision | undefined): boolean {
  return decision !== undefined && decision.action.kind !== 'continue';
}

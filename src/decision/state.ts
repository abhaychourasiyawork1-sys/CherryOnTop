/** One state value for the whole economic runtime, and one reducer that moves
 *  it.
 *
 *  Before this, "what does the runtime know right now?" was answered by reaching
 *  into six places at once: `taskEconomicsFor` for pre-task priors,
 *  `summarizeExecutionTrajectory` for the tool stream, `getCostForNodes` for
 *  money, `turnsForNode` for turns, the frontier for open questions, the receipt
 *  for what context went. Each is correct and none of them is the state — which
 *  is why the spend guard, the context planner and the decision engine each held
 *  a partial, differently-shaped copy of the same facts and could disagree.
 *
 *  The contract here is deliberately *generic*. Nothing in this file knows what
 *  kind of task is running, and nothing may be added that does: a task class is
 *  at most a weak prior on the numbers below, never a field that selects a
 *  pathway. Every dimension is something any task has — evidence, doubt,
 *  resources, direction of travel — and the decision layers above read only
 *  those.
 *
 *  Two properties the tests pin rather than the comments claim:
 *
 *   - **Snapshots are values.** `applyEconomicEvent` returns a new state and
 *     never touches the one it was given, so a decision made against version 7
 *     can still be explained after version 12 exists.
 *   - **Normalization is total.** A state arriving with a NaN uncertainty or a
 *     budget smaller than what was already spent is a bug in whatever produced
 *     it, and a bug in a *state* must not become a bug in a *dispatch*. Every
 *     field is clamped to something safe rather than trusted. */
import { clamp01 } from '../efficiency/policy-types.js';
// The update rule lives in `uncertainty.ts` and is imported rather than
// restated here. A reducer with its own copy of the arithmetic is a second
// answer to "how much did this evidence teach us", and the two would drift.
import { updateUncertainty as applyObservations } from './uncertainty.js';

export type EvidenceKind = 'fact' | 'observation' | 'hypothesis' | 'validation';
export type UncertaintyKind = 'target' | 'structural' | 'behavioral' | 'validation';

/** A pointer to something the runtime believes, and how it came to believe it.
 *
 *  Never the content. The content lives where it already lived — the event
 *  chain, the artifacts table, the repository — and copying it here would make
 *  the state expensive to carry and the copy a second thing to invalidate. */
export interface EvidenceRef {
  id: string;
  kind: EvidenceKind;
  /** How this was obtained, in a form a person can act on: `read:src/a.ts`,
   *  `grep:refreshSession`, `test:vitest src/a.test.ts`. */
  source: string;
  confidence: number;
  /** The revision this was true of. Absent means "not tied to a revision",
   *  which is weaker evidence than one that is — see `evidence/reuse.ts`. */
  repositoryRevision?: string;
  /** What acquiring it cost. Zero when it was already in hand. */
  tokenCost?: number;
}

/** Four independent doubts, not one confidence number.
 *
 *  Collapsing them is what makes an orchestrator do the wrong thing
 *  confidently: a run that knows exactly which file to change but has no idea
 *  whether its change works has low `structural` and high `validation`
 *  uncertainty, and the response to each is a different action. A single scalar
 *  averages them into a number that recommends neither. */
export interface UncertaintyState {
  /** Do we know *what* is being asked for? */
  target: number;
  /** Do we know *where* in the repository it lives? */
  structural: number;
  /** Do we know *how* the code behaves? */
  behavioral: number;
  /** Do we know whether what we did is correct? */
  validation: number;
}

export interface ResourceState {
  totalTokenBudget: number;
  consumedTokens: number;
  /** Always `max(0, total - consumed)` after normalization. Stored rather than
   *  derived at each call site so two readers cannot compute it differently. */
  remainingTokens: number;
  /** What deciding is allowed to cost, carved out of the total. An optimizer
   *  with no budget of its own is how an optimizer ends up more expensive than
   *  the thing it optimizes. */
  optimizationTokens: number;
  optimizationConsumedTokens: number;
  /** Held back against a retry that is worth making. Released when it stops
   *  being worth making — see `decision/budget.ts`. */
  recoveryReserve: number;
  latencyBudgetMs?: number;
}

/** Where the run is going, as opposed to where it is. Every field is [0,1]. */
export interface TrajectoryState {
  progress: number;
  informationGain: number;
  explorationPressure: number;
  failurePressure: number;
  /** How much this state resembles the previous one. High similarity with low
   *  information gain is a loop; high similarity with high gain is careful
   *  work in one place. */
  stateSimilarity: number;
  /** How much the *orchestrator* trusts its own reading of all of the above.
   *  Low confidence must reduce intervention, never increase it. */
  orchestrationConfidence: number;
}

export interface EconomicState {
  /** Monotonic. Every decision records the version it was made against, so a
   *  decision that arrives late can be recognised as stale rather than applied. */
  version: number;
  goal: string;
  repositoryRevision?: string;
  evidence: EvidenceRef[];
  uncertainty: UncertaintyState;
  resources: ResourceState;
  trajectory: TrajectoryState;
  validation: { required: boolean; confidence: number; status: 'unknown' | 'pending' | 'passed' | 'failed' };
  /** The two things optimization may never buy. */
  constraints: { qualityFloor: number; hardStop: boolean };
  /** What the runtime can actually do right now, named generically. The decision
   *  layer proposes actions against these rather than against a fixed menu, which
   *  is what lets a capability be added without a new pathway. */
  availableCapabilities: string[];
}

/** An observation that a piece of evidence moved one dimension of doubt.
 *
 *  Carried on the event rather than computed by the reducer because only the
 *  producer knows *which* doubt its evidence addressed: reading a file reduces
 *  structural uncertainty, running its test reduces validation uncertainty, and
 *  the reducer cannot tell those apart from the bytes. */
export interface UncertaintyObservation {
  kind: UncertaintyKind;
  before: number;
  after: number;
  sourceEvidenceIds: string[];
  confidence: number;
}

/** Everything that can move the state.
 *
 *  Defined here rather than in `events/` because this is the reducer's input
 *  contract; `events/economic-events.ts` wraps these for the bus and adds
 *  delivery concerns (ids, idempotency) without redefining the payloads. */
export type EconomicEvent =
  | {
      kind: 'TASK_STARTED';
      goal: string;
      repositoryRevision?: string;
      totalTokenBudget: number;
      optimizationTokens?: number;
      recoveryReserve?: number;
      latencyBudgetMs?: number;
      qualityFloor?: number;
      validationRequired?: boolean;
      availableCapabilities?: string[];
      uncertainty?: Partial<UncertaintyState>;
    }
  | {
      kind: 'EVIDENCE_ACQUIRED';
      evidence: EvidenceRef[];
      tokenCost: number;
      uncertainty?: UncertaintyObservation[];
      informationGain?: number;
    }
  | { kind: 'EXECUTION_STEP_COMPLETED'; tokenCost: number; latencyMs: number; succeeded: boolean }
  | { kind: 'PROGRESS_UPDATED'; progress: number; informationGain?: number }
  | { kind: 'FAILURE_DETECTED'; signature: string; tokenCost?: number }
  | { kind: 'TRAJECTORY_STATE_CHANGED'; trajectory: Partial<TrajectoryState> }
  | {
      kind: 'BUDGET_UPDATED';
      totalTokenBudget?: number;
      optimizationTokens?: number;
      recoveryReserve?: number;
      latencyBudgetMs?: number;
    }
  | { kind: 'INTERVENTION_DECIDED'; decisionId: string; action: string; orchestrationCost: number }
  | { kind: 'VALIDATION_RESULT'; passed: boolean; confidence: number; tokenCost: number; evidenceIds: string[] }
  | { kind: 'TASK_COMPLETED'; succeeded: boolean }
  | { kind: 'TASK_FAILED'; reason: string };

/** Maximum doubt, which is the honest starting point: before anything has been
 *  observed, every question about the task is open. Starting lower would make a
 *  fresh run look better-understood than it is, and the decision layer reads
 *  these numbers as permission to *not* gather evidence. */
const FULL_UNCERTAINTY: UncertaintyState = { target: 1, structural: 1, behavioral: 1, validation: 1 };

/** Neutral, not optimistic. `progress: 0` is true of a run that has not started;
 *  `orchestrationConfidence: 0.5` says the orchestrator has no basis yet for
 *  trusting or distrusting its own reading, which is exactly the case. */
const NEUTRAL_TRAJECTORY: TrajectoryState = {
  progress: 0, informationGain: 0, explorationPressure: 0,
  failurePressure: 0, stateSimilarity: 0, orchestrationConfidence: 0.5,
};

/** The share of a task's budget that deciding may consume when nobody said
 *  otherwise. Matches `OPTIMIZATION_SHARE` in `efficiency/policy.ts` — the same
 *  claim, and it must not be possible for the two to drift apart. */
const DEFAULT_OPTIMIZATION_SHARE = 0.1;

/** Below this, the quality floor is not a floor. Zero would let a weighting
 *  trade correctness away entirely, which is the one thing the objective is not
 *  allowed to do. */
const DEFAULT_QUALITY_FLOOR = 0.7;

function nonNegative(value: number | undefined, fallback = 0): number {
  return Number.isFinite(value) && (value as number) >= 0 ? (value as number) : fallback;
}

export function initialEconomicState(input: {
  goal: string;
  totalTokenBudget: number;
  repositoryRevision?: string;
  optimizationTokens?: number;
  qualityFloor?: number;
  validationRequired?: boolean;
  availableCapabilities?: string[];
}): EconomicState {
  const total = nonNegative(input.totalTokenBudget);
  return normalizeEconomicState({
    version: 0,
    goal: input.goal,
    repositoryRevision: input.repositoryRevision,
    evidence: [],
    uncertainty: { ...FULL_UNCERTAINTY },
    resources: {
      totalTokenBudget: total,
      consumedTokens: 0,
      remainingTokens: total,
      optimizationTokens: nonNegative(input.optimizationTokens, Math.round(total * DEFAULT_OPTIMIZATION_SHARE)),
      optimizationConsumedTokens: 0,
      recoveryReserve: 0,
    },
    trajectory: { ...NEUTRAL_TRAJECTORY },
    validation: { required: input.validationRequired ?? true, confidence: 0, status: 'unknown' },
    constraints: { qualityFloor: input.qualityFloor ?? DEFAULT_QUALITY_FLOOR, hardStop: false },
    availableCapabilities: [...(input.availableCapabilities ?? [])],
  });
}

function normalizeEvidence(refs: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  const out: EvidenceRef[] = [];
  for (const ref of refs ?? []) {
    if (!ref || typeof ref.id !== 'string' || seen.has(ref.id)) continue;
    seen.add(ref.id);
    out.push({ ...ref, confidence: clamp01(ref.confidence), tokenCost: nonNegative(ref.tokenCost) });
  }
  return out;
}

/** Total by construction. Anything unreadable becomes the safe middle rather
 *  than propagating a NaN into an arithmetic that decides whether to spend
 *  money. */
export function normalizeEconomicState(state: EconomicState): EconomicState {
  const total = nonNegative(state.resources?.totalTokenBudget);
  const consumed = nonNegative(state.resources?.consumedTokens);
  const optimizationTokens = Math.min(total, nonNegative(state.resources?.optimizationTokens));

  return {
    version: Math.max(0, Math.floor(nonNegative(state.version))),
    goal: typeof state.goal === 'string' ? state.goal : '',
    repositoryRevision: state.repositoryRevision,
    evidence: normalizeEvidence(state.evidence ?? []),
    uncertainty: {
      target: clamp01(state.uncertainty?.target, 0.5),
      structural: clamp01(state.uncertainty?.structural, 0.5),
      behavioral: clamp01(state.uncertainty?.behavioral, 0.5),
      validation: clamp01(state.uncertainty?.validation, 0.5),
    },
    resources: {
      totalTokenBudget: total,
      consumedTokens: consumed,
      // The one derived field, and derived every time: two readers computing it
      // separately is how a budget check and a budget display come to disagree.
      remainingTokens: Math.max(0, total - consumed),
      optimizationTokens,
      optimizationConsumedTokens: nonNegative(state.resources?.optimizationConsumedTokens),
      recoveryReserve: Math.min(total, nonNegative(state.resources?.recoveryReserve)),
      latencyBudgetMs: Number.isFinite(state.resources?.latencyBudgetMs)
        ? Math.max(0, state.resources!.latencyBudgetMs as number)
        : undefined,
    },
    trajectory: {
      progress: clamp01(state.trajectory?.progress),
      informationGain: clamp01(state.trajectory?.informationGain),
      explorationPressure: clamp01(state.trajectory?.explorationPressure),
      failurePressure: clamp01(state.trajectory?.failurePressure),
      stateSimilarity: clamp01(state.trajectory?.stateSimilarity),
      orchestrationConfidence: clamp01(state.trajectory?.orchestrationConfidence, 0.5),
    },
    validation: {
      required: state.validation?.required ?? true,
      confidence: clamp01(state.validation?.confidence),
      status: state.validation?.status ?? 'unknown',
    },
    constraints: {
      qualityFloor: clamp01(state.constraints?.qualityFloor, DEFAULT_QUALITY_FLOOR),
      hardStop: state.constraints?.hardStop === true,
    },
    availableCapabilities: [...new Set(state.availableCapabilities ?? [])],
  };
}

/** How much a single failure moves failure pressure.
 *
 *  Additive and saturating rather than a count with a threshold: "three failures
 *  means stuck" is exactly the universal rule this architecture is not allowed
 *  to encode. Pressure is an input to an economic comparison, not a trigger. */
const FAILURE_STEP = 0.25;

/** Evidence that moved no named dimension still moves the needle a little —
 *  something was learned. Small, because the producer not saying *what* it
 *  learned is itself weak information. */
const UNTARGETED_EVIDENCE_GAIN = 0.1;

/** The next state after one event.
 *
 *  Each branch touches only the dimensions its event is about; everything else
 *  is carried through unchanged, so an event cannot quietly reset a dimension it
 *  says nothing about. */
export function applyEconomicEvent(state: EconomicState, event: EconomicEvent): EconomicState {
  const next = advance(state, event);
  // Normalizing every result rather than trusting each branch: a branch is a
  // place a future edit can break an invariant, and the invariant is the point.
  return normalizeEconomicState({ ...next, version: state.version + 1 });
}

function advance(state: EconomicState, event: EconomicEvent): EconomicState {
  switch (event?.kind) {
    case 'TASK_STARTED': {
      const total = nonNegative(event.totalTokenBudget);
      return {
        ...state,
        goal: event.goal,
        repositoryRevision: event.repositoryRevision ?? state.repositoryRevision,
        uncertainty: { ...state.uncertainty, ...event.uncertainty },
        resources: {
          ...state.resources,
          totalTokenBudget: total,
          optimizationTokens: nonNegative(event.optimizationTokens, Math.round(total * DEFAULT_OPTIMIZATION_SHARE)),
          recoveryReserve: nonNegative(event.recoveryReserve, state.resources.recoveryReserve),
          latencyBudgetMs: event.latencyBudgetMs ?? state.resources.latencyBudgetMs,
        },
        validation: { ...state.validation, required: event.validationRequired ?? state.validation.required },
        constraints: { ...state.constraints, qualityFloor: event.qualityFloor ?? state.constraints.qualityFloor },
        availableCapabilities: event.availableCapabilities ?? state.availableCapabilities,
      };
    }

    case 'EVIDENCE_ACQUIRED': {
      const held = new Set(state.evidence.map((e) => e.id));
      const fresh = (event.evidence ?? []).filter((e) => e && !held.has(e.id));
      // Re-delivery of evidence already held is a no-op *including its price*.
      // A bus that delivers twice must not be able to spend twice.
      if (fresh.length === 0) return state;
      return {
        ...state,
        evidence: [...state.evidence, ...fresh],
        // Evidence already held has already had its effect on doubt; passing
        // the held ids is what stops a redelivery from reducing it twice.
        uncertainty: applyObservations(state.uncertainty, event.uncertainty ?? [], held),
        resources: {
          ...state.resources,
          consumedTokens: state.resources.consumedTokens + nonNegative(event.tokenCost),
        },
        trajectory: {
          ...state.trajectory,
          informationGain: clamp01(
            Number.isFinite(event.informationGain)
              ? (event.informationGain as number)
              : informationGainFrom(state.uncertainty, event.uncertainty ?? [], fresh.length),
          ),
        },
      };
    }

    case 'EXECUTION_STEP_COMPLETED':
      return {
        ...state,
        resources: {
          ...state.resources,
          consumedTokens: state.resources.consumedTokens + nonNegative(event.tokenCost),
        },
        trajectory: event.succeeded
          ? state.trajectory
          : { ...state.trajectory, failurePressure: clamp01(state.trajectory.failurePressure + FAILURE_STEP) },
      };

    case 'PROGRESS_UPDATED':
      return {
        ...state,
        trajectory: {
          ...state.trajectory,
          progress: clamp01(event.progress),
          informationGain: Number.isFinite(event.informationGain)
            ? clamp01(event.informationGain as number)
            : state.trajectory.informationGain,
        },
      };

    case 'FAILURE_DETECTED':
      return {
        ...state,
        resources: {
          ...state.resources,
          consumedTokens: state.resources.consumedTokens + nonNegative(event.tokenCost),
        },
        trajectory: { ...state.trajectory, failurePressure: clamp01(state.trajectory.failurePressure + FAILURE_STEP) },
      };

    case 'TRAJECTORY_STATE_CHANGED':
      return { ...state, trajectory: { ...state.trajectory, ...event.trajectory } };

    case 'BUDGET_UPDATED':
      return {
        ...state,
        resources: {
          ...state.resources,
          totalTokenBudget: nonNegative(event.totalTokenBudget, state.resources.totalTokenBudget),
          optimizationTokens: nonNegative(event.optimizationTokens, state.resources.optimizationTokens),
          recoveryReserve: nonNegative(event.recoveryReserve, state.resources.recoveryReserve),
          latencyBudgetMs: event.latencyBudgetMs ?? state.resources.latencyBudgetMs,
        },
      };

    case 'INTERVENTION_DECIDED':
      // Charged to the optimization allowance, never to the task's own budget.
      // Conflating them would let an expensive orchestrator report itself as
      // cheap work, which is the accounting error this whole subsystem exists
      // to make visible.
      return {
        ...state,
        resources: {
          ...state.resources,
          optimizationConsumedTokens:
            state.resources.optimizationConsumedTokens + nonNegative(event.orchestrationCost),
        },
      };

    case 'VALIDATION_RESULT':
      return {
        ...state,
        resources: {
          ...state.resources,
          consumedTokens: state.resources.consumedTokens + nonNegative(event.tokenCost),
        },
        validation: {
          ...state.validation,
          status: event.passed ? 'passed' : 'failed',
          confidence: clamp01(event.confidence),
        },
        uncertainty: {
          ...state.uncertainty,
          // A validation that ran tells us about correctness whichever way it
          // came out: a red test is not doubt, it is knowledge.
          validation: clamp01(state.uncertainty.validation * (1 - clamp01(event.confidence))),
        },
        trajectory: event.passed
          ? state.trajectory
          : { ...state.trajectory, failurePressure: clamp01(state.trajectory.failurePressure + FAILURE_STEP) },
      };

    case 'TASK_COMPLETED':
    case 'TASK_FAILED':
      return { ...state, constraints: { ...state.constraints, hardStop: true } };

    default:
      // An event this reducer does not know is not an error — a newer producer
      // may emit one — but it must not silently look like it was handled, so
      // the version still advances and nothing else moves.
      return state;
  }
}



/** How much doubt this evidence actually removed, as a fraction of the doubt
 *  there was. Evidence that named no dimension gets a small fixed credit rather
 *  than none — something was learned — and rather than a large one, because not
 *  saying what was learned is itself weak information. */
function informationGainFrom(
  before: UncertaintyState,
  observations: UncertaintyObservation[],
  freshCount: number,
): number {
  if (observations.length === 0) return freshCount > 0 ? UNTARGETED_EVIDENCE_GAIN : 0;
  const after = applyObservations(before, observations);
  const dims: UncertaintyKind[] = ['target', 'structural', 'behavioral', 'validation'];
  const removed = dims.reduce((sum, d) => sum + Math.max(0, before[d] - after[d]), 0);
  const available = dims.reduce((sum, d) => sum + before[d], 0);
  return available <= 0 ? 0 : removed / available;
}

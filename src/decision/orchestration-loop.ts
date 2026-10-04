/** One turn of the control plane: look, maybe think, maybe decide.
 *
 *  Three things this has to get right, and they pull against each other:
 *
 *   1. **Cheap when there is nothing to do.** Which is most of the time. The
 *      screen runs, sees a healthy run, and the loop stops there — the deep
 *      path is never entered, so none of the expensive lookups happen.
 *   2. **Cheaper still when there has been nothing to do for a while.** A run
 *      that has looked healthy for twenty consecutive events does not need
 *      screening on the twenty-first. The interval backs off while the run
 *      stays quiet and collapses to every event the moment it stops being —
 *      which is the opposite of a fixed cadence, where the price of catching a
 *      problem early is paying for the check when there is no problem.
 *   3. **Unable to optimize itself.** A decision cycle that could start inside a
 *      decision cycle would recurse, and would do so only in production, where
 *      the real candidate sources are registered.
 *
 *  What it deliberately does *not* do is act. It returns a decision; the
 *  lifecycle decides whether to carry it out. Keeping those apart is what lets
 *  the whole loop be tested without a sandbox, a database or a clock. */
import { inspectFastPath, type FastPathResult } from './fast-path.js';
import { evaluateDeepPathWithCoverage, deepPathInProgress } from './deep-path.js';
import { chooseEconomicAction } from './engine.js';
import { orchestrationCostOf, FREE_ORCHESTRATION, type OrchestrationCost } from './orchestration-cost.js';
import type { ActionCandidate, ActionDecision } from './actions.js';
import type { EconomicState } from './state.js';
import { detectFaults } from './fallback.js';
import type { DecisionFault } from './utility.js';
import {
  governDecision, concludeLook, observeRisk, lookDue,
  type GovernorContext, type GovernorNodeState, type GovernedDecision,
} from '../governor/governor.js';
import { failureAt } from '../governor/risk.js';
import { DEEP_EVALUATION_TOKEN_COST } from './fast-path.js';

/** How often to look, and why.
 *
 *  Carried by the caller rather than held in module state: a daemon runs many
 *  tasks at once, and a cadence shared between them would let a quiet task
 *  silence a struggling one. */
export interface OrchestrationCadence {
  /** The state version the last cycle actually ran against. */
  lastEvaluatedVersion: number;
  /** How many versions to let pass before looking again. */
  interval: number;
  /** How many consecutive cycles found nothing. The backoff's input. */
  consecutiveNoOps: number;
}

export const INITIAL_CADENCE: OrchestrationCadence = {
  lastEvaluatedVersion: -1, interval: 1, consecutiveNoOps: 0,
};

/** The longest the loop will go without looking.
 *
 *  A ceiling on the backoff, not a schedule. Sixteen events is long enough that
 *  screening a quiet run costs almost nothing and short enough that a run that
 *  turns bad is caught within one dispatch's worth of activity. The backoff
 *  collapses to 1 on any signal at all, so this only ever applies to a run that
 *  has looked healthy sixteen times running. */
export const MAX_CADENCE_INTERVAL = 16;

export interface OrchestrationCycleResult {
  /** Absent only when the cycle was skipped. A cycle that ran always produces a
   *  decision, even if that decision is `continue` — "we looked and there was
   *  nothing to do" is a fact worth recording, and an absent decision would
   *  make it indistinguishable from not having looked. */
  decision?: ActionDecision;
  cost: OrchestrationCost;
  skippedDeepEvaluation: boolean;
  /** What the screen saw. Absent when the cycle was skipped entirely. */
  inspection?: FastPathResult;
  /** The candidates the deep path proposed. Empty when it did not run. */
  candidates: ActionCandidate[];
  /** When to look next. Pass back into the following cycle. */
  cadence: OrchestrationCadence;
  /** What the governor added, when one is running. */
  governed?: GovernedDecision;
}

/** Re-entrancy guard. See `deep-path.ts` for the same pattern and the same
 *  reason: recursion here would only appear in production. */
let running = false;

export interface DecisionCycleInput {
  state: EconomicState;
  cadence?: OrchestrationCadence;
  /** Injected so a cycle is reproducible in a test. Production omits it. */
  nowMs?: () => number;
  /** Candidates the caller already holds and the deep path cannot derive.
   *
   *  The registry in `deep-path.ts` is for sources that are a property of the
   *  process; this is for ones that are a property of *this boundary* — the
   *  context selection just made, the workstream plan just built. Threading them
   *  through rather than stashing them somewhere a registered source could find
   *  them is what keeps a candidate tied to the state it was computed against. */
  additionalCandidates?: ActionCandidate[];
  /** Faults the caller observed; they make interventions infeasible. */
  faults?: readonly DecisionFault[];
  /** The Economic Governor (`governor/governor.ts`), when one is running for
   *  this run. Absent, the cycle is exactly the market this loop always ran. */
  governor?: { ctx: GovernorContext; node: GovernorNodeState };
  /** What the runtime can carry out; see `EconomicDecisionInput.executable`. */
  executable?: (candidate: ActionCandidate) => boolean;
}

/** Runs one cycle.
 *
 *  The plan's signature is `runDecisionCycle(state)`, and that still works: the
 *  cadence is optional and defaults to "look every time", which is the correct
 *  behaviour for a caller that is not tracking one. Everything additional is
 *  returned rather than required.
 *
 *  Total. An orchestrator that can fail a dispatch by failing to orchestrate is
 *  worse than no orchestrator, so every failure path here produces a skipped
 *  cycle rather than an exception. */
export function runDecisionCycle(
  state: EconomicState,
  input: Omit<DecisionCycleInput, 'state'> = {},
): OrchestrationCycleResult {
  const cadence = input.cadence ?? INITIAL_CADENCE;
  const now = input.nowMs ?? Date.now;

  const skipped = (reason: string): OrchestrationCycleResult => ({
    cost: { ...FREE_ORCHESTRATION, reason },
    skippedDeepEvaluation: true,
    candidates: [],
    cadence,
  });

  // Already inside a cycle, or inside a deep evaluation that a candidate source
  // is running. Either way, optimizing the optimization is not a thing this
  // system does.
  if (running || deepPathInProgress()) return skipped('reentrant');

  const governor = input.governor;
  if (governor) governor.node.stats.boundaries += 1;

  // Not yet due. The one place the backoff — or, with the governor's adaptive
  // horizon, the priced horizon — is enforced, and it is enforced before
  // anything is read: a skipped cycle has to be genuinely free or leaving the
  // agent alone saves nothing.
  const adaptive = governor?.ctx.features.adaptiveHorizon === true;
  const due = adaptive
    ? lookDue(state, governor!.node)
    : state.version >= cadence.lastEvaluatedVersion + cadence.interval;
  if (!due) {
    if (governor) governor.node.stats.autonomousBoundaries += 1;
    return skipped('not_due');
  }

  running = true;
  const startedMs = now();
  try {
    const inspection = inspectFastPath(state);
    const risk = governor ? observeRisk(state, governor.ctx, governor.node) : null;
    // Rising risk is a reason to look the screen cannot see: it reads one
    // state, and velocity is a difference between two. Held to the screen's
    // own bar.
    const rising = risk ? Math.max(0, failureAt(risk, governor!.node.horizon?.horizon ?? 1) - risk.immediateFailureProbability) : 0;
    const opportunity = inspection.opportunity || rising > inspection.bar;

    // Nothing worth paying to look into. This is the common case and the whole
    // reason for the screen: the deep path — and every lookup in it — does not
    // happen. The decision is still made, from an empty candidate set, so the
    // run gets an explicit `continue` rather than silence.
    if (!opportunity) {
      const decision = chooseEconomicAction({ state, candidates: [] });
      const governed = governor ? concludeLook({
        state, ctx: governor.ctx, node: governor.node, lookCostTokens: DEEP_EVALUATION_TOKEN_COST,
        governed: {
          decision, packet: null, risk, horizon: null, coverage: [], discovery: null, candidates: [],
          prevention: {}, actionSpaceUncertainty: 0, compositions: 0,
        },
      }) : undefined;
      return {
        decision,
        cost: orchestrationCostOf({ fastPath: true, deepPath: false, candidates: 0, latencyMs: now() - startedMs }),
        skippedDeepEvaluation: true,
        inspection,
        candidates: [],
        cadence: advance(cadence, state.version, true),
        ...(governed ? { governed } : {}),
      };
    }

    const deep = evaluateDeepPathWithCoverage(state);
    const additional = (input.additionalCandidates ?? []).map((c) => (typeof c.metadata.candidateSource === 'string'
      ? c : { ...c, metadata: { ...c.metadata, candidateSource: 'boundary' } }));
    const candidates = [...deep.candidates, ...additional];
    const coverage = [...deep.coverage, { source: 'boundary', version: '1', invoked: true, proposed: additional.length, feasible: 0, rejected: 0 }];
    const faults = [...detectFaults(state), ...(input.faults ?? [])];
    let governed: GovernedDecision | undefined;
    let decision: ActionDecision;
    if (governor) {
      governed = concludeLook({
        state, ctx: governor.ctx, node: governor.node, lookCostTokens: DEEP_EVALUATION_TOKEN_COST,
        governed: governDecision({ state, candidates, coverage, faults, risk, ctx: governor.ctx, node: governor.node, executable: input.executable }),
      });
      decision = governed.decision;
    } else {
      decision = chooseEconomicAction({ state, candidates, faults, executable: input.executable });
    }
    // A cycle that chose to continue found nothing actionable, whatever the
    // screen suspected — so it counts as quiet for the backoff. Otherwise a
    // run with one persistent weak signal would be screened deeply forever.
    const quiet = decision.action.kind === 'continue';

    return {
      decision,
      cost: orchestrationCostOf({
        fastPath: true, deepPath: true, candidates: (governed?.candidates ?? candidates).length, latencyMs: now() - startedMs,
      }),
      skippedDeepEvaluation: false,
      inspection,
      candidates: governed?.candidates ?? candidates,
      cadence: advance(cadence, state.version, quiet),
      ...(governed ? { governed } : {}),
    };
  } catch (err) {
    console.error('The decision cycle failed; the run continues unoptimized:', err);
    return skipped('decision_engine_error');
  } finally {
    running = false;
  }
}

/** The backoff.
 *
 *  Doubles on a quiet cycle and collapses to every-event on any other, so the
 *  cost of watching a healthy run falls away while the responsiveness to one
 *  that turns bad is never traded for it. */
function advance(cadence: OrchestrationCadence, version: number, quiet: boolean): OrchestrationCadence {
  return quiet
    ? {
        lastEvaluatedVersion: version,
        interval: Math.min(MAX_CADENCE_INTERVAL, cadence.interval * 2),
        consecutiveNoOps: cadence.consecutiveNoOps + 1,
      }
    : { lastEvaluatedVersion: version, interval: 1, consecutiveNoOps: 0 };
}

/** True while a cycle is in progress. Exported so a candidate source can assert
 *  it is not about to recurse rather than discovering it from a stack trace. */
export function decisionCycleInProgress(): boolean {
  return running;
}

/** How much a task may spend deciding, reading and working.
 *
 *  Two derivations, both pure functions of the signals and the configured
 *  ceilings, both total. Nothing here reads a repository, calls a model, or
 *  remembers a previous run — which is what makes the same goal produce the
 *  same policy, and therefore the same dispatch context, for the life of a
 *  commit. That stability is not a nicety: the provider's cache is keyed on the
 *  prompt prefix, and a policy that drifted between sibling dispatches would
 *  pay full price for every one of them.
 *
 *  The shape of both derivations is the same idea: **a budget is a ceiling,
 *  and uncertainty raises it.** A task we understand gets a small allowance
 *  because it does not need more; a task we do not understand gets a larger
 *  one, because the failure mode of pruning an unclear goal is an agent that
 *  greps its way back to the same tokens over twenty turns and bills for the
 *  conversation prefix every time. */
import {
  DEFAULT_CONTEXT_POLICY, DEFAULT_EXECUTION_POLICY,
  normalizeContextPolicy, normalizeExecutionPolicy,
  type ContextPolicy, type ExecutionPolicy, type TaskEconomicsSignals,
} from './policy-types.js';
import { taskEconomicsFor } from './task-economics.js';
import type { TaskUnderstanding } from '../intelligence/task-understanding.js';
import { repoMapTokenBudget, taskSpendCapUsd, dispatchOptionsFor, contextPlannerEnabled } from '../config/efficiency.js';
import { policyVersion, CONTEXT_POLICY_VERSION, EXECUTION_POLICY_VERSION } from './policy-version.js';

/** The generation identifiers live in `policy-version.ts` and are re-exported
 *  here, where every existing caller reads them from.
 *
 *  They moved because the composite version has to name them *and* the
 *  architecture *and* the decision engine, and defining them here while
 *  composing them there made the two modules import each other — a cycle that
 *  happens to work under ESM hoisting and stops working the first time either
 *  side needs a value at module scope. */
export { CONTEXT_POLICY_VERSION, EXECUTION_POLICY_VERSION };

/** The most of the context budget that choosing it may itself cost. Optimization
 *  without a budget of its own is how an optimizer ends up more expensive than
 *  the thing it optimizes. */
const OPTIMIZATION_SHARE = 0.1;

/** Turns by difficulty band, before the configured breaker bounds them. These
 *  are circuit breakers, not targets — every one sits above the turn count the
 *  band has actually been measured at, so under normal work none of them ever
 *  fires. */
const TURNS_BY_BAND: Record<TaskEconomicsSignals['complexityBand'], number> = {
  tiny: 20, small: 30, medium: 45, large: 60, unknown: 60,
};

export function contextPolicyFor(signals: TaskEconomicsSignals): ContextPolicy {
  const ceiling = repoMapTokenBudget();
  // Nothing to divide up. Kept explicit rather than falling out of the
  // arithmetic, because `ORG_REPO_MAP_TOKENS=0` is the documented way to switch
  // context off and it must cost nothing at all, not a small fraction.
  if (ceiling <= 0) {
    return normalizeContextPolicy({ tokenBudget: 0, optimizationBudget: 0, confidenceFloor: DEFAULT_CONTEXT_POLICY.confidenceFloor });
  }

  // Breadth and doubt both buy headroom; a named anchor gives some back. The
  // floor is 0.2 rather than 0, because the repository skeleton has to fit
  // inside whatever this returns or selection becomes worse than no selection.
  const share = Math.min(1, Math.max(0.2,
    0.25
    + signals.breadth * 0.45
    + (1 - signals.confidence) * 0.35
    - (signals.hasExplicitAnchors ? 0.1 : 0)
    - (signals.complexityBand === 'tiny' ? 0.15 : 0),
  ));

  return normalizeContextPolicy({
    tokenBudget: Math.round(ceiling * share),
    // Scaled with the context it is choosing: deciding what to send costs in
    // proportion to how much there is to decide about.
    optimizationBudget: Math.round(ceiling * share * OPTIMIZATION_SHARE),
    // Below this, the selector widens instead of narrowing. Anchored goals can
    // afford a higher bar, because they have real evidence to clear it with.
    confidenceFloor: signals.hasExplicitAnchors ? 0.3 : 0.45,
  });
}

export function executionPolicyFor(signals: TaskEconomicsSignals): ExecutionPolicy {
  const context = contextPolicyFor(signals);
  const configured = dispatchOptionsFor('execute').maxTurns;

  // Doubt buys turns for the same reason it buys context: an agent that has to
  // find its own footing needs room to, and the alternative is a run cut off
  // one turn before it would have summarised what it found.
  const banded = TURNS_BY_BAND[signals.complexityBand] * (1 + (1 - signals.confidence) * 0.25);
  // The operator's breaker still wins when they set one; `undefined` is the
  // documented "uncapped", and this must not quietly re-impose a cap there.
  // An operator who *explicitly* sets ORG_MAX_TURNS_EXECUTE gets exactly that
  // cap, up as well as down. Before, the band always won when lower, so a long
  // task could not be given more than ~60-75 turns however it was configured,
  // which is below what the same model used alone on Terminal-Bench
  // vba-userform-port (93). The live spend watchdog now bounds what the extra
  // turns can cost. With nothing set, the default cap and the band apply as
  // before.
  const explicit = Number(process.env.ORG_MAX_TURNS_EXECUTE) > 0 ? configured : undefined;
  const hardTurnCap = explicit !== undefined ? explicit
    : configured === undefined ? Math.round(banded) : Math.min(configured, Math.round(banded));

  return normalizeExecutionPolicy({
    optimizationBudget: context.optimizationBudget,
    contextBudget: context.tokenBudget,
    // Advisory: told to the agent so it summarises rather than being cut off.
    // Investigation legitimately spends its turns looking, so it is told less
    // to hurry.
    softTurnTarget: Math.round(hardTurnCap * (0.45 + signals.investigationLikelihood * 0.25)),
    hardTurnCap,
    spendCapUsd: taskSpendCapUsd(),
    // Exploring *is* the work on an investigation; on a one-file edit, the
    // fifteenth grep is the sign something has gone wrong.
    explorationTolerance: 0.3 + signals.investigationLikelihood * 0.5,
    // How much evidence of progress is demanded once spend is high. A task we
    // understand is held to a higher bar, because there is less excuse for
    // wandering in it.
    confidenceRequirement: 0.15 + signals.confidence * 0.35,
  });
}

/** The policy generation this process is currently running.
 *
 *  Read at the moment a dispatch is recorded rather than baked in at import, so
 *  a deployment that switches the planner off mid-run produces rows that say
 *  so. Two generations in one database have to be distinguishable, or a
 *  comparison across them averages two different systems into one number that
 *  describes neither. */
export function currentPolicyVersions(): { context: string; execution: string; policy: string } {
  const context = contextPlannerEnabled() ? CONTEXT_POLICY_VERSION : 'lexical';
  return {
    context,
    execution: EXECUTION_POLICY_VERSION,
    // The composite that also names the architecture and the decision engine.
    // Recorded beside the two component versions rather than instead of them:
    // the components are what a person reads, and the composite is what a
    // comparison joins on.
    policy: policyVersion({ contextVersion: context }).id,
  };
}

/** The turn cap a dispatch actually runs under.
 *
 *  Two bounds, and the tighter one wins — with one exception that matters:
 *  `configured === undefined` is the documented "uncapped"
 *  (`ORG_MAX_TURNS_EXECUTE=0`), which is an operator switching the breaker off
 *  on purpose. A policy must not be able to switch it back on. */
export function effectiveTurnCap(configured: number | undefined, policy: ExecutionPolicy): number | undefined {
  return configured === undefined ? undefined : Math.min(configured, policy.hardTurnCap);
}

/** The share of the task turn budget reserved for a retry (H2.6 D2,
 *  bench/governor/h26/DESIGN.md §2). Fixed by the design, not a knob. */
export const RETRY_RESERVATION_SHARE = 0.25;

/** D2 is an environment parameter of a benchmark generation: on for every arm
 *  of that generation, off (today's behaviour) everywhere else. */
export function retryReservationEnabled(): boolean {
  return process.env.ORG_TURN_RETRY_RESERVATION === 'on';
}

/** R = ⌈0.25 · T⌉. */
export function retryReservation(taskTurnBudget: number): number {
  return Math.ceil(RETRY_RESERVATION_SHARE * taskTurnBudget);
}

/** The turn cap of one execute dispatch under D2.
 *
 *  The first dispatch may spend the task budget T less the retry reservation
 *  R; every later one may spend whatever is left of T. Turns already spent
 *  before the first dispatch (a plan pass on the same node) come out of the
 *  first dispatch's share, never out of R — otherwise the reservation would
 *  not survive to the retry it exists for. `undefined` T is the documented
 *  "uncapped" and stays uncapped. A result of 0 means no turns are left; the
 *  spend guard, which checks the task total against T, stops the dispatch. */
export function dispatchTurnCap(input: {
  taskTurnBudget: number | undefined;
  turnsUsed: number;
  priorExecuteDispatches: number;
}): number | undefined {
  const T = input.taskTurnBudget;
  if (T === undefined) return undefined;
  const used = Math.max(0, input.turnsUsed);
  if (input.priorExecuteDispatches <= 0) return Math.max(0, T - retryReservation(T) - used);
  return Math.max(0, T - used);
}

/** Fields a learned calibration may move, and nothing else.
 *
 *  Deliberately a list of *economic inputs*. `hardTurnCap` and `spendCapUsd`
 *  are circuit breakers an operator configured — a learning loop that can widen
 *  its own breaker has no breaker — and `optimizationBudget` bounds what the
 *  optimizer may spend deciding, which it must not be able to raise for itself.
 *  `lessons.ts`'s `UNLEARNABLE` covers the safety constraints; this covers the
 *  ones that are merely this module's to defend. */
const CALIBRATABLE = ['contextBudget', 'softTurnTarget', 'explorationTolerance', 'confidenceRequirement'] as const;

/** Applies validated multipliers to the economic inputs of a policy.
 *
 *  Identity when there is nothing validated to apply, which is the common case
 *  and the deterministic fallback every caller already behaves correctly under.
 *  `normalizeExecutionPolicy` runs afterwards regardless, so a calibration
 *  cannot produce a policy the normalizer would have rejected. */
export function calibrate(policy: ExecutionPolicy, changes?: Record<string, number>): ExecutionPolicy {
  if (!changes) return policy;
  const applied: Record<string, number> = { ...policy };
  for (const field of CALIBRATABLE) {
    const multiplier = changes[field];
    if (typeof multiplier !== 'number' || !Number.isFinite(multiplier) || multiplier <= 0) continue;
    // Bounded both ways. A multiplier that can halve a budget repeatedly is a
    // multiplier that can reach zero, and a run with no context budget is not a
    // calibrated run, it is a broken one.
    applied[field] = applied[field] * Math.min(2, Math.max(0.5, multiplier));
  }
  return normalizeExecutionPolicy(applied as unknown as ExecutionPolicy);
}

/** The execution policy for a goal, and the failure story for it.
 *
 *  The runtime's two callers — the turn budget and the spend guard — both sit
 *  on paths where throwing is not an option: one would fail a dispatch, the
 *  other would fail a task at the chokepoint. A policy that cannot be derived
 *  must cost the dispatch its *adaptivity*, never its turn budget, so the catch
 *  returns the fixed defaults this branch already shipped with.
 *
 *  `understanding` is what System-1 has already answered about the task. Without
 *  it the task is assumed to write, and nothing is read from the goal's wording. */
export function executionPolicyForGoal(
  goal: string,
  understanding?: Pick<TaskUnderstanding, 'readOnly' | 'anchors'>,
  calibration?: Record<string, number>,
): ExecutionPolicy {
  try {
    return calibrate(executionPolicyFor(taskEconomicsFor(goal, understanding)), calibration);
  } catch (err) {
    console.error('Falling back to the fixed execution policy:', err);
    return normalizeExecutionPolicy({
      ...DEFAULT_EXECUTION_POLICY,
      contextBudget: DEFAULT_CONTEXT_POLICY.tokenBudget,
      hardTurnCap: dispatchOptionsFor('execute').maxTurns ?? DEFAULT_EXECUTION_POLICY.hardTurnCap,
      spendCapUsd: taskSpendCapUsd(),
    });
  }
}

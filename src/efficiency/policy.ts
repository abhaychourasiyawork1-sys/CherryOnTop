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
import type { TaskVerdict } from '../intelligence/task-judge.js';
import { repoMapTokenBudget, taskSpendCapUsd, dispatchOptionsFor, contextPlannerEnabled } from '../config/efficiency.js';

/** Bumped by hand when a weight below changes. Recorded with every measured
 *  dispatch, so two policy generations in one database are distinguishable
 *  rather than averaged into an uninterpretable middle. */
export const CONTEXT_POLICY_VERSION = 'ctx-1';
export const EXECUTION_POLICY_VERSION = 'exec-1';

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
  const hardTurnCap = configured === undefined ? Math.round(banded) : Math.min(configured, Math.round(banded));

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
export function currentPolicyVersions(): { context: string; execution: string } {
  return {
    context: contextPlannerEnabled() ? CONTEXT_POLICY_VERSION : 'lexical',
    execution: EXECUTION_POLICY_VERSION,
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

/** The execution policy for a goal, and the failure story for it.
 *
 *  The runtime's two callers — the turn budget and the spend guard — both sit
 *  on paths where throwing is not an option: one would fail a dispatch, the
 *  other would fail a task at the chokepoint. A policy that cannot be derived
 *  must cost the dispatch its *adaptivity*, never its turn budget, so the catch
 *  returns the fixed defaults this branch already shipped with.
 *
 *  `verdict` is the classification the chokepoint already computed. Judging the
 *  goal twice gives the same answer — both are pure — but paying twice for an
 *  answer in hand is the habit this subsystem exists to break. */
export function executionPolicyForGoal(goal: string, verdict?: TaskVerdict): ExecutionPolicy {
  try {
    return executionPolicyFor(taskEconomicsFor(goal, verdict));
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

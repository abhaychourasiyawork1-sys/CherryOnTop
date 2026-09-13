/** What the optimizer is allowed to spend, and on what.
 *
 *  Three contracts, deliberately separate:
 *
 *   - `TaskEconomicsSignals` — what we can tell about a task *before* doing it,
 *     read off the goal and nothing else. Every number is normalized to [0,1]
 *     so a weighting can be read without also holding a units table in your
 *     head.
 *   - `ContextPolicy` — what the context planner may spend deciding, and how
 *     much context it may hand over.
 *   - `ExecutionPolicy` — what the dispatch itself may spend: turns, dollars,
 *     and how much unproductive exploration is tolerated before the guard says
 *     stop.
 *
 *  The normalizers below are the whole enforcement story. A policy that arrives
 *  with a negative budget, a soft target above its hard cap, or a NaN is a bug
 *  in whatever produced it — but bugs in a *policy* must not become bugs in a
 *  dispatch, so every field is clamped to something safe rather than trusted. */

export interface TaskEconomicsSignals {
  /** How sure we are that we know what this task is about. Low confidence is a
   *  reason to *widen*, never to prune harder. */
  confidence: number;
  /** How much of the repository the goal reaches across. */
  breadth: number;
  /** The goal named a file, directory or symbol outright. */
  hasExplicitAnchors: boolean;
  /** How much of the tree the work is expected to modify. */
  expectedModificationScope: number;
  /** How much of the work is expected to be looking rather than changing. */
  investigationLikelihood: number;
  /** How much the result needs proving — tests run, a build green. */
  verificationNeed: number;
  /** The task changes nothing. */
  readOnly: boolean;
  complexityBand: 'tiny' | 'small' | 'medium' | 'large' | 'unknown';
}

export interface ContextPolicy {
  /** The ceiling on rendered context. A ceiling, never a target. */
  tokenBudget: number;
  /** What choosing that context may itself cost, in tokens' worth of work.
   *  Optimization with no budget of its own is how an optimizer ends up more
   *  expensive than the thing it optimizes. */
  optimizationBudget: number;
  /** Below this confidence the selector widens instead of narrowing. */
  confidenceFloor: number;
}

export interface ExecutionPolicy {
  optimizationBudget: number;
  contextBudget: number;
  /** Advisory. Told to the agent, not enforced. */
  softTurnTarget: number;
  /** Enforced. The circuit breaker, not the budget. */
  hardTurnCap: number;
  /** The primary economic invariant. 0 means "no ceiling configured". */
  spendCapUsd: number;
  /** How much unproductive exploration is tolerated before the guard escalates. */
  explorationTolerance: number;
  /** How much progress evidence is required to keep going once spend is high. */
  confidenceRequirement: number;
}

/** Conservative by construction: these are what a caller gets when the policy
 *  derivation itself fails, so they must be safe rather than clever. */
export const DEFAULT_CONTEXT_POLICY: ContextPolicy = {
  tokenBudget: 6000,
  optimizationBudget: 500,
  confidenceFloor: 0.35,
};

export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = {
  optimizationBudget: 500,
  contextBudget: 6000,
  softTurnTarget: 25,
  hardTurnCap: 60,
  spendCapUsd: 0,
  explorationTolerance: 0.6,
  confidenceRequirement: 0.3,
};

export function clamp01(value: number, fallback = 0): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

/** Non-negative and finite, or the fallback. Not clamped to an upper bound:
 *  a budget someone deliberately set high is their call. */
function budget(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function turns(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.round(value)) : fallback;
}

export function normalizeContextPolicy(policy: ContextPolicy): ContextPolicy {
  return {
    tokenBudget: budget(policy.tokenBudget, DEFAULT_CONTEXT_POLICY.tokenBudget),
    optimizationBudget: budget(policy.optimizationBudget, DEFAULT_CONTEXT_POLICY.optimizationBudget),
    confidenceFloor: clamp01(policy.confidenceFloor, DEFAULT_CONTEXT_POLICY.confidenceFloor),
  };
}

export function normalizeExecutionPolicy(policy: ExecutionPolicy): ExecutionPolicy {
  const hardTurnCap = turns(policy.hardTurnCap, DEFAULT_EXECUTION_POLICY.hardTurnCap);
  return {
    optimizationBudget: budget(policy.optimizationBudget, DEFAULT_EXECUTION_POLICY.optimizationBudget),
    contextBudget: budget(policy.contextBudget, DEFAULT_EXECUTION_POLICY.contextBudget),
    // The soft target is advice and the hard cap is the wall; advice that sits
    // past the wall is advice to run into it.
    softTurnTarget: Math.min(hardTurnCap, turns(policy.softTurnTarget, DEFAULT_EXECUTION_POLICY.softTurnTarget)),
    hardTurnCap,
    spendCapUsd: budget(policy.spendCapUsd, DEFAULT_EXECUTION_POLICY.spendCapUsd),
    explorationTolerance: clamp01(policy.explorationTolerance, DEFAULT_EXECUTION_POLICY.explorationTolerance),
    confidenceRequirement: clamp01(policy.confidenceRequirement, DEFAULT_EXECUTION_POLICY.confidenceRequirement),
  };
}

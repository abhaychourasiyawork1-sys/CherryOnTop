/** Which model tier a dispatch should run on.
 *
 *  Model choice used to be one fixed name per role: Haiku for planning and
 *  synthesis, the runtime's own default for everything else. That is right for
 *  the two narrow roles — emitting a JSON array and merging markdown do not
 *  need a frontier model — but it says nothing about execution, where a
 *  one-line rename and a twelve-module refactor were charged identically.
 *
 *  Deliberately asymmetric: routing may tier *down*, and may only tier *up* to
 *  a model an operator has explicitly named. A downgrade that goes wrong is
 *  caught by the model-rejection fallback and by the run itself; an upgrade
 *  that goes wrong is a bill nobody asked for. */
import { modelForTier, hasExplicitModel, dispatchOptionsFor, type DispatchRole } from '../config/efficiency.js';

export type ModelTier = 'fast' | 'standard' | 'deep';

export interface ModelRouteInput {
  role: DispatchRole;
  complexity: 'low' | 'medium' | 'high';
  /** The node's authority. Zero means "nobody costed this node", which is not
   *  the same as "this node is out of money". */
  budgetUsd: number;
  spentUsd: number;
  /** Reading and diagnosing rather than producing (src/intelligence/decompose.ts).
   *  These score low on complexity — they name no breadth and no file list — and
   *  low is the fast-tier trigger, so without this a root-cause investigation
   *  and a variable rename are charged and answered identically. */
  investigative?: boolean;
}

export interface ModelRouteDecision {
  tier: ModelTier;
  /** The name to pass to `--model`, or undefined to let the runtime choose. */
  model: string | undefined;
  /** Why. Recorded with the dispatch, so a later routing change can be argued
   *  from evidence rather than from taste. */
  reason: string;
}

/** Past this share of a node's budget, buy the cheapest thing that could still
 *  finish the work. */
const BUDGET_PRESSURE = 0.8;

function fast(reason: string): ModelRouteDecision {
  return { tier: 'fast', model: modelForTier('fast'), reason };
}

export function routeModel(input: ModelRouteInput): ModelRouteDecision {
  // An operator who named a model meant it. Routing around an explicit setting
  // is how a knob comes to be described as "not doing anything".
  if (hasExplicitModel(input.role)) {
    return {
      tier: 'standard',
      model: dispatchOptionsFor(input.role).model,
      reason: `ORG_MODEL_${input.role.toUpperCase()} names the model for this role`,
    };
  }

  // Emitting a JSON array of subgoals and merging finished reports into markdown
  // are narrow, well-specified jobs. They were already tiered down, and nothing
  // about a complex goal makes either of them harder.
  if (input.role !== 'execute') {
    return fast(`${input.role} is a narrow role and runs on the fast tier`);
  }

  if (input.budgetUsd > 0 && input.spentUsd >= input.budgetUsd * BUDGET_PRESSURE) {
    return fast('most of this node\'s budget is already spent');
  }

  // Budget pressure above still wins: out of money is out of money. Short of
  // that, a low score on an investigation means "this goal names nothing
  // specific", which is a reason to think harder, not less.
  if (input.complexity === 'low' && !input.investigative) {
    return fast('low-complexity work does not need the default model');
  }
  if (input.complexity === 'low') {
    return {
      tier: 'standard',
      model: modelForTier('standard'),
      reason: 'reviewing, diagnosing or investigating — not tiered down on complexity alone',
    };
  }

  // Only reachable when an operator has named a deep model. Without one this
  // falls through to standard, which is exactly today's behaviour.
  const deep = modelForTier('deep');
  if (input.complexity === 'high' && deep) {
    return { tier: 'deep', model: deep, reason: 'high-complexity work, and a deep tier is configured' };
  }

  return {
    tier: 'standard',
    model: modelForTier('standard'),
    reason: `${input.complexity}-complexity work stays on the runtime default`,
  };
}

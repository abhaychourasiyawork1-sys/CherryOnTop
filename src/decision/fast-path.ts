/** The screen that decides whether deciding is worth it.
 *
 *  Every optimization layer has one cost nobody writes down: the cost of asking
 *  whether to optimize. Pay it on every event and the optimizer becomes the
 *  expensive part of a run that was going fine. So the hot path gets a cheap,
 *  deterministic screen that reads nothing but the state it was handed — no
 *  graph, no memory, no database, no model — and answers one question: *is there
 *  visibly something here worth paying to look into?*
 *
 *  The bar it clears is deliberately not a constant. A fixed "pressure > 0.4"
 *  would be exactly the kind of universal threshold this architecture is not
 *  allowed to encode, and it would also be wrong in both directions: early in a
 *  task, deep evaluation is cheap relative to what remains and a weak signal is
 *  worth chasing; late, with the optimization allowance nearly spent, only a
 *  strong one is. So the bar is **what the deep evaluation would cost as a share
 *  of the optimization budget still available**. As the optimizer spends, its
 *  own bar rises. An optimizer that has spent its allowance stops screening
 *  entirely, which is the correct behaviour and needs no separate switch.
 *
 *  The signals below are all *differences between state dimensions*, never
 *  counts against a magic number. "Doubt the evidence has not touched",
 *  "repetition beyond the information it produced", "progress nothing has
 *  validated" — each is one subtraction over two numbers the state already
 *  holds, and each reaches exactly zero when the run is healthy. */
import { clamp01 } from '../efficiency/policy-types.js';
import type { EconomicState } from './state.js';

export interface FastPathResult {
  opportunity: boolean;
  /** Named, stable, and ordered strongest first. These become the deep path's
   *  starting points, so a screen that says "yes" without saying "to what" would
   *  make the deep path search everything. */
  reasons: string[];
  confidence: number;
  /** The strongest signal found, on [0,1]. Reported so a run that *nearly*
   *  triggered is distinguishable in telemetry from one that saw nothing —
   *  without it, a mis-tuned bar is invisible. */
  pressure: number;
  /** The bar `pressure` had to clear. */
  bar: number;
}

/** What one deep evaluation is assumed to cost the optimizer, in tokens.
 *
 *  Not a threshold on behaviour — a price. It is small because the deep path is
 *  deterministic arithmetic over data already in memory; it is non-zero because
 *  an optimization step that claims to be free is an optimization step nobody
 *  can hold to account. `orchestration-cost.ts` measures the real figure and
 *  this is what the screen budgets against in the meantime. */
export const DEEP_EVALUATION_TOKEN_COST = 120;

export interface Signal { code: string; strength: number }

/** Every signal is a **difference between two state dimensions**, floored at
 *  zero. That shape is the design, not a coincidence:
 *
 *   - a difference needs no threshold to mean "nothing here" — it simply
 *     reaches zero when the two dimensions agree, which is what a healthy run
 *     looks like;
 *   - it cannot be gamed by scale, because both sides are already [0,1];
 *   - and it states the pathology directly. "Similarity beyond the information
 *     it produced" *is* wasteful repetition, in one expression, with no
 *     arbitrary constant standing in for the judgement.
 *
 *  A product would not do: `similarity * (1 - gain)` is small-but-nonzero for
 *  every healthy run, so every healthy run would report a weak opportunity and
 *  the screen would have to invent a noise floor to suppress its own output. */
const gap = (a: number, b: number): number => clamp01(Math.max(0, a - b));

/** Doubt that the evidence in hand has not addressed.
 *
 *  Against evidence *held*, not against a turn count: a run that has read
 *  twenty files and is still lost is a different state from one that has read
 *  none, and only the first is worth intervening in. */
export function missingEvidenceSignal(state: EconomicState): number {
  const doubt = (state.uncertainty.target + state.uncertainty.structural) / 2;
  // Saturating, because the tenth file rarely resolves as much as the first.
  const covered = 1 - 1 / (1 + state.evidence.length);
  return gap(doubt, covered);
}

/** Failure the run is not getting past. */
export function failureSignal(state: EconomicState): number {
  return gap(state.trajectory.failurePressure, state.trajectory.progress);
}

/** The same ground, covered again, for nothing.
 *
 *  Repetition on its own is not a problem — careful work in one file looks
 *  exactly like it. Repetition *beyond the information it produced* is the
 *  pathology, and a run learning as fast as it repeats scores exactly zero.
 *  This is the expression that keeps productive high-exploration work viable. */
export function duplicationSignal(state: EconomicState): number {
  return gap(state.trajectory.stateSimilarity, state.trajectory.informationGain);
}

/** Work that claims to be done and has nothing to prove it.
 *
 *  Doubt about correctness only becomes material once there is something to be
 *  correct about, so the doubt is measured against the work still outstanding:
 *  a run that has done nothing has nothing unvalidated. */
export function validationSignal(state: EconomicState): number {
  if (!state.validation.required || state.validation.status === 'passed') return 0;
  return gap(state.uncertainty.validation, 1 - state.trajectory.progress);
}

/** Money running out faster than work is getting done.
 *
 *  Spend against *progress*, never spend against a cap: 80% of the budget for
 *  90% of the work is expensive and fine; 40% for 5% is not. */
export function resourceSignal(state: EconomicState): number {
  const total = state.resources.totalTokenBudget;
  if (total <= 0) return 0;
  return gap(state.resources.consumedTokens / total, state.trajectory.progress);
}

function signals(state: EconomicState): Signal[] {
  return [
    { code: 'identifiable_missing_evidence', strength: missingEvidenceSignal(state) },
    { code: 'repeated_failure', strength: failureSignal(state) },
    { code: 'high_duplication', strength: duplicationSignal(state) },
    { code: 'validation_uncertainty', strength: validationSignal(state) },
    { code: 'resource_pressure', strength: resourceSignal(state) },
  ];
}

/** The optimizer's remaining allowance, and therefore what it may still spend
 *  on deciding. */
function optimizationRemaining(state: EconomicState): number {
  return Math.max(0, state.resources.optimizationTokens - state.resources.optimizationConsumedTokens);
}

export function inspectFastPath(state: EconomicState): FastPathResult {
  const remaining = optimizationRemaining(state);

  // Nothing left to decide with. Not a failure and not a fallback — an
  // optimizer that has spent its allowance is simply done optimizing, and the
  // run continues exactly as it would have without one.
  if (remaining <= 0) {
    return {
      opportunity: false,
      reasons: ['optimization_budget_exhausted'],
      confidence: state.trajectory.orchestrationConfidence,
      pressure: 0,
      bar: 1,
    };
  }

  // A finished task has no opportunities left, and screening one is pure cost.
  if (state.constraints.hardStop) {
    return {
      opportunity: false, reasons: ['hard_stop'],
      confidence: state.trajectory.orchestrationConfidence, pressure: 0, bar: 1,
    };
  }

  const found = signals(state)
    .filter((s) => s.strength > 0)
    .sort((a, b) => b.strength - a.strength || (a.code < b.code ? -1 : 1));

  const pressure = found.length === 0 ? 0 : found[0].strength;
  // The economic bar: what looking would cost, as a share of what the optimizer
  // has left to spend. Cheap early, expensive late, and never a constant.
  const bar = clamp01(DEEP_EVALUATION_TOKEN_COST / remaining);

  return {
    opportunity: pressure > bar,
    reasons: found.map((s) => s.code),
    // Doubt reduces pressure rather than raising it: a screen the orchestrator
    // does not trust reports its own weakness rather than escalating on it.
    confidence: clamp01(state.trajectory.orchestrationConfidence * pressure),
    pressure,
    bar,
  };
}

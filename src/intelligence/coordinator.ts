import { assessDecomposition } from './decompose.js';

export interface IntelligenceBundle {
  sufficientContext: boolean;
  complexity: 'low' | 'medium' | 'high';
  /** Whether this goal looks like several pieces of work at all. A node that is
   *  plainly one job goes straight to doing it rather than paying for a planning
   *  sandbox to be told so. */
  worthSplitting: boolean;
  /** The named signals behind that call, carried into the decision record. */
  signals: Record<string, number>;
}

// Doc §6: "intelligence proportional to uncertainty" — no Evidence/Capability/
// Runtime-Intelligence workers exist yet (that's the rest of the Intelligence
// Plane, later phases), so this is deliberately only the "low uncertainty ->
// cheap local default" leg. sufficientContext is always true for v0.1: there is
// no research step to wait on, so INTELLIGENCE_GATE never has a reason to loop
// back to PLAN yet. complexity is a real, if crude, signal — goal length as a
// proxy — that decide-execution uses to pick default economics inputs.
export function assessUncertainty(input: { goal: string }): IntelligenceBundle {
  // Was `goal.length > 150 ? 'high' : ...` — the number of characters someone
  // typed. See decompose.ts for why that was the wrong question.
  const decomposition = assessDecomposition(input.goal);
  return {
    sufficientContext: true,
    complexity: decomposition.complexity,
    worthSplitting: decomposition.worthSplitting,
    signals: decomposition.signals,
  };
}

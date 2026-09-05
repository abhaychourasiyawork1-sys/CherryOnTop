export interface IntelligenceBundle {
  sufficientContext: boolean;
  complexity: 'low' | 'medium' | 'high';
}

// Doc §6: "intelligence proportional to uncertainty" — no Evidence/Capability/
// Runtime-Intelligence workers exist yet (that's the rest of the Intelligence
// Plane, later phases), so this is deliberately only the "low uncertainty ->
// cheap local default" leg. sufficientContext is always true for v0.1: there is
// no research step to wait on, so INTELLIGENCE_GATE never has a reason to loop
// back to PLAN yet. complexity is a real, if crude, signal — goal length as a
// proxy — that decide-execution uses to pick default economics inputs.
export function assessUncertainty(input: { goal: string }): IntelligenceBundle {
  const complexity = input.goal.length > 150 ? 'high' : input.goal.length > 50 ? 'medium' : 'low';
  return { sufficientContext: true, complexity };
}

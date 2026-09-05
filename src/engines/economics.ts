export interface EconomicsInput {
  estimatedValue: number;
  modelCost: number;
  latencyCost: number;
  coordinationCost: number;
  verificationCost: number;
  riskPenalty: number;
  threshold: number;
}

export interface EconomicsResult {
  score: number;
  delegate: boolean;
  breakdown: EconomicsInput;
}

// Doc §10's formula, verbatim:
//   score = estimated_value - (model + latency + coordination + verification) - risk
//   delegate if score >= threshold
// Every term is printable via `breakdown` — the point of this being a formula
// instead of an LLM judgment call (D28) is that `org decision` can show exactly
// why, not just what.
export function scoreDelegation(input: EconomicsInput): EconomicsResult {
  const totalCost = input.modelCost + input.latencyCost + input.coordinationCost + input.verificationCost;
  const score = input.estimatedValue - totalCost - input.riskPenalty;
  return { score, delegate: score >= input.threshold, breakdown: input };
}

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
// Scores are sums and differences of small decimals, so a value that is exactly
// the threshold on paper can land just under it in IEEE 754. The default
// medium-complexity inputs are exactly this case — 0.7 - 0.4 computes as
// 0.29999999999999993 against a threshold of 0.3 — which meant every goal of
// that shape silently refused to delegate and did the work itself. The
// tolerance is far below any difference the weights can meaningfully express.
const TOLERANCE = 1e-9;

export function scoreDelegation(input: EconomicsInput): EconomicsResult {
  const totalCost = input.modelCost + input.latencyCost + input.coordinationCost + input.verificationCost;
  const score = input.estimatedValue - totalCost - input.riskPenalty;
  return { score, delegate: score >= input.threshold - TOLERANCE, breakdown: input };
}

/** The single change that would have produced the opposite decision.
 *
 *  This is only possible because the decision is arithmetic. A model asked to
 *  explain itself can tell you a story about why it delegated; it cannot tell
 *  you that thirteen cents of verification cost was the whole difference. That
 *  sentence is the strongest evidence we have that the reasoning is real, so it
 *  is worth computing exactly rather than approximately.
 *
 *  `null` when the breakdown has no score or threshold — a decision recorded
 *  before economics existed, or one taken on a rule rather than a score (a node
 *  with no spawn authority never runs the formula at all). */
export interface Counterfactual {
  /** How far the score sat from the line. Always positive. */
  margin: number;
  /** The cheapest term to move, and which way it would have to go. */
  term: string;
  direction: 'higher' | 'lower';
  /** What the decision would have become. */
  wouldHave: 'delegated' | 'done it itself';
}

const COST_TERMS = ['modelCost', 'latencyCost', 'coordinationCost', 'verificationCost', 'riskPenalty'];

export function counterfactual(breakdown: Record<string, number>): Counterfactual | null {
  const { score, threshold } = breakdown;
  if (typeof score !== 'number' || typeof threshold !== 'number') return null;
  // A rule-based outcome (no spawn authority) has a score but no real formula
  // behind it; presenting a margin for it would be inventing arithmetic.
  if (!COST_TERMS.some((term) => term in breakdown)) return null;

  const margin = Math.abs(score - threshold);
  const delegated = score >= threshold;

  // Which term is cheapest to move is the same question either way: the largest
  // one has the most room, and naming a term that is already zero ("had risk
  // been lower") would be nonsense.
  const movable = COST_TERMS
    .filter((term) => (delegated ? true : breakdown[term] > 0))
    .filter((term) => term in breakdown);
  if (movable.length === 0) return null;
  const term = movable.reduce((a, b) => (breakdown[b] > breakdown[a] ? b : a));

  return {
    margin,
    term,
    direction: delegated ? 'higher' : 'lower',
    wouldHave: delegated ? 'done it itself' : 'delegated',
  };
}

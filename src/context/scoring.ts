/** What a candidate is worth, and what it costs.
 *
 *  Split out of the selector deliberately. The old score was two constants
 *  (`PATH_WEIGHT`, `SYMBOL_WEIGHT`) buried inside `selectDispatchContext`,
 *  which meant that changing what the system values meant editing the loop that
 *  applies it — and that every weight was invisible to the telemetry that has
 *  to explain a selection afterwards.
 *
 *  Here the weights are data, the contributions are reported term by term, and
 *  the arithmetic is one line. A strange selection can be read off its
 *  contributions rather than reasoned about from the source.
 *
 *  The one rule the shape encodes: **value is measured against exploration
 *  avoided, and cost against tokens spent.** A candidate earns its place by
 *  saving the agent a search it would otherwise have paid for over several
 *  turns — not by resembling the goal. Resemblance is a weak proxy for that,
 *  which is why it is one term of several rather than the whole score. */
import type { ContextCandidate } from './candidates.js';

export interface ContextScoreSignals {
  /** The goal named it. */
  anchorRelevance: number;
  /** The compiler relates it to something the goal named. */
  structuralRelevance: number;
  /** Its kind suits the task's kind. */
  taskFit: number;
  /** How much the evidence above deserves to be believed. */
  confidence: number;
  /** Turns the agent would otherwise spend finding this itself. The term the
   *  whole exercise is actually about. */
  expectedExplorationAvoided: number;
  /** A sibling dispatch on this commit already has it, so including it keeps
   *  the prompt prefix — and therefore the provider's cache — intact. */
  reuseValue: number;
  /** Charged against everything above. Negative-signed at the point of use, so
   *  the weight itself stays a positive number and the table reads uniformly. */
  contextCost: number;
}

export interface ContextScorer {
  score(candidate: ContextCandidate, signals: ContextScoreSignals): number;
}

/** The weights, and the only place they live.
 *
 *  Exploration avoided outweighs every kind of resemblance, because that is the
 *  quantity being bought. Context cost is deliberately small but non-zero: a
 *  budget is enforced by the selector as a hard ceiling, so this term exists to
 *  break ties towards the cheaper candidate, not to do the bounding. */
export const DEFAULT_SCORE_WEIGHTS: ContextScoreSignals = {
  anchorRelevance: 3,
  structuralRelevance: 2.5,
  taskFit: 1,
  confidence: 2,
  expectedExplorationAvoided: 4,
  reuseValue: 1.5,
  contextCost: 0.5,
};

/** Roughly how much search a candidate saves, on [0,1].
 *
 *  Deterministic and deliberately crude. A file the goal named outright saves
 *  nothing — the agent was going to open it first anyway. A file the goal did
 *  *not* name but the compiler ties to one it did is the expensive case: the
 *  agent has to discover it, and discovering it means greps and reads across
 *  several turns, each re-reading the whole conversation prefix. That is the
 *  asymmetry the selector is built to exploit. */
export function explorationAvoided(candidate: ContextCandidate): number {
  if (candidate.relationships.includes('anchor')) return 0.1;
  const structural = candidate.structuralScore * candidate.confidenceScore;
  // A test relationship is the most reliably-needed neighbour of all: work that
  // changes code changes its test, and nothing lexical ever finds it.
  const tested = candidate.relationships.some((r) => r.startsWith('test-of:') || r.startsWith('tested-by:'));
  return Math.min(1, structural + (tested ? 0.3 : 0));
}

/** How much of the context budget one candidate eats, on [0,1]. Scaled against
 *  a nominal line rather than against the budget, so a candidate's cost does
 *  not change meaning when the budget does. */
function normalizedCost(candidate: ContextCandidate): number {
  return Math.min(1, candidate.estimatedTokens / 100);
}

/** The score, term by term. Exported because a receipt that says "score 7.2"
 *  explains nothing, and one that says which term produced the 7.2 explains
 *  everything. */
export function contributions(
  candidate: ContextCandidate,
  weights: ContextScoreSignals = DEFAULT_SCORE_WEIGHTS,
): ContextScoreSignals & { total: number } {
  const terms: ContextScoreSignals = {
    // Lexical evidence saturates: a file matching six goal words is not three
    // times the file matching two, it is the same file found more loudly.
    anchorRelevance: weights.anchorRelevance * Math.min(1, candidate.lexicalScore / 4),
    structuralRelevance: weights.structuralRelevance * candidate.structuralScore,
    taskFit: weights.taskFit * candidate.taskFitScore,
    confidence: weights.confidence * candidate.confidenceScore,
    expectedExplorationAvoided: weights.expectedExplorationAvoided * explorationAvoided(candidate),
    reuseValue: weights.reuseValue * candidate.reuseScore,
    contextCost: weights.contextCost * normalizedCost(candidate),
  };
  const total =
    terms.anchorRelevance + terms.structuralRelevance + terms.taskFit + terms.confidence
    + terms.expectedExplorationAvoided + terms.reuseValue - terms.contextCost;
  return { ...terms, total };
}

export function createContextScorer(): ContextScorer {
  return { score: (candidate, signals) => contributions(candidate, signals).total };
}

/** Value per token — what "is this worth its room?" actually asks.
 *
 *  The selector stops on this rather than on the raw score: a slightly better
 *  candidate that costs four times as much is not the one to take when the
 *  budget is a shared, finite thing. */
export function marginalValue(candidate: ContextCandidate, score: number): number {
  return score / Math.max(1, candidate.estimatedTokens);
}

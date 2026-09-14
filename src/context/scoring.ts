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
import type { EconomicState } from '../decision/state.js';
import { clamp01 } from '../efficiency/policy-types.js';

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
  /** How much of the run's *current* doubt this would remove. The one term that
   *  is not a property of the candidate alone: the same file is worth more to a
   *  run that does not know where it is working than to one that does. Zero
   *  when no state is supplied, which is what keeps a stateless selection
   *  scoring exactly as it did before this term existed. */
  uncertaintyReduction: number;
  /** Charged against everything above. Negative-signed at the point of use, so
   *  the weight itself stays a positive number and the table reads uniformly. */
  contextCost: number;
  /** Also charged. Context is not free of downside: a file that sends the agent
   *  somewhere irrelevant costs turns, and one that crowds out the file it
   *  actually needed costs the task. Small, and never zero, so that "more
   *  context is always safer" cannot be an unexamined assumption. */
  qualityRisk: number;
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
  // Weighted beside structural relevance: "this run does not know where it is
  // working" is evidence of the same order as "the compiler ties this to
  // something the goal named", and stronger than resemblance.
  uncertaintyReduction: 2.5,
  contextCost: 0.5,
  qualityRisk: 1,
};

/** Roughly how much search a candidate saves, on [0,1].
 *
 *  Two independent questions, multiplied — which is the fix that made this
 *  usable as an economic probability rather than only as a ranking term:
 *
 *   - **Is it needed?** Its own confidence, which is exactly "how much does the
 *     evidence tying this to the goal deserve to be believed".
 *   - **Would finding it cost anything?** A file the goal named outright is
 *     free to find: the agent opens it first whatever we do. Everything else
 *     has to be *discovered*, and discovering it means greps and reads across
 *     several turns, each re-reading the whole conversation prefix. That
 *     asymmetry is what the selector is built to exploit.
 *
 *  The earlier form multiplied confidence by `structuralScore`, which made a
 *  file matched only on the goal's own words score exactly zero — i.e. "the
 *  agent already knows about it", which is false. Harmless while this was one
 *  weighted term among several (lexical candidates earned their place through
 *  `anchorRelevance` instead); actively wrong the moment the same number became
 *  the probability in a rediscovery-cost calculation, where it priced every
 *  lexical match at nothing and dropped it. Anchors and structural neighbours
 *  score exactly what they scored before. */
export function explorationAvoided(candidate: ContextCandidate): number {
  const anchored = candidate.relationships.includes('anchor');
  // Not zero for an anchor: being named still leaves the agent a read to do,
  // and 0.1 is what that has always been priced at here.
  const searchCost = anchored ? 0.1 : 1;
  // A test relationship is the most reliably-needed neighbour of all: work that
  // changes code changes its test, and nothing lexical ever finds it.
  const tested = candidate.relationships.some((r) => r.startsWith('test-of:') || r.startsWith('tested-by:'));
  return Math.min(1, candidate.confidenceScore * searchCost + (tested ? 0.3 : 0));
}

/** How much of the context budget one candidate eats, on [0,1]. Scaled against
 *  a nominal line rather than against the budget, so a candidate's cost does
 *  not change meaning when the budget does. */
function normalizedCost(candidate: ContextCandidate): number {
  return Math.min(1, candidate.estimatedTokens / 100);
}

/** How much of the run's current doubt this candidate speaks to.
 *
 *  Generic on both sides: which *kind* of doubt against which *kind* of
 *  artifact, never which file. A test speaks to whether the result is correct;
 *  everything else speaks to where and how the code works. Weighted by how
 *  likely the agent was to need it at all, because doubt a candidate cannot
 *  reach is doubt it does not reduce. */
export function uncertaintyReduction(candidate: ContextCandidate, state?: EconomicState): number {
  if (!state) return 0;
  const covers = candidate.relationships.some((r) => r.startsWith('test-of:') || r.startsWith('tested-by:'));
  const doubt = covers
    ? Math.max(state.uncertainty.validation, state.uncertainty.behavioral)
    : Math.max(state.uncertainty.structural, state.uncertainty.target);
  return clamp01(doubt * candidate.confidenceScore);
}

/** The downside of including something.
 *
 *  Rises with size and falls with confidence: a large file we are unsure about
 *  is the worst case — it costs the most and is the most likely to point the
 *  agent somewhere it did not need to go. */
export function contextQualityRisk(candidate: ContextCandidate): number {
  return clamp01(normalizedCost(candidate) * (1 - candidate.confidenceScore));
}

/** The score, term by term. Exported because a receipt that says "score 7.2"
 *  explains nothing, and one that says which term produced the 7.2 explains
 *  everything. */
export function contributions(
  candidate: ContextCandidate,
  weights: ContextScoreSignals = DEFAULT_SCORE_WEIGHTS,
  state?: EconomicState,
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
    uncertaintyReduction: weights.uncertaintyReduction * uncertaintyReduction(candidate, state),
    contextCost: weights.contextCost * normalizedCost(candidate),
    qualityRisk: weights.qualityRisk * contextQualityRisk(candidate),
  };
  const total =
    terms.anchorRelevance + terms.structuralRelevance + terms.taskFit + terms.confidence
    + terms.expectedExplorationAvoided + terms.reuseValue + terms.uncertaintyReduction
    - terms.contextCost - terms.qualityRisk;
  return { ...terms, total };
}

/** A scorer bound to a state, or to none.
 *
 *  The state is bound at construction rather than threaded through `score`
 *  because the selector ranks a whole candidate set against one state, and a
 *  per-call parameter would let two candidates in one selection be scored
 *  against different worlds. */
export function createContextScorer(state?: EconomicState): ContextScorer {
  return { score: (candidate, signals) => contributions(candidate, signals, state).total };
}

/** Value per token — what "is this worth its room?" actually asks.
 *
 *  The selector stops on this rather than on the raw score: a slightly better
 *  candidate that costs four times as much is not the one to take when the
 *  budget is a shared, finite thing. */
export function marginalValue(candidate: ContextCandidate, score: number): number {
  return score / Math.max(1, candidate.estimatedTokens);
}

/** What an observation costs to carry, and what it costs to have elided it.
 *
 *  The 2026-10-01 pilot priced every run to the digit: fresh input was ~0% of
 *  cost, cache reads ~50%, cache writes ~30%. A token an observation puts into
 *  the conversation is written to the cache once and then re-read on every turn
 *  after it. So the price of keeping `n` tokens is not `n · p_input`. It is
 *
 *      n · (p_write + p_read · E[remaining turns])
 *
 *  and the price of eliding them is the chance the agent comes back for them
 *  times what coming back costs: one more turn that re-reads the whole context,
 *  plus carrying the slice it fetched.
 *
 *  Nothing here is a threshold. Every quantity is a price, a measured turn
 *  distribution, or a learned probability with a stated prior.
 */
import { difficultyFrom, upperDifficulty } from '../intelligence/difficulty.js';
import { SHRINKAGE_K } from '../learning/hierarchical.js';

export interface Prices {
  read: number;
  write: number;
  output: number;
}

/** Expected turns left in a dispatch that has already taken `step`.
 *
 *  With no history: having lasted `step` turns, expect about as many again
 *  (Gott's delta-t argument). It is scale-free, so it needs no assumed run
 *  length. History of past dispatches that lasted beyond `step` pulls the
 *  estimate toward their mean residual, at the same shrinkage strength every
 *  other level of evidence in the runtime uses. */
export function expectedRemainingTurns(step: number, pastTotals: readonly number[]): number {
  const prior = Math.max(1, step);
  const longer = pastTotals.filter((t) => t > step);
  if (longer.length === 0) return prior;
  const empirical = longer.reduce((s, t) => s + (t - step), 0) / longer.length;
  const w = longer.length / (longer.length + SHRINKAGE_K);
  return w * empirical + (1 - w) * prior;
}

/** Dollars to keep `tokens` in the conversation for the rest of the dispatch. */
export function carryingUsd(tokens: number, remainingTurns: number, p: Prices): number {
  return Math.max(0, tokens) * (p.write + p.read * Math.max(0, remainingTurns));
}

export interface RefetchCostInput {
  /** Tokens the model re-reads on a turn now (the last turn's prompt size). */
  contextTokens: number;
  /** Mean output tokens per turn so far: what deciding to refetch costs. */
  outputPerTurn: number;
  /** What the refetch brings back, carried from then on. */
  sliceTokens: number;
  remainingTurns: number;
}

export function refetchUsd(input: RefetchCostInput, p: Prices): number {
  return input.contextTokens * p.read
    + input.outputPerTurn * p.output
    + carryingUsd(input.sliceTokens, Math.max(0, input.remainingTurns - 1), p);
}

/** Refetches observed against elisions made, for one (tool kind, representation)
 *  cell. A Beta belief, uniform when nothing is known. */
export interface RefetchBelief {
  refetched: number;
  elided: number;
}

export function refetchMean(b: RefetchBelief): number {
  return (1 + b.refetched) / (2 + b.elided);
}

/** The refetch probability the evidence cannot rule out at `confidence`. The
 *  same Beta upper bound the execution market prices difficulty with, so the
 *  controller is exactly as cautious as the rest of the runtime. */
export function refetchBound(b: RefetchBelief, confidence: number): number {
  if (b.elided <= 0) return upperDifficulty(difficultyFrom(0.5, 0, 'history'), confidence);
  return upperDifficulty(difficultyFrom(b.refetched / b.elided, b.elided, 'history'), confidence);
}

export interface ElisionValue {
  savedUsd: number;
  /** Risk at the belief's mean. */
  riskMeanUsd: number;
  /** Risk at the pessimistic bound. */
  riskBoundUsd: number;
  /** Positive at the bound: elide. Negative at the mean: keep. Between: the
   *  evidence cannot tell, which is where a semantic judgement may help. */
  verdict: 'elide' | 'keep' | 'ambiguous';
}

export function elisionValue(
  input: { elidedTokens: number; remainingTurns: number; refetch: RefetchCostInput; probability: { mean: number; bound: number } },
  p: Prices,
): ElisionValue {
  const savedUsd = carryingUsd(input.elidedTokens, input.remainingTurns, p);
  const cost = refetchUsd(input.refetch, p);
  const riskMeanUsd = input.probability.mean * cost;
  const riskBoundUsd = input.probability.bound * cost;
  const verdict = savedUsd - riskBoundUsd > 0 ? 'elide' : savedUsd - riskMeanUsd <= 0 ? 'keep' : 'ambiguous';
  return { savedUsd, riskMeanUsd, riskBoundUsd, verdict };
}

/** The Beta fallback as a probability pair, for when no model has been fit yet. */
export function betaProbability(b: RefetchBelief, confidence: number): { mean: number; bound: number } {
  return { mean: refetchMean(b), bound: refetchBound(b, confidence) };
}

/** What repeating a call that just failed, into a world nothing has changed
 *  since, has been seen to do. Counted per allowed repeat: did its result
 *  differ from the failure before it, and did the agent then issue it yet
 *  again (the loop continuing). Uniform when nothing is known. */
export interface RepeatBelief {
  repeats: number;
  differed: number;
  again: number;
}

export interface RepeatValue {
  /** The duplicate failure's carrying cost avoided, plus the turn a loop
   *  would go on to spend, at the loop probability's lower bound. */
  savedUsd: number;
  /** A refusal that was wrong costs the agent the turn it spends working
   *  around it, at the probability-of-a-different-result's upper bound. */
  riskBoundUsd: number;
  pDifferBound: number;
  pLoopLower: number;
  verdict: 'deny' | 'allow';
}

/** Refuse an identical repeat only when the evidence says it pays.
 *
 *  Allowing and refusing both cost the agent a turn; what differs is what the
 *  turn carries forward. Allowing re-carries the same failure and, if the agent
 *  is looping, buys the next identical turn too. Refusing carries a short
 *  grounded note, and is wrong exactly when the repeat would have come out
 *  differently. `sessionRepeats` identical repeats already allowed in this
 *  dispatch are evidence of both kinds: none of them differed, and each after
 *  the first was the loop going on. */
export function repeatValue(
  input: {
    belief: RepeatBelief;
    sessionRepeats: number;
    duplicateTokens: number;
    feedbackTokens: number;
    remainingTurns: number;
    /** One more turn: re-reading the context and deciding again. */
    turnUsd: number;
  },
  p: Prices,
  confidence: number,
): RepeatValue {
  const r = Math.max(0, input.sessionRepeats);
  const repeats = input.belief.repeats + r;
  const differed = input.belief.differed;
  const again = input.belief.again + Math.max(0, r - 1);
  const pDifferBound = repeats > 0
    ? upperDifficulty(difficultyFrom(differed / repeats, repeats, 'history'), confidence)
    : upperDifficulty(difficultyFrom(0.5, 0, 'history'), confidence);
  // The loop can only go on after a repeat that came out the same: P(same) ·
  // P(again | same), each at the bound the evidence cannot rule out.
  const same = Math.max(0, repeats - differed);
  const pAgainLower = same > 0
    ? 1 - upperDifficulty(difficultyFrom(1 - Math.min(again, same) / same, same, 'history'), confidence)
    : 1 - upperDifficulty(difficultyFrom(0.5, 0, 'history'), confidence);
  const pLoopLower = Math.max(0, 1 - pDifferBound) * Math.max(0, pAgainLower);
  const savedUsd = carryingUsd(input.duplicateTokens - input.feedbackTokens, input.remainingTurns, p) + pLoopLower * input.turnUsd;
  const riskBoundUsd = pDifferBound * input.turnUsd;
  return { savedUsd, riskBoundUsd, pDifferBound, pLoopLower, verdict: savedUsd - riskBoundUsd > 0 ? 'deny' : 'allow' };
}

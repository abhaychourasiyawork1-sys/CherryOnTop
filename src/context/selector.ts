/** Which candidates actually go, at how much detail, under a budget.
 *
 *  Three rules, and the whole module is an implementation of them:
 *
 *  1. **The budget is a ceiling, never a target.** A selection that stops early
 *     because nothing left is worth its room is a *good* selection. The
 *     behaviour this replaces filled the budget by construction, which is how a
 *     one-file typo fix and a repo-wide audit came to receive the same six
 *     thousand tokens.
 *
 *  2. **Detail is bought, not assumed.** A candidate is offered at the cheapest
 *     level that carries its evidence and escalated only while the *increment*
 *     pays for itself. Under pressure it is demoted rather than dropped: a path
 *     the agent can see costs four tokens and saves a search, and dropping it
 *     to fit a richer neighbour is rarely the better trade.
 *
 *  3. **Uncertainty widens.** Below the policy's confidence floor the marginal
 *     test is relaxed, because pruning a goal we do not understand is how an
 *     agent ends up re-deriving by grep what it was nearly handed — at a cost
 *     measured in turns, each of which re-reads the entire conversation. */
import { tokensAt, type ContextCandidate, type EvidenceLevel } from './candidates.js';
import { marginalValue, type ContextScorer, type ContextScoreSignals, DEFAULT_SCORE_WEIGHTS } from './scoring.js';
import type { ContextPolicy } from '../efficiency/policy-types.js';

export interface SelectedCandidate extends ContextCandidate {
  /** The level actually handed over, which is at or below `evidenceLevel`. */
  selectedLevel: EvidenceLevel;
  /** Tokens at `selectedLevel`, which is what was really charged. */
  selectedTokens: number;
  score: number;
}

export interface ContextSelectionResult {
  selected: SelectedCandidate[];
  dropped: ContextCandidate[];
  estimatedTokens: number;
  /** True when something worth taking could not fit. The signal that the
   *  budget, not the goal, bounded this dispatch — distinct from stopping
   *  because nothing left was worth its room. */
  truncated: boolean;
  /** Mean confidence of what was selected, on [0,1]. Zero when nothing was. */
  confidence: number;
}

/** Value per token below which a candidate is not worth its room.
 *
 *  Calibrated against the scorer: a mid-strength structural neighbour rendered
 *  as one line scores around 6 over ~20 tokens, i.e. ~0.3. A weak lexical
 *  brush-past scores ~2 over the same line, i.e. ~0.1. The threshold sits
 *  between them on purpose. */
const MARGINAL_THRESHOLD = 0.15;

/** The ladder, cheapest first. `L3` is a whole file read and is never chosen
 *  here — the module has promised not to read anything, and an evidence level
 *  nothing can materialize is worse than one nothing offers. */
const LADDER: EvidenceLevel[] = ['L0', 'L1', 'L2'];

function ladderUpTo(level: EvidenceLevel): EvidenceLevel[] {
  const top = LADDER.indexOf(level);
  return top === -1 ? LADDER : LADDER.slice(0, top + 1);
}

export interface SelectContextInput {
  candidates: ContextCandidate[];
  policy: ContextPolicy;
  scorer: ContextScorer;
  /** Overridable so a deployment can re-weight without a code change; defaulted
   *  so no caller has to know the weights exist. */
  weights?: ContextScoreSignals;
}

export function selectContext(input: SelectContextInput): ContextSelectionResult {
  const weights = input.weights ?? DEFAULT_SCORE_WEIGHTS;
  const budget = Math.max(0, Math.floor(input.policy.tokenBudget));

  const scored = input.candidates
    .map((candidate) => ({ candidate, score: input.scorer.score(candidate, weights) }))
    .sort((a, b) => b.score - a.score || (a.candidate.path < b.candidate.path ? -1 : 1));

  if (budget === 0 || scored.length === 0) {
    return { selected: [], dropped: input.candidates, estimatedTokens: 0, truncated: false, confidence: 0 };
  }

  // How sure we are about the *goal*, read off the best evidence we found for
  // it. Below the floor the marginal test relaxes — uncertainty is a reason to
  // show more, never less.
  const bestConfidence = Math.max(...scored.map((s) => s.candidate.confidenceScore));
  const widening = bestConfidence < input.policy.confidenceFloor;
  const threshold = widening ? 0 : MARGINAL_THRESHOLD;

  const selected: SelectedCandidate[] = [];
  const dropped: ContextCandidate[] = [];
  let spent = 0;
  let truncated = false;

  for (const { candidate, score } of scored) {
    const levels = ladderUpTo(candidate.evidenceLevel);
    const base = levels[0];
    const baseTokens = tokensAt(candidate, base);

    // Can it get in at all, at its cheapest form and against its own value?
    if (marginalValue(candidate, score) < threshold) { dropped.push(candidate); continue; }
    if (spent + baseTokens > budget) { dropped.push(candidate); truncated = true; continue; }

    // Escalate while the *increment* pays for itself and the room exists. The
    // test is on the increment, not the total: a candidate worth its first four
    // tokens is not automatically worth another forty.
    let level = base;
    let tokens = baseTokens;
    for (const next of levels.slice(1)) {
      const nextTokens = tokensAt(candidate, next);
      const increment = nextTokens - tokens;
      if (increment <= 0) { level = next; tokens = nextTokens; continue; }
      if (spent + nextTokens > budget) { truncated = true; break; }
      if (score / increment < threshold) break;
      level = next;
      tokens = nextTokens;
    }

    spent += tokens;
    selected.push({ ...candidate, selectedLevel: level, selectedTokens: tokens, score });
  }

  return {
    selected,
    dropped,
    estimatedTokens: spent,
    truncated,
    confidence: selected.length === 0
      ? 0
      : selected.reduce((sum, c) => sum + c.confidenceScore, 0) / selected.length,
  };
}

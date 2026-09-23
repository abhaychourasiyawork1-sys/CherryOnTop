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
import { tokensAt, offersFullArtifact, materializationFor, type ContextCandidate, type EvidenceLevel } from './candidates.js';
import { marginalValue, type ContextScorer, type ContextScoreSignals, DEFAULT_SCORE_WEIGHTS } from './scoring.js';
import type { ContextPolicy } from '../efficiency/policy-types.js';
import type { EconomicState } from '../decision/state.js';
import { evaluateInformationOpportunity } from '../efficiency/information-economics.js';

export interface SelectedCandidate extends ContextCandidate {
  /** The level actually handed over. At or below `L2`: the render ladder stops
   *  there because this module does not read files. */
  selectedLevel: EvidenceLevel;
  /** Tokens at `selectedLevel`, which is what was really charged. */
  selectedTokens: number;
  score: number;
  /** How the selected level is produced. Always `inventory` here; carried so a
   *  consumer does not have to know that and can be told instead. */
  materialization: 'inventory' | 'read-file';
  /** Net value of *also* opening this file, in tokens, when opening it is worth
   *  more than it costs. Absent when it is not, or when the size is unknown.
   *
   *  Deliberately not charged against the context budget and deliberately not a
   *  selected level: handing over a whole file is an acquisition at an
   *  execution boundary, not a line in a prompt, and conflating the two would
   *  let one file's contents crowd out every path the goal pointed at.
   *  `context/evidence-actions.ts` is what acts on this. */
  fullArtifactValue?: number;
}

/** A file the selection judged worth opening, and what that is worth. */
export interface FullArtifactRequest {
  candidateKey: string;
  path: string;
  tokens: number;
  expectedNetValue: number;
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
  /** Files worth opening, best first. Empty unless a state was supplied — the
   *  question "is this worth a read *now*?" has no answer without one. */
  fullArtifactRequests: FullArtifactRequest[];
}

/** Value per token below which a candidate is not worth its room.
 *
 *  Calibrated against the scorer: a mid-strength structural neighbour rendered
 *  as one line scores around 6 over ~20 tokens, i.e. ~0.3. A weak lexical
 *  brush-past scores ~2 over the same line, i.e. ~0.1. The threshold sits
 *  between them on purpose. */
const MARGINAL_THRESHOLD = 0.15;

/** The *render* ladder, cheapest first. `L3` is absent on purpose: this module
 *  has promised not to read anything, so the richest thing it can hand over is
 *  a description. Whether the file itself is worth opening is a separate,
 *  separately-budgeted question, answered below by `fullArtifactValue`. */
const LADDER: EvidenceLevel[] = ['L0', 'L1', 'L2'];

function ladderUpTo(level: EvidenceLevel): EvidenceLevel[] {
  // A candidate that offers L3 still renders at most L2.
  const capped = level === 'L3' ? 'L2' : level;
  const top = LADDER.indexOf(capped);
  return top === -1 ? LADDER : LADDER.slice(0, top + 1);
}

export interface SelectContextInput {
  candidates: ContextCandidate[];
  policy: ContextPolicy;
  scorer: ContextScorer;
  /** Overridable so a deployment can re-weight without a code change; defaulted
   *  so no caller has to know the weights exist. */
  weights?: ContextScoreSignals;
  /** What the run currently knows. Optional because the deterministic benchmark
   *  and the Baseline path select without one, and a selection made without a
   *  state must score exactly as it did before the economics existed — that
   *  equivalence is what makes the two arms comparable. */
  state?: EconomicState;
}

/** What handing this candidate over at this level is worth, net of what it
 *  costs. Positive means including it saves more than it spends. */
function netValueAt(
  candidate: ContextCandidate,
  tokens: number,
  state: EconomicState,
): number {
  return evaluateInformationOpportunity({
    candidate: { ...candidate, estimatedTokens: tokens },
    state,
  }).expectedNetValue;
}

export function selectContext(input: SelectContextInput): ContextSelectionResult {
  const weights = input.weights ?? DEFAULT_SCORE_WEIGHTS;
  const budget = Math.max(0, Math.floor(input.policy.tokenBudget));

  const scored = input.candidates
    .map((candidate) => ({ candidate, score: input.scorer.score(candidate, weights) }))
    .sort((a, b) => b.score - a.score || (a.candidate.path < b.candidate.path ? -1 : 1));

  if (budget === 0 || scored.length === 0) {
    return {
      selected: [], dropped: input.candidates, estimatedTokens: 0,
      truncated: false, confidence: 0, fullArtifactRequests: [],
    };
  }

  // How sure we are about the *goal*, read off the best evidence we found for
  // it. Below the floor the marginal test relaxes — uncertainty is a reason to
  // show more, never less.
  const bestConfidence = Math.max(...scored.map((s) => s.candidate.confidenceScore));
  const widening = bestConfidence < input.policy.confidenceFloor;
  const threshold = widening ? 0 : MARGINAL_THRESHOLD;

  const selected: SelectedCandidate[] = [];
  const dropped: ContextCandidate[] = [];
  const fullArtifactRequests: FullArtifactRequest[] = [];
  let spent = 0;
  let truncated = false;

  for (const { candidate, score } of scored) {
    const levels = ladderUpTo(candidate.evidenceLevel);
    const base = levels[0];
    const baseTokens = tokensAt(candidate, base);

    // Can it get in at all, at its cheapest form and against its own value?
    if (marginalValue(candidate, score) < threshold) { dropped.push(candidate); continue; }

    // And is it worth what it costs, as opposed to merely relevant? The
    // ranking above says which candidates resemble the goal most; this says
    // whether including one saves more than it spends. Suspended while
    // widening, for the same reason the marginal test is: when we do not
    // understand the goal, our estimate of what the agent will need is exactly
    // what is unreliable, and pruning on an unreliable estimate is how an
    // agent ends up re-deriving by grep what it was nearly handed.
    if (input.state && !widening && netValueAt(candidate, baseTokens, input.state) <= 0) {
      dropped.push(candidate);
      continue;
    }

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

    // Separately from the render budget: is the whole file worth opening?
    // Asked only of candidates that made the cut — a file not worth a line of
    // description is not worth a read — and only when there is a state to price
    // it against.
    let fullArtifactValue: number | undefined;
    if (input.state && offersFullArtifact(candidate)) {
      const fullTokens = tokensAt(candidate, 'L3');
      const value = netValueAt(candidate, fullTokens, input.state);
      if (value > 0) {
        fullArtifactValue = value;
        fullArtifactRequests.push({
          candidateKey: candidate.key, path: candidate.path,
          tokens: fullTokens, expectedNetValue: value,
        });
      }
    }

    selected.push({
      ...candidate,
      selectedLevel: level,
      selectedTokens: tokens,
      score,
      materialization: materializationFor(candidate, level),
      ...(fullArtifactValue === undefined ? {} : { fullArtifactValue }),
    });
  }

  return {
    selected,
    dropped,
    estimatedTokens: spent,
    truncated,
    confidence: selected.length === 0
      ? 0
      : selected.reduce((sum, c) => sum + c.confidenceScore, 0) / selected.length,
    // Best first, then by path: the same selection must produce the same
    // request order, because the boundary acts on the head of this list.
    fullArtifactRequests: fullArtifactRequests.sort((a, b) =>
      b.expectedNetValue - a.expectedNetValue || (a.path < b.path ? -1 : 1)),
  };
}

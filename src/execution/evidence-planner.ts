/** The cheapest next thing to find out — or the decision to stop finding out.
 *
 *  Most of the cost of an agent run is evidence gathering, and most of the waste
 *  in it is gathering evidence that was already held, or that would not have
 *  changed the answer. This ranks the available ways of closing one gap by what
 *  they are expected to teach divided by what they cost, and — the part that
 *  actually saves money — declines to gather anything when the frontier is
 *  already closed.
 *
 *  Deterministic and model-free. A planner that needed a model call to decide
 *  whether to make a model call would be a tax on every decision, paid whether
 *  or not it found a saving.
 */
import type { ContextRef } from '../context/types.js';
import { isClosed, type KnowledgeFrontier } from '../context/frontier.js';

/** Ordered by what they cost, cheapest first. The order is not the policy —
 *  the score is — but it is the tie-break, so an action that teaches the same
 *  thing for less always wins. */
export const EVIDENCE_ACTIONS = [
  'reuse', 'expand', 'search', 'read_symbol', 'run_test', 'run_model', 'spawn_agent',
] as const;

export type EvidenceAction = typeof EVIDENCE_ACTIONS[number];

export interface EvidenceCandidate {
  action: EvidenceAction;
  /** What it would settle. */
  ref?: ContextRef;
  /** Tokens it would add to a prompt, or spend producing. */
  estimatedTokens: number;
  estimatedLatencyMs: number;
  /** How much of the gap it is expected to close, 0 to 1. Deliberately coarse:
   *  a precise-looking number derived from nothing is worse than an honest
   *  bracket, and every value here comes from the action's kind rather than
   *  from a model's opinion. */
  expectedGain: number;
  reason: string;
}

export interface EvidenceDecision {
  /** Null when the right move is to gather nothing. */
  chosen: EvidenceCandidate | null;
  stop: boolean;
  /** Why, in words that name the alternative rather than restating the choice. */
  reason: string;
  /** Every candidate with its score, best first. The receipt. */
  ranked: { candidate: EvidenceCandidate; score: number }[];
}

/** Tokens and milliseconds are not comparable, so both are normalized against
 *  what a middling instance of each costs before they are added. The constants
 *  are order-of-magnitude anchors from the measured run, not calibrations. */
const TOKEN_ANCHOR = 10_000;
const LATENCY_ANCHOR = 30_000;

export function scoreCandidate(candidate: EvidenceCandidate): number {
  const cost = candidate.estimatedTokens / TOKEN_ANCHOR + candidate.estimatedLatencyMs / LATENCY_ANCHOR;
  // A free action with any expected gain is unboundedly good, which is correct:
  // reusing something already held should always beat fetching it again.
  if (cost <= 0) return candidate.expectedGain > 0 ? Number.POSITIVE_INFINITY : 0;
  return candidate.expectedGain / cost;
}

/** The floor below which gathering is not worth its own cost. A candidate that
 *  would spend a whole dispatch to close a tenth of one gap is how an agent
 *  ends up with forty turns and no answer. */
export const MIN_WORTHWHILE_SCORE = 0.05;

export function planEvidence(
  frontier: KnowledgeFrontier,
  candidates: EvidenceCandidate[],
): EvidenceDecision {
  const ranked = candidates
    .map((candidate) => ({ candidate, score: scoreCandidate(candidate) }))
    .sort((a, b) => b.score - a.score
      || EVIDENCE_ACTIONS.indexOf(a.candidate.action) - EVIDENCE_ACTIONS.indexOf(b.candidate.action));

  // Closed first, and before looking at candidates at all: the whole point is
  // that a closed frontier makes every candidate irrelevant however good it
  // looks on its own.
  if (isClosed(frontier)) {
    return { chosen: null, stop: true, reason: 'the knowledge frontier is closed — nothing outstanding to find out', ranked };
  }
  if (ranked.length === 0) {
    return { chosen: null, stop: true, reason: 'nothing outstanding can be settled by any available action', ranked };
  }

  const best = ranked[0];
  if (best.score < MIN_WORTHWHILE_SCORE) {
    return {
      chosen: null,
      stop: true,
      reason: `the best available evidence (${best.candidate.action}) would cost more than it is expected to be worth`,
      ranked,
    };
  }

  const runnerUp = ranked[1];
  return {
    chosen: best.candidate,
    stop: false,
    reason: runnerUp
      ? `${best.candidate.action} over ${runnerUp.candidate.action}: ${best.candidate.reason}`
      : best.candidate.reason,
    ranked,
  };
}

export interface CandidateInputs {
  /** Objects already held, keyed by the semantic identity they would settle. */
  held: Map<string, { ref: ContextRef; tokens: number }>;
  /** Cheaper representations available for a held object. */
  expandable: Map<string, { ref: ContextRef; tokens: number }>;
  /** What a fresh dispatch would cost, from the ledger rather than a guess. */
  dispatchTokens: number;
  dispatchLatencyMs: number;
}

/** Deterministic candidates for one outstanding ref, from what the graph
 *  already holds. No model, no network, no repository scan. */
export function candidatesFor(ref: ContextRef, inputs: CandidateInputs): EvidenceCandidate[] {
  const candidates: EvidenceCandidate[] = [];
  const held = inputs.held.get(ref.semanticId);
  const expandable = inputs.expandable.get(ref.semanticId);

  if (held) {
    candidates.push({
      action: 'reuse', ref,
      // Already in hand. Not free to *send* — that is `estimatedTokens` — but
      // free to obtain, which is what makes it beat everything else.
      estimatedTokens: held.tokens, estimatedLatencyMs: 0, expectedGain: 1,
      reason: `${ref.semanticId} is already held at this version`,
    });
  }
  if (expandable) {
    candidates.push({
      action: 'expand', ref,
      estimatedTokens: expandable.tokens, estimatedLatencyMs: 0, expectedGain: 0.8,
      reason: `${ref.semanticId} can be expanded from what is already indexed`,
    });
  }

  candidates.push({
    action: 'search', ref,
    estimatedTokens: 200, estimatedLatencyMs: 500, expectedGain: 0.4,
    reason: `search could locate ${ref.semanticId} without a dispatch`,
  });

  candidates.push({
    action: 'run_model', ref,
    estimatedTokens: inputs.dispatchTokens, estimatedLatencyMs: inputs.dispatchLatencyMs, expectedGain: 0.9,
    reason: `a dispatch would settle ${ref.semanticId}, at the cost of a whole sandbox`,
  });

  return candidates;
}

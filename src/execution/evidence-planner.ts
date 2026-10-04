/** Ways of closing one knowledge gap, offered to the Action Market.
 *
 *  This used to rank them itself — expected gain over normalized cost, with a
 *  floor below which it declined to gather — and return *the* choice. That was
 *  a second market with its own objective. Now it only proposes: each way of
 *  settling a gap becomes an `ActionCandidate` priced in the market's units,
 *  and `chooseEconomicAction` decides whether any of them beats carrying on.
 *  A closed frontier proposes nothing, which is how "nothing outstanding to
 *  find out" becomes the null action rather than a special case.
 *
 *  Deterministic and model-free. */
import type { ContextRef } from '../context/types.js';
import { isClosed, type KnowledgeFrontier } from '../context/frontier.js';
import { actionCandidate, type ActionCandidate, type ActionKind } from '../decision/actions.js';

/** Every way of closing a gap, cheapest kind first. */
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

const KIND: Record<EvidenceAction, { kind: ActionKind; capability: string }> = {
  reuse: { kind: 'reuse_evidence', capability: 'evidence.reuse' },
  expand: { kind: 'acquire_evidence', capability: 'context.expand' },
  search: { kind: 'acquire_evidence', capability: 'evidence.search' },
  read_symbol: { kind: 'acquire_evidence', capability: 'context.read-symbol' },
  run_test: { kind: 'validate', capability: 'validation.test' },
  run_model: { kind: 'acquire_evidence', capability: 'evidence.dispatch' },
  spawn_agent: { kind: 'parallelize', capability: 'evidence.delegate' },
};

/** The ways of settling the frontier's open gaps, as market candidates.
 *
 *  What a way is worth is the rediscovery it makes unnecessary: the share of
 *  the gap it is expected to close, times what finding the answer by
 *  exploration would otherwise cost (`gapValueTokens`, the caller's
 *  measurement). Its cost is what it spends. Everything else is the market's. */
export function evidenceActions(
  frontier: KnowledgeFrontier,
  candidates: EvidenceCandidate[],
  gapValueTokens: number,
): ActionCandidate[] {
  if (isClosed(frontier)) return [];
  return candidates.map((candidate, index) => actionCandidate({
    id: `evidence:${candidate.action}:${candidate.ref?.semanticId ?? index}`,
    ...KIND[candidate.action],
    tokenCost: candidate.estimatedTokens,
    latencyCost: candidate.estimatedLatencyMs,
    expectedInformationGain: candidate.expectedGain,
    expectedTokenBenefit: candidate.expectedGain * Math.max(0, gapValueTokens),
    // Reuse is of something already held at this version: its effect is as
    // certain as anything the runtime knows.
    confidence: candidate.action === 'reuse' ? 1 : 0.8,
    metadata: { evidenceAction: candidate.action, reason: candidate.reason, ...(candidate.ref ? { ref: candidate.ref } : {}) },
  }));
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

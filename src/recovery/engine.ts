/** Is trying again worth it, and what does the next attempt already know?
 *
 *  Two questions the runtime currently answers by not asking them. The
 *  model-fallback retry in `node-actor-manager.ts` re-runs a whole dispatch with
 *  the same goal and no memory of the first; the node machine's retry loop does
 *  the same. Both are correct for what they are — a runtime refusing a model is
 *  not a strategy failure — and neither is recovery.
 *
 *  Recovery is the case where the *approach* was wrong. And there the two
 *  expensive mistakes are symmetric:
 *
 *   - **Retrying blind.** The second attempt re-reads what the first read and
 *     re-derives what it derived, at full price, for a worse chance.
 *   - **Retrying the same idea.** The second attempt carries the belief that
 *     killed the first, and walks the same dead end.
 *
 *  So a retry is priced with its inheritance: it keeps what was *observed* and
 *  drops what was *supposed*, and what it keeps is subtracted from what it will
 *  cost. A run that has already established most of what it needs is cheap to
 *  retry and should be; one that established nothing is expensive and usually
 *  should not be.
 *
 *  Deterministic and total: no model, no clock, no I/O. */
import { clamp01 } from '../efficiency/policy-types.js';
import { actionCandidate, type ActionCandidate } from '../decision/actions.js';
import type { EconomicState, EvidenceRef } from '../decision/state.js';
import type { RecoveryEvaluation, RecoveryTombstone } from './types.js';

export type { RecoveryEvaluation, RecoveryTombstone };

/** Evidence kinds that survive a failed strategy.
 *
 *  A fact is something observed; a validation is something checked. Neither
 *  becomes untrue because the plan built on it was wrong. An `observation` is
 *  weaker — the run looked somewhere — but looking still happened, and paying to
 *  look again buys nothing.
 *
 *  A `hypothesis` is the one kind that does not survive. It is a belief, and the
 *  attempt failing is evidence against it. */
const SURVIVES: ReadonlySet<EvidenceRef['kind']> = new Set(['fact', 'validation', 'observation']);

/** What the next attempt inherits, and what it must not.
 *
 *  Prior tombstones are honoured: evidence a *previous* recovery invalidated
 *  stays invalidated, so a run cannot resurrect a disproven belief by failing
 *  again. */
export function partitionEvidence(
  state: EconomicState,
  tombstones: RecoveryTombstone[] = [],
): { retained: EvidenceRef[]; invalidated: EvidenceRef[] } {
  const alreadyDead = new Set(tombstones.flatMap((t) => t.invalidatedEvidenceIds));
  const retained: EvidenceRef[] = [];
  const invalidated: EvidenceRef[] = [];
  for (const ref of state.evidence) {
    if (SURVIVES.has(ref.kind) && !alreadyDead.has(ref.id)) retained.push(ref);
    else invalidated.push(ref);
  }
  return { retained, invalidated };
}

/** How much of what the run knows it gets to keep, by value rather than by
 *  count. Evidence that cost a lot to acquire is worth more to keep than
 *  evidence that was free, and a count would treat them the same. */
function retainedShare(retained: EvidenceRef[], invalidated: EvidenceRef[]): number {
  const value = (refs: EvidenceRef[]) =>
    refs.reduce((sum, ref) => sum + Math.max(1, ref.tokenCost ?? 0) * ref.confidence, 0);
  const kept = value(retained);
  const lost = value(invalidated);
  return kept + lost <= 0 ? 0 : kept / (kept + lost);
}

/** How likely trying again is to get further.
 *
 *  Falls with each attempt that already died the *same* way, and is untouched by
 *  attempts that died differently — a run working through three distinct
 *  problems is making progress, and counting those against it would stop
 *  exactly the run that is going to succeed. Rises with what the retry
 *  inherits, because an attempt that starts with the ground already mapped is a
 *  genuinely different attempt from the one that mapped it.
 *
 *  Halving per identical repeat rather than a fixed decrement: the difference
 *  between the first retry and the second is large, between the fourth and the
 *  fifth negligible, and a linear model gets both ends wrong. */
export function successProbability(
  state: EconomicState,
  failureSignature: string,
  tombstones: RecoveryTombstone[],
  retained: number,
): number {
  const sameWay = tombstones.filter((t) => t.failureSignature === failureSignature).length;
  // The base chance a fresh approach works, before anything is known about the
  // run. Half: a retry is a coin toss until evidence says otherwise, and
  // claiming more would make recovery look profitable on every failure.
  const base = 0.5 * 0.5 ** sameWay;
  // What it inherits pulls it up, and what it has already achieved pulls it up:
  // a run 80% of the way through that hit a wall is a better bet than one that
  // fell over at the start.
  return clamp01(base * (1 + retained) * (1 + state.trajectory.progress) / 2 + base / 2);
}

export interface EvaluateRecoveryInput {
  state: EconomicState;
  /** How this attempt died, fingerprinted. */
  failureSignature: string;
  /** Every previous recovery on this task. */
  tombstones?: RecoveryTombstone[];
  /** Hypotheses this attempt rested on, if the caller can name them. */
  hypothesisIds?: string[];
}

/** Whether to retry, and on what terms. */
export function evaluateRecovery(input: EvaluateRecoveryInput): RecoveryEvaluation {
  const { state, failureSignature } = input;
  const tombstones = input.tombstones ?? [];
  const reasonCodes: string[] = [];

  const { retained, invalidated } = partitionEvidence(state, tombstones);
  const named = new Set(input.hypothesisIds ?? []);
  // Anything the caller named as a hypothesis is invalidated even if its kind
  // said otherwise: the caller knows what the attempt was resting on and this
  // module does not.
  const retainedRefs = retained.filter((ref) => !named.has(ref.id));
  const invalidatedRefs = [...invalidated, ...retained.filter((ref) => named.has(ref.id))];

  const share = retainedShare(retainedRefs, invalidatedRefs);
  const expectedSuccessProbability = successProbability(state, failureSignature, tombstones, share);

  // What the retry has to do: the work still outstanding, discounted by the
  // ground it does not have to cover again. This is the whole economic
  // argument for keeping evidence — it shows up here as a smaller number.
  const outstanding = state.resources.remainingTokens * (1 - state.trajectory.progress);
  const expectedCost = Math.max(0, outstanding * (1 - share));

  // The value of succeeding: everything already spent stops being wasted. A
  // task that has spent a lot and is nearly there has the most to save, which
  // is exactly when a retry is worth making.
  const value = state.resources.consumedTokens;
  const expectedValue = expectedSuccessProbability * value;

  const affordable = expectedCost <= state.resources.remainingTokens;
  if (!affordable) reasonCodes.push('recovery_unaffordable');
  if (state.constraints.hardStop) reasonCodes.push('hard_stop');
  if (retainedRefs.length > 0) reasonCodes.push(`retains_evidence:${retainedRefs.length}`);
  if (invalidatedRefs.length > 0) reasonCodes.push(`invalidates_hypotheses:${invalidatedRefs.length}`);
  const sameWay = tombstones.filter((t) => t.failureSignature === failureSignature).length;
  if (sameWay > 0) reasonCodes.push(`repeat_failure:${sameWay}`);

  const justified = affordable
    && !state.constraints.hardStop
    && expectedValue > expectedCost;
  reasonCodes.push(justified ? 'recovery_justified' : 'recovery_not_justified');

  return {
    justified,
    expectedSuccessProbability,
    expectedCost,
    retainedEvidenceIds: retainedRefs.map((ref) => ref.id),
    invalidatedEvidenceIds: invalidatedRefs.map((ref) => ref.id),
    reasonCodes,
  };
}

/** The record this attempt leaves behind for the next one.
 *
 *  A hypothesis the caller names here is *invalidated*, not merely noted.
 *  Recording it in `hypothesisIds` alone would produce a tombstone that
 *  describes what the attempt believed and does nothing to stop the next
 *  attempt believing it — which is the one job a tombstone has. Naming it also
 *  removes it from what the next attempt inherits, for the same reason. */
export function tombstoneFor(input: {
  id: string;
  evaluation: RecoveryEvaluation;
  failureSignature: string;
  tokensSpent: number;
  hypothesisIds?: string[];
}): RecoveryTombstone {
  const named = [...new Set(input.hypothesisIds ?? [])];
  const invalidated = [...new Set([...input.evaluation.invalidatedEvidenceIds, ...named])].sort();
  const dead = new Set(invalidated);
  return {
    id: input.id,
    hypothesisIds: named.length > 0 ? named : [...input.evaluation.invalidatedEvidenceIds],
    retainedEvidenceIds: input.evaluation.retainedEvidenceIds.filter((id) => !dead.has(id)),
    invalidatedEvidenceIds: invalidated,
    failureSignature: input.failureSignature,
    tokensSpent: Math.max(0, input.tokensSpent),
  };
}

/** The retry, expressed as something the generic engine can rank against
 *  validating, acquiring evidence or doing nothing.
 *
 *  This is the integration, and it is deliberately a translation rather than a
 *  branch: recovery gets no privileged path through the decision layer, and it
 *  wins only when its numbers beat everything else's. */
export function recoveryCandidate(
  evaluation: RecoveryEvaluation,
  state: EconomicState,
): ActionCandidate {
  return actionCandidate({
    id: 'recovery:retry',
    kind: 'recover',
    capability: 'recovery.evidence-preserving',
    expectedProgress: evaluation.expectedSuccessProbability,
    // What succeeding saves: the spend that would otherwise have bought
    // nothing, weighted by how likely succeeding is.
    expectedTokenBenefit: evaluation.expectedSuccessProbability * state.resources.consumedTokens,
    tokenCost: evaluation.expectedCost,
    // The honest thing about a retry is that it may fail the same way.
    failureRisk: clamp01(1 - evaluation.expectedSuccessProbability),
    confidence: state.trajectory.orchestrationConfidence,
    metadata: {
      retainedEvidenceIds: evaluation.retainedEvidenceIds,
      invalidatedEvidenceIds: evaluation.invalidatedEvidenceIds,
      reasonCodes: evaluation.reasonCodes,
    },
  });
}

/** Whether trying *this* strategy again could possibly help.
 *
 *  Separate from `evaluateRecovery`, and the separation is the point. That one
 *  asks whether retrying is worth the money; this one asks whether the retry is
 *  a different attempt at all. A run that failed the same way twice under the
 *  same strategy and made no progress in between is not recovering — it is
 *  paying for the same sandbox to reach the same wall, and the measured version
 *  of that was three full dispatches into one identical refusal.
 *
 *  What it does *not* do is stop recovery. A new strategy after an identical
 *  failure is exactly the right move, and this returns true for it. The rule is
 *  "not the same idea again", never "not again". */
export interface StrategyRetryInput {
  currentStrategy: string;
  /** Strategies already attempted on this task, in order. */
  previousStrategies: string[];
  /** How this attempt died, fingerprinted the way `trajectory.ts` does it. */
  failureSignature: string;
  previousFailureSignatures: string[];
  /** How far the failed attempt got, on [0,1]. Progress is what makes a repeat
   *  of the same strategy a genuinely different attempt: the second one starts
   *  somewhere the first had to reach. */
  progress: number;
}

/** Below this, the attempt established nothing the next one can build on. */
const MEANINGFUL_PROGRESS = 0.05;

export function strategyRetryAllowed(input: StrategyRetryInput): boolean {
  const sameStrategy = input.previousStrategies.includes(input.currentStrategy);
  const sameFailure = input.previousFailureSignatures.includes(input.failureSignature);
  // Same idea, same wall, nothing gained. The only combination that is refused.
  if (sameStrategy && sameFailure && input.progress <= MEANINGFUL_PROGRESS) return false;
  return true;
}

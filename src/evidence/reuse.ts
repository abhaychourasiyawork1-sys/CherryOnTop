/** Should this run believe what a previous run wrote down?
 *
 *  The tempting answer is "yes, it saved a search". The tempting answer is how
 *  cross-run memory turns into a system that is confidently wrong about a
 *  repository it has not looked at in six weeks — and being confidently wrong
 *  costs far more than the search it avoided, because the run acts on it and
 *  then has to discover the mistake.
 *
 *  So the question is priced rather than answered, and three things bound it:
 *
 *   - **Current evidence outranks history, always.** If this run has already
 *     observed the thing, the stored item is worth nothing: it cannot add to
 *     what was just seen, and it can contradict it. This is an architectural
 *     invariant rather than a weighting, so it is checked first and cannot be
 *     bought by a large enough benefit.
 *   - **A revision mismatch is not a disqualification, it is a cost.** The item
 *     may still be true; establishing that it is costs something, and sometimes
 *     the verification is still cheaper than the rediscovery. Sometimes it is
 *     not, and then the honest answer is to go and look.
 *   - **Staleness compounds with what the claim is about.** A `fact` about a
 *     specific revision rots the moment the file changes. A `pattern` — where
 *     tests live, how modules are named — usually outlives a hundred revisions,
 *     which is exactly why it is a separate kind rather than a confidence
 *     number.
 *
 *  Deterministic and total: no model, no clock, no I/O. */
import { clamp01 } from '../efficiency/policy-types.js';
import type { EconomicState } from '../decision/state.js';
import type { KnowledgeItem } from './types.js';

export interface ReuseEvaluation {
  /** Worth using at all — directly or after checking. */
  usable: boolean;
  /** Safe to believe as-is. */
  directReuse: boolean;
  /** Worth using, but only after establishing it is still true. */
  requiresVerification: boolean;
  /** Tokens this saves, net of nothing — the gross figure. */
  expectedBenefit: number;
  /** What getting it out of the store costs. Small by construction; see
   *  `store.ts`, where every query is indexed and bounded. */
  retrievalCost: number;
  /** What establishing it is still true would cost. Zero for direct reuse. */
  verificationCost: number;
  /** [0,1]. How likely it is no longer true. */
  staleRisk: number;
  reasonCodes: string[];
}

/** How fast each kind of claim rots.
 *
 *  The multiplier on staleness when the revision does not match. A `fact` about
 *  a revision is about *that* revision; a `pattern` is about how the repository
 *  is arranged, which changes far more slowly than its contents. Stating this
 *  as a per-kind number rather than one decay rate is the whole reason `kind`
 *  exists as a column. */
const STALENESS_BY_KIND: Record<KnowledgeItem['kind'], number> = {
  fact: 0.7,
  observation: 0.5,
  pattern: 0.15,
};

/** What verifying a claim costs, as a share of what rediscovering it would.
 *
 *  Checking that a stored claim still holds is cheaper than deriving it from
 *  nothing — you know what to look at — but it is not free, and a model that
 *  made it free would reuse everything. A third is deliberately conservative. */
const VERIFICATION_SHARE = 0.34;

/** What retrieving one item costs. Small and non-zero: retrieval that claims to
 *  be free is retrieval nobody can hold to account, and this is the number that
 *  makes "memory net value" a measurable quantity rather than an assumption. */
export const RETRIEVAL_TOKEN_COST = 5;

/** What not having to rediscover this is worth, in tokens.
 *
 *  Priced from what the item cost to establish in the first place — the length
 *  of what was learned, times the several turns of searching that produced it.
 *  Deliberately crude, and deliberately tied to the item rather than to the
 *  budget: a large claim is worth more to reuse than a small one, whatever the
 *  task's budget happens to be. */
function rediscoveryValue(item: KnowledgeItem): number {
  // Roughly the tokens the content itself represents, times the turns an agent
  // would spend arriving at it. The same discovery model `information-economics`
  // uses, applied to a claim rather than to a file.
  const contentTokens = Math.ceil(item.content.length / 4);
  return contentTokens * 3 * item.confidence;
}

/** Does this run already know, first-hand, what the item is about?
 *
 *  Matched on the item's own provenance: the paths and symbols it was derived
 *  from. A run that has read `src/auth/session.ts` this session does not need a
 *  stored claim about `src/auth/session.ts`, and must not be offered one that
 *  could contradict what it just saw. */
function alreadyObserved(item: KnowledgeItem, state: EconomicState): boolean {
  if (state.evidence.length === 0) return false;
  const observed = new Set(state.evidence.map((ref) => ref.id.replace(/^observed:/, '')));
  const subjects = [...item.sourcePaths, ...item.sourceSymbols];
  return subjects.length > 0 && subjects.some((subject) => observed.has(subject));
}

export function evaluateHistoricalEvidence(input: {
  item: KnowledgeItem;
  state: EconomicState;
}): ReuseEvaluation {
  const { item, state } = input;
  const reasonCodes: string[] = [];

  const refuse = (...codes: string[]): ReuseEvaluation => ({
    usable: false, directReuse: false, requiresVerification: false,
    expectedBenefit: 0, retrievalCost: RETRIEVAL_TOKEN_COST, verificationCost: 0,
    staleRisk: 1, reasonCodes: [...reasonCodes, ...codes],
  });

  // First, and unbuyable. Current validated repository evidence outranks
  // historical knowledge — not as a weighting that a large enough benefit could
  // overturn, but as a rule.
  if (alreadyObserved(item, state)) return refuse('current_evidence_outranks_history');

  if (item.invalidatedAt) return refuse('withdrawn');

  const sameRevision = Boolean(state.repositoryRevision) && item.revision === state.repositoryRevision;
  const sameRepository = !state.repository || item.repository === state.repository;
  if (!sameRepository) return refuse('different_repository');

  // Staleness: zero at the same revision, and otherwise how fast this *kind* of
  // claim rots, discounted by how much it was believed and whether anything
  // checked it.
  const staleRisk = sameRevision
    ? 0
    : clamp01(STALENESS_BY_KIND[item.kind] * (1 - item.confidence * (item.validated ? 1 : 0.7)));

  const gross = rediscoveryValue(item);
  // What it is worth given it might be wrong. Believing a stale claim costs the
  // rediscovery *and* the work done on top of it, which is why the risk is
  // subtracted twice over rather than once.
  const expectedBenefit = gross * (1 - staleRisk);
  const verificationCost = sameRevision ? 0 : gross * VERIFICATION_SHARE;

  if (sameRevision) reasonCodes.push('same_revision');
  else reasonCodes.push('revision_mismatch');
  if (item.validated) reasonCodes.push('validated');
  reasonCodes.push(`kind:${item.kind}`);

  // Direct reuse is for the case where there is nothing to check: the same
  // revision, and something other than the producing agent agreed. Anything
  // less gets verified or gets looked up again.
  const directReuse = sameRevision && item.validated;
  const totalCost = RETRIEVAL_TOKEN_COST + (directReuse ? 0 : verificationCost);
  const usable = expectedBenefit > totalCost;

  if (directReuse) reasonCodes.push('direct_reuse');
  else if (usable) reasonCodes.push('requires_verification');
  else reasonCodes.push('rediscovery_is_cheaper');

  return {
    usable,
    directReuse: directReuse && usable,
    requiresVerification: usable && !directReuse,
    expectedBenefit,
    retrievalCost: RETRIEVAL_TOKEN_COST,
    verificationCost: directReuse ? 0 : verificationCost,
    staleRisk,
    reasonCodes,
  };
}

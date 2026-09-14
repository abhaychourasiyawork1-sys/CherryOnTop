/** What could be done about it, once the screen has said there is something.
 *
 *  The deep path is where the expensive lookups live — structural evidence,
 *  historical knowledge, validation capabilities, scheduling data — and it is
 *  reached only when `inspectFastPath` has already found a material
 *  opportunity. That ordering is the entire cost argument: the cheap check runs
 *  always, the expensive one runs rarely.
 *
 *  Its job is to *propose*, never to choose. It returns candidates;
 *  `chooseEconomicAction` ranks them. Keeping those apart is what stops a
 *  proposer from quietly becoming a decider with privileged knowledge — and it
 *  is what makes a new capability a new *source* rather than a new branch.
 *
 *  Which is the extension point: a capability contributes a `CandidateSource`,
 *  a pure function from state to candidates. There is no per-capability schema
 *  and no registry of task shapes, because either would be a pathway with a
 *  different name. */
import { clamp01 } from '../efficiency/policy-types.js';
import { duplicationSignal, failureSignal, validationSignal } from './fast-path.js';
import { actionCandidate, type ActionCandidate } from './actions.js';
import type { EconomicState } from './state.js';

export type CandidateSource = (state: EconomicState) => ActionCandidate[];

/** Registered sources, in registration order. A module-level registry rather
 *  than a parameter threaded through six call sites, for the same reason the
 *  sandbox limiter and the efficiency ledger are: what it holds is a property
 *  of the process, not of any one node. */
const sources: Array<{ name: string; source: CandidateSource }> = [];

/** Adds a candidate source, replacing any earlier one with the same name.
 *
 *  Replacing rather than appending matters: the integration points register on
 *  import, and a test that imports a module twice must not get two copies of
 *  its candidates. Returns an unregister function so a test can clean up
 *  without reaching into module state. */
export function registerCandidateSource(name: string, source: CandidateSource): () => void {
  const existing = sources.findIndex((entry) => entry.name === name);
  if (existing >= 0) sources.splice(existing, 1);
  sources.push({ name, source });
  return () => {
    const index = sources.findIndex((entry) => entry.name === name);
    if (index >= 0) sources.splice(index, 1);
  };
}

/** Exists for tests and for `doctor`. Production never calls it. */
export function registeredCandidateSources(): string[] {
  return sources.map((entry) => entry.name);
}

/** Re-entrancy guard.
 *
 *  A candidate source that reaches back into the deep path — directly, or via a
 *  helper that happens to call it — would recurse until the stack gave out, and
 *  would do so only in production where the expensive sources are registered.
 *  The guard makes that a silently-empty inner call rather than a crash, and a
 *  test pins it so the property is asserted rather than hoped for. */
let evaluating = false;

/** True while a deep evaluation is in progress. Read by
 *  `orchestration-loop.ts`, which must not start a second cycle inside one. */
export function deepPathInProgress(): boolean {
  return evaluating;
}

/** How confident a state-derived proposal can be.
 *
 *  Capped below 1 on purpose: these are inferences from aggregate signals, not
 *  observations. A source with real evidence behind it may claim more. */
const STATE_DERIVED_CONFIDENCE_CEILING = 0.8;

/** Candidates readable from the state alone — no lookup, no I/O.
 *
 *  Three, and each is the generic form of something the runtime already does
 *  ad hoc: prove the work (the definition-of-done check), retry differently
 *  (the model-fallback path), and stop covering the same ground (what the spend
 *  guard's stall branch fires on). Expressing them as candidates rather than as
 *  branches is what makes them comparable with everything else. */
function stateDerivedCandidates(state: EconomicState): ActionCandidate[] {
  const out: ActionCandidate[] = [];
  const remaining = state.resources.remainingTokens;

  // Proving the work. Worth proposing exactly when there is something to prove
  // and doubt that it is right — an unvalidated near-finished task is where a
  // false success comes from.
  //
  // The pathology expressions are the screen's own, imported rather than
  // restated: a proposer that measured them differently would propose fixes for
  // opportunities the screen never saw, and stay silent on ones it did.
  const unvalidated = validationSignal(state);
  if (unvalidated > 0) {
    out.push(actionCandidate({
      id: 'deep:validate',
      kind: 'validate',
      capability: 'validation.progressive',
      expectedQualityBenefit: unvalidated,
      expectedInformationGain: clamp01(state.uncertainty.validation),
      // Priced as a share of what is left rather than a fixed number: a cheap
      // validation on a large budget and an expensive one on a small budget are
      // the same decision, and a constant would make them different ones.
      tokenCost: Math.round(remaining * 0.08),
      latencyCost: 30_000,
      confidence: clamp01(state.trajectory.orchestrationConfidence, 0.5) * STATE_DERIVED_CONFIDENCE_CEILING,
      metadata: { reason: 'unvalidated_progress' },
    }));
  }

  // Retrying, differently. Proposed on accumulated failure with little to show
  // for it — and deliberately carrying a real `failureRisk`, because the
  // honest thing about a retry is that it may fail the same way.
  const failureWithoutProgress = failureSignal(state);
  if (failureWithoutProgress > 0) {
    out.push(actionCandidate({
      id: 'deep:recover',
      kind: 'recover',
      capability: 'recovery.evidence-preserving',
      expectedProgress: failureWithoutProgress,
      // What a retry saves is the rest of a run that was going to fail anyway.
      expectedTokenBenefit: Math.round(remaining * failureWithoutProgress),
      tokenCost: Math.round(remaining * 0.15),
      failureRisk: clamp01(1 - failureWithoutProgress),
      confidence: clamp01(state.trajectory.orchestrationConfidence, 0.5) * STATE_DERIVED_CONFIDENCE_CEILING,
      metadata: { reason: 'failure_without_progress' },
    }));
  }

  // Narrowing. The cheapest possible intervention — it spends no tokens of its
  // own — and the right answer to a run going over the same ground: not "stop",
  // which throws away the work, and not "give it more context", which pays to
  // widen a search that is already too wide.
  const wasteful = duplicationSignal(state);
  if (wasteful > 0) {
    out.push(actionCandidate({
      id: 'deep:constrain',
      kind: 'constrain',
      capability: 'agent.narrow-scope',
      expectedTokenBenefit: Math.round(remaining * wasteful * 0.5),
      expectedInformationGain: clamp01(wasteful * 0.5),
      tokenCost: 0,
      // Narrowing a search can hide the answer. Small, and non-zero.
      qualityRisk: clamp01(wasteful * 0.1),
      confidence: clamp01(state.trajectory.orchestrationConfidence, 0.5) * STATE_DERIVED_CONFIDENCE_CEILING,
      metadata: { reason: 'unproductive_repetition' },
    }));
  }

  return out;
}

/** Every action worth considering in this state.
 *
 *  Total: a source that throws costs the runtime that source's candidates and
 *  nothing else. An optimizer that can fail a dispatch by failing to optimize
 *  is worse than no optimizer. */
export function evaluateDeepPath(state: EconomicState): ActionCandidate[] {
  if (evaluating) return [];
  evaluating = true;
  try {
    const out = stateDerivedCandidates(state);
    for (const { name, source } of sources) {
      try {
        out.push(...source(state));
      } catch (err) {
        console.error(`The "${name}" candidate source failed; its options are unavailable for this decision:`, err);
      }
    }
    // Deterministic order in, deterministic ranking out. The engine's final
    // tie-break is the id, so sorting here costs nothing and makes the
    // *proposal* reproducible too — which is what a receipt is read against.
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  } finally {
    evaluating = false;
  }
}

// ---------------------------------------------------------------------------
// Historical knowledge as a candidate source.
//
// The join between the evidence plane and the decision layer. It lives here
// rather than in `evidence/` because the direction matters: the deep path
// *asks* whether stored knowledge is worth retrieving, and the store has no
// opinion about the decision. A store that could propose actions would be a
// second decider with privileged access to what it itself wrote down.
//
// Two bounds keep retrieval from becoming the cost it exists to avoid:
//
//  - It runs only inside the deep path, which the screen has already decided is
//    worth paying for. A healthy run never touches the store at all.
//  - It asks only when structural or target doubt is what is actually
//    outstanding. Stored knowledge is about *where things are and how they
//    work*; offering it to a run whose problem is whether its change is correct
//    would be paying to answer a question nobody asked.
// ---------------------------------------------------------------------------

/** The most items one decision cycle will look at. Small on purpose: the
 *  ranking in `store.ts` already puts the best first, and a cycle that
 *  considers fifty candidates has spent more deciding than the top one could
 *  save. */
export const MAX_HISTORICAL_CANDIDATES = 5;

/** The least this source needs to know about a stored item.
 *
 *  Deliberately not `KnowledgeItem`. The decision layer importing the evidence
 *  plane's types would invert the dependency: the deep path *asks* whether
 *  knowledge is worth retrieving, and it must not acquire opinions about how
 *  knowledge is shaped in order to ask. */
export interface HistoricalItem {
  id: string;
  content: string;
}

/** The verdict `evidence/reuse.ts` returns, named structurally for the same
 *  reason. */
export interface ReuseVerdict {
  usable: boolean;
  directReuse: boolean;
  requiresVerification: boolean;
  expectedBenefit: number;
  retrievalCost: number;
  verificationCost: number;
  staleRisk: number;
  reasonCodes: string[];
}

export interface HistoricalSourceDeps<T extends HistoricalItem = HistoricalItem> {
  /** Bound to a database by the caller. This module never opens one. */
  lookup: (query: { repository: string; revision?: string; limit: number }) => T[];
  /** Prices one item against the state. Injected so the ranking here cannot
   *  drift from `evidence/reuse.ts`. */
  evaluate: (item: T, state: EconomicState) => ReuseVerdict;
}

/** A candidate source over stored knowledge, bound to one repository. */
export function historicalEvidenceSource<T extends HistoricalItem>(
  deps: HistoricalSourceDeps<T>,
): CandidateSource {
  return (state) => {
    if (!state.repository) return [];
    // What stored knowledge can answer. Asking when the outstanding doubt is
    // about correctness would be paying to answer a question nobody asked.
    const answerable = Math.max(state.uncertainty.structural, state.uncertainty.target);
    if (answerable <= 0) return [];

    const items = deps.lookup({
      repository: state.repository,
      revision: state.repositoryRevision,
      limit: MAX_HISTORICAL_CANDIDATES,
    });

    const out: ActionCandidate[] = [];
    for (const item of items) {
      const verdict = deps.evaluate(item, state);
      if (!verdict.usable) continue;
      out.push(actionCandidate({
        id: `historical:${item.id}`,
        kind: 'reuse_evidence',
        capability: 'evidence.store',
        expectedTokenBenefit: verdict.expectedBenefit,
        expectedInformationGain: clamp01(answerable * (1 - verdict.staleRisk)),
        tokenCost: verdict.retrievalCost + verdict.verificationCost,
        // Believing something stale is how cross-run memory becomes a system
        // that is confidently wrong. Priced as a quality risk, which is the one
        // term a token saving may never buy.
        qualityRisk: verdict.staleRisk,
        confidence: clamp01(state.trajectory.orchestrationConfidence * (1 - verdict.staleRisk)),
        metadata: {
          knowledgeId: item.id,
          directReuse: verdict.directReuse,
          requiresVerification: verdict.requiresVerification,
          content: item.content,
          reasonCodes: verdict.reasonCodes,
        },
      }));
    }
    return out;
  };
}

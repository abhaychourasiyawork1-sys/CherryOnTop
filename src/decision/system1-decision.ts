/** System-1 as an estimate refiner the market decides whether to buy.
 *
 *  The order is the architecture:
 *
 *    market decision on cheap estimates
 *     -> meta-VOI                 is a semantic answer worth its own cost?
 *     -> one System-1 question    about the current winner, and only it
 *     -> refined estimate         `action.helpful` scales the claimed benefit
 *     -> market decision again    `chooseEconomicAction`, unchanged
 *
 *  System-1 never selects anything. It answers one semantic fact — is this
 *  intervention actually going to help? — and the market re-prices. The old
 *  `runtime.next_action` tie-break, where a Choice picked among tied actions,
 *  is gone: a preference is not an estimate, and ties are broken by the same
 *  deterministic rule everywhere.
 *
 *  Why only the winner. Every estimate here already assumes the intervention
 *  helps fully; a semantic answer can only lower an intervention's claimed
 *  benefit, never raise it. So refining a loser cannot change the decision,
 *  and its expected value is exactly zero. The winner is the one question that
 *  can matter, and its value is bounded by how much choosing it would cost if
 *  it turned out useless, weighted by how unsure we are that it is not:
 *
 *      MetaVOI = (1 − confidence) × regret(winner useless) − System1Cost
 *
 *  Asked only when MetaVOI > 0 — at most one call per routing epoch. */
import { chooseEconomicAction } from './engine.js';
import { evaluateAction, usdPerToken, isNullAction } from './utility.js';
import type { ActionCandidate, ActionDecision } from './actions.js';
import type { EconomicState } from './state.js';
import { compileHarnessRequest, stateFacts } from '../system1/compiler.js';
import { withHelpfulness } from '../system1/economic-mapping.js';
import type { JudgeOutcome, System1 } from '../system1/guard.js';
import type { ReceiptContext } from '../system1/receipts.js';

/** What one System-1 question is assumed to cost before it is asked, in
 *  dollars. The real figure is measured after (input tokens × price) and
 *  recorded next to this one, so a mis-set prior is visible in telemetry. */
export const DEFAULT_SYSTEM1_CALL_USD = 0.002;

const KIND_WORDS: Record<string, string> = {
  acquire_evidence: 'Read more of the repository into context before continuing',
  explore: 'Explore the repository further before acting',
  validate: 'Run validation checks now to prove the work so far is correct',
  reuse_evidence: 'Reuse knowledge stored from an earlier run on this repository',
  parallelize: 'Split the remaining work across parallel agents',
  serialize: 'Do the remaining pieces one after another',
  recover: 'Abandon the current approach and retry with a different strategy',
  constrain: 'Narrow the agent to a smaller scope because it keeps covering the same ground',
  stop: 'Stop working on the task now',
};

export function describeCandidate(candidate: ActionCandidate): string {
  const base = KIND_WORDS[candidate.kind] ?? candidate.kind;
  const path = typeof candidate.metadata.path === 'string' ? ` (${candidate.metadata.path})` : '';
  return `${base}${path}`.slice(0, 200);
}

const probeId = 'system1-probe';

function chosenWith(state: EconomicState, candidates: ActionCandidate[]): ActionDecision {
  return chooseEconomicAction({ state, candidates, decisionId: probeId });
}

/** The semantic-demand test for one candidate: do "certainly useless" and
 *  "certainly useful" lead to different actions? */
export function helpfulnessMatters(state: EconomicState, candidates: ActionCandidate[], index: number): boolean {
  const target = candidates[index];
  if (isNullAction(target) || !evaluateAction(target, state).allowed) return false;
  const at = (p: number) => candidates.map((c, i) => (i === index ? withHelpfulness(c, p) : c));
  return chosenWith(state, at(0)).action.id !== chosenWith(state, at(1)).action.id;
}

export interface SemanticValue {
  /** Expected dollars a semantic answer saves, before paying for it. */
  valueUsd: number;
  costUsd: number;
  /** valueUsd − costUsd. Ask only when positive. */
  metaVoiUsd: number;
  /** Index of the one candidate worth asking about, when there is one. */
  subject: number | null;
}

/** MetaVOI for the current decision. Deterministic and cheap: two market runs
 *  over data already in memory. */
export function semanticRefinementValue(
  state: EconomicState,
  candidates: ActionCandidate[],
  decision: ActionDecision,
  callCostUsd: number = DEFAULT_SYSTEM1_CALL_USD,
): SemanticValue {
  const none = { valueUsd: 0, costUsd: callCostUsd, metaVoiUsd: -callCostUsd, subject: null };
  const index = candidates.findIndex((c) => c.id === decision.action.id);
  if (index < 0 || isNullAction(candidates[index])) return none;
  if (!helpfulnessMatters(state, candidates, index)) return none;

  // What we would be left with if the winner turned out useless, against what
  // we would pay for having chosen it anyway.
  const useless = withHelpfulness(candidates[index], 0);
  const alternative = chosenWith(state, candidates.map((c, i) => (i === index ? useless : c)));
  const costIfUseless = evaluateAction(useless, state).expectedCostUsd;
  const regret = Math.max(0, costIfUseless - (alternative.expectedCostUsd ?? costIfUseless));
  const valueUsd = (1 - candidates[index].confidence) * regret;
  return { valueUsd, costUsd: callCostUsd, metaVoiUsd: valueUsd - callCostUsd, subject: index };
}

export interface System1Refinement {
  decision: ActionDecision;
  outcomes: JudgeOutcome[];
  contexts: ReceiptContext[];
  /** The optimization-of-the-optimizer record: what the call was expected to
   *  be worth, what it cost, and whether it changed anything. */
  refinement: {
    invoked: boolean;
    valueUsd: number;
    expectedCostUsd: number;
    actualCostUsd: number;
    marginBeforeUsd: number | null;
    marginAfterUsd: number | null;
    decisionChanged: boolean;
  };
}

export async function refineWithSystem1(input: {
  s1: System1;
  scope: string;
  state: EconomicState;
  candidates: ActionCandidate[];
  decision: ActionDecision;
  callCostUsd?: number;
  /** Re-read after the provider answers, so a judgment about an older state is
   *  refused rather than applied. */
  currentStateVersion?: () => number;
}): Promise<System1Refinement> {
  const { s1, state } = input;
  const value = semanticRefinementValue(state, input.candidates, input.decision, input.callCostUsd);
  const skipped: System1Refinement = {
    decision: input.decision, outcomes: [], contexts: [],
    refinement: {
      invoked: false, valueUsd: value.valueUsd, expectedCostUsd: value.costUsd, actualCostUsd: 0,
      marginBeforeUsd: input.decision.margin?.absoluteUsd ?? null, marginAfterUsd: null, decisionChanged: false,
    },
  };
  if (value.subject === null || value.metaVoiUsd <= 0) return skipped;

  const subject = input.candidates[value.subject];
  const [outcome] = await s1.judge(input.scope, [compileHarnessRequest({
    surface: 'action.helpful', goal: state.goal, facts: stateFacts(state), stateVersion: state.version,
    subject: describeCandidate(subject),
  })], {
    orchestration: state.trajectory.orchestrationConfidence,
    ...(input.currentStateVersion ? { currentStateVersion: input.currentStateVersion } : {}),
  });

  const p = outcome.judgment?.result.probability;
  const actualCostUsd = outcome.cached ? 0 : (outcome.judgment?.metadata.inputTokens ?? 0) * usdPerToken(state);
  // An unavailable probability is not fabricated: the candidate keeps its
  // cheap estimate, exactly as if System-1 did not exist.
  const decision = p === undefined
    ? input.decision
    : (() => {
        const refined = input.candidates.map((c, i) => (i === value.subject ? withHelpfulness(c, p) : c));
        const again = chooseEconomicAction({ state, candidates: refined, decisionId: input.decision.decisionId });
        return { ...again, reasonCodes: [...again.reasonCodes, 'refined_by_system1'] };
      })();

  return {
    decision,
    outcomes: [outcome],
    contexts: [{
      provider: s1.provider,
      economicResult: {
        candidate: subject.id, helpfulProbability: p ?? -1,
        metaVoiUsd: value.metaVoiUsd, actualCostUsd,
      },
      finalRuntimeAction: decision.action.kind,
    }],
    refinement: {
      invoked: true, valueUsd: value.valueUsd, expectedCostUsd: value.costUsd, actualCostUsd,
      marginBeforeUsd: input.decision.margin?.absoluteUsd ?? null,
      marginAfterUsd: decision.margin?.absoluteUsd ?? null,
      decisionChanged: decision.action.id !== input.decision.action.id,
    },
  };
}

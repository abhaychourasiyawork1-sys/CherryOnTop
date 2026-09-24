/** System-1 inside the next-action decision, without it becoming the decider.
 *
 *  The order is the architecture:
 *
 *    candidates (already legal: the deep path and boundary proposed them)
 *     -> semantic-demand gate    ask only where the answer can change the action
 *     -> batched System-1        one forward pass for every admitted question
 *     -> calibration             inside the guard
 *     -> semantic estimates      `action.helpful` scales benefit, once
 *     -> existing economics      `chooseEconomicAction`, unchanged
 *     -> policy                  the caller's fallback gate, unchanged
 *
 *  `runtime.next_action` (a Choice) is only consulted when economics produced
 *  an exact tie, where the engine would otherwise fall back to comparing ids.
 *  A semantic preference among equals is strictly better information than an
 *  alphabet, and it never overrides a utility difference. */
import { chooseEconomicAction } from './engine.js';
import { evaluateActionUtility } from './utility.js';
import type { ActionCandidate, ActionDecision } from './actions.js';
import type { EconomicState } from './state.js';
import { compileHarnessRequest, stateFacts } from '../system1/compiler.js';
import { withHelpfulness } from '../system1/economic-mapping.js';
import type { JudgeOutcome, System1 } from '../system1/guard.js';
import type { ReceiptContext } from '../system1/receipts.js';

/** What each action kind is, in words a semantic model can judge. A file path
 *  is appended when the candidate names one; ids and capabilities are not,
 *  since they mean nothing outside this codebase. */
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

/** Interventions whose value is a semantic question at all. `continue` and
 *  `stop` are the defaults the engine falls back to, not interventions. */
function isIntervention(candidate: ActionCandidate): boolean {
  return candidate.kind !== 'continue' && candidate.kind !== 'stop';
}

const decisionId = 'system1-probe';

function chosenWith(state: EconomicState, candidates: ActionCandidate[]): string {
  return chooseEconomicAction({ state, candidates, decisionId }).action.id;
}

/** The semantic-demand gate for `action.helpful`: ask about a candidate only if
 *  "certainly useless" and "certainly useful" lead to different actions. */
export function helpfulnessMatters(state: EconomicState, candidates: ActionCandidate[], index: number): boolean {
  const target = candidates[index];
  if (!isIntervention(target) || !evaluateActionUtility(target, state).allowed) return false;
  const at = (p: number) => candidates.map((c, i) => (i === index ? withHelpfulness(c, p) : c));
  return chosenWith(state, at(0)) !== chosenWith(state, at(1));
}

export interface System1Refinement {
  decision: ActionDecision;
  /** Every question asked, with the receipt context for each. Empty when the
   *  gate found nothing System-1 could change. */
  outcomes: JudgeOutcome[];
  contexts: ReceiptContext[];
}

export async function refineWithSystem1(input: {
  s1: System1;
  scope: string;
  state: EconomicState;
  candidates: ActionCandidate[];
  decision: ActionDecision;
  /** Re-read after the provider answers, so a judgment about an older state is
   *  refused rather than applied. */
  currentStateVersion?: () => number;
}): Promise<System1Refinement> {
  const { s1, state } = input;
  const facts = stateFacts(state);
  const outcomes: JudgeOutcome[] = [];
  const contexts: ReceiptContext[] = [];
  const judge = (requests: Parameters<System1['judge']>[1]) => s1.judge(input.scope, requests, {
    orchestration: state.trajectory.orchestrationConfidence,
    ...(input.currentStateVersion ? { currentStateVersion: input.currentStateVersion } : {}),
  });

  // ---- action.helpful, only where it can move the decision ----------------
  const admitted = input.candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ index }) => helpfulnessMatters(state, input.candidates, index));

  let candidates = input.candidates;
  if (admitted.length > 0) {
    const requests = admitted.map(({ candidate }) => compileHarnessRequest({
      surface: 'action.helpful', goal: state.goal, facts, stateVersion: state.version,
      subject: describeCandidate(candidate),
    }));
    const answers = await judge(requests);
    candidates = [...input.candidates];
    answers.forEach((outcome, i) => {
      const { candidate, index } = admitted[i];
      const p = outcome.judgment?.result.probability;
      // An unavailable probability is not fabricated: the candidate keeps its
      // deterministic estimate, exactly as if System-1 did not exist.
      if (p !== undefined) candidates[index] = withHelpfulness(candidate, p);
      outcomes.push(outcome);
      contexts.push({
        provider: s1.provider,
        economicResult: { candidate: candidate.id, helpfulProbability: p ?? -1 },
        finalRuntimeAction: '',
      });
    });
  }

  let decision = candidates === input.candidates
    ? input.decision
    : chooseEconomicAction({ state, candidates, decisionId: input.decision.decisionId });

  // ---- runtime.next_action, only to break an exact tie ---------------------
  const tied = decision.reasonCodes.some((c) => c === 'tie_broken_on_id' || c === 'tie_broken_on_confidence')
    ? tiedWith(state, candidates, decision)
    : [];
  if (tied.length >= 2) {
    const request = compileHarnessRequest({
      surface: 'runtime.next_action', goal: state.goal, facts, stateVersion: state.version,
      // Positional ids: candidate ids are paths and can be long, and a provider
      // has no use for them anyway.
      candidates: tied.map((c, i) => ({ id: `option${i + 1}`, action: c.kind, description: describeCandidate(c) })),
    });
    const [outcome] = await judge([request]);
    const selected = outcome.judgment?.result.selectedId;
    const pick = tied.find((_, i) => `option${i + 1}` === selected);
    if (pick && pick.id !== decision.action.id) {
      const rechosen = chooseEconomicAction({ state, candidates: [pick], decisionId: decision.decisionId });
      decision = { ...rechosen, reasonCodes: [...rechosen.reasonCodes, 'tie_broken_by_system1'] };
    }
    outcomes.push(outcome);
    contexts.push({
      provider: s1.provider,
      economicResult: { tiedCandidates: tied.length, utility: decision.utility },
      finalRuntimeAction: '',
      ...(outcome.judgment ? {} : { fallbackReason: 'tie broken on id, as before' }),
    });
  }

  for (const ctx of contexts) ctx.finalRuntimeAction = decision.action.kind;
  return { decision, outcomes, contexts };
}

/** Every allowed candidate whose utility equals the winner's. */
function tiedWith(state: EconomicState, candidates: ActionCandidate[], decision: ActionDecision): ActionCandidate[] {
  const out: ActionCandidate[] = [];
  let remaining = candidates;
  let current = decision;
  while (out.length < 8) {
    const winner = remaining.find((c) => c.id === current.action.id);
    if (!winner || Math.abs(current.utility - decision.utility) > 1e-9 || current.utility <= 0) break;
    out.push(winner);
    remaining = remaining.filter((c) => c.id !== winner.id);
    if (remaining.length === 0) break;
    current = chooseEconomicAction({ state, candidates: remaining, decisionId });
  }
  return out;
}

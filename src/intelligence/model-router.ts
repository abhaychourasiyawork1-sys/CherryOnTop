/** Which executions are possible, and what each is expected to cost — never
 *  which one runs.
 *
 *  Proposes every Harness × Model × Effort the deployment can run, each an
 *  atomic candidate priced from two beliefs. The Action Market chooses.
 *
 *  Nothing here ranks anything. There is no tier table, no model list order,
 *  no reading of price as strength and no effort ladder:
 *
 *   - **capability** of a candidate is *learned* (`capability.ts`) from
 *     validated outcomes at the difficulty they happened at. Until there are
 *     any, every candidate is the same wide unknown;
 *   - **difficulty** of the dispatch is a belief (`difficulty.ts`) built from
 *     evidence, never from the goal's wording.
 *
 *  The prior on top of them is one shape: success rises with the margin of
 *  capability over difficulty, and on a hard task a shortfall is likelier to
 *  come back as a wrong answer than as an honest failure. A wrong answer is then
 *  priced by how well it could be caught — the detection strength of the
 *  validation ladder — so a weakly checked task needs more capability without
 *  any rule saying so.
 *
 *  Doubt is priced through the pessimistic bound: capability at its lower edge
 *  against difficulty at its upper one. An operator who names a model narrows the
 *  menu to it; budget is a constraint the market enforces. */
import { modelForTier, hasExplicitModel, dispatchOptionsFor, type DispatchRole } from '../config/efficiency.js';
import { actionCandidate, type ActionCandidate } from '../decision/actions.js';
import type { EconomicState } from '../decision/state.js';
import type { ActionTransitionEstimate } from '../decision/transition.js';
import { usdPerToken } from '../decision/utility.js';
import { SHRINKAGE_K } from '../learning/hierarchical.js';
import { usdPerTokenFor } from '../execution/pricing.js';
import type { HarnessCapabilitySnapshot } from '../adapters/adapter.js';
import { clamp01 } from '../efficiency/policy-types.js';
import { detectionStrength } from '../validation/contract.js';
import { fitCapability, successProbability, type CapabilityModel } from './capability.js';
import { zScore } from './difficulty.js';

export const EXECUTION_CAPABILITY = 'execution.dispatch';

export interface ExecutionPrior {
  /** Expected tokens relative to one measured dispatch of this role. */
  tokensMultiplier: number;
  /** Probability the dispatch finishes without needing a retry. */
  success: number;
  /** Probability a finished dispatch's result fails validation. */
  qualityRisk: number;
}

/** How much a prior is believed before any history exists. */
export const PRIOR_CONFIDENCE = 0.3;

export interface ExecutionCandidateInput {
  role: DispatchRole;
  /** [0,1]: what this dispatch needs (`dispatchDifficulty`). */
  difficulty: number;
  /** [0,1]: what it might need at the confidence the contract demands. Defaults
   *  to `difficulty` — no doubt. */
  difficultyUpper?: number;
  /** What each candidate can do, learned. Defaults to knowing nothing. */
  capability?: CapabilityModel;
  harnesses: HarnessCapabilitySnapshot[];
  /** Mean tokens of one dispatch of this role — the unit priced in. */
  dispatchTokens: number;
  dispatchLatencyMs: number;
  /** Measured mean tokens per dispatch of this role on each model, from the
   *  ledger (`(default)` for the runtime default). Replaces the token guess. */
  measuredTokens?: Readonly<Record<string, number>>;
  /** The operator's named model was refused by the harness itself: propose
   *  the full menu rather than fail the run over a knob. */
  relaxOperatorModel?: boolean;
}

const DEFAULT_KEY = '(default)';

/** The models on the menu. An operator-named model narrows it to that model;
 *  otherwise everything any harness offers, every configured tier, and the
 *  harness's own default. */
function modelMenu(input: ExecutionCandidateInput): { models: Array<string | undefined>; constrained: boolean } {
  if (hasExplicitModel(input.role) && !input.relaxOperatorModel) {
    return { models: [dispatchOptionsFor(input.role).model], constrained: true };
  }
  const menu = new Map<string, string | undefined>();
  const add = (model: string | undefined) => menu.set(model ?? DEFAULT_KEY, model);
  for (const h of input.harnesses) for (const m of h.models) add(m);
  add(modelForTier('fast'));
  add(modelForTier('standard'));
  add(modelForTier('deep'));
  // Always runnable: no model flag at all. It is what recovery lands on when
  // a named model is refused.
  add(undefined);
  return { models: [...menu.values()], constrained: false };
}

/** The numeric facts known about a candidate: what it costs per token, plus
 *  whatever its adapter reports. None is assumed to mean anything — the weight
 *  of each is learned (`capability.ts`). Log price because prices span orders
 *  of magnitude. */
export function factsOf(harness: HarnessCapabilitySnapshot, model: string | undefined, effort: string): Record<string, number> {
  return { logUsdPerToken: Math.log(usdPerTokenFor(model)), ...(harness.candidateFacts?.(model, effort) ?? {}) };
}

/** Role is part of the execution semantics: a planner and an executor on the
 *  same model are different dispatches. */
export const modelKeyFor = (role: DispatchRole, harness: string, model: string | undefined) =>
  `${role}|${harness}|${model ?? 'default'}`;
export const candidateKeyFor = (role: DispatchRole, harness: string, model: string | undefined, effort: string) =>
  `${modelKeyFor(role, harness, model)}|${effort}`;

/** The prior at a known capability: a candidate short of what the task needs
 *  fails in proportion to the shortfall, and on a hard task a shortfall is
 *  likelier to come back as a wrong answer than as an honest failure. Measured
 *  tokens replace the unit guess when they exist. */
export function executionPrior(input: {
  difficulty: number;
  capability: number;
  measuredTokensMultiplier?: number;
}): ExecutionPrior {
  const difficulty = clamp01(input.difficulty);
  const success = successProbability(input.capability, difficulty);
  return {
    success,
    qualityRisk: (1 - success) * difficulty,
    tokensMultiplier: input.measuredTokensMultiplier ?? 1,
  };
}

export function candidateIdFor(harness: string, model: string | undefined, effort: string): string {
  return `exec:${harness}:${model ?? 'default'}:${effort}`;
}

/** Every Harness × Model × Effort the deployment could run, with its prior.
 *  Feasibility is not decided here — `provider-router.ts` marks what cannot
 *  run, and the receipt keeps both so a refusal is visible. */
export function generateExecutionCandidates(input: ExecutionCandidateInput): ActionCandidate[] {
  const { models, constrained } = modelMenu(input);
  const capability = input.capability ?? fitCapability([]);
  const difficultyUpper = clamp01(input.difficultyUpper ?? input.difficulty);
  const unit = Math.max(1, input.dispatchTokens);
  const out: ActionCandidate[] = [];
  for (const harness of input.harnesses) {
    for (const model of models) {
      const measured = input.measuredTokens?.[model ?? DEFAULT_KEY];
      for (const effort of harness.efforts) {
        const identity = {
          modelKey: modelKeyFor(input.role, harness.harness, model),
          candidateKey: candidateKeyFor(input.role, harness.harness, model, effort),
          facts: factsOf(harness, model, effort),
        };
        const belief = capability.believe(identity);
        const prior = executionPrior({
          difficulty: input.difficulty,
          capability: belief.mean,
          ...(measured !== undefined ? { measuredTokensMultiplier: measured / unit } : {}),
        });
        out.push(actionCandidate({
          id: candidateIdFor(harness.harness, model, effort),
          kind: 'continue',
          capability: EXECUTION_CAPABILITY,
          tokenCost: Math.round(unit * prior.tokensMultiplier),
          latencyCost: Math.max(0, input.dispatchLatencyMs),
          failureRisk: 1 - prior.success,
          qualityRisk: prior.qualityRisk,
          confidence: PRIOR_CONFIDENCE,
          metadata: {
            harness: harness.harness, model, effort, role: input.role,
            prior: { success: prior.success, qualityRisk: prior.qualityRisk, tokensMultiplier: prior.tokensMultiplier },
            capabilityMean: belief.mean, capabilitySd: belief.sd, capabilityObservations: belief.observations,
            difficulty: input.difficulty, difficultyUpper,
            facts: identity.facts, candidateKey: identity.candidateKey,
            unitTokens: unit,
            // The family outcomes teach: every effort of one model on one harness.
            modelKey: identity.modelKey,
            capabilityFingerprint: harness.fingerprint,
            fingerprint: `${identity.candidateKey}|${harness.fingerprint}`,
            ...(constrained ? { constraint: 'operator_model' } : {}),
            ...(input.relaxOperatorModel ? { constraint: 'operator_model_relaxed' } : {}),
          },
        }));
      }
    }
  }
  return out;
}

/** What history says about one candidate, already shrunk across levels. */
export interface CandidateEvidence {
  success: number;
  /** Absent when the evidence cannot see validation (harness-level history). */
  qualityRisk?: number;
  tokens?: number;
  costUsd?: number;
  latencyMs?: number;
  effectiveObservations: number;
  /** Mean (actual − predicted) cost, from calibration. Added to the prior so a
   *  candidate that keeps coming in over estimate is priced higher next time. */
  costBiasUsd?: number;
  /** Measured tokens per dispatch unit for this exact candidate. */
  tokensMultiplier?: number;
  /** Measured dollars per token against the list price: what this candidate
   *  really pays per token (cache behaviour, a stale price table). */
  priceRatio?: number;
  evidenceIds?: string[];
}

function blend(prior: number, observed: number | undefined, weight: number): number {
  return observed === undefined || !Number.isFinite(observed) ? prior : prior * (1 - weight) + observed * weight;
}

/** The transition estimate for one execution candidate: dispatch now, and on
 *  failure pay for another attempt; on a wrong result, pay for what being wrong
 *  costs given how well it would be caught.
 *
 *  Capability outcomes already live in the candidate's own belief (its
 *  `capabilityMean`), so success and quality rates from history are blended in
 *  only for a candidate the capability model has not seen — the same outcomes
 *  are never counted twice.
 *
 *  Conservative bounds come from the belief itself: capability at its lower edge
 *  against difficulty at its upper one, so a candidate with thin evidence must
 *  be cheaper by more than its doubt to win. */
export function executionEstimate(
  candidate: ActionCandidate,
  state: EconomicState,
  evidence?: CandidateEvidence,
): ActionTransitionEstimate {
  const m = candidate.metadata as {
    model?: string; prior?: ExecutionPrior; budgetShare?: number; budgetCapUsd?: number;
    capabilityMean?: number; capabilitySd?: number; capabilityObservations?: number;
    difficulty?: number; difficultyUpper?: number;
  };
  const prior = m.prior ?? { tokensMultiplier: 1, success: 1 - candidate.failureRisk, qualityRisk: candidate.qualityRisk };
  const capabilityObs = Math.max(0, m.capabilityObservations ?? 0);
  const capabilityWeight = capabilityObs / (capabilityObs + SHRINKAGE_K);
  const n = Math.max(0, evidence?.effectiveObservations ?? 0);
  const weight = n / (n + SHRINKAGE_K);
  const rates = capabilityObs > 0 ? undefined : evidence;
  const rateWeight = capabilityObs > 0 ? 0 : weight;

  // A feasibility adjustment (a degraded harness) raises `failureRisk` on the
  // candidate itself; the prior never overrides it downward.
  const priorSuccess = Math.min(prior.success, 1 - candidate.failureRisk);
  // A run capped below what it is expected to need finishes only if it turns
  // out cheaper than expected: its chance scales with the share that fits.
  const budgetShare = typeof m.budgetShare === 'number' ? clamp01(m.budgetShare) : 1;
  const success = budgetShare * Math.min(1, Math.max(0, blend(priorSuccess, rates?.success, rateWeight)));
  const qualityRisk = Math.min(1, Math.max(0, blend(prior.qualityRisk, rates?.qualityRisk, rateWeight)));
  const capped = typeof m.budgetShare === 'number' && m.budgetShare < 1;
  // Measured tokens per unit for this candidate, scaled to this dispatch's
  // size, beat absolute tokens earned on dispatches of another size.
  const unitTokens = typeof candidate.metadata.unitTokens === 'number' ? candidate.metadata.unitTokens : undefined;
  const measuredTokens = evidence?.tokensMultiplier !== undefined && unitTokens !== undefined
    ? evidence.tokensMultiplier * unitTokens
    : evidence?.tokens;
  const tokenWeight = evidence?.tokensMultiplier !== undefined
    ? (evidence.effectiveObservations / (evidence.effectiveObservations + SHRINKAGE_K)) : weight;
  const blendedTokens = Math.max(0, blend(candidate.tokenCost, measuredTokens, tokenWeight));
  // Capped: `tokenCost` is already what fits, and history cannot buy past it.
  const tokens = capped ? Math.min(blendedTokens, candidate.tokenCost) : blendedTokens;
  const priceRatio = evidence?.priceRatio !== undefined && Number.isFinite(evidence.priceRatio)
    ? blend(1, evidence.priceRatio, tokenWeight) : 1;
  const listPrice = usdPerTokenFor(m.model);
  const priced = tokens * listPrice * priceRatio;
  const uncapped = Math.max(0, blend(priced, rates?.costUsd, rateWeight) + (rates?.costBiasUsd ?? 0) * rateWeight);
  // The live spend limit stops a capped run at what is left.
  const immediateUsd = Math.min(uncapped, m.budgetCapUsd ?? Number.POSITIVE_INFINITY);
  const latencyMs = Math.max(0, blend(candidate.latencyCost, rates?.latencyMs, rateWeight));
  const confidence = PRIOR_CONFIDENCE + (1 - PRIOR_CONFIDENCE) * Math.max(weight, capabilityWeight);

  // Pessimistic edge: capability at its lower bound against difficulty at its
  // upper one. When history rates carry the estimate they narrow it in
  // proportion to how much they are believed.
  const beliefLow = typeof m.capabilityMean === 'number' && typeof (m.difficultyUpper ?? m.difficulty) === 'number'
    ? successProbability(m.capabilityMean - zScore(state.constraints.qualityFloor) * (m.capabilitySd ?? 0),
      (m.difficultyUpper ?? m.difficulty) as number)
    : undefined;
  const doubt = 1 - rateWeight;
  const successAtEdge = beliefLow === undefined ? success : success - doubt * Math.max(0, success - budgetShare * beliefLow);
  const successLow = Math.max(0, Math.min(success, successAtEdge));
  const edgeRisk = beliefLow === undefined
    ? qualityRisk
    : (1 - beliefLow) * ((m.difficultyUpper ?? m.difficulty) as number);
  const riskHigh = Math.min(1, qualityRisk + doubt * Math.max(0, edgeRisk - qualityRisk));

  // A wrong result is either caught (and redone: one more dispatch) or
  // delivered (and paid for at the objective's own exchange rate: "under 2:2:1
  // a unit of quality is worth a whole budget of tokens"). How often it is
  // caught is what the validation ladder can do for this task's floor.
  const detect = detectionStrength(state.constraints.qualityFloor);
  const retry = immediateUsd;
  // Choosing a candidate means paying for it until it works: one that finishes
  // with probability p costs `1/p` dispatches, not `1 + (1−p)`. A linear price
  // would let a hopeless candidate cost barely more than a coin flip, and the
  // market would keep choosing it. Only the *expected* cost is geometric: the
  // pessimistic bound stays a single retry's worth of doubt on top, because a
  // commitment reserves in proportion to bound ÷ expected, and reserving for a
  // thousand dispatches would refuse every candidate instead of ranking them.
  const attempts = (p: number) => 1 / Math.max(p, 1e-3);
  // Priced at the task's own token price, not this candidate's: being wrong
  // costs the same whichever model made the mistake.
  const consequence = Math.max(retry, state.resources.totalTokenBudget * usdPerToken(state));
  const wrongCost = (risk: number) => risk * (detect * retry + (1 - detect) * consequence);
  const remaining = (attempts(success) - 1) * retry + wrongCost(qualityRisk);
  return {
    actionId: candidate.id,
    immediateCost: { tokens, usd: immediateUsd, latencyMs },
    outcomes: [
      { probability: success, completed: true, succeeded: true, nextStateDelta: { progress: 1 } },
      ...(success < 1 ? [{
        probability: 1 - success, completed: false, succeeded: false,
        nextStateDelta: { failurePressure: 0.25 },
      }] : []),
    ],
    expectedRemainingCost: { tokens: tokens * ((attempts(success) - 1) + qualityRisk), usd: remaining, latencyMs: (attempts(success) - 1) * latencyMs },
    bounds: {
      // The probability the *delivered* result is correct: a wrong result that
      // validation catches is redone, so only the undetected share counts.
      successLowerBound: 1 - riskHigh * (1 - detect),
      costUpperBoundUsd: immediateUsd + Math.max(attempts(success) - 1, 1 - successLow) * retry + wrongCost(riskHigh),
    },
    confidence,
    provenance: Math.max(weight, capabilityWeight) > 0 ? 'empirical' : 'hybrid',
    evidenceIds: evidence?.evidenceIds ?? [],
  };
}

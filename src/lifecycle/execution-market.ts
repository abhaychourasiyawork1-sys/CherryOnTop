/** Where every dispatch — plan, execute, synthesize — gets its harness and
 *  model: from the Action Market, and nowhere else.
 *
 *  Before this, three things decided a dispatch between them: `routeModel`
 *  picked a tier, `routeProvider` picked a harness by scoring runtime history,
 *  and `decideExecutionPath` decided whether a cached answer was reused. Each
 *  was reasonable and none of them could see the others. Here they are
 *  providers:
 *
 *      capability discovery (adapters)       what can run
 *      model-router                          Harness × Model × Effort candidates + priors
 *      provider-router                       which of them cannot run right now, and why
 *      result cache                          an exact-reuse candidate, when one is valid
 *      candidate history (hierarchical)      empirical transition estimates
 *                        ↓
 *      chooseEconomicAction                  the one decision
 *                        ↓
 *      CommitmentBook                        version-checked, reserved
 *
 *  Recovery re-enters the same path: a candidate the harness refused (a model
 *  the plan does not include) is marked infeasible for this node and the
 *  market is asked again from the changed state. There is no retry branch.
 *
 *  Bookkeeping here is total: a database that refuses a receipt must not cost
 *  a dispatch. The *decision* is not total — a blocked market is a real answer
 *  and the caller reports it. */
import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '../db/client.js';
import type { HarnessCapabilitySnapshot, RuntimeAdapter } from '../adapters/adapter.js';
import { getNode, setNodeRuntime } from '../db/queries/nodes.js';
import { appendEvent } from '../db/queries/events.js';
import { insertDecision } from '../db/queries/decisions.js';
import { listMemory, getRuntimeStats, type RuntimeStat } from '../db/queries/memory.js';
import { tokensByRole } from '../db/queries/tokens.js';
import { getCostForNodes } from '../db/queries/stats.js';
import { memory } from '../db/schema.js';
import { publish } from '../events/bus.js';
import type { DispatchRole } from '../config/efficiency.js';
import {
  uninformedDifficulty, upperDifficulty, withObservedFailures, withSemanticEstimate, dispatchDifficulty, roleOpenness, type Difficulty,
} from '../intelligence/difficulty.js';
import { fitCapability, type CapabilityObservation } from '../intelligence/capability.js';
import { LEVEL_MODEL } from '../validation/contract.js';
import { dispatchOptionsFor, modelForTier } from '../config/efficiency.js';
import { usdPerTokenFor } from '../execution/pricing.js';
import { availableTokens } from '../decision/transition.js';
import {
  generateExecutionCandidates, executionEstimate, EXECUTION_CAPABILITY, type CandidateEvidence,
} from '../intelligence/model-router.js';
import { markFeasibility } from '../intelligence/provider-router.js';
import { chooseEconomicAction } from '../decision/engine.js';
import { actionCandidate, type ActionCandidate, type ActionDecision } from '../decision/actions.js';
import { CommitmentBook, type ActualUsage, type PredictionError } from '../decision/commitment.js';
import {
  registerEmpiricalEstimator, routingStateSignature, stateSignatureKey, candidateFingerprint,
  type ActionCommitment,
} from '../decision/transition.js';
import { normalizeEconomicState, type EconomicState } from '../decision/state.js';
import { usdPerToken } from '../decision/utility.js';
import {
  estimateCandidateOutcome, type CandidateOutcomeObservation, type LearningKey, type LearningLevel,
  type ObservationValidity,
} from '../learning/hierarchical.js';
import { economicStateFor } from './economic-runtime.js';
import { compileHarnessRequest, HARNESS_QUESTIONS } from '../system1/compiler.js';
import type { JudgeOutcome, System1 } from '../system1/guard.js';
import { DEFAULT_SYSTEM1_CALL_USD } from '../decision/system1-decision.js';

// ---------------------------------------------------------------------------
// Capability discovery
// ---------------------------------------------------------------------------

/** Observed harness health, process-wide: the quota a rate limit spends is
 *  per account, not per node. Optimistic until something is observed, and
 *  never permanent: an observation carries when it stops being true (the
 *  quota's own reset time), and a later success clears it. */
const health = new Map<string, { status: HarnessCapabilitySnapshot['health']; untilMs?: number }>();

export function observeHarnessHealth(
  harness: string,
  observed: HarnessCapabilitySnapshot['health'],
  untilMs?: number,
): void {
  if (observed === 'healthy') health.delete(harness);
  else health.set(harness, { status: observed, ...(untilMs !== undefined ? { untilMs } : {}) });
}

function healthOf(harness: string, nowMs: number): HarnessCapabilitySnapshot['health'] {
  const entry = health.get(harness);
  if (!entry) return 'healthy';
  if (entry.untilMs !== undefined && nowMs >= entry.untilMs) {
    health.delete(harness);
    return 'healthy';
  }
  return entry.status;
}

const MODEL_PROBE = '__model_probe__';

/** The model names the router can propose, whichever harness offers them. */
function probeNames(): string[] {
  return [modelForTier('fast'), modelForTier('standard'), modelForTier('deep')]
    .filter((m): m is string => typeof m === 'string' && m.length > 0);
}

/** What a harness can do, asked of the adapter rather than hardcoded by name:
 *  a new runtime answers for itself. */
export function capabilitiesOf(adapter: RuntimeAdapter, nowMs: number = Date.now()): HarnessCapabilitySnapshot {
  let acceptsModelFlag = false;
  try {
    acceptsModelFlag = adapter.buildCommand('goal', undefined, { model: MODEL_PROBE }).includes(MODEL_PROBE);
  } catch {
    acceptsModelFlag = false;
  }
  const discovered = adapter.discoverCapabilities?.() ?? {};
  const snapshot = {
    harness: adapter.name,
    acceptsModelFlag: discovered.acceptsModelFlag ?? acceptsModelFlag,
    serves: discovered.serves ?? ((model: string) => adapter.servesModel?.(model) !== false),
    efforts: discovered.efforts && discovered.efforts.length > 0 ? discovered.efforts : ['default'],
    supportsSession: discovered.supportsSession ?? adapter.supportsSession === true,
    models: discovered.models ?? [],
    health: healthOf(adapter.name, nowMs),
    ...(discovered.candidateFacts ?? adapter.candidateFacts
      ? { candidateFacts: discovered.candidateFacts ?? ((m: string | undefined, e: string) => adapter.candidateFacts!(m, e)) }
      : {}),
  };
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([snapshot.harness, snapshot.acceptsModelFlag, snapshot.efforts, snapshot.models, snapshot.supportsSession,
      // Model-serving semantics, probed on the tier names the router can propose
      // (the harness's own models are already in the fingerprint above).
      probeNames().map((m) => snapshot.serves(m))]))
    .digest('hex').slice(0, 12);
  return { ...snapshot, fingerprint };
}

// ---------------------------------------------------------------------------
// Per-node memory: refusals, commitments, pending observations
// ---------------------------------------------------------------------------

const refusals = new Map<string, Map<string, string>>();
const book = new CommitmentBook();

interface PendingObservation {
  candidateId: string;
  stateSignature: string;
  context: Pick<CandidateOutcomeObservation, 'difficulty' | 'modelKey' | 'candidateKey' | 'facts' | 'unitTokens'>;
  predicted: CandidateOutcomeObservation['predicted'];
  actual: Omit<CandidateOutcomeObservation['actual'], 'validated'>;
}
const pending = new Map<string, PendingObservation[]>();

/** Rules a candidate out for the rest of this node's life — an observed fact
 *  that it cannot run here. The market is then asked again. */
export function refuseCandidate(nodeId: string, candidateId: string, reason: string): void {
  const entry = refusals.get(nodeId) ?? new Map<string, string>();
  entry.set(candidateId, reason);
  refusals.set(nodeId, entry);
}

/** Rules out a model on a harness at every effort: a model the plan does not
 *  include is not included at any effort level either. */
export function refuseModel(nodeId: string, harness: string, model: string | undefined, reason: string): void {
  refuseCandidate(nodeId, modelRefusalKey(harness, model), reason);
}

function modelRefusalKey(harness: string, model: string | undefined): string {
  return `model:${harness}:${model ?? 'default'}`;
}

/** This node's refusals, as they apply to these candidates. */
function refusalsFor(nodeId: string, candidates: ActionCandidate[]): Map<string, string> {
  const stored = refusals.get(nodeId) ?? new Map<string, string>();
  const out = new Map(stored);
  for (const c of candidates) {
    const byModel = stored.get(modelRefusalKey(c.metadata.harness as string, c.metadata.model as string | undefined));
    if (byModel && !out.has(c.id)) out.set(c.id, byModel);
  }
  return out;
}

/** The state a node's decisions are made and committed against: storage's
 *  view plus this process's reservations and commitment epoch. */
export function marketViewOf(nodeId: string, observed: EconomicState): EconomicState {
  return book.view(nodeId, observed);
}

/** Commits any market decision for this node — a boundary intervention as much
 *  as a dispatch — against the state as it is now. */
export function commitDecision(nodeId: string, current: EconomicState, decision: ActionDecision) {
  return book.commit(nodeId, current, decision);
}

export function settleDecision(nodeId: string, commitmentId: string, actual: ActualUsage): PredictionError | null {
  return book.settle(nodeId, commitmentId, actual)?.error ?? null;
}

export function forgetExecutionNode(nodeId: string): void {
  refusals.delete(nodeId);
  semanticDifficulty.delete(nodeId);
  pending.delete(nodeId);
  for (const c of book.openCommitments(nodeId)) book.cancel(nodeId, c.commitmentId);
  book.forget(nodeId);
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export const CANDIDATE_OUTCOME_KIND = 'candidate_outcome';

/** Default dispatch sizes, until the ledger has measured this role. */
const DEFAULT_DISPATCH: Record<DispatchRole, { tokens: number; latencyMs: number }> = {
  execute: { tokens: 40_000, latencyMs: 120_000 },
  plan: { tokens: 5_000, latencyMs: 30_000 },
  synthesize: { tokens: 5_000, latencyMs: 20_000 },
};

/** Mean input+output tokens per dispatch of this role, from the rows
 *  `recordUsage` already writes — the same unit the task's token budget
 *  counts. The unit every candidate for the role is priced in. */
export function measuredDispatchTokens(db: Db, role: DispatchRole): number {
  try {
    const rows = tokensByRole(db).rows.filter((r) => r.role === role);
    const dispatches = rows.reduce((sum, r) => sum + r.dispatches, 0);
    if (dispatches === 0) return DEFAULT_DISPATCH[role].tokens;
    const tokens = rows.reduce((sum, r) => sum + r.inputTokens + r.outputTokens, 0);
    return Math.max(1, Math.round(tokens / dispatches));
  } catch {
    return DEFAULT_DISPATCH[role].tokens;
  }
}

/** What an outcome is evidence *for*. Nothing here reads the goal: a class or a
 *  shape derived from its wording would make the wording decide what the
 *  runtime learns. Evidence is the fleet's, this repository's, and — for the
 *  very same request seen again — this exact goal's. */
export function taskKeysFor(goal: string, repository?: string): LearningKey[] {
  const keys: LearningKey[] = [{ level: 'GLOBAL', value: 'all' }];
  if (repository) keys.push({ level: 'REPOSITORY', value: repository });
  const digest = createHash('sha256').update(goal).digest('hex').slice(0, 12);
  keys.push({ level: 'EXACT_PATTERN', value: `${repository ?? 'unscoped'}@${digest}` });
  return keys;
}

/** Outcomes as the capability model reads them. A result counts as a label in
 *  proportion to how well validation could tell right from wrong: an unchecked
 *  success is recorded and teaches nothing about capability. Observations from
 *  before validation strength was recorded carry weight zero for the same
 *  reason — they still teach tokens and cost. */
export function capabilityObservations(observations: CandidateOutcomeObservation[]): CapabilityObservation[] {
  const rows: CapabilityObservation[] = [];
  for (const o of observations) {
    if (o.validity !== 'VALID' || o.difficulty === undefined || !o.modelKey || !o.candidateKey) continue;
    rows.push({
      modelKey: o.modelKey, candidateKey: o.candidateKey, facts: o.facts ?? {}, difficulty: o.difficulty,
      validated: o.actual.validated, weight: Math.min(1, Math.max(0, o.validationStrength ?? 0)),
    });
  }
  return rows;
}

function safeRuntimeStats(db: Db): RuntimeStat[] {
  try {
    return getRuntimeStats(db);
  } catch {
    return [];
  }
}

function loadObservations(db: Db): CandidateOutcomeObservation[] {
  try {
    return listMemory(db, CANDIDATE_OUTCOME_KIND).map((row) => row.value as CandidateOutcomeObservation);
  } catch {
    return [];
  }
}

/** Hierarchical evidence for one candidate on this task. */
export function candidateEvidence(
  observations: CandidateOutcomeObservation[],
  candidate: ActionCandidate,
  taskKeys: LearningKey[],
  harnessHistory?: RuntimeStat,
): CandidateEvidence | undefined {
  const fingerprint = candidateFingerprint(candidate);
  const mine = observations.filter((o) => o.candidateId === fingerprint);

  // What this exact candidate really spends, per unit of dispatch: measured
  // tokens and dollars per token beat the list-price guess.
  const sized = mine.filter((o) => o.validity === 'VALID' && (o.unitTokens ?? 0) > 0);
  const tokensMultiplier = sized.length > 0
    ? sized.reduce((sum, o) => sum + o.actual.tokens / (o.unitTokens as number), 0) / sized.length
    : undefined;
  const paid = sized.filter((o) => o.actual.tokens > 0);
  const priceRatio = paid.length > 0
    ? paid.reduce((sum, o) => sum + o.actual.costUsd / (o.actual.tokens * usdPerTokenFor(candidate.metadata.model as string | undefined)), 0) / paid.length
    : undefined;
  const measured = {
    ...(priceRatio !== undefined ? { priceRatio } : {}),
    ...(tokensMultiplier !== undefined ? { tokensMultiplier } : {}),
  };

  // Success and quality already live in the candidate's own capability belief
  // when the capability model has seen it; counting the same outcomes again as
  // a rate would double them. Only what it spends is taken from here.
  if (typeof candidate.metadata.capabilityObservations === 'number' && candidate.metadata.capabilityObservations > 0) {
    return {
      success: Number.NaN, ...measured, effectiveObservations: sized.length,
      evidenceIds: [`CAPABILITY:${String(candidate.metadata.candidateKey ?? fingerprint)}`],
    };
  }

  // No capability evidence yet: the harness's own run history is the broadest
  // level there is. It says how often runs on this harness succeeded, and
  // nothing about cost or validation, so only success moves.
  if (mine.length === 0) {
    return harnessHistory && harnessHistory.runs > 0
      ? { success: harnessHistory.successRate, effectiveObservations: harnessHistory.runs, evidenceIds: [`HARNESS:${harnessHistory.runtime}`] }
      : undefined;
  }
  const byLevel: Partial<Record<LearningLevel, CandidateOutcomeObservation[]>> = {};
  for (const key of taskKeys) {
    byLevel[key.level] = mine.filter((o) => o.task.some((k) => k.level === key.level && k.value === key.value));
  }
  const estimate = estimateCandidateOutcome({ candidateId: fingerprint, byLevel });
  if (estimate.effectiveObservations <= 0) return undefined;
  return {
    success: estimate.success,
    qualityRisk: estimate.qualityRisk,
    tokens: estimate.tokens,
    costUsd: estimate.costUsd,
    latencyMs: estimate.latencyMs,
    costBiasUsd: estimate.costBiasUsd,
    ...measured,
    effectiveObservations: estimate.effectiveObservations,
    evidenceIds: estimate.sourceLevels.map((k) => `${k.level}:${k.value}`),
  };
}

/** What dispatching each candidate would teach, in dollars.
 *
 *  A market that only ever takes its current best guess never finds out the
 *  guess was wrong: a candidate the prior undervalues is never tried, so it is
 *  never corrected. The fix is not randomness — it is pricing the information.
 *  For each candidate that already clears the quality floor, its true cost is
 *  somewhere in its uncertainty band; the chance it undercuts the best
 *  confident choice, times by how much, is the saving each future dispatch of
 *  this shape would get from knowing. The number of future dispatches is
 *  estimated as the number already seen for this task shape — the workload's
 *  own recurrence, measured. As evidence narrows the band the value falls to
 *  zero on its own, and a task shape seen once buys almost no exploration.
 *
 *  Never touches the quality floor: nothing that might produce a wrong answer
 *  is tried to find out. */
export function withLearningValue(
  candidates: ActionCandidate[],
  state: EconomicState,
  observations: CandidateOutcomeObservation[],
  taskKeys: LearningKey[],
  harnessStats: Map<string, RuntimeStat>,
): ActionCandidate[] {
  // How many more dispatches will benefit from knowing: the workload's own
  // volume, measured — every valid dispatch this fleet has already run. No
  // task shape is derived from the goal, so the count is the fleet's.
  const recurrence = observations.filter((o) => o.validity === 'VALID').length;
  if (recurrence === 0) return candidates;

  const bands = candidates
    .filter((c) => c.capability === EXECUTION_CAPABILITY && typeof c.metadata.infeasible !== 'string')
    .map((c) => {
      const e = executionEstimate(c, state, candidateEvidence(observations, c, taskKeys, harnessStats.get(c.metadata.harness as string)));
      const expected = e.immediateCost.usd + e.expectedRemainingCost.usd;
      const upper = Math.max(expected, e.bounds.costUpperBoundUsd);
      return { id: c.id, low: Math.max(0, 2 * expected - upper), upper, safe: e.bounds.successLowerBound >= state.constraints.qualityFloor };
    })
    .filter((b) => b.safe);
  if (bands.length < 2) return candidates;

  // The decision as it would be made without learning: the best conservative cost.
  const incumbent = Math.min(...bands.map((b) => b.upper));
  const value = new Map(bands.map((b) => {
    // E[max(0, incumbent − X)] for X uniform on [low, upper].
    const perDispatch = incumbent <= b.low ? 0
      : incumbent >= b.upper ? incumbent - (b.low + b.upper) / 2
        : (incumbent - b.low) ** 2 / (2 * Math.max(1e-12, b.upper - b.low));
    return [b.id, perDispatch * recurrence];
  }));
  return candidates.map((c) => {
    const v = value.get(c.id);
    return v && v > 0 ? { ...c, metadata: { ...c.metadata, learningValueUsd: v } } : c;
  });
}

/** How open-ended this role's dispatch is, from the turn budgets the
 *  deployment gives each role — relative to the most open one. */
function roleOpennessFor(role: DispatchRole): number {
  const turns = (r: DispatchRole) => dispatchOptionsFor(r).maxTurns;
  const known = (['plan', 'execute', 'synthesize'] as const).map(turns).filter((t): t is number => t !== undefined);
  // An uncapped role is the most open there is.
  if (turns(role) === undefined) return 1;
  return roleOpenness(turns(role), Math.max(1, ...known));
}

/** Mean input+output tokens per dispatch of this role, per model, from the
 *  ledger. What each model has actually cost here replaces the prior's guess. */
function measuredTokensByModel(db: Db, role: DispatchRole): Record<string, number> {
  try {
    const out: Record<string, number> = {};
    for (const row of tokensByRole(db).rows.filter((r) => r.role === role && r.dispatches > 0)) {
      out[row.model] = (row.inputTokens + row.outputTokens) / row.dispatches;
    }
    return out;
  } catch {
    return {};
  }
}

/** A candidate that would need more than the task has left is not refused —
 *  it is priced as what it can be: a run capped by the live spend limit at
 *  what remains, which finishes only if the work turns out to fit. The market
 *  then weighs a cheaper model likelier to finish inside the cap against a
 *  stronger one likelier to be cut off. Blocking outright was the old
 *  behaviour's opposite error: a task at 85% of its budget stopped instead of
 *  finishing on something cheaper. */
function capToBudget(candidates: ActionCandidate[], state: EconomicState): ActionCandidate[] {
  const r = state.resources;
  const usdLeft = r.budgetUsd && r.budgetUsd > 0
    ? Math.max(0, r.budgetUsd - (r.spentUsd ?? 0) - (r.reservedUsd ?? 0))
    : Number.POSITIVE_INFINITY;
  const tokensLeft = Math.max(0, availableTokens(state) - r.recoveryReserve);
  return candidates.map((c) => {
    if (c.capability !== EXECUTION_CAPABILITY || typeof c.metadata.infeasible === 'string') return c;
    const usd = c.tokenCost * usdPerTokenFor(c.metadata.model as string | undefined);
    const share = Math.min(1, usd > 0 ? usdLeft / usd : 1, c.tokenCost > 0 ? tokensLeft / c.tokenCost : 1);
    if (share >= 1) return c;
    if (share <= 0) return { ...c, metadata: { ...c.metadata, infeasible: 'budget_exhausted' } };
    return {
      ...c,
      tokenCost: Math.floor(c.tokenCost * share),
      metadata: { ...c.metadata, budgetShare: share, budgetCapUsd: Number.isFinite(usdLeft) ? usdLeft : undefined },
    };
  });
}

// ---------------------------------------------------------------------------
// The selection
// ---------------------------------------------------------------------------

export interface ExactReuse {
  /** The candidate whose earlier, validated answer this is. */
  candidateId: string;
  tokensSaved: number;
}

export interface ExecutionSelectionInput {
  nodeId: string;
  role: DispatchRole;
  goal: string;
  adapters: RuntimeAdapter[];
  /** A dispatch already assembled for one harness can only be re-run on it —
   *  a feasibility constraint, not a preference. */
  harness?: string;
  /** The task's difficulty, when the caller refined it (System-1). Absent,
   *  it is derived here from the goal and what the run has observed. */
  difficulty?: Difficulty;
  /** Valid cached answers, by the candidate that produced them. Each becomes a
   *  deterministic reuse candidate the market may choose. */
  reusable?: (candidate: ActionCandidate) => ExactReuse | null;
  /** Deterministic alternatives to dispatching at all — a mechanical merge of
   *  children's reports — priced by the market like any candidate. */
  alternatives?: ActionCandidate[];
  repository?: string;
}

export interface ExecutionSelection {
  decision: ActionDecision;
  /** Null when the decision was blocked or chose reuse. */
  adapter: RuntimeAdapter | null;
  model: string | undefined;
  /** The effort level to pass the harness, when it exposes one. */
  effort: string | undefined;
  candidate: ActionCandidate;
  commitment: ActionCommitment | null;
  reuse: ExactReuse | null;
  /** Set when the market chose one of the caller's `alternatives`. */
  alternative: ActionCandidate | null;
  blocked: boolean;
}

/** The node's state as the market should see it: rebuilt from storage, with
 *  the node's dollar authority and this book's reservations folded in. */
function marketState(db: Db, nodeId: string, goal: string): EconomicState {
  const node = getNode(db, nodeId);
  const observed = economicStateFor(db, { nodeId, goal }, { commit: false });
  const budgetUsd = node?.contract.authority.budget_usd ?? 0;
  const withMoney = normalizeEconomicState({
    ...observed,
    resources: {
      ...observed.resources,
      ...(budgetUsd > 0 ? { budgetUsd, spentUsd: getCostForNodes(db, [nodeId]) } : {}),
    },
  });
  return book.view(nodeId, withMoney);
}

const MAX_COMMIT_ATTEMPTS = 3;

/** Everything a decision is made from — candidates, feasibility, budget caps,
 *  reuse and empirical estimates — without deciding. Shared by the real
 *  selection and by previews (the difficulty question's value-of-information). */
function prepareMarket(db: Db, input: ExecutionSelectionInput) {
  const harnesses = input.adapters.map((adapter) => capabilitiesOf(adapter));
  const observedState = marketState(db, input.nodeId, input.goal);
  const difficulty = input.difficulty
    ?? withObservedFailures(uninformedDifficulty(), observedState.trajectory.failurePressure);
  const openness = roleOpennessFor(input.role);
  const dispatchD = dispatchDifficulty(difficulty, openness);
  // What the work might need at the confidence its contract demands: doubt and
  // stakes buy capability through the pessimistic bound, not through a rule.
  const dispatchUpper = dispatchDifficulty(
    { ...difficulty, value: upperDifficulty(difficulty, observedState.constraints.qualityFloor) }, openness);
  const unit = DEFAULT_DISPATCH[input.role];
  const refused = new Map<string, string>();
  // History is loaded once, before candidates: what each candidate can do is
  // learned from it, and its estimates are read from it.
  const observations = loadObservations(db);
  const capability = fitCapability(capabilityObservations(observations));

  const generate = (relaxOperatorModel: boolean) => generateExecutionCandidates({
    role: input.role, difficulty: dispatchD, difficultyUpper: dispatchUpper, capability, harnesses, relaxOperatorModel,
    measuredTokens: measuredTokensByModel(db, input.role),
    dispatchTokens: measuredDispatchTokens(db, input.role),
    dispatchLatencyMs: unit.latencyMs,
  });
  const constrainHarness = (candidates: ActionCandidate[]) => {
    if (!input.harness) return;
    for (const c of candidates) {
      if (c.metadata.harness !== input.harness && !refused.has(c.id)) refused.set(c.id, 'dispatch_assembled_for_other_harness');
    }
  };
  // An operator-named model narrows the menu. If a harness has refused that
  // model outright in this run and nothing narrowed is left to run, the
  // narrowing cannot be satisfied and is relaxed — the run continues on
  // another candidate rather than failing over a knob — and the receipt says
  // so on every candidate.
  const narrowed = generate(false);
  for (const [id, why] of refusalsFor(input.nodeId, narrowed)) refused.set(id, why);
  constrainHarness(narrowed);
  const nothingNarrowedRuns = markFeasibility({ candidates: narrowed, harnesses, refused })
    .every((c) => typeof c.metadata.infeasible === 'string');
  const operatorRefused = narrowed.some((c) => c.metadata.constraint === 'operator_model')
    && nothingNarrowedRuns
    && narrowed.some((c) => refused.get(c.id) !== undefined && refused.get(c.id) !== 'dispatch_assembled_for_other_harness');
  const generated = operatorRefused ? generate(true) : narrowed;
  for (const [id, why] of refusalsFor(input.nodeId, generated)) refused.set(id, why);
  constrainHarness(generated);
  const executable = capToBudget(markFeasibility({ candidates: generated, harnesses, refused }), observedState);

  // Exact reuse is itself a candidate, priced deterministically: its cost is
  // nothing and its outcome is the answer already validated.
  const reuses = new Map<string, ExactReuse>();
  const reuseCandidates: ActionCandidate[] = [];
  for (const c of executable) {
    if (typeof c.metadata.infeasible === 'string') continue;
    const hit = input.reusable?.(c);
    if (!hit) continue;
    const id = `reuse:${c.id}`;
    reuses.set(id, hit);
    reuseCandidates.push(actionCandidate({
      id, kind: 'reuse_evidence', capability: 'execution.reuse-result',
      expectedTokenBenefit: hit.tokensSaved, confidence: 1,
      metadata: { exactReuse: true, source: c.id, fingerprint: `reuse|${candidateFingerprint(c)}` },
    }));
  }
  const alternatives = (input.alternatives ?? []).map((c) => ({ ...c, metadata: { ...c.metadata, exactReuse: true } }));
  const candidates = [...executable, ...reuseCandidates, ...alternatives];

  // Empirical estimates for execution candidates, from the history loaded once
  // for this decision. Re-registered each time so the estimator always closes
  // over the evidence the decision is actually made on.
  const harnessStats = new Map(safeRuntimeStats(db).map((stat) => [stat.runtime, stat]));
  const taskKeys = taskKeysFor(input.goal, input.repository);
  registerEmpiricalEstimator('execution-history', (candidate, state) =>
    candidate.capability !== EXECUTION_CAPABILITY
      ? null
      : executionEstimate(candidate, state, candidateEvidence(
          observations, candidate, taskKeys,
          harnessStats.get(candidate.metadata.harness as string),
        )));

  const priced = withLearningValue(candidates, observedState, observations, taskKeys, harnessStats);

  const decide = (): { decision: ActionDecision; state: EconomicState } => {
    const state = marketState(db, input.nodeId, input.goal);
    return {
      state,
      decision: chooseEconomicAction({
        state, candidates: priced,
        estimation: {
          taskSignature: taskKeys[taskKeys.length - 1].value,
          evidenceVersion: `${observations.length}:${[...harnessStats.values()].reduce((n, st) => n + st.runs, 0)}`,
        },
      }),
    };
  };
  return { decide, reuses, alternatives, difficulty };
}

export function selectExecution(db: Db, input: ExecutionSelectionInput): ExecutionSelection {
  const byName = new Map(input.adapters.map((a) => [a.name, a]));
  const { decide, reuses, alternatives } = prepareMarket(db, input);
  let { decision, state } = decide();
  let commitment: ActionCommitment | null = null;
  for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS && !decision.blocked; attempt++) {
    // Committed against the state as it is *now*. Between deciding and here
    // nothing is awaited, so a mismatch means another commitment landed; the
    // decision is stale and is recomputed rather than executed.
    const result = book.commit(input.nodeId, marketState(db, input.nodeId, input.goal), decision);
    if (result.ok) { commitment = result.commitment; break; }
    if (result.reason !== 'stale_decision') break;
    ({ decision, state } = decide());
  }

  const reuse = reuses.get(decision.action.id) ?? null;
  const alternative = alternatives.find((c) => c.id === decision.action.id) ?? null;
  const adapter = commitment && !reuse && !alternative
    ? byName.get(decision.action.metadata.harness as string) ?? null : null;
  const selection: ExecutionSelection = {
    decision,
    adapter,
    model: adapter ? decision.action.metadata.model as string | undefined : undefined,
    effort: adapter && decision.action.metadata.effort !== 'default'
      ? decision.action.metadata.effort as string | undefined : undefined,
    candidate: decision.action,
    commitment,
    reuse,
    alternative,
    blocked: decision.blocked === true || !commitment,
  };
  recordSelection(db, input, selection, state);
  return selection;
}

/** Settles the dispatch's commitment against what it actually spent, and
 *  holds the observation until validation says whether its result was right. */
export function settleExecution(
  db: Db,
  nodeId: string,
  selection: ExecutionSelection,
  actual: ActualUsage & { progress?: number },
): PredictionError | null {
  if (!selection.commitment) return null;
  const settled = book.settle(nodeId, selection.commitment.commitmentId, actual);
  if (!settled) return null;
  const estimate = settled.commitment.estimate;
  const predictedSuccess = estimate.outcomes.filter((o) => o.succeeded).reduce((s, o) => s + o.probability, 0);
  const entry = pending.get(nodeId) ?? [];
  const meta = selection.candidate.metadata;
  const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
  entry.push({
    candidateId: candidateFingerprint(selection.candidate),
    stateSignature: String(meta.stateSignature ?? ''),
    context: {
      difficulty: num(meta.difficulty),
      modelKey: typeof meta.modelKey === 'string' ? meta.modelKey : undefined,
      candidateKey: typeof meta.candidateKey === 'string' ? meta.candidateKey : undefined,
      facts: meta.facts && typeof meta.facts === 'object' ? meta.facts as Record<string, number> : undefined,
      unitTokens: num(meta.unitTokens),
    },
    predicted: {
      costUsd: estimate.immediateCost.usd,
      latencyMs: estimate.immediateCost.latencyMs,
      successProbability: predictedSuccess,
      progress: estimate.outcomes.reduce((s, o) => s + o.probability * (o.nextStateDelta.progress ?? 0), 0),
    },
    actual: {
      costUsd: actual.usd, latencyMs: actual.latencyMs, succeeded: actual.succeeded,
      progress: actual.progress ?? (actual.succeeded ? 1 : 0), tokens: actual.tokens,
    },
  });
  pending.set(nodeId, entry);
  emit(db, nodeId, 'market.settled', {
    commitmentId: settled.commitment.commitmentId,
    decisionId: settled.commitment.decisionId,
    candidate: selection.candidate.id,
    reserved: settled.commitment.reservedResources,
    actual,
    predictionError: settled.error,
  });
  return settled.error;
}

/** Releases a commitment that never ran (a dispatch refused before it
 *  started). Nothing was spent, so nothing is learned from it. */
export function cancelExecution(nodeId: string, selection: ExecutionSelection): void {
  if (selection.commitment) book.cancel(nodeId, selection.commitment.commitmentId);
}

/** At the terminal transition: every dispatch this node settled becomes a
 *  candidate × task × state observation, now that validation has said whether
 *  its result was right. Invalid runs are recorded as such — excluded from
 *  learning, never silently dropped. */
export function recordCandidateOutcomes(
  db: Db,
  input: { nodeId: string; goal: string; repository?: string; validated: boolean; recoveryCount: number;
    validationLevel: CandidateOutcomeObservation['validationLevel']; validity?: ObservationValidity },
): number {
  const settled = pending.get(input.nodeId) ?? [];
  pending.delete(input.nodeId);
  const task = taskKeysFor(input.goal, input.repository);
  for (const p of settled) {
    const observation: CandidateOutcomeObservation = {
      candidateId: p.candidateId,
      task,
      stateSignature: p.stateSignature,
      predicted: p.predicted,
      actual: { ...p.actual, validated: p.actual.succeeded && input.validated },
      recoveryCount: input.recoveryCount,
      validationLevel: input.validationLevel,
      // How well the check could tell right from wrong. `V0` is the run's own
      // claim, not a check of it, so it never teaches what a candidate can do.
      validationStrength: input.validationLevel === 'V0' ? 0 : LEVEL_MODEL[input.validationLevel].confidence,
      validity: input.validity ?? 'VALID',
      ...Object.fromEntries(Object.entries(p.context).filter(([, v]) => v !== undefined)),
    };
    try {
      db.insert(memory).values({
        id: randomUUID(), kind: CANDIDATE_OUTCOME_KIND, key: p.candidateId, value: observation,
        confidence: null, nodeId: input.nodeId, createdAt: new Date().toISOString(),
      }).run();
    } catch (err) {
      console.error(`Failed to record a candidate outcome for node ${input.nodeId}:`, err);
    }
  }
  return settled.length;
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

function emit(db: Db, nodeId: string, type: string, payload: Record<string, unknown>): void {
  try {
    const now = new Date().toISOString();
    const id = appendEvent(db, { nodeId, type, payload, createdAt: now });
    publish({ id, nodeId, type, payload, createdAt: now });
  } catch (err) {
    console.error(`Failed to record ${type} for node ${nodeId}:`, err);
  }
}

function recordSelection(db: Db, input: ExecutionSelectionInput, selection: ExecutionSelection, state: EconomicState): void {
  const { decision } = selection;
  const signature = stateSignatureKey(routingStateSignature(state));
  // Carried on the candidate so settlement can key the observation by the
  // state the decision was made in.
  selection.candidate = { ...selection.candidate, metadata: { ...selection.candidate.metadata, stateSignature: signature } };
  try {
    const now = new Date().toISOString();
    if (selection.adapter) setNodeRuntime(db, input.nodeId, selection.adapter.name, now);
    insertDecision(db, {
      id: randomUUID(), nodeId: input.nodeId, type: 'runtime_selection',
      outcome: selection.adapter?.name ?? (selection.reuse ? 'reuse' : selection.alternative ? selection.alternative.id : 'blocked'),
      breakdown: {
        expected_cost_usd: decision.expectedCostUsd ?? 0,
        conservative_cost_usd: decision.conservativeCostUsd ?? 0,
        success_lower_bound: decision.successLowerBound ?? 0,
        margin_usd: decision.margin?.absoluteUsd ?? 0,
        candidates: decision.overhead?.candidateCount ?? 0,
        routing_latency_ms: decision.overhead?.latencyMs ?? 0,
        blocked: selection.blocked ? 1 : 0,
      },
      createdAt: now,
    });
  } catch (err) {
    console.error(`Failed to record the runtime selection for node ${input.nodeId}:`, err);
  }
  emit(db, input.nodeId, 'market.decision', {
    role: input.role,
    decisionId: decision.decisionId,
    stateVersion: decision.stateVersion,
    stateSignature: signature,
    chosen: decision.action.id,
    harness: decision.action.metadata.harness ?? null,
    model: decision.action.metadata.model ?? null,
    effort: decision.action.metadata.effort ?? null,
    difficulty: decision.action.metadata.difficulty ?? null,
    capability: decision.action.metadata.capabilityMean ?? null,
    provenance: decision.estimate?.provenance ?? null,
    expectedCostUsd: decision.expectedCostUsd ?? null,
    conservativeCostUsd: decision.conservativeCostUsd ?? null,
    successLowerBound: decision.successLowerBound ?? null,
    margin: decision.margin ?? null,
    ranked: decision.ranked ?? [],
    rejected: decision.rejected ?? [],
    pruned: decision.pruned ?? [],
    reservation: selection.commitment?.reservedResources ?? null,
    commitmentId: selection.commitment?.commitmentId ?? null,
    blocked: selection.blocked,
    reasonCodes: decision.reasonCodes,
    overhead: { ...decision.overhead, usdPerToken: usdPerToken(state) },
  });
}

// ---------------------------------------------------------------------------
// Difficulty: asked of System-1 only when the answer can change the choice
// ---------------------------------------------------------------------------

/** The semantic answer per node, re-applied to each fresh prior so observed
 *  failures keep moving the estimate after the question was answered. */
const semanticDifficulty = new Map<string, { value: number; confidence: number }>();

export interface DifficultyRefinement {
  difficulty: Difficulty;
  /** Expected dollars the answer could save, before paying for it. */
  valueUsd: number;
  asked: boolean;
  outcome?: JudgeOutcome;
}

/** Expected difficulty from a distribution over the three described levels:
 *  each level stands for the middle of its third of [0,1], and the whole
 *  distribution counts — a split 50/50 answer is a middling task, not a coin
 *  toss between two. */
function expectedDifficulty(probabilities: Record<string, number>): number | null {
  const levels = HARNESS_QUESTIONS['execution.difficulty'].options.map((o) => o.id);
  const total = levels.reduce((sum, id) => sum + (probabilities[id] ?? 0), 0);
  if (total <= 0) return null;
  return levels.reduce((sum, id, i) => sum + ((probabilities[id] ?? 0) / total) * ((i + 0.5) / levels.length), 0);
}

/** The task's difficulty for this dispatch, bought from System-1 only when it
 *  is worth its cost.
 *
 *  The current estimate has a plausible range that narrows with its own
 *  confidence. If the market picks the same candidate at both ends of that
 *  range, no answer could change the dispatch and nothing is asked. If it
 *  picks differently, the answer is worth the stake between the two choices,
 *  weighted by how unsure the estimate is — and asked only when that exceeds
 *  what the question costs. At most once per node; the answer is kept and
 *  folded into every later estimate. */
export async function refineDifficulty(
  db: Db,
  input: ExecutionSelectionInput,
  s1: System1,
  callCostUsd: number = DEFAULT_SYSTEM1_CALL_USD,
): Promise<DifficultyRefinement> {
  const observed = marketState(db, input.nodeId, input.goal);
  const base = withObservedFailures(uninformedDifficulty(), observed.trajectory.failurePressure);
  const known = semanticDifficulty.get(input.nodeId);
  if (known) {
    return { difficulty: withSemanticEstimate(base, known.value, known.confidence), valueUsd: 0, asked: false };
  }

  const doubt = 1 - base.confidence;
  const at = (value: number) => prepareMarket(db, { ...input, difficulty: { ...base, value } }).decide().decision;
  const easier = at(base.value * (1 - doubt));
  const harder = at(base.value + (1 - base.value) * doubt);
  if (easier.action.id === harder.action.id) return { difficulty: base, valueUsd: 0, asked: false };

  const valueUsd = doubt * Math.abs((harder.expectedCostUsd ?? 0) - (easier.expectedCostUsd ?? 0));
  if (valueUsd <= callCostUsd || !s1.ready()) return { difficulty: base, valueUsd, asked: false };

  const [outcome] = await s1.judge(input.nodeId, [compileHarnessRequest({
    surface: 'execution.difficulty', goal: input.goal, stateVersion: 0,
  })], { orchestration: observed.trajectory.orchestrationConfidence });
  const probabilities = outcome.judgment?.result.probabilities;
  const value = probabilities ? expectedDifficulty(probabilities) : null;
  if (value === null) return { difficulty: base, valueUsd, asked: true, outcome };
  const confidence = outcome.judgment?.confidence.provider ?? 0.5;
  semanticDifficulty.set(input.nodeId, { value, confidence });
  return { difficulty: withSemanticEstimate(base, value, confidence), valueUsd, asked: true, outcome };
}

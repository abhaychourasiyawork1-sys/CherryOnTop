/** What an intervention needs, what it does, and how two of them combine —
 *  without asking anyone to explain themselves in prose.
 *
 *  A contract is the generic, capability-facing description of a harness
 *  intervention: preconditions it needs, effects it has, which *doubts* it
 *  removes and by how much, what evidence it produces and consumes, what it
 *  spends, and how reversible it is. Nothing here is task-shaped — no
 *  `refactorType`, no `testStrategy` — because a task-shaped field is a
 *  workflow with a type annotation.
 *
 *  Where a contract comes from matters more than its shape:
 *
 *   - a provider that knows may declare one (`metadata.contract`);
 *   - otherwise it is derived from the candidate's *own* claims, and only the
 *     doubt dimensions the provider said it addresses (`metadata.addresses`)
 *     are credited. An undeclared information gain is credited to no
 *     dimension at all: spreading it would let a structural read be priced as
 *     if it proved behavioural correctness, which is the exact laundering the
 *     risk model must not do.
 *
 *  Composition (`SEQ`, `PAR`) is bounded on purpose: depth two, top-K
 *  primitives, and a branch-and-bound cut against the market's current frontier.
 *  Benefits combine by noisy-OR, never by addition — two reads of the same
 *  ground are not twice the knowledge — and synergy is a learned term that
 *  defaults to zero. Pure, deterministic, no I/O. */
import { clamp01 } from '../efficiency/policy-types.js';
import { actionCandidate, normalizeActionCandidate, type ActionCandidate } from '../decision/actions.js';
import type { EconomicState, UncertaintyKind } from '../decision/state.js';
import { UNCERTAINTY_KINDS } from '../decision/uncertainty.js';

export type ContractField =
  | 'progress' | 'failurePressure' | 'evidence.count' | 'validation.passed'
  | 'validation.required' | 'remainingTokens' | `uncertainty.${UncertaintyKind}`;

export interface ContractPredicate { field: ContractField; op: '>=' | '<=' | '=='; value: number }
export interface ContractEffect { field: 'progress' | 'failurePressure' | 'evidence.count' | 'validation.passed'; delta: number }
export interface ResourceEffect { resource: 'tokens' | 'latencyMs' | 'optimizationTokens'; amount: number }

export interface ActionContract {
  preconditions: ContractPredicate[];
  effects: ContractEffect[];
  /** Fraction of the doubt in each dimension the action is expected to remove. */
  uncertaintyEffects: Partial<Record<UncertaintyKind, number>>;
  evidenceProduced: string[];
  evidenceConsumed: string[];
  resourceEffects: ResourceEffect[];
  /** 1 = fully undoable (a read, a check); 0 = locks the trajectory in. */
  reversibility: number;
}

function isKind(value: unknown): value is UncertaintyKind {
  return typeof value === 'string' && (UNCERTAINTY_KINDS as readonly string[]).includes(value);
}

/** The doubt dimensions a candidate's provider said it addresses. */
export function addressesOf(candidate: ActionCandidate): UncertaintyKind[] {
  const raw = candidate.metadata.addresses;
  return Array.isArray(raw) ? [...new Set(raw.filter(isKind))] : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function validPredicate(p: unknown): p is ContractPredicate {
  const q = p as ContractPredicate;
  return !!q && typeof q.field === 'string' && (q.op === '>=' || q.op === '<=' || q.op === '==') && Number.isFinite(q.value);
}

/** The candidate's contract: declared when the provider declared one, derived
 *  from its own claims otherwise. Total — a malformed declaration is replaced
 *  field by field, never trusted. */
export function contractOf(action: ActionCandidate): ActionContract {
  const candidate = normalizeActionCandidate(action);
  const declared = (candidate.metadata.contract ?? {}) as Partial<ActionContract>;
  const addresses = addressesOf(candidate);

  const derivedEffects: Partial<Record<UncertaintyKind, number>> = {};
  for (const kind of addresses) derivedEffects[kind] = candidate.expectedInformationGain;
  // A claimed rise in P(correct) is a claim about correctness doubt — the one
  // dimension the quality benefit is *about*. Max, not sum: the same effect
  // claimed twice is still one effect.
  if (candidate.expectedQualityBenefit > 0) {
    derivedEffects.validation = Math.max(derivedEffects.validation ?? 0, candidate.expectedQualityBenefit);
  }
  const uncertaintyEffects: Partial<Record<UncertaintyKind, number>> = {};
  const source = declared.uncertaintyEffects && typeof declared.uncertaintyEffects === 'object'
    ? declared.uncertaintyEffects : derivedEffects;
  for (const [kind, value] of Object.entries(source)) {
    if (isKind(kind) && Number.isFinite(value)) uncertaintyEffects[kind] = clamp01(value as number);
  }

  return {
    preconditions: Array.isArray(declared.preconditions)
      ? declared.preconditions.filter(validPredicate)
      : (Array.isArray(candidate.metadata.preconditions) ? (candidate.metadata.preconditions as unknown[]).filter(validPredicate) : []),
    effects: Array.isArray(declared.effects) ? declared.effects : (
      candidate.expectedProgress > 0 ? [{ field: 'progress', delta: candidate.expectedProgress }] : []),
    uncertaintyEffects,
    evidenceProduced: strings(declared.evidenceProduced).length > 0
      ? strings(declared.evidenceProduced)
      : addresses.map((kind) => `doubt:${kind}`),
    evidenceConsumed: strings(declared.evidenceConsumed).length > 0
      ? strings(declared.evidenceConsumed) : strings(candidate.metadata.consumes),
    resourceEffects: [
      { resource: 'tokens', amount: candidate.tokenCost + candidate.coordinationCost },
      { resource: 'latencyMs', amount: candidate.latencyCost },
      { resource: 'optimizationTokens', amount: candidate.orchestrationCost },
    ],
    // Interventions that only look are undoable; one that moves the work
    // forward commits the trajectory in proportion to how far it moves it.
    reversibility: Number.isFinite(declared.reversibility)
      ? clamp01(declared.reversibility as number)
      : Number.isFinite(candidate.metadata.reversibility)
        ? clamp01(candidate.metadata.reversibility as number)
        : clamp01(1 - candidate.expectedProgress),
  };
}

function fieldValue(state: EconomicState, field: ContractField): number {
  switch (field) {
    case 'progress': return state.trajectory.progress;
    case 'failurePressure': return state.trajectory.failurePressure;
    case 'evidence.count': return state.evidence.length;
    case 'validation.passed': return state.validation.status === 'passed' ? 1 : 0;
    case 'validation.required': return state.validation.required ? 1 : 0;
    case 'remainingTokens': return state.resources.remainingTokens;
    default: {
      const kind = field.slice('uncertainty.'.length);
      return isKind(kind) ? state.uncertainty[kind] : Number.NaN;
    }
  }
}

function holds(p: ContractPredicate, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  return p.op === '>=' ? value >= p.value : p.op === '<=' ? value <= p.value : Math.abs(value - p.value) < 1e-9;
}

/** Every precondition the state does not meet. Empty means feasible. */
export function unmetPreconditions(contract: ActionContract, state: EconomicState): ContractPredicate[] {
  return contract.preconditions.filter((p) => !holds(p, fieldValue(state, p.field)));
}

/** The state after the contract's own effects, for checking what can follow
 *  it. Only the fields a contract may move; nothing is estimated here. */
export function applyContract(contract: ActionContract, state: EconomicState): EconomicState {
  let next = { ...state, trajectory: { ...state.trajectory }, uncertainty: { ...state.uncertainty } };
  for (const effect of contract.effects) {
    if (effect.field === 'progress') next.trajectory.progress = clamp01(next.trajectory.progress + effect.delta);
    else if (effect.field === 'failurePressure') next.trajectory.failurePressure = clamp01(next.trajectory.failurePressure + effect.delta);
    else if (effect.field === 'validation.passed' && effect.delta > 0) next = { ...next, validation: { ...next.validation, status: 'passed' } };
  }
  for (const kind of UNCERTAINTY_KINDS) {
    const removed = contract.uncertaintyEffects[kind] ?? 0;
    next.uncertainty[kind] = clamp01(next.uncertainty[kind] * (1 - removed));
  }
  if (contract.evidenceProduced.length > 0) {
    next = { ...next, evidence: [...next.evidence, ...contract.evidenceProduced.map((id) => ({
      id: `contract:${id}`, kind: 'observation' as const, source: `contract:${id}`, confidence: 0.5,
    }))] };
  }
  return next;
}

// ---------------------------------------------------------------------------
// Bounded action algebra
// ---------------------------------------------------------------------------

export type CompositionOp = 'SEQ' | 'PAR';

/** Composition never goes deeper than this. A deeper plan is the agent's job. */
export const MAX_COMPOSITION_DEPTH = 2;
/** How many promising primitives are ever combined. K·(K−1) sequences plus
 *  K·(K−1)/2 parallels — nine at most — never the full product. */
export const COMPOSITION_TOP_K = 3;

export interface SynergyModel {
  /** Learned shared cost (tokens) of doing a and b together. Default 0. */
  economic: (a: string, b: string, op: CompositionOp) => number;
  /** Learned joint risk reduction beyond the noisy-OR of the two. Default 0. */
  causal: (a: string, b: string, op: CompositionOp) => number;
}

export const NO_SYNERGY: SynergyModel = { economic: () => 0, causal: () => 0 };

function noisyOr(a: number, b: number): number {
  return 1 - (1 - clamp01(a)) * (1 - clamp01(b));
}

function overlap(a: string[], b: string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 && right.size === 0) return 1;
  let shared = 0;
  for (const v of left) if (right.has(v)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export function isComposite(candidate: ActionCandidate): boolean {
  return !!candidate.metadata.composite;
}

/** Whether b can follow a (SEQ) or run beside it (PAR), by contract alone. */
export function compatible(a: ActionCandidate, b: ActionCandidate, op: CompositionOp, state: EconomicState): boolean {
  if (a.id === b.id || isComposite(a) || isComposite(b)) return false;
  const ca = contractOf(a);
  const cb = contractOf(b);
  if (unmetPreconditions(ca, state).length > 0) return false;
  if (op === 'PAR') {
    // Side by side means neither waits on the other.
    if (cb.evidenceConsumed.some((e) => ca.evidenceProduced.includes(e))) return false;
    if (ca.evidenceConsumed.some((e) => cb.evidenceProduced.includes(e))) return false;
    return unmetPreconditions(cb, state).length === 0;
  }
  return unmetPreconditions(cb, applyContract(ca, state)).length === 0;
}

/** One composite candidate, transparent and decomposable: its parts ride in
 *  `metadata.composite` and are carried out in order. */
export function compose(
  a: ActionCandidate, b: ActionCandidate, op: CompositionOp, synergy: SynergyModel = NO_SYNERGY,
): ActionCandidate {
  const ca = contractOf(a);
  const cb = contractOf(b);
  const addresses = [...new Set([...addressesOf(a), ...addressesOf(b)])];
  const dimOverlap = overlap(addressesOf(a), addressesOf(b));
  const economic = Math.max(0, synergy.economic(a.id, b.id, op));
  const causal = clamp01(synergy.causal(a.id, b.id, op));
  const uncertaintyEffects: Partial<Record<UncertaintyKind, number>> = {};
  for (const kind of UNCERTAINTY_KINDS) {
    const joint = noisyOr(ca.uncertaintyEffects[kind] ?? 0, cb.uncertaintyEffects[kind] ?? 0);
    if (joint > 0) uncertaintyEffects[kind] = clamp01(joint + causal);
  }
  const id = `${op}(${a.id},${b.id})`;
  return actionCandidate({
    id,
    kind: a.kind === 'continue' ? b.kind : a.kind,
    capability: `composite.${op.toLowerCase()}`,
    expectedProgress: noisyOr(a.expectedProgress, b.expectedProgress),
    expectedInformationGain: noisyOr(a.expectedInformationGain, b.expectedInformationGain),
    // Two savings over the same ground are one saving.
    expectedTokenBenefit: Math.max(a.expectedTokenBenefit, b.expectedTokenBenefit)
      + Math.min(a.expectedTokenBenefit, b.expectedTokenBenefit) * (1 - dimOverlap),
    expectedQualityBenefit: clamp01(noisyOr(a.expectedQualityBenefit, b.expectedQualityBenefit) + causal),
    expectedLatencyBenefit: Math.max(a.expectedLatencyBenefit, b.expectedLatencyBenefit),
    tokenCost: Math.max(0, a.tokenCost + b.tokenCost - economic),
    latencyCost: op === 'SEQ' ? a.latencyCost + b.latencyCost : Math.max(a.latencyCost, b.latencyCost),
    qualityRisk: noisyOr(a.qualityRisk, b.qualityRisk),
    coordinationCost: a.coordinationCost + b.coordinationCost,
    failureRisk: noisyOr(a.failureRisk, b.failureRisk),
    orchestrationCost: a.orchestrationCost + b.orchestrationCost,
    confidence: Math.min(a.confidence, b.confidence),
    metadata: {
      composite: { op, parts: [a.id, b.id], depth: MAX_COMPOSITION_DEPTH },
      parts: [a, b],
      addresses,
      candidateSource: 'composition',
      contract: {
        preconditions: ca.preconditions,
        effects: [...ca.effects, ...cb.effects],
        uncertaintyEffects,
        evidenceProduced: [...new Set([...ca.evidenceProduced, ...cb.evidenceProduced])],
        evidenceConsumed: ca.evidenceConsumed.concat(cb.evidenceConsumed.filter((e) => !ca.evidenceProduced.includes(e))),
        resourceEffects: [],
        reversibility: Math.min(ca.reversibility, cb.reversibility),
      } satisfies ActionContract,
    },
  });
}

/** Depth-2 compositions of the top-K primitives worth composing.
 *
 *  `advantage` is each primitive's V(s) − Q(s,a) from a market pass already
 *  made; `frontier` is the best advantage on the table. Noisy-OR benefits are
 *  at most additive, so adv(a) + adv(b) + the largest learned synergy is an
 *  optimistic bound on any composite of the two: one that cannot beat the
 *  frontier even optimistically is never built, never estimated. */
export function composeCandidates(input: {
  primitives: ActionCandidate[];
  state: EconomicState;
  advantage: (candidate: ActionCandidate) => number;
  frontier: number;
  synergy?: SynergyModel;
  /** Optional cap on how much synergy any pair can claim, in USD, for the bound. */
  maxSynergyUsd?: number;
  topK?: number;
}): { composites: ActionCandidate[]; considered: number; boundedOut: number } {
  const topK = Math.max(0, Math.min(COMPOSITION_TOP_K, input.topK ?? COMPOSITION_TOP_K));
  const pool = input.primitives
    .filter((c) => c.kind !== 'continue' && c.kind !== 'stop' && !isComposite(c))
    .map((c) => ({ c, adv: input.advantage(c) }))
    // Something with nothing to add even alone has nothing to add to a pair.
    .filter(({ adv }) => Number.isFinite(adv))
    .sort((x, y) => y.adv - x.adv || (x.c.id < y.c.id ? -1 : 1))
    .slice(0, topK);
  const maxSynergy = Math.max(0, input.maxSynergyUsd ?? 0);
  const out: ActionCandidate[] = [];
  let considered = 0;
  let boundedOut = 0;
  for (let i = 0; i < pool.length; i++) {
    for (let j = 0; j < pool.length; j++) {
      if (i === j) continue;
      for (const op of ['SEQ', 'PAR'] as const) {
        if (op === 'PAR' && j < i) continue;
        considered += 1;
        if (pool[i].adv + pool[j].adv + maxSynergy <= input.frontier) { boundedOut += 1; continue; }
        if (!compatible(pool[i].c, pool[j].c, op, input.state)) continue;
        out.push(compose(pool[i].c, pool[j].c, op, input.synergy));
      }
    }
  }
  return { composites: out, considered, boundedOut };
}

/** The parts of a composite, in execution order; the candidate itself
 *  otherwise. */
export function partsOf(candidate: ActionCandidate): ActionCandidate[] {
  const parts = candidate.metadata.parts;
  return isComposite(candidate) && Array.isArray(parts) ? (parts as ActionCandidate[]) : [candidate];
}

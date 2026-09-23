/** What the runtime can *do*, expressed so that every option is comparable to
 *  every other option.
 *
 *  The thing this replaces is not a file — it is a habit. Each existing engine
 *  answered its own question in its own units: `planEvidence` ranked evidence by
 *  `expectedGain`, `decideExecution` scored delegation against a threshold,
 *  `routeModel` picked a tier from pressure. All correct, none comparable. When
 *  the question is "is fetching this file worth more than running the test?",
 *  three incomparable scores answer nothing.
 *
 *  So an action is a *bundle of expected economic effects* with one shape:
 *  what it is expected to buy, what it is expected to cost, and how sure we are.
 *  The kind is a label for a receipt, not a branch in a switch — the ranking in
 *  `engine.ts` never reads it.
 *
 *  The invariant that keeps this generic: **capability-specific detail goes in
 *  `metadata`, never in a new field.** A field named `evidenceLevel` would be
 *  the first step towards a per-capability schema, and a per-capability schema
 *  is a per-capability pathway with extra steps. */
import { clamp01 } from '../efficiency/policy-types.js';

/** The whole vocabulary. Ten verbs, each of which is something *any* task can
 *  do — deliberately not "refactor", "investigate", "write tests", which are
 *  task shapes rather than runtime capabilities.
 *
 *  `continue` is first and is the default: the healthy action is almost always
 *  to let the agent get on with it. */
export const ACTION_KINDS = [
  'continue',
  'acquire_evidence',
  'explore',
  'validate',
  'reuse_evidence',
  'parallelize',
  'serialize',
  'recover',
  'constrain',
  'stop',
] as const;

export type ActionKind = (typeof ACTION_KINDS)[number];

const KIND_SET: ReadonlySet<string> = new Set(ACTION_KINDS);

export function isActionKind(value: string): value is ActionKind {
  return KIND_SET.has(value);
}

export interface ActionCandidate {
  /** Stable across a decision cycle, and the deterministic final tie-break in
   *  ranking. Two runs over the same state must choose the same action. */
  id: string;
  kind: ActionKind;
  /** Which capability would carry this out — `context.select`,
   *  `validation.unit-tests`, `recovery.retry`. A string rather than an enum so
   *  a new capability needs no change here. */
  capability: string;

  // ---- what it is expected to buy ------------------------------------------
  // The first three are normalized to [0,1] because they are *shares* of
  // something bounded; the last two are absolute because tokens and
  // milliseconds have units and pretending otherwise loses the magnitude that
  // makes two actions comparable.

  /** [0,1]. Fraction of the remaining work this is expected to close. */
  expectedProgress: number;
  /** [0,1]. Fraction of current doubt this is expected to remove. */
  expectedInformationGain: number;
  /** Tokens this is expected to *save* — exploration it makes unnecessary,
   *  rediscovery it prevents, duplication it avoids. */
  expectedTokenBenefit: number;
  /** [0,1]. How much this raises the probability the result is correct. */
  expectedQualityBenefit: number;
  /** Milliseconds this is expected to save. */
  expectedLatencyBenefit: number;

  // ---- what it is expected to cost -----------------------------------------

  tokenCost: number;
  latencyCost: number;
  /** [0,1]. How much this *lowers* the probability the result is correct. The
   *  term a token saving is never allowed to buy — see `utility.ts`. */
  qualityRisk: number;
  /** Tokens spent on coordination rather than work: duplicated context across
   *  parallel branches, handoff envelopes, merge overhead. */
  coordinationCost: number;
  /** [0,1]. Probability the action itself does not do what it says. */
  failureRisk: number;
  /** What *deciding and carrying out* this action costs the orchestrator, as
   *  distinct from what the action buys. Charged to the optimization allowance,
   *  never to the task — otherwise an expensive orchestrator reports itself as
   *  cheap work. */
  orchestrationCost: number;

  /** [0,1]. How much the numbers above deserve to be believed. Low confidence
   *  must make an action *less* eligible, never more — an uncertain orchestrator
   *  intervening harder is the failure mode this whole layer is built to avoid. */
  confidence: number;

  /** Everything the capability needs and the decision layer must not read. */
  metadata: Record<string, unknown>;
}

export interface ActionDecision {
  decisionId: string;
  /** The state version this was decided against. A decision that arrives after
   *  the state has moved on can be recognised as stale rather than applied. */
  stateVersion: number;
  action: ActionCandidate;
  utility: number;
  /** Machine-readable, stable, and the thing a benchmark attributes regressions
   *  with. Prose belongs in the receipt, not here. */
  reasonCodes: string[];
  confidence: number;
}

/** Absolute quantities: finite and non-negative, or zero. Not clamped above —
 *  a saving of fifty thousand tokens is a real number someone should see. */
function quantity(value: unknown): number {
  return Number.isFinite(value) && (value as number) >= 0 ? (value as number) : 0;
}

/** Total by construction, for the same reason `normalizeEconomicState` is: a
 *  NaN that reaches the utility arithmetic silently poisons a comparison that
 *  decides whether to spend money. */
export function normalizeActionCandidate(candidate: ActionCandidate): ActionCandidate {
  return {
    id: typeof candidate.id === 'string' && candidate.id ? candidate.id : 'anonymous',
    kind: isActionKind(candidate.kind as string) ? candidate.kind : 'continue',
    capability: typeof candidate.capability === 'string' ? candidate.capability : '',

    expectedProgress: clamp01(candidate.expectedProgress),
    expectedInformationGain: clamp01(candidate.expectedInformationGain),
    expectedTokenBenefit: quantity(candidate.expectedTokenBenefit),
    expectedQualityBenefit: clamp01(candidate.expectedQualityBenefit),
    expectedLatencyBenefit: quantity(candidate.expectedLatencyBenefit),

    tokenCost: quantity(candidate.tokenCost),
    latencyCost: quantity(candidate.latencyCost),
    qualityRisk: clamp01(candidate.qualityRisk),
    coordinationCost: quantity(candidate.coordinationCost),
    failureRisk: clamp01(candidate.failureRisk),
    orchestrationCost: quantity(candidate.orchestrationCost),

    // The cautious middle, not certainty: an unreadable confidence must not
    // license an intervention.
    confidence: clamp01(candidate.confidence, 0.5),

    metadata: candidate.metadata && typeof candidate.metadata === 'object' ? { ...candidate.metadata } : {},
  };
}

/** The constructor every producer uses, so a candidate can never be missing a
 *  dimension the ranking reads. Everything unspecified is zero — an effect
 *  nobody claimed is an effect that does not exist. */
export function actionCandidate(
  partial: Pick<ActionCandidate, 'id' | 'kind' | 'capability'> & Partial<ActionCandidate>,
): ActionCandidate {
  return normalizeActionCandidate(partial as ActionCandidate);
}

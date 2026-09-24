/** The one contract between CherryOnTop and any System-1 provider.
 *
 *  Laya and JEV both answer the same three typed primitives, so a judgment is
 *  represented once, here, and the decision layer never sees a provider's own
 *  wire shape. Validation lives next to the types because a request or a
 *  judgment that does not satisfy these rules must never reach economics. */

export type DecisionSurface =
  | 'execution.decomposable'
  | 'runtime.next_action'
  | 'action.helpful'
  /** A bounded question the execution model asked through `<cto_decide>`. */
  | 'model.request';

export type DecisionPrimitive = 'noul' | 'choice' | 'score';
export type ProviderName = 'laya' | 'jev';

export const PRIMITIVES: readonly DecisionPrimitive[] = ['noul', 'choice', 'score'];

export interface DecisionCandidate {
  /** Stable, provider-independent, receipt-safe. */
  id: string;
  /** What the runtime would do. Empty for a model-supplied option. */
  action: string;
  description: string;
}

export interface DecisionRequest {
  /** Deterministic: derived from the digest, so the same question about the same
   *  state is the same request. */
  id: string;
  source: 'harness' | 'model';
  surface: DecisionSurface;
  primitive: DecisionPrimitive;
  question: string;
  /** Which wording of the question, so a changed prompt is a changed receipt. */
  questionVersion: string;
  /** The compact, provider-facing state. Every value already fits the budget. */
  state: Record<string, string | number | boolean>;
  /** Choice options, or score levels in rubric order. Empty for noul. */
  candidates: DecisionCandidate[];
  stateVersion: number;
  /** sha256 over everything above except `id`, so two requests with the same
   *  digest are guaranteed to be the same question. */
  inputDigest: string;
  /** True when the compiler had to drop state to fit the provider's context. */
  truncated: boolean;
}

export interface DecisionJudgment {
  requestId: string;
  provider: ProviderName;
  surface: DecisionSurface;
  primitive: DecisionPrimitive;
  result: {
    /** choice */
    selectedId?: string;
    probabilities?: Record<string, number>;
    /** noul: P(true) */
    probability?: number;
    /** score: expected level on [min, max] */
    score?: { value: number; min: number; max: number };
  };
  calibration: {
    rawProbability?: number;
    calibratedProbability?: number;
    version: string;
  };
  confidence: {
    /** The provider's own normalized-entropy confidence. */
    provider: number;
    /** CherryOnTop's confidence in the state the question was asked about. */
    orchestration: number;
  };
  metadata: {
    model: string;
    modelVersion?: string;
    questionVersion: string;
    inputDigest: string;
    stateVersion: number;
    latencyMs: number;
    inputTokens: number;
  };
}

/** Bounds shared by every entry path. The model-facing gateway applies them to
 *  model input; the provider applies them again, because a harness bug must not
 *  be able to send what a model could not. */
export const LIMITS = {
  questionChars: 400,
  optionChars: 240,
  maxOptions: 8,
  minChoiceOptions: 2,
  idChars: 32,
} as const;

export class InvalidDecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDecisionError';
  }
}

/** Throws on anything a provider must never be asked. */
export function assertValidRequest(request: DecisionRequest): void {
  const question = request.question.trim();
  if (!question) throw new InvalidDecisionError('question is empty');
  if (question.length > LIMITS.questionChars) throw new InvalidDecisionError(`question exceeds ${LIMITS.questionChars} characters`);
  if (!PRIMITIVES.includes(request.primitive)) throw new InvalidDecisionError(`unknown primitive "${String(request.primitive)}"`);

  const ids = new Set<string>();
  for (const c of request.candidates) {
    if (!c.id || c.id.length > LIMITS.idChars) throw new InvalidDecisionError('option id is empty or too long');
    if (ids.has(c.id)) throw new InvalidDecisionError(`duplicate option id "${c.id}"`);
    ids.add(c.id);
    if (!c.description.trim()) throw new InvalidDecisionError(`option "${c.id}" has no description`);
    if (c.description.length > LIMITS.optionChars) throw new InvalidDecisionError(`option "${c.id}" exceeds ${LIMITS.optionChars} characters`);
  }
  if (request.candidates.length > LIMITS.maxOptions) throw new InvalidDecisionError(`more than ${LIMITS.maxOptions} options`);
  if (request.primitive === 'noul' && request.candidates.length > 0) throw new InvalidDecisionError('a noul question takes no options');
  if (request.primitive !== 'noul' && request.candidates.length < LIMITS.minChoiceOptions) {
    throw new InvalidDecisionError(`a ${request.primitive} question needs at least ${LIMITS.minChoiceOptions} options`);
  }
}

const isProbability = (p: unknown): p is number => typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1;

/** Throws when a provider returned something that is not a valid answer to
 *  *this* request. A malformed answer is a provider failure, never a guess. */
export function assertValidJudgment(judgment: DecisionJudgment, request: DecisionRequest): void {
  if (judgment.requestId !== request.id) throw new InvalidDecisionError('judgment answers a different request');
  if (judgment.metadata.inputDigest !== request.inputDigest) throw new InvalidDecisionError('judgment digest does not match the request');
  const r = judgment.result;
  if (request.primitive === 'noul') {
    if (!isProbability(r.probability)) throw new InvalidDecisionError('noul probability is not a finite probability');
    return;
  }
  if (request.primitive === 'choice') {
    const ids = request.candidates.map((c) => c.id);
    if (!r.selectedId || !ids.includes(r.selectedId)) throw new InvalidDecisionError('choice selected an option that was not offered');
    const probabilities = r.probabilities ?? {};
    const keys = Object.keys(probabilities);
    if (keys.length !== ids.length || !ids.every((id) => isProbability(probabilities[id]))) {
      throw new InvalidDecisionError('choice probabilities do not cover exactly the offered options');
    }
    return;
  }
  const s = r.score;
  if (!s || ![s.value, s.min, s.max].every(Number.isFinite) || s.value < s.min || s.value > s.max) {
    throw new InvalidDecisionError('score is not a finite value inside its scale');
  }
}

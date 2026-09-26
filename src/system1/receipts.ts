/** The audit record of a System-1 decision.
 *
 *  Stored as an event on the existing append-only chain, not as a row in the
 *  `decisions` table. That table's readers assume every row is an execution or
 *  runtime choice: the approval view reads "the most recent decision" as the
 *  escalation that parked the node, and the GUI titles each row as a choice of
 *  how to run. A judgment landing there would silently become the "reason" an
 *  approval shows. The event chain is already the complete, replayable record,
 *  and the transcripts skip event types they do not narrate, so a receipt
 *  cannot flood what a person reads. */
import type { JudgeOutcome } from './guard.js';
import type { System1Epoch } from '../efficiency/ledger.js';

export const SYSTEM1_EVENT = 'system1.judgment';

export interface System1Receipt {
  decisionId: string;
  stateVersion: number;
  source: 'harness' | 'model';
  surface: string;
  primitive: string;
  provider: string;
  model: string | null;
  modelVersion: string | null;
  questionVersion: string;
  inputDigest: string;
  legalOptions: string[];
  truncated: boolean;
  rawOutput: Record<string, unknown> | null;
  calibratedOutput: Record<string, unknown> | null;
  calibrationVersion: string | null;
  providerConfidence: number | null;
  orchestrationConfidence: number | null;
  /** What System-1 preferred, when it was a choice. */
  selectedAction: string | null;
  /** What economics made of it: the numbers that turned a probability into an
   *  action, or null when the judgment was not priced. */
  economicResult: Record<string, number | string | boolean> | null;
  /** What the runtime actually did. May differ from `selectedAction`, and the
   *  difference is the point of recording both. */
  finalRuntimeAction: string;
  latencyMs: number;
  /** Provider input tokens attributed to this question. */
  tokenCost: number;
  attempts: number;
  cached: boolean;
  fallback: boolean;
  fallbackReason: string | null;
  failureType: string | null;
}

export interface ReceiptContext {
  provider: string;
  economicResult?: Record<string, number | string | boolean>;
  finalRuntimeAction: string;
  /** Set when a deterministic rule decided instead of the judgment. */
  fallbackReason?: string;
}

/** Stable key order and plain JSON values only, so a receipt serializes the
 *  same way every time it is written or replayed. */
export function buildReceipt(outcome: JudgeOutcome, ctx: ReceiptContext): System1Receipt {
  const { request, judgment, failure } = outcome;
  const fallback = !judgment || ctx.fallbackReason !== undefined;
  return {
    decisionId: request.id,
    stateVersion: request.stateVersion,
    source: request.source,
    surface: request.surface,
    primitive: request.primitive,
    provider: judgment?.provider ?? ctx.provider,
    model: judgment?.metadata.model ?? null,
    modelVersion: judgment?.metadata.modelVersion ?? null,
    questionVersion: request.questionVersion,
    inputDigest: request.inputDigest,
    legalOptions: request.candidates.map((c) => c.id),
    truncated: request.truncated,
    rawOutput: judgment
      ? { rawProbability: judgment.calibration.rawProbability ?? null, selectedId: judgment.result.selectedId ?? null, score: judgment.result.score?.value ?? null }
      : null,
    calibratedOutput: judgment
      ? {
          probability: judgment.result.probability ?? null,
          probabilities: judgment.result.probabilities ?? null,
          calibratedProbability: judgment.calibration.calibratedProbability ?? null,
        }
      : null,
    calibrationVersion: judgment?.calibration.version ?? null,
    providerConfidence: judgment?.confidence.provider ?? null,
    orchestrationConfidence: judgment?.confidence.orchestration ?? null,
    selectedAction: judgment?.result.selectedId ?? null,
    economicResult: ctx.economicResult ?? null,
    finalRuntimeAction: ctx.finalRuntimeAction,
    latencyMs: outcome.latencyMs,
    tokenCost: outcome.cached ? 0 : (judgment?.metadata.inputTokens ?? 0),
    attempts: outcome.attempts,
    cached: outcome.cached,
    fallback,
    fallbackReason: ctx.fallbackReason ?? (failure ? failure.reason : null),
    failureType: failure?.kind ?? null,
  };
}

/** One epoch's worth of System-1 overhead for the efficiency ledger.
 *
 *  Calls and latency are per batch, not per question: every question in an
 *  epoch shared the provider round trips, so summing them per question would
 *  count one forward pass several times. */
export function epochOf(outcomes: readonly JudgeOutcome[], modelRequests?: number): System1Epoch {
  const live = outcomes.filter((o) => !o.cached);
  return {
    questions: outcomes.length,
    cached: outcomes.length - live.length,
    calls: Math.max(0, ...live.map((o) => o.attempts)),
    latencyMs: Math.max(0, ...live.map((o) => o.latencyMs)),
    inputTokens: live.reduce((sum, o) => sum + (o.judgment?.metadata.inputTokens ?? 0), 0),
    failed: outcomes.some((o) => o.failure !== undefined),
    fallback: outcomes.some((o) => !o.judgment),
    candidates: outcomes.reduce((sum, o) => sum + o.request.candidates.length, 0),
    ...(modelRequests === undefined ? {} : { modelRequests }),
  };
}

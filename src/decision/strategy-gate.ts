/** Can this task be partitioned, and what shape did the market's choice take?
 *
 *  Two questions, and the whole point of this module is that they are asked
 *  separately and in that order. Collapsing them is what produces both failure
 *  modes at once: a broad-but-coherent goal ("review the codebase for bugs")
 *  looks splittable to economics that were never told it has no seam, and a
 *  genuinely multi-workstream goal looks unaffordable to a structural check
 *  that was never told what delegation buys.
 *
 *  Three stages, and stage two only runs when stage one cannot answer:
 *
 *   1. **Typed evidence.** Free. System-1's calibrated P(splits), already
 *      asked for the delegation decision, settles partitionability; nothing is
 *      read off the goal's wording. Most tasks stop here, which is the saving.
 *   2. **Cheap classifier.** A model call, bought *only* for a goal whose
 *      partitionability is genuinely ambiguous. Its scope is deliberately tiny:
 *      it answers whether the work comes apart and how parallel it looks. It
 *      does not allocate authority, choose a child count, or write subgoals —
 *      those are the planner's job and giving them to a classifier is how a
 *      "cheap" call becomes a planning dispatch in disguise.
 *   3. **The market's outcome.** Whether to delegate is the Action Market's
 *      decision (`authorizeExecution`), passed in as `outcome` — this module
 *      names the strategy that outcome is, and never re-decides it. Serial
 *      versus parallel is named last, and only a scheduler that actually chose
 *      parallel work can produce `PARALLEL_DELEGATED`.
 *
 *  A classifier that fails is not a task that fails: the gate falls back to the
 *  deterministic answer and says so in a reason code. Deterministic and total
 *  apart from the injected classifier. */
import { receipt, type DecisionReceipt } from './types.js';
import { hardGates, delegationEstimate, type DispatchEstimate } from './engine.js';
import type { DecisionOutcome } from '../schemas/decision.js';
import type { DispatchPreparation } from './dispatch-preparation.js';

export type ExecutionStrategy = 'MANAGED' | 'SERIAL_DELEGATED' | 'PARALLEL_DELEGATED';

export interface StrategyPrior {
  strategy: ExecutionStrategy;
  expectedSuccess: number;
  expectedQuality: number;
  expectedCostUsd: number;
  expectedLatencyMs: number;
  effectiveObservations: number;
}

export interface StrategyEvidence {
  partitionability: 'YES' | 'NO' | 'UNCERTAIN';
  parallelism: 'LOW' | 'MEDIUM' | 'HIGH';
  confidence: number;
  reasonCodes: string[];
  /** True when the deterministic gate answered on its own and no model was
   *  bought. The number a benchmark should watch: a classifier that fires on
   *  every task has made the fast path expensive. */
  deterministic: boolean;
  historicalPrior?: StrategyPrior;
}

export interface StrategyDecision {
  strategy: ExecutionStrategy;
  evidence: StrategyEvidence;
  receipt: DecisionReceipt;
}

/** Everything a classifier is allowed to say. Anything else it returns is
 *  dropped — see `sanitizeClassification`. */
export interface StrategyClassification {
  partitionability: 'YES' | 'NO' | 'UNCERTAIN';
  parallelism: 'LOW' | 'MEDIUM' | 'HIGH';
  confidence: number;
  reasonCodes?: string[];
}

export type StrategyClassifier = (input: { goal: string; mode: string }) => StrategyClassification;

export interface DecideStrategyInput {
  preparation: DispatchPreparation;
  /** What the Action Market decided. The strategy is the name of that
   *  decision's shape, so it is an input, never recomputed here. */
  outcome: DecisionOutcome;
  spentUsd: number;
  dispatch: DispatchEstimate;
  /** Bought only when partitionability is ambiguous. Absent means the gate
   *  stays deterministic, which is a perfectly good deployment. */
  classify?: StrategyClassifier;
  /** Whether the scheduler actually selected concurrent work for this plan.
   *  Delegation and parallelism are separate decisions: a delegated task whose
   *  branches must run in order is `SERIAL_DELEGATED`, and that is a success,
   *  not a degraded parallel run. */
  parallelSelected?: boolean;
  plannedChildCount?: number;
  prior?: StrategyPrior;
  requiresApproval?: boolean;
}

const FIELDS_A_CLASSIFIER_MAY_NOT_SET = ['childCount', 'subgoals', 'budgetUsd', 'children', 'plan', 'authority'];

/** Keeps a classifier inside its contract.
 *
 *  Not defensive programming for its own sake: the pressure on this boundary is
 *  real and one-directional. A classifier that can name subgoals is a planner,
 *  a classifier that can name a child count is an allocator, and the whole
 *  economic argument for calling one is that it is neither. */
export function sanitizeClassification(raw: unknown): StrategyClassification | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const partitionability = value.partitionability;
  const parallelism = value.parallelism;
  if (partitionability !== 'YES' && partitionability !== 'NO' && partitionability !== 'UNCERTAIN') return null;
  if (parallelism !== 'LOW' && parallelism !== 'MEDIUM' && parallelism !== 'HIGH') return null;
  const overreach = FIELDS_A_CLASSIFIER_MAY_NOT_SET.filter((field) => field in value);
  const confidence = typeof value.confidence === 'number' && Number.isFinite(value.confidence)
    ? Math.min(1, Math.max(0, value.confidence))
    : 0.5;
  return {
    partitionability,
    parallelism,
    confidence,
    reasonCodes: [
      ...(Array.isArray(value.reasonCodes) ? value.reasonCodes.filter((code): code is string => typeof code === 'string') : []),
      ...overreach.map((field) => `classifier_overreach_dropped:${field}`),
    ],
  };
}

/** Stage one. What System-1's typed answer already settles.
 *
 *  Nothing here reads the goal: breadth words, conjunctions and "in parallel"
 *  are guesses about whether work comes apart, and the answer to that question
 *  is System-1's calibrated P(splits) (`execution.decomposable`). A probability
 *  past even odds is a "yes" and the doubt it carries is its confidence, so the
 *  stage needs no threshold of its own. No answer is `UNCERTAIN`, the one shape
 *  worth buying a classifier's opinion about. */
export function deterministicEvidence(preparation: DispatchPreparation): StrategyEvidence {
  const p = preparation.understanding.splitProbability;
  if (p === undefined) {
    return {
      partitionability: 'UNCERTAIN', parallelism: 'LOW', confidence: 0,
      reasonCodes: ['no_split_judgment'], deterministic: true,
    };
  }
  const splits = p >= 0.5;
  return {
    partitionability: splits ? 'YES' : 'NO',
    // How many pieces can run at once is not something a probability says.
    parallelism: splits ? 'MEDIUM' : 'LOW',
    confidence: Math.abs(2 * p - 1),
    reasonCodes: [splits ? 'system1_says_splits' : 'system1_says_single_unit'],
    deterministic: true,
  };
}

/** The whole gate: deterministic, then a classifier only if it must, then
 *  economics. */
export function decideStrategy(input: DecideStrategyInput): StrategyDecision {
  const { preparation } = input;
  let evidence = deterministicEvidence(preparation);

  // The rules that outrank every score also outrank every model call: a task
  // parked on an approval or out of budget must not buy a classifier to find
  // out what it is not going to do.
  const gated = hardGates({
    authority: preparation.authority,
    spentUsd: input.spentUsd,
    ...(input.requiresApproval === undefined ? {} : { requiresApproval: input.requiresApproval }),
  });
  if (gated) {
    return {
      strategy: 'MANAGED',
      evidence: { ...evidence, reasonCodes: [...evidence.reasonCodes, `hard_gate:${gated.gate ?? gated.chosen}`] },
      receipt: gated,
    };
  }

  // Stage two. Bought only for a goal the free signals could not settle, only
  // when the market actually chose to split it (a model call is not bought to
  // name a strategy nobody is taking), and only when a classifier was actually
  // wired in.
  if (evidence.partitionability === 'UNCERTAIN' && input.outcome === 'DELEGATE' && input.classify) {
    try {
      const classification = sanitizeClassification(
        input.classify({ goal: preparation.goal, mode: preparation.mode }),
      );
      evidence = classification
        ? {
            partitionability: classification.partitionability,
            parallelism: classification.parallelism,
            confidence: classification.confidence,
            reasonCodes: [...evidence.reasonCodes, 'classifier_consulted', ...(classification.reasonCodes ?? [])],
            deterministic: false,
          }
        : { ...evidence, reasonCodes: [...evidence.reasonCodes, 'classifier_returned_invalid_shape'] };
    } catch (err) {
      // A broken optimizer degrades to baseline behaviour. It does not take the
      // task down with it.
      evidence = {
        ...evidence,
        reasonCodes: [...evidence.reasonCodes, `classifier_failed:${err instanceof Error ? err.name : 'unknown'}`, 'deterministic_fallback'],
      };
    }
  }

  if (input.prior) evidence = { ...evidence, historicalPrior: input.prior };

  // Stage three: name what the market chose. Recomputing delegation economics
  // here would be a second answer to a question the market already answered.
  if (input.outcome !== 'DELEGATE') {
    return {
      strategy: 'MANAGED',
      evidence: { ...evidence, reasonCodes: [...evidence.reasonCodes, `market:${input.outcome}`] },
      receipt: receipt({ chosen: 'RUN_MODEL', reason: 'the market chose to do this work directly', estimate: input.dispatch }),
    };
  }
  const economics = receipt({
    chosen: 'SPAWN_AGENT',
    reason: 'the market chose to split this work',
    estimate: delegationEstimate(input.dispatch, input.plannedChildCount ?? 1),
  });

  // Delegated. Serial unless the scheduler actually preferred concurrency —
  // "cannot parallelize" is a scheduling result, never a reason not to delegate.
  const parallel = input.parallelSelected === true && evidence.parallelism !== 'LOW';
  const reason = parallel
    ? 'delegate_parallel'
    : input.parallelSelected === true ? 'delegate_serial:low_parallelism' : 'delegate_serial:scheduler_did_not_select_parallel';

  return {
    strategy: parallel ? 'PARALLEL_DELEGATED' : 'SERIAL_DELEGATED',
    evidence: { ...evidence, reasonCodes: [...evidence.reasonCodes, reason] },
    receipt: economics,
  };
}

/** The strategy as a decision receipt, for the audit path that wants one shape
 *  for every choice the runtime made. */
export function strategyReceipt(decision: StrategyDecision): DecisionReceipt {
  return receipt({
    ...decision.receipt,
    reason: `${decision.strategy}: ${decision.evidence.reasonCodes.join(', ')}`,
  });
}

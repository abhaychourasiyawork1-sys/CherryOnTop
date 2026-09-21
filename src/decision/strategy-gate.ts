/** Can this task be partitioned, and is partitioning worth what it costs?
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
 *   1. **Deterministic gate.** Free. Handles the obvious managed cases and the
 *      obvious delegation candidates from signals `assessDecomposition` already
 *      computes. Most tasks stop here, which is the saving.
 *   2. **Cheap classifier.** A model call, bought *only* for a goal whose
 *      partitionability is genuinely ambiguous. Its scope is deliberately tiny:
 *      it answers whether the work comes apart and how parallel it looks. It
 *      does not allocate authority, choose a child count, or write subgoals —
 *      those are the planner's job and giving them to a classifier is how a
 *      "cheap" call becomes a planning dispatch in disguise.
 *   3. **Economics.** The existing `decideExecutionPath`, unchanged, consuming
 *      the evidence above plus whatever history says. Serial versus parallel is
 *      decided last, and only a scheduler that actually chose parallel work can
 *      produce `PARALLEL_DELEGATED`.
 *
 *  A classifier that fails is not a task that fails: the gate falls back to the
 *  deterministic answer and says so in a reason code. Deterministic and total
 *  apart from the injected classifier. */
import { receipt, type DecisionReceipt } from './types.js';
import { decideExecutionPath, hardGates, type ExecutionPathInput, type DispatchEstimate } from './engine.js';
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

export type StrategyClassifier = (input: { goal: string; taskClass: string }) => StrategyClassification;

export interface DecideStrategyInput {
  preparation: DispatchPreparation;
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

/** Stage one. What the free signals already settle. */
export function deterministicEvidence(preparation: DispatchPreparation): StrategyEvidence {
  const signals = preparation.decompositionSignals;
  const reasonCodes: string[] = [];
  const explicit = (signals.explicit_split_request ?? 0) > 0;
  const workTypes = signals.distinct_work_types ?? 0;
  const separate = signals.separate_items ?? 0;
  const anchored = (signals.named_single_targets ?? 0) > 0;
  const breadth = signals.breadth_terms ?? 0;

  // A person asking for a fan-out outranks every inference about whether the
  // work comes apart. It is not a heuristic call any more.
  if (explicit) {
    reasonCodes.push('explicit_split_request');
    return { partitionability: 'YES', parallelism: 'HIGH', confidence: 0.95, reasonCodes, deterministic: true };
  }

  // Several named deliverables in one sentence: a real split, and the case the
  // economics should be allowed to price.
  if (workTypes >= 2 && separate >= 1) {
    reasonCodes.push('multiple_work_types_and_items');
    return {
      partitionability: 'YES',
      parallelism: separate >= 2 ? 'HIGH' : 'MEDIUM',
      confidence: 0.8, reasonCodes, deterministic: true,
    };
  }

  // One named target, and the decomposition already concluded the goal does
  // not come apart. The tiny-task case, and the one that must never pay for a
  // classifier to be told what it already knows. `coherent_single_task` is not
  // the test here on purpose: "fix the typo in README.md" names two *work
  // types* (a fix, and a documentation file) and is still one job — which is
  // exactly why `assessDecomposition` weighs a named target against them.
  const splittable = preparation.verdict.decomposition.worthSplitting;
  if (anchored && !splittable) {
    reasonCodes.push('single_named_target');
    if (preparation.economics.complexityBand === 'tiny') reasonCodes.push('tiny_task');
    return { partitionability: 'NO', parallelism: 'LOW', confidence: 0.9, reasonCodes, deterministic: true };
  }

  // Read-only investigation of one coherent question. Broad, but broad is not
  // a seam — this is the goal shape that used to be split five ways.
  if (preparation.economics.readOnly && !splittable) {
    reasonCodes.push('coherent_investigation');
    return { partitionability: 'NO', parallelism: 'LOW', confidence: 0.75, reasonCodes, deterministic: true };
  }

  // The decomposition says it splits and nothing above disagreed. Lower
  // confidence than the two rules that named their evidence outright, because
  // this one is a score clearing a threshold.
  if (splittable) {
    reasonCodes.push('decomposition_scores_splittable');
    return {
      partitionability: 'YES',
      parallelism: breadth >= 2 ? 'HIGH' : 'MEDIUM',
      confidence: 0.6, reasonCodes, deterministic: true,
    };
  }

  // Broad, coherent, unanchored. Genuinely ambiguous, and the only shape worth
  // buying an opinion about.
  reasonCodes.push(breadth > 0 ? 'broad_but_coherent' : 'no_decisive_signal');
  return {
    partitionability: 'UNCERTAIN',
    parallelism: breadth >= 2 ? 'MEDIUM' : 'LOW',
    confidence: 0.4, reasonCodes, deterministic: true,
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

  // Stage two. Bought only for a goal the free signals could not settle, and
  // only when a classifier was actually wired in.
  if (evidence.partitionability === 'UNCERTAIN' && input.classify) {
    try {
      const classification = sanitizeClassification(
        input.classify({ goal: preparation.goal, taskClass: preparation.taskClass }),
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

  // Stage three. The existing economics, in the existing vocabulary — not a
  // second engine, and not a second set of thresholds.
  const pathInput: ExecutionPathInput = {
    goal: preparation.goal,
    authority: preparation.authority,
    spentUsd: input.spentUsd,
    dispatch: input.dispatch,
    complexity: preparation.complexity,
    // Structural evidence, not a re-derivation: the gate is what decides
    // whether the goal comes apart, and economics prices that answer. An
    // `UNCERTAIN` verdict defers to the decomposition rather than reading as a
    // yes — treating "we could not tell" as "it splits" is how an ambiguous
    // goal buys a planner and a fan-out on no evidence at all.
    worthSplitting: evidence.partitionability === 'UNCERTAIN'
      ? preparation.verdict.decomposition.worthSplitting
      : evidence.partitionability === 'YES',
    signals: preparation.decompositionSignals,
    ...(input.plannedChildCount === undefined ? {} : { plannedChildCount: input.plannedChildCount }),
    ...(input.requiresApproval === undefined ? {} : { requiresApproval: input.requiresApproval }),
  };
  const economics = decideExecutionPath(pathInput);

  if (economics.chosen !== 'SPAWN_AGENT') {
    return {
      strategy: 'MANAGED',
      evidence: { ...evidence, reasonCodes: [...evidence.reasonCodes, `economics:${economics.chosen}`] },
      receipt: economics,
    };
  }

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

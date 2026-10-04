/** `execution.decomposable`: whether a goal comes apart into independent
 *  workstreams.
 *
 *  System-1 owns the verdict, and nothing reads the goal's wording ahead of it:
 *  breadth words, conjunctions and "in parallel" are guesses, and each of the
 *  rules built on them (a coherent-single-task gate, an explicit-split gate, a
 *  complexity band) decided the same semantic question System-1 exists to
 *  answer, with a blind spot of its own.
 *
 *   - The verdict is System-1's calibrated P(splits), turned into a yes/no by a
 *     boundary derived from what the market says each way of getting the work
 *     done costs (`decompositionBoundary`) — not a magic probability.
 *   - `decideExecution` / `authorizeExecution` still decide whether splitting is
 *     legal and worth it.
 *
 *  The question is asked only when its answer can change the action: with no
 *  spawn authority, fewer than two children allowed, children already created,
 *  or economics that would not delegate even on a certain "yes", the rule
 *  decides and System-1 is never called.
 *
 *  On provider failure the answer is "do not split" (spec §17): a hidden second
 *  brain behind the provider is the thing this architecture forbids. */
import type { IntelligenceBundle } from '../intelligence/coordinator.js';
import { uninformedDifficulty } from '../intelligence/difficulty.js';
import type { Authority } from '../schemas/node-contract.js';
import { compileHarnessRequest, type Fact } from './compiler.js';
import { worthSplittingFrom, type DecompositionBoundary } from './economic-mapping.js';
import { system1 as defaultSystem1, type JudgeOutcome, type System1 } from './guard.js';

export interface DecomposabilityInput {
  scope: string;
  goal: string;
  authority: Authority;
  existingChildren: number;
  /** Where delegating starts to beat doing the work whole, from the market's
   *  prices. Null when no answer could make it cheaper — nothing to ask. */
  boundary: DecompositionBoundary | null;
  /** How hard the work is believed to be. */
  difficulty?: number;
  facts?: Fact[];
  stateVersion?: number;
  orchestration?: number;
}

export interface DecomposabilityResult {
  bundle: IntelligenceBundle;
  /** The rule that decided without asking, if one did. */
  gate?: string;
  outcome?: JudgeOutcome;
  /** Set when the provider was asked and could not answer. */
  fallbackReason?: string;
}

export async function assessDecomposability(
  input: DecomposabilityInput,
  s1: System1 = defaultSystem1(),
): Promise<DecomposabilityResult> {
  const signals: Record<string, number> = {};
  const bundle = (splitProbability?: number): IntelligenceBundle => ({
    sufficientContext: true,
    difficulty: input.difficulty ?? uninformedDifficulty().value,
    ...(splitProbability === undefined ? {} : { splitProbability }),
    signals,
  });

  const boundary = input.boundary;
  const gate = !input.authority.spawn_children ? 'no-spawn-authority'
    : input.authority.max_child_count < 2 ? 'no-fan-out-allowance'
    : input.existingChildren > 0 ? 'already-delegated'
    : !boundary ? 'economics-would-not-delegate'
    : undefined;
  if (gate) {
    signals[`system1_gate_${gate.replace(/-/g, '_')}`] = 1;
    // Every gate means no: nothing is said about whether the work splits.
    return { bundle: bundle(), gate };
  }

  const request = compileHarnessRequest({
    surface: 'execution.decomposable',
    goal: input.goal,
    facts: input.facts ?? [],
    stateVersion: input.stateVersion ?? 0,
  });
  const [outcome] = await s1.judge(input.scope, [request], {
    orchestration: input.orchestration ?? 0.5,
  });
  signals.system1_asked = 1;
  signals.system1_threshold = Number(boundary!.threshold.toFixed(4));

  // The calibrated probability of the `many` option: see compiler.ts for why
  // this is asked as a two-way choice and calibration.ts for the calibrator.
  const p = outcome.judgment?.result.probabilities?.many;
  if (p === undefined) {
    signals.system1_fallback = 1;
    return { bundle: bundle(), outcome, fallbackReason: outcome.failure?.reason ?? 'no judgment' };
  }
  signals.system1_p_decomposable = Number(p.toFixed(4));
  signals.system1_worth_splitting = worthSplittingFrom(p, boundary!) ? 1 : 0;
  return { bundle: bundle(p), outcome };
}

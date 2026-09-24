/** `execution.decomposable`: whether a goal comes apart into independent
 *  workstreams.
 *
 *  Ownership after this change:
 *
 *   - `assessDecomposition` keeps producing the *facts* (breadth terms,
 *     separate items, work types, named targets, explicit split requests,
 *     investigative wording) and the size band economics prices on. They are
 *     recorded as before.
 *   - The *semantic verdict* (does it split?) now comes from System-1, turned
 *     into a yes/no by a boundary derived from the delegation economics
 *     (`decompositionBoundary`), not a magic probability.
 *   - `decideExecution` / `authorizeExecution` are unchanged and still decide
 *     whether splitting is legal and worth it.
 *
 *  The question is asked only when its answer can change the action. With no
 *  spawn authority, fewer than two children allowed, children already
 *  created, an explicit split request, or economics that would not delegate
 *  even on a certain "yes", the rule decides and System-1 is never called.
 *
 *  On provider failure the answer is "do not split" unless the person asked for
 *  a split in so many words (spec §17). The regex verdict this replaced is
 *  deliberately *not* the fallback: a hidden second brain behind the provider
 *  is the thing this architecture forbids. */
import { assessDecomposition } from '../intelligence/decompose.js';
import type { IntelligenceBundle } from '../intelligence/coordinator.js';
import type { Authority } from '../schemas/node-contract.js';
import { compileHarnessRequest, type Fact } from './compiler.js';
import { decompositionBoundary, worthSplittingFrom } from './economic-mapping.js';
import { system1 as defaultSystem1, type JudgeOutcome, type System1 } from './guard.js';

export interface DecomposabilityInput {
  scope: string;
  goal: string;
  authority: Authority;
  existingChildren: number;
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
  const decomposition = assessDecomposition(input.goal);
  const signals: Record<string, number> = { ...decomposition.signals };
  const bundle = (worthSplitting: boolean): IntelligenceBundle => ({
    sufficientContext: true,
    complexity: decomposition.complexity,
    worthSplitting,
    signals,
  });

  const explicit = (signals.explicit_split_request ?? 0) > 0;
  const boundary = decompositionBoundary(decomposition.complexity);
  const gate = !input.authority.spawn_children ? 'no-spawn-authority'
    : input.authority.max_child_count < 2 ? 'no-fan-out-allowance'
    : input.existingChildren > 0 ? 'already-delegated'
    : explicit ? 'explicit-split-request'
    : !boundary ? 'economics-would-not-delegate'
    : undefined;
  if (gate) {
    signals[`system1_gate_${gate.replace(/-/g, '_')}`] = 1;
    // An explicit request is a fact about what the person wants, and it still
    // only reaches economics as "worth trying". Every other gate means no.
    return { bundle: bundle(gate === 'explicit-split-request'), gate };
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
    return { bundle: bundle(false), outcome, fallbackReason: outcome.failure?.reason ?? 'no judgment' };
  }
  signals.system1_p_decomposable = Number(p.toFixed(4));
  return { bundle: bundle(worthSplittingFrom(p, boundary!)), outcome };
}

/** Which generation of the optimizer produced a run.
 *
 *  Two generations in one database averaged together describe neither. That is
 *  already why `contextPolicyVersion` and `executionPolicyVersion` are recorded
 *  per dispatch — but those name the *weights*, and the economic architecture
 *  adds a second thing that can change underneath a comparison: the decision
 *  engine itself. A run where the utility model gained a term is not the same
 *  system as the run before it, even with identical weights.
 *
 *  So a policy version names three things together — the architecture, the
 *  policy generation, and the engine generation — and is immutable, because a
 *  version identifier that can be edited after the fact is a version identifier
 *  that will eventually be edited after the fact.
 *
 *  What it deliberately is **not** is a runtime mode. Versions accumulate
 *  without bound; product modes stay at exactly two, and the test below is what
 *  keeps that true when someone reaches for a third. */
import { runtimeMode, type RuntimeMode } from '../config/efficiency.js';

/** Bumped by hand when a weight in `policy.ts` changes. Recorded with every
 *  measured dispatch, so two policy generations in one database are
 *  distinguishable rather than averaged into an uninterpretable middle.
 *
 *  Defined here rather than beside the weights they describe, so that composing
 *  them with the architecture and the engine generation does not require the
 *  two modules to import each other. */
export const CONTEXT_POLICY_VERSION = 'ctx-1';
export const EXECUTION_POLICY_VERSION = 'exec-1';

/** Bumped by hand when the decision layer's *behaviour* changes: a new term in
 *  the utility model, a changed tie-break, a new action kind that can be
 *  chosen. Not bumped for a refactor that cannot change an outcome — a version
 *  that moves for reasons nobody can observe makes every comparison look
 *  incomparable. */
export const DECISION_ENGINE_VERSION = 'dec-1';

export interface PolicyVersion {
  /** Deterministic and composite. Two processes running the same code produce
   *  the same id, which is what makes it a join key rather than a label. */
  id: string;
  architecture: RuntimeMode;
  version: string;
  createdAt: string;
  decisionEngineVersion: string;
}

/** The version this process is running, as a frozen value.
 *
 *  `createdAt` is supplied rather than read from a clock: the identity of a
 *  policy generation is the code it names, and two processes started an hour
 *  apart on the same commit are running the same policy. A timestamp baked in
 *  at import would make them look different. */
export function policyVersion(input: {
  architecture?: RuntimeMode;
  contextVersion?: string;
  executionVersion?: string;
  decisionEngineVersion?: string;
  createdAt?: string;
} = {}): PolicyVersion {
  const architecture = input.architecture ?? runtimeMode();
  const context = input.contextVersion ?? CONTEXT_POLICY_VERSION;
  const execution = input.executionVersion ?? EXECUTION_POLICY_VERSION;
  const engine = input.decisionEngineVersion ?? DECISION_ENGINE_VERSION;
  const version = `${context}/${execution}`;

  return Object.freeze({
    id: `${architecture}:${version}:${engine}`,
    architecture,
    version,
    createdAt: input.createdAt ?? '',
    decisionEngineVersion: engine,
  });
}

/** Whether two runs are comparable at all.
 *
 *  Exists so a benchmark can *refuse* to average two generations rather than
 *  doing it silently. Two runs of different architectures are comparable — that
 *  is the whole point of the comparison — but two runs of different policy or
 *  engine generations are not, whichever arm they were in. */
export function comparable(a: PolicyVersion, b: PolicyVersion): boolean {
  return a.version === b.version && a.decisionEngineVersion === b.decisionEngineVersion;
}

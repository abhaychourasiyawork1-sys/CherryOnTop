/** Everything the control plane believes at the moment a dispatch starts,
 *  decided once.
 *
 *  The manager used to derive the same semantic facts several times over on one
 *  dispatch: what kind of task this is, how it decomposes, how much it needs
 *  verifying, which revision it runs against. That is two problems wearing one
 *  coat. The cheap one is cost — judging a goal twice pays twice for the same
 *  answer. The expensive one is *disagreement*: the context selector and the
 *  strategy gate reasoning from derivations taken microseconds apart, on inputs
 *  that shifted in between, produce a run nobody can reconstruct afterwards.
 *
 *  So this is a snapshot, not a brain. It combines answers the existing modules
 *  own — `judgeTask`, `taskEconomicsFor`, `contextPolicyFor`,
 *  `executionPolicyFor`, `contractFor` — and adds no scoring of its own. Every
 *  dependency is injected so the whole thing is unit-testable and so a test can
 *  prove each derivation happens exactly once.
 *
 *  Deterministic and total: no network, no Kubernetes, no model, no clock. */
import type { Authority } from '../schemas/node-contract.js';
import type { ToolGrant } from '../adapters/adapter.js';
import { scopeOf, type SecurityScope } from '../context/types.js';
import { judgeTask, type TaskVerdict } from '../intelligence/task-judge.js';
import { taskEconomicsFor } from '../efficiency/task-economics.js';
import { contextPolicyFor, executionPolicyFor, currentPolicyVersions } from '../efficiency/policy.js';
import { contractFor, type ValidationContract } from '../validation/contract.js';
import type { ContextPolicy, ExecutionPolicy, TaskEconomicsSignals } from '../efficiency/policy-types.js';

export interface DispatchPreparation {
  goal: string;
  taskClass: string;
  /** A stable fingerprint of *what shape of work this is*, built from the
   *  deterministic signals rather than from the goal's words. Two goals that
   *  read nothing alike but decompose identically share a shape, which is what
   *  makes it a usable learning key — raw goal text never repeats. */
  taskShape: string;
  complexity: 'low' | 'medium' | 'high';
  decompositionSignals: Record<string, number>;
  verificationNeed: number;
  /** The full economics read, carried rather than re-derived downstream. */
  economics: TaskEconomicsSignals;
  repository?: string;
  repositoryRevision?: string;
  authority: Authority;
  toolGrant: ToolGrant;
  securityScope: SecurityScope;
  contextPolicy: ContextPolicy;
  executionPolicy: ExecutionPolicy;
  validationContract: ValidationContract;
  policyVersions: ReturnType<typeof currentPolicyVersions>;
  /** The whole verdict, so a consumer that needs `worthPlanning` or `direct`
   *  reads it here instead of judging the goal a second time. */
  verdict: TaskVerdict;
}

export interface PrepareDispatchInput {
  goal: string;
  authority: Authority;
  toolGrant: ToolGrant;
  repository?: string;
  repositoryRevision?: string;
  /** Definition-of-done items a person named. They raise the validation floor
   *  and never lower it. */
  requiredChecks?: string[];
}

/** Everything the snapshot reads from the rest of the runtime. Injected so a
 *  test can count the calls, and so this module owns no imports it could be
 *  tempted to re-derive from. */
export interface PrepareDispatchDeps {
  judgeTask: typeof judgeTask;
  taskEconomicsFor: typeof taskEconomicsFor;
  contextPolicyFor: typeof contextPolicyFor;
  executionPolicyFor: typeof executionPolicyFor;
  currentPolicyVersions: typeof currentPolicyVersions;
  contractFor: typeof contractFor;
}

export const REAL_PREPARE_DEPS: PrepareDispatchDeps = {
  judgeTask, taskEconomicsFor, contextPolicyFor, executionPolicyFor, currentPolicyVersions, contractFor,
};

/** Buckets, not values. A fingerprint that moves whenever a float moves is a
 *  key that never matches twice, which is a learning table of one row each. */
function band(value: number): 'lo' | 'mid' | 'hi' {
  return value < 0.34 ? 'lo' : value < 0.67 ? 'mid' : 'hi';
}

export function taskShapeFingerprint(input: {
  taskClass: string;
  complexity: string;
  economics: Pick<TaskEconomicsSignals, 'complexityBand' | 'hasExplicitAnchors' | 'breadth' | 'verificationNeed' | 'readOnly'>;
  worthSplitting: boolean;
}): string {
  return [
    input.taskClass,
    input.complexity,
    input.economics.complexityBand,
    input.economics.hasExplicitAnchors ? 'anchored' : 'unanchored',
    `breadth-${band(input.economics.breadth)}`,
    `verify-${band(input.economics.verificationNeed)}`,
    input.economics.readOnly ? 'read-only' : 'writes',
    input.worthSplitting ? 'splittable' : 'unit',
  ].join('/');
}

/** Build it once, at the safe execution boundary, and pass references down.
 *
 *  The returned object is immutable by convention: construct here, read
 *  everywhere. A consumer that needs a value this holds must read it rather
 *  than derive it again — that is the entire contract. */
export function prepareDispatch(
  input: PrepareDispatchInput,
  deps: PrepareDispatchDeps = REAL_PREPARE_DEPS,
): DispatchPreparation {
  const verdict = deps.judgeTask(input.goal);
  // The verdict carries the decomposition it already computed, so nothing here
  // asks for it a second time.
  const economics = deps.taskEconomicsFor(input.goal, verdict);

  return Object.freeze({
    goal: input.goal,
    taskClass: verdict.taskClass,
    taskShape: taskShapeFingerprint({
      taskClass: verdict.taskClass,
      complexity: verdict.decomposition.complexity,
      economics,
      worthSplitting: verdict.decomposition.worthSplitting,
    }),
    complexity: verdict.decomposition.complexity,
    decompositionSignals: verdict.decomposition.signals,
    verificationNeed: economics.verificationNeed,
    economics,
    ...(input.repository === undefined ? {} : { repository: input.repository }),
    ...(input.repositoryRevision === undefined ? {} : { repositoryRevision: input.repositoryRevision }),
    authority: input.authority,
    toolGrant: input.toolGrant,
    securityScope: scopeOf(input.toolGrant.allowedTools, input.toolGrant.readOnly),
    contextPolicy: deps.contextPolicyFor(economics),
    executionPolicy: deps.executionPolicyFor(economics),
    validationContract: deps.contractFor({
      verificationNeed: economics.verificationNeed,
      requiredChecks: input.requiredChecks ?? [],
    }),
    policyVersions: deps.currentPolicyVersions(),
    verdict,
  });
}

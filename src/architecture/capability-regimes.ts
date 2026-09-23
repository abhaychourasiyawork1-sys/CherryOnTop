/** Which capabilities must stay reachable, proved against the real modules.
 *
 *  The failure this exists to catch is not a bug — it is an optimization that
 *  quietly makes a capability unreachable and is then read as evidence the
 *  capability was not needed. A benchmark that never delegated says nothing
 *  about whether delegation still works; the previous run was interpreted as if
 *  it did.
 *
 *  So each regime here builds deterministic inputs, hands them to the module
 *  that actually owns the decision, and reports whether the intended capability
 *  survived into the answer. Three separate facts, deliberately never collapsed:
 *
 *   - **reachable** — the runtime can still produce this action. Proved here.
 *   - **exercised** — a run actually took it. Proved by a benchmark.
 *   - **measured** — taking it made a difference. Proved by a paired benchmark.
 *
 *  Nothing in this file changes behaviour, and nothing in the runtime imports
 *  it except the benchmark manifest. Deterministic and total: no clock, no I/O,
 *  no model. */
import type { Authority } from '../schemas/node-contract.js';
import { decideExecutionPath } from '../decision/engine.js';
import { judgeTask } from '../intelligence/task-judge.js';
import { taskEconomicsFor } from '../efficiency/task-economics.js';
import { planWorkstreams, schedulingCandidates, dependentsOf, type WorkstreamNode } from '../execution/workstreams.js';
import { evaluateRecovery, recoveryCandidate } from '../recovery/engine.js';
import { validate, type ValidationEvidence } from '../validation/engine.js';
import { contractFor } from '../validation/contract.js';
import { novelState } from './fixtures.js';

export const CAPABILITY_REGIMES = [
  'MANAGED_SIMPLE',
  'MANAGED_NORMAL',
  'MANAGED_RISKY',
  'SERIAL_DELEGATED',
  'PARALLEL_DELEGATED',
  'DELEGATED_PARTIAL_FAILURE',
  'RECOVERY_AFTER_VALIDATION_FAILURE',
  'INVESTIGATION_READ_ONLY',
  'EXPLICIT_REQUIRED_CHECK',
  'V3_FRESH_VERIFICATION',
] as const;

export type CapabilityRegime = (typeof CAPABILITY_REGIMES)[number];

export interface RegimeScenario {
  regime: CapabilityRegime;
  /** The existing capability/action vocabulary this regime keeps alive. No new
   *  taxonomy: these are strings the runtime already uses. */
  capability: string;
  /** Whether the owning module still produces the intended action. */
  reachable: boolean;
  /** What the module actually answered, so a failure names the regression
   *  rather than merely reporting one. */
  observed: string;
}

const WIDE_AUTHORITY: Authority = {
  tools: ['read', 'edit', 'bash'], spawn_children: true, max_child_count: 3, budget_usd: 5,
};
const NARROW_AUTHORITY: Authority = {
  tools: ['read', 'edit'], spawn_children: false, max_child_count: 0, budget_usd: 5,
};

const DISPATCH = { tokens: 100_000, latencyMs: 120_000, costUsd: 0.5 };

function evidence(over: Partial<ValidationEvidence> = {}): ValidationEvidence {
  return { claimedSuccess: true, artifactIds: [], observedChecks: [], requiredChecks: [], ...over };
}

function twoStreams(dependent: boolean): WorkstreamNode[] {
  const base = (id: string, writePaths: string[]): WorkstreamNode => ({
    id, writePaths,
    inputDependencies: [], informationDependencies: [], outputDependencies: [], validationDependencies: [],
  });
  const a = base('a', ['src/a.ts']);
  const b = base('b', ['src/b.ts']);
  return dependent ? [a, { ...b, inputDependencies: ['a'] }] : [a, b];
}

/** One regime, built from deterministic inputs and answered by the real module. */
export function buildScenario(regime: CapabilityRegime): RegimeScenario {
  switch (regime) {
    case 'MANAGED_SIMPLE': {
      const goal = 'Fix the typo in README.md';
      const verdict = judgeTask(goal);
      const chosen = decideExecutionPath({
        goal, authority: WIDE_AUTHORITY, spentUsd: 0, dispatch: DISPATCH,
        complexity: verdict.decomposition.complexity,
        worthSplitting: verdict.decomposition.worthSplitting,
        signals: verdict.decomposition.signals,
      }).chosen;
      return { regime, capability: 'RUN_MODEL', reachable: chosen === 'RUN_MODEL', observed: chosen };
    }

    case 'MANAGED_NORMAL': {
      const goal = 'Add retry handling to the session refresh path in src/auth/session.ts';
      const chosen = decideExecutionPath({
        goal, authority: NARROW_AUTHORITY, spentUsd: 0, dispatch: DISPATCH, complexity: 'medium',
      }).chosen;
      return { regime, capability: 'RUN_MODEL', reachable: chosen === 'RUN_MODEL', observed: chosen };
    }

    case 'MANAGED_RISKY': {
      // A task judged to need proving must still be able to demand more than
      // "a file changed" — an artifact alone must not clear its floor.
      const contract = contractFor({ verificationNeed: taskEconomicsFor('Fix the failing parser test in src/parse.ts').verificationNeed });
      const artifactOnly = validate({ evidence: evidence({ artifactIds: ['artifact-1'] }), contract });
      return {
        regime, capability: 'validation.escalates-above-V1',
        reachable: !artifactOnly.passed && artifactOnly.level === 'V1',
        observed: `${artifactOnly.level}:${artifactOnly.passed}`,
      };
    }

    case 'SERIAL_DELEGATED': {
      const plan = planWorkstreams({ nodes: twoStreams(true) });
      const serial = plan.parallelGroups.length === 2 && plan.parallelGroups.every((g) => g.length === 1);
      return {
        regime, capability: 'execution.workstreams',
        reachable: serial, observed: JSON.stringify(plan.parallelGroups),
      };
    }

    case 'PARALLEL_DELEGATED': {
      const plan = planWorkstreams({ nodes: twoStreams(false) });
      const candidates = schedulingCandidates({
        plan, state: novelState(), contextTokensPerBranch: 4_000, branchLatencyMs: 120_000,
      });
      const kinds = candidates.map((c) => c.kind);
      return {
        regime, capability: 'execution.workstreams',
        // Both options, always: a scheduler that only offers the fast one has
        // not made a decision.
        reachable: kinds.includes('parallelize') && kinds.includes('serialize'),
        observed: kinds.join(','),
      };
    }

    case 'DELEGATED_PARTIAL_FAILURE': {
      // An independent sibling must survive another branch failing.
      const nodes = twoStreams(false);
      const lost = dependentsOf(nodes, 'a');
      return {
        regime, capability: 'execution.workstreams.partial-failure',
        reachable: lost.length === 0, observed: `lost=[${lost.join(',')}]`,
      };
    }

    case 'RECOVERY_AFTER_VALIDATION_FAILURE': {
      const state = novelState({
        over: {
          evidence: [{ id: 'observed:src/a.ts', kind: 'fact', source: 'read', confidence: 0.9, tokenCost: 4_000 }],
          // Most of the budget spent and most of the work done: the case where
          // a retry has the most to save and is therefore worth making.
          resources: {
            totalTokenBudget: 100_000, consumedTokens: 70_000, remainingTokens: 30_000,
            optimizationTokens: 2_000, optimizationConsumedTokens: 0, recoveryReserve: 5_000,
          },
          trajectory: {
            progress: 0.7, informationGain: 0.5, explorationPressure: 0.3,
            failurePressure: 0.4, stateSimilarity: 0.3, orchestrationConfidence: 0.8,
          },
        },
      });
      const evaluation = evaluateRecovery({ state, failureSignature: 'validation_failed' });
      const candidate = recoveryCandidate(evaluation, state);
      return {
        regime, capability: candidate.capability,
        reachable: evaluation.justified && candidate.kind === 'recover',
        observed: evaluation.reasonCodes.join(','),
      };
    }

    case 'INVESTIGATION_READ_ONLY': {
      const signals = taskEconomicsFor('Investigate why the scheduler drops the second retry');
      return {
        regime, capability: 'task.read-only',
        reachable: signals.readOnly && signals.expectedModificationScope === 0,
        observed: `readOnly=${signals.readOnly} scope=${signals.expectedModificationScope}`,
      };
    }

    case 'EXPLICIT_REQUIRED_CHECK': {
      // A named check nobody closed outranks every green thing beside it.
      const result = validate({
        evidence: evidence({
          artifactIds: ['artifact-1'],
          observedChecks: [{ id: 'observed:npm test', command: 'npm test', passed: true }],
          requiredChecks: [{ id: 'dod-1', text: 'changelog updated', met: false }],
        }),
        contract: contractFor({ verificationNeed: 0.8, requiredChecks: ['changelog updated'] }),
      });
      return {
        regime, capability: 'validation.required-checks',
        reachable: !result.passed && result.reasonCodes.some((code) => code.startsWith('required_checks_unmet')),
        observed: result.reasonCodes.join(','),
      };
    }

    case 'V3_FRESH_VERIFICATION': {
      const result = validate({
        evidence: evidence({ artifactIds: ['artifact-1'] }),
        contract: { qualityFloor: 0.95, requiredChecks: [], allowedUncertainty: 0.05 },
        verify: () => ({ passed: true, evidenceId: 'fresh:npm test', tokens: 2_000, latencyMs: 45_000 }),
      });
      return {
        regime, capability: 'validation.fresh-verification',
        reachable: result.level === 'V3' && result.passed,
        observed: `${result.level}:${result.passed}`,
      };
    }
  }
}

export function buildAllScenarios(): RegimeScenario[] {
  return CAPABILITY_REGIMES.map(buildScenario);
}

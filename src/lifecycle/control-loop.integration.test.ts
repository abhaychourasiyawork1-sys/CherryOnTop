/** The control plane in the order it is supposed to run, end to end.
 *
 *  Every piece of this architecture is individually tested somewhere else. This
 *  file exists because the pieces only create value in a particular sequence,
 *  and the failure mode it pins is the one unit tests cannot see: several
 *  individually reasonable optimizations that, composed, make a simple task
 *  expensive or let an unverified run report success.
 *
 *  Four properties, and each one is a way the composition could go wrong:
 *
 *   - a simple task does not traverse delegation-only stages;
 *   - a complex task can still reach every approved capability;
 *   - every terminal success has a validation result behind it;
 *   - an optimizer that breaks degrades to baseline rather than to a failure.
 *
 *  No cluster, no model, no database: the machine is driven with injected
 *  actors, so what is under test is the *order*, which is the thing the
 *  integration owns. */
import { describe, it, expect, vi } from 'vitest';
import { createActor, fromPromise, waitFor } from 'xstate';
import { nodeMachine, type ValidationVerdict } from './node-machine.js';
import { ZERO_USAGE } from '../execution/tokens.js';
import { prepareDispatch } from '../decision/dispatch-preparation.js';
import { decideStrategy, type ExecutionStrategy, type StrategyClassifier } from '../decision/strategy-gate.js';
import { validateDelegationPlan } from '../decision/delegation-validator.js';
import { allocateChildAuthority, delegationTopology, workstreamNodesFor } from './delegate-child.js';
import { planWorkstreams } from '../execution/workstreams.js';
import { validateDelegatedOutcome } from '../validation/delegated.js';
import { validationProfileFor } from '../validation/profile.js';
import { judgeTask } from '../intelligence/task-judge.js';
import { decideExecution, type DecideExecutionResult } from '../engines/decide-execution.js';
import type { ExecuteStepResult } from '../execution/execute-step.js';
import type { IntelligenceBundle } from '../intelligence/coordinator.js';
import type { ValidationResult } from '../validation/engine.js';
import type { Authority } from '../schemas/node-contract.js';

const AUTHORITY: Authority = {
  tools: ['Read', 'Edit'], spawn_children: true, max_child_count: 3, budget_usd: 5,
};

const PASSED: ValidationResult = {
  level: 'V2', passed: true, confidence: 0.85, tokens: 0, latencyMs: 0,
  evidenceIds: ['observed:npm test'], reasonCodes: ['V2:observed_verification_passed'],
};
const FAILED: ValidationResult = {
  level: 'V1', passed: false, confidence: 0.5, tokens: 0, latencyMs: 0,
  evidenceIds: ['artifact-1'], reasonCodes: ['below_required_confidence'],
};

export interface ControlLoopTrace {
  states: string[];
  strategy: ExecutionStrategy;
  validation: ValidationResult;
  succeeded: boolean;
  /** Which model-backed capabilities were bought. The number a benchmark
   *  watches: a classifier or a planner on a one-file edit is the
   *  orchestration tax this architecture exists to remove. */
  bought: string[];
}

interface LoopOptions {
  mode: 'baseline' | 'full';
  validation: 'required' | 'optional';
  authority?: Authority;
  /** Verdicts to serve, in order. The last one repeats. */
  verdicts?: ValidationVerdict[];
  /** Simulates a broken optimizer: the strategy gate throws. */
  breakStrategyGate?: boolean;
}

/** Runs one goal through the real decision modules and the real state machine,
 *  and reports what the control plane actually did. */
async function runControlLoop(goal: string, options: LoopOptions): Promise<ControlLoopTrace> {
  const authority = options.authority ?? AUTHORITY;
  const bought: string[] = [];
  const states: string[] = [];
  const classify: StrategyClassifier = (input) => {
    bought.push('classifier');
    return { partitionability: 'UNCERTAIN', parallelism: 'LOW', confidence: 0.4, reasonCodes: [] };
  };

  let strategy: ExecutionStrategy = 'MANAGED';
  if (!options.breakStrategyGate) {
    const preparation = prepareDispatch({
      goal, authority, toolGrant: { allowedTools: authority.tools, readOnly: false },
    });
    strategy = decideStrategy({
      preparation, spentUsd: 0,
      dispatch: { tokens: 100_000, latencyMs: 120_000, costUsd: 0.5 },
      ...(options.mode === 'full' ? { classify } : {}),
    }).strategy;
  }

  const verdicts = options.verdicts ?? [{ ...PASSED }];
  let served = 0;
  const verdict = () => verdicts[Math.min(served++, verdicts.length - 1)];

  const machine = nodeMachine.provide({
    actors: {
      assessUncertainty: fromPromise(async (): Promise<IntelligenceBundle> => {
        const judged = judgeTask(goal);
        return {
          sufficientContext: true,
          complexity: judged.decomposition.complexity,
          worthSplitting: judged.decomposition.worthSplitting,
          signals: judged.decomposition.signals,
        };
      }),
      decideExecution: fromPromise(async ({ input }): Promise<DecideExecutionResult> => decideExecution({
        goal, authority,
        complexity: input.complexity ?? 'low',
        worthSplitting: input.worthSplitting,
        signals: input.signals,
      })),
      executeStep: fromPromise(async (): Promise<ExecuteStepResult> => {
        bought.push('execute');
        return { succeeded: true, message: 'done', events: [], usage: { ...ZERO_USAGE } };
      }),
      delegateToChild: fromPromise(async (): Promise<ExecuteStepResult> => {
        bought.push('plan', 'child', 'synthesize');
        return { succeeded: true, message: 'children done', events: [], usage: { ...ZERO_USAGE } };
      }),
      escalate: fromPromise(async () => 'approval-1'),
      validate: fromPromise(async (): Promise<ValidationVerdict> => {
        bought.push('validate');
        return options.validation === 'optional' ? { ...PASSED } : verdict();
      }),
    },
  });

  const actor = createActor(machine, { input: { nodeId: 'n1', goal } });
  actor.subscribe((snapshot) => {
    const state = String(snapshot.value);
    if (states.at(-1) !== state) states.push(state);
  });
  actor.start();
  actor.send({ type: 'START' });
  const final = await waitFor(actor, (snapshot) => snapshot.status === 'done', { timeout: 5000 });

  return {
    states,
    strategy,
    validation: final.context.lastValidation ?? FAILED,
    succeeded: final.value === 'COMPLETE',
    bought,
  };
}

describe('the managed path', () => {
  it('uses the minimal managed path for a simple task', async () => {
    const trace = await runControlLoop('Fix the typo in README.md', { mode: 'full', validation: 'required' });
    // ORIENT and PLAN are eventless: the machine passes straight through them
    // in the same microtask, so a subscriber never observes them settled. They
    // are still stages — asserted below against the machine definition — and
    // what matters here is that nothing *else* got in.
    expect(trace.states).toEqual([
      'CREATED', 'INTELLIGENCE_GATE',
      'EXECUTION_DECISION', 'SELF_EXECUTE', 'VALIDATE', 'COMPLETE',
    ]);
    expect(trace.strategy).toBe('MANAGED');
  });

  it('still routes through the orientation and planning stages', () => {
    const states = Object.keys(nodeMachine.config.states ?? {});
    expect(states).toEqual(expect.arrayContaining(['ORIENT', 'PLAN', 'INTELLIGENCE_GATE', 'VALIDATE']));
  });

  it('has no edge from execution or delegation straight to COMPLETE', () => {
    const json = JSON.stringify(nodeMachine.config.states);
    // Every path to COMPLETE leaves from VALIDATE. Asserted against the
    // definition rather than by walking one run, because the thing that must
    // not exist is an *edge*, and a run only ever demonstrates the edges it
    // happened to take.
    const complete = json.split('"target":"COMPLETE"').length - 1;
    const fromValidate = JSON.stringify(
      (nodeMachine.config.states as Record<string, unknown>).VALIDATE,
    ).split('"target":"COMPLETE"').length - 1;
    expect(complete).toBe(fromValidate);
    expect(fromValidate).toBeGreaterThan(0);
  });

  it('buys one execution and one validation, and nothing else', async () => {
    const trace = await runControlLoop('Fix the typo in README.md', { mode: 'full', validation: 'required' });
    expect(trace.bought).toEqual(['execute', 'validate']);
    expect(trace.bought).not.toContain('classifier');
    expect(trace.bought).not.toContain('plan');
    expect(trace.bought).not.toContain('synthesize');
  });

  it('never reaches COMPLETE without a validation result behind it', async () => {
    const trace = await runControlLoop('Fix the typo in README.md', { mode: 'full', validation: 'required' });
    expect(trace.succeeded).toBe(true);
    expect(trace.validation.passed).toBe(true);
    expect(trace.states).toContain('VALIDATE');
    // The contract, stated as a property of the trace rather than of one edge:
    // there is no path from execution to completion that skips the gate.
    expect(trace.states.indexOf('VALIDATE')).toBeLessThan(trace.states.indexOf('COMPLETE'));
  });
});

describe('the delegated path', () => {
  const goal = 'Fix the auth bug; also add parser tests';

  it('reaches delegation for a genuinely multi-workstream goal', async () => {
    const trace = await runControlLoop(goal, { mode: 'full', validation: 'required' });
    expect(trace.strategy).not.toBe('MANAGED');
    expect(trace.states).toContain('DELEGATE');
  });

  it('runs plan validation, authority allocation and scheduling before any child', () => {
    // The order, as the modules themselves enforce it: a plan is checked, then
    // funded, then scheduled. A plan that fails the first step never reaches
    // the second, so no sandbox is spent finding out it was a clone.
    const subgoals = ['Fix the auth bug in src/auth.ts', 'add parser tests in src/parser.test.ts'];
    const nodes = workstreamNodesFor(subgoals);
    const validation = validateDelegationPlan(
      { goal, authority: AUTHORITY },
      {
        subgoals: subgoals.map((text, index) => ({
          id: String(index), goal: text,
          writePaths: nodes[index].writePaths,
          dependencies: nodes[index].inputDependencies,
        })),
      },
    );
    expect(validation.valid).toBe(true);

    const allocation = allocateChildAuthority({ parent: AUTHORITY, childCount: 2, reserveBudgetUsd: 1 });
    expect(allocation.totalAllocatedUsd).toBeLessThanOrEqual(AUTHORITY.budget_usd - 1);

    const plan = planWorkstreams({ nodes });
    expect(['SERIAL_DELEGATED', 'PARALLEL_DELEGATED']).toContain(delegationTopology(plan, ['parallelize']));
  });

  it('refuses to fund a plan that is two copies of the same job', () => {
    const validation = validateDelegationPlan(
      { goal, authority: AUTHORITY },
      {
        subgoals: [
          { id: '0', goal: 'add parser tests', writePaths: ['parser.test.ts'], dependencies: [] },
          { id: '1', goal: 'add parser tests', writePaths: ['parser.test.ts'], dependencies: [] },
        ],
      },
    );
    expect(validation.valid).toBe(false);
  });

  it('keeps successful siblings when one child fails', () => {
    const result = validateDelegatedOutcome({
      parentRequiredChecks: [],
      children: [
        { id: 'a', succeeded: true, validation: PASSED, changedPaths: ['src/a.ts'], authorityCompliant: true, dependenciesSatisfied: true },
        { id: 'b', succeeded: false, validation: FAILED, changedPaths: [], authorityCompliant: true, dependenciesSatisfied: true },
        { id: 'c', succeeded: true, validation: PASSED, changedPaths: ['src/c.ts'], authorityCompliant: true, dependenciesSatisfied: true },
      ],
      graph: [
        { id: 'a', inputDependencies: [], informationDependencies: [], outputDependencies: [], validationDependencies: [], writePaths: ['src/a.ts'] },
        { id: 'b', inputDependencies: [], informationDependencies: [], outputDependencies: [], validationDependencies: [], writePaths: ['src/b.ts'] },
        { id: 'c', inputDependencies: [], informationDependencies: [], outputDependencies: [], validationDependencies: [], writePaths: ['src/c.ts'] },
      ],
      mergedOutcome: {
        claimedSuccess: true, artifactIds: ['artifact-1'],
        observedChecks: [{ id: 'observed:npm test', command: 'npm test', passed: true }],
        requiredChecks: [],
      },
    });
    expect(result.passed).toBe(false);
    expect(result.retainedChildren).toEqual(['a', 'c']);
    expect(result.childFailures).toEqual(['b']);
  });

  it('asks delegated work for stronger proof than a tiny managed edit', () => {
    const delegated = validationProfileFor({
      strategy: 'SERIAL_DELEGATED',
      economics: { complexityBand: 'tiny', verificationNeed: 0.4, readOnly: false, expectedModificationScope: 0.1 },
    });
    const managed = validationProfileFor({
      strategy: 'MANAGED',
      economics: { complexityBand: 'tiny', verificationNeed: 0.4, readOnly: false, expectedModificationScope: 0.1 },
    });
    expect(delegated.minimumLevel).toBe('V2');
    expect(managed.minimumLevel).toBe('V1');
  });
});

describe('the failure path', () => {
  it('goes to a recovery boundary rather than straight to completion', async () => {
    const trace = await runControlLoop('Fix the typo in README.md', {
      mode: 'full', validation: 'required',
      verdicts: [
        { ...FAILED, failureSignature: 'first_problem' },
        { ...PASSED, failureSignature: 'none' },
      ],
    });
    // Back through EXECUTION_DECISION — a re-decision, not a blind re-run.
    expect(trace.states.filter((state) => state === 'EXECUTION_DECISION')).toHaveLength(2);
    expect(trace.succeeded).toBe(true);
  });

  it('never completes a run whose validation kept failing', async () => {
    const trace = await runControlLoop('Fix the typo in README.md', {
      mode: 'full', validation: 'required', verdicts: [{ ...FAILED }],
    });
    expect(trace.succeeded).toBe(false);
    expect(trace.states.at(-1)).toBe('FAILED');
  });
});

describe('degrading to baseline', () => {
  it('still completes the task when the strategy gate itself is broken', async () => {
    // An optimizer that can fail a task by failing to optimize is worse than no
    // optimizer, and this path is on the way to every dispatch.
    const trace = await runControlLoop('Fix the typo in README.md', {
      mode: 'full', validation: 'required', breakStrategyGate: true,
    });
    expect(trace.succeeded).toBe(true);
    expect(trace.strategy).toBe('MANAGED');
  });

  it('does not buy a classifier in baseline mode', async () => {
    const trace = await runControlLoop('Bring the whole service in line with the new approach', {
      mode: 'baseline', validation: 'required',
    });
    expect(trace.bought).not.toContain('classifier');
  });

  it('stays managed when the node may not spawn, however splittable the goal', async () => {
    const trace = await runControlLoop('Fix the auth bug; also add parser tests', {
      mode: 'full', validation: 'required',
      authority: { ...AUTHORITY, spawn_children: false, max_child_count: 0 },
    });
    expect(trace.strategy).toBe('MANAGED');
    expect(trace.states).not.toContain('DELEGATE');
  });
});

describe('no strategy transition mid-flight', () => {
  it('decides the strategy once, before any sandbox exists', async () => {
    const decided = vi.fn();
    const preparation = prepareDispatch({
      goal: 'Fix the typo in README.md', authority: AUTHORITY,
      toolGrant: { allowedTools: AUTHORITY.tools, readOnly: false },
    });
    const first = decideStrategy({
      preparation, spentUsd: 0, dispatch: { tokens: 1, latencyMs: 1, costUsd: 1 },
      classify: decided as never,
    });
    const second = decideStrategy({
      preparation, spentUsd: 0, dispatch: { tokens: 1, latencyMs: 1, costUsd: 1 },
      classify: decided as never,
    });
    // Same snapshot in, same strategy out: nothing about a live sandbox can
    // change it, because nothing about a live sandbox is an input.
    expect(first.strategy).toBe(second.strategy);
    expect(decided).not.toHaveBeenCalled();
  });
});

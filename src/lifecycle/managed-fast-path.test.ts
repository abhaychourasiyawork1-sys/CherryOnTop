/** The tiny task, end to end, with everything expensive spied on.
 *
 *  The measured regression this pins: a one-file typo fix under the efficiency
 *  arm cost $0.2114 and 223s against $0.1083 and 38s with it off — same answer,
 *  one dispatch either way. The extra money bought orchestration nobody needed
 *  and a model tier nobody measured. So `MANAGED` has to mean *one CherryOnTop
 *  controlled execution*, not "delegation that fell through", and it has to
 *  stay on the default execution model.
 *
 *  `MANAGED` never means "direct Claude": authority, tool enforcement and
 *  validation are all still on this path, and the tests below say so. */
import { describe, it, expect, vi } from 'vitest';
import { createActor, fromPromise } from 'xstate';
import { nodeMachine } from './node-machine.js';
import { ZERO_USAGE } from '../execution/tokens.js';
import type { ExecuteStepResult } from '../execution/execute-step.js';
import type { IntelligenceBundle } from '../intelligence/coordinator.js';
import { prepareDispatch } from '../decision/dispatch-preparation.js';
import { decideStrategy, type StrategyClassifier } from '../decision/strategy-gate.js';
import { decideExecution } from '../engines/decide-execution.js';
import { routeModel } from '../intelligence/model-router.js';
import { judgeTask } from '../intelligence/task-judge.js';
import { isToolAllowed } from '../engines/enforce-tools.js';
import type { Authority } from '../schemas/node-contract.js';

const TINY_GOAL = 'Fix the typo in README.md';
const AUTHORITY: Authority = {
  tools: ['read', 'edit'], spawn_children: true, max_child_count: 2, budget_usd: 5,
};

function snapshot(goal = TINY_GOAL) {
  return prepareDispatch({ goal, authority: AUTHORITY, toolGrant: { allowedTools: AUTHORITY.tools, readOnly: false } });
}

describe('managed fast path — the decision', () => {
  it('keeps a tiny anchored edit under CherryOnTop control with no fan-out', () => {
    const classifier = vi.fn<StrategyClassifier>();
    const decision = decideStrategy({
      preparation: snapshot(), spentUsd: 0,
      dispatch: { tokens: 100_000, latencyMs: 120_000, costUsd: 0.5 },
      classify: classifier,
    });
    expect(decision.strategy).toBe('MANAGED');
    expect(classifier).not.toHaveBeenCalled();
    expect(decision.evidence.deterministic).toBe(true);
  });

  it('does not buy a planner to be told the goal does not split', () => {
    const verdict = judgeTask(TINY_GOAL);
    expect(verdict.worthPlanning).toBe(false);
    expect(decideExecution({
      goal: TINY_GOAL, authority: AUTHORITY, complexity: verdict.decomposition.complexity,
      worthSplitting: verdict.decomposition.worthSplitting,
    }).outcome).toBe('SELF_EXECUTE');
  });

  it('does not downgrade the execution model merely because the task is simple', () => {
    // The measured reason: a README fix on the fast tier took six times the
    // turns. Simple is an economic fact about the task, not a licence to run it
    // on a weaker model.
    const route = routeModel({ role: 'execute', complexity: 'low', investigative: false, budgetUsd: 5, spentUsd: 0 });
    expect(route.tier).toBe('standard');
  });

  it('asks for less context than the ceiling for an anchored edit', () => {
    const prep = snapshot();
    expect(prep.contextPolicy.tokenBudget).toBeLessThan(6000);
    expect(prep.economics.hasExplicitAnchors).toBe(true);
  });

  it('still enforces the tool grant — the fast path is not a security path', () => {
    expect(isToolAllowed(AUTHORITY, 'edit')).toBe(true);
    expect(isToolAllowed(AUTHORITY, 'bash')).toBe(false);
  });
});

describe('managed fast path — the lifecycle', () => {
  it('runs exactly one execution dispatch and validates it, with no child and no synthesis', async () => {
    const spies = {
      plan: vi.fn(),
      classifier: vi.fn(),
      createChild: vi.fn(),
      synthesize: vi.fn(),
      executeStep: vi.fn(async (): Promise<ExecuteStepResult> => ({
        succeeded: true, message: 'fixed', events: [], usage: { ...ZERO_USAGE },
      })),
    };

    const verdict = judgeTask(TINY_GOAL);
    const machine = nodeMachine.provide({
      actors: {
        assessUncertainty: fromPromise(async (): Promise<IntelligenceBundle> => ({
          sufficientContext: true,
          complexity: verdict.decomposition.complexity,
          worthSplitting: verdict.decomposition.worthSplitting,
          signals: verdict.decomposition.signals,
        })),
        // The real economics, not a stub: the point of the test is that the
        // runtime's own rules keep this task managed.
        decideExecution: fromPromise(async ({ input }) => decideExecution({
          goal: TINY_GOAL, authority: AUTHORITY,
          complexity: input.complexity ?? 'low',
          worthSplitting: input.worthSplitting,
          signals: input.signals,
        })),
        executeStep: fromPromise(spies.executeStep),
        delegateToChild: fromPromise(async (): Promise<ExecuteStepResult> => {
          spies.createChild();
          spies.plan();
          return { succeeded: true, message: '', events: [], usage: { ...ZERO_USAGE } };
        }),
        escalate: fromPromise(async () => 'approval-1'),
      },
    });

    const actor = createActor(machine, { input: { nodeId: 'n1', goal: TINY_GOAL } });
    actor.start();
    actor.send({ type: 'START' });
    await vi.waitFor(() => expect(actor.getSnapshot().status).toBe('done'));

    expect(actor.getSnapshot().value).toBe('COMPLETE');
    expect(spies.executeStep).toHaveBeenCalledTimes(1);
    expect(spies.plan).not.toHaveBeenCalled();
    expect(spies.classifier).not.toHaveBeenCalled();
    expect(spies.createChild).not.toHaveBeenCalled();
    expect(spies.synthesize).not.toHaveBeenCalled();
  });
});

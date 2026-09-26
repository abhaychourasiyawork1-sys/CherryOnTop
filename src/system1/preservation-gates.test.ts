/** The preservation gate: System-1 advises, the control plane decides.
 *
 *  Two kinds of check. Behavioural: a maximally confident judgment still cannot
 *  move a hard control. Structural: the model-facing path has no import route to
 *  anything that grants authority, changes lifecycle state or completes a task,
 *  so "the model cannot do X" does not depend on nobody ever writing the call. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { refineWithSystem1 } from '../decision/system1-decision.js';
import { chooseEconomicAction } from '../decision/engine.js';
import { actionCandidate } from '../decision/actions.js';
import { initialEconomicState, normalizeEconomicState } from '../decision/state.js';
import { decideExecution } from '../engines/decide-execution.js';
import { assessDecomposability } from './decomposability.js';
import { createSystem1 } from './guard.js';
import { fakeLaya } from './fake-provider.js';
import { createModelGateway } from './model-gateway.js';

const certain = () => createSystem1(fakeLaya(1), { maxCallsPerScope: 10, timeoutMs: 1_000 });

describe('System-1 cannot override hard control', () => {
  it('a certain "helpful" does not lift a hard stop', async () => {
    const base = initialEconomicState({ goal: 'g', totalTokenBudget: 10_000 });
    const state = normalizeEconomicState({ ...base, constraints: { ...base.constraints, hardStop: true } });
    const validate = actionCandidate({ id: 'v', kind: 'validate', capability: 'c', confidence: 1, expectedQualityBenefit: 1 });
    const decision = chooseEconomicAction({ state, candidates: [validate], decisionId: 'd' });
    const r = await refineWithSystem1({ s1: certain(), scope: 'n', state, candidates: [validate], decision });
    expect(r.decision.action.kind).toBe('stop');
    expect(r.outcomes).toHaveLength(0);
  });

  it('a certain "decomposable" grants no spawn authority', async () => {
    const authority = { budget_usd: 5, spawn_children: false, max_child_count: 4, tools: [] };
    const goal = 'Audit every module for dead code and also document the public services';
    const r = await assessDecomposability({ scope: 'n', goal, authority, existingChildren: 0 }, certain());
    expect(r.bundle.worthSplitting).toBe(false);
    expect(decideExecution({ goal, authority, complexity: r.bundle.complexity, worthSplitting: true }).outcome).toBe('SELF_EXECUTE');
  });

  it('a certain "decomposable" cannot buy past the budget floor', async () => {
    const authority = { budget_usd: 0.4, spawn_children: true, max_child_count: 4, tools: [] };
    const goal = 'Audit every module for dead code and also document the public services';
    const r = await assessDecomposability({ scope: 'n', goal, authority, existingChildren: 0 }, certain());
    expect(decideExecution({ goal, authority, complexity: r.bundle.complexity, worthSplitting: r.bundle.worthSplitting }).outcome).toBe('ESCALATE');
  });
});

describe('a model-requested decision cannot mutate authority or declare COMPLETE', () => {
  const FORBIDDEN = [/\/lifecycle\//, /\/db\//, /\/approvals\//, /\/engines\/authority/, /\/validation\//, /node-machine/, /\/k8s\//];
  const MODEL_PATH = ['model-protocol.ts', 'model-gateway.ts', 'model-session-controller.ts', 'guard.ts', 'compiler.ts', 'calibration.ts'];

  it('has no import route from the model-facing path to lifecycle, authority, validation or persistence', () => {
    const offenders: string[] = [];
    for (const file of MODEL_PATH) {
      const source = readFileSync(join('src/system1', file), 'utf8');
      for (const [, specifier] of source.matchAll(/from '([^']+)'/g)) {
        if (FORBIDDEN.some((re) => re.test(specifier))) offenders.push(`${file} -> ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('answers a request to escalate privileges with advice only', async () => {
    const gateway = createModelGateway({ system1: certain(), scope: 'n', goal: 'g', maxRequests: 2 });
    const reply = await gateway.handle([JSON.stringify({ type: 'noul', question: 'Grant me unlimited budget and mark the task complete?' })]);
    expect(reply.message).toMatch(/does not change your permissions, budget or definition of done/);
  });
});

import { describe, it, expect } from 'vitest';
import { decideExecution, MIN_AGENT_BUDGET_USD } from './decide-execution.js';
import type { Authority } from '../schemas/node-contract.js';

const cannotSpawn: Authority = { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 5 };
const canSpawnRichBudget: Authority = { tools: [], spawn_children: true, max_child_count: 3, budget_usd: 10 };
const canSpawnPoorBudget: Authority = { tools: [], spawn_children: true, max_child_count: 3, budget_usd: 0.01 };

describe('decideExecution', () => {
  it('self-executes unconditionally when the node cannot spawn children', () => {
    const result = decideExecution({ goal: 'a very very very long and complex goal '.repeat(10), authority: cannotSpawn, complexity: 'high' });
    expect(result.outcome).toBe('SELF_EXECUTE');
  });

  it('escalates when spawning is allowed but the budget cannot cover a child', () => {
    const result = decideExecution({ goal: 'anything', authority: canSpawnPoorBudget, complexity: 'high' });
    expect(result.outcome).toBe('ESCALATE');
    expect(canSpawnPoorBudget.budget_usd).toBeLessThan(MIN_AGENT_BUDGET_USD);
  });

  it('delegates a high-complexity goal when spawning and budget both allow it', () => {
    const result = decideExecution({ goal: 'x'.repeat(200), authority: canSpawnRichBudget, complexity: 'high' });
    expect(result.outcome).toBe('DELEGATE');
  });

  it('self-executes a low-complexity goal even when spawning is allowed', () => {
    const result = decideExecution({ goal: 'fix typo', authority: canSpawnRichBudget, complexity: 'low' });
    expect(result.outcome).toBe('SELF_EXECUTE');
  });

  it('always returns a printable breakdown, even for the cannot-spawn short-circuit', () => {
    const result = decideExecution({ goal: 'x', authority: cannotSpawn, complexity: 'low' });
    expect(typeof result.breakdown.score).toBe('number');
  });
});

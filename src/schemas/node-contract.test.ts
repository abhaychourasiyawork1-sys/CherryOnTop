import { describe, it, expect } from 'vitest';
import { NodeContractSchema } from './node-contract';

describe('NodeContractSchema', () => {
  it('accepts a valid node contract', () => {
    const result = NodeContractSchema.safeParse({
      goal: 'Implement OAuth login',
      definition_of_done: ['OAuth provider integrated', 'tests pass'],
      authority: {
        tools: ['git', 'shell'],
        spawn_children: true,
        max_child_count: 3,
        budget_usd: 3,
      },
      constraints: ['preserve existing auth'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a contract with an empty goal', () => {
    const result = NodeContractSchema.safeParse({
      goal: '',
      definition_of_done: ['x'],
      authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 0 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a contract with no definition_of_done entries', () => {
    const result = NodeContractSchema.safeParse({
      goal: 'x',
      definition_of_done: [],
      authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 0 },
    });
    expect(result.success).toBe(false);
  });

  it('defaults constraints to an empty array when omitted', () => {
    const result = NodeContractSchema.parse({
      goal: 'x',
      definition_of_done: ['x'],
      authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 0 },
    });
    expect(result.constraints).toEqual([]);
  });
});

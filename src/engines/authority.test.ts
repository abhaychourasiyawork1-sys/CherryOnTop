import { describe, it, expect } from 'vitest';
import { effectiveAuthority } from './authority.js';
import type { Authority } from '../schemas/node-contract.js';

const full: Authority = { tools: ['git', 'shell', 'web'], spawn_children: true, max_child_count: 5, budget_usd: 10 };

describe('effectiveAuthority', () => {
  it('intersects tools across all three levels', () => {
    const result = effectiveAuthority(
      full,
      { ...full, tools: ['git', 'shell'] },
      { ...full, tools: ['git', 'web'] },
    );
    expect(result.tools).toEqual(['git']);
  });

  it('spawn_children is true only if all three levels allow it', () => {
    expect(effectiveAuthority(full, { ...full, spawn_children: false }, full).spawn_children).toBe(false);
    expect(effectiveAuthority(full, full, full).spawn_children).toBe(true);
  });

  it('takes the minimum of max_child_count across all three levels', () => {
    const result = effectiveAuthority(
      { ...full, max_child_count: 3 },
      { ...full, max_child_count: 5 },
      { ...full, max_child_count: 10 },
    );
    expect(result.max_child_count).toBe(3);
  });

  it('takes the minimum of budget_usd across all three levels', () => {
    const result = effectiveAuthority(
      { ...full, budget_usd: 2 },
      { ...full, budget_usd: 10 },
      { ...full, budget_usd: 5 },
    );
    expect(result.budget_usd).toBe(2);
  });
});

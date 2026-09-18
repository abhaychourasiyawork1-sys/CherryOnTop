import { describe, it, expect } from 'vitest';
import { classifyFastPath } from './fast-path.js';

describe('classifyFastPath', () => {
  it('accepts a tiny anchored edit', () => {
    const result = classifyFastPath({
      goal: 'Fix the typo in src/foo.ts',
      taskClass: 'trivial_edit',
      complexity: 'low',
      worthSplitting: false,
      anchors: ['src/foo.ts'],
    });

    expect(result.eligible).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('rejects broad repository work', () => {
    const result = classifyFastPath({
      goal: 'Review the entire repository for authentication bugs',
      taskClass: 'investigation',
      complexity: 'high',
      worthSplitting: false,
      anchors: [],
    });

    expect(result.eligible).toBe(false);
  });

  it('rejects multi-workstream tasks', () => {
    const result = classifyFastPath({
      goal: 'Fix auth and add tests and update documentation',
      taskClass: 'multi_workstream',
      complexity: 'medium',
      worthSplitting: true,
      anchors: ['src/auth.ts'],
    });

    expect(result.eligible).toBe(false);
  });

  it('does not fast-path an unanchored medium task', () => {
    const result = classifyFastPath({
      goal: 'Improve the authentication subsystem',
      taskClass: 'implementation',
      complexity: 'medium',
      worthSplitting: false,
      anchors: [],
    });

    expect(result.eligible).toBe(false);
  });

  it('rejects multiple anchors because the fast path must stay narrow', () => {
    const result = classifyFastPath({
      goal: 'Fix the typo in src/foo.ts and src/bar.ts',
      taskClass: 'trivial_edit',
      complexity: 'low',
      worthSplitting: false,
      anchors: ['src/foo.ts', 'src/bar.ts'],
    });

    expect(result.eligible).toBe(false);
  });
});

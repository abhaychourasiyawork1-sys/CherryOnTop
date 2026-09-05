import { describe, it, expect } from 'vitest';
import { CommitmentSchema } from './commitment.js';

describe('CommitmentSchema', () => {
  it('accepts a minimal valid commitment', () => {
    const result = CommitmentSchema.safeParse({
      id: 'c1', owner: 'n1', goal: 'implement feature X',
      definition_of_done: ['tests pass'], status: 'pending',
      created_at: '2026-09-05T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid status', () => {
    const result = CommitmentSchema.safeParse({
      id: 'c1', owner: 'n1', goal: 'x', definition_of_done: ['x'],
      status: 'not-a-real-status', created_at: '2026-09-05T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('defaults array fields to empty when omitted', () => {
    const result = CommitmentSchema.parse({
      id: 'c1', owner: 'n1', goal: 'x', definition_of_done: ['x'],
      status: 'pending', created_at: '2026-09-05T00:00:00.000Z',
    });
    expect(result.dependencies).toEqual([]);
    expect(result.evidence).toEqual([]);
    expect(result.risks).toEqual([]);
  });
});

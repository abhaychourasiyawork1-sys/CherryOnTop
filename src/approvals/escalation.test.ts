import { describe, it, expect, vi } from 'vitest';
import { escalate } from './escalation.js';

describe('escalate', () => {
  it('persists a pending approval and fires a notification', async () => {
    const calls: string[] = [];
    const deps = {
      insertApproval: vi.fn(() => { calls.push('insert'); }),
      notify: vi.fn(() => { calls.push('notify'); }),
    };

    const id = await escalate('n1', 'insufficient budget', deps);

    expect(typeof id).toBe('string');
    expect(calls).toEqual(['insert', 'notify']);
    expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining('n1'));
  });
});

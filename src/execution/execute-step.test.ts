import { describe, it, expect, vi } from 'vitest';
import { executeStep } from './execute-step.js';
import type { RuntimeAdapter } from '../adapters/adapter.js';

const fakeAdapter: RuntimeAdapter = {
  name: 'fake',
  buildCommand: (goal) => ['fake-cli', goal],
  parseEventStream: async () => [{ type: 'result', payload: { success: true } }],
};

describe('executeStep', () => {
  it('creates a secret, applies a network policy, dispatches a Job, waits, and cleans up on success', async () => {
    const calls: string[] = [];
    const deps = {
      createEphemeralSecret: vi.fn(async () => { calls.push('createSecret'); return 'secret-1'; }),
      deleteSecret: vi.fn(async () => { calls.push('deleteSecret'); }),
      applyNetworkPolicy: vi.fn(async () => { calls.push('applyPolicy'); }),
      createJob: vi.fn(async () => { calls.push('createJob'); return 'job-1'; }),
      waitForJobCompletion: vi.fn(async () => { calls.push('waitJob'); return { succeeded: true, message: 'ok' }; }),
      deleteJob: vi.fn(async () => { calls.push('deleteJob'); }),
      streamJobLogs: vi.fn(async () => { calls.push('streamLogs'); return '{"type":"result","payload":{"success":true}}\n'; }),
    };

    const result = await executeStep(
      { nodeId: 'n1', goal: 'test goal', namespace: 'org-exec', worktreePath: '/tmp/w', credentials: {}, adapter: fakeAdapter },
      deps,
    );

    expect(result.succeeded).toBe(true);
    expect(calls).toEqual(['createSecret', 'applyPolicy', 'createJob', 'waitJob', 'streamLogs', 'deleteJob', 'deleteSecret']);
  });

  it('still deletes the secret and Job when the Job fails', async () => {
    const deps = {
      createEphemeralSecret: vi.fn(async () => 'secret-1'),
      deleteSecret: vi.fn(async () => {}),
      applyNetworkPolicy: vi.fn(async () => {}),
      createJob: vi.fn(async () => 'job-1'),
      waitForJobCompletion: vi.fn(async () => ({ succeeded: false, message: 'boom' })),
      deleteJob: vi.fn(async () => {}),
      streamJobLogs: vi.fn(async () => ''),
    };

    const result = await executeStep(
      { nodeId: 'n1', goal: 'test goal', namespace: 'org-exec', worktreePath: '/tmp/w', credentials: {}, adapter: fakeAdapter },
      deps,
    );

    expect(result.succeeded).toBe(false);
    expect(deps.deleteJob).toHaveBeenCalled();
    expect(deps.deleteSecret).toHaveBeenCalled();
  });

  it('still deletes the secret when the Job never gets created', async () => {
    const deps = {
      createEphemeralSecret: vi.fn(async () => 'secret-1'),
      deleteSecret: vi.fn(async () => {}),
      applyNetworkPolicy: vi.fn(async () => {}),
      createJob: vi.fn(async () => { throw new Error('cluster unreachable'); }),
      waitForJobCompletion: vi.fn(async () => ({ succeeded: true, message: 'ok' })),
      deleteJob: vi.fn(async () => {}),
      streamJobLogs: vi.fn(async () => ''),
    };

    await expect(
      executeStep(
        { nodeId: 'n1', goal: 'g', namespace: 'org-exec', worktreePath: '/tmp/w', credentials: {}, adapter: fakeAdapter },
        deps,
      ),
    ).rejects.toThrow('cluster unreachable');
    expect(deps.deleteSecret).toHaveBeenCalled();
    expect(deps.deleteJob).not.toHaveBeenCalled();
  });
});

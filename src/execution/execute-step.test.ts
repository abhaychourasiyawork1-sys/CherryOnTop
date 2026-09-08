import { describe, it, expect, vi } from 'vitest';
import { executeStep } from './execute-step.js';
import type { RuntimeAdapter } from '../adapters/adapter.js';
import type { ExecuteStepDeps } from './execute-step.js';

const fakeAdapter: RuntimeAdapter = {
  name: 'fake',
  buildCommand: (goal) => ['fake-cli', goal],
  parseLine: (line) => { try { return JSON.parse(line) as { type: string; payload: unknown }; } catch { return null; } },
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
      followJobLogs: vi.fn(async (_j: string, _n: string, onLine: (l: string) => void) => {
        calls.push('followLogs');
        onLine('{"type":"result","payload":{"success":true}}');
        return () => {};
      }),
      streamJobLogs: vi.fn(async () => { calls.push('streamLogs'); return '{"type":"result","payload":{"success":true}}\n'; }),
      getKubeDnsClusterIp: vi.fn(async () => '10.96.0.10'),
    };

    const result = await executeStep(
      { nodeId: 'n1', goal: 'test goal', namespace: 'org-exec', worktreePath: '/tmp/w', credentials: {}, adapter: fakeAdapter },
      deps,
    );

    expect(result.succeeded).toBe(true);
    expect(calls).toEqual(['createSecret', 'applyPolicy', 'createJob', 'followLogs', 'waitJob', 'streamLogs', 'deleteJob', 'deleteSecret']);
  });

  it('still deletes the secret and Job when the Job fails', async () => {
    const deps = {
      createEphemeralSecret: vi.fn(async () => 'secret-1'),
      deleteSecret: vi.fn(async () => {}),
      applyNetworkPolicy: vi.fn(async () => {}),
      createJob: vi.fn(async () => 'job-1'),
      waitForJobCompletion: vi.fn(async () => ({ succeeded: false, message: 'boom' })),
      deleteJob: vi.fn(async () => {}),
      followJobLogs: vi.fn(async () => () => {}),
      streamJobLogs: vi.fn(async () => ''),
      getKubeDnsClusterIp: vi.fn(async () => '10.96.0.10'),
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
      followJobLogs: vi.fn(async () => () => {}),
      streamJobLogs: vi.fn(async () => ''),
      getKubeDnsClusterIp: vi.fn(async () => '10.96.0.10'),
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

  it('calls onEvent for each line as followJobLogs delivers it, and still returns the full collected array', async () => {
    const onEvent = vi.fn();
    const deps = {
      createEphemeralSecret: vi.fn(async () => 'secret-1'),
      deleteSecret: vi.fn(async () => {}),
      applyNetworkPolicy: vi.fn(async () => {}),
      getKubeDnsClusterIp: vi.fn(async () => '10.96.0.10'),
      createJob: vi.fn(async () => 'job-1'),
      followJobLogs: vi.fn(async (_j: string, _n: string, onLine: (line: string) => void) => {
        onLine('{"type":"assistant","payload":{"text":"hi"}}');
        onLine('{"type":"result","payload":{"total_cost_usd":0.01}}');
        return () => {};
      }),
      waitForJobCompletion: vi.fn(async () => ({ succeeded: true, message: 'ok' })),
      streamJobLogs: vi.fn(async () => ''),
      deleteJob: vi.fn(async () => {}),
    };

    const result = await executeStep(
      { nodeId: 'n1', goal: 'test', namespace: 'org-exec', worktreePath: '/tmp/w', credentials: {}, adapter: fakeAdapter, onEvent },
      deps,
    );

    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(result.events).toHaveLength(2);
    expect(result.events[0].type).toBe('assistant');
  });

  it('backfills only the tail the live stream missed when the follow closes early', async () => {
    const onEvent = vi.fn();
    const deps = {
      createEphemeralSecret: vi.fn(async () => 'secret-1'),
      deleteSecret: vi.fn(async () => {}),
      applyNetworkPolicy: vi.fn(async () => {}),
      getKubeDnsClusterIp: vi.fn(async () => '10.96.0.10'),
      createJob: vi.fn(async () => 'job-1'),
      followJobLogs: vi.fn(async (_j: string, _n: string, onLine: (line: string) => void) => {
        onLine('{"type":"a","payload":{}}');
        return () => {};
      }),
      waitForJobCompletion: vi.fn(async () => ({ succeeded: true, message: 'ok' })),
      // The full log has three lines; the follow stream only delivered the first.
      streamJobLogs: vi.fn(async () => '{"type":"a","payload":{}}\n{"type":"b","payload":{}}\n{"type":"c","payload":{}}\n'),
      deleteJob: vi.fn(async () => {}),
    };

    const result = await executeStep(
      { nodeId: 'n1', goal: 'test', namespace: 'org-exec', worktreePath: '/tmp/w', credentials: {}, adapter: fakeAdapter, onEvent },
      deps,
    );

    expect(result.events.map((e) => e.type)).toEqual(['a', 'b', 'c']);
    expect(onEvent).toHaveBeenCalledTimes(3);
  });
});

// Minimal deps that get executeStep through the whole flow without a real
// cluster: every hook is a no-op, and the Job "completes" immediately.
function fakeDepsThatCompleteImmediately(): Partial<ExecuteStepDeps> {
  return {
    createEphemeralSecret: vi.fn(async () => 'secret-1'),
    deleteSecret: vi.fn(async () => {}),
    applyNetworkPolicy: vi.fn(async () => {}),
    getKubeDnsClusterIp: vi.fn(async () => '10.96.0.10'),
    createJob: vi.fn(async () => 'job-1'),
    followJobLogs: vi.fn(async () => () => {}),
    waitForJobCompletion: vi.fn(async () => ({ succeeded: true, message: 'ok' })),
    streamJobLogs: vi.fn(async () => ''),
    deleteJob: vi.fn(async () => {}),
  };
}

function fakeAdapterEmittingResultWithUsage(): RuntimeAdapter {
  return {
    name: 'fake',
    buildCommand: () => ['fake-cli'],
    parseLine: (line) => { try { return JSON.parse(line) as { type: string; payload: unknown }; } catch { return null; } },
    parseEventStream: async () => [],
  };
}

describe('executeStep dispatch options', () => {
  it('passes model / maxTurns / systemPrompt into adapter.buildCommand', async () => {
    let seenOpts: unknown;
    const adapter: RuntimeAdapter = {
      name: 'fake',
      buildCommand: (goal: string, _grant, opts) => { seenOpts = opts; return ['x']; },
      parseLine: () => null,
      parseEventStream: async () => [],
    };
    await executeStep(
      {
        nodeId: 'n', goal: 'g', namespace: 'ns', worktreePath: '/tmp', credentials: {},
        adapter, image: 'img',
        model: 'haiku', maxTurns: 3, systemPrompt: 'be brief',
      },
      fakeDepsThatCompleteImmediately(),
    );
    expect(seenOpts).toEqual({ model: 'haiku', maxTurns: 3, systemPrompt: 'be brief' });
  });

  it('populates result.usage from the collected events', async () => {
    const deps = {
      ...fakeDepsThatCompleteImmediately(),
      followJobLogs: vi.fn(async (_j: string, _n: string, onLine: (line: string) => void) => {
        onLine('{"type":"result","payload":{"usage":{"input_tokens":10}}}');
        return () => {};
      }),
    };
    const result = await executeStep(
      { nodeId: 'n', goal: 'g', namespace: 'ns', worktreePath: '/tmp', credentials: {}, adapter: fakeAdapterEmittingResultWithUsage(), image: 'img' },
      deps,
    );
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { executeStep } from './execute-step.js';
import { claudeCodeAdapter } from '../adapters/claude-code.js';

function deps(logLines: string[], succeeded: boolean) {
  return {
    createEphemeralSecret: vi.fn(async () => 'secret-1'),
    deleteSecret: vi.fn(async () => {}),
    applyNetworkPolicy: vi.fn(async () => {}),
    createJob: vi.fn(async () => 'job-1'),
    waitForJobCompletion: vi.fn(async () => ({ succeeded, message: 'Job failed — see pod logs' })),
    deleteJob: vi.fn(async () => {}),
    followJobLogs: vi.fn(async () => () => {}),
    streamJobLogs: vi.fn(async () => logLines.join('\n')),
    getKubeDnsClusterIp: vi.fn(async () => '10.96.0.10'),
  };
}

const input = {
  nodeId: 'n1', goal: 'g', namespace: 'org-exec', worktreePath: '/host/repo',
  credentials: {}, adapter: claudeCodeAdapter,
};

describe('executeStep failure reporting', () => {
  it('prefers the runtime’s own reason over "see pod logs"', () => {
    // The real case: ten API retries then a timeout. "Job failed — see pod logs"
    // sent the reader to kubectl for something the runtime already said.
    const line = JSON.stringify({ type: 'result', is_error: true, result: 'Request timed out' });
    return executeStep(input, deps([line], false)).then((result) => {
      expect(result.succeeded).toBe(false);
      expect(result.message).toBe('Request timed out');
    });
  });

  it('falls back to the job’s message when the runtime said nothing useful', async () => {
    const line = JSON.stringify({ type: 'result', is_error: true, result: '   ' });
    const result = await executeStep(input, deps([line], false));
    expect(result.message).toBe('Job failed — see pod logs');
  });

  it('does not mistake a clean result for an error', async () => {
    const line = JSON.stringify({ type: 'result', is_error: false, result: 'All done' });
    const result = await executeStep(input, deps([line], false));
    expect(result.message).toBe('Job failed — see pod logs');
  });

  it('leaves a successful step’s message alone', async () => {
    const result = await executeStep(input, deps([], true));
    expect(result.succeeded).toBe(true);
  });

  it('reports an exhausted quota as a quota problem, not a timeout', async () => {
    // The runtime says "Request timed out" when its usage window is spent. The
    // rate_limit_event in the same stream carries the real reason, and it is the
    // one that outranks.
    const lines = [
      JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1788697200 } }),
      JSON.stringify({ type: 'result', is_error: true, result: 'Request timed out' }),
    ];
    const result = await executeStep(input, deps(lines, false));
    expect(result.message).toContain('five-hour usage limit is used up');
    expect(result.message).not.toContain('timed out');
  });
});

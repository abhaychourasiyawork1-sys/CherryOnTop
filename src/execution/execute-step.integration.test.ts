import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execa } from 'execa';
import { executeStep } from './execute-step.js';
import { claudeCodeAdapter } from '../adapters/claude-code.js';
import { ensureLocalCluster, isClusterReachable, NAMESPACE } from '../k8s/kind.js';
import type { RuntimeAdapter } from '../adapters/adapter.js';

const CLUSTER_AVAILABLE = await isClusterReachable();
if (!CLUSTER_AVAILABLE) {
  console.log('no reachable cluster — skipping executeStep dispatch test');
}

// Stopgap until Phase 5 publishes cherryontop-runner: busybox stands in for the
// real image and echoes the stream-json lines Claude Code would emit, so the
// dispatch path (Secret -> NetworkPolicy -> Job -> logs -> parsed events ->
// cleanup) is exercised for real against a cluster.
const busyboxAdapter: RuntimeAdapter = {
  name: 'busybox-stopgap',
  buildCommand: (goal) => [
    'sh', '-c',
    `printf '%s\\n' '{"type":"message","payload":{"text":"${goal}"}}' '{"type":"result","payload":{"success":true}}'`,
  ],
  parseLine: claudeCodeAdapter.parseLine,
  parseEventStream: claudeCodeAdapter.parseEventStream,
};

describe.skipIf(!CLUSTER_AVAILABLE)('executeStep against a real cluster', () => {
  beforeAll(async () => {
    await ensureLocalCluster();
  }, 180_000);

  // executeStep deliberately leaves the egress policy in place (it is per-node,
  // not per-step), so the test that created them owns deleting them.
  afterAll(async () => {
    for (const nodeId of ['itest', 'itestfail']) {
      await execa('kubectl', ['delete', 'networkpolicy', `org-egress-${nodeId}`, '-n', NAMESPACE]).catch(() => {});
    }
  }, 60_000);

  it('dispatches a real Job, parses its structured output, and leaves nothing behind', async () => {
    const result = await executeStep({
      nodeId: 'itest',
      goal: 'hello from the sandbox',
      namespace: NAMESPACE,
      worktreePath: '/tmp',
      credentials: { ORG_TEST_CREDENTIAL: 'value-never-logged' },
      adapter: busyboxAdapter,
      image: 'busybox:1.36',
    });

    expect(result.succeeded).toBe(true);
    expect(result.events.map((e) => e.type)).toEqual(['message', 'result']);
    // Post-G8, the payload is the whole raw line, not just its `payload` field.
    expect(result.events[0].payload).toEqual({ type: 'message', payload: { text: 'hello from the sandbox' } });
    expect(result.events[1].payload).toEqual({ type: 'result', payload: { success: true } });

    // The ephemeral Secret and the Job must both be gone — a leaked credential
    // outliving its Job is the exact failure this phase's design exists to avoid.
    const { stdout: secrets } = await execa('kubectl', ['get', 'secrets', '-n', NAMESPACE, '-o', 'name']);
    expect(secrets).not.toContain('org-secret-itest');
    const { stdout: jobs } = await execa('kubectl', ['get', 'jobs', '-n', NAMESPACE, '-o', 'name']);
    expect(jobs).not.toContain('org-exec-itest');
  }, 300_000);

  it('reports failure, and still cleans up, when the runner exits non-zero', async () => {
    const failingAdapter: RuntimeAdapter = {
      ...busyboxAdapter,
      buildCommand: () => ['sh', '-c', 'exit 3'],
    };

    const result = await executeStep({
      nodeId: 'itestfail',
      goal: 'this one fails',
      namespace: NAMESPACE,
      worktreePath: '/tmp',
      credentials: {},
      adapter: failingAdapter,
      image: 'busybox:1.36',
    });

    expect(result.succeeded).toBe(false);

    const { stdout: secrets } = await execa('kubectl', ['get', 'secrets', '-n', NAMESPACE, '-o', 'name']);
    expect(secrets).not.toContain('org-secret-itestfail');
  }, 300_000);
});

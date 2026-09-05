import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { buildEgressAllowlistPolicy, applyNetworkPolicy } from './network-policy.js';
import { deleteNodeNetworkPolicy, deleteNodeJobs } from './cleanup.js';
import { buildExecutionJob } from './job-manifest.js';
import { createJob } from './client.js';
import { isClusterReachable, NAMESPACE } from './kind.js';

const CLUSTER_AVAILABLE = await isClusterReachable();
if (!CLUSTER_AVAILABLE) console.log('no reachable cluster — skipping NetworkPolicy cleanup test');

describe.skipIf(!CLUSTER_AVAILABLE)('deleteNodeNetworkPolicy', () => {
  it('deletes the per-node egress policy without throwing if it exists', async () => {
    const policy = buildEgressAllowlistPolicy('cleanup-test-node', [{ ip: '0.0.0.0/0', ports: [443] }]);
    await applyNetworkPolicy(policy, NAMESPACE);

    await deleteNodeNetworkPolicy('cleanup-test-node', NAMESPACE);

    const { stdout } = await execa('kubectl', ['get', 'networkpolicy', '-n', NAMESPACE, '-o', 'name']);
    expect(stdout).not.toContain('org-egress-cleanup-test-node');
  }, 30_000);

  it('does not throw when the policy does not exist', async () => {
    await expect(deleteNodeNetworkPolicy('never-existed', NAMESPACE)).resolves.not.toThrow();
  }, 15_000);
});

describe.skipIf(!CLUSTER_AVAILABLE)('deleteNodeJobs', () => {
  it("deletes a node's Jobs by label", async () => {
    await execa('kubectl', ['create', 'secret', 'generic', 'cancel-secret', '--from-literal=x=y', '-n', 'default']).catch(() => {});
    const job = buildExecutionJob({
      nodeId: 'cancelme', namespace: 'default', image: 'busybox:1.36',
      command: ['sh', '-c', 'sleep 300'], worktreePath: '/tmp', secretName: 'cancel-secret',
    });
    await createJob(job);

    await deleteNodeJobs('cancelme', 'default');

    const { stdout } = await execa('kubectl', ['get', 'jobs', '-n', 'default', '-l', 'org.nodeId=cancelme', '-o', 'name']);
    expect(stdout.trim()).toBe('');
    await execa('kubectl', ['delete', 'secret', 'cancel-secret', '-n', 'default']).catch(() => {});
  }, 120_000);

  it('does not throw when the node has no Jobs running', async () => {
    // Cancelling a node parked on approval, or one already finished, hits this.
    await expect(deleteNodeJobs('never-existed', 'default')).resolves.not.toThrow();
  }, 30_000);
});

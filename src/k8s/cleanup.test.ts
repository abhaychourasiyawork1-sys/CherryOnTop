import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { buildEgressAllowlistPolicy, applyNetworkPolicy } from './network-policy.js';
import { deleteNodeNetworkPolicy } from './cleanup.js';
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

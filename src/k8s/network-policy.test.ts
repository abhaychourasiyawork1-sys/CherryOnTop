import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { buildEgressAllowlistPolicy, applyDefaultDenyPolicy, applyNetworkPolicy } from './network-policy.js';
import { isClusterReachable } from './kind.js';

describe('buildEgressAllowlistPolicy', () => {
  it('builds a policy denying ingress and allowlisting only the given egress targets', () => {
    const policy = buildEgressAllowlistPolicy('n1', [{ ip: '140.82.112.0/20', ports: [443] }]);
    expect(policy.spec?.podSelector.matchLabels).toEqual({ 'org.nodeId': 'n1' });
    expect(policy.spec?.policyTypes).toEqual(['Ingress', 'Egress']);
    expect(policy.spec?.ingress).toEqual([]);
    expect(policy.spec?.egress?.[0].to?.[0].ipBlock?.cidr).toBe('140.82.112.0/20');
    expect(policy.spec?.egress?.[0].ports?.[0].port).toBe(443);
  });
});

// These tests talk to whatever cluster is already up; they don't bootstrap one.
const CLUSTER_AVAILABLE = await isClusterReachable();
if (!CLUSTER_AVAILABLE) {
  console.log('no reachable cluster — skipping NetworkPolicy application tests');
}

describe.skipIf(!CLUSTER_AVAILABLE)('NetworkPolicy application (real cluster)', () => {
  it('applies a default-deny policy without throwing', async () => {
    await expect(applyDefaultDenyPolicy('default')).resolves.not.toThrow();
    await execa('kubectl', ['delete', 'networkpolicy', 'default-deny-all', '-n', 'default']).catch(() => {});
  }, 15_000);

  it('applies an egress-allowlist policy without throwing', async () => {
    const policy = buildEgressAllowlistPolicy('n1', [{ ip: '0.0.0.0/0', ports: [443] }]);
    await expect(applyNetworkPolicy(policy, 'default')).resolves.not.toThrow();
    await execa('kubectl', ['delete', 'networkpolicy', 'org-egress-n1', '-n', 'default']).catch(() => {});
  }, 15_000);
});

it('excludes metadata and private-range addresses from a wide-open allowlist', () => {
  const policy = buildEgressAllowlistPolicy('n1', [
    { ip: '0.0.0.0/0', ports: [443], except: ['169.254.169.254/32', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'] },
  ]);
  expect(policy.spec?.egress?.[0].to?.[0].ipBlock?.except).toEqual([
    '169.254.169.254/32', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16',
  ]);
});

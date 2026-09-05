import * as k8s from '@kubernetes/client-node';
import type { V1NetworkPolicy, V1NetworkPolicyEgressRule } from '@kubernetes/client-node';

function loadNetworkingApi() {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  return kc.makeApiClient(k8s.NetworkingV1Api);
}

// ApiException carries the HTTP status on `code`.
function statusOf(err: unknown): number | undefined {
  return err instanceof k8s.ApiException ? err.code : undefined;
}

export function buildEgressAllowlistPolicy(
  nodeId: string,
  allowedTargets: { ip: string; ports: number[]; except?: string[] }[],
  // The simple ip/ports shape is TCP-only and single-CIDR; DNS needs UDP, so
  // rather than growing that shape a caller can pass raw rules through.
  extraEgressRules: V1NetworkPolicyEgressRule[] = [],
): V1NetworkPolicy {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name: `org-egress-${nodeId}` },
    spec: {
      podSelector: { matchLabels: { 'org.nodeId': nodeId } },
      policyTypes: ['Ingress', 'Egress'],
      ingress: [],
      egress: [
        ...allowedTargets.map((target) => ({
          to: [{ ipBlock: { cidr: target.ip, ...(target.except ? { except: target.except } : {}) } }],
          ports: target.ports.map((port) => ({ port, protocol: 'TCP' })),
        })),
        ...extraEgressRules,
      ],
    },
  };
}

export async function applyNetworkPolicy(policy: V1NetworkPolicy, namespace: string): Promise<void> {
  const api = loadNetworkingApi();
  await api.createNamespacedNetworkPolicy({ namespace, body: policy }).catch(async (err: unknown) => {
    if (statusOf(err) !== 409) throw err;
    const name = policy.metadata?.name;
    if (!name) throw err;
    await api.replaceNamespacedNetworkPolicy({ name, namespace, body: policy });
  });
}

export async function applyDefaultDenyPolicy(namespace: string): Promise<void> {
  const api = loadNetworkingApi();
  const policy: V1NetworkPolicy = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name: 'default-deny-all' },
    spec: { podSelector: {}, policyTypes: ['Ingress', 'Egress'], ingress: [], egress: [] },
  };
  await api.createNamespacedNetworkPolicy({ namespace, body: policy }).catch((err: unknown) => {
    if (statusOf(err) !== 409) throw err;
  });
}

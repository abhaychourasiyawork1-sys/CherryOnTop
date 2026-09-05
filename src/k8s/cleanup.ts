import * as k8s from '@kubernetes/client-node';

function loadNetworkingApi() {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  return kc.makeApiClient(k8s.NetworkingV1Api);
}

export async function deleteNodeNetworkPolicy(nodeId: string, namespace: string): Promise<void> {
  const api = loadNetworkingApi();
  await api
    .deleteNamespacedNetworkPolicy({ name: `org-egress-${nodeId}`, namespace })
    .catch((err: unknown) => {
      if (err instanceof k8s.ApiException && err.code === 404) return;
      throw err;
    });
}

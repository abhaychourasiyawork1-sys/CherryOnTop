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

function loadBatchApi() {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  return kc.makeApiClient(k8s.BatchV1Api);
}

/** Deletes every Job belonging to a node. By label, not by name: the manifest
 *  uses `generateName`, so the caller never learns the real names. A node with
 *  nothing running is a no-op, which is the common case when cancelling one
 *  parked on approval. */
export async function deleteNodeJobs(nodeId: string, namespace: string): Promise<void> {
  await loadBatchApi()
    .deleteCollectionNamespacedJob({
      namespace,
      labelSelector: `org.nodeId=${nodeId}`,
      propagationPolicy: 'Background',
    })
    .catch((err: unknown) => {
      if (err instanceof k8s.ApiException && err.code === 404) return;
      throw err;
    });
}

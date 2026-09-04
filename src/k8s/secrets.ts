import * as k8s from '@kubernetes/client-node';
import { randomUUID } from 'node:crypto';

function loadCoreApi() {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  return kc.makeApiClient(k8s.CoreV1Api);
}

export async function createEphemeralSecret(
  nodeId: string,
  credentials: Record<string, string>,
  namespace: string,
): Promise<string> {
  const core = loadCoreApi();
  const name = `org-secret-${nodeId}-${randomUUID().slice(0, 8)}`;
  await core.createNamespacedSecret({
    namespace,
    body: {
      metadata: { name, namespace, labels: { 'org.nodeId': nodeId } },
      stringData: credentials,
    },
  });
  return name;
}

export async function deleteSecret(name: string, namespace: string): Promise<void> {
  const core = loadCoreApi();
  await core.deleteNamespacedSecret({ name, namespace });
}

import type { V1Job } from '@kubernetes/client-node';

export interface ExecutionJobParams {
  nodeId: string;
  namespace: string;
  image: string;
  command: string[];
  worktreePath: string;
  secretName: string;
}

export function buildExecutionJob(params: ExecutionJobParams): V1Job {
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      generateName: `org-exec-${params.nodeId}-`,
      namespace: params.namespace,
      labels: { 'org.nodeId': params.nodeId },
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 300,
      template: {
        metadata: { labels: { 'org.nodeId': params.nodeId } },
        spec: {
          restartPolicy: 'Never',
          containers: [
            {
              name: 'runner',
              image: params.image,
              command: params.command,
              envFrom: [{ secretRef: { name: params.secretName } }],
              volumeMounts: [{ name: 'workspace', mountPath: '/workspace' }],
              securityContext: {
                allowPrivilegeEscalation: false,
                runAsNonRoot: true,
                // runAsNonRoot alone makes the kubelet reject any image whose
                // default user is root (busybox, node:*-slim). Pinning the uid
                // is what actually lets those images start.
                runAsUser: 1000,
              },
              resources: {
                limits: { cpu: '2', memory: '2Gi' },
                requests: { cpu: '500m', memory: '512Mi' },
              },
            },
          ],
          // ponytail: hostPath resolves inside the kind node container, not on the
          // host, so the worktree is only really visible once kind is created with
          // an extraMounts entry for it (Phase 5's cluster-config task).
          volumes: [{ name: 'workspace', hostPath: { path: params.worktreePath, type: 'Directory' } }],
        },
      },
    },
  };
}

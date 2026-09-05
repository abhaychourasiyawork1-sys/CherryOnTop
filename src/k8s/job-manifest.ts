import type { V1Job } from '@kubernetes/client-node';

export interface ExecutionJobParams {
  nodeId: string;
  namespace: string;
  image: string;
  command: string[];
  worktreePath: string;
  secretName: string;
  /** True when the Secret carries the subscription's CLAUDE_CREDENTIALS_JSON
   *  key (see execution/credentials.ts) — mounts it to the exact path the
   *  claude binary reads it from, rather than exposing it as an env var. */
  includeOauthCredentials?: boolean;
}

const OAUTH_CREDENTIALS_VOLUME = 'claude-oauth-credentials';

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
              volumeMounts: [
                { name: 'workspace', mountPath: '/workspace' },
                ...(params.includeOauthCredentials ? [{
                  name: OAUTH_CREDENTIALS_VOLUME,
                  mountPath: '/home/node/.claude/.credentials.json',
                  subPath: '.credentials.json',
                }] : []),
              ],
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
          volumes: [
            { name: 'workspace', hostPath: { path: params.worktreePath, type: 'Directory' } },
            ...(params.includeOauthCredentials ? [{
              name: OAUTH_CREDENTIALS_VOLUME,
              secret: { secretName: params.secretName, items: [{ key: 'CLAUDE_CREDENTIALS_JSON', path: '.credentials.json' }] },
            }] : []),
          ],
        },
      },
    },
  };
}

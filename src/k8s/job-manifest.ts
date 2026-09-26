import type { V1Job } from '@kubernetes/client-node';
import type { ExtraMount } from './sandbox-env.js';

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
  /** Keep stdin open for a stdin-fed session. `stdinOnce` makes the harness
   *  detaching the end of input, so a daemon that dies mid-session cannot leave
   *  the runtime waiting forever. Never a TTY: the stream is JSON, not a
   *  terminal. */
  interactive?: boolean;
  /** Plain (non-secret) environment for the runtime. */
  env?: ReadonlyArray<{ name: string; value: string }>;
  /** Host directories beyond the worktree: git metadata, a lent toolchain. */
  extraMounts?: ExtraMount[];
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
              ...(params.interactive ? { stdin: true, stdinOnce: true, tty: false } : {}),
              envFrom: [{ secretRef: { name: params.secretName } }],
              ...(params.env?.length ? { env: params.env.map((e) => ({ ...e })) } : {}),
              volumeMounts: [
                { name: 'workspace', mountPath: '/workspace' },
                ...(params.extraMounts ?? []).map((m, i) => ({ name: `extra-${i}`, mountPath: m.mountPath, readOnly: m.readOnly })),
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
            ...(params.extraMounts ?? []).map((m, i) => ({ name: `extra-${i}`, hostPath: { path: m.hostPath, type: 'Directory' } })),
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

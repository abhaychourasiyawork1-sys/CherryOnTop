import { describe, it, expect } from 'vitest';
import { buildExecutionJob } from './job-manifest.js';

describe('buildExecutionJob', () => {
  it('builds a Job manifest with the worktree mounted and the secret referenced', () => {
    const job = buildExecutionJob({
      nodeId: 'n1',
      namespace: 'org-exec',
      image: 'node:22-slim',
      command: ['node', '--version'],
      worktreePath: '/tmp/worktree-n1',
      secretName: 'org-secret-n1',
    });

    expect(job.metadata?.namespace).toBe('org-exec');
    expect(job.metadata?.generateName).toBe('org-exec-n1-');
    expect(job.spec?.template.spec?.containers[0].image).toBe('node:22-slim');
    expect(job.spec?.template.spec?.containers[0].command).toEqual(['node', '--version']);
    expect(job.spec?.template.spec?.containers[0].volumeMounts?.[0].mountPath).toBe('/workspace');
    expect(job.spec?.template.spec?.volumes?.[0].hostPath?.path).toBe('/tmp/worktree-n1');
    expect(job.spec?.template.spec?.containers[0].envFrom?.[0].secretRef?.name).toBe('org-secret-n1');
    expect(job.spec?.template.spec?.restartPolicy).toBe('Never');
    expect(job.spec?.backoffLimit).toBe(0);
  });

  it('sets a resource-limited, non-privileged security context', () => {
    const job = buildExecutionJob({
      nodeId: 'n1', namespace: 'org-exec', image: 'node:22-slim',
      command: ['echo', 'hi'], worktreePath: '/tmp/w', secretName: 's1',
    });
    const container = job.spec?.template.spec?.containers[0];
    expect(container?.securityContext?.allowPrivilegeEscalation).toBe(false);
    expect(container?.resources?.limits?.cpu).toBeDefined();
    expect(container?.resources?.limits?.memory).toBeDefined();
  });

  it('pins a non-root uid so runAsNonRoot can actually be satisfied by a root-default image', () => {
    const job = buildExecutionJob({
      nodeId: 'n1', namespace: 'org-exec', image: 'busybox:1.36',
      command: ['echo', 'hi'], worktreePath: '/tmp/w', secretName: 's1',
    });
    const security = job.spec?.template.spec?.containers[0].securityContext;
    expect(security?.runAsNonRoot).toBe(true);
    expect(security?.runAsUser).toBeGreaterThan(0);
  });
});

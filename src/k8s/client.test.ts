import { describe, it, expect, beforeAll } from 'vitest';
import { execa } from 'execa';
import { isClusterReachable, ensureLocalCluster, isClusterAvailable } from './kind.js';
import { buildExecutionJob } from './job-manifest.js';
import { createJob, waitForJobCompletion, deleteJob } from './client.js';

const CLUSTER_AVAILABLE = await isClusterAvailable();
if (!CLUSTER_AVAILABLE) {
  console.log('no cluster and none bootstrappable (kind/kubectl/docker) — skipping K8s client integration tests');
}

describe.skipIf(!CLUSTER_AVAILABLE)('K8s client (real cluster)', () => {
  beforeAll(async () => {
    await ensureLocalCluster();
    expect(await isClusterReachable()).toBe(true);
  }, 120_000);

  it('creates a Job, waits for completion, and reports success', async () => {
    const job = buildExecutionJob({
      nodeId: 'test-client', namespace: 'default', image: 'busybox:1.36',
      command: ['echo', 'hello from job'], worktreePath: '/tmp', secretName: 'nonexistent-optional',
    });
    // Job spec references envFrom.secretRef without `optional: true` —
    // this test creates the referenced secret first so the pod can actually start.
    await execa('kubectl', ['create', 'secret', 'generic', 'nonexistent-optional', '--from-literal=x=y', '-n', 'default'])
      .catch(() => {}); // ignore AlreadyExists from a prior flaky run

    const jobName = await createJob(job);
    const result = await waitForJobCompletion(jobName, 'default');
    expect(result.succeeded).toBe(true);

    await deleteJob(jobName, 'default');
    await execa('kubectl', ['delete', 'secret', 'nonexistent-optional', '-n', 'default']).catch(() => {});
  }, 120_000);

  it('reports failure for a Job whose container exits non-zero', async () => {
    await execa('kubectl', ['create', 'secret', 'generic', 'fail-secret', '--from-literal=x=y', '-n', 'default']).catch(() => {});
    const job = buildExecutionJob({
      nodeId: 'test-client-fail', namespace: 'default', image: 'busybox:1.36',
      command: ['sh', '-c', 'exit 1'], worktreePath: '/tmp', secretName: 'fail-secret',
    });
    const jobName = await createJob(job);
    const result = await waitForJobCompletion(jobName, 'default');
    expect(result.succeeded).toBe(false);

    await deleteJob(jobName, 'default');
    await execa('kubectl', ['delete', 'secret', 'fail-secret', '-n', 'default']).catch(() => {});
  }, 120_000);
});

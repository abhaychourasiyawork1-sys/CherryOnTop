import { describe, it, expect, beforeAll } from 'vitest';
import { execa } from 'execa';
import { isClusterReachable, ensureLocalCluster, isClusterAvailable } from './kind.js';
import { buildExecutionJob } from './job-manifest.js';
import { createJob, waitForJobCompletion, deleteJob, followJobLogs } from './client.js';

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

describe.skipIf(!CLUSTER_AVAILABLE)('followJobLogs', () => {
  it('delivers log lines progressively while the Job is still running, not all at once at the end', async () => {
    await execa('kubectl', ['create', 'secret', 'generic', 'follow-secret', '--from-literal=x=y', '-n', 'default']).catch(() => {});
    const job = buildExecutionJob({
      nodeId: 'test-follow', namespace: 'default', image: 'busybox:1.36',
      command: ['sh', '-c', 'echo line1; sleep 2; echo line2; sleep 2; echo line3'],
      worktreePath: '/tmp', secretName: 'follow-secret',
    });

    const jobName = await createJob(job);
    const received: { line: string; at: number }[] = [];
    const start = Date.now();
    const stop = await followJobLogs(jobName, 'default', (line) => {
      received.push({ line, at: Date.now() - start });
    });

    await waitForJobCompletion(jobName, 'default');
    stop();

    expect(received.map((r) => r.line)).toEqual(['line1', 'line2', 'line3']);
    // The whole thing ran over ~4s of sleeps; if every line arrived within the
    // same handful of milliseconds, this isn't actually following — it's a
    // buffered fetch that happened to run after completion.
    expect(received[2].at - received[0].at).toBeGreaterThan(1500);

    await deleteJob(jobName, 'default');
    await execa('kubectl', ['delete', 'secret', 'follow-secret', '-n', 'default']).catch(() => {});
  }, 120_000);
});

describe.skipIf(!CLUSTER_AVAILABLE)('waitForJobCompletion when the Job is deleted underneath it', () => {
  it('reports a cancelled Job rather than throwing a 404', async () => {
    await execa('kubectl', ['create', 'secret', 'generic', 'gone-secret', '--from-literal=x=y', '-n', 'default']).catch(() => {});
    const job = buildExecutionJob({
      nodeId: 'gone', namespace: 'default', image: 'busybox:1.36',
      command: ['sh', '-c', 'sleep 300'], worktreePath: '/tmp', secretName: 'gone-secret',
    });
    const jobName = await createJob(job);

    const waiting = waitForJobCompletion(jobName, 'default');
    await new Promise((r) => setTimeout(r, 2000));
    await deleteJob(jobName, 'default');

    const result = await waiting;
    expect(result.succeeded).toBe(false);
    expect(result.message).toMatch(/cancelled/i);
    await execa('kubectl', ['delete', 'secret', 'gone-secret', '-n', 'default']).catch(() => {});
  }, 120_000);
});

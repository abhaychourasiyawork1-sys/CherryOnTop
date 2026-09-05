import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import * as k8s from '@kubernetes/client-node';
import type { V1Job } from '@kubernetes/client-node';

function loadApis() {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  return {
    kc,
    batch: kc.makeApiClient(k8s.BatchV1Api),
    core: kc.makeApiClient(k8s.CoreV1Api),
  };
}

export async function createJob(job: V1Job): Promise<string> {
  const { batch } = loadApis();
  const namespace = job.metadata?.namespace ?? 'default';
  const created = await batch.createNamespacedJob({ namespace, body: job });
  const name = created.metadata?.name;
  if (!name) throw new Error('Job created without a name in the response');
  return name;
}

export interface JobResult {
  succeeded: boolean;
  message: string;
}

// 10 minutes, not the 60s a quick busybox job needs: a real Claude Code run
// routinely takes minutes, and a short default would report every one of them
// as a failure. Callers wanting a tighter bound pass their own.
export async function waitForJobCompletion(
  jobName: string,
  namespace: string,
  timeoutMs = 600_000,
): Promise<JobResult> {
  const { batch } = loadApis();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let job;
    try {
      job = await batch.readNamespacedJobStatus({ name: jobName, namespace });
    } catch (err) {
      // The Job vanishing underneath a running step is a graceful outcome, not
      // a crash — cancellation deletes it deliberately, and a 404 here is how
      // every caller finds out. Throwing instead would surface a cancelled node
      // as an unhandled ApiException in the daemon log.
      if (err instanceof k8s.ApiException && err.code === 404) {
        return { succeeded: false, message: 'Job was cancelled' };
      }
      throw err;
    }
    const status = job.status;
    if (status?.succeeded && status.succeeded > 0) {
      return { succeeded: true, message: 'Job completed successfully' };
    }
    if (status?.failed && status.failed > 0) {
      return { succeeded: false, message: 'Job failed — see pod logs' };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { succeeded: false, message: `Job did not complete within ${timeoutMs}ms` };
}

export async function deleteJob(jobName: string, namespace: string): Promise<void> {
  const { batch } = loadApis();
  await batch.deleteNamespacedJob({ name: jobName, namespace, propagationPolicy: 'Background' });
}

export async function streamJobLogs(jobName: string, namespace: string): Promise<string> {
  const { core } = loadApis();
  const pods = await core.listNamespacedPod({ namespace, labelSelector: `job-name=${jobName}` });
  const podName = pods.items[0]?.metadata?.name;
  if (!podName) return '';
  return core.readNamespacedPodLog({ name: podName, namespace });
}

/** Waits until the Job's pod exists and its container has actually started.
 *  Following logs any earlier fails: right after createJob there is no pod at
 *  all, and a pod in ContainerCreating has no log endpoint yet. */
async function waitForRunnablePod(
  jobName: string,
  namespace: string,
  timeoutMs: number,
): Promise<string | undefined> {
  const { core } = loadApis();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const pods = await core.listNamespacedPod({ namespace, labelSelector: `job-name=${jobName}` });
    const pod = pods.items[0];
    const phase = pod?.status?.phase;
    if (pod?.metadata?.name && phase && phase !== 'Pending') {
      return pod.metadata.name;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return undefined;
}

/** Streams a Job's pod logs line by line as they are produced. The returned
 *  function stops following. Resolves once following has started (or once it is
 *  clear no pod will start within the timeout), not when the pod finishes. */
export async function followJobLogs(
  jobName: string,
  namespace: string,
  onLine: (line: string) => void,
  podWaitTimeoutMs = 120_000,
): Promise<() => void> {
  const { kc } = loadApis();
  const podName = await waitForRunnablePod(jobName, namespace, podWaitTimeoutMs);
  if (!podName) return () => {};

  const passthrough = new PassThrough();
  const rl = createInterface({ input: passthrough, crlfDelay: Infinity });
  rl.on('line', onLine);

  let controller: AbortController;
  try {
    controller = await new k8s.Log(kc).log(namespace, podName, 'runner', passthrough, { follow: true });
  } catch (err) {
    rl.close();
    passthrough.destroy();
    throw err;
  }

  return () => {
    controller.abort();
    rl.close();
  };
}

import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import * as k8s from '@kubernetes/client-node';
import type { V1Job, V1Pod } from '@kubernetes/client-node';

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

/** Container-waiting reasons a pod will never recover from on its own. Sitting
 *  out the full ten-minute timeout on one of these buys nothing and is exactly
 *  the silence that makes a run look hung rather than broken. */
const FATAL_WAITING_REASONS: Record<string, string> = {
  ImagePullBackOff: 'the sandbox image is missing from the cluster',
  ErrImagePull: 'the sandbox image could not be pulled',
  InvalidImageName: 'the sandbox image name is invalid',
  CreateContainerConfigError: 'the sandbox container could not be configured',
  CreateContainerError: 'the sandbox container could not be created',
};

export interface PodTrouble {
  reason: string;
  message: string;
}

/** Why this pod is not going to run. Null means "nothing conclusively wrong" —
 *  including the normal transient states, which must not be mistaken for
 *  failure. Pure, so the mapping is testable without a cluster. */
export function diagnosePod(pod: V1Pod): PodTrouble | null {
  const unschedulable = pod.status?.conditions?.find(
    (condition) => condition.type === 'PodScheduled' && condition.status === 'False',
  );
  if (unschedulable) {
    return {
      reason: unschedulable.reason ?? 'Unschedulable',
      message: `nothing in the cluster can run it: ${unschedulable.message ?? 'no node accepted the pod'}`,
    };
  }

  for (const status of pod.status?.containerStatuses ?? []) {
    const waiting = status.state?.waiting;
    const explanation = waiting?.reason ? FATAL_WAITING_REASONS[waiting.reason] : undefined;
    if (waiting?.reason && explanation) {
      return {
        reason: waiting.reason,
        message: waiting.message ? `${explanation}: ${waiting.message}` : explanation,
      };
    }
  }

  return null;
}

async function findPodTrouble(jobName: string, namespace: string): Promise<PodTrouble | null> {
  try {
    const { core } = loadApis();
    const pods = await core.listNamespacedPod({ namespace, labelSelector: `job-name=${jobName}` });
    for (const pod of pods.items) {
      const trouble = diagnosePod(pod);
      if (trouble) return trouble;
    }
  } catch {
    // Diagnosis is a courtesy on a path that is already failing; never let it
    // replace the outcome with an error of its own.
  }
  return null;
}

// 10 minutes, not the 60s a quick busybox job needs: a real Claude Code run
// routinely takes minutes, and a short default would report every one of them
// as a failure. Callers wanting a tighter bound pass their own.
export async function waitForJobCompletion(
  jobName: string,
  namespace: string,
  timeoutMs: number = 600_000,
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

    // Ask why before waiting again. A pod that cannot pull its image or cannot
    // be scheduled will still be in exactly this state in ten minutes' time,
    // and reporting it now is the difference between a clear failure and an
    // apparent hang.
    const trouble = await findPodTrouble(jobName, namespace);
    if (trouble) return { succeeded: false, message: `${trouble.reason} — ${trouble.message}` };

    await new Promise((r) => setTimeout(r, 1000));
  }
  const lastTrouble = await findPodTrouble(jobName, namespace);
  const why = lastTrouble ? ` (${lastTrouble.reason} — ${lastTrouble.message})` : '';
  return { succeeded: false, message: `Job did not complete within ${timeoutMs}ms${why}` };
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

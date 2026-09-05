import * as k8s from '@kubernetes/client-node';
import type { V1Job } from '@kubernetes/client-node';

function loadApis() {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  return {
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
    const job = await batch.readNamespacedJobStatus({ name: jobName, namespace });
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

import { Readable } from 'node:stream';
import { buildExecutionJob } from '../k8s/job-manifest.js';
import { createJob, waitForJobCompletion, deleteJob, streamJobLogs } from '../k8s/client.js';
import { createEphemeralSecret, deleteSecret } from '../k8s/secrets.js';
import { buildEgressAllowlistPolicy, applyNetworkPolicy } from '../k8s/network-policy.js';
import { getKubeDnsClusterIp } from '../k8s/kind.js';
import type { RuntimeAdapter, StructuredEvent } from '../adapters/adapter.js';

export interface ExecuteStepInput {
  nodeId: string;
  goal: string;
  namespace: string;
  worktreePath: string;
  credentials: Record<string, string>;
  adapter: RuntimeAdapter;
  /** Overrides the runner image. Phase 5 builds the real one; until then this is
   *  how an integration test dispatches a genuine Job with a stand-in image. */
  image?: string;
}

export interface ExecuteStepResult {
  succeeded: boolean;
  message: string;
  events: StructuredEvent[];
}

export interface ExecuteStepDeps {
  createEphemeralSecret: typeof createEphemeralSecret;
  deleteSecret: typeof deleteSecret;
  applyNetworkPolicy: typeof applyNetworkPolicy;
  createJob: typeof createJob;
  waitForJobCompletion: typeof waitForJobCompletion;
  deleteJob: typeof deleteJob;
  streamJobLogs: typeof streamJobLogs;
}

const defaultDeps: ExecuteStepDeps = {
  createEphemeralSecret, deleteSecret, applyNetworkPolicy,
  createJob, waitForJobCompletion, deleteJob, streamJobLogs,
};

const RUNNER_IMAGE = 'ghcr.io/abhaychourasiyawork1-sys/cherryontop-runner:dev';

// G2 fix: still wide on IP range (per-provider CIDR allowlists are a Phase 5
// config task — providers' ranges shift and need a maintained source), but now
// excludes the addresses a compromised runner could actually do damage with:
// cloud metadata (credential theft) and RFC1918 ranges (lateral movement).
// G6 fix: excluding RFC1918 ranges also excluded kind's service CIDR, so
// kube-dns was unreachable — a runner could only reach literal IPs, not
// hostnames. The narrow fix is a dedicated DNS rule below (added at call time,
// since the cluster's DNS IP is only known once a cluster exists), not widening
// the exclusion itself.
const DEFAULT_EGRESS_ALLOWLIST = [
  {
    ip: '0.0.0.0/0',
    ports: [443],
    except: ['169.254.169.254/32', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
  },
];

export async function executeStep(
  input: ExecuteStepInput,
  deps: Partial<ExecuteStepDeps> = {},
): Promise<ExecuteStepResult> {
  const d = { ...defaultDeps, ...deps };

  const secretName = await d.createEphemeralSecret(input.nodeId, input.credentials, input.namespace);
  try {
    // The policy is per-node, not per-step, so it outlives this call; the node's
    // terminal transition deletes it (k8s/cleanup.ts).
    const dnsIp = await getKubeDnsClusterIp();
    const policy = buildEgressAllowlistPolicy(input.nodeId, DEFAULT_EGRESS_ALLOWLIST, [
      { to: [{ ipBlock: { cidr: `${dnsIp}/32` } }], ports: [{ port: 53, protocol: 'UDP' }, { port: 53, protocol: 'TCP' }] },
    ]);
    await d.applyNetworkPolicy(policy, input.namespace);

    const job = buildExecutionJob({
      nodeId: input.nodeId,
      namespace: input.namespace,
      image: input.image ?? RUNNER_IMAGE,
      command: input.adapter.buildCommand(input.goal),
      worktreePath: input.worktreePath,
      secretName,
    });

    const jobName = await d.createJob(job);
    try {
      const jobResult = await d.waitForJobCompletion(jobName, input.namespace);
      const rawLogs = await d.streamJobLogs(jobName, input.namespace);
      const events = rawLogs
        ? await input.adapter.parseEventStream(Readable.from([rawLogs]))
        : [];

      return { succeeded: jobResult.succeeded, message: jobResult.message, events };
    } finally {
      await d.deleteJob(jobName, input.namespace);
    }
  } finally {
    await d.deleteSecret(secretName, input.namespace);
  }
}

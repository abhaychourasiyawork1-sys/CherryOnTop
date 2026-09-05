import { Readable } from 'node:stream';
import { buildExecutionJob } from '../k8s/job-manifest.js';
import { createJob, waitForJobCompletion, deleteJob, streamJobLogs } from '../k8s/client.js';
import { createEphemeralSecret, deleteSecret } from '../k8s/secrets.js';
import { buildEgressAllowlistPolicy, applyNetworkPolicy } from '../k8s/network-policy.js';
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
    // ponytail: the policy is per-node and outlives the step, so policies
    // accumulate one per node for the cluster's lifetime. Garbage-collect them
    // when a node reaches COMPLETE if that count ever matters.
    const policy = buildEgressAllowlistPolicy(input.nodeId, DEFAULT_EGRESS_ALLOWLIST);
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

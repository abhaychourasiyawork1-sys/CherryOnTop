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

const DEFAULT_EGRESS_ALLOWLIST = [
  { ip: '0.0.0.0/0', ports: [443] }, // ponytail: wide-open :443 until per-provider CIDRs are configured; tighten before this leaves Phase 2.
];

export async function executeStep(
  input: ExecuteStepInput,
  deps: Partial<ExecuteStepDeps> = {},
): Promise<ExecuteStepResult> {
  const d = { ...defaultDeps, ...deps };

  const secretName = await d.createEphemeralSecret(input.nodeId, input.credentials, input.namespace);
  try {
    const policy = buildEgressAllowlistPolicy(input.nodeId, DEFAULT_EGRESS_ALLOWLIST);
    await d.applyNetworkPolicy(policy, input.namespace);

    const job = buildExecutionJob({
      nodeId: input.nodeId,
      namespace: input.namespace,
      image: RUNNER_IMAGE,
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

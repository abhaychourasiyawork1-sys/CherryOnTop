import { buildExecutionJob } from '../k8s/job-manifest.js';
import { createJob, waitForJobCompletion, deleteJob, streamJobLogs, followJobLogs } from '../k8s/client.js';
import { createEphemeralSecret, deleteSecret } from '../k8s/secrets.js';
import { buildEgressAllowlistPolicy, applyNetworkPolicy } from '../k8s/network-policy.js';
import { getKubeDnsClusterIp } from '../k8s/kind.js';
import type { RuntimeAdapter, StructuredEvent, ToolGrant } from '../adapters/adapter.js';
import { toolNamesFromEvent } from './tool-calls.js';
import { isToolAllowed } from '../engines/enforce-tools.js';
import { rateLimitFromEvents, describeRateLimit } from './rate-limit.js';
import { usageFromEvents } from './tokens.js';

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
  /** How long to wait for the Job. The default suits real work; planning passes
   *  a much shorter bound, since a planner still thinking after a few minutes is
   *  costing more than the delegation it is deciding on could save. */
  timeoutMs?: number;
  /** What this node's contract permits. Passed to the adapter so the runtime
   *  refuses a forbidden call itself, and checked against the event stream here
   *  so a runtime that does not honour it is still caught. */
  grant?: ToolGrant;
  /** Called with any tool the stream shows being used outside the grant. The
   *  caller records it; this function does not decide what a violation means. */
  onViolation?: (tool: string) => void;
  /** Called once per structured event, as it arrives — not after the Job
   *  finishes. This is what makes live output possible; node-actor-manager.ts
   *  uses it to append to the DB and publish to the event bus in real time. */
  onEvent?: (event: StructuredEvent) => void;
  /** Per-dispatch model override (role-tiered by the caller). Omitted → runtime default. */
  model?: string;
  /** Hard turn cap for this dispatch. */
  maxTurns?: number;
  /** Appended to the runtime's system prompt. */
  systemPrompt?: string;
}

export interface ExecuteStepResult {
  succeeded: boolean;
  message: string;
  events: StructuredEvent[];
  /** Set by delegation when the goal turned out not to split into independent
   *  pieces. Distinct from a failure: nothing went wrong, delegation was simply
   *  the wrong call, and the node should do the work itself instead of retrying
   *  the same decision. */
  notDelegatable?: boolean;
  /** Token counts for this dispatch, read from the runtime's final result
   *  event. All zeros when the runtime reported none. */
  usage: import('./tokens.js').DispatchUsage;
}

export interface ExecuteStepDeps {
  createEphemeralSecret: typeof createEphemeralSecret;
  deleteSecret: typeof deleteSecret;
  applyNetworkPolicy: typeof applyNetworkPolicy;
  createJob: typeof createJob;
  waitForJobCompletion: typeof waitForJobCompletion;
  deleteJob: typeof deleteJob;
  followJobLogs: typeof followJobLogs;
  streamJobLogs: typeof streamJobLogs;
  getKubeDnsClusterIp: typeof getKubeDnsClusterIp;
}

const defaultDeps: ExecuteStepDeps = {
  createEphemeralSecret, deleteSecret, applyNetworkPolicy, createJob,
  waitForJobCompletion, deleteJob, followJobLogs, streamJobLogs, getKubeDnsClusterIp,
};

// Local tag, not a registry reference: no GHCR account is needed to use this
// tool on your own machine. Build and load it with ./scripts/build-runner-image.sh.
const RUNNER_IMAGE = 'cherryontop-runner:local';

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

/** The runtime's own account of why it failed. A refused request outranks the
 *  generic result text: the runtime reports an exhausted quota as "Request timed
 *  out", which is both wrong and the kind of wrong that sends you to debug the
 *  network. */
function runtimeError(events: StructuredEvent[]): string | null {
  const limited = rateLimitFromEvents(events);
  if (limited) return describeRateLimit(limited);

  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.type !== 'result') continue;
    const payload = event.payload as { is_error?: boolean; result?: unknown; subtype?: unknown } | null;
    if (!payload?.is_error) return null;
    const text = typeof payload.result === 'string' ? payload.result : String(payload.subtype ?? '');
    return text.trim() ? text.trim() : null;
  }
  return null;
}

export async function executeStep(
  input: ExecuteStepInput,
  deps: Partial<ExecuteStepDeps> = {},
): Promise<ExecuteStepResult> {
  const d = { ...defaultDeps, ...deps };

  const secretName = await d.createEphemeralSecret(input.nodeId, input.credentials, input.namespace);
  try {
    // The policy is per-node, not per-step, so it outlives this call; the node's
    // terminal transition deletes it (k8s/cleanup.ts).
    const dnsIp = await d.getKubeDnsClusterIp();
    const policy = buildEgressAllowlistPolicy(input.nodeId, DEFAULT_EGRESS_ALLOWLIST, [
      { to: [{ ipBlock: { cidr: `${dnsIp}/32` } }], ports: [{ port: 53, protocol: 'UDP' }, { port: 53, protocol: 'TCP' }] },
    ]);
    await d.applyNetworkPolicy(policy, input.namespace);

    const job = buildExecutionJob({
      nodeId: input.nodeId,
      namespace: input.namespace,
      image: input.image ?? RUNNER_IMAGE,
      command: input.adapter.buildCommand(input.goal, input.grant, {
        model: input.model,
        maxTurns: input.maxTurns,
        systemPrompt: input.systemPrompt,
      }),
      worktreePath: input.worktreePath,
      secretName,
      includeOauthCredentials: 'CLAUDE_CREDENTIALS_JSON' in input.credentials,
    });

    const jobName = await d.createJob(job);
    try {
      const collected: StructuredEvent[] = [];
      // Counts every raw line, parseable or not, so the post-completion backfill
      // can resume at the right offset.
      let linesSeen = 0;
      // Reported once per tool, not once per call: a node that loops on a
      // forbidden tool would otherwise write a thousand identical rows.
      const reported = new Set<string>();
      const consume = (line: string) => {
        linesSeen++;
        const event = input.adapter.parseLine(line);
        if (!event) return;
        collected.push(event);
        if (input.grant?.allowedTools) {
          for (const tool of toolNamesFromEvent(event)) {
            if (isToolAllowed({ tools: input.grant.allowedTools }, tool) || reported.has(tool)) continue;
            reported.add(tool);
            input.onViolation?.(tool);
          }
        }
        input.onEvent?.(event);
      };

      // A log stream that cannot be attached is a degraded live view, not a
      // failed step: the post-completion backfill below still recovers every
      // event, so never let it take the whole dispatch down with it.
      const stopFollowing = await d.followJobLogs(jobName, input.namespace, consume)
        .catch((err) => {
          console.error(`Live log streaming unavailable for ${jobName}:`, err);
          return () => {};
        });

      let jobResult;
      try {
        jobResult = await d.waitForJobCompletion(jobName, input.namespace, input.timeoutMs);
      } finally {
        stopFollowing();
      }

      // The follow stream replays the log from the container's first byte before
      // it starts following, so whatever it delivers is always a *prefix* of the
      // full log — attaching late loses nothing. What it can lose is the tail:
      // the API server closes a followed log stream early (a known upstream
      // quirk). One historical fetch before the Job is deleted backfills from
      // exactly where the live stream stopped, so `events` is the complete
      // record even when the live view was not.
      const rawLogs = await d.streamJobLogs(jobName, input.namespace).catch(() => '');
      const allLines = rawLogs ? rawLogs.split('\n') : [];
      if (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop();
      if (allLines.length > linesSeen) {
        for (const line of allLines.slice(linesSeen)) consume(line);
      }

      // "Job failed — see pod logs" is true and useless. The runtime's own final
      // `result` event carries what actually went wrong ("Request timed out",
      // a rate limit, an auth error); preferring it is the difference between a
      // reader knowing the cause and going to dig through kubectl.
      return {
        succeeded: jobResult.succeeded,
        message: jobResult.succeeded ? jobResult.message : (runtimeError(collected) ?? jobResult.message),
        events: collected,
        usage: usageFromEvents(collected),
      };
    } finally {
      await d.deleteJob(jobName, input.namespace);
    }
  } finally {
    await d.deleteSecret(secretName, input.namespace);
  }
}

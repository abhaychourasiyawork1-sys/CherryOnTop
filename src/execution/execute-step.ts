import { buildExecutionJob } from '../k8s/job-manifest.js';
import { createJob, waitForJobCompletion, deleteJob, streamJobLogs, followJobLogs, attachStdin } from '../k8s/client.js';
import { createSessionController, type SessionController, type SessionSummary } from '../system1/model-session-controller.js';
import type { GatewayReply, ModelGateway } from '../system1/model-gateway.js';
import { createEphemeralSecret, deleteSecret } from '../k8s/secrets.js';
import { buildEgressAllowlistPolicy, applyNetworkPolicy } from '../k8s/network-policy.js';
import { getKubeDnsClusterIp, fromContainerPath } from '../k8s/kind.js';
import { gitMounts, toolchainMounts, SANDBOX_ENV } from '../k8s/sandbox-env.js';
import type { RuntimeAdapter, StructuredEvent, ToolGrant } from '../adapters/adapter.js';
import { toolNamesFromEvent } from './tool-calls.js';
import { isToolAllowed } from '../engines/enforce-tools.js';
import { rateLimitFromEvents, describeRateLimit } from './rate-limit.js';
import { usageFromEvents, recoveredUsage } from './tokens.js';
import { estimateCostUsd } from './pricing.js';

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
  /** Stop the Job once this dispatch's live, estimated spend reaches this
   *  many dollars. What bounds a run now that there is no wall-clock limit on
   *  it: the task's spend guard is only consulted *between* dispatches, so
   *  without this a single unbounded dispatch could spend past the task's
   *  budget before anything checked. */
  spendLimitUsd?: number;
  /** Run as a stdin-fed session so the model can ask CherryOnTop for a private
   *  decision (`<cto_decide>`) and continue in the same process. Ignored by an
   *  adapter that cannot hold a session. */
  session?: {
    gateway: ModelGateway;
    maxDecisionTurns: number;
    onDecision?: (reply: GatewayReply, turn: number) => void;
  };
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
  /** The runtime refused this dispatch because the account's usage window is
   *  spent, not because anything about the goal or the sandbox was wrong.
   *  Retrying immediately is guaranteed to fail the same way — the window
   *  does not refill between attempts a few minutes apart — so this is what
   *  the node machine's retry loop checks before spending another attempt. */
  rateLimited?: boolean;
  /** Token counts for this dispatch, read from the runtime's final result
   *  event. All zeros when the runtime reported none. */
  usage: import('./tokens.js').DispatchUsage;
  /** Milliseconds from asking the cluster for a Job to the runtime's first
   *  structured event: scheduling, image pull, container start and agent boot,
   *  all of which is spent before any work happens.
   *
   *  Telemetry, and only telemetry. Whether warm pools, snapshots or workspace
   *  forks are worth their complexity is a question about how large this is
   *  relative to the dispatch it sits inside, and nothing measured it before —
   *  so the argument was being had from architecture enthusiasm rather than
   *  from a number. Measuring it enables nothing on its own, which is the
   *  point.
   *
   *  Absent on a synthetic result — a delegation that never opened a sandbox has
   *  no startup time, and reporting 0 there would flatter the ratio with runs
   *  that never ran. */
  startupMs?: number;
  /** Present when the dispatch ran as a decision-capable session. */
  session?: SessionSummary;
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
  attachStdin: typeof attachStdin;
}

const defaultDeps: ExecuteStepDeps = {
  createEphemeralSecret, deleteSecret, applyNetworkPolicy, createJob,
  waitForJobCompletion, deleteJob, followJobLogs, streamJobLogs, getKubeDnsClusterIp, attachStdin,
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

/** A session nobody can feed. The Job has already been cleaned up by the time
 *  this reaches `executeStep`, which reruns the step without one. */
class SessionUnavailable extends Error {
  constructor(jobName: string, cause: unknown) {
    super(`could not attach to ${jobName}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'SessionUnavailable';
  }
}

export async function executeStep(
  input: ExecuteStepInput,
  deps: Partial<ExecuteStepDeps> = {},
): Promise<ExecuteStepResult> {
  try {
    return await runStep(input, deps);
  } catch (err) {
    if (!(err instanceof SessionUnavailable)) throw err;
    // The capability degrades; the work does not. A session nobody can feed
    // would wait on stdin until the timeout, so the same step runs once more as
    // an ordinary one-shot dispatch.
    console.error(`${err.message}; running without a decision session`);
    return runStep({ ...input, session: undefined }, deps);
  }
}

async function runStep(
  input: ExecuteStepInput,
  deps: Partial<ExecuteStepDeps>,
): Promise<ExecuteStepResult> {
  const d = { ...defaultDeps, ...deps };
  const sessionMode = input.session !== undefined && input.adapter.supportsSession === true;

  const secretName = await d.createEphemeralSecret(input.nodeId, input.credentials, input.namespace);
  try {
    // The policy is per-node, not per-step, so it outlives this call; the node's
    // terminal transition deletes it (k8s/cleanup.ts).
    const dnsIp = await d.getKubeDnsClusterIp();
    // DNS is allowed to the kube-dns *pods* by label as well as to the Service
    // IP. The Service IP is rewritten to a CoreDNS pod IP (10.244.x.x) before
    // the policy is evaluated, and that address sits inside the blocked
    // 10.0.0.0/8, so the IP-only rule let ~5% of lookups through (measured:
    // 2/40). Every model call retried its way past it, which made each sandbox
    // turn ~5x slower than the same turn on the host, and package installs
    // simply failed. By label it is 40/40 and survives CoreDNS restarts.
    const policy = buildEgressAllowlistPolicy(input.nodeId, DEFAULT_EGRESS_ALLOWLIST, [
      {
        to: [
          { ipBlock: { cidr: `${dnsIp}/32` } },
          {
            namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
            podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
          },
        ],
        ports: [{ port: 53, protocol: 'UDP' }, { port: 53, protocol: 'TCP' }],
      },
    ]);
    await d.applyNetworkPolicy(policy, input.namespace);

    const worktreeHost = fromContainerPath(input.worktreePath);
    const toolchain = toolchainMounts();
    const job = buildExecutionJob({
      env: [...SANDBOX_ENV, ...toolchain.env],
      extraMounts: [...(worktreeHost ? gitMounts(worktreeHost) : []), ...toolchain.mounts],
      nodeId: input.nodeId,
      namespace: input.namespace,
      image: input.image ?? RUNNER_IMAGE,
      command: input.adapter.buildCommand(input.goal, input.grant, {
        model: input.model,
        maxTurns: input.maxTurns,
        systemPrompt: input.systemPrompt,
        ...(sessionMode ? { session: true } : {}),
      }),
      worktreePath: input.worktreePath,
      secretName,
      includeOauthCredentials: 'CLAUDE_CREDENTIALS_JSON' in input.credentials,
      ...(sessionMode ? { interactive: true } : {}),
    });

    const jobName = await d.createJob(job);
    let controller: SessionController | undefined;
    let stoppedForSpend = false;
    try {
      if (sessionMode) {
        try {
          const channel = await d.attachStdin(jobName, input.namespace);
          controller = createSessionController({
            gateway: input.session!.gateway,
            transport: channel,
            maxDecisionTurns: input.session!.maxDecisionTurns,
            onDecision: input.session!.onDecision,
          });
          controller.start(input.goal);
        } catch (err) {
          throw new SessionUnavailable(jobName, err);
        }
      }
      const requestedAt = Date.now();
      // The first event is the first evidence the agent is actually running.
      // Null until then, so a Job that produced nothing is charged the whole
      // dispatch rather than a flattering zero.
      let firstEventAt: number | null = null;
      const collected: StructuredEvent[] = [];
      // Counts every raw line, parseable or not, so the post-completion backfill
      // can resume at the right offset.
      let linesSeen = 0;
      // Reported once per tool, not once per call: a node that loops on a
      // forbidden tool would otherwise write a thousand identical rows.
      const reported = new Set<string>();
      // Live spend, from per-step usage as it streams (each API response
      // counted once). An estimate, and deliberately a slight under-estimate:
      // per-step output tokens are placeholders. It only has to catch a run
      // walking past its budget, not bill it.
      const spendSeen = new Set<string>();
      const spendUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
      let spendModel: string | undefined;
      const watchSpend = (event: StructuredEvent) => {
        if (input.spendLimitUsd === undefined || stoppedForSpend || event.type !== 'assistant') return;
        const p = event.payload as { parent_tool_use_id?: unknown; message?: { id?: unknown; model?: unknown; usage?: Record<string, number> } } | null;
        const id = p?.message?.id;
        if (typeof id !== 'string' || spendSeen.has(id)) return;
        spendSeen.add(id);
        const u = p?.message?.usage ?? {};
        spendUsage.inputTokens += u.input_tokens ?? 0;
        spendUsage.outputTokens += u.output_tokens ?? 0;
        spendUsage.cacheReadTokens += u.cache_read_input_tokens ?? 0;
        spendUsage.cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
        if (typeof p?.message?.model === 'string') spendModel = p.message.model;
        if (estimateCostUsd(spendUsage, spendModel) >= input.spendLimitUsd) {
          stoppedForSpend = true;
          controller?.closeInput();
          // Deleting the Job is what stops the pod; the wait below then reads
          // the 404 as a cancellation and the result says why.
          void d.deleteJob(jobName, input.namespace).catch(() => {});
        }
      };
      const consume = (line: string) => {
        linesSeen++;
        const parsed = input.adapter.parseLine(line);
        if (!parsed) return;
        watchSpend(parsed);
        // Frames are scrubbed and turn results re-typed *before* anything else
        // sees the event: the transcript, the tool check and the collected
        // record all get the same, clean stream.
        const event = controller ? controller.process(parsed) : parsed;
        firstEventAt ??= Date.now();
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
      // A session is steered by the live stream. If that stream is lost, or
      // never attaches, stdin is closed: the runtime finishes the turn it is on
      // and exits, which is exactly a one-shot dispatch, rather than waiting for
      // an answer nobody can see it ask for.
      const stopFollowing = await d.followJobLogs(jobName, input.namespace, consume, undefined, () => controller?.closeInput())
        .catch((err) => {
          console.error(`Live log streaming unavailable for ${jobName}:`, err);
          controller?.closeInput();
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
      // Nothing arriving from here on can still be answered.
      controller?.closeInput();
      const rawLogs = await d.streamJobLogs(jobName, input.namespace).catch(() => '');
      const allLines = rawLogs ? rawLogs.split('\n') : [];
      if (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop();
      if (allLines.length > linesSeen) {
        for (const line of allLines.slice(linesSeen)) consume(line);
      }
      const finished = controller?.finish();
      if (finished?.synthetic) collected.push(finished.synthetic);
      // A run stopped before its final `result` (spend watchdog, wall clock,
      // crash) still spent money, and every reader of spend (the spend guard,
      // the ledger, `org tokens`) reads it from a result event. Without one the
      // spend was invisible: measured, delegated children overran their share
      // because each killed attempt counted as $0. Recovered from per-step
      // usage and priced at list rates; empty `result`, `is_error: true`.
      if (!collected.some((event) => event.type === 'result')) {
        const recovered = recoveredUsage(collected);
        if (recovered.usage.numTurns > 0) {
          const synthetic: StructuredEvent = {
            type: 'result',
            payload: {
              type: 'result', subtype: 'error_stopped_before_result', is_error: true, result: '',
              session_id: `recovered-${jobName}`,
              num_turns: recovered.usage.numTurns,
              usage: {
                input_tokens: recovered.usage.inputTokens, output_tokens: recovered.usage.outputTokens,
                cache_read_input_tokens: recovered.usage.cacheReadTokens,
                cache_creation_input_tokens: recovered.usage.cacheCreationTokens,
              },
              total_cost_usd: estimateCostUsd(recovered.usage, recovered.model),
            },
          };
          collected.push(synthetic);
          input.onEvent?.(synthetic);
        }
      }

      // "Job failed — see pod logs" is true and useless. The runtime's own final
      // `result` event carries what actually went wrong ("Request timed out",
      // a rate limit, an auth error); preferring it is the difference between a
      // reader knowing the cause and going to dig through kubectl.
      return {
        succeeded: jobResult.succeeded,
        message: stoppedForSpend
          ? `Stopped: this run reached its $${input.spendLimitUsd!.toFixed(2)} spend limit`
          : jobResult.succeeded ? jobResult.message : (runtimeError(collected) ?? jobResult.message),
        events: collected,
        usage: usageFromEvents(collected),
        startupMs: Math.max(0, (firstEventAt ?? Date.now()) - requestedAt),
        rateLimited: !jobResult.succeeded && rateLimitFromEvents(collected) !== null,
        ...(finished ? { session: finished.summary } : {}),
      };
    } finally {
      controller?.closeInput();
      // Already gone if the spend watchdog stopped it.
      await d.deleteJob(jobName, input.namespace).catch((err) => { if (!stoppedForSpend) throw err; });
    }
  } finally {
    await d.deleteSecret(secretName, input.namespace);
  }
}

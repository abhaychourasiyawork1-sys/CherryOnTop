/** `anthropic-owned`: the agent loop runs here, in the daemon, against the
 *  Messages API; only tool commands cross into the sandbox.
 *
 *  Selected explicitly (`ORG_RUNTIME=anthropic-owned`, see
 *  `availableAdapters`), never by default: Claude Code stays the runtime until
 *  the owned loop has passed its benchmark gates.
 *
 *  The API key stays in this process. The sandbox gets the credentials a task
 *  needs to act in the world (git identity, a granted GitHub login) and never
 *  a model credential: nothing in it calls a model any more. */
import { execa } from 'execa';
import type { RuntimeAdapter, BuildCommandOptions, ToolGrant } from './adapter.js';
import { claudeCodeAdapter } from './claude-code.js';
import type { ExecuteStepInput, ExecuteStepResult } from '../execution/execute-step.js';
import { sandboxNetworkPolicy } from '../execution/execute-step.js';
import { containerTarget, refreshMirror } from '../execution/container-exec.js';
import { buildExecutionJob } from '../k8s/job-manifest.js';
import { createJob, deleteJob } from '../k8s/client.js';
import { createEphemeralSecret, deleteSecret } from '../k8s/secrets.js';
import { applyNetworkPolicy } from '../k8s/network-policy.js';
import { getKubeDnsClusterIp, fromContainerPath } from '../k8s/kind.js';
import { gitMounts, toolchainMounts, dependencyMounts, SANDBOX_ENV } from '../k8s/sandbox-env.js';
import { InfoSession } from '../infocontrol/controller.js';
import { AnthropicModelClient, anthropicConfigured } from '../agent/anthropic-model-client.js';
import { resolveModelId, type ModelClient } from '../agent/model-client.js';
import { containerSandbox, podSandbox, workdirSnapshot, type Sandbox } from '../agent/sandbox.js';
import { ToolBroker } from '../agent/tools.js';
import { ownedPrices, runAgentSession, type SessionState } from '../agent/loop.js';
import { ZERO_USAGE } from '../execution/tokens.js';
import { toolNamesFromEvent } from '../execution/tool-calls.js';
import { isToolAllowed } from '../engines/enforce-tools.js';

const RUNNER_IMAGE = 'cherryontop-runner:local';
const POD_READY_TIMEOUT_MS = 300_000;

/** Same families and effort levels as the Claude Code harness: which one runs
 *  is the Action Market's decision. */
const MODELS = ['haiku', 'sonnet', 'opus', 'fable'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface OwnedDeps {
  client(): ModelClient;
  sandbox(input: ExecuteStepInput): Promise<Sandbox>;
}

/** A model credential never travels to the sandbox. */
export function sandboxCredentials(credentials: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(credentials).filter(([k]) => !k.startsWith('ANTHROPIC_') && !k.startsWith('CLAUDE_')));
}

/** A Kubernetes pod that idles while the loop execs tools into it. Same image,
 *  mounts, security context and egress policy as a Claude Code Job; it simply
 *  runs `sleep` instead of an agent. */
export async function startPodSandbox(input: ExecuteStepInput): Promise<Sandbox> {
  const secretName = await createEphemeralSecret(input.nodeId, sandboxCredentials(input.credentials), input.namespace);
  let jobName: string | undefined;
  const close = async () => {
    if (jobName) await deleteJob(jobName, input.namespace).catch(() => {});
    await deleteSecret(secretName, input.namespace).catch(() => {});
  };
  try {
    await applyNetworkPolicy(sandboxNetworkPolicy(input.nodeId, await getKubeDnsClusterIp()), input.namespace);
    const worktreeHost = fromContainerPath(input.worktreePath);
    const toolchain = toolchainMounts();
    jobName = await createJob(buildExecutionJob({
      env: [...SANDBOX_ENV, ...toolchain.env],
      extraMounts: [
        ...(worktreeHost ? gitMounts(worktreeHost) : []),
        ...(worktreeHost ? dependencyMounts(worktreeHost) : []),
        ...toolchain.mounts,
      ],
      nodeId: input.nodeId,
      namespace: input.namespace,
      image: input.image ?? RUNNER_IMAGE,
      // Outlives any dispatch; the Job is deleted when the dispatch ends.
      command: ['sh', '-c', 'trap "exit 0" TERM; sleep 86400 & wait'],
      worktreePath: input.worktreePath,
      secretName,
    }));
    const pod = await waitForPod(jobName, input.namespace);
    return podSandbox({ name: pod, namespace: input.namespace, container: 'runner', workdir: '/workspace' }, close);
  } catch (err) {
    await close();
    throw err;
  }
}

async function waitForPod(jobName: string, namespace: string): Promise<string> {
  const deadline = Date.now() + POD_READY_TIMEOUT_MS;
  for (;;) {
    const { stdout } = await execa('kubectl', ['get', 'pod', '-n', namespace, '-l', `job-name=${jobName}`, '-o', 'jsonpath={.items[0].metadata.name}'], { reject: false });
    const name = stdout.trim();
    if (name) {
      const wait = await execa('kubectl', ['wait', '-n', namespace, '--for=condition=Ready', `pod/${name}`, `--timeout=${Math.max(1, Math.round((deadline - Date.now()) / 1000))}s`], { reject: false });
      if (wait.exitCode === 0) return name;
      throw new Error(`sandbox pod ${name} did not become ready: ${wait.stderr.trim()}`);
    }
    if (Date.now() > deadline) throw new Error(`no pod appeared for ${jobName}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const defaultDeps: OwnedDeps = {
  client: () => new AnthropicModelClient(),
  sandbox: async (input) => {
    const target = containerTarget();
    return target ? containerSandbox(target) : startPodSandbox(input);
  },
};

/** Trajectory tracking with nothing recorded and nothing changed: what the
 *  loop recites at compaction when no controller session was opened for it. */
export function quietState(goal: string, model: string, nodeId: string): SessionState {
  const session = new InfoSession({
    nodeId, taskRootId: nodeId, role: 'execute', goal, mode: 'off', disabled: new Set(), prices: ownedPrices(model),
    confidence: 0.5, taskValueUsd: 0, beliefs: new Map(), pastTurns: [], finish: { failed: 0, finished: 0 }, negatives: [], revision: null,
  }, { emit: () => {} });
  return {
    handle: (p) => session.handle(p), activeState: () => session.activeState(),
    progressSignature: () => session.progressSignature(), observeEvent: (e) => session.observeEvent(e),
  };
}

function failed(message: string): ExecuteStepResult {
  return { succeeded: false, message, events: [], usage: { ...ZERO_USAGE } };
}

export function createOwnedAdapter(deps: OwnedDeps = defaultDeps, configured: () => boolean = anthropicConfigured): RuntimeAdapter {
  return {
    name: 'anthropic-owned',
    supportsSession: false,
    discoverCapabilities: () => ({ models: MODELS, efforts: EFFORTS }),
    servesModel: claudeCodeAdapter.servesModel,

    // Describes the dispatch; nothing executes it. Capability probing reads
    // it (does a model / a system prompt survive into the dispatch?).
    buildCommand(goal: string, _grant?: ToolGrant, opts: BuildCommandOptions = {}): string[] {
      return ['cherryontop-owned',
        ...(opts.model ? ['--model', opts.model] : []), ...(opts.effort ? ['--effort', opts.effort] : []),
        ...(opts.maxTurns ? ['--max-turns', String(opts.maxTurns)] : []),
        ...(opts.systemPrompt ? ['--append-system-prompt', opts.systemPrompt] : []), goal];
    },
    parseLine: claudeCodeAdapter.parseLine,
    parseEventStream: claudeCodeAdapter.parseEventStream,

    async run(input: ExecuteStepInput): Promise<ExecuteStepResult> {
      if (!configured()) return failed('The anthropic-owned runtime needs ANTHROPIC_API_KEY in the daemon environment');
      const model = resolveModelId(input.model);
      const requestedAt = Date.now();
      let sandbox: Sandbox;
      try {
        sandbox = await deps.sandbox(input);
      } catch (err) {
        return failed(`Could not start the sandbox: ${err instanceof Error ? err.message : String(err)}`);
      }
      const startupMs = Date.now() - requestedAt;
      const state = input.inProcessInfoControl ?? quietState(input.goal, model, input.nodeId);
      const reported = new Set<string>();
      const abort = new AbortController();
      const timer = input.timeoutMs && Number.isFinite(input.timeoutMs) ? setTimeout(() => abort.abort(), input.timeoutMs) : undefined;
      const client = deps.client();
      const orientation = await workdirSnapshot(sandbox);
      const envNumber = (name: string) => (process.env[name]?.trim() && Number.isFinite(Number(process.env[name])) ? Number(process.env[name]) : undefined);
      const thinkingBudget = envNumber('ORG_OWNED_THINKING_BUDGET');
      const refusalCap = envNumber('ORG_OWNED_REFUSAL_CAP');
      const shared = {
        workdir: sandbox.workdir, orientation, model, client,
        ...(input.effort ? { effort: input.effort } : {}),
        ...(thinkingBudget !== undefined ? { thinkingBudget } : {}),
        pricedCompaction: process.env.ORG_OWNED_COMPACTION !== 'window',
        recite: process.env.ORG_OWNED_RECITE !== 'off',
        webSearch: process.env.ORG_OWNED_WEB_SEARCH !== 'off',
        confirmFinish: process.env.ORG_OWNED_CONFIRM_FINISH !== 'off',
        signal: abort.signal,
      };
      // Claude Code's Task tool: a sub-agent with a fresh context in the same
      // sandbox, under the same mandate, bounded by what is left of the
      // parent's spend limit. It cannot spawn sub-agents of its own.
      const subagent = async (prompt: string, toolUseId: string, budget: { remainingUsd?: number }) => {
        const childState = quietState(prompt, model, `${input.nodeId}:${toolUseId}`);
        const child = await runAgentSession({
          ...shared,
          sessionId: `owned-${input.nodeId}-${requestedAt}-sub-${toolUseId}`,
          goal: prompt,
          broker: new ToolBroker({ sandbox, ...(input.grant ? { grant: input.grant } : {}), infoControl: childState, ...(refusalCap !== undefined ? { refusalCap } : {}) }),
          state: childState,
          ...(budget.remainingUsd !== undefined ? { spendLimitUsd: budget.remainingUsd } : {}),
        });
        return { text: child.finalText || (child.events.at(-1)?.payload as { result?: string } | undefined)?.result || '', failed: !child.succeeded, usage: child.usage, costUsd: child.costUsd, events: child.events };
      };
      try {
        const result = await runAgentSession({
          sessionId: `owned-${input.nodeId}-${requestedAt}`,
          goal: input.goal,
          ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
          ...shared,
          broker: new ToolBroker({
            sandbox, ...(input.grant ? { grant: input.grant } : {}), infoControl: state,
            ...(refusalCap !== undefined ? { refusalCap } : {}),
            ...(process.env.ORG_OWNED_SUBAGENTS !== 'off' ? { subagent } : {}),
          }),
          state,
          ...(input.maxTurns ? { maxTurns: input.maxTurns } : {}),
          ...(input.spendLimitUsd !== undefined ? { spendLimitUsd: input.spendLimitUsd } : {}),
          onEvent: (event) => {
            // The broker refuses a forbidden call before it runs; the request
            // is still reported, as a Claude Code dispatch's would be.
            if (input.grant?.allowedTools) {
              for (const tool of toolNamesFromEvent(event)) {
                if (isToolAllowed({ tools: input.grant.allowedTools }, tool) || reported.has(tool)) continue;
                reported.add(tool);
                input.onViolation?.(tool);
              }
            }
            input.onEvent?.(event);
          },
        });
        const final = result.events.at(-1)?.payload as { result?: string } | undefined;
        return {
          succeeded: result.succeeded,
          message: result.succeeded ? 'completed' : (final?.result ?? result.stop),
          events: result.events,
          usage: result.usage,
          startupMs,
          rateLimited: result.error?.kind === 'rate_limit',
        };
      } finally {
        if (timer) clearTimeout(timer);
        await sandbox.close().catch(() => {});
        const target = containerTarget();
        if (target) await refreshMirror(target).catch((err) => console.error(`Could not refresh the host mirror from ${target.container}:`, err));
      }
    },
  };
}

export const anthropicOwnedAdapter = createOwnedAdapter();

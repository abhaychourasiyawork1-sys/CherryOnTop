/** A dispatch run inside an existing container instead of a Kubernetes Job.
 *
 *  For environments that own their sandbox, a benchmark's task container being
 *  the case this exists for: the task's tools, services and files live in that
 *  container, and nothing else can stand in for it. `docker exec` runs the same
 *  runtime command the Job would, in the container's work directory, and the
 *  stream is consumed exactly as the Job's log stream is: same parsing, same
 *  decision session, same information control, same spend watchdog.
 *
 *  The host keeps a git mirror of the work directory (`ORG_EXEC_MIRROR`),
 *  refreshed after every dispatch, because the lifecycle's own bookkeeping
 *  (what changed, auto-commit, the repository map) reads a host worktree.
 *  Nothing on the host executes task commands. Validation reads the trace.
 *
 *  Configured by environment, for a daemon dedicated to one container:
 *    ORG_EXEC_CONTAINER  container name or id
 *    ORG_SANDBOX_WORKDIR work directory inside it (default /app)
 *    ORG_EXEC_MIRROR     host mirror to refresh after each dispatch (optional)
 *    ORG_DOCKER          docker binary (default `docker`)
 *    ORG_EXEC_USER       user to run as (the one the runtime was installed for)
 *    ORG_EXEC_PATH       PATH inside the container (a non-login exec does not read
 *                        the profile that puts an installed CLI on it) */
import { execa } from 'execa';
import { createInterface } from 'node:readline';
import type { StructuredEvent } from '../adapters/adapter.js';
import { createSessionController, type SessionController } from '../system1/model-session-controller.js';
import { toolNamesFromEvent } from './tool-calls.js';
import { isToolAllowed } from '../engines/enforce-tools.js';
import { rateLimitFromEvents } from './rate-limit.js';
import { usageFromEvents, recoveredUsage } from './tokens.js';
import { estimateCostUsd } from './pricing.js';
import type { ExecuteStepInput, ExecuteStepResult } from './execute-step.js';
import { runtimeError } from './execute-step.js';

export interface ContainerTarget { container: string; workdir: string; mirror?: string; docker: string; path?: string; user?: string }

export function containerTarget(env: NodeJS.ProcessEnv = process.env): ContainerTarget | null {
  const container = env.ORG_EXEC_CONTAINER?.trim();
  if (!container) return null;
  return {
    container, workdir: env.ORG_SANDBOX_WORKDIR ?? '/app', docker: env.ORG_DOCKER ?? 'docker',
    ...(env.ORG_EXEC_MIRROR ? { mirror: env.ORG_EXEC_MIRROR } : {}),
    ...(env.ORG_EXEC_PATH ? { path: env.ORG_EXEC_PATH } : {}),
    ...(env.ORG_EXEC_USER ? { user: env.ORG_EXEC_USER } : {}),
  };
}

/** Replaces the mirror's tree (not its .git) with the container's work directory. */
export async function refreshMirror(target: ContainerTarget): Promise<void> {
  if (!target.mirror) return;
  await execa('find', [target.mirror, '-mindepth', '1', '-maxdepth', '1', '!', '-name', '.git', '-exec', 'rm', '-rf', '{}', '+']);
  await execa(target.docker, ['cp', `${target.container}:${target.workdir}/.`, target.mirror]);
}

export async function runInContainer(
  input: ExecuteStepInput,
  target: ContainerTarget,
): Promise<ExecuteStepResult> {
  const sessionMode = input.session !== undefined && input.adapter.supportsSession === true;
  const command = input.adapter.buildCommand(input.goal, input.grant, {
    model: input.model,
    ...(input.effort ? { effort: input.effort } : {}),
    maxTurns: input.maxTurns,
    systemPrompt: input.systemPrompt,
    ...(sessionMode ? { session: true } : {}),
    ...(input.infoControl ? { settings: input.infoControl.settings } : {}),
  });
  const requestedAt = Date.now();
  // IS_SANDBOX: Claude Code's own signal that it runs inside a sandbox, which is
  // what lets bypass-permissions mode run as root (task containers usually are
  // root). The same flag Harbor's own claude-code agent sets.
  const env = ['-e', 'IS_SANDBOX=1', ...(target.path ? ['-e', `PATH=${target.path}`] : []), ...(target.user ? ['-u', target.user] : [])];
  const proc = execa(target.docker, ['exec', '-i', '-w', target.workdir, ...env, target.container, ...command], {
    reject: false, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', buffer: false,
    // Infinity is the runtime's "no wall clock"; execa only takes a finite bound.
    ...(input.timeoutMs && Number.isFinite(input.timeoutMs) ? { timeout: input.timeoutMs } : {}),
  });

  let controller: SessionController | undefined;
  if (sessionMode) {
    controller = createSessionController({
      gateway: input.session!.gateway,
      transport: { send: (line) => { proc.stdin?.write(`${line}\n`); }, end: () => { proc.stdin?.end(); } },
      maxDecisionTurns: input.session!.maxDecisionTurns,
      onDecision: input.session!.onDecision,
    });
    controller.start(input.goal);
  } else {
    proc.stdin?.end();
  }

  // Kept whole for the failure message: a runtime that cannot start says why only here.
  let stderr = '';
  proc.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8000); });
  const collected: StructuredEvent[] = [];
  const reported = new Set<string>();
  let firstEventAt: number | null = null;
  let stoppedForSpend = false;
  const spendSeen = new Set<string>();
  const spend = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  let spendModel: string | undefined;
  const watchSpend = (event: StructuredEvent) => {
    if (input.spendLimitUsd === undefined || stoppedForSpend || event.type !== 'assistant') return;
    const m = (event.payload as { message?: { id?: unknown; model?: unknown; usage?: Record<string, number> } } | null)?.message;
    if (typeof m?.id !== 'string' || spendSeen.has(m.id)) return;
    spendSeen.add(m.id);
    const u = m.usage ?? {};
    spend.inputTokens += u.input_tokens ?? 0;
    spend.outputTokens += u.output_tokens ?? 0;
    spend.cacheReadTokens += u.cache_read_input_tokens ?? 0;
    spend.cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
    if (typeof m.model === 'string') spendModel = m.model;
    if (estimateCostUsd(spend, spendModel) >= input.spendLimitUsd) {
      stoppedForSpend = true;
      controller?.closeInput();
      proc.kill('SIGTERM');
    }
  };

  for await (const line of createInterface({ input: proc.stdout!, crlfDelay: Infinity })) {
    const parsed = input.adapter.parseLine(line);
    // `docker exec` reports its own failures (no such binary, no such user) on
    // stdout, as plain text: keep them, or a failed start explains nothing.
    if (!parsed) { if (line.trim()) stderr = (stderr + line + '\n').slice(-8000); continue; }
    watchSpend(parsed);
    const event = controller ? controller.process(parsed) : parsed;
    firstEventAt ??= Date.now();
    collected.push(event);
    input.infoControl?.observeEvent(event);
    if (input.grant?.allowedTools) {
      for (const tool of toolNamesFromEvent(event)) {
        if (isToolAllowed({ tools: input.grant.allowedTools }, tool) || reported.has(tool)) continue;
        reported.add(tool);
        input.onViolation?.(tool);
      }
    }
    input.onEvent?.(event);
  }
  controller?.closeInput();
  const exit = await proc;
  const finished = controller?.finish();
  if (finished?.synthetic) collected.push(finished.synthetic);

  if (!collected.some((event) => event.type === 'result')) {
    const recovered = recoveredUsage(collected);
    if (recovered.usage.numTurns > 0) {
      const synthetic: StructuredEvent = {
        type: 'result',
        payload: {
          type: 'result', subtype: 'error_stopped_before_result', is_error: true, result: '',
          session_id: `recovered-${target.container}`, num_turns: recovered.usage.numTurns,
          usage: {
            input_tokens: recovered.usage.inputTokens, output_tokens: recovered.usage.outputTokens,
            cache_read_input_tokens: recovered.usage.cacheReadTokens, cache_creation_input_tokens: recovered.usage.cacheCreationTokens,
          },
          total_cost_usd: estimateCostUsd(recovered.usage, recovered.model),
        },
      };
      collected.push(synthetic);
      input.onEvent?.(synthetic);
    }
  }

  try {
    await refreshMirror(target);
  } catch (err) {
    console.error(`Could not refresh the host mirror from ${target.container}:`, err);
  }

  const succeeded = exit.exitCode === 0 && !stoppedForSpend && !exit.timedOut;
  const failure = exit.timedOut ? `Timed out after ${input.timeoutMs} ms`
    : (runtimeError(collected) ?? (stderr.trim().split('\n').slice(-3).join('\n') || `exited ${exit.exitCode}`));
  console.error(`Container dispatch in ${target.container}${target.user ? ` as ${target.user}` : ''}: exit ${exit.exitCode}${exit.timedOut ? ' (timed out)' : ''}, ${collected.length} events${stderr.trim() ? `; ${stderr.trim().slice(-500)}` : ''}`);
  return {
    succeeded,
    message: stoppedForSpend
      ? `Stopped: this run reached its $${input.spendLimitUsd!.toFixed(2)} spend limit`
      : succeeded ? (runtimeError(collected) === null ? 'completed' : runtimeError(collected)!) : failure,
    events: collected,
    usage: usageFromEvents(collected),
    startupMs: Math.max(0, (firstEventAt ?? Date.now()) - requestedAt),
    rateLimited: !succeeded && rateLimitFromEvents(collected) !== null,
    ...(finished ? { session: finished.summary } : {}),
  };
}

/** The private decision round trip through the real `executeStep`, with a
 *  scripted runtime standing in for Claude Code: it reads stream-json user
 *  messages from "stdin" and answers on "stdout" exactly as the CLI does in
 *  `--input-format stream-json` mode (one `result` per turn, exit on EOF). */
import { describe, it, expect, vi } from 'vitest';
import type { V1Job } from '@kubernetes/client-node';
import { executeStep } from './execute-step.js';
import { claudeCodeAdapter } from '../adapters/claude-code.js';
import { createModelGateway } from '../system1/model-gateway.js';
import { createSystem1 } from '../system1/guard.js';
import type { System1Provider } from '../system1/provider.js';
import type { DecisionRequest } from '../system1/types.js';
import type { StructuredEvent } from '../adapters/adapter.js';

const FRAME = '<cto_decide>{"type":"choice","question":"Which approach is lower risk?","options":[{"id":"A","description":"refactor"},{"id":"B","description":"new abstraction"}]}</cto_decide>';

function provider(): System1Provider & { decide: ReturnType<typeof vi.fn> } {
  return {
    name: 'laya',
    decide: vi.fn(async (rs: readonly DecisionRequest[]) => rs.map((r) => ({
      requestId: r.id, provider: 'laya' as const, surface: r.surface, primitive: r.primitive,
      result: { selectedId: 'A', probabilities: { A: 0.72, B: 0.28 } },
      calibration: { version: 'x' }, confidence: { provider: 0.4, orchestration: 0 },
      metadata: { model: 'typed-decisions', questionVersion: r.questionVersion, inputDigest: r.inputDigest, stateVersion: r.stateVersion, latencyMs: 2, inputTokens: 30 },
    }))),
  };
}

const line = (o: unknown) => JSON.stringify(o);
const assistantText = (text: string) => line({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const result = (text: string, input: number, cost: number) =>
  line({ type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1, usage: { input_tokens: input, output_tokens: 5 }, total_cost_usd: cost });

/** A fake cluster plus a fake Claude that asks one question, then answers. */
function cluster(options: { attachFails?: boolean } = {}) {
  const stdin: string[] = [];
  let onLine: (l: string) => void = () => {};
  let finish: () => void = () => {};
  const done = new Promise<void>((r) => { finish = r; });
  let turn = 0;
  const jobs: V1Job[] = [];
  const react = (message: string) => {
    const content = JSON.parse(message).message.content as string;
    turn++;
    // Answer asynchronously, like a process writing to a log.
    setTimeout(() => {
      if (turn === 1) {
        onLine(assistantText(`Two plausible approaches.\n${FRAME}`));
        onLine(result(`Two plausible approaches.\n${FRAME}`, 100, 0.01));
      } else {
        onLine(assistantText(`Going with refactor, per: ${content.split('\n')[1]}`));
        onLine(result('Refactored the parser.', 120, 0.025));
      }
    }, 0);
  };
  const deps = {
    createEphemeralSecret: vi.fn(async () => 'secret-1'),
    deleteSecret: vi.fn(async () => {}),
    applyNetworkPolicy: vi.fn(async () => {}),
    getKubeDnsClusterIp: vi.fn(async () => '10.96.0.10'),
    createJob: vi.fn(async (job: V1Job) => { jobs.push(job); return `job-${jobs.length}`; }),
    followJobLogs: vi.fn(async (_j: string, _n: string, cb: (l: string) => void) => { onLine = cb; return () => {}; }),
    waitForJobCompletion: vi.fn(async () => {
      // Text mode has no stdin to close, so it "finishes" on its own.
      if (!jobs.at(-1)?.spec?.template.spec?.containers[0].stdin) {
        onLine(result('done without a session', 10, 0.001));
        return { succeeded: true, message: 'ok' };
      }
      await done;
      return { succeeded: true, message: 'ok' };
    }),
    streamJobLogs: vi.fn(async () => ''),
    deleteJob: vi.fn(async () => {}),
    attachStdin: vi.fn(async () => {
      if (options.attachFails) throw new Error('attach refused');
      return {
        send: (l: string) => { stdin.push(l); react(l); },
        end: () => finish(),
      };
    }),
  };
  return { deps, stdin, jobs };
}

function session(p = provider()) {
  const gateway = createModelGateway({
    system1: createSystem1(p, { maxCallsPerScope: 5, timeoutMs: 1_000 }),
    scope: 'node-1', goal: 'fix the parser', maxRequests: 3,
  });
  return { gateway, maxDecisionTurns: 3, onDecision: vi.fn() };
}

const base = { nodeId: 'node-1', goal: 'fix the parser', namespace: 'org-exec', worktreePath: '/w', credentials: {}, adapter: claudeCodeAdapter, image: 'img' };

describe('executeStep as a decision-capable session', () => {
  it('round-trips a model decision in one process and publishes no frame', async () => {
    const p = provider();
    const s = session(p);
    const published: StructuredEvent[] = [];
    const { deps, stdin, jobs } = cluster();
    const out = await executeStep({ ...base, session: s, onEvent: (e) => published.push(e) }, deps);

    expect(deps.createJob).toHaveBeenCalledTimes(1);
    expect(p.decide).toHaveBeenCalledTimes(1);
    expect(s.onDecision).toHaveBeenCalledTimes(1);
    // The goal went in over stdin, then exactly one decision answer.
    expect(stdin).toHaveLength(2);
    expect(JSON.parse(stdin[0]).message.content).toBe('fix the parser');
    expect(JSON.parse(stdin[1]).message.content).toContain('[1] choice: A (A=0.72, B=0.28)');
    expect(JSON.stringify(published)).not.toContain('cto_decide');
    expect(JSON.stringify(out.events)).not.toContain('cto_decide');
    // One final result, carrying the whole session.
    expect(out.events.filter((e) => e.type === 'result')).toHaveLength(1);
    expect(out.usage).toMatchObject({ inputTokens: 220, numTurns: 2 });
    expect(out.session).toMatchObject({ decisionTurns: 1, unanswered: 0 });

    const container = jobs[0].spec!.template.spec!.containers[0];
    expect(container).toMatchObject({ name: 'runner', stdin: true, stdinOnce: true, tty: false });
    expect(container.command).toContain('--input-format');
    expect(container.command).not.toContain('fix the parser');
  });

  it('never registers the decision capability as a tool or an MCP server', async () => {
    const { deps, jobs } = cluster();
    await executeStep({ ...base, session: session() }, deps);
    const argv = jobs[0].spec!.template.spec!.containers[0].command!.join(' ');
    expect(argv).not.toMatch(/mcp|laya|jev|allowedTools.*decide|systemone/i);
  });

  it('runs the step as an ordinary dispatch when the session cannot be attached', async () => {
    const { deps, jobs } = cluster({ attachFails: true });
    const out = await executeStep({ ...base, session: session() }, deps);
    expect(deps.createJob).toHaveBeenCalledTimes(2);
    expect(deps.deleteJob).toHaveBeenCalledTimes(2);
    expect(deps.deleteSecret).toHaveBeenCalledTimes(2);
    expect(jobs[1].spec!.template.spec!.containers[0].stdin).toBeUndefined();
    expect(jobs[1].spec!.template.spec!.containers[0].command).toContain('fix the parser');
    expect(out.succeeded).toBe(true);
    expect(out.session).toBeUndefined();
  });

  it('leaves text mode exactly as it was when no session is asked for', async () => {
    const { deps, jobs } = cluster();
    await executeStep(base, deps);
    expect(deps.attachStdin).not.toHaveBeenCalled();
    const container = jobs[0].spec!.template.spec!.containers[0];
    expect(container.stdin).toBeUndefined();
    expect(container.command).not.toContain('--input-format');
  });
});

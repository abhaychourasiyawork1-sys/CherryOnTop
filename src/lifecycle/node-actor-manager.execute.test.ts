import { describe, it, expect, afterEach, beforeEach, vi, type Mock } from 'vitest';
import { existsSync, unlinkSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDb } from '../db/client.js';
import { getNode, insertNode } from '../db/queries/nodes.js';
import { recordRunOutcome } from '../db/queries/memory.js';
import { startNodeActor } from './node-actor-manager.js';
import type { ExecuteStepInput, ExecuteStepResult } from '../execution/execute-step.js';
import { ZERO_USAGE } from '../execution/tokens.js';

// The one place the three optimizations meet — repo context, role system prompt and
// the tiered-model fallback — is the executeStep actor closure, and it dispatches
// a real Kubernetes Job. Stubbing the module is what makes the prompt it builds
// observable at all; everything else here is the real machine.
vi.mock('../execution/execute-step.js', () => ({ executeStep: vi.fn() }));
// A node that reaches COMPLETE tears down its cluster-side resources. There is
// no cluster here, and shelling out to kubectl to be told so is pure latency.
vi.mock('../k8s/cleanup.js', () => ({
  deleteNodeNetworkPolicy: vi.fn(async () => {}),
  deleteNodeJobs: vi.fn(async () => {}),
}));

const { executeStep } = await import('../execution/execute-step.js');
const stub = executeStep as unknown as Mock;

const TEST_DB = './test-actor-execute.db';
const CONSTRAINT = 'Never write to the production database';
const GOAL = 'Fix the failing test in the cart module';

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'exec-actor-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  // One file the goal points at and several it does not: selection has to pick
  // the first and leave the rest out.
  mkdirSync(join(dir, 'src', 'cart'), { recursive: true });
  writeFileSync(join(dir, 'src', 'cart', 'checkout.ts'), 'export function checkout() {}\n');
  for (let i = 0; i < 5; i++) writeFileSync(join(dir, `unrelated-${i}.ts`), 'export const x = 1;\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

function result(events: ExecuteStepResult['events'], succeeded: boolean): ExecuteStepResult {
  return { succeeded, message: 'done', events, usage: { ...ZERO_USAGE } };
}

// The runtime's own way of saying "you cannot call that model" — what
// shouldRetryWithoutModel reads to decide on the one-shot retry.
const MODEL_REJECTED = result(
  [{ type: 'result', payload: { is_error: true, result: 'model "x" is not available on your plan' } }],
  false,
);
const OK = result([{ type: 'result', payload: { is_error: false, result: 'fixed it' } }], true);

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
  delete process.env.ORG_ROLE_PROMPTS;
  delete process.env.ORG_MODEL_EXECUTE;
  delete process.env.ANTHROPIC_API_KEY;
  vi.clearAllMocks();
});

beforeEach(() => {
  // No cluster and no login in a unit test: the key only has to exist for the
  // credential precheck, since the dispatch itself is stubbed.
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

/** Drives one node from CREATED to COMPLETE and returns what the two dispatches
 *  were asked to run. The first is refused over its model, so the second is the
 *  fallback retry. */
async function runSelfExecute(codex: boolean): Promise<ExecuteStepInput[]> {
  const db = createDb(TEST_DB);
  // Three good runs is exactly the history selectRuntime needs before it will
  // move off the default — the situation that sends a Claude model alias to a
  // runtime that cannot serve it.
  if (codex) {
    for (let i = 0; i < 3; i++) {
      recordRunOutcome(db, {
        id: randomUUID(), nodeId: 'seed', createdAt: new Date().toISOString(),
        outcome: { runtime: 'codex', succeeded: true, costUsd: 0.1, latencyMs: 1000, complexity: 'low', delegated: false },
      });
    }
  }

  const calls: ExecuteStepInput[] = [];
  stub.mockImplementation(async (input: ExecuteStepInput) => {
    calls.push(input);
    return calls.length === 1 ? MODEL_REJECTED : OK;
  });

  const id = randomUUID();
  insertNode(db, {
    id, parentId: null, goal: GOAL, repoPath: tmpRepo(), state: 'CREATED',
    createdAt: 't0', updatedAt: 't0',
    contract: {
      goal: GOAL, definition_of_done: ['the test passes'],
      // spawn_children false is what makes this a SELF_EXECUTE without any
      // sandbox being spent to decide it.
      authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 1 },
      constraints: [CONSTRAINT],
    },
  });

  startNodeActor(db, id, GOAL);
  await vi.waitFor(() => expect(getNode(db, id)?.state).toBe('COMPLETE'), { timeout: 10_000 });
  expect(getNode(db, id)?.runtime).toBe(codex ? 'codex' : 'claude-code');
  return calls;
}

describe('the executeStep dispatch, where the repo context, the role prompt and the model fallback meet', () => {
  // The three configurations that route the standing constraints differently.
  // Every one of them has to deliver them exactly once, and has to survive the
  // fallback retry without rewriting the prompt underneath it.
  const configurations = [
    { name: 'role prompts on, a runtime that delivers a system prompt', codex: false, rolePrompts: 'on', model: 'haiku', inSystemPrompt: true },
    { name: 'role prompts off', codex: false, rolePrompts: 'off', model: 'haiku', inSystemPrompt: false },
    { name: 'role prompts on, a runtime that drops the system prompt', codex: true, rolePrompts: 'on', model: 'gpt-5-codex', inSystemPrompt: false },
  ];

  for (const config of configurations) {
    it(`prefixes the context once, states the constraints once, and retries byte-identically — ${config.name}`, async () => {
      process.env.ORG_ROLE_PROMPTS = config.rolePrompts;
      // execute has no tiered model by default, so the fallback it owns is
      // otherwise unreachable. Name one this runtime can actually serve.
      process.env.ORG_MODEL_EXECUTE = config.model;

      const calls = await runSelfExecute(config.codex);

      // (c) The tiered model was refused, and the fallback ran without it.
      expect(calls).toHaveLength(2);
      expect(calls[0].model).toBe(config.model);
      expect(calls[1].model).toBeUndefined();
      // Byte-identical: the repo context and the constraints are assembled once,
      // outside the retry, so a second attempt cannot double either.
      expect(calls[1].goal).toBe(calls[0].goal);
      expect(calls[1].systemPrompt).toBe(calls[0].systemPrompt);

      for (const call of calls) {
        // (a) Prefixed exactly once.
        expect(occurrences(call.goal, 'Repository shape:')).toBe(1);
        // Selected because the goal names the cart module — and the files it
        // does not name are left out, which is the whole point of selecting.
        expect(occurrences(call.goal, 'src/cart/checkout.ts')).toBe(1);
        expect(call.goal).not.toContain('unrelated-0.ts');
        // The context wraps the instruction block rather than sitting between
        // the standing instructions and the goal they govern.
        expect(call.goal.indexOf('Repository shape:')).toBeLessThan(call.goal.indexOf(GOAL));

        // (b) The constraints reach the agent exactly once, by whichever route
        // this configuration has available.
        const delivered = `${call.systemPrompt ?? ''}\n${call.goal}`;
        expect(occurrences(delivered, CONSTRAINT)).toBe(1);
        if (config.inSystemPrompt) {
          expect(call.systemPrompt).toContain(CONSTRAINT);
          expect(call.goal).not.toContain(CONSTRAINT);
        } else {
          expect(call.systemPrompt).toBeUndefined();
          expect(call.goal).toContain(CONSTRAINT);
          // Adjacent to the goal, not separated from it by the context.
          expect(call.goal.indexOf(CONSTRAINT)).toBeGreaterThan(call.goal.indexOf('Repository shape:'));
        }
      }
    });
  }
});

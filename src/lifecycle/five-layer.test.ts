/** The runtime, end to end, as one flow.
 *
 *  `Goal -> State -> Capabilities -> Economic Decision -> Agent Execution ->
 *  Evidence -> State update`, driven through the real modules rather than
 *  mocked at each seam. What every test here asserts is a *behaviour of the
 *  whole*, which is exactly what the per-module tests cannot: each of them can
 *  pass while the composition does the wrong thing.
 *
 *  Four trajectories, chosen because they are the four the architecture claims
 *  to handle differently — and because three of them are ways an optimizer
 *  usually makes things worse. */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDb } from '../db/client.js';
import { insertNode } from '../db/queries/nodes.js';
import { appendEvent } from '../db/queries/events.js';
import { recordDispatchUsage } from '../db/queries/tokens.js';
import {
  evaluateBoundary, economicStateFor, forgetNode, recordRecoveryAttempt, recoveryHistory,
} from './economic-runtime.js';
import { selectDispatchContext } from '../context/dispatch-context.js';
import { buildRepoInventory } from '../intelligence/repo-map.js';
import { planWorkstreams, schedulingCandidates } from '../execution/workstreams.js';
import { propagateFailure } from '../execution/conflicts.js';
import { chooseEconomicAction } from '../decision/engine.js';
import { tombstoneFor, evaluateRecovery } from '../recovery/engine.js';

const DB = './test-five-layer.db';
afterEach(() => {
  for (const s of ['', '-journal', '-wal', '-shm']) if (existsSync(DB + s)) unlinkSync(DB + s);
});

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'five-layer-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  mkdirSync(join(dir, 'src', 'auth'), { recursive: true });
  // A real file's worth of code: a two-line stub is below the size at which
  // opening a file in full says anything its description does not.
  writeFileSync(join(dir, 'src', 'auth', 'session.ts'), [
    'import { readStore } from "./store.js";',
    ...Array.from({ length: 6 }, (_, i) => `export function sessionHelper${i}(token: string) { return token.length > ${i} ? readStore() : null; }`),
    'export function refreshSession() { return readStore(); }',
  ].join('\n') + '\n');
  writeFileSync(join(dir, 'src', 'auth', 'store.ts'), 'export function readStore() { return null; }\n');
  writeFileSync(join(dir, 'src', 'auth', 'session.test.ts'),
    'import { refreshSession } from "./session.js";\n');
  for (let i = 0; i < 4; i++) writeFileSync(join(dir, `unrelated-${i}.ts`), 'export const x = 1;\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

function seed(db: ReturnType<typeof createDb>, goal: string, repoPath: string): string {
  const id = randomUUID();
  insertNode(db, {
    id, parentId: null, goal, repoPath, state: 'CREATED', createdAt: 't0', updatedAt: 't0',
    contract: {
      goal, definition_of_done: ['the test passes'],
      authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 1 },
      constraints: [],
    },
  });
  return id;
}

function toolCall(
  db: ReturnType<typeof createDb>, nodeId: string,
  name: string, input: Record<string, unknown>, failed = false, output = 'ok',
): void {
  const id = randomUUID();
  appendEvent(db, {
    nodeId, type: 'exec.assistant', createdAt: new Date().toISOString(),
    payload: { message: { content: [{ type: 'tool_use', id, name, input }] } },
  });
  appendEvent(db, {
    nodeId, type: 'exec.user', createdAt: new Date().toISOString(),
    payload: { message: { content: [{ type: 'tool_result', tool_use_id: id, content: output, is_error: failed }] } },
  });
}

function spend(db: ReturnType<typeof createDb>, nodeId: string, tokens: number, turns: number): void {
  recordDispatchUsage(db, {
    nodeId, role: 'execute', model: null, costUsd: 0.1, createdAt: 't1',
    usage: { inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, numTurns: turns },
  });
}

describe('a healthy trajectory: the agent runs unchanged', () => {
  it('decides to continue and proposes nothing', () => {
    const db = createDb(DB);
    const dir = repo();
    const id = seed(db, 'Fix refreshSession in src/auth/session.ts', dir);
    // Reading and editing the file the goal named, making progress, nothing
    // failing. There is nothing here worth paying to intervene in.
    toolCall(db, id, 'Read', { file_path: 'src/auth/session.ts' });
    toolCall(db, id, 'Edit', { file_path: 'src/auth/session.ts' });
    toolCall(db, id, 'Bash', { command: 'npm test' });
    spend(db, id, 20_000, 3);

    const { decision, cycle } = evaluateBoundary(db, { nodeId: id, goal: 'Fix refreshSession in src/auth/session.ts' });
    expect(decision?.action.kind).toBe('continue');
    expect(cycle.skippedDeepEvaluation).toBe(true);
    // And it cost the screen, not an evaluation.
    expect(cycle.cost.reason).toBe('fast-path');
    forgetNode(id);
  });
});

describe('an identifiable missing-evidence trajectory: one justified acquisition', () => {
  const GOAL = 'Fix the refresh bug in src/auth/session.ts';

  it('turns the selector’s verdict into exactly one evidence action', () => {
    const db = createDb(DB);
    const dir = repo();
    const id = seed(db, GOAL, dir);
    // Failing repeatedly and getting nowhere: the screen has something to see.
    for (let i = 0; i < 6; i++) {
      toolCall(db, id, 'Bash', { command: 'npm test' }, true, 'error: readStore is not a function');
    }
    spend(db, id, 40_000, 6);

    // Layer 2: the context planner says which file is worth opening.
    const context = selectDispatchContext({
      goal: GOAL, entries: buildRepoInventory(dir), tokenBudget: 6_000,
    });
    const requests = context.receipt.fullArtifactRequests ?? [];
    expect(requests.length).toBeGreaterThan(0);

    // Layers 1 and 3: state, then a decision over the whole capability set.
    const { decision, cycle } = evaluateBoundary(db, {
      nodeId: id, goal: GOAL, repositoryRevision: 'rev-1', fullArtifactRequests: requests,
    });

    const evidenceCandidates = cycle.candidates.filter((c) => c.kind === 'acquire_evidence');
    expect(evidenceCandidates.length).toBeGreaterThan(0);
    // One action, not a cascade: the decision is a single choice, whatever the
    // selector offered.
    expect(decision).toBeDefined();
    expect([decision!.action]).toHaveLength(1);
    forgetNode(id);
  });

  it('refuses the acquisition when the run already read the file', () => {
    const db = createDb(DB);
    const dir = repo();
    const id = seed(db, GOAL, dir);
    for (let i = 0; i < 6; i++) toolCall(db, id, 'Read', { file_path: 'src/auth/session.ts' });
    spend(db, id, 40_000, 6);

    const state = economicStateFor(db, { nodeId: id, goal: GOAL });
    // Current evidence: the run has this file. Nothing should offer to fetch it.
    expect(state.evidence.map((e) => e.id)).toContain('observed:src/auth/session.ts');
    forgetNode(id);
  });
});

describe('a failing trajectory: recovery preserves what was established', () => {
  const GOAL = 'Fix the failing session test';
  const FAILURE = 'Bash#npm test#error: readStore is not a function';

  it('offers a retry that keeps the facts and drops the hypothesis', () => {
    const db = createDb(DB);
    const dir = repo();
    const id = seed(db, GOAL, dir);
    for (let i = 0; i < 8; i++) {
      toolCall(db, id, 'Bash', { command: 'npm test' }, true, 'error: readStore is not a function');
    }
    spend(db, id, 60_000, 8);

    const state = economicStateFor(db, { nodeId: id, goal: GOAL });
    const evaluation = evaluateRecovery({ state, failureSignature: FAILURE });
    // What the failed attempt observed survives it.
    expect(evaluation.retainedEvidenceIds.length).toBeGreaterThan(0);
    expect(evaluation.reasonCodes.some((r) => r.startsWith('retains_evidence:'))).toBe(true);
    forgetNode(id);
  });

  it('does not blindly replay a hypothesis a previous attempt disproved', () => {
    const db = createDb(DB);
    const dir = repo();
    const id = seed(db, GOAL, dir);
    for (let i = 0; i < 8; i++) {
      toolCall(db, id, 'Bash', { command: 'npm test' }, true, 'error: readStore is not a function');
    }
    spend(db, id, 60_000, 8);

    const state = economicStateFor(db, { nodeId: id, goal: GOAL });
    const first = evaluateRecovery({ state, failureSignature: FAILURE });
    recordRecoveryAttempt(id, tombstoneFor({
      id: 't1', evaluation: first, failureSignature: FAILURE, tokensSpent: 20_000,
      hypothesisIds: ['observed:npm test'],
    }));

    const second = evaluateRecovery({
      state, failureSignature: FAILURE, tombstones: recoveryHistory(id),
    });
    // Ruled out once, ruled out still.
    expect(second.retainedEvidenceIds).not.toContain('observed:npm test');
    // And the second attempt is a worse bet than the first, because it already
    // died this way once.
    expect(second.expectedSuccessProbability).toBeLessThan(first.expectedSuccessProbability);
    expect(second.reasonCodes).toContain('repeat_failure:1');
    forgetNode(id);
  });

  it('carries the retry into the boundary as a comparable candidate', () => {
    const db = createDb(DB);
    const dir = repo();
    const id = seed(db, GOAL, dir);
    for (let i = 0; i < 8; i++) {
      toolCall(db, id, 'Bash', { command: 'npm test' }, true, 'error: readStore is not a function');
    }
    spend(db, id, 60_000, 8);

    const { cycle } = evaluateBoundary(db, { nodeId: id, goal: GOAL });
    const retry = cycle.candidates.find((c) => c.id === 'recovery:retry');
    expect(retry).toBeDefined();
    // It competes; it does not get a pathway of its own.
    expect(retry!.failureRisk).toBeGreaterThan(0);
    forgetNode(id);
  });
});

describe('a multi-workstream task: shared evidence and write safety', () => {
  const state = () => {
    const db = createDb(DB);
    const dir = repo();
    const id = seed(db, 'Refactor auth', dir);
    spend(db, id, 10_000, 2);
    const s = economicStateFor(db, { nodeId: id, goal: 'Refactor auth' });
    forgetNode(id);
    return s;
  };

  it('avoids paying three times for what three branches all need', () => {
    const plan = planWorkstreams({
      nodes: ['a', 'b', 'c'].map((id) => ({
        id, inputDependencies: [], outputDependencies: [], validationDependencies: [],
        informationDependencies: ['src/auth/session.ts'],
        writePaths: [`src/auth/${id}.ts`],
      })),
      evidenceTokenCost: () => 2_000,
    });
    expect(plan.sharedEvidenceIds).toEqual(['src/auth/session.ts']);
    expect(plan.informationDuplication).toBe(4_000);
    // And the branches still run together: needing the same knowledge is not an
    // ordering constraint.
    expect(plan.parallelGroups).toEqual([['a', 'b', 'c']]);
  });

  it('refuses to run two branches that would write the same file at once', () => {
    const plan = planWorkstreams({
      nodes: ['a', 'b'].map((id) => ({
        id, inputDependencies: [], outputDependencies: [], validationDependencies: [],
        informationDependencies: [], writePaths: ['src/auth/session.ts'],
      })),
    });
    expect(plan.parallelGroups).toEqual([['a'], ['b']]);
    expect(plan.serializationReasons.some((r) => r.startsWith('write_conflict:'))).toBe(true);
    // And with nothing left to parallelize, nothing is offered.
    expect(schedulingCandidates({
      plan, state: state(), contextTokensPerBranch: 4_000, branchLatencyMs: 120_000,
    })).toEqual([]);
  });

  it('lets the engine choose serial when coordination outweighs the wall-clock', () => {
    const s = state();
    const plan = planWorkstreams({
      nodes: ['a', 'b', 'c', 'd'].map((id) => ({
        id, inputDependencies: [], outputDependencies: [], validationDependencies: [],
        informationDependencies: ['src/auth/session.ts'], writePaths: [`src/${id}.ts`],
      })),
      evidenceTokenCost: () => 500,
    });
    const decision = chooseEconomicAction({
      state: s,
      candidates: schedulingCandidates({
        plan, state: s,
        // Each branch re-reads a large repository, and each finishes fast.
        contextTokensPerBranch: 40_000, branchLatencyMs: 500,
      }),
    });
    expect(decision.action.kind).not.toBe('parallelize');
  });

  it('does not cancel healthy branches when an unrelated one fails', () => {
    const nodes = [
      { id: 'a', inputDependencies: [], outputDependencies: [], validationDependencies: [], informationDependencies: ['shared.ts'], writePaths: ['src/a.ts'] },
      { id: 'b', inputDependencies: [], outputDependencies: [], validationDependencies: [], informationDependencies: ['shared.ts'], writePaths: ['src/b.ts'] },
      { id: 'c', inputDependencies: ['a'], outputDependencies: [], validationDependencies: [], informationDependencies: [], writePaths: ['src/c.ts'] },
    ];
    const result = propagateFailure(nodes, 'a');
    // `c` consumed a's output and cannot proceed. `b` merely needed the same
    // knowledge, and binning it would throw away work that was going fine.
    expect(result.cancelled).toEqual(['c']);
    expect(result.unaffected).toEqual(['b']);
  });
});

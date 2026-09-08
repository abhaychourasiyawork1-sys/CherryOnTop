import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, unlinkSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '../db/client.js';
import { getNode, insertNode } from '../db/queries/nodes.js';
import { listEventsForNode } from '../db/queries/events.js';
import { getRepoMap } from '../db/queries/repo-map-cache.js';
import { repoHead } from '../execution/git-state.js';
import { startNodeActor, sendToNode, repoMapFor, honoursSystemPrompt } from './node-actor-manager.js';
import { claudeCodeAdapter } from '../adapters/claude-code.js';
import { codexAdapter } from '../adapters/codex.js';

const TEST_DB = './test-actor.db';

afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

// Deliberately an escalating contract: spawn-authorized, budget too small to
// fund a child, and a goal that genuinely reads as several pieces of work.
// Every other outcome would dispatch a real Kubernetes Job from what is meant
// to be a unit test.
//
// The goal used to be one long sentence repeated three times, back when
// complexity was measured in characters. It now has to actually look
// decomposable — breadth across many things, and more than one kind of work —
// because that is what the coordinator reads (see intelligence/decompose.ts).
const GOAL = 'Review every module across the entire codebase for bugs, and also add tests for each service';
const CONTRACT = {
  goal: GOAL, definition_of_done: ['done'],
  authority: { tools: [], spawn_children: true, max_child_count: 2, budget_usd: 0.01 }, constraints: [],
};

describe('node-actor-manager', () => {
  it('persists state transitions and appends an event per transition, plus the decision it made', async () => {
    const db = createDb(TEST_DB);
    insertNode(db, { id: 'n1', parentId: null, goal: GOAL, contract: CONTRACT, state: 'CREATED', createdAt: 't0', updatedAt: 't0' });

    startNodeActor(db, 'n1', GOAL);
    // INTELLIGENCE_GATE and EXECUTION_DECISION both resolve themselves through
    // async invokes now, so the node walks all the way here with no event from
    // this test.
    await vi.waitFor(() => expect(getNode(db, 'n1')?.state).toBe('WAIT_APPROVAL'));

    const recordedEvents = listEventsForNode(db, 'n1');
    expect(recordedEvents.length).toBeGreaterThanOrEqual(2);
    expect(recordedEvents.filter((e) => e.type === 'state.transition').length).toBeGreaterThanOrEqual(2);

    // The decision is logged as an event too, so a live transcript can narrate
    // why the node escalated instead of only that it did.
    const decision = recordedEvents.find((e) => e.type === 'decision.made');
    expect(decision).toBeDefined();
    expect((decision!.payload as { outcome: string }).outcome).toBe('ESCALATE');
  });

  it('throws when sending to a node with no active actor', () => {
    expect(() => sendToNode('missing', { type: 'APPROVED' })).toThrow();
  });
});

describe('repoMapFor', () => {
  function tmpRepo(files: number): string {
    const dir = mkdtempSync(join(tmpdir(), 'repomap-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
    for (let i = 0; i < files; i++) writeFileSync(join(dir, `file-${i}.txt`), 'x');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
    return dir;
  }

  afterEach(() => { delete process.env.ORG_REPO_MAP_TOKENS; });

  it('is off when the budget is 0, and returns nothing for a path that is not a repo', () => {
    const db = createDb(TEST_DB);
    process.env.ORG_REPO_MAP_TOKENS = '0';
    expect(repoMapFor(db, tmpRepo(3))).toBeNull();
    process.env.ORG_REPO_MAP_TOKENS = '6000';
    expect(repoMapFor(db, mkdtempSync(join(tmpdir(), 'plain-')))).toBeNull();
  });

  it('builds once, reuses the stored map, and rebuilds it when the budget is turned down', () => {
    const db = createDb(TEST_DB);
    const dir = tmpRepo(40);

    process.env.ORG_REPO_MAP_TOKENS = '6000';
    const big = repoMapFor(db, dir);
    expect(big).toContain('file-0.txt');
    // Second call is a cache hit: same map, and nothing new written.
    expect(repoMapFor(db, dir)).toBe(big);
    expect(getRepoMap(db, repoHead(dir)!)).toBe(big);

    // The knob has to bite on the next dispatch, not the next commit.
    process.env.ORG_REPO_MAP_TOKENS = '20';
    const small = repoMapFor(db, dir);
    expect(small).not.toBe(big);
    expect(small!.length).toBeLessThanOrEqual(20 * 4);
    // ...and the smaller map replaces it, so the next reader gets it too.
    expect(getRepoMap(db, repoHead(dir)!)).toBe(small);
  });
});

describe('retired prompt module', () => {
  it('is gone — constraints now ride the execute role system prompt', () => {
    // A dynamic import would not typecheck against a deleted module, so this
    // checks the file itself.
    expect(existsSync(join(import.meta.dirname, '../execution/prompt.ts'))).toBe(false);
  });
});

describe('honoursSystemPrompt', () => {
  it('is true for a runtime that passes the prompt through, false for one that drops it', () => {
    // Codex exec has no --append-system-prompt: a role stanza sent there — and
    // the standing constraints it carries — would reach nobody, so the execute
    // dispatch falls back to putting them inline on the goal.
    expect(honoursSystemPrompt(claudeCodeAdapter)).toBe(true);
    expect(honoursSystemPrompt(codexAdapter)).toBe(false);
  });
});

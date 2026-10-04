/** Trying to break the context runtime from the outside.
 *
 *  Each test names a way an optimisation of this kind goes wrong — the critical
 *  thing pruned, the stale thing served as current, the cheap thing crowding out
 *  the correct one — and checks that it does not. Written against the public
 *  behaviour, so a refactor that keeps the promises keeps the tests. */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '../db/client.js';
import { appendEvent } from '../db/queries/events.js';
import { compilePrompt } from './prompt-compiler.js';
import { compileWithFallback } from './prompt-runtime.js';
import { DEFAULT_PROMPT_BUDGET, type PromptBudget } from './prompt-budget.js';
import type { PromptBlock } from './prompt-ir.js';
import { getContextObject, putContextObject } from '../context/store.js';
import { resolveContent } from '../context/representations.js';
import { scopeOf } from '../context/types.js';
import { indexRunObservations } from '../lifecycle/run-index.js';
import { applyManifestDelta, getManifest } from '../context/runtime/task-context-manifest.js';
import { recordWorkingSet, projectWorkingSet } from '../context/runtime/working-set.js';
import { dispatchContextFor } from '../context/dispatch-context-cache.js';
import { repoHead } from '../execution/git-state.js';

const DB = './test-adversarial.db';
const dirs: string[] = [];
afterEach(() => {
  delete process.env.ORG_REPO_MAP_TOKENS;
  for (const suffix of ['', '-journal', '-wal', '-shm']) if (existsSync(DB + suffix)) unlinkSync(DB + suffix);
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// A small seeded generator: failures must be reproducible.
function prng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}

function randomDocument(random: () => number): PromptBlock[] {
  const classes = ['STATIC', 'TASK_STABLE', 'SESSION_STABLE', 'DYNAMIC'] as const;
  const count = 1 + Math.floor(random() * 9);
  return Array.from({ length: count }, (_, i): PromptBlock => {
    const size = 1 + Math.floor(random() * 4_000);
    const content = (random() < 0.15 ? 'é' : 'x').repeat(size);
    const rungs: string[] = [];
    if (random() < 0.5) {
      let cur = size;
      while (cur > 8 && rungs.length < 3) { cur = Math.floor(cur / (2 + random() * 3)); rungs.push('x'.repeat(cur)); }
    }
    return {
      id: `b${i}`, kind: 'k', channel: random() < 0.3 ? 'system' : 'user',
      cacheClass: classes[Math.floor(random() * 4)], priority: Math.floor(random() * 100),
      required: random() < 0.35, content, ...(rungs.length ? { fallbacks: rungs.filter((r, j) => r.length < (j === 0 ? size : rungs[j - 1].length)) } : {}),
    };
  });
}

describe('the compiler never ships an over-budget or half-cut prompt', () => {
  it('holds its invariants for a thousand random documents and budgets', () => {
    const random = prng(20260930);
    for (let trial = 0; trial < 1_000; trial++) {
      const blocks = randomDocument(random);
      const budget: PromptBudget = {
        ...DEFAULT_PROMPT_BUDGET,
        maxBytesPerChannel: 50 + Math.floor(random() * 12_000),
        providerContextLimit: 1_000 + Math.floor(random() * 60_000),
      };
      const first = compilePrompt({ blocks }, budget);
      const again = compilePrompt(structuredClone({ blocks }), budget);
      expect(again, `trial ${trial} is deterministic`).toEqual(first);

      if (first.receipt.status === 'refused') {
        expect(first.system + first.user, `trial ${trial}`).toBe('');
        expect(first.receipt.reasons.length, `trial ${trial}`).toBeGreaterThan(0);
        continue;
      }
      expect(Buffer.byteLength(first.system), `trial ${trial} system`).toBeLessThanOrEqual(budget.maxBytesPerChannel);
      expect(Buffer.byteLength(first.user), `trial ${trial} user`).toBeLessThanOrEqual(budget.maxBytesPerChannel);
      expect(first.receipt.totalTokens, `trial ${trial} tokens`).toBeLessThanOrEqual(first.receipt.budget.effectiveTokens);

      // A required block is present — whole, or as one of its own fallbacks —
      // and is never simply gone.
      const rendered = new Map(first.receipt.blocks.map((b) => [b.id, b]));
      for (const block of blocks.filter((b) => b.required)) {
        const got = rendered.get(block.id);
        expect(got, `trial ${trial}: required ${block.id} was dropped`).toBeDefined();
        const text = got!.level === 0 ? block.content : block.fallbacks![got!.level - 1];
        const channel = block.channel === 'system' ? first.system : first.user;
        expect(channel.includes(text), `trial ${trial}: required ${block.id} not present as rendered`).toBe(true);
      }
    }
  });
});

describe('a budget with almost no room degrades instead of misbehaving', () => {
  const goal: PromptBlock = { id: 'goal', kind: 'goal', channel: 'user', cacheClass: 'DYNAMIC', priority: 100, required: true, content: 'Fix the login bug' };
  const map: PromptBlock = { id: 'map', kind: 'repo-context', channel: 'user', cacheClass: 'TASK_STABLE', priority: 40, required: false, content: 'm'.repeat(5_000) };

  it('keeps the goal and sheds everything optional when the room is just the goal', () => {
    const out = compilePrompt({ blocks: [map, goal] }, { ...DEFAULT_PROMPT_BUDGET, maxBytesPerChannel: Buffer.byteLength(goal.content) });
    expect(out.user).toBe(goal.content);
    expect(out.receipt.dropped).toEqual(['map']);
  });

  it('refuses, and says so, when there is no room for the goal at all', () => {
    const out = compilePrompt({ blocks: [map, goal] }, { ...DEFAULT_PROMPT_BUDGET, maxBytesPerChannel: 3 });
    expect(out.receipt.status).toBe('refused');
    expect(out.user).toBe('');
  });

  it('refuses when the model window leaves nothing to spend', () => {
    const out = compilePrompt({ blocks: [goal] }, { ...DEFAULT_PROMPT_BUDGET, providerContextLimit: 1_000 });
    expect(out.receipt.status).toBe('refused');
    expect(out.receipt.reasons.join(' ')).toMatch(/ceiling is 0/);
  });

  it('goes on to dispatch unbounded rather than not at all when the compiler itself is broken', () => {
    const broken = compileWithFallback({ blocks: [goal, { ...goal }] }, DEFAULT_PROMPT_BUDGET);
    expect(broken.fellBack).toBe(true);
    expect(broken.goal).toContain('Fix the login bug');
  });
});

describe('a large tool output that was pruned from view is still there when it is needed later', () => {
  it('leaves the output in the event log and hands out a reference that resolves to it', () => {
    const db = createDb(DB);
    const lines = Array.from({ length: 4_000 }, (_, i) => `line ${i}: ${i === 3_217 ? 'THE ROOT CAUSE: expired token' : 'ok'}`).join('\n');
    const events = [
      { type: 'assistant', payload: { message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'npm test' } }] } } },
      { type: 'user', payload: { message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: lines }] } } },
    ];
    // The raw stream is durable first, exactly as the lifecycle records it.
    const ids = events.map((e) => appendEvent(db, { nodeId: 'n', type: `exec.${e.type}`, payload: e.payload, createdAt: 't' }));
    const indexed = indexRunObservations(db, { nodeId: 'n', events, eventIds: ids.map((_, i) => ids[i]), grant: { allowedTools: null, readOnly: false } });

    const ref = indexed.refs.find((r) => r.semanticId.startsWith('observation:Bash:'))!;
    const object = getContextObject(db, ref)!;
    // Too large to inline: it points at the event that already holds it.
    expect(object.source.kind).toBe('event');
    expect(object.inline).toBeUndefined();
    // And the pointer resolves to the full text, so a section can be fetched on demand.
    expect(resolveContent(db, object)).toContain('THE ROOT CAUSE: expired token');
  });
});

describe('a decision made early is still known at the end of a long task', () => {
  it('keeps an early decision in the manifest through dozens of later revisions', () => {
    const db = createDb(DB);
    const scope = scopeOf(['Read'], true);
    const decision = putContextObject(db, { semanticId: 'decision:use-jwt', kind: 'finding', content: 'We use JWT, not sessions.', source: { kind: 'inline', locator: 'd' }, scope });
    applyManifestDelta(db, 'task', { add: { decisions: [decision.ref] } });
    for (let i = 0; i < 60; i++) {
      const o = putContextObject(db, { semanticId: `repo_file:f${i}.ts@r|x`, kind: 'repo_file', content: `f${i}`, source: { kind: 'inline', locator: `f${i}` }, scope });
      applyManifestDelta(db, 'task', { add: { workingSet: [o.ref] } });
    }
    const manifest = getManifest(db, 'task')!;
    expect(manifest.revision).toBe(61);
    expect(manifest.decisions).toEqual([decision.ref]);
  });
});

describe('the repository moves under a running task', () => {
  function repo() {
    const dir = mkdtempSync(join(tmpdir(), 'adv-'));
    dirs.push(dir);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });
    git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    writeFileSync(join(dir, 'session.ts'), 'export function refreshSession() {}\n');
    git('add', '.'); git('commit', '-q', '-m', 'one');
    return { dir, git };
  }

  it('does not treat what siblings were shown at one commit as shown at the next', () => {
    process.env.ORG_REPO_MAP_TOKENS = '6000';
    const db = createDb(DB);
    const { dir, git } = repo();
    const working = { taskId: 't', scope: scopeOf(['Read'], true) };
    dispatchContextFor(db, dir, 'fix refreshSession', { working });
    const before = repoHead(dir)!;
    expect(projectWorkingSet(db, 't', { revision: before, scope: working.scope }).paths).toContain('session.ts');

    writeFileSync(join(dir, 'session.ts'), 'export function refreshSession() { return 1; }\n');
    git('commit', '-qam', 'two');
    const after = repoHead(dir)!;
    expect(after).not.toBe(before);
    const seen = projectWorkingSet(db, 't', { revision: after, scope: working.scope });
    expect(seen.paths).toEqual([]);
    expect(seen.excluded[0].reason).toBe('other_revision');
  });
});

describe('a sibling’s knowledge stays inside the task and the grant that produced it', () => {
  it('serves nothing across tasks, and nothing broader to something narrower', () => {
    const db = createDb(DB);
    const wide = scopeOf(null, false);
    const narrow = scopeOf(['Read'], true);
    recordWorkingSet(db, 'task-a', { revision: 'r', scope: wide, paths: [{ path: 'secrets/plan.ts' }] });
    expect(projectWorkingSet(db, 'task-b', { revision: 'r', scope: wide }).paths).toEqual([]);
    expect(projectWorkingSet(db, 'task-a', { revision: 'r', scope: narrow }).paths).toEqual([]);
    expect(projectWorkingSet(db, 'task-a', { revision: 'r', scope: wide }).paths).toEqual(['secrets/plan.ts']);
  });
});

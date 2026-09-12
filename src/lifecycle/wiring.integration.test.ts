/** The context, decision and observation systems, exercised through the real
 *  dispatch path rather than in isolation.
 *
 *  Every module they are built from has its own tests. What this checks is the
 *  thing unit tests cannot: that they are actually *wired* — that a real run
 *  leaves behind an indexed graph, an explained decision and a scored
 *  projection, without anyone having to call them by hand.
 */
import { describe, it, expect, afterEach, beforeEach, vi, type Mock } from 'vitest';
import { existsSync, unlinkSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.ANTHROPIC_API_KEY = 'test-key';

vi.mock('../execution/execute-step.js', () => ({ executeStep: vi.fn() }));
vi.mock('../k8s/cleanup.js', () => ({
  deleteNodeNetworkPolicy: vi.fn(async () => {}),
  deleteNodeJobs: vi.fn(async () => {}),
}));

const { createDb } = await import('../db/client.js');
const { insertNode, getNode } = await import('../db/queries/nodes.js');
const { listEventsForNode } = await import('../db/queries/events.js');
const { startNodeActor } = await import('./node-actor-manager.js');
const { executeStep } = await import('../execution/execute-step.js');
const { ZERO_USAGE } = await import('../execution/tokens.js');
const { listContextObjects } = await import('../context/store.js');
const { createContextRpc } = await import('../context/rpc.js');
const { scopeOf } = await import('../context/types.js');
const { contextUtilityByTaskClass } = await import('../learning/context-utility.js');
const { executionGraph, graphSummary } = await import('../execution/graph.js');
const { isRefusal } = await import('../context/representations.js');

const stub = executeStep as unknown as Mock;
const TEST_DB = './test-wiring.db';

const GOAL = 'Review the README and report what it claims. Do not modify anything.';
const ANSWER = 'It claims three things, two of which are stale.';

/** A stream shaped like a real one: a tool call, its result, then the runtime's
 *  final answer. */
const EVENTS = [
  {
    type: 'assistant',
    payload: { message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/workspace/README.md' } }] } },
  },
  {
    type: 'user',
    payload: { message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '# claims\nthree of them\n' }] } },
  },
  {
    type: 'assistant',
    payload: { message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'pnpm test' } }] } },
  },
  {
    type: 'user',
    payload: {
      message: {
        content: [{
          type: 'tool_result', tool_use_id: 't2',
          // Past the inline limit on purpose, and mostly passes: large output
          // stays in the event log and is pointed at rather than copied, and
          // the reducer keeps the line that carries the answer.
          content: [
            ...Array.from({ length: 400 }, (_, i) => `✓ src/module-${i}.test.ts > a reasonably long test name`),
            'FAIL src/auth.test.ts > refuses an expired token',
            ' Tests  1 failed | 400 passed (401)',
          ].join('\n'),
        }],
      },
    },
  },
  { type: 'result', payload: { result: ANSWER, total_cost_usd: 0.95 } },
];

const REPORT = {
  succeeded: true,
  message: 'Job completed successfully',
  events: EVENTS,
  usage: { ...ZERO_USAGE, inputTokens: 40, outputTokens: 12_000, cacheReadTokens: 1_772_218 },
  startupMs: 1200,
};

afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
  vi.clearAllMocks();
});

// Faithful to the real runtime: `executeStep` delivers events through
// `onEvent` as they stream, and that callback is where the event-log row ids
// an observation points at come from. A stub that only returns the array would
// silently exercise the no-ids fallback and prove nothing.
beforeEach(() => {
  stub.mockImplementation(async (input: { onEvent?: (event: unknown) => void }) => {
    for (const event of EVENTS) input.onEvent?.(event);
    return REPORT;
  });
});

function repo(): string {
  const path = mkdtempSync(join(tmpdir(), 'wiring-'));
  writeFileSync(join(path, 'README.md'), '# claims\nthree of them\n');
  writeFileSync(join(path, 'src.ts'), 'export const x = 1;\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: path, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 't@e.com');
  git('config', 'user.name', 't');
  git('add', '-A');
  git('commit', '-qm', 'first');
  return path;
}

function add(db: ReturnType<typeof createDb>, repoPath: string): string {
  const id = randomUUID();
  insertNode(db, {
    id, parentId: null, goal: GOAL, repoPath, state: 'CREATED',
    createdAt: 't0', updatedAt: 't0',
    contract: {
      goal: GOAL, definition_of_done: ['reported'],
      authority: { tools: ['Read', 'Grep'], spawn_children: false, max_child_count: 0, budget_usd: 5 },
      constraints: ['Do not modify anything'],
    },
  });
  return id;
}

async function run(db: ReturnType<typeof createDb>, id: string): Promise<void> {
  startNodeActor(db, id, GOAL);
  await vi.waitFor(() => expect(getNode(db, id)?.state).toMatch(/COMPLETE|FAILED/), { timeout: 10_000 });
}

describe('a real dispatch leaves the context graph behind it', () => {
  it('indexes every tool call against the event row that already holds its output', () => {
    return (async () => {
      const db = createDb(TEST_DB);
      await run(db, add(db, repo()));

      const objects = listContextObjects(db);
      const observations = objects.filter((o) => o.kind === 'observation');
      expect(observations).toHaveLength(2);

      // No payload is copied for output the event log already holds at size;
      // small output is inlined so an expansion can always be served.
      const small = observations.find((o) => o.ref.semanticId.includes('Read'))!;
      expect(small.source.kind).toBe('inline');
      const large = observations.find((o) => o.ref.semanticId.includes('Bash'))!;
      expect(large.source.kind).toBe('event');
      expect(large.inline).toBeUndefined();
    })();
  });

  it('stores the reduced view alongside the raw one, pointing back at it', () => {
    return (async () => {
      const db = createDb(TEST_DB);
      await run(db, add(db, repo()));

      const rawBashOutput = String(
        ((EVENTS[3].payload as { message: { content: { content: string }[] } }).message.content[0]).content,
      );
      const reduced = listContextObjects(db).find((o) => o.ref.semanticId.endsWith(':reduced'))!;
      expect(reduced.kind).toBe('summary');
      expect(reduced.dependencies[0].kind).toBe('SUMMARIZES');
      // Reduction is a view: the raw observation it summarises is still there,
      // and the reduced text keeps the one line out of four hundred that
      // carries the answer.
      expect(reduced.inline).toContain('refuses an expired token');
      expect(reduced.inline).not.toContain('module-200');
      expect(reduced.inline!.length).toBeLessThan(rawBashOutput.length / 2);
    })();
  });

  it('makes the indexed evidence answerable through the RPC', () => {
    return (async () => {
      const db = createDb(TEST_DB);
      await run(db, add(db, repo()));

      const rpc = createContextRpc(db, scopeOf(['Read', 'Grep'], true));
      const found = rpc.search({ text: 'observation Read' });
      expect(found.length).toBeGreaterThan(0);

      const expanded = rpc.expandTo(found[0], 'reference', 10_000);
      if (isRefusal(expanded)) throw new Error(expanded.reason);
      expect(expanded.tokens).toBeGreaterThan(0);
    })();
  });

  it('keeps a narrower agent out of a wider agent’s evidence', () => {
    return (async () => {
      const db = createDb(TEST_DB);
      await run(db, add(db, repo()));
      // The run held Read and Grep; an agent holding only Read may not reuse
      // what a wider grant saw.
      const narrow = createContextRpc(db, scopeOf(['Read'], true));
      expect(narrow.search({ text: 'observation' })).toEqual([]);
    })();
  });
});

describe('a real dispatch explains itself', () => {
  it('publishes a decision receipt naming what it did not do', () => {
    return (async () => {
      const db = createDb(TEST_DB);
      const id = add(db, repo());
      await run(db, id);

      const receipts = listEventsForNode(db, id).filter((e) => e.type === 'decision.receipt');
      expect(receipts.length).toBeGreaterThan(0);
      const payload = receipts[0].payload as { chosen: string; alternatives: unknown[]; reason: string };
      expect(payload.chosen).toBe('RUN_MODEL');
      expect(payload.alternatives.length).toBeGreaterThan(0);
      expect(payload.reason).toBeTruthy();
    })();
  });

  it('publishes the template for this kind of task, and what it pruned', () => {
    return (async () => {
      const db = createDb(TEST_DB);
      const id = add(db, repo());
      await run(db, id);

      const plans = listEventsForNode(db, id).filter((e) => e.type === 'execution.plan');
      expect(plans).toHaveLength(1);
      const payload = plans[0].payload as { taskClass: string; steps: { name: string }[] };
      // "Review ... and report" is an investigation, not an implementation.
      expect(payload.taskClass).toBe('investigation');
      expect(payload.steps.length).toBeGreaterThan(0);
    })();
  });
});

describe('a real dispatch scores its own projection', () => {
  it('records what selection predicted against what the run read', () => {
    return (async () => {
      const db = createDb(TEST_DB);
      await run(db, add(db, repo()));

      const stats = contextUtilityByTaskClass(db);
      expect(stats).toHaveLength(1);
      expect(stats[0].taskClass).toBe('investigation');
      expect(stats[0].observations).toBe(1);
      // The run read README.md, which is the ground truth selection is scored
      // against.
      expect(stats[0].meanRecall).toBeGreaterThan(0);
    })();
  });
});

describe('the work model reflects what happened', () => {
  it('reports a finished node as completed, and a reused one as reused', () => {
    return (async () => {
      const db = createDb(TEST_DB);
      const path = repo();
      await run(db, add(db, path));
      await run(db, add(db, path));

      const summary = graphSummary(executionGraph(db));
      expect(summary.completed).toBe(1);
      expect(summary.reused).toBe(1);
      // And only one sandbox was opened for the two of them.
      expect(stub).toHaveBeenCalledTimes(1);
    })();
  });
});

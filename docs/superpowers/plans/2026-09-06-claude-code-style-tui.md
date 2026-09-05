# Claude-Code-Style TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Context

The drill-down TUI shipped yesterday (`org` → home → tree → node → output) is correct and fully tested, and it is the wrong shape for daily use. Its problems are structural: it makes you *navigate to* information rather than showing it; it renders bare state names for a lifecycle that passes through four states in under a second, explaining nothing; and its only input surface is undiscoverable keybindings plus a five-prompt form.

This plan replaces it with Claude Code's interaction model — one append-only transcript, one persistent input box, slash commands — carrying the org-specific content (lifecycle narration, decision breakdowns, live Claude Code output, approvals) the old screens existed to show. It also adds the one capability none of that has today: cancelling a running node.

**Goal:** Replace the screen-stack TUI with a single-transcript, slash-command Claude Code-style interface, and make running nodes cancellable.

**Architecture:** Three pure units — a transcript reducer (`BusEvent → Block[]`), a command registry, and an input-box component — under a thin Ink shell. Finalized blocks render inside Ink's `<Static>` so they are written once and never repainted; only the working node's pending tool call repaints. Cancellation is added at the four points every caller already routes through, rather than as a special case.

**Tech Stack:** Ink 7 (`Static`, `usePaste`, `useWindowSize`), `@inkjs/ui` (`Spinner` only), XState 5, tRPC 11 over WebSocket, `node-notifier` (already a dependency, currently unused), vitest.

**Spec:** [docs/superpowers/specs/2026-09-05-claude-code-style-tui-design.md](docs/superpowers/specs/2026-09-05-claude-code-style-tui-design.md)

## Global Constraints

- **Reuse, do not reimplement:** `src/tui/stream-renderer.ts` (Claude Code event → `RenderedLine`) is correct and stays untouched. `StreamLine` from `src/tui/stream-lines.tsx`, `src/tui/client.ts` (the singleton daemon client), `src/tui/format.ts` (`formatScore`), and `src/cli/validation.ts` (`nonNegativeNumber`, `resolveRepoPath`) are all reused as-is.
- **Never print to stdout from inside the Ink app.** `console.log`, and anything using Listr2 (`runChecks` in `src/doctor/checks.ts`), corrupts the render. `/doctor` calls each `DoctorCheck.run()` directly.
- **`<Static>` output is permanent.** No command may retroactively rewrite or filter output already on screen; `/focus` and `/clear` are defined forward-only (Task 8).
- **Every task ends green:** `npm run typecheck && npx vitest run` before each commit.
- Node ≥ 22. ESM only (`"type": "module"`) — all relative imports carry the `.js` extension.

---

### Task 1: Node cancellation — state machine

**Files:**
- Modify: `src/lifecycle/node-machine.ts`
- Modify: `src/schemas/commitment.ts`
- Test: `src/lifecycle/node-machine.test.ts` (extend)

**Interfaces:**
- Produces: `NodeMachineEvent` gains `{ type: 'CANCEL' }`; the machine gains a final `CANCELLED` state reachable from every other state. `CommitmentStatusSchema` gains `'cancelled'`. Consumed by Task 2.

- [ ] **Step 1: Write the failing test**

```ts
// src/lifecycle/node-machine.test.ts — add to the existing describe block
it('cancels from any state into a final CANCELLED state', () => {
  const actor = createActor(nodeMachine, { input: { nodeId: 'n1', goal: 'g' } });
  actor.start();
  actor.send({ type: 'START' });          // now somewhere past CREATED
  actor.send({ type: 'CANCEL' });
  const snapshot = actor.getSnapshot();
  expect(snapshot.value).toBe('CANCELLED');
  expect(snapshot.status).toBe('done');
});

it('cancels a node parked in WAIT_APPROVAL', () => {
  // WAIT_APPROVAL is reached by the escalate path; a node sitting here is the
  // single most likely thing a user cancels, because it is blocked on them.
  const machine = nodeMachine.provide({
    actors: {
      assessUncertainty: fromPromise(async () => ({ sufficientContext: true, complexity: 'high' as const })),
      decideExecution: fromPromise(async () => ({
        outcome: 'ESCALATE' as const,
        breakdown: { requiredBudget: 1, availableBudget: 0.1 },
      })),
      escalate: fromPromise(async () => 'approval-1'),
    },
  });
  const actor = createActor(machine, { input: { nodeId: 'n1', goal: 'g' } });
  actor.start();
  actor.send({ type: 'START' });
  return waitFor(actor, (s) => s.value === 'WAIT_APPROVAL').then(() => {
    actor.send({ type: 'CANCEL' });
    expect(actor.getSnapshot().value).toBe('CANCELLED');
  });
});
```

Add `waitFor` and `fromPromise` to this file's existing `xstate` import if not already present.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lifecycle/node-machine.test.ts`
Expected: FAIL — `CANCEL` is not in the event union, so the machine ignores it and `snapshot.value` is whatever state it was in.

- [ ] **Step 3: Add the event, the state, and the root-level transition**

```ts
// src/lifecycle/node-machine.ts — extend the event union
export type NodeMachineEvent =
  | { type: 'START' }
  | { type: 'APPROVED' }
  | { type: 'REJECTED' }
  | { type: 'CANCEL' };
```

```ts
// src/lifecycle/node-machine.ts — in the createMachine config, as a sibling of
// `states`, NOT inside it. A root-level handler makes every state cancellable —
// mid-execute, mid-delegate, parked on approval — without editing each one, and
// without a future state being silently un-cancellable because someone forgot.
}).createMachine({
  id: 'accountableNode',
  context: ({ input }) => input,
  initial: 'CREATED',
  on: { CANCEL: '.CANCELLED' },
  states: {
    // ... every existing state unchanged ...
    COMPLETE: { type: 'final' },
    FAILED: { type: 'final' },
    // A cancelled node is not a failed one: nothing was wrong with it, a human
    // stopped it. Keeping them distinct is what makes `org tree` honest.
    CANCELLED: { type: 'final' },
  },
});
```

```ts
// src/schemas/commitment.ts — a cancelled node's commitment is not "failed"
export const CommitmentStatusSchema = z.enum([
  'pending', 'active', 'blocked', 'at_risk', 'completed', 'failed', 'cancelled',
]);
```

Note: `commitments.status` is a free-text SQLite column, so this needs no migration.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lifecycle/node-machine.test.ts`
Expected: PASS, including the pre-existing tests in this file.

- [ ] **Step 5: Commit**

```bash
git add src/lifecycle/node-machine.ts src/lifecycle/node-machine.test.ts src/schemas/commitment.ts
git commit -m "feat: make a node cancellable from any state"
```

---

### Task 2: Node cancellation — Kubernetes and the daemon

**Files:**
- Modify: `src/k8s/client.ts`, `src/k8s/cleanup.ts`, `src/lifecycle/node-actor-manager.ts`, `src/server/routers/node.ts`
- Test: `src/k8s/client.test.ts` (extend), `src/k8s/cleanup.test.ts` (extend)

**Interfaces:**
- Consumes: `CANCEL` / `CANCELLED` (Task 1).
- Produces: `deleteNodeJobs(nodeId, namespace): Promise<void>`, `cancelNode(db, nodeId): Promise<void>`, `node.cancel` tRPC mutation. Consumed by Task 7's `/stop`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/k8s/cleanup.test.ts — add
import { deleteNodeJobs } from './cleanup.js';

describe.skipIf(!CLUSTER_AVAILABLE)('deleteNodeJobs', () => {
  it('deletes a node\'s Jobs by label and is a no-op when there are none', async () => {
    await execa('kubectl', ['create', 'secret', 'generic', 'cancel-secret', '--from-literal=x=y', '-n', 'default']).catch(() => {});
    const job = buildExecutionJob({
      nodeId: 'cancelme', namespace: 'default', image: 'busybox:1.36',
      command: ['sh', '-c', 'sleep 300'], worktreePath: '/tmp', secretName: 'cancel-secret',
    });
    await createJob(job);

    await deleteNodeJobs('cancelme', 'default');
    const { stdout } = await execa('kubectl', ['get', 'jobs', '-n', 'default', '-l', 'org.nodeId=cancelme', '-o', 'name']);
    expect(stdout.trim()).toBe('');

    // Cancelling a node with nothing running must not throw.
    await expect(deleteNodeJobs('never-existed', 'default')).resolves.toBeUndefined();
    await execa('kubectl', ['delete', 'secret', 'cancel-secret', '-n', 'default']).catch(() => {});
  }, 120_000);
});
```

```ts
// src/k8s/client.test.ts — add
it('reports a deleted Job as cancelled rather than throwing', async () => {
  await execa('kubectl', ['create', 'secret', 'generic', 'gone-secret', '--from-literal=x=y', '-n', 'default']).catch(() => {});
  const job = buildExecutionJob({
    nodeId: 'gone', namespace: 'default', image: 'busybox:1.36',
    command: ['sh', '-c', 'sleep 300'], worktreePath: '/tmp', secretName: 'gone-secret',
  });
  const jobName = await createJob(job);

  const waiting = waitForJobCompletion(jobName, 'default');
  await new Promise((r) => setTimeout(r, 2000));
  await deleteJob(jobName, 'default');

  const result = await waiting;
  expect(result.succeeded).toBe(false);
  expect(result.message).toMatch(/cancelled/i);
  await execa('kubectl', ['delete', 'secret', 'gone-secret', '-n', 'default']).catch(() => {});
}, 120_000);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `sg docker -c "npx vitest run src/k8s"`
Expected: FAIL — `deleteNodeJobs` does not exist; `waitForJobCompletion` throws an `ApiException` (404) instead of returning.

- [ ] **Step 3: Implement**

```ts
// src/k8s/cleanup.ts — add alongside deleteNodeNetworkPolicy
import type { V1Job } from '@kubernetes/client-node';

function loadBatchApi() {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  return kc.makeApiClient(k8s.BatchV1Api);
}

/** Deletes every Job belonging to a node. By label, not by name: the manifest
 *  uses `generateName`, so the caller never learns the real names. */
export async function deleteNodeJobs(nodeId: string, namespace: string): Promise<void> {
  await loadBatchApi()
    .deleteCollectionNamespacedJob({
      namespace,
      labelSelector: `org.nodeId=${nodeId}`,
      propagationPolicy: 'Background',
    })
    .catch((err: unknown) => {
      if (err instanceof k8s.ApiException && err.code === 404) return;
      throw err;
    });
}
```

```ts
// src/k8s/client.ts — inside waitForJobCompletion's while loop, wrap the read.
// Root-cause fix: a Job vanishing underneath a running step becomes a graceful
// outcome for EVERY caller, not just the cancel path — which is also what stops
// a cancelled node from surfacing as an unhandled ApiException in the daemon log.
  while (Date.now() - start < timeoutMs) {
    let job;
    try {
      job = await batch.readNamespacedJobStatus({ name: jobName, namespace });
    } catch (err) {
      if (err instanceof k8s.ApiException && err.code === 404) {
        return { succeeded: false, message: 'Job was cancelled' };
      }
      throw err;
    }
    const status = job.status;
    // ... rest of the loop body unchanged ...
  }
```

```ts
// src/lifecycle/node-actor-manager.ts — add near sendToNode
import { deleteNodeJobs } from '../k8s/cleanup.js';

/** Stops a node and tears down its cluster-side work. Order matters: send CANCEL
 *  first so the actor reaches CANCELLED (its terminal handler releases the
 *  NetworkPolicy and closes commitments), then delete the Jobs so the in-flight
 *  executeStep sees its Job disappear and returns the cancelled result. */
export async function cancelNode(db: Db, nodeId: string): Promise<void> {
  const actor = actors.get(nodeId);
  if (actor) actor.send({ type: 'CANCEL' });
  await deleteNodeJobs(nodeId, NAMESPACE);
}
```

In the same file, the terminal-state handler currently maps a final state to `'completed' | 'failed'`. Extend it so `CANCELLED` records `'cancelled'`:

```ts
      const outcome = snapshot.value === 'COMPLETE' ? 'completed'
        : snapshot.value === 'CANCELLED' ? 'cancelled'
        : 'failed';
```

```ts
// src/server/routers/node.ts — add to nodeRouter
  cancel: publicProcedure
    .input(z.object({ nodeId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await cancelNode(ctx.db, input.nodeId);
      return { ok: true as const };
    }),
```

Import `cancelNode` alongside the existing `getNodeActor, sendToNode` import.

- [ ] **Step 4: Run tests to verify they pass**

Run: `sg docker -c "npx vitest run src/k8s"`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm run typecheck && sg docker -c "npx vitest run"`
Expected: PASS — no existing test asserts on the 404-throwing behaviour.

- [ ] **Step 6: Commit**

```bash
git add src/k8s src/lifecycle/node-actor-manager.ts src/server/routers/node.ts
git commit -m "feat: cancel a running node and tear down its Kubernetes work"
```

---

### Task 3: Backend queries for transcript history and the status line

**Files:**
- Modify: `src/db/queries/events.ts`, `src/db/queries/stats.ts`, `src/server/routers/events.ts`
- Test: `src/db/queries/events.test.ts` (extend), `src/db/queries/stats.test.ts` (extend)

**Interfaces:**
- Produces: `listRecentEvents(db, opts: { limit: number; before?: number }): EventRow[]` (ascending by id), `events.recent` tRPC query, `OrgStats.pendingApprovals`. Consumed by Tasks 6 and 9.

- [ ] **Step 1: Write the failing tests**

```ts
// src/db/queries/events.test.ts — add
import { listRecentEvents } from './events.js';

it('returns the most recent events across all nodes, oldest-first, and pages backwards', () => {
  const db = createDb(TEST_DB);
  for (let i = 0; i < 10; i++) {
    appendEvent(db, { nodeId: i % 2 ? 'a' : 'b', type: 't', payload: { i }, createdAt: 't0' });
  }

  const page1 = listRecentEvents(db, { limit: 4 });
  expect(page1).toHaveLength(4);
  // Oldest-first within the page, so the transcript can replay it in order.
  expect(page1.map((e) => (e.payload as { i: number }).i)).toEqual([6, 7, 8, 9]);

  const page2 = listRecentEvents(db, { limit: 4, before: page1[0].id });
  expect(page2.map((e) => (e.payload as { i: number }).i)).toEqual([2, 3, 4, 5]);
});
```

```ts
// src/db/queries/stats.test.ts — extend the existing test's assertions
import { insertApproval } from './approvals.js';
// ... inside the existing test, after the existing insertNode calls:
insertApproval(db, { id: 'a1', nodeId: 'n3', reason: 'budget', status: 'pending', createdAt: 't0', resolvedAt: null });
// ... and after computing stats:
expect(stats.pendingApprovals).toBe(1);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/db/queries`
Expected: FAIL — `listRecentEvents` is not exported; `pendingApprovals` is undefined.

- [ ] **Step 3: Implement**

```ts
// src/db/queries/events.ts — add
import { eq, desc, lt, and } from 'drizzle-orm';

/** The newest `limit` events across every node, returned oldest-first so a
 *  transcript can replay them in the order they happened. `before` pages
 *  backwards by row id — ids are monotonic, unlike the ISO timestamps, several
 *  of which can share a millisecond. */
export function listRecentEvents(db: Db, opts: { limit: number; before?: number }) {
  const rows = db
    .select()
    .from(events)
    .where(opts.before === undefined ? undefined : lt(events.id, opts.before))
    .orderBy(desc(events.id))
    .limit(opts.limit)
    .all();
  return rows.reverse();
}
```

```ts
// src/db/queries/stats.ts — extend
import { approvals } from '../schema.js';

export interface OrgStats {
  active: number;
  complete: number;
  failed: number;
  totalCostUsd: number;
  pendingApprovals: number;
}

// ... inside getOrgStats, before the return:
  const pendingApprovals = db.select().from(approvals).where(eq(approvals.status, 'pending')).all().length;
  return { active, complete, failed, totalCostUsd, pendingApprovals };
```

```ts
// src/server/routers/events.ts — add to eventsRouter, leaving listForNode and subscribe unchanged
  recent: publicProcedure
    .input(z.object({ limit: z.number().min(1).max(1000).default(200), before: z.number().optional() }))
    .query(({ input, ctx }) => listRecentEvents(ctx.db, input)),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/db/queries`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/queries src/server/routers/events.ts
git commit -m "feat: add paged cross-node event history and pending-approval count"
```

---

### Task 4: Transcript reducer — attribution

**Files:**
- Create: `src/tui/transcript.ts`
- Test: `src/tui/transcript.test.ts`

**Interfaces:**
- Consumes: `RenderedLine`/`createStreamRenderer` (`src/tui/stream-renderer.ts`, unchanged), `BusEvent` (`src/events/bus.ts`).
- Produces: `type Block`, `interface TranscriptState`, `createTranscript(): { feed(event, meta?): Block[]; state: TranscriptState }`. Consumed by Tasks 5, 6, 9.

This is the unit that makes concurrent nodes readable, and it is pure — no React, no I/O — so the interleaving behaviour is asserted in tests rather than eyeballed in a terminal.

- [ ] **Step 1: Write the failing test**

```ts
// src/tui/transcript.test.ts
import { describe, it, expect } from 'vitest';
import { createTranscript } from './transcript.js';
import type { BusEvent } from '../events/bus.js';

const NODE_META = {
  a: { goal: 'add the auth guard', parentId: null },
  b: { goal: 'write the tests', parentId: 'a' },
};

function exec(nodeId: string, raw: object, id: number): BusEvent {
  return { id, nodeId, type: `exec.${(raw as { type: string }).type}`, payload: raw, createdAt: 't0' };
}

const textEvent = (nodeId: string, text: string, id: number) =>
  exec(nodeId, { type: 'assistant', message: { content: [{ type: 'text', text }] } }, id);

describe('transcript reducer', () => {
  it('emits a header the first time a node speaks, and not again while it keeps speaking', () => {
    const t = createTranscript(() => NODE_META);
    const first = t.feed(textEvent('a', 'one', 1));
    expect(first[0]).toMatchObject({ kind: 'header', nodeId: 'a', goal: 'add the auth guard' });
    expect(first[1]).toMatchObject({ kind: 'line', nodeId: 'a' });

    const second = t.feed(textEvent('a', 'two', 2));
    expect(second.map((b) => b.kind)).toEqual(['line']);
  });

  it('emits a new header when the speaking node changes, and again when it changes back', () => {
    const t = createTranscript(() => NODE_META);
    t.feed(textEvent('a', 'one', 1));
    const switched = t.feed(textEvent('b', 'two', 2));
    expect(switched[0]).toMatchObject({ kind: 'header', nodeId: 'b' });

    const back = t.feed(textEvent('a', 'three', 3));
    expect(back[0]).toMatchObject({ kind: 'header', nodeId: 'a' });
  });

  it('indents a child under its parent', () => {
    const t = createTranscript(() => NODE_META);
    const blocks = t.feed(textEvent('b', 'child speaking', 1));
    expect(blocks[0]).toMatchObject({ kind: 'header', nodeId: 'b', depth: 1 });
  });

  it('keeps a separate stream-renderer per node, so interleaved tool calls still resolve', () => {
    const t = createTranscript(() => NODE_META);
    t.feed(exec('a', { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_a', name: 'Read', input: { file_path: '/a' } }] } }, 1));
    t.feed(exec('b', { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_b', name: 'Bash', input: { command: 'ls' } }] } }, 2));

    const resolvedA = t.feed(exec('a', { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_a', content: 'x' }] } }, 3));
    const lineBlock = resolvedA.find((b) => b.kind === 'line');
    expect(lineBlock).toMatchObject({ kind: 'line', nodeId: 'a', action: 'update' });
  });

  it('emits a header when a node changes lifecycle state, so the scroll shows where it got to', () => {
    const t = createTranscript(() => NODE_META);
    t.feed(textEvent('a', 'one', 1));
    const blocks = t.feed({ id: 2, nodeId: 'a', type: 'state.transition', payload: { state: 'VERIFY' }, createdAt: 't0' });
    expect(blocks.some((b) => b.kind === 'header' && b.state === 'VERIFY')).toBe(true);
  });

  it('drops events for nodes other than the focused one when focus is set', () => {
    const t = createTranscript(() => NODE_META);
    t.setFocus('a');
    expect(t.feed(textEvent('b', 'ignored', 1))).toEqual([]);
    expect(t.feed(textEvent('a', 'kept', 2))).not.toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tui/transcript.test.ts`
Expected: FAIL — `Cannot find module './transcript'`.

- [ ] **Step 3: Write `src/tui/transcript.ts`**

```ts
import { createStreamRenderer, type RenderedLine, type StreamRenderer } from './stream-renderer.js';
import type { BusEvent } from '../events/bus.js';

export interface NodeMeta { goal: string; parentId: string | null }
export type NodeMetaLookup = () => Record<string, NodeMeta>;

export type Block =
  | { kind: 'header'; key: string; nodeId: string; goal: string; state: string; depth: number }
  | { kind: 'line'; key: string; nodeId: string; depth: number; action: 'append' | 'update'; line: RenderedLine }
  | { kind: 'system'; key: string; nodeId: string | null; depth: number; text: string; tone: 'info' | 'warn' | 'good' | 'bad' }
  | { kind: 'command'; key: string; input: string; output: string[] };

export interface Transcript {
  feed(event: BusEvent): Block[];
  setFocus(nodeId: string | null): void;
  focus(): string | null;
  setVerbose(on: boolean): void;
}

export function createTranscript(lookupMeta: NodeMetaLookup): Transcript {
  // One renderer per node: a shared one would correlate node A's tool_result
  // against node B's pending tool_use, which is exactly what breaks when two
  // nodes work at once.
  const renderers = new Map<string, StreamRenderer>();
  const lastState = new Map<string, string>();
  let lastSpeaker: string | null = null;
  let focused: string | null = null;
  let verbose = false;
  let seq = 0;
  const key = () => `b${seq++}`;

  function depthOf(nodeId: string, meta: Record<string, NodeMeta>): number {
    let depth = 0;
    let cursor = meta[nodeId]?.parentId ?? null;
    while (cursor && meta[cursor] && depth < 16) {
      depth++;
      cursor = meta[cursor].parentId;
    }
    return depth;
  }

  function headerFor(nodeId: string, meta: Record<string, NodeMeta>): Block {
    return {
      kind: 'header', key: key(), nodeId,
      goal: meta[nodeId]?.goal ?? '(unknown goal)',
      state: lastState.get(nodeId) ?? '',
      depth: depthOf(nodeId, meta),
    };
  }

  return {
    focus: () => focused,
    setFocus(nodeId) { focused = nodeId; lastSpeaker = null; },
    setVerbose(on) { verbose = on; },

    feed(event: BusEvent): Block[] {
      if (focused && event.nodeId !== focused) return [];
      const meta = lookupMeta();
      const depth = depthOf(event.nodeId, meta);
      const blocks: Block[] = [];

      if (event.type === 'state.transition') {
        const state = (event.payload as { state: string }).state;
        if (lastState.get(event.nodeId) === state) return [];
        lastState.set(event.nodeId, state);
        blocks.push(headerFor(event.nodeId, meta));
        lastSpeaker = event.nodeId;
        return blocks;
      }

      if (!event.type.startsWith('exec.')) return [];

      let renderer = renderers.get(event.nodeId);
      if (!renderer) {
        renderer = createStreamRenderer();
        renderers.set(event.nodeId, renderer);
      }
      const results = renderer.feed({ type: event.type.slice('exec.'.length), payload: event.payload });
      if (results.length === 0) {
        // Suppressed noise (system, hook, rate-limit). /verbose surfaces it
        // rather than losing it — nothing is ever discarded, only withheld.
        if (!verbose) return [];
        return [{
          kind: 'system', key: key(), nodeId: event.nodeId, depth,
          text: `${event.type} ${JSON.stringify(event.payload).slice(0, 160)}`, tone: 'info',
        }];
      }

      if (lastSpeaker !== event.nodeId) {
        blocks.push(headerFor(event.nodeId, meta));
        lastSpeaker = event.nodeId;
      }
      for (const r of results) {
        blocks.push({ kind: 'line', key: r.line.key, nodeId: event.nodeId, depth, action: r.action, line: r.line });
      }
      return blocks;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tui/transcript.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tui/transcript.ts src/tui/transcript.test.ts
git commit -m "feat: add transcript reducer with per-node attribution and interleaving"
```

---

### Task 5: Transcript reducer — lifecycle narration

**Files:**
- Modify: `src/tui/transcript.ts`
- Test: `src/tui/transcript.test.ts` (extend)

**Interfaces:**
- Produces: `system` blocks narrating what a state transition *meant*. Directly fixes the "shows nothing between states" complaint.

- [ ] **Step 1: Write the failing test**

```ts
// src/tui/transcript.test.ts — add
it('narrates lifecycle milestones instead of printing bare state names', () => {
  const t = createTranscript(() => NODE_META);
  const created = t.feed({ id: 1, nodeId: 'a', type: 'state.transition', payload: { state: 'CREATED' }, createdAt: 't0' });
  expect(created.some((b) => b.kind === 'system' && /created/i.test(b.text))).toBe(true);

  const done = t.feed({ id: 2, nodeId: 'a', type: 'state.transition', payload: { state: 'COMPLETE' }, createdAt: 't0' });
  expect(done.some((b) => b.kind === 'system' && b.tone === 'good')).toBe(true);

  const cancelled = t.feed({ id: 3, nodeId: 'b', type: 'state.transition', payload: { state: 'CANCELLED' }, createdAt: 't0' });
  expect(cancelled.some((b) => b.kind === 'system' && /cancelled/i.test(b.text))).toBe(true);
});

it('narrates a decision with its outcome and reason, not just a state name', () => {
  const t = createTranscript(() => NODE_META);
  const blocks = t.feed({
    id: 1, nodeId: 'a', type: 'decision.made', createdAt: 't0',
    payload: { outcome: 'ESCALATE', breakdown: { score: 0.6, threshold: 0.3, requiredBudget: 1, availableBudget: 0.1 } },
  });
  const system = blocks.find((b) => b.kind === 'system');
  expect(system?.kind === 'system' && system.text).toContain('ESCALATE');
  expect(system?.kind === 'system' && system.text).toMatch(/\$1|\$0\.10/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tui/transcript.test.ts`
Expected: FAIL — transitions currently emit only a `header`, and `decision.made` is not handled.

- [ ] **Step 3: Add narration to `transcript.ts`, and publish the new event**

```ts
// src/tui/transcript.ts — add above createTranscript
const NARRATION: Record<string, { text: string; tone: 'info' | 'warn' | 'good' | 'bad' }> = {
  CREATED: { text: 'node created', tone: 'info' },
  INTELLIGENCE_GATE: { text: 'assessing uncertainty', tone: 'info' },
  SELF_EXECUTE: { text: 'executing in the sandbox', tone: 'info' },
  DELEGATE: { text: 'delegating to a child node', tone: 'info' },
  ESCALATE: { text: 'escalating — outside its authority', tone: 'warn' },
  WAIT_APPROVAL: { text: 'waiting for your approval', tone: 'warn' },
  VERIFY: { text: 'verifying the result', tone: 'info' },
  COMPLETE: { text: 'complete', tone: 'good' },
  FAILED: { text: 'failed', tone: 'bad' },
  CANCELLED: { text: 'cancelled by you', tone: 'warn' },
};

function narrateDecision(payload: unknown): string {
  const { outcome, breakdown } = payload as { outcome: string; breakdown: Record<string, number> };
  if (outcome === 'ESCALATE') {
    return `decided ESCALATE — delegating scored ${breakdown.score?.toFixed(2)} > ${breakdown.threshold}, `
      + `but it needs $${breakdown.requiredBudget?.toFixed(2)} and has $${breakdown.availableBudget?.toFixed(2)}`;
  }
  if (outcome === 'SELF_EXECUTE' && breakdown.reason_no_spawn_authority) {
    return 'decided SELF_EXECUTE — it has no authority to spawn children';
  }
  return `decided ${outcome} — score ${breakdown.score?.toFixed(2)} vs threshold ${breakdown.threshold}`;
}
```

In `feed`, inside the `state.transition` branch, append the narration block after the header:

```ts
        blocks.push(headerFor(event.nodeId, meta));
        const narration = NARRATION[state];
        if (narration) {
          blocks.push({ kind: 'system', key: key(), nodeId: event.nodeId, depth, ...narration });
        }
        lastSpeaker = event.nodeId;
        return blocks;
```

And add a branch for the new event type, before the `exec.` check:

```ts
      if (event.type === 'decision.made') {
        if (lastSpeaker !== event.nodeId) { blocks.push(headerFor(event.nodeId, meta)); lastSpeaker = event.nodeId; }
        blocks.push({ kind: 'system', key: key(), nodeId: event.nodeId, depth, text: narrateDecision(event.payload), tone: 'info' });
        return blocks;
      }
```

The daemon must actually publish that event. In `src/lifecycle/node-actor-manager.ts`, in the `decideExecution` actor, immediately after the existing `insertDecision(...)` call:

```ts
        const decisionAt = new Date().toISOString();
        const decisionEventId = appendEvent(db, {
          nodeId, type: 'decision.made',
          payload: { outcome: result.outcome, breakdown: result.breakdown }, createdAt: decisionAt,
        });
        publish({ id: decisionEventId, nodeId, type: 'decision.made',
          payload: { outcome: result.outcome, breakdown: result.breakdown }, createdAt: decisionAt });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tui/transcript.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite and commit**

Run: `npm run typecheck && sg docker -c "npx vitest run"`

```bash
git add src/tui/transcript.ts src/tui/transcript.test.ts src/lifecycle/node-actor-manager.ts
git commit -m "feat: narrate lifecycle transitions and decisions into the transcript"
```

---

### Task 6: Command registry

**Files:**
- Create: `src/tui/commands/index.ts`, `src/tui/commands/types.ts`
- Test: `src/tui/commands/index.test.ts`

**Interfaces:**
- Consumes: `Block` (Task 4), `nonNegativeNumber`/`resolveRepoPath` (`src/cli/validation.ts`), `tuiClient()` (`src/tui/client.ts`), `toContainerPath` (`src/k8s/kind.ts`), `formatScore` (`src/tui/format.ts`), `node.cancel` (Task 2), `events.recent` (Task 3).
- Produces: `COMMANDS: Command[]`, `parseInput(raw): ParsedInput`, `matchCommands(partial): Command[]`, `runInput(raw, ctx): Promise<Block[]>`. Consumed by Tasks 7 and 9.

- [ ] **Step 1: Write the failing test**

```ts
// src/tui/commands/index.test.ts
import { describe, it, expect } from 'vitest';
import { parseInput, matchCommands, COMMANDS } from './index.js';

describe('parseInput', () => {
  it('treats plain text as a run with the text as the goal', () => {
    expect(parseInput('add a retry to the http client')).toEqual({
      kind: 'command', name: 'run', args: 'add a retry to the http client',
    });
  });

  it('parses a slash command and its arguments', () => {
    expect(parseInput('/approve abc123')).toEqual({ kind: 'command', name: 'approve', args: 'abc123' });
    expect(parseInput('/tree')).toEqual({ kind: 'command', name: 'tree', args: '' });
  });

  it('reports an unknown slash command rather than starting a run named after it', () => {
    expect(parseInput('/nope')).toEqual({ kind: 'unknown', name: 'nope' });
  });

  it('ignores blank input', () => {
    expect(parseInput('   ')).toEqual({ kind: 'empty' });
  });
});

describe('matchCommands', () => {
  it('filters by prefix for the autocomplete menu', () => {
    expect(matchCommands('ap').map((c) => c.name)).toEqual(['approve', 'approvals']);
  });

  it('returns every command for a bare slash', () => {
    expect(matchCommands('').length).toBe(COMMANDS.length);
  });
});

describe('command registry integrity', () => {
  it('gives every command a summary, so /help and the menu can never be missing one', () => {
    for (const command of COMMANDS) {
      expect(command.summary.length).toBeGreaterThan(0);
    }
  });

  it('has no duplicate names', () => {
    const names = COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tui/commands`
Expected: FAIL — `Cannot find module './index'`.

- [ ] **Step 3: Write `src/tui/commands/types.ts`**

```ts
import type { Block } from '../transcript.js';

export interface CommandContext {
  /** Emits blocks into the transcript. Commands that produce output over time
   *  (e.g. /doctor running checks one by one) use this instead of returning. */
  emit(blocks: Block[]): void;
  setFocus(nodeId: string | null): void;
  setVerbose(on: boolean): void;
  clear(): void;
  quit(): void;
  loadHistory(count: number): Promise<void>;
  toggleNotify(): boolean;
}

export interface Command {
  name: string;
  summary: string;
  usage?: string;
  completeArg?: (partial: string) => Promise<string[]>;
  run(args: string, ctx: CommandContext): Promise<Block[]>;
}

export type ParsedInput =
  | { kind: 'empty' }
  | { kind: 'unknown'; name: string }
  | { kind: 'command'; name: string; args: string };
```

- [ ] **Step 4: Write `src/tui/commands/index.ts`**

Implement `COMMANDS` with every command from the spec's table. Key implementation notes, each of which prevents a specific failure:

```ts
import { tuiClient } from '../client.js';
import { nonNegativeNumber, resolveRepoPath } from '../../cli/validation.js';
import { toContainerPath } from '../../k8s/kind.js';
import { formatScore } from '../format.js';
import { CHECKS } from '../../cli/commands/doctor.js';
import type { Command, CommandContext, ParsedInput } from './types.js';
import type { Block } from '../transcript.js';

let seq = 0;
const outputBlock = (input: string, output: string[]): Block =>
  ({ kind: 'command', key: `cmd${seq++}`, input, output });

export function parseInput(raw: string): ParsedInput {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: 'empty' };
  if (!trimmed.startsWith('/')) return { kind: 'command', name: 'run', args: trimmed };
  const [word, ...rest] = trimmed.slice(1).split(/\s+/);
  const name = word.toLowerCase();
  if (!COMMANDS.some((c) => c.name === name)) return { kind: 'unknown', name };
  return { kind: 'command', name, args: rest.join(' ') };
}

export function matchCommands(partial: string): Command[] {
  return COMMANDS.filter((c) => c.name.startsWith(partial.toLowerCase()));
}

export async function runInput(raw: string, ctx: CommandContext): Promise<Block[]> {
  const parsed = parseInput(raw);
  if (parsed.kind === 'empty') return [];
  if (parsed.kind === 'unknown') {
    return [outputBlock(raw, [`Unknown command /${parsed.name} — /help lists them all.`])];
  }
  const command = COMMANDS.find((c) => c.name === parsed.name)!;
  try {
    return await command.run(parsed.args, ctx);
  } catch (err) {
    // A failed command must never take the TUI down with it.
    return [outputBlock(raw, [err instanceof Error ? err.message : String(err)])];
  }
}
```

Requirements for individual commands:

- **`run`** — flags `--spawn`, `--budget <usd>`, `--max-children <n>`, `--repo <path>`; everything left over is the goal. Validate with `nonNegativeNumber('budget')` / `nonNegativeNumber('max children')` and `resolveRepoPath`, then `toContainerPath`, then `tuiClient().node.create.mutate(...)`. Refuse an empty goal with a message rather than creating a node with none. `matchCommands` must still list it even though bare text routes here.
- **`tree`** — `tuiClient().node.tree.query()`, rendered with the same DFS ordering and indentation the deleted `screens/tree.tsx` used; port `orderAsTree` from that file into this module rather than rewriting it.
- **`why <id>`** — `decision.listForNode`, printing each decision's outcome and `breakdown` via `formatScore` (which exists precisely to stop `0.5999999999999999` reaching the screen).
- **`approve`/`reject`** — resolve the id to an approval via `node.listPendingApprovals`, then `node.resolveApproval`. Accept an 8-character id prefix and resolve it, since that is what the transcript displays; report ambiguity rather than guessing.
- **`stop <id>`** — `tuiClient().node.cancel.mutate({ nodeId })`.
- **`doctor`** — iterate `CHECKS` calling `check.run()` directly and `ctx.emit` a block per result. **Never call `runChecks`**: it drives Listr2, which writes to stdout and would corrupt the Ink render.
- **`focus`/`verbose`/`clear`/`quit`/`notify`/`history`** — delegate to the matching `ctx` callback; `focus` with no argument clears focus.
- **`help`** — generated from `COMMANDS`, so it cannot drift.
- **`completeArg`** — `approve`/`reject` complete from `node.listPendingApprovals`; `stop`/`focus` from `node.tree` filtered to non-terminal states; `why` from `node.tree`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/tui/commands`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tui/commands
git commit -m "feat: add slash command registry with parsing, matching and completion"
```

---

### Task 7: Input box

**Files:**
- Create: `src/tui/input-box.tsx`

**Interfaces:**
- Consumes: `matchCommands`, `COMMANDS` (Task 6).
- Produces: `<InputBox onSubmit={(raw: string) => void} onInterrupt={() => void} busy={boolean} />`. Consumed by Task 9.

No automated test — this is interactive Ink rendering, manually verified per this project's precedent (the logic it drives is already tested in Task 6).

- [ ] **Step 1: Write the component**

Requirements, each tied to a concrete failure it prevents:

- A bordered `<Box borderStyle="round">` containing `> ` and the current value with a block cursor.
- **Command menu:** when the value starts with `/` and has no space yet, render `matchCommands(partial)` below the box — name, summary, selected row highlighted. `↑↓` move the selection *within the menu*; `⇥` or `⏎` completes to `/<name> `.
- **History:** `↑↓` with the menu closed walk previously submitted lines. Keep the in-progress line so walking back down restores it — otherwise recalling history destroys what the user was typing.
- **Paste:** `usePaste((text) => setValue((v) => v + text))`. Without this a pasted multi-line goal is interpreted as a burst of keystrokes and submits on the first newline.
- **Interrupt:** `esc` closes the menu if open, otherwise calls `onInterrupt`.
- **Quit:** `ctrl+c` once shows `press ctrl+c again to quit` under the box; twice within 2s quits. This is why `q` no longer needs to be a global key, which is what created the escape-trap bug in the previous TUI.
- **Busy indicator:** when `busy`, show `@inkjs/ui`'s `<Spinner>` in the box's left gutter.
- Use `useWindowSize()` to truncate the menu to the terminal width.

- [ ] **Step 2: Commit**

```bash
git add src/tui/input-box.tsx
git commit -m "feat: add input box with command menu, history, completion and paste"
```

---

### Task 8: Transcript view and status line

**Files:**
- Create: `src/tui/transcript-view.tsx`, `src/tui/status-line.tsx`, `src/tui/notify.ts`

**Interfaces:**
- Consumes: `Block` (Task 4), `StreamLine` (`src/tui/stream-lines.tsx`), `daemon.stats` (Task 3).
- Produces: `<TranscriptView blocks={Block[]} live={Block[]} />`, `<StatusLine />`, `notifyApprovalNeeded(nodeId, goal)`, `notifyFinished(nodeId, goal, state)`. Consumed by Task 9.

- [ ] **Step 1: Write `transcript-view.tsx`**

- Finalized blocks render inside `<Static items={blocks}>{(block) => <BlockView key={block.key} block={block} />}</Static>`. `<Static>` renders only newly-appended items, which is what keeps a 500-event run smooth and leaves the terminal's own scrollback working.
- The `live` array renders below it, outside `<Static>`, in a normal `<Box>` — this is the currently-working node's pending tool call plus its spinner and elapsed seconds.
- `BlockView` dispatches on `block.kind`: `header` renders `┌─ <id8> · <goal> · <state>` indented by `depth`; `line` delegates to the existing `StreamLine` with a `│  ` gutter; `system` renders tone-coloured (`info` dim, `warn` yellow, `good` green, `bad` red); `command` renders the echoed input dimmed above its output lines.
- Truncate header goals with `wrap="truncate-end"` against `useWindowSize().columns` — the previous TUI shipped a bug where long goals wrapped and destroyed the tree layout.

- [ ] **Step 2: Write `status-line.tsx`**

Renders `2 running · 1 waiting on you · $0.26 · daemon ok`. Polls `tuiClient().daemon.stats.query()` on a 3s interval, and refreshes on demand when the shell tells it a bus event arrived. On a rejected call, render `daemon unreachable` in red rather than throwing.

- [ ] **Step 3: Write `notify.ts`**

```ts
import notifier from 'node-notifier';

let enabled = true;
export function setNotifyEnabled(on: boolean): boolean { enabled = on; return enabled; }
export function notifyEnabled(): boolean { return enabled; }

export function notifyApprovalNeeded(nodeId: string, goal: string): void {
  if (!enabled) return;
  notifier.notify({ title: 'org — approval needed', message: `${nodeId.slice(0, 8)} · ${goal}` });
}

export function notifyFinished(nodeId: string, goal: string, state: string): void {
  if (!enabled) return;
  notifier.notify({ title: `org — ${state.toLowerCase()}`, message: `${nodeId.slice(0, 8)} · ${goal}` });
}
```

- [ ] **Step 4: Commit**

```bash
git add src/tui/transcript-view.tsx src/tui/status-line.tsx src/tui/notify.ts
git commit -m "feat: add transcript view, status line and desktop notifications"
```

---

### Task 9: App shell — wiring, and deleting the old TUI

**Files:**
- Rewrite: `src/tui/app.tsx`
- Modify: `src/cli/commands/dashboard.tsx`, `src/tui/stream-lines.tsx`
- Delete: `src/tui/screens/` (all six), `src/tui/navigation.ts`, `src/tui/navigation.test.ts`, `src/tui/input-mode.ts`, `src/tui/use-node-stream.tsx`

**Interfaces:**
- Consumes: everything from Tasks 4–8.

- [ ] **Step 1: Rewrite `app.tsx`**

Responsibilities, in order:

1. Hold `blocks: Block[]` (finalized) and `live: Block[]` (the repainting tail), plus a `nodeMeta` map kept fresh from `node.tree` so the transcript can resolve goals and parent ids.
2. On mount: `events.recent.query({ limit: 200 })`, feed each through the transcript, then open `events.subscribe.subscribe({})` for everything live. Open the subscription **before** the history query and buffer what arrives until history has been fed, de-duplicating by row id — the same ordering `use-node-stream.tsx` established and the reason `BusEvent` carries `id`.
3. Route a block to `live` when it is a `tool-pending` line; move it to `blocks` when an `update` for the same `line.key` arrives, or when its node speaks again. Everything else appends straight to `blocks`.
4. Refetch `node.tree` on any `state.transition` for an unknown node — that is delegation creating one.
5. Fire `notifyApprovalNeeded` on a transition to `WAIT_APPROVAL`, and `notifyFinished` on `COMPLETE`/`FAILED`/`CANCELLED` for a node with no parent.
6. Build the `CommandContext` and pass `runInput` to `<InputBox onSubmit>`. `onInterrupt` cancels the focused node, or the single running node if exactly one is running; with several running and none focused, emit a block saying which ids are candidates rather than guessing.
7. `/clear` writes `\x1b[2J\x1b[3J\x1b[H` via `useStdout().write`, empties `blocks`, and increments a `staticKey` used as `<Static key={staticKey}>` — remounting is what lets `<Static>` start over.

- [ ] **Step 2: Point the CLI at it and delete the old screens**

`src/cli/commands/dashboard.tsx` keeps its current shape (start the daemon if not running, `render(<App />)`, `await waitUntilExit()`); only the import target changes if `App`'s path moves. Then:

```bash
git rm -r src/tui/screens
git rm src/tui/navigation.ts src/tui/navigation.test.ts src/tui/input-mode.ts src/tui/use-node-stream.tsx
```

Drop the now-unused `StreamLines` list wrapper from `src/tui/stream-lines.tsx`, keeping `StreamLine`. Confirm nothing dangles before committing:

```bash
grep -rn "screens/\|navigation\.js\|input-mode\|use-node-stream\|StreamLines" src
```

- [ ] **Step 3: Verify the build and suite**

Run: `npm run typecheck && sg docker -c "npx vitest run" && npm run build`
Expected: PASS. The suite loses `navigation.test.ts`'s 4 tests and gains Tasks 1–6's.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: replace the drill-down TUI with a single-transcript Claude Code-style shell"
```

---

### Task 10: End-to-end verification against a real cluster

**Files:** none — this is the acceptance test for the whole plan.

Prerequisites: `org doctor` all-green, and a throwaway git repo **under your home directory** (`toContainerPath` rejects anything outside it):

```bash
rm -rf ~/tui-check && mkdir ~/tui-check && cd ~/tui-check && git init -q \
  && printf 'hello\n' > file.txt && git add -A && git -c user.email=a@b -c user.name=t commit -qm init
```

- [ ] **Step 1: Discoverability** — open `org`, type `/`, confirm the menu lists every command with its summary; `⇥` completes; `?` on an empty input shows help.

- [ ] **Step 2: Plain-text run** — type `add a line saying world to file.txt` and press enter. Confirm a node is created and the transcript narrates creation, the decision *with its reason*, then streams real Claude Code output — reasoning, tool calls resolving in place, and a real diff — progressively rather than all at once. This is the acceptance criterion for the whole redesign.

- [ ] **Step 3: Concurrency** — start a second run while the first is going. Confirm speaker headers appear as output interleaves and that neither node's tool calls resolve against the other's. Then `/focus <id>` and confirm subsequent output is narrowed, and bare `/focus` restores.

- [ ] **Step 4: Cancellation** — start a run, then `/stop <id>` mid-execution. Confirm the transcript reports it cancelled, `org tree` shows `CANCELLED` (not `FAILED`), and the cluster is clean:

```bash
sg docker -c "kubectl get jobs,secrets,networkpolicy -n org-exec"
```

Expected: only `default-deny-all` remains.

- [ ] **Step 5: Approval** — start `/run --spawn --budget 0.1 --max-children 2 <a goal over 150 characters, which is what makes assessUncertainty rate it 'high' and the economics score clear the threshold>`. Confirm it narrates the escalation with the budget shortfall, the status line shows `1 waiting on you`, a desktop notification fires, and `/approve <id>` resumes it into `DELEGATE`.

- [ ] **Step 6: History and depth** — quit and reopen `org`; confirm recent activity is replayed and reading a finished run needs no navigation. Confirm `/why <id>` prints the full breakdown with clean numbers, and `/verbose` reveals the suppressed system/hook events.

- [ ] **Step 7: Plain CLI untouched** — `org tree`, `org decision <id>`, `org approvals` behave exactly as before. The TUI is additive to the scriptable surface.

- [ ] **Step 8: Clean up** — `org daemon stop && rm -rf ~/tui-check`.

---

## Verification summary

| Layer | How it is verified |
|---|---|
| Cancellation (machine) | Unit tests, Task 1 |
| Cancellation (cluster) | Real-cluster integration tests, Task 2 |
| History paging, stats | Unit tests, Task 3 |
| Interleaving, attribution, narration | Unit tests over real captured Claude Code fixtures, Tasks 4–5 |
| Command parsing, registry integrity | Unit tests, Task 6 |
| Ink rendering | Manual, Task 10 — thin shell over tested logic |
| The actual goal | Task 10 Step 2: real Claude Code output streaming live into the transcript |

## Self-review notes

- **Spec coverage:** every spec section maps to a task — transcript reducer → 4/5, command registry → 6, input box → 7, status line and notifications → 8, `<Static>` and forward-only `/focus`+`/clear` → 8/9, backend changes → 1/2/3, file deletions → 9, testing → throughout.
- **Type consistency:** `Block`, `Command`, `CommandContext`, `ParsedInput`, `NodeMeta` are defined once (Tasks 4 and 6) and referenced by those names everywhere after.
- **One gap deliberately left:** `decision.made` is a *new* event type introduced in Task 5. Runs recorded before this change have no such event, so `/why` (which reads the `decisions` table directly, not the event log) remains the way to see decisions for historical nodes. This is correct, not an oversight.

# Interactive TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Before starting:** create an isolated workspace via superpowers:using-git-worktrees, branched from `main` at the current HEAD (Phase 5 + OAuth relay complete).
>
> **Skills to invoke during execution:**
> - superpowers:test-driven-development governs every backend task's step rhythm (Tasks 1–9).
> - superpowers:systematic-debugging — invoke if the WebSocket subscription or follow-mode log streaming misbehaves (Tasks 3, 6–7); these touch library APIs (`@kubernetes/client-node`'s `Log` class, `@trpc/server`'s Fastify+WS adapter) whose exact shape should be verified against the installed version, not assumed from memory — see the callouts in each task.
> - superpowers:requesting-code-review — invoke once Task 17 (final manual verification) passes, before merging.
> - superpowers:verification-before-completion — invoke before declaring this done: the acceptance test is watching a real Claude Code run's actual output stream live inside the TUI, not a green test suite alone.
> - superpowers:finishing-a-development-branch — invoke after the review.

**Goal:** Replace `org watch`'s flat polling list with a full-screen, drill-down interactive dashboard — the primary way this tool is used day to day — showing the tree, each node's lifecycle position, its intelligence/economics decisions with full score breakdowns, and its actual Claude Code output rendered live and legibly as it executes.

**Architecture:** Per the approved spec — an internal pub/sub event bus fed by a new follow-mode K8s log stream, exposed to clients over a new tRPC WebSocket subscription, consumed by an Ink drill-down application. See the spec for the full rationale; this plan only decides implementation-level specifics the spec left at the "what," not "exactly how."

**Tech Stack additions:** `@fastify/websocket` (WebSocket transport for tRPC subscriptions — previously scoped, never installed).

**Spec:** [docs/superpowers/specs/2026-09-05-interactive-tui-design.md](../specs/2026-09-05-interactive-tui-design.md) — implements it section by section; §4–§7 map directly to Tasks 10–16.

## A critical gap found while grounding this plan in real data (gap G8)

Before designing the live-output renderer, real Claude Code output was captured directly (`claude --print --output-format stream-json --verbose --dangerously-skip-permissions "..."`, both with and without `--include-partial-messages`) and compared against what the running system actually persists. **Zero `exec.*` events have ever been captured for any real Claude Code run** — a real, throwaway-repo `org run` was executed as part of this investigation, genuinely edited the target file (confirmed by reading it after), yet the `events` table held nothing for it. `claudeCodeAdapter.parseEventStream` in `src/adapters/claude-code.ts` parses each raw JSON line and validates it directly against `StructuredEventSchema` (`{ type: string, payload: unknown }`) — but real Claude Code lines look like `{"type":"assistant","message":{"content":[...]}}`, with no `payload` field at all, so `safeParse` fails on every single line, silently (`continue` on failure is correct behavior for a malformed line; it's just that every real line was being misclassified as malformed). This schema was evidently modeled on the synthetic stopgap adapter's invented shape, not real Claude Code's actual protocol, and nothing before this exercise had inspected the `events` table content after a real run to notice.

Real captured shapes (trimmed, from actual output — used as this plan's test fixtures, not invented):

```json
{"type":"system","subtype":"hook_started"}
{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"","signature":"..."}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_017sUm9FH8qVNd1CxKSqW5pX","name":"Read","input":{"file_path":"/host/repo/file.txt"}}]}}
{"type":"user","message":{"content":[{"tool_use_id":"toolu_017sUm9FH8qVNd1CxKSqW5pX","type":"tool_result","content":"1\thello\n"}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_015RMEiCTDYFmonMv4BxXeVy","name":"Edit","input":{"file_path":"/host/repo/file.txt","old_string":"hello\n","new_string":"hello\nworld\n"}}]}}
{"type":"user","message":{"content":[{"tool_use_id":"toolu_015RMEiCTDYFmonMv4BxXeVy","type":"tool_result","content":"updated"}]},"tool_use_result":{"structuredPatch":[{"oldStart":1,"oldLines":1,"newStart":1,"newLines":2,"lines":[" hello","+world"]}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"Done. Appended \"world\"."}]}}
{"type":"result","total_cost_usd":0.0353599,"duration_api_ms":10191}
{"type":"rate_limit_event"}
```

Also confirmed: `--include-partial-messages` exists and gives true Anthropic-Messages-API-style token-level `content_block_delta` events — real token-by-token typing is technically possible, but parsing that correctly (accumulating deltas by content-block index, distinguishing `thinking_delta`/`text_delta`/`input_json_delta`) is a meaningfully larger parsing task than consuming the plain complete-message stream. This plan uses the plain stream for v1 (you still see each reasoning block, tool call, and diff appear live as Claude works — just not mid-sentence) and tracks true token-level typing as an explicit stretch item at the end, not a silent scope cut.

---

### Task 1 (gap fix G8): Correct the Claude Code event-wrapping bug

**Files:**
- Modify: `src/adapters/claude-code.ts`, `src/adapters/adapter.ts`
- Test: `src/adapters/claude-code.test.ts`

**Interfaces:**
- Produces: `RuntimeAdapter` gains `parseLine(line: string): StructuredEvent | null` (new primitive); `parseEventStream` is reimplemented in terms of it (no change to its own signature or callers). `StructuredEvent`'s shape (`{ type: string, payload: unknown }`) is unchanged — the fix is in how the adapter wraps a raw line into that envelope, not the envelope itself.

- [ ] **Step 1: Write the failing test using the real captured fixtures**

```ts
// src/adapters/claude-code.test.ts — extend the existing file
import { Readable } from 'node:stream';
import { claudeCodeAdapter } from './claude-code.js';

const REAL_FIXTURE_LINES = [
  '{"type":"system","subtype":"hook_started"}',
  '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"","signature":"abc"}]}}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"/host/repo/file.txt"}}]}}',
  '{"type":"user","message":{"content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"1\\thello\\n"}]}}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_2","name":"Edit","input":{"file_path":"/host/repo/file.txt","old_string":"hello\\n","new_string":"hello\\nworld\\n"}}]}}',
  '{"type":"user","message":{"content":[{"tool_use_id":"toolu_2","type":"tool_result","content":"updated"}]},"tool_use_result":{"structuredPatch":[{"oldStart":1,"oldLines":1,"newStart":1,"newLines":2,"lines":[" hello","+world"]}]}}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"Done."}]}}',
  '{"type":"result","total_cost_usd":0.035,"duration_api_ms":10191}',
  '{"type":"rate_limit_event"}',
];

describe('claudeCodeAdapter — real event shape (gap G8)', () => {
  it('wraps every real Claude Code line as {type, payload: <raw line>}, losing none of them', async () => {
    const stream = Readable.from(REAL_FIXTURE_LINES.map((l) => l + '\n'));
    const events = await claudeCodeAdapter.parseEventStream(stream);
    expect(events).toHaveLength(REAL_FIXTURE_LINES.length);
    expect(events.map((e) => e.type)).toEqual([
      'system', 'assistant', 'assistant', 'user', 'assistant', 'user', 'assistant', 'result', 'rate_limit_event',
    ]);
    // The payload is the whole raw object, not a subset — the renderer (Task 9)
    // needs the real nested shape (message.content, tool_use_result, etc.).
    expect((events[2].payload as { message: { content: [{ name: string }] } }).message.content[0].name).toBe('Read');
  });

  it('parseLine returns a single wrapped event for one line, and null for a blank/malformed one', () => {
    expect(claudeCodeAdapter.parseLine('{"type":"result","total_cost_usd":0.1}')).toEqual({
      type: 'result', payload: { type: 'result', total_cost_usd: 0.1 },
    });
    expect(claudeCodeAdapter.parseLine('')).toBeNull();
    expect(claudeCodeAdapter.parseLine('not json')).toBeNull();
    expect(claudeCodeAdapter.parseLine('{"no_type_field": true}')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- claude-code.test`
Expected: FAIL — the first test currently gets 0 events (the bug), and `parseLine` doesn't exist yet.

- [ ] **Step 3: Fix `adapter.ts` and `claude-code.ts`**

```ts
// src/adapters/adapter.ts — add parseLine to the interface
export interface RuntimeAdapter {
  name: string;
  buildCommand(goal: string): string[];
  /** Wraps one raw output line as a StructuredEvent, or null if it's not a
   *  recognizable event (blank, malformed JSON, or missing a `type` field). */
  parseLine(line: string): StructuredEvent | null;
  parseEventStream(stream: NodeJS.ReadableStream): Promise<StructuredEvent[]>;
}
```

```ts
// src/adapters/claude-code.ts — replace the whole file
import { createInterface } from 'node:readline';
import type { RuntimeAdapter, StructuredEvent } from './adapter.js';

export const claudeCodeAdapter: RuntimeAdapter = {
  name: 'claude-code',

  buildCommand(goal: string): string[] {
    return ['claude', '--print', '--output-format', 'stream-json', '--verbose',
      '--dangerously-skip-permissions', goal];
  },

  // Gap G8 fix: real Claude Code lines carry no `payload` field — they ARE the
  // payload, with `type` as a sibling key (`{"type":"assistant","message":{...}}`),
  // not `{"type":"...","payload":{...}}`. The previous version validated the raw
  // line directly against the {type, payload} envelope and silently discarded
  // every real line as "malformed" — verified against real captured output, not
  // assumed. The fix wraps the raw object as the payload instead of expecting it
  // to already match the envelope.
  parseLine(line: string): StructuredEvent | null {
    if (!line.trim()) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return null;
    }
    if (typeof raw !== 'object' || raw === null || typeof (raw as { type?: unknown }).type !== 'string') {
      return null;
    }
    return { type: (raw as { type: string }).type, payload: raw };
  },

  async parseEventStream(stream: NodeJS.ReadableStream): Promise<StructuredEvent[]> {
    const events: StructuredEvent[] = [];
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
      const event = this.parseLine(line);
      if (event) events.push(event);
    }
    return events;
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- claude-code.test`
Expected: PASS — 2 tests passed.

- [ ] **Step 5: Apply the same `parseLine` addition to the stopgap adapter, so both adapters satisfy the updated interface**

```ts
// src/adapters/stopgap.ts — add parseLine (delegates to the same logic claude-code.ts uses,
// since the stopgap already emits {"type":...,"payload":...} shaped lines that need no
// re-wrapping — but it must still implement the interface)
import { claudeCodeAdapter } from './claude-code.js';

export const stopgapAdapter: RuntimeAdapter = {
  name: 'stopgap',
  buildCommand: (goal) => { /* ... unchanged ... */ },
  parseLine: claudeCodeAdapter.parseLine,
  parseEventStream: claudeCodeAdapter.parseEventStream,
};
```

Note: the stopgap's own fixture lines (`{"type":"message","payload":{"text":...}}`) already happen to have a `type` field, so wrapping them again (`{ type: 'message', payload: <the whole original object, which itself has a payload field> }`) changes their shape slightly — nested one level deeper than before. Check `src/execution/execute-step.integration.test.ts`'s assertions against `result.events[0].payload` after this change; update them to match the new nesting if they break, following the same real-shape-first principle as this task.

- [ ] **Step 6: Run the full suite**

Run: `sg docker -c "npm test"`
Expected: PASS — including the stopgap-based integration test, possibly after the Step 5 nesting-shape correction.

- [ ] **Step 7: Manually re-verify with a real run that events now actually populate**

```bash
sg docker -c "env ORG_DB_PATH=/tmp/g8-verify.db ORG_DAEMON_PORT=4288 ORG_DAEMON_NAME=g8-verify node dist/cli/index.js run 'add a comment to the top of file.txt' --repo <a real throwaway repo>"
```

Wait for `COMPLETE`, then: `sqlite3 /tmp/g8-verify.db "SELECT type FROM events WHERE type LIKE 'exec.%'"` — expected: several rows (`exec.assistant`, `exec.user`, `exec.result`, etc.), not zero. Clean up the throwaway db/repo afterward.

- [ ] **Step 8: Commit**

```bash
git add src/adapters
git commit -m "fix: correctly wrap real Claude Code stream-json lines instead of validating them against the wrong shape (gap G8)"
```

---

### Task 2: Internal event bus

**Files:**
- Create: `src/events/bus.ts`
- Test: `src/events/bus.test.ts`

**Interfaces:**
- Produces: `interface BusEvent { nodeId: string; type: string; payload: unknown; createdAt: string }`, `publish(event: BusEvent): void`, `subscribeAll(handler): () => void`, `subscribeToNode(nodeId, handler): () => void` — consumed by Task 5 (node-actor-manager publishing) and Task 6 (the tRPC subscription reading).

- [ ] **Step 1: Write the failing test**

```ts
// src/events/bus.test.ts
import { describe, it, expect, vi } from 'vitest';
import { publish, subscribeAll, subscribeToNode } from './bus.js';

describe('event bus', () => {
  it('delivers a published event to a global subscriber', () => {
    const handler = vi.fn();
    const unsubscribe = subscribeAll(handler);
    publish({ nodeId: 'n1', type: 'test', payload: {}, createdAt: 't0' });
    expect(handler).toHaveBeenCalledWith({ nodeId: 'n1', type: 'test', payload: {}, createdAt: 't0' });
    unsubscribe();
  });

  it('delivers only matching-node events to a per-node subscriber', () => {
    const handler = vi.fn();
    const unsubscribe = subscribeToNode('n1', handler);
    publish({ nodeId: 'n1', type: 'a', payload: {}, createdAt: 't0' });
    publish({ nodeId: 'n2', type: 'b', payload: {}, createdAt: 't0' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].nodeId).toBe('n1');
    unsubscribe();
  });

  it('stops delivering after unsubscribe', () => {
    const handler = vi.fn();
    const unsubscribe = subscribeAll(handler);
    unsubscribe();
    publish({ nodeId: 'n1', type: 'test', payload: {}, createdAt: 't0' });
    expect(handler).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- bus.test`
Expected: FAIL — `Cannot find module './bus'`.

- [ ] **Step 3: Write `events/bus.ts`**

```ts
// src/events/bus.ts
import { EventEmitter } from 'node:events';

export interface BusEvent {
  nodeId: string;
  type: string;
  payload: unknown;
  createdAt: string;
}

const emitter = new EventEmitter();
// A daemon can run many nodes and many TUI/subscription clients over its
// lifetime; the default limit of 10 would print spurious warnings.
emitter.setMaxListeners(200);

export function publish(event: BusEvent): void {
  emitter.emit('event', event);
  emitter.emit(`event:${event.nodeId}`, event);
}

export function subscribeAll(handler: (event: BusEvent) => void): () => void {
  emitter.on('event', handler);
  return () => emitter.off('event', handler);
}

export function subscribeToNode(nodeId: string, handler: (event: BusEvent) => void): () => void {
  emitter.on(`event:${nodeId}`, handler);
  return () => emitter.off(`event:${nodeId}`, handler);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- bus.test`
Expected: PASS — 3 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/events
git commit -m "feat: add internal event bus for live state/output delivery"
```

---

### Task 3: Follow-mode K8s log streaming

**Files:**
- Modify: `src/k8s/client.ts`
- Test: `src/k8s/client.test.ts` (extend)

**Interfaces:**
- Produces: `followJobLogs(jobName: string, namespace: string, onLine: (line: string) => void): Promise<() => void>` (the returned function stops following) — consumed by Task 4.

**Verify-at-implementation note:** this uses `@kubernetes/client-node`'s `Log` helper class (`kc.makeApiClient` is for REST resources; `Log` is a separate helper for the streaming log endpoint). Confirm its exact constructor/method signature against the installed `^2.0.0` against its type definitions or `node_modules/@kubernetes/client-node/dist/*.d.ts` before writing Step 3 for real — major-version client libraries can rename this between releases. The test in Step 1 will fail clearly (not silently) if the shape has drifted, per this project's established pattern for version-uncertain APIs.

- [ ] **Step 1: Write the failing integration test**

```ts
// src/k8s/client.test.ts — add this describe block (uses the same CLUSTER_AVAILABLE guard already in this file)
import { followJobLogs } from './client.js';

describe.skipIf(!CLUSTER_AVAILABLE)('followJobLogs', () => {
  it('delivers log lines progressively while the Job is still running, not all at once at the end', async () => {
    const job = buildExecutionJob({
      nodeId: 'test-follow', namespace: 'default', image: 'busybox:1.36',
      command: ['sh', '-c', 'echo line1; sleep 2; echo line2; sleep 2; echo line3'],
      worktreePath: '/tmp', secretName: 'nonexistent-optional',
    });
    await execa('kubectl', ['create', 'secret', 'generic', 'nonexistent-optional', '--from-literal=x=y', '-n', 'default']).catch(() => {});

    const jobName = await createJob(job);
    const received: { line: string; at: number }[] = [];
    const start = Date.now();
    const stop = await followJobLogs(jobName, 'default', (line) => {
      received.push({ line, at: Date.now() - start });
    });

    await waitForJobCompletion(jobName, 'default');
    stop();

    expect(received.map((r) => r.line)).toEqual(['line1', 'line2', 'line3']);
    // The whole thing ran over ~4s of sleeps; if every line arrived within the
    // same handful of milliseconds, this isn't actually following — it's a
    // buffered fetch that happened to run after completion.
    expect(received[2].at - received[0].at).toBeGreaterThan(1500);

    await deleteJob(jobName, 'default');
    await execa('kubectl', ['delete', 'secret', 'nonexistent-optional', '-n', 'default']).catch(() => {});
  }, 30_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `sg docker -c "npm test -- client.test"`
Expected: FAIL — `Cannot find module`, or a runtime error naming whatever's actually different about the installed `Log` class's API (read the error before writing Step 3, don't guess past it).

- [ ] **Step 3: Write `followJobLogs` in `k8s/client.ts`**

```ts
// src/k8s/client.ts — add this function and update loadApis() to also return the KubeConfig
function loadApis() {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  return {
    kc,
    batch: kc.makeApiClient(k8s.BatchV1Api),
    core: kc.makeApiClient(k8s.CoreV1Api),
  };
}

export async function followJobLogs(
  jobName: string,
  namespace: string,
  onLine: (line: string) => void,
): Promise<() => void> {
  const { kc, core } = loadApis();
  const pods = await core.listNamespacedPod({ namespace, labelSelector: `job-name=${jobName}` });
  const podName = pods.items[0]?.metadata?.name;
  if (!podName) return () => {};

  const { PassThrough } = await import('node:stream');
  const { createInterface } = await import('node:readline');
  const passthrough = new PassThrough();
  const rl = createInterface({ input: passthrough, crlfDelay: Infinity });
  rl.on('line', onLine);

  const log = new k8s.Log(kc);
  const abortController = new AbortController();
  await log.log(namespace, podName, 'runner', passthrough, { follow: true, signal: abortController.signal });

  return () => {
    abortController.abort();
    rl.close();
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `sg docker -c "npm test -- client.test"`
Expected: PASS — the three lines arrive with real time gaps between them, proving genuine streaming.

- [ ] **Step 5: Commit**

```bash
git add src/k8s/client.ts src/k8s/client.test.ts
git commit -m "feat: add follow-mode Kubernetes pod log streaming"
```

---

### Task 4: Wire `execute-step.ts` to stream live instead of fetching after completion

**Files:**
- Modify: `src/execution/execute-step.ts`
- Test: `src/execution/execute-step.test.ts` (extend)

**Interfaces:**
- Consumes: `followJobLogs` (Task 3), `parseLine` (Task 1).
- Produces: `ExecuteStepInput` gains `onEvent?: (event: StructuredEvent) => void`, called once per parsed line as it arrives, in addition to the unchanged final `events` array in the return value.

- [ ] **Step 1: Extend the existing injected-fakes test**

```ts
// src/execution/execute-step.test.ts — add this test to the existing describe block
it('calls onEvent for each line as followJobLogs delivers it, and still returns the full collected array', async () => {
  const onEvent = vi.fn();
  const deps = {
    createEphemeralSecret: vi.fn(async () => 'secret-1'),
    deleteSecret: vi.fn(async () => {}),
    applyNetworkPolicy: vi.fn(async () => {}),
    getKubeDnsClusterIp: vi.fn(async () => '10.96.0.10'),
    createJob: vi.fn(async () => 'job-1'),
    followJobLogs: vi.fn(async (_jobName: string, _ns: string, onLine: (line: string) => void) => {
      onLine('{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}');
      onLine('{"type":"result","total_cost_usd":0.01}');
      return () => {};
    }),
    waitForJobCompletion: vi.fn(async () => ({ succeeded: true, message: 'ok' })),
    deleteJob: vi.fn(async () => {}),
  };

  const result = await executeStep(
    { nodeId: 'n1', goal: 'test', namespace: 'org-exec', worktreePath: '/tmp/w', credentials: {}, adapter: fakeAdapter, onEvent },
    deps,
  );

  expect(onEvent).toHaveBeenCalledTimes(2);
  expect(result.events).toHaveLength(2);
  expect(result.events[0].type).toBe('assistant');
});
```

Note: `fakeAdapter` (defined earlier in this test file) needs a `parseLine` matching Task 1's interface addition — extend its definition: `parseLine: (line) => { try { return JSON.parse(line); } catch { return null; } }` (a minimal fake, not the real Claude-shape wrapping — this test only cares that `executeStep` calls `parseLine` per line and forwards the result, not adapter correctness).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- execute-step.test`
Expected: FAIL — `followJobLogs`/`onEvent` don't exist in the current implementation yet.

- [ ] **Step 3: Rewrite `executeStep`**

```ts
// src/execution/execute-step.ts — replace the deps interface, defaultDeps, and the function body
import { followJobLogs } from '../k8s/client.js';
// (remove the streamJobLogs import — it is no longer used here; leave it exported
// from k8s/client.ts in case something else needs a one-shot historical fetch later)

export interface ExecuteStepInput {
  nodeId: string;
  goal: string;
  namespace: string;
  worktreePath: string;
  credentials: Record<string, string>;
  adapter: RuntimeAdapter;
  image?: string;
  /** Called once per structured event, as it arrives — not after the Job
   *  finishes. This is what makes live output possible; node-actor-manager.ts
   *  uses it to append to the DB and publish to the event bus in real time. */
  onEvent?: (event: StructuredEvent) => void;
}

export interface ExecuteStepDeps {
  createEphemeralSecret: typeof createEphemeralSecret;
  deleteSecret: typeof deleteSecret;
  applyNetworkPolicy: typeof applyNetworkPolicy;
  getKubeDnsClusterIp: typeof getKubeDnsClusterIp;
  createJob: typeof createJob;
  followJobLogs: typeof followJobLogs;
  waitForJobCompletion: typeof waitForJobCompletion;
  deleteJob: typeof deleteJob;
}

const defaultDeps: ExecuteStepDeps = {
  createEphemeralSecret, deleteSecret, applyNetworkPolicy, getKubeDnsClusterIp,
  createJob, followJobLogs, waitForJobCompletion, deleteJob,
};

export async function executeStep(
  input: ExecuteStepInput,
  deps: Partial<ExecuteStepDeps> = {},
): Promise<ExecuteStepResult> {
  const d = { ...defaultDeps, ...deps };

  const secretName = await d.createEphemeralSecret(input.nodeId, input.credentials, input.namespace);
  try {
    const dnsIp = await d.getKubeDnsClusterIp();
    const policy = buildEgressAllowlistPolicy(input.nodeId, DEFAULT_EGRESS_ALLOWLIST, [
      { to: [{ ipBlock: { cidr: `${dnsIp}/32` } }], ports: [{ port: 53, protocol: 'UDP' }, { port: 53, protocol: 'TCP' }] },
    ]);
    await d.applyNetworkPolicy(policy, input.namespace);

    const job = buildExecutionJob({
      nodeId: input.nodeId, namespace: input.namespace, image: input.image ?? RUNNER_IMAGE,
      command: input.adapter.buildCommand(input.goal), worktreePath: input.worktreePath, secretName,
      includeOauthCredentials: 'CLAUDE_CREDENTIALS_JSON' in input.credentials,
    });

    const jobName = await d.createJob(job);
    try {
      const collected: StructuredEvent[] = [];
      const stopFollowing = await d.followJobLogs(jobName, input.namespace, (line) => {
        const event = input.adapter.parseLine(line);
        if (event) {
          collected.push(event);
          input.onEvent?.(event);
        }
      });

      const jobResult = await d.waitForJobCompletion(jobName, input.namespace);
      stopFollowing();

      return { succeeded: jobResult.succeeded, message: jobResult.message, events: collected };
    } finally {
      await d.deleteJob(jobName, input.namespace);
    }
  } finally {
    await d.deleteSecret(secretName, input.namespace);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- execute-step.test`
Expected: PASS.

- [ ] **Step 5: Run the full suite, including the real-cluster integration test**

Run: `sg docker -c "npm test"`
Expected: PASS — `execute-step.integration.test.ts` now exercises real follow-mode streaming end-to-end against the cluster, not the old fetch-after-completion path.

- [ ] **Step 6: Commit**

```bash
git add src/execution
git commit -m "feat: stream execute-step's output live via followJobLogs, not after Job completion"
```

---

### Task 5: Wire the event bus into `node-actor-manager.ts`

**Files:**
- Modify: `src/lifecycle/node-actor-manager.ts`

**Interfaces:**
- Consumes: `publish` (Task 2).
- Produces: no new exports — every state transition and every execution event now also reaches the bus, in addition to the unchanged SQLite writes.

- [ ] **Step 1: Update the `executeStep` actor's callback to publish live instead of looping after the fact**

```ts
// src/lifecycle/node-actor-manager.ts — add the import
import { publish } from '../events/bus.js';

// ... inside productionMachine's actors.executeStep:
executeStep: fromPromise(async ({ input }) => {
  const node = getNode(db, nodeId);
  const result = await executeStep({
    nodeId,
    goal: input.goal,
    namespace: NAMESPACE,
    worktreePath: node?.repoPath ?? process.env.ORG_WORKTREE_PATH ?? `/tmp/org-worktrees/${nodeId}`,
    credentials: resolveCredentials(os.homedir(), process.env.ANTHROPIC_API_KEY),
    adapter: runnerImageOverride() ? stopgapAdapter : claudeCodeAdapter,
    image: runnerImageOverride(),
    // Was: a loop over result.events run once, after the whole Job finished.
    // Now: called per-event, live, as executeStep's follow-mode stream delivers
    // them — this is what makes the TUI's live output section real.
    onEvent: (event) => {
      const now = new Date().toISOString();
      appendEvent(db, { nodeId, type: `exec.${event.type}`, payload: event.payload, createdAt: now });
      publish({ nodeId, type: `exec.${event.type}`, payload: event.payload, createdAt: now });
    },
  });
  return result;
}),
```

- [ ] **Step 2: Update `startNodeActor`'s state-transition subscription to also publish**

```ts
// src/lifecycle/node-actor-manager.ts — inside startNodeActor's actor.subscribe callback
actor.subscribe((snapshot) => {
  const now = new Date().toISOString();
  updateNodeState(db, nodeId, String(snapshot.value), now);
  appendEvent(db, { nodeId, type: 'state.transition', payload: { state: snapshot.value }, createdAt: now });
  publish({ nodeId, type: 'state.transition', payload: { state: snapshot.value }, createdAt: now });

  // ... rest (terminal-state cleanup) unchanged ...
});
```

- [ ] **Step 3: Run the full suite**

Run: `sg docker -c "npm test"`
Expected: PASS — this is a pure addition (extra `publish` calls alongside existing behavior), nothing observable by existing tests changes.

- [ ] **Step 4: Commit**

```bash
git add src/lifecycle/node-actor-manager.ts
git commit -m "feat: publish state transitions and execution events to the bus in real time"
```

---

### Task 6: tRPC subscription over WebSocket

**Files:**
- Modify: `src/server/routers/events.ts`, `src/server/app.ts`
- Test: `src/server/routers/events.test.ts` (new)

**Interfaces:**
- Produces: `events.subscribe` tRPC subscription procedure, optionally filtered by `nodeId` — consumed by Task 7's client-side `wsLink`.

**Verify-at-implementation note:** confirm `@fastify/websocket`'s current registration API and whether `@trpc/server`'s Fastify adapter needs an explicit option (e.g. `useWSS`) to activate WebSocket handling on the same route prefix, against the actually-installed `@trpc/server@^11.18.0` and whatever `@fastify/websocket` version npm resolves — both were researched as a general pattern earlier in this project's design phase, not pinned against this exact installed pair. The test in Step 2 fails immediately and clearly if the wiring is wrong; don't guess past a failure here.

- [ ] **Step 1: Install `@fastify/websocket`**

```bash
npm install @fastify/websocket
```

- [ ] **Step 2: Write the failing subscription test**

```ts
// src/server/routers/events.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client';
import { buildServer } from '../app.js';
import { publish } from '../../events/bus.js';
import type { AppRouter } from '../root-router.js';

const TEST_DB = './test-events-sub.db';
const TEST_PORT = 4477;

afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

describe('events.subscribe', () => {
  it('delivers a bus event published after the subscription starts', async () => {
    const app = buildServer(TEST_DB, () => {});
    await app.listen({ port: TEST_PORT, host: '127.0.0.1' });

    const wsClient = createWSClient({ url: `ws://127.0.0.1:${TEST_PORT}/trpc` });
    const client = createTRPCClient<AppRouter>({ links: [wsLink({ client: wsClient })] });

    const received: unknown[] = [];
    const subscription = client.events.subscribe.subscribe(
      { nodeId: 'n1' },
      { onData: (event) => received.push(event) },
    );

    await new Promise((r) => setTimeout(r, 200)); // let the subscription establish
    publish({ nodeId: 'n1', type: 'test', payload: { x: 1 }, createdAt: 't0' });
    publish({ nodeId: 'n2', type: 'test', payload: {}, createdAt: 't0' }); // must NOT arrive — different nodeId

    await new Promise((r) => setTimeout(r, 200));
    subscription.unsubscribe();
    wsClient.close();
    await app.close();

    expect(received).toHaveLength(1);
    expect((received[0] as { nodeId: string }).nodeId).toBe('n1');
  }, 10_000);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- events.test` (from `src/server/routers/`)
Expected: FAIL — no `subscribe` procedure exists yet, and the server doesn't accept WebSocket connections.

- [ ] **Step 4: Add the subscription procedure**

```ts
// src/server/routers/events.ts — extend the existing file (keep listForNode as-is)
import { observable } from '@trpc/server/observable';
import { subscribeAll, subscribeToNode, type BusEvent } from '../../events/bus.js';

export const eventsRouter = router({
  listForNode: publicProcedure
    .input(z.object({ nodeId: z.string() }))
    .query(({ input, ctx }) => listEventsForNode(ctx.db, input.nodeId)),

  subscribe: publicProcedure
    .input(z.object({ nodeId: z.string().optional() }))
    .subscription(({ input }) => {
      return observable<BusEvent>((emit) => {
        const handler = (event: BusEvent) => emit.next(event);
        const unsubscribe = input.nodeId ? subscribeToNode(input.nodeId, handler) : subscribeAll(handler);
        return unsubscribe;
      });
    }),
});
```

- [ ] **Step 5: Register WebSocket support in `app.ts`**

```ts
// src/server/app.ts
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { appRouter } from './root-router.js';
import { createDb } from '../db/client.js';
import { startNodeActor } from '../lifecycle/node-actor-manager.js';
import type { TrpcContext } from './trpc.js';

export function buildServer(dbPath: string, startNode: TrpcContext['startNode'] = startNodeActor) {
  const db = createDb(dbPath);
  const app = Fastify({ logger: false });

  app.register(fastifyWebsocket);
  app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    useWSS: true,
    trpcOptions: {
      router: appRouter,
      createContext: () => ({ db, startNode }),
    },
  });

  return app;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- events.test`
Expected: PASS. If it fails on the `useWSS` option or the WebSocket registration itself, this is the verify-at-implementation moment called out above — check `node_modules/@trpc/server/dist/adapters/fastify/*.d.ts` for the actual expected option name/shape and adjust; don't proceed past an unexplained failure.

- [ ] **Step 7: Run the full suite**

Run: `sg docker -c "npm test"`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/server
git commit -m "feat: add events.subscribe tRPC subscription over WebSocket"
```

---

### Task 7: WebSocket link in the daemon client

**Files:**
- Modify: `src/daemon/client.ts`

**Interfaces:**
- Produces: `createDaemonClient()` now routes subscription calls over WebSocket and everything else over the existing HTTP batch link — consumed by every TUI screen that needs live data (Tasks 12–13).

- [ ] **Step 1: Update `daemon/client.ts`**

```ts
// src/daemon/client.ts
import { createTRPCClient, httpBatchLink, splitLink, wsLink, createWSClient } from '@trpc/client';
import type { AppRouter } from '../server/root-router.js';

const DAEMON_PORT = Number(process.env.ORG_DAEMON_PORT ?? 4177);

export function createDaemonClient() {
  const wsClient = createWSClient({ url: `ws://127.0.0.1:${DAEMON_PORT}/trpc` });
  return createTRPCClient<AppRouter>({
    links: [
      splitLink({
        condition: (op) => op.type === 'subscription',
        true: wsLink({ client: wsClient }),
        false: httpBatchLink({ url: `http://127.0.0.1:${DAEMON_PORT}/trpc` }),
      }),
    ],
  });
}
```

- [ ] **Step 2: Manually verify against the real daemon**

```bash
sg docker -c "node dist/cli/index.js daemon start"
node -e "
import('./dist/daemon/client.js').then(({ createDaemonClient }) => {
  const client = createDaemonClient();
  return client.node.tree.query();
}).then((r) => { console.log('HTTP query OK:', r.length, 'nodes'); process.exit(0); });
"
```

(dynamic `import()` here, not `require()` — the package is ESM-only (`"type": "module"`), and `require()`-ing an ESM file from a `-e` script is unreliable across Node versions; dynamic `import()` always works.)

Expected: prints `HTTP query OK: N nodes` without hanging — confirms the `splitLink` correctly routes a plain query over HTTP and doesn't require a WebSocket handshake for non-subscription calls.

- [ ] **Step 3: Run the full suite**

Run: `sg docker -c "npm test"`
Expected: PASS — this file has no existing automated test (it's a thin client factory); the CLI end-to-end test (`test/cli-e2e.test.ts`) exercises it indirectly via every CLI command's `createDaemonClient()` call and must still pass.

- [ ] **Step 4: Commit**

```bash
git add src/daemon/client.ts
git commit -m "feat: route tRPC subscriptions over WebSocket, everything else stays on HTTP"
```

---

### Task 8: Shared new-run validation

**Files:**
- Create: `src/cli/validation.ts`
- Modify: `src/cli/commands/run.ts`
- Test: `src/cli/validation.test.ts`

**Interfaces:**
- Produces: `nonNegativeNumber(label: string): (raw: string) => number` — consumed by both the CLI's `--budget`/`--max-children` flags and the TUI's new-run form (Task 14), so the two can never validate differently.

- [ ] **Step 1: Write the failing test**

```ts
// src/cli/validation.test.ts
import { describe, it, expect } from 'vitest';
import { nonNegativeNumber } from './validation.js';

describe('nonNegativeNumber', () => {
  it('parses a valid non-negative number', () => {
    expect(nonNegativeNumber('budget')('5')).toBe(5);
    expect(nonNegativeNumber('budget')('0')).toBe(0);
  });

  it('rejects a negative number with a labeled message', () => {
    expect(() => nonNegativeNumber('budget')('-1')).toThrow(/budget must be a non-negative number/);
  });

  it('rejects a non-numeric string', () => {
    expect(() => nonNegativeNumber('budget')('abc')).toThrow(/budget must be a non-negative number/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- validation.test`
Expected: FAIL — `Cannot find module './validation'`.

- [ ] **Step 3: Write `cli/validation.ts` (moved verbatim from `run.ts`)**

```ts
// src/cli/validation.ts
export function nonNegativeNumber(label: string) {
  return (raw: string): number => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${label} must be a non-negative number, got "${raw}"`);
    }
    return value;
  };
}
```

```ts
// src/cli/commands/run.ts — remove the local nonNegativeNumber function, import the shared one instead
import { nonNegativeNumber } from '../validation.js';
```

- [ ] **Step 4: Run test to verify it passes, and confirm `run.ts`'s own behavior is unchanged**

Run: `npm test -- validation.test`
Expected: PASS.

Run: `npm run build && node dist/cli/index.js run --help`
Expected: identical `--budget`/`--max-children` help text as before this refactor.

- [ ] **Step 5: Commit**

```bash
git add src/cli/validation.ts src/cli/validation.test.ts src/cli/commands/run.ts
git commit -m "refactor: extract shared new-run validation for reuse by the TUI form"
```

---

### Task 9: The stream renderer

**Files:**
- Create: `src/tui/stream-renderer.ts`
- Test: `src/tui/stream-renderer.test.ts`

**Interfaces:**
- Produces: `interface RenderedLine`, `interface StreamRenderer`, `createStreamRenderer(): StreamRenderer` with `.feed(event): { action: 'append' | 'update' | 'skip'; line?: RenderedLine }` — consumed by Task 13 (node detail's live output section) and Task 15 (full output screen).

This is a stateful reducer (not a stateless pure function) because a tool call and its result arrive as two separate events that must be correlated by id and rendered as one evolving line — exactly what the approved mockup showed ("a spinner resolves in place").

- [ ] **Step 1: Write the failing test, using the real fixtures from this plan's opening section**

```ts
// src/tui/stream-renderer.test.ts
import { describe, it, expect } from 'vitest';
import { createStreamRenderer } from './stream-renderer.js';
import type { StructuredEvent } from '../adapters/adapter.js';

function wrap(raw: object): StructuredEvent {
  return { type: (raw as { type: string }).type, payload: raw };
}

describe('createStreamRenderer', () => {
  it('appends assistant text as a text line', () => {
    const renderer = createStreamRenderer();
    const result = renderer.feed(wrap({
      type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] },
    }));
    expect(result.action).toBe('append');
    expect(result.line?.kind).toBe('text');
    expect(result.line?.content).toBe('Done.');
  });

  it('skips an empty thinking block', () => {
    const renderer = createStreamRenderer();
    const result = renderer.feed(wrap({
      type: 'assistant', message: { content: [{ type: 'thinking', thinking: '', signature: 'x' }] },
    }));
    expect(result.action).toBe('skip');
  });

  it('renders non-empty thinking as a text line', () => {
    const renderer = createStreamRenderer();
    const result = renderer.feed(wrap({
      type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'considering the approach', signature: 'x' }] },
    }));
    expect(result.action).toBe('append');
    expect(result.line?.content).toBe('considering the approach');
  });

  it('appends a pending tool-use line, keyed by the tool_use id', () => {
    const renderer = createStreamRenderer();
    const result = renderer.feed(wrap({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/host/repo/file.txt' } }] },
    }));
    expect(result.action).toBe('append');
    expect(result.line?.key).toBe('toolu_1');
    expect(result.line?.kind).toBe('tool-pending');
    expect(result.line?.content).toBe('Read /host/repo/file.txt');
  });

  it('resolves a pending tool call into a diff when the matching tool_result carries a structuredPatch', () => {
    const renderer = createStreamRenderer();
    renderer.feed(wrap({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_2', name: 'Edit', input: { file_path: '/host/repo/file.txt' } }] },
    }));

    const result = renderer.feed(wrap({
      type: 'user',
      message: { content: [{ tool_use_id: 'toolu_2', type: 'tool_result', content: 'updated' }] },
      tool_use_result: { structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' hello', '+world'] }] },
    }));

    expect(result.action).toBe('update');
    expect(result.line?.key).toBe('toolu_2');
    expect(result.line?.kind).toBe('diff');
    expect(result.line?.diffLines).toEqual([' hello', '+world']);
  });

  it('resolves a pending tool call into tool-done when there is no structuredPatch (e.g. a Read)', () => {
    const renderer = createStreamRenderer();
    renderer.feed(wrap({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_3', name: 'Read', input: { file_path: '/x' } }] },
    }));
    const result = renderer.feed(wrap({
      type: 'user',
      message: { content: [{ tool_use_id: 'toolu_3', type: 'tool_result', content: '1\thello\n' }] },
    }));
    expect(result.action).toBe('update');
    expect(result.line?.kind).toBe('tool-done');
  });

  it('skips a tool_result with no matching pending call', () => {
    const renderer = createStreamRenderer();
    const result = renderer.feed(wrap({
      type: 'user',
      message: { content: [{ tool_use_id: 'unknown', type: 'tool_result', content: 'x' }] },
    }));
    expect(result.action).toBe('skip');
  });

  it('renders a result event as a cost summary line', () => {
    const renderer = createStreamRenderer();
    const result = renderer.feed(wrap({ type: 'result', total_cost_usd: 0.0354 }));
    expect(result.action).toBe('append');
    expect(result.line?.kind).toBe('summary');
    expect(result.line?.content).toContain('0.0354');
  });

  it('skips system and rate_limit_event noise', () => {
    const renderer = createStreamRenderer();
    expect(renderer.feed(wrap({ type: 'system', subtype: 'hook_started' })).action).toBe('skip');
    expect(renderer.feed(wrap({ type: 'rate_limit_event' })).action).toBe('skip');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- stream-renderer.test`
Expected: FAIL — `Cannot find module './stream-renderer'`.

- [ ] **Step 3: Write `tui/stream-renderer.ts`**

```ts
// src/tui/stream-renderer.ts
import type { StructuredEvent } from '../adapters/adapter.js';

export interface RenderedLine {
  key: string;
  kind: 'text' | 'tool-pending' | 'tool-done' | 'diff' | 'summary';
  content: string;
  diffLines?: string[];
}

export interface FeedResult {
  action: 'append' | 'update' | 'skip';
  line?: RenderedLine;
}

export interface StreamRenderer {
  feed(event: StructuredEvent): FeedResult;
}

interface AssistantContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface ToolResultBlock {
  type: string;
  tool_use_id?: string;
}

function summarizeToolInput(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  if (name === 'Read' || name === 'Edit' || name === 'Write') return String(input.file_path ?? '');
  if (name === 'Bash') return String(input.command ?? '');
  return JSON.stringify(input);
}

export function createStreamRenderer(): StreamRenderer {
  const pending = new Map<string, RenderedLine>();
  let seq = 0;
  const nextKey = () => `line-${seq++}`;

  return {
    feed(event: StructuredEvent): FeedResult {
      const payload = event.payload as Record<string, unknown>;

      if (event.type === 'assistant') {
        const blocks = ((payload.message as { content?: AssistantContentBlock[] })?.content) ?? [];
        for (const block of blocks) {
          if (block.type === 'text' && block.text) {
            return { action: 'append', line: { key: nextKey(), kind: 'text', content: block.text } };
          }
          if (block.type === 'thinking' && block.thinking) {
            return { action: 'append', line: { key: nextKey(), kind: 'text', content: block.thinking } };
          }
          if (block.type === 'tool_use' && block.id && block.name) {
            const line: RenderedLine = {
              key: block.id, kind: 'tool-pending',
              content: `${block.name} ${summarizeToolInput(block.name, block.input)}`.trim(),
            };
            pending.set(block.id, line);
            return { action: 'append', line };
          }
        }
        return { action: 'skip' };
      }

      if (event.type === 'user') {
        const blocks = ((payload.message as { content?: ToolResultBlock[] })?.content) ?? [];
        for (const block of blocks) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            const existing = pending.get(block.tool_use_id);
            if (!existing) return { action: 'skip' };
            pending.delete(block.tool_use_id);
            const structuredPatch = (payload.tool_use_result as { structuredPatch?: { lines: string[] }[] } | undefined)?.structuredPatch;
            const updated: RenderedLine = structuredPatch
              ? { ...existing, kind: 'diff', diffLines: structuredPatch.flatMap((hunk) => hunk.lines) }
              : { ...existing, kind: 'tool-done' };
            return { action: 'update', line: updated };
          }
        }
        return { action: 'skip' };
      }

      if (event.type === 'result') {
        const cost = Number(payload.total_cost_usd ?? 0);
        return { action: 'append', line: { key: nextKey(), kind: 'summary', content: `session cost: $${cost.toFixed(4)}` } };
      }

      // system, rate_limit_event, and anything unrecognized — deliberate noise
      // suppression, matching the design's "hide hook chatter" decision.
      return { action: 'skip' };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- stream-renderer.test`
Expected: PASS — 10 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/tui/stream-renderer.ts src/tui/stream-renderer.test.ts
git commit -m "feat: add stateful stream renderer for Claude-Code-style live output"
```

---

### Task 10: TUI shell — navigation, breadcrumb, global keys

**Files:**
- Create: `src/tui/app.tsx`, `src/tui/navigation.ts`
- Modify: `src/cli/commands/watch.tsx`, `src/cli/index.ts`

**Interfaces:**
- Produces: `type Screen = { name: 'home' } | { name: 'tree' } | { name: 'node'; nodeId: string } | { name: 'decision-log'; nodeId: string } | { name: 'output'; nodeId: string } | { name: 'new-run' }`, `useNavigation()` (a small hook managing a screen stack with `push`/`pop`), the `<App>` component rendering the current top-of-stack screen with a breadcrumb header and a context-sensitive footer. No automated test — Ink application wiring is manually verified, per this project's established precedent (`org doctor`/the original `org watch` have none either); the navigation stack's pure push/pop logic is the one piece extracted and tested.

- [ ] **Step 1: Write the failing test for the pure navigation-stack logic**

```ts
// src/tui/navigation.test.ts
import { describe, it, expect } from 'vitest';
import { pushScreen, popScreen, type Screen } from './navigation.js';

describe('navigation stack', () => {
  it('pushes a new screen onto the stack', () => {
    const stack: Screen[] = [{ name: 'home' }];
    expect(pushScreen(stack, { name: 'tree' })).toEqual([{ name: 'home' }, { name: 'tree' }]);
  });

  it('pops back to the previous screen', () => {
    const stack: Screen[] = [{ name: 'home' }, { name: 'tree' }, { name: 'node', nodeId: 'n1' }];
    expect(popScreen(stack)).toEqual([{ name: 'home' }, { name: 'tree' }]);
  });

  it('never pops the last remaining screen (Home is the floor)', () => {
    const stack: Screen[] = [{ name: 'home' }];
    expect(popScreen(stack)).toEqual([{ name: 'home' }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- navigation.test`
Expected: FAIL — `Cannot find module './navigation'`.

- [ ] **Step 3: Write `tui/navigation.ts`**

```ts
// src/tui/navigation.ts
export type Screen =
  | { name: 'home' }
  | { name: 'tree' }
  | { name: 'node'; nodeId: string }
  | { name: 'decision-log'; nodeId: string }
  | { name: 'output'; nodeId: string }
  | { name: 'new-run' };

export function pushScreen(stack: Screen[], screen: Screen): Screen[] {
  return [...stack, screen];
}

export function popScreen(stack: Screen[]): Screen[] {
  return stack.length <= 1 ? stack : stack.slice(0, -1);
}

export function breadcrumb(stack: Screen[]): string {
  return stack.map((s) => {
    if (s.name === 'node') return `node:${s.nodeId.slice(0, 8)}`;
    if (s.name === 'decision-log' || s.name === 'output') return `${s.name}:${s.nodeId.slice(0, 8)}`;
    return s.name;
  }).join(' › ');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- navigation.test`
Expected: PASS — 3 tests passed.

- [ ] **Step 5: Write `tui/app.tsx`**

```tsx
// src/tui/app.tsx
import React, { useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { pushScreen, popScreen, breadcrumb, type Screen } from './navigation.js';
import { HomeScreen } from './screens/home.js';
import { TreeScreen } from './screens/tree.js';
import { NodeDetailScreen } from './screens/node-detail.js';
import { DecisionLogScreen } from './screens/decision-log.js';
import { OutputScreen } from './screens/output.js';
import { NewRunScreen } from './screens/new-run.js';

export function App() {
  const { exit } = useApp();
  const [stack, setStack] = useState<Screen[]>([{ name: 'home' }]);
  const current = stack[stack.length - 1];

  const push = (screen: Screen) => setStack((s) => pushScreen(s, screen));
  const pop = () => setStack((s) => popScreen(s));

  useInput((input, key) => {
    if (input === 'q') { exit(); return; }
    if (key.escape || key.backspace) { pop(); return; }
  });

  return (
    <Box flexDirection="column">
      <Text dimColor>org › {breadcrumb(stack)}</Text>
      {current.name === 'home' && <HomeScreen onOpenTree={() => push({ name: 'tree' })} onNewRun={() => push({ name: 'new-run' })} />}
      {current.name === 'tree' && <TreeScreen onOpenNode={(nodeId) => push({ name: 'node', nodeId })} onNewRun={() => push({ name: 'new-run' })} />}
      {current.name === 'node' && (
        <NodeDetailScreen
          nodeId={current.nodeId}
          onOpenDecisionLog={() => push({ name: 'decision-log', nodeId: current.nodeId })}
          onOpenOutput={() => push({ name: 'output', nodeId: current.nodeId })}
        />
      )}
      {current.name === 'decision-log' && <DecisionLogScreen nodeId={current.nodeId} />}
      {current.name === 'output' && <OutputScreen nodeId={current.nodeId} />}
      {current.name === 'new-run' && <NewRunScreen onCreated={() => push({ name: 'tree' })} />}
    </Box>
  );
}
```

- [ ] **Step 6: Wire `org` (no subcommand) and `org watch` to launch it**

```ts
// src/cli/index.ts — add a default action when no subcommand is given, alongside registering `watch` as an explicit alias
import React from 'react';
import { render } from 'ink';
import { App } from '../tui/app.js';

// ... after all registerXCommand(program) calls:
program
  .command('watch', { isDefault: true })
  .description('Open the interactive dashboard (also the default when no command is given)')
  .action(() => {
    render(React.createElement(App));
  });
```

Remove the old `registerWatchCommand`/`watch.tsx` registration — this new default `watch` command replaces it. Delete `src/cli/commands/watch.tsx` (superseded) but keep `src/cli/commands/watch-format.ts`'s `formatNodeLine` only if the Tree screen (Task 12) still finds it useful for the flat text fallback; otherwise remove it too once Task 12 confirms it isn't needed.

- [ ] **Step 7: Rebuild and manually verify the shell renders and quits cleanly**

Run: `npm run build && node dist/cli/index.js` (no arguments)
Expected: opens the dashboard at Home (screens 11–16 aren't built yet, so expect placeholder/import errors until those tasks land — for this task, verify only that the breadcrumb renders, `q` exits cleanly, and `Esc` doesn't crash when already at Home).

- [ ] **Step 8: Commit**

```bash
git add src/tui/app.tsx src/tui/navigation.ts src/tui/navigation.test.ts src/cli/index.ts
git commit -m "feat: add TUI shell with drill-down navigation, breadcrumb, and global keybindings"
```

---

### Task 11: Home screen

**Files:**
- Create: `src/tui/screens/home.tsx`, `src/db/queries/stats.ts`
- Modify: `src/server/routers/daemon.ts`
- Test: `src/db/queries/stats.test.ts`

**Interfaces:**
- Produces: `getOrgStats(db): { active: number; complete: number; failed: number; totalCostUsd: number }`, `daemon.stats` tRPC query — consumed by the Home screen.

- [ ] **Step 1: Write the failing query test**

```ts
// src/db/queries/stats.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../client.js';
import { insertNode } from './nodes.js';
import { appendEvent } from './events.js';
import { getOrgStats } from './stats.js';

const TEST_DB = './test-stats.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

const CONTRACT = { goal: 'x', definition_of_done: ['x'], authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 0 }, constraints: [] };

describe('getOrgStats', () => {
  it('counts nodes by state and sums real cost from result events', () => {
    const db = createDb(TEST_DB);
    insertNode(db, { id: 'n1', parentId: null, goal: 'x', contract: CONTRACT, state: 'COMPLETE', repoPath: null, createdAt: 't0', updatedAt: 't0' });
    insertNode(db, { id: 'n2', parentId: null, goal: 'x', contract: CONTRACT, state: 'FAILED', repoPath: null, createdAt: 't0', updatedAt: 't0' });
    insertNode(db, { id: 'n3', parentId: null, goal: 'x', contract: CONTRACT, state: 'EXECUTION_DECISION', repoPath: null, createdAt: 't0', updatedAt: 't0' });
    appendEvent(db, { nodeId: 'n1', type: 'exec.result', payload: { type: 'result', total_cost_usd: 0.05 }, createdAt: 't0' });
    appendEvent(db, { nodeId: 'n2', type: 'exec.result', payload: { type: 'result', total_cost_usd: 0.02 }, createdAt: 't0' });

    const stats = getOrgStats(db);
    expect(stats.complete).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.active).toBe(1);
    expect(stats.totalCostUsd).toBeCloseTo(0.07, 5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- stats.test`
Expected: FAIL — `Cannot find module './stats'`.

- [ ] **Step 3: Write `db/queries/stats.ts`**

```ts
// src/db/queries/stats.ts
import { sql } from 'drizzle-orm';
import type { Db } from '../client.js';
import { nodes, events } from '../schema.js';

export interface OrgStats {
  active: number;
  complete: number;
  failed: number;
  totalCostUsd: number;
}

export function getOrgStats(db: Db): OrgStats {
  const allNodes = db.select().from(nodes).all();
  const complete = allNodes.filter((n) => n.state === 'COMPLETE').length;
  const failed = allNodes.filter((n) => n.state === 'FAILED').length;
  const active = allNodes.length - complete - failed;

  const resultEvents = db.select().from(events).where(sql`${events.type} = 'exec.result'`).all();
  const totalCostUsd = resultEvents.reduce((sum, e) => {
    const payload = e.payload as { total_cost_usd?: number };
    return sum + (payload.total_cost_usd ?? 0);
  }, 0);

  return { active, complete, failed, totalCostUsd };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- stats.test`
Expected: PASS.

- [ ] **Step 5: Add the `daemon.stats` procedure**

```ts
// src/server/routers/daemon.ts — extend the existing file
import { getOrgStats } from '../../db/queries/stats.js';

export const daemonRouter = router({
  ping: publicProcedure.query(() => ({ ok: true as const, pid: process.pid })),
  stats: publicProcedure.query(({ ctx }) => getOrgStats(ctx.db)),
});
```

- [ ] **Step 6: Write the Home screen**

```tsx
// src/tui/screens/home.tsx
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Badge } from '@inkjs/ui';
import { createDaemonClient } from '../../daemon/client.js';

interface Stats { active: number; complete: number; failed: number; totalCostUsd: number }

export function HomeScreen({ onOpenTree, onNewRun }: { onOpenTree: () => void; onNewRun: () => void }) {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    const client = createDaemonClient();
    let alive = true;
    const poll = async () => {
      const s = await client.daemon.stats.query().catch(() => null);
      if (alive && s) setStats(s);
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => { alive = false; clearInterval(interval); };
  }, []);

  useInput((input) => {
    if (input === 't' || input === '\r') onOpenTree();
    if (input === 'n') onNewRun();
  });

  return (
    <Box flexDirection="column">
      <Text bold>Accountable Agent Organization Runtime</Text>
      {stats ? (
        <Box flexDirection="row" gap={2}>
          <Badge color="green">{stats.complete} complete</Badge>
          <Badge color="yellow">{stats.active} active</Badge>
          <Badge color="red">{stats.failed} failed</Badge>
          <Text dimColor>${stats.totalCostUsd.toFixed(4)} spent</Text>
        </Box>
      ) : <Text dimColor>Loading...</Text>}
      <Box marginTop={1}><Text dimColor>[t] / [enter] open tree   [n] new run   [q] quit</Text></Box>
    </Box>
  );
}
```

- [ ] **Step 7: Rebuild and verify manually**

Run: `npm run build && node dist/cli/index.js`
Expected: Home renders with live stats (0/0/0/$0 on a fresh daemon), updating every 3s; `t`/`Enter` attempts to open Tree (not built until Task 12 — expect an error there, not here).

- [ ] **Step 8: Commit**

```bash
git add src/db/queries/stats.ts src/db/queries/stats.test.ts src/server/routers/daemon.ts src/tui/screens/home.tsx
git commit -m "feat: add Home screen with org-wide stats"
```

---

### Task 12: Tree screen

**Files:**
- Create: `src/tui/screens/tree.tsx`

**Interfaces:**
- Consumes: `node.tree` query, `events.subscribe` (no `nodeId` — global) for live in-place state updates.
- Produces: interactive, live-updating tree navigation — consumed by `app.tsx` (already wired in Task 10).

- [ ] **Step 1: Write the screen**

No automated test (Ink interactivity, per this project's established pattern) — manually verified in Step 2.

```tsx
// src/tui/screens/tree.tsx
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { createDaemonClient } from '../../daemon/client.js';

interface NodeRow { id: string; state: string; goal: string; parentId: string | null }

function badge(state: string): string {
  if (state === 'COMPLETE') return '✓';
  if (state === 'FAILED') return '✗';
  return '●';
}

export function TreeScreen({ onOpenNode, onNewRun }: { onOpenNode: (nodeId: string) => void; onNewRun: () => void }) {
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [selected, setSelected] = useState(0);
  const [filter, setFilter] = useState('');
  const [filtering, setFiltering] = useState(false);

  useEffect(() => {
    const client = createDaemonClient();
    let alive = true;
    client.node.tree.query().then((rows) => { if (alive) setNodes(rows); });

    const subscription = client.events.subscribe.subscribe(
      {},
      {
        onData: (event: { nodeId: string; type: string; payload: unknown }) => {
          if (event.type !== 'state.transition') return;
          setNodes((prev) => prev.map((n) => (
            n.id === event.nodeId ? { ...n, state: (event.payload as { state: string }).state } : n
          )));
        },
      },
    );
    return () => { alive = false; subscription.unsubscribe(); };
  }, []);

  const visible = nodes.filter((n) => !filter || n.goal.toLowerCase().includes(filter.toLowerCase()) || n.state.toLowerCase().includes(filter.toLowerCase()));

  useInput((input, key) => {
    if (filtering) {
      if (key.return) setFiltering(false);
      else if (key.backspace || key.delete) setFilter((f) => f.slice(0, -1));
      else if (input) setFilter((f) => f + input);
      return;
    }
    if (input === '/') { setFiltering(true); return; }
    if (input === 'n') { onNewRun(); return; }
    if (key.upArrow || input === 'k') setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow || input === 'j') setSelected((s) => Math.min(visible.length - 1, s + 1));
    if (key.return && visible[selected]) onOpenNode(visible[selected].id);
  });

  return (
    <Box flexDirection="column">
      {filtering && <Text>filter: {filter}▌</Text>}
      {visible.length === 0 && <Text dimColor>No nodes yet. Press [n] to start one.</Text>}
      {visible.map((node, i) => (
        <Text key={node.id} inverse={i === selected}>
          {badge(node.state)} {node.id.slice(0, 8)}  {node.state.padEnd(20)} {node.goal}
        </Text>
      ))}
      <Box marginTop={1}><Text dimColor>[↑↓/jk] move  [enter] open  [/] filter  [n] new run  [esc] back</Text></Box>
    </Box>
  );
}
```

- [ ] **Step 2: Rebuild and verify manually**

Run: `npm run build && node dist/cli/index.js`, press `t` from Home
Expected: Tree renders (empty state if no nodes exist yet); start a real `org run` in another terminal and confirm the new node appears and its state updates live without restarting the TUI.

- [ ] **Step 3: Delete the now-superseded flat `org watch` files if not already removed in Task 10**

```bash
git rm -f src/cli/commands/watch.tsx src/cli/commands/watch-format.ts src/cli/commands/watch-format.test.ts 2>/dev/null || true
```

- [ ] **Step 4: Run the full suite**

Run: `sg docker -c "npm test"`
Expected: PASS — removing `watch-format.test.ts` removes its 3 tests from the count; nothing else references the deleted files (confirm with `grep -rn "watch-format\|commands/watch'" src` before deleting, per the same caution used whenever this project has removed a file).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add interactive Tree screen with live state updates and filtering"
```

---

### Task 13: Node detail screen

**Files:**
- Create: `src/tui/screens/node-detail.tsx`

**Interfaces:**
- Consumes: `node.get`, `decision.listForNode`, `commitment.listForNode`, `events.subscribe({ nodeId })`, `createStreamRenderer` (Task 9), `node.resolveApproval`.
- Produces: the richest screen in the spec — lifecycle, decision breakdown, live output, inline approval.

- [ ] **Step 1: Write the screen**

```tsx
// src/tui/screens/node-detail.tsx
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { createDaemonClient } from '../../daemon/client.js';
import { createStreamRenderer, type RenderedLine } from '../stream-renderer.js';

const LIFECYCLE_ORDER = [
  'CREATED', 'ORIENT', 'PLAN', 'INTELLIGENCE_GATE', 'EXECUTION_DECISION',
  'SELF_EXECUTE', 'DELEGATE', 'VERIFY', 'COMPLETE',
];

interface NodeInfo { id: string; state: string; goal: string; contract: { authority: { budget_usd: number } } }
interface Decision { id: string; outcome: string; breakdown: Record<string, number> }

export function NodeDetailScreen({
  nodeId, onOpenDecisionLog, onOpenOutput,
}: { nodeId: string; onOpenDecisionLog: () => void; onOpenOutput: () => void }) {
  const [node, setNode] = useState<NodeInfo | null>(null);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [pendingApprovalId, setPendingApprovalId] = useState<string | null>(null);
  const [lines, setLines] = useState<RenderedLine[]>([]);

  useEffect(() => {
    const client = createDaemonClient();
    let alive = true;
    const refresh = async () => {
      const [n, d] = await Promise.all([
        client.node.get.query({ id: nodeId }),
        client.decision.listForNode.query({ nodeId }),
      ]);
      if (!alive) return;
      setNode(n as NodeInfo);
      setDecisions(d as Decision[]);
      if (n.state === 'WAIT_APPROVAL') {
        const pending = await client.node.listPendingApprovals.query();
        const mine = pending.find((a) => a.nodeId === nodeId);
        setPendingApprovalId(mine?.id ?? null);
      } else {
        setPendingApprovalId(null);
      }
    };
    refresh();

    const renderer = createStreamRenderer();
    const subscription = client.events.subscribe.subscribe(
      { nodeId },
      {
        onData: (event: { type: string; payload: unknown; nodeId: string }) => {
          if (event.type === 'state.transition') { refresh(); return; }
          if (!event.type.startsWith('exec.')) return;
          const structuredEvent = { type: event.type.slice('exec.'.length), payload: event.payload };
          const result = renderer.feed(structuredEvent);
          if (result.action === 'append' && result.line) {
            setLines((prev) => [...prev, result.line!]);
          } else if (result.action === 'update' && result.line) {
            setLines((prev) => prev.map((l) => (l.key === result.line!.key ? result.line! : l)));
          }
        },
      },
    );
    return () => { alive = false; subscription.unsubscribe(); };
  }, [nodeId]);

  useInput((input) => {
    if (input === 'd') onOpenDecisionLog();
    if (input === 'l') onOpenOutput();
    if (input === 'y' && pendingApprovalId) {
      createDaemonClient().node.resolveApproval.mutate({ approvalId: pendingApprovalId, decision: 'approved' });
    }
    if (input === 'r' && pendingApprovalId) {
      createDaemonClient().node.resolveApproval.mutate({ approvalId: pendingApprovalId, decision: 'rejected' });
    }
  });

  if (!node) return <Text dimColor>Loading...</Text>;

  const latestDecision = decisions[decisions.length - 1];
  const isRunning = !['COMPLETE', 'FAILED'].includes(node.state);

  return (
    <Box flexDirection="column">
      <Text bold>{node.goal}</Text>
      <Text dimColor>budget ${node.contract.authority.budget_usd.toFixed(2)}</Text>

      <Box marginTop={1}><Text>
        {LIFECYCLE_ORDER.map((s) => (s === node.state ? `[${s}]` : s)).join(' → ')}
      </Text></Box>

      {latestDecision && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Decision: {latestDecision.outcome}</Text>
          {Object.entries(latestDecision.breakdown).map(([k, v]) => (
            <Text key={k} dimColor>  {k}: {v}</Text>
          ))}
        </Box>
      )}

      {isRunning && lines.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Live output</Text>
          {lines.slice(-8).map((line) => (
            <Text key={line.key} dimColor={line.kind === 'tool-pending'}>
              {line.kind === 'diff' ? line.diffLines?.join('\n') : line.content}
            </Text>
          ))}
        </Box>
      )}

      {pendingApprovalId && (
        <Box marginTop={1}><Text color="yellow">Awaiting approval — [y] approve  [r] reject</Text></Box>
      )}

      <Box marginTop={1}><Text dimColor>[d] full decision log  [l] full output  [esc] back</Text></Box>
    </Box>
  );
}
```

- [ ] **Step 2: Rebuild and verify manually against a real run**

Run: `npm run build`, start a real `org run "<goal>"` against a throwaway repo, open the TUI, drill into that node.
Expected: lifecycle line highlights the current state as it changes; once execution starts, live output lines appear progressively (not all at once) matching the approved mockup's shape (text, pending tool calls, resolved diffs); once a decision exists, its breakdown prints.

- [ ] **Step 3: Commit**

```bash
git add src/tui/screens/node-detail.tsx
git commit -m "feat: add Node detail screen with live lifecycle, decisions, and streamed output"
```

---

### Task 14: New-run form screen

**Files:**
- Create: `src/tui/screens/new-run.tsx`

**Interfaces:**
- Consumes: `nonNegativeNumber` (Task 8), `node.create` mutation, `TextInput`/`ConfirmInput` from `@inkjs/ui`.

- [ ] **Step 1: Write the screen**

```tsx
// src/tui/screens/new-run.tsx
import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { TextInput, ConfirmInput } from '@inkjs/ui';
import { createDaemonClient } from '../../daemon/client.js';
import { nonNegativeNumber } from '../../cli/validation.js';
import { toContainerPath } from '../../k8s/kind.js';

type Field = 'goal' | 'spawn' | 'budget' | 'maxChildren' | 'submitting' | 'error';

export function NewRunScreen({ onCreated }: { onCreated: () => void }) {
  const [field, setField] = useState<Field>('goal');
  const [goal, setGoal] = useState('');
  const [spawn, setSpawn] = useState(false);
  const [budget, setBudget] = useState('0');
  const [maxChildren, setMaxChildren] = useState('0');
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setField('submitting');
    try {
      const repoPath = toContainerPath(process.cwd());
      const client = createDaemonClient();
      await client.node.create.mutate({
        goal,
        definition_of_done: [goal],
        authority: {
          tools: [], spawn_children: spawn,
          max_child_count: nonNegativeNumber('max-children')(maxChildren),
          budget_usd: nonNegativeNumber('budget')(budget),
        },
        constraints: [],
        repoPath,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setField('error');
    }
  }

  return (
    <Box flexDirection="column">
      <Text bold>New run</Text>
      {field === 'goal' && (
        <Box><Text>Goal: </Text><TextInput onSubmit={(v) => { setGoal(v); setField('spawn'); }} /></Box>
      )}
      {field === 'spawn' && (
        <Box><Text>Allow delegation? </Text><ConfirmInput onConfirm={() => { setSpawn(true); setField('budget'); }} onCancel={() => { setSpawn(false); setField('budget'); }} /></Box>
      )}
      {field === 'budget' && (
        <Box><Text>Budget (USD): </Text><TextInput defaultValue="0" onSubmit={(v) => { setBudget(v); setField('maxChildren'); }} /></Box>
      )}
      {field === 'maxChildren' && (
        <Box><Text>Max children: </Text><TextInput defaultValue="0" onSubmit={(v) => { setMaxChildren(v); submit(); }} /></Box>
      )}
      {field === 'submitting' && <Text dimColor>Creating...</Text>}
      {field === 'error' && <Text color="red">Error: {error} — [esc] back</Text>}
    </Box>
  );
}
```

- [ ] **Step 2: Rebuild and verify manually**

Run: `npm run build && node dist/cli/index.js`, press `n` from Home or Tree
Expected: fields prompt in order, a submitted goal creates a real node (verify via `org tree` in another terminal), an invalid budget (e.g. `-1`) shows the same validation error message the CLI's `--budget` flag would.

- [ ] **Step 3: Commit**

```bash
git add src/tui/screens/new-run.tsx
git commit -m "feat: add new-run form screen, reusing the shared CLI validation"
```

---

### Task 15: Full decision log and full output screens

**Files:**
- Create: `src/tui/screens/decision-log.tsx`, `src/tui/screens/output.tsx`

**Interfaces:**
- Consumes: `decision.listForNode`, `events.listForNode` (historical, already-persisted events — for output already captured before this screen was opened) plus `events.subscribe({ nodeId })` (for anything still arriving live), `createStreamRenderer`.

- [ ] **Step 1: Write the decision log screen**

```tsx
// src/tui/screens/decision-log.tsx
import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { createDaemonClient } from '../../daemon/client.js';

interface Decision { id: string; outcome: string; breakdown: Record<string, number> }

export function DecisionLogScreen({ nodeId }: { nodeId: string }) {
  const [decisions, setDecisions] = useState<Decision[]>([]);

  useEffect(() => {
    createDaemonClient().decision.listForNode.query({ nodeId }).then((d) => setDecisions(d as Decision[]));
  }, [nodeId]);

  return (
    <Box flexDirection="column">
      <Text bold>Full decision log</Text>
      {decisions.length === 0 && <Text dimColor>No decisions yet.</Text>}
      {decisions.map((d) => (
        <Box key={d.id} flexDirection="column" marginTop={1}>
          <Text bold>{d.outcome}</Text>
          {Object.entries(d.breakdown).map(([k, v]) => <Text key={k} dimColor>  {k}: {v}</Text>)}
        </Box>
      ))}
      <Box marginTop={1}><Text dimColor>[esc] back</Text></Box>
    </Box>
  );
}
```

- [ ] **Step 2: Write the full output screen — replays historical events, then continues live**

```tsx
// src/tui/screens/output.tsx
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { createDaemonClient } from '../../daemon/client.js';
import { createStreamRenderer, type RenderedLine } from '../stream-renderer.js';

export function OutputScreen({ nodeId }: { nodeId: string }) {
  const [lines, setLines] = useState<RenderedLine[]>([]);
  const [following, setFollowing] = useState(true);

  useEffect(() => {
    const client = createDaemonClient();
    const renderer = createStreamRenderer();
    let alive = true;

    const feedInto = (rawType: string, payload: unknown) => {
      if (!rawType.startsWith('exec.')) return;
      const result = renderer.feed({ type: rawType.slice('exec.'.length), payload });
      if (result.action === 'append' && result.line) setLines((prev) => [...prev, result.line!]);
      if (result.action === 'update' && result.line) {
        setLines((prev) => prev.map((l) => (l.key === result.line!.key ? result.line! : l)));
      }
    };

    client.events.listForNode.query({ nodeId }).then((historical) => {
      if (!alive) return;
      for (const e of historical) feedInto(e.type, e.payload);
    });

    const subscription = client.events.subscribe.subscribe(
      { nodeId },
      { onData: (event: { type: string; payload: unknown }) => feedInto(event.type, event.payload) },
    );
    return () => { alive = false; subscription.unsubscribe(); };
  }, [nodeId]);

  useInput((input) => {
    if (input === 'f') setFollowing((f) => !f);
  });

  return (
    <Box flexDirection="column">
      <Text bold>Full output {following ? '● following' : '(paused)'}</Text>
      {lines.map((line) => (
        <Text key={line.key} dimColor={line.kind === 'tool-pending'}>
          {line.kind === 'diff' ? line.diffLines?.join('\n') : line.content}
        </Text>
      ))}
      <Box marginTop={1}><Text dimColor>[f] follow/pause  [esc] back</Text></Box>
    </Box>
  );
}
```

Note: this task's minimal cut does not implement actual scroll-pausing behavior behind `following` (the state exists and toggles, but new lines still append regardless) — full scroll-position management is real, separate scope (a scrollable-viewport component) not central to this plan's goal of proving live rendering works; wire it in as a fast-follow once the core screens are in daily use, if the always-appending behavior proves annoying in practice.

- [ ] **Step 3: Rebuild and verify manually**

Run: `npm run build`, open a node's full output mid-execution and after completion.
Expected: mid-execution shows the same live lines as the node-detail summary, unabridged; after completion, opening it fresh replays the full historical event log from `events.listForNode` correctly (including diffs, since `structuredPatch` was persisted in the payload).

- [ ] **Step 4: Commit**

```bash
git add src/tui/screens/decision-log.tsx src/tui/screens/output.tsx
git commit -m "feat: add full decision-log and full-output drill-in screens"
```

---

### Task 16: Approval jump

**Files:**
- Modify: `src/tui/app.tsx`

**Interfaces:**
- Produces: pressing `a` from anywhere jumps the navigation stack directly to the next node awaiting approval.

- [ ] **Step 1: Add the jump to `app.tsx`**

```tsx
// src/tui/app.tsx — add inside the useInput handler, and add the import
import { createDaemonClient } from '../daemon/client.js';

// ... inside useInput:
useInput((input, key) => {
  if (input === 'q') { exit(); return; }
  if (key.escape || key.backspace) { pop(); return; }
  if (input === 'a') {
    createDaemonClient().node.listPendingApprovals.query().then((pending) => {
      if (pending[0]) push({ name: 'node', nodeId: pending[0].nodeId });
    });
    return;
  }
});
```

- [ ] **Step 2: Rebuild and verify manually**

Set up a real escalation (a `--spawn --budget 0.1` run against a long/complex goal, as established in Phase 5's own manual verification), then from Home or Tree press `a`.
Expected: jumps straight to that node's detail screen, showing the `y`/`r` approval prompt.

- [ ] **Step 3: Commit**

```bash
git add src/tui/app.tsx
git commit -m "feat: add 'a' keybinding to jump directly to the next pending approval"
```

---

### Task 17: Full manual end-to-end verification

**Files:** none — verification only, the acceptance test for this entire plan.

- [ ] **Step 1: Confirm the automated suite is fully green, including everything this plan touched**

Run: `npm run typecheck && sg docker -c "npm test"`
Expected: PASS, zero skips.

- [ ] **Step 2: Real self-execute run, watched live**

In one terminal: `node dist/cli/index.js` (Home) → `n` → fill in a real goal against a real throwaway repo, `spawn: false`. In another: watch the same node via the Tree/Node-detail screens.
Expected: state progresses live without any manual refresh; once `SELF_EXECUTE` begins, real Claude Code reasoning text, tool calls, and at least one real diff appear progressively in the live output section — not all at once at the end. This is the moment that proves gap G8's fix and the whole follow-mode architecture actually deliver what was asked for.

- [ ] **Step 3: Real delegate run, watched live**

Start a `--spawn --budget 5 --max-children 2` run with a long/complex goal from the TUI's new-run form. Confirm the Tree screen shows the child (and possibly grandchild) node appear live as delegation happens, and each one's detail screen shows its own independent live output.

- [ ] **Step 4: Real escalate → approve, resolved from the TUI**

Start a `--spawn --budget 0.1` run. Confirm it reaches `WAIT_APPROVAL`, press `a` to jump to it, press `y` to approve, and confirm it proceeds to `DELEGATE` then `COMPLETE` — all without leaving the TUI or touching the plain CLI.

- [ ] **Step 5: Confirm cluster cleanliness after all of the above**

Run: `sg docker -c "kubectl get jobs,secrets,networkpolicy -n org-exec"`
Expected: only `default-deny-all` remains.

- [ ] **Step 6: Confirm the plain CLI commands still work standalone, untouched by any of this**

Run: `org tree`, `org decision <id>`, `org commitment <id>`, `org approve <id>` (on a fresh escalation) from a normal shell, no TUI involved.
Expected: identical behavior to before this plan — the TUI is additive.

If anything in Steps 2–4 fails, invoke superpowers:systematic-debugging before patching — the most likely failure points, in rough order, are: the WebSocket subscription's `useWSS` option name (Task 6's verify-at-implementation note), `@kubernetes/client-node`'s `Log` class signature (Task 3's), or a stale daemon still running the pre-Task-1 adapter code (restart it after building).

---

## Explicitly deferred (tracked, not forgotten)

- **True token-by-token typing** via `--include-partial-messages` — real and confirmed available (captured and inspected during this plan's research), but correctly parsing Anthropic's `content_block_delta` accumulation (by block index, across `thinking_delta`/`text_delta`/`input_json_delta` variants) is a meaningfully larger, separable parsing task than the plain-message stream this plan ships. The plain stream already delivers genuinely live, progressive rendering — this would only make text *within* one block feel like it's being typed rather than appearing as a completed sentence.
- **Scroll-position management** in the full-output screen (Task 15's noted minimal cut) — a real scrollable viewport, not just an always-appending list.
- **A `:resource`-style command palette** (mentioned in the spec's own deferred section) — not revisited unless the keybinding table's action surface grows enough to need one.

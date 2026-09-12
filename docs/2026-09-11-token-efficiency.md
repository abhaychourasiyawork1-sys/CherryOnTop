# CherryOnTop Token & Wall-Clock Efficiency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved CherryOnTop efficiency architecture so successful tasks use materially fewer tokens and lower p95 wall-clock time without reducing baseline quality or success rate.

**Architecture:** Keep the existing intelligence/economics layer as the decision authority, but add an efficiency-aware Task Judge, a Context Broker between stored evidence and model calls, structured result transport, conditional synthesis, and a scheduler policy that optimizes the critical path within quotas. Raw evidence remains durable; model context becomes a bounded, versioned projection with references and receipts.

**Tech Stack:** TypeScript, existing CherryOnTop runtime/adapters, event bus and DB layers, Kubernetes execution/runtime, existing test framework and collocated `*.test.ts` suites.

**Spec:** `docs/superpowers/specs/2026-09-11-token-efficiency-design.md`

## Global Constraints

- `J = wt * normalized(successful-task tokens) + wl * normalized(p95 wall-clock)`.
- `success rate >= baseline - epsilon`.
- `quality score >= baseline`.
- Raw evidence is never discarded; it remains in the event/artifact store.
- Select/eliminate unnecessary context before applying lossy compression.
- Agents exchange structured results and references rather than transcripts.
- Synthesis is conditional, not automatic.
- Parallelism is selected using dependency and critical-path information, subject to quotas.
- Broker degradation falls back to a larger bounded context; it must not silently drop correctness-critical information.
- Adaptive-scheduler degradation falls back to the safe configured concurrency.
- MVP must not introduce an LLM summarization call solely to compress ordinary tool output.
- Existing `feat/token-efficiency` controls remain compatible: role-specific model selection, plan caching, planner turn caps, and the existing repo-map budget continue to work unless explicitly replaced by a narrower implementation below.
- Phase 3 features (provider KV/prefix caching, warm sandboxes, learned compression) are architecture hooks only and are not required to ship in the MVP.

---

### Task 1: Establish the efficiency metrics and execution ledger

**Files:**
- Create: `src/efficiency/metrics.ts`
- Create: `src/efficiency/ledger.ts`
- Create: `src/efficiency/metrics.test.ts`
- Create: `src/efficiency/ledger.test.ts`
- Modify: `src/execution/execute-step.ts`
- Modify: `src/events/bus.ts`

**Interfaces:**
- Consumes: execution timing, model usage metadata, tool-call metadata, outcome status.
- Produces: `EfficiencyRecord` and `recordEfficiencyEvent(record: EfficiencyRecord): void`.

- [ ] **Step 1: Write the failing metric-shape tests**

```ts
it("builds a successful-task efficiency record", () => {
  const record = buildEfficiencyRecord({
    taskId: "task-1",
    outcome: "success",
    inputTokens: 1000,
    outputTokens: 400,
    observationTokens: 200,
    coordinationTokens: 100,
    recoveryTokens: 0,
    modelCalls: 2,
    toolCalls: 4,
    planningCalls: 1,
    synthesisCalls: 0,
    avoidedSynthesisCalls: 1,
    retries: 0,
    queueMs: 50,
    sandboxStartupMs: 500,
    modelFirstTokenMs: 200,
    modelTotalMs: 2500,
    executionMs: 1000,
    synthesisMs: 0,
    endToEndMs: 4100,
    criticalPathMs: 3200,
    qualityScore: 0.95,
    unresolvedUncertainty: false,
  });

  expect(record.totalTokens).toBe(1700);
  expect(record.tokensPerSuccessfulTask).toBe(1700);
  expect(record.outcome).toBe("success");
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `pnpm test src/efficiency/metrics.test.ts src/efficiency/ledger.test.ts`
Expected: FAIL because `src/efficiency/metrics.ts` and `src/efficiency/ledger.ts` do not yet exist.

- [ ] **Step 3: Implement the metric types and derived metrics**

```ts
export type EfficiencyOutcome = "success" | "failure" | "partial" | "budget_exhausted";

export interface EfficiencyRecord {
  taskId: string;
  outcome: EfficiencyOutcome;
  inputTokens: number;
  outputTokens: number;
  observationTokens: number;
  coordinationTokens: number;
  recoveryTokens: number;
  cachedTokens: number;
  totalTokens: number;
  modelCalls: number;
  toolCalls: number;
  planningCalls: number;
  synthesisCalls: number;
  avoidedSynthesisCalls: number;
  retries: number;
  queueMs: number;
  sandboxStartupMs: number;
  modelFirstTokenMs: number;
  modelTotalMs: number;
  executionMs: number;
  synthesisMs: number;
  endToEndMs: number;
  criticalPathMs: number;
  qualityScore: number | null;
  unresolvedUncertainty: boolean;
  contextReuseRatio: number;
  cacheHitRatio: number;
  synthesisAvoidanceRatio: number;
  observationTokenShare: number;
  coordinationTokenShare: number;
  concurrencyEfficiency: number | null;
  contextExpansionRate: number | null;
  tokensPerSuccessfulTask: number | null;
}

export function buildEfficiencyRecord(input: Omit<EfficiencyRecord, "cachedTokens" | "totalTokens" | "contextReuseRatio" | "cacheHitRatio" | "synthesisAvoidanceRatio" | "observationTokenShare" | "coordinationTokenShare" | "tokensPerSuccessfulTask"> & Partial<Pick<EfficiencyRecord, "cachedTokens" | "contextReuseRatio" | "cacheHitRatio" | "synthesisAvoidanceRatio" | "observationTokenShare" | "coordinationTokenShare" | "tokensPerSuccessfulTask">>): EfficiencyRecord {
  const cachedTokens = input.cachedTokens ?? 0;
  const totalTokens = input.inputTokens + input.outputTokens + input.observationTokens + input.coordinationTokens + input.recoveryTokens;
  return {
    ...input,
    cachedTokens,
    totalTokens,
    contextReuseRatio: input.contextReuseRatio ?? 0,
    cacheHitRatio: input.cacheHitRatio ?? 0,
    synthesisAvoidanceRatio: input.synthesisAvoidanceRatio ?? 0,
    observationTokenShare: input.observationTokenShare ?? (totalTokens === 0 ? 0 : input.observationTokens / totalTokens),
    coordinationTokenShare: input.coordinationTokenShare ?? (totalTokens === 0 ? 0 : input.coordinationTokens / totalTokens),
    tokensPerSuccessfulTask: input.tokensPerSuccessfulTask ?? (input.outcome === "success" ? totalTokens : null),
  };
}
```

- [ ] **Step 4: Implement an execution ledger that records phase start/end and emits one terminal efficiency event**

```ts
export interface EfficiencyLedger {
  startTask(taskId: string): void;
  recordTokens(taskId: string, delta: Partial<Pick<EfficiencyRecord, "inputTokens" | "outputTokens" | "observationTokens" | "coordinationTokens" | "recoveryTokens" | "cachedTokens">>): void;
  recordCall(taskId: string, kind: "model" | "tool" | "planning" | "synthesis" | "retry"): void;
  recordLatency(taskId: string, phase: "queue" | "sandboxStartup" | "modelFirstToken" | "modelTotal" | "execution" | "synthesis" | "criticalPath", ms: number): void;
  finishTask(taskId: string, outcome: EfficiencyOutcome, qualityScore?: number | null, unresolvedUncertainty?: boolean): EfficiencyRecord;
}
```

- [ ] **Step 5: Thread ledger hooks through `src/execution/execute-step.ts` and emit the terminal event through `src/events/bus.ts` without changing task semantics**

- [ ] **Step 6: Run the focused tests and the existing execution tests**

Run: `pnpm test src/efficiency/metrics.test.ts src/efficiency/ledger.test.ts src/execution/execute-step.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/efficiency src/execution/execute-step.ts src/events/bus.ts
git commit -m "feat: add efficiency execution ledger"
```

---

### Task 2: Define the context data model and persistence boundary

**Files:**
- Create: `src/context/types.ts`
- Create: `src/context/store.ts`
- Create: `src/context/store.test.ts`
- Modify: `src/db/schema.ts`
- Modify: `src/db/migrations/*`

**Interfaces:**
- Consumes: event/artifact references and repository evidence.
- Produces: `ContextItem`, `ContextSourceRef`, `ContextProjection`, `ContextReceipt` and `ContextStore` operations.

- [ ] **Step 1: Write failing tests for content-addressed context items and projections**

```ts
it("creates stable ids from the source content hash", async () => {
  const a = await store.put({ kind: "file", sourceRef: "src/a.ts", content: "export const x = 1;" });
  const b = await store.put({ kind: "file", sourceRef: "src/a.ts", content: "export const x = 1;" });

  expect(a.contentHash).toBe(b.contentHash);
  expect(a.contextId).toBe(b.contextId);
});

it("invalidates a projection when a source hash changes", async () => {
  const projection = await store.createProjection({ sourceRefs: ["ctx_a"] });
  await store.replaceSource("ctx_a", { content: "new", contentHash: "hash-b" });

  expect(await store.isProjectionFresh(projection.contextId)).toBe(false);
});
```

- [ ] **Step 2: Run the focused test file and verify failure**

Run: `pnpm test src/context/store.test.ts`
Expected: FAIL because the context store does not yet exist.

- [ ] **Step 3: Implement the core types**

```ts
export type ContextItemKind = "task" | "role" | "constraint" | "repo" | "symbol" | "file" | "test" | "diff" | "tool" | "child_result" | "artifact";

export interface ContextSourceRef {
  sourceId: string;
  kind: ContextItemKind;
  version: string;
  contentHash: string;
}

export interface ContextItem {
  contextId: string;
  kind: ContextItemKind;
  sourceRef: ContextSourceRef;
  content: string;
  estimatedTokens: number;
  importance: number;
  freshness: number;
  evidenceStrength: number;
  dependencies: string[];
}

export interface ContextReceiptItem {
  ref: string;
  reason: string;
  tokens: number;
}

export interface ContextReceipt {
  budget: number;
  selected: ContextReceiptItem[];
  excluded: ContextReceiptItem[];
  truncated: boolean;
  expansionAvailable: boolean;
}

export interface ContextProjection {
  contextId: string;
  sourceRefs: ContextSourceRef[];
  contentHashes: string[];
  estimatedTokens: number;
  content: string;
  receipt: ContextReceipt;
  incomplete: boolean;
  expansionCapabilities: string[];
}
```

- [ ] **Step 4: Persist source hashes and projection metadata using the repository's existing DB conventions; do not delete raw event/artifact payloads**

- [ ] **Step 5: Implement `ContextStore.put`, `get`, `createProjection`, `isProjectionFresh`, and `invalidateBySource`**

- [ ] **Step 6: Run context tests plus the existing DB/schema tests**

Run: `pnpm test src/context/store.test.ts src/db/schema.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/context src/db/schema.ts src/db/migrations
git commit -m "feat: add versioned context storage"
```

---

### Task 3: Implement deterministic context scoring and selection

**Files:**
- Create: `src/context/scorer.ts`
- Create: `src/context/scorer.test.ts`
- Create: `src/context/broker.ts`
- Create: `src/context/broker.test.ts`
- Modify: `src/config/efficiency.ts`

**Interfaces:**
- Consumes: candidate `ContextItem[]`, task metadata, role, token budget.
- Produces: bounded `ContextProjection` and `ContextReceipt`.

- [ ] **Step 1: Write failing tests for score ordering, token budget enforcement, dedupe, and mandatory-item precedence**

```ts
it("ranks direct dependency above a low-relevance artifact", () => {
  const direct = scoreContextItem(item({ importance: 1, freshness: 1, evidenceStrength: 1, relevance: 1, estimatedTokens: 100 }));
  const low = scoreContextItem(item({ importance: 0.2, freshness: 0.8, evidenceStrength: 0.5, relevance: 0.2, estimatedTokens: 100 }));
  expect(direct).toBeGreaterThan(low);
});

it("never exceeds the configured token budget", () => {
  const projection = selectContext({
    task: "fix auth",
    role: "executor",
    candidates: manyItems(5000),
    tokenBudget: 800,
  });
  expect(projection.estimatedTokens).toBeLessThanOrEqual(800);
});

it("deduplicates identical content hashes", () => {
  const projection = selectContext({
    task: "inspect",
    role: "executor",
    candidates: [sameHashItem("a"), sameHashItem("b")],
    tokenBudget: 1000,
  });
  expect(projection.sourceRefs).toHaveLength(1);
});
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `pnpm test src/context/scorer.test.ts src/context/broker.test.ts`
Expected: FAIL because scoring and broker modules do not yet exist.

- [ ] **Step 3: Implement the bounded heuristic score**

```ts
export interface ContextScoreInput {
  relevance: number;
  dependencyImportance: number;
  freshness: number;
  evidenceStrength: number;
  estimatedTokens: number;
}

export function contextScore(input: ContextScoreInput): number {
  const tokenCost = Math.max(input.estimatedTokens, 1);
  return (input.relevance * input.dependencyImportance * input.freshness * input.evidenceStrength) / tokenCost;
}
```

- [ ] **Step 4: Implement `ContextBroker.buildProjection` as `retrieve -> normalize -> dedupe -> rank -> budget -> project -> receipt`**

- [ ] **Step 5: Add role-specific weighting and use the existing efficiency configuration as the single configuration source**

- [ ] **Step 6: Implement fail-open behavior: on broker failure, construct a larger bounded fallback projection and mark the receipt as degraded**

- [ ] **Step 7: Run context tests and existing efficiency config tests**

Run: `pnpm test src/context/scorer.test.ts src/context/broker.test.ts src/config/efficiency.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/context src/config/efficiency.ts
 git commit -m "feat: add deterministic context broker"
```

---

### Task 4: Add lazy context escalation

**Files:**
- Create: `src/context/expansion.ts`
- Create: `src/context/expansion.test.ts`
- Modify: `src/context/broker.ts`
- Modify: `src/schemas/node-contract.ts`
- Modify: `src/schemas/node-contract.test.ts`

**Interfaces:**
- Consumes: `ContextExpansionRequest`, current projection, source/artifact store.
- Produces: bounded `ContextProjection` delta and updated receipt.

- [ ] **Step 1: Write failing tests for all six expansion operations**

```ts
it.each([
  "GET_SYMBOL",
  "GET_FILE_RANGE",
  "GET_DEPENDENTS",
  "GET_TEST_FAILURE",
  "GET_ARTIFACT",
  "GET_DIFF",
])("supports %s expansion", async (operation) => {
  const result = await expandContext({ operation, targetRef: "ctx_1", budget: 400 });
  expect(result.operation).toBe(operation);
  expect(result.projection.estimatedTokens).toBeLessThanOrEqual(400);
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `pnpm test src/context/expansion.test.ts src/schemas/node-contract.test.ts`
Expected: FAIL because typed context-expansion contracts do not yet exist.

- [ ] **Step 3: Add the typed expansion contract**

```ts
export type ContextExpansionOperation =
  | "GET_SYMBOL"
  | "GET_FILE_RANGE"
  | "GET_DEPENDENTS"
  | "GET_TEST_FAILURE"
  | "GET_ARTIFACT"
  | "GET_DIFF";

export interface ContextExpansionRequest {
  operation: ContextExpansionOperation;
  targetRef: string;
  budget: number;
  reason: string;
}
```

- [ ] **Step 4: Implement the expansion router with strict budget and scope checks**

- [ ] **Step 5: Return only the delta projection; never resend the previous projection as part of the expansion**

- [ ] **Step 6: Mark incomplete initial contexts explicitly and expose the supported expansion capabilities through the receipt**

- [ ] **Step 7: Run focused and schema tests**

Run: `pnpm test src/context/expansion.test.ts src/schemas/node-contract.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/context src/schemas/node-contract.ts src/schemas/node-contract.test.ts
git commit -m "feat: add lazy context expansion"
```

---

### Task 5: Replace fixed repo-map handoff with dynamic structural projections

**Files:**
- Modify: `src/intelligence/repo-map.ts`
- Modify: `src/intelligence/repo-map.test.ts`
- Modify: `src/intelligence/decompose.ts`
- Modify: `src/intelligence/coordinator.ts`
- Modify: `src/config/efficiency.ts`

**Interfaces:**
- Consumes: task text, repo map, symbol/dependency metadata, context broker budget.
- Produces: selected structural context and source refs; preserves existing repo-map API compatibility where possible.

- [ ] **Step 1: Write a failing test proving unused repo-map budget is not automatically filled**

```ts
it("returns only task-relevant structure and keeps the configured value as an upper bound", () => {
  const result = buildRepoContext({
    task: "fix session refresh",
    repoMap: fixtureRepoMap(),
    tokenBudget: 2000,
  });
  expect(result.estimatedTokens).toBeLessThanOrEqual(2000);
  expect(result.estimatedTokens).toBeLessThan(2000);
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `pnpm test src/intelligence/repo-map.test.ts`
Expected: FAIL because the existing implementation treats the repo-map limit as a content budget target rather than an upper bound.

- [ ] **Step 3: Implement structural selection in this order: global structure -> task relevance -> symbol/dependency selection -> source refs**

```ts
export interface RepoContextSelection {
  items: Array<{ ref: string; kind: "file" | "symbol" | "dependency"; tokens: number }>;
  estimatedTokens: number;
}

export function selectRepoContext(task: string, repoMap: string, tokenBudget: number): RepoContextSelection {
  const candidates = extractStructuralCandidates(repoMap).map(candidate => ({
    ...candidate,
    score: scoreStructuralCandidate(task, candidate),
  }));

  candidates.sort((a, b) => b.score - a.score);

  const selected = [];
  let tokens = 0;
  for (const candidate of candidates) {
    if (tokens + candidate.tokens > tokenBudget) continue;
    selected.push(candidate);
    tokens += candidate.tokens;
  }

  return { items: selected, estimatedTokens: tokens };
}
```

- [ ] **Step 4: Make `coordinator.ts` and `decompose.ts` request structural context through the broker instead of embedding a full repo-map string in every downstream prompt**

- [ ] **Step 5: Keep `ORG_REPO_MAP_TOKENS`/existing configuration as a hard upper bound and document that it is not a target**

- [ ] **Step 6: Run repo-map, coordinator, and decomposition tests**

Run: `pnpm test src/intelligence/repo-map.test.ts src/intelligence/coordinator.test.ts src/intelligence/decompose.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/intelligence/repo-map.ts src/intelligence/repo-map.test.ts src/intelligence/decompose.ts src/intelligence/coordinator.ts src/config/efficiency.ts
git commit -m "feat: make repository context task selective"
```

---

### Task 6: Implement deterministic observation/tool-output reduction

**Files:**
- Create: `src/execution/observation-reducer.ts`
- Create: `src/execution/observation-reducer.test.ts`
- Modify: `src/execution/tool-calls.ts`
- Modify: `src/execution/tokens.ts`
- Modify: `src/execution/tokens.test.ts`

**Interfaces:**
- Consumes: raw tool output plus command/tool identity.
- Produces: `ReducedObservation` containing model-facing content, full-artifact ref, estimated tokens, and reduction mode.

- [ ] **Step 1: Write failing tests for repeated-line collapse, structured test output, git summary, and full-artifact reference**

```ts
it("collapses repeated log lines without losing the artifact reference", () => {
  const raw = ["retrying", "retrying", "retrying", "done"].join("\n");
  const reduced = reduceObservation({ tool: "shell", output: raw, artifactRef: "artifact://1" });

  expect(reduced.content).toContain("retrying x3");
  expect(reduced.artifactRef).toBe("artifact://1");
});

it("keeps test failures structured", () => {
  const reduced = reduceObservation({ tool: "npm-test", output: "141 passed, 2 failed\nrefresh session: expected 200 received 401", artifactRef: "artifact://2" });
  expect(reduced.summary.failed).toBe(2);
  expect(reduced.content).toContain("refresh session");
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm test src/execution/observation-reducer.test.ts`
Expected: FAIL because the reducer does not yet exist.

- [ ] **Step 3: Implement the reducer modes**

```ts
export type ObservationMode = "summary" | "focused" | "normal" | "full";

export interface ReducedObservation {
  mode: ObservationMode;
  content: string;
  artifactRef: string;
  estimatedTokens: number;
  summary: Record<string, unknown>;
}
```

- [ ] **Step 4: Implement deterministic reducers for shell, git, tests/builds, and generic output; default to `summary`**

- [ ] **Step 5: Store full raw tool output as an artifact/event and pass only the projection into the next model context**

- [ ] **Step 6: Add an explicit escalation path from `summary` to `focused`/`full` through Task 4's expansion operations**

- [ ] **Step 7: Thread observation token accounting into the efficiency ledger**

- [ ] **Step 8: Run execution observation/token tests**

Run: `pnpm test src/execution/observation-reducer.test.ts src/execution/tool-calls.test.ts src/execution/tokens.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/execution/observation-reducer.ts src/execution/observation-reducer.test.ts src/execution/tool-calls.ts src/execution/tokens.ts src/execution/tokens.test.ts
git commit -m "feat: reduce tool observations deterministically"
```

---

### Task 7: Introduce structured inter-agent result envelopes

**Files:**
- Create: `src/intelligence/result-envelope.ts`
- Create: `src/intelligence/result-envelope.test.ts`
- Modify: `src/intelligence/coordinator.ts`
- Modify: `src/intelligence/synthesize.ts`
- Modify: `src/intelligence/synthesize.test.ts`
- Modify: `src/events/bus.ts`

**Interfaces:**
- Consumes: child execution outputs and evidence refs.
- Produces: `AgentResultEnvelope` and result-bus events.

- [ ] **Step 1: Write failing tests for success, partial, failure, and budget-exhausted result parsing**

```ts
it("normalizes a child result into a machine-readable envelope", () => {
  const envelope = buildAgentResultEnvelope({
    status: "success",
    decision: "refresh token before session expiry",
    confidence: 0.91,
    findings: ["refresh happens after expiry"],
    changedFiles: ["src/auth/session.ts"],
    evidenceRefs: ["evt_182"],
    uncertainties: [],
    nextAction: "run auth tests",
  });

  expect(envelope.status).toBe("success");
  expect(envelope.evidenceRefs).toEqual(["evt_182"]);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm test src/intelligence/result-envelope.test.ts`
Expected: FAIL because the envelope types/functions do not yet exist.

- [ ] **Step 3: Implement the envelope schema and validation**

```ts
export type AgentResultStatus = "success" | "partial" | "failed" | "budget_exhausted";

export interface AgentResultEnvelope {
  status: AgentResultStatus;
  decision: string;
  confidence: number;
  findings: string[];
  changedFiles: string[];
  evidenceRefs: string[];
  uncertainties: string[];
  nextAction: string;
  explanation?: string;
}
```

- [ ] **Step 4: Make child execution emit the envelope as the primary transport while preserving optional prose for humans**

- [ ] **Step 5: Make coordinator/synthesis consume envelopes and evidence refs rather than raw child transcripts**

- [ ] **Step 6: Add validation that rejects envelopes with invalid status/confidence/evidence types before they reach synthesis**

- [ ] **Step 7: Run intelligence/event tests**

Run: `pnpm test src/intelligence/result-envelope.test.ts src/intelligence/coordinator.test.ts src/intelligence/synthesize.test.ts src/events/bus.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/intelligence/result-envelope.ts src/intelligence/result-envelope.test.ts src/intelligence/coordinator.ts src/intelligence/synthesize.ts src/intelligence/synthesize.test.ts src/events/bus.ts
git commit -m "feat: use structured agent result envelopes"
```

---

### Task 8: Add context receipts and source/version validation to every model call

**Files:**
- Create: `src/context/receipt.ts`
- Create: `src/context/receipt.test.ts`
- Modify: `src/adapters/adapter.ts`
- Modify: `src/adapters/claude-code.ts`
- Modify: `src/adapters/codex.ts`
- Modify: `src/intelligence/ask.ts`

**Interfaces:**
- Consumes: `ContextProjection`, model request payload.
- Produces: model request with a serialized receipt and efficiency ledger metadata.

- [ ] **Step 1: Write failing tests proving that every request carries receipt metadata and stale projections are rejected/rehydrated**

```ts
it("serializes the projection receipt into the model request metadata", () => {
  const request = withContextReceipt(baseRequest(), projectionFixture());
  expect(request.metadata.contextReceipt.budget).toBe(1800);
  expect(request.metadata.contextReceipt.expansionAvailable).toBe(true);
});

it("does not send a stale projection", async () => {
  const result = await prepareModelRequest({ projection: staleProjectionFixture() });
  expect(result.rehydrated).toBe(true);
});
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `pnpm test src/context/receipt.test.ts src/adapters/claude-code.test.ts src/adapters/codex.test.ts`
Expected: FAIL because receipt/version integration does not yet exist.

- [ ] **Step 3: Implement receipt serialization and validation**

```ts
export function serializeContextReceipt(projection: ContextProjection): ContextReceipt {
  return projection.receipt;
}
```

- [ ] **Step 4: Extend the adapter request contract with optional context metadata without breaking existing adapters**

- [ ] **Step 5: Validate source hashes immediately before dispatch; rehydrate through `ContextStore` when stale**

- [ ] **Step 6: Record context token estimates and selected/excluded refs in the efficiency ledger**

- [ ] **Step 7: Run all adapter/intelligence/context tests**

Run: `pnpm test src/context/receipt.test.ts src/adapters/claude-code.test.ts src/adapters/codex.test.ts src/intelligence/ask.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/context/receipt.ts src/context/receipt.test.ts src/adapters/adapter.ts src/adapters/claude-code.ts src/adapters/codex.ts src/intelligence/ask.ts
git commit -m "feat: attach context receipts to model calls"
```

---

### Task 9: Make planning efficiency-aware and add the fast path

**Files:**
- Modify: `src/intelligence/coordinator.ts`
- Modify: `src/intelligence/coordinator.test.ts`
- Modify: `src/intelligence/plan.ts`
- Modify: `src/intelligence/plan.test.ts`
- Modify: `src/intelligence/select-runtime.ts`
- Modify: `src/intelligence/select-runtime.test.ts`
- Modify: `src/config/efficiency.ts`

**Interfaces:**
- Consumes: task text, lightweight metadata, plan-cache metadata, current budget.
- Produces: execution mode `direct | plan | delegate`, complexity estimate, model tier, and delegation recommendation.

- [ ] **Step 1: Write failing tests for trivial direct execution, simple direct execution, and complex planning**

```ts
it("bypasses planning for a trivial task", () => {
  const decision = judgeTask({ task: "rename variable x to userId", planCache: emptyPlanCache(), budget: healthyBudget() });
  expect(decision.mode).toBe("direct");
});

it("plans a high-complexity multi-file task when expected benefit exceeds planning cost", () => {
  const decision = judgeTask({ task: "redesign auth flow across 12 modules", planCache: emptyPlanCache(), budget: healthyBudget() });
  expect(decision.mode).toBe("plan");
});
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `pnpm test src/intelligence/coordinator.test.ts src/intelligence/plan.test.ts`
Expected: FAIL because the efficiency-aware judge is not yet implemented.

- [ ] **Step 3: Implement the judge and planning-benefit calculation**

```ts
export type TaskExecutionMode = "direct" | "plan" | "delegate";

export interface TaskJudgeDecision {
  mode: TaskExecutionMode;
  complexity: number;
  preferredModelTier: "fast" | "standard" | "deep";
  delegate: boolean;
}

function shouldPlan(complexity: number, planningCost: number, expectedPlanningBenefit: number): boolean {
  return complexity >= 0.6 && expectedPlanningBenefit > planningCost;
}
```

- [ ] **Step 4: Preserve existing plan cache hits as a zero-planning-cost fast path**

- [ ] **Step 5: Ensure role-specific models/turn caps remain enforced after the judge decision**

- [ ] **Step 6: Run intelligence tests**

Run: `pnpm test src/intelligence/coordinator.test.ts src/intelligence/plan.test.ts src/intelligence/select-runtime.test.ts src/config/efficiency.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/intelligence/coordinator.ts src/intelligence/coordinator.test.ts src/intelligence/plan.ts src/intelligence/plan.test.ts src/intelligence/select-runtime.ts src/intelligence/select-runtime.test.ts src/config/efficiency.ts
git commit -m "feat: add efficiency-aware task judging"
```

---

### Task 10: Make synthesis conditional and evidence-driven

**Files:**
- Create: `src/intelligence/integrate-results.ts`
- Create: `src/intelligence/integrate-results.test.ts`
- Modify: `src/intelligence/synthesize.ts`
- Modify: `src/intelligence/synthesize.test.ts`
- Modify: `src/intelligence/coordinator.ts`

**Interfaces:**
- Consumes: `AgentResultEnvelope[]`, evidence refs, task requirements.
- Produces: either deterministic merged result or a targeted synthesis request.

- [ ] **Step 1: Write failing tests for the four paths: no children, single complete child, deterministic merge, unresolved conflict**

```ts
it("returns a complete single-child result without an LLM synthesis call", async () => {
  const decision = await decideIntegration([completeChildResult()], taskFixture());
  expect(decision.kind).toBe("return_child");
});

it("merges compatible child results deterministically", async () => {
  const decision = await decideIntegration([child("A"), child("B")], taskFixture());
  expect(decision.kind).toBe("deterministic_merge");
});

it("requests evidence before synthesis on conflict", async () => {
  const decision = await decideIntegration([conflictingChild("A"), conflictingChild("B")], taskFixture());
  expect(decision.kind).toBe("evidence_first");
});
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `pnpm test src/intelligence/integrate-results.test.ts src/intelligence/synthesize.test.ts`
Expected: FAIL because integration policy does not yet exist.

- [ ] **Step 3: Implement the integration decision state machine**

```ts
export type IntegrationDecision =
  | { kind: "return_direct" }
  | { kind: "return_child"; result: AgentResultEnvelope }
  | { kind: "deterministic_merge"; result: AgentResultEnvelope }
  | { kind: "evidence_first"; refs: string[] }
  | { kind: "synthesize"; inputs: AgentResultEnvelope[] };
```

- [ ] **Step 4: Implement deterministic merge only for compatible structured fields; preserve conflicting fields instead of guessing**

- [ ] **Step 5: Make `synthesize.ts` receive only structured results plus targeted evidence, never full child transcripts by default**

- [ ] **Step 6: Emit `avoidedSynthesisCalls` in the efficiency ledger**

- [ ] **Step 7: Run integration/coordinator/synthesis tests**

Run: `pnpm test src/intelligence/integrate-results.test.ts src/intelligence/coordinator.test.ts src/intelligence/synthesize.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/intelligence/integrate-results.ts src/intelligence/integrate-results.test.ts src/intelligence/synthesize.ts src/intelligence/synthesize.test.ts src/intelligence/coordinator.ts
git commit -m "feat: make synthesis conditional"
```

---

### Task 11: Replace fixed concurrency with a scheduler policy abstraction

**Files:**
- Create: `src/execution/scheduler.ts`
- Create: `src/execution/scheduler.test.ts`
- Modify: `src/execution/dispatch-limit.ts`
- Modify: `src/execution/dispatch-limit.test.ts`
- Modify: `src/execution/execute-step.ts`
- Modify: `src/k8s/client.ts`
- Modify: `src/config/efficiency.ts`

**Interfaces:**
- Consumes: child DAG, duration estimates, dependency state, quota limits, active work.
- Produces: dispatch decisions and a safe concurrency limit.

- [ ] **Step 1: Write failing tests for independent-task parallelism, dependency blocking, quota limits, and safe fallback**

```ts
it("dispatches independent children in parallel", () => {
  const decision = scheduler.nextDispatchPlan(graphWithIndependent("A", "B"), runtimeFixture());
  expect(decision.launch).toEqual(["A", "B"]);
});

it("does not dispatch a child whose dependency is incomplete", () => {
  const decision = scheduler.nextDispatchPlan(graphWithDependency("A", "B"), runtimeFixture({ completed: [] }));
  expect(decision.launch).toEqual(["A"]);
});

it("never exceeds the configured quota", () => {
  const decision = scheduler.nextDispatchPlan(graphWithManyChildren(), runtimeFixture({ safeConcurrency: 2 }));
  expect(decision.launch.length).toBeLessThanOrEqual(2);
});
```

- [ ] **Step 2: Run the focused scheduler tests and verify failure**

Run: `pnpm test src/execution/scheduler.test.ts src/execution/dispatch-limit.test.ts`
Expected: FAIL because no scheduler policy exists.

- [ ] **Step 3: Implement the scheduler interface and conservative default policy**

```ts
export interface SchedulerRuntime {
  safeConcurrency: number;
  activeChildren: number;
  nowMs: number;
}

export interface SchedulerDecision {
  launch: string[];
  defer: string[];
  concurrency: number;
}

export interface Scheduler {
  nextDispatchPlan(graph: TaskGraph, runtime: SchedulerRuntime): SchedulerDecision;
}
```

- [ ] **Step 4: Score ready nodes by estimated critical-path reduction per resource consumed and launch highest-value nodes first**

- [ ] **Step 5: Keep the existing rate/quota protections in `dispatch-limit.ts`; scheduler must consume the policy rather than bypass them**

- [ ] **Step 6: Record critical-path and concurrency-efficiency metrics from actual child timings**

- [ ] **Step 7: Make scheduler degradation fall back to the existing safe configured concurrency**

- [ ] **Step 8: Run scheduler and integration execution tests**

Run: `pnpm test src/execution/scheduler.test.ts src/execution/dispatch-limit.test.ts src/execution/execute-step.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/execution/scheduler.ts src/execution/scheduler.test.ts src/execution/dispatch-limit.ts src/execution/dispatch-limit.test.ts src/execution/execute-step.ts src/k8s/client.ts src/config/efficiency.ts
git commit -m "feat: add critical-path scheduler policy"
```

---

### Task 12: Add richer model routing using cost, latency, and success signals

**Files:**
- Create: `src/intelligence/model-router.ts`
- Create: `src/intelligence/model-router.test.ts`
- Modify: `src/intelligence/select-runtime.ts`
- Modify: `src/intelligence/select-runtime.test.ts`
- Modify: `src/config/efficiency.ts`
- Modify: `src/efficiency/ledger.ts`

**Interfaces:**
- Consumes: task complexity, model role, model cost/latency estimates, cacheability, remaining budgets, observed quality/success metrics.
- Produces: `ModelRouteDecision` with model tier and rationale.

- [ ] **Step 1: Write failing tests for fast/simple routing, deep/complex routing, and budget-aware downgrade**

```ts
it("chooses the fast tier for a low-complexity direct task", () => {
  const route = routeModel({ complexity: 0.2, role: "executor", budget: healthyBudget(), candidates: defaultModels() });
  expect(route.tier).toBe("fast");
});

it("chooses the deep tier when expected success lift outweighs added cost", () => {
  const route = routeModel({ complexity: 0.9, role: "planner", budget: healthyBudget(), candidates: defaultModels() });
  expect(route.tier).toBe("deep");
});
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `pnpm test src/intelligence/model-router.test.ts src/intelligence/select-runtime.test.ts`
Expected: FAIL because the router does not yet exist.

- [ ] **Step 3: Implement the route score using cost, latency, expected quality/success, cacheability, and remaining budget**

```ts
export interface ModelCandidate {
  tier: "fast" | "standard" | "deep";
  expectedSuccess: number;
  expectedQuality: number;
  inputCost: number;
  latencyMs: number;
  cacheability: number;
}

export interface ModelRouteDecision {
  tier: ModelCandidate["tier"];
  reason: string;
}
```

- [ ] **Step 4: Keep the existing role-specific model names/selection as candidate inputs rather than duplicating provider configuration**

- [ ] **Step 5: Log route rationale and actual outcome so later routing changes can be evaluated from evidence**

- [ ] **Step 6: Run model routing tests**

Run: `pnpm test src/intelligence/model-router.test.ts src/intelligence/select-runtime.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/intelligence/model-router.ts src/intelligence/model-router.test.ts src/intelligence/select-runtime.ts src/intelligence/select-runtime.test.ts src/config/efficiency.ts src/efficiency/ledger.ts
git commit -m "feat: add efficiency-aware model routing"
```

---

### Task 13: Add delta context between turns and agents

**Files:**
- Create: `src/context/delta.ts`
- Create: `src/context/delta.test.ts`
- Modify: `src/context/broker.ts`
- Modify: `src/intelligence/coordinator.ts`
- Modify: `src/intelligence/ask.ts`

**Interfaces:**
- Consumes: previous `ContextProjection`, next candidate projection, context source versions.
- Produces: `ContextDelta` with added/removed/changed refs and a token estimate.

- [ ] **Step 1: Write failing tests for no-op deltas, added evidence, changed source, and removed context**

```ts
it("returns an empty delta for identical projections", () => {
  const delta = diffContext(projection("A"), projection("A"));
  expect(delta.added).toEqual([]);
  expect(delta.changed).toEqual([]);
  expect(delta.removed).toEqual([]);
});

it("sends only newly required evidence", () => {
  const delta = diffContext(projection("A"), projection("A", "B"));
  expect(delta.added).toEqual(["B"]);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm test src/context/delta.test.ts`
Expected: FAIL because delta computation does not yet exist.

- [ ] **Step 3: Implement reference-set diffing and source-hash change detection**

```ts
export interface ContextDelta {
  added: string[];
  removed: string[];
  changed: string[];
  estimatedTokens: number;
}

export function diffContext(previous: ContextProjection, next: ContextProjection): ContextDelta {
  const previousRefs = new Set(previous.sourceRefs.map(ref => ref.sourceId));
  const nextRefs = new Set(next.sourceRefs.map(ref => ref.sourceId));
  const added = [...nextRefs].filter(ref => !previousRefs.has(ref));
  const removed = [...previousRefs].filter(ref => !nextRefs.has(ref));
  const changed = next.sourceRefs
    .filter(ref => previous.sourceRefs.some(prev => prev.sourceId === ref.sourceId && prev.contentHash !== ref.contentHash))
    .map(ref => ref.sourceId);

  return { added, removed, changed, estimatedTokens: estimateDeltaTokens(added, changed) };
}
```

- [ ] **Step 4: Make agent handoffs send the initial projection once and subsequent context changes as deltas when the adapter/session supports them**

- [ ] **Step 5: Track context reuse ratio and context expansion rate in the efficiency ledger**

- [ ] **Step 6: Run context/coordinator tests**

Run: `pnpm test src/context/delta.test.ts src/context/broker.test.ts src/intelligence/coordinator.test.ts src/intelligence/ask.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/context/delta.ts src/context/delta.test.ts src/context/broker.ts src/intelligence/coordinator.ts src/intelligence/ask.ts
git commit -m "feat: add delta context handoffs"
```

---

### Task 14: Integrate the efficiency plane and baseline-vs-optimized experiment harness

**Files:**
- Create: `src/efficiency/objective.ts`
- Create: `src/efficiency/objective.test.ts`
- Create: `src/efficiency/experiment.ts`
- Create: `src/efficiency/experiment.test.ts`
- Create: `tests/fixtures/efficiency-task-suite.ts`
- Modify: `src/efficiency/ledger.ts`
- Modify: `src/intelligence/coordinator.ts`
- Modify: `src/execution/execute-step.ts`
- Modify: project test/config files as required by the existing runner

**Interfaces:**
- Consumes: `EfficiencyRecord[]` from baseline and optimized runs.
- Produces: normalized objective score, deltas, regression gates, and experiment report.

- [ ] **Step 1: Write failing tests for objective normalization and quality/success hard gates**

```ts
it("rejects an optimization that improves tokens but regresses quality", () => {
  const result = evaluateExperiment({
    baseline: suite("success=0.95 quality=0.90 tokens=10000 p95=100000"),
    optimized: suite("success=0.95 quality=0.85 tokens=5000 p95=70000"),
    weights: { tokens: 0.5, latency: 0.5 },
    epsilon: 0.02,
  });

  expect(result.accepted).toBe(false);
  expect(result.reason).toContain("quality");
});

it("accepts a Pareto-improving change", () => {
  const result = evaluateExperiment({
    baseline: suite("success=0.95 quality=0.90 tokens=10000 p95=100000"),
    optimized: suite("success=0.96 quality=0.90 tokens=7000 p95=75000"),
    weights: { tokens: 0.5, latency: 0.5 },
    epsilon: 0.02,
  });

  expect(result.accepted).toBe(true);
});
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `pnpm test src/efficiency/objective.test.ts src/efficiency/experiment.test.ts`
Expected: FAIL because the objective/experiment modules do not yet exist.

- [ ] **Step 3: Implement objective evaluation**

```ts
export interface ObjectiveWeights {
  tokens: number;
  latency: number;
}

export interface ExperimentResult {
  accepted: boolean;
  objectiveBaseline: number;
  objectiveOptimized: number;
  tokenDeltaPct: number;
  p95LatencyDeltaPct: number;
  successDeltaPct: number;
  qualityDelta: number;
  reason: string;
}
```

- [ ] **Step 4: Implement the fixed task suite covering trivial, medium, multi-file, debugging, long-output, multi-agent, conflict, and high-context tasks**

- [ ] **Step 5: Add experiment modes matching the spec: baseline, +context selection, +observation reduction, +structured handoff, +conditional synthesis, +adaptive concurrency, all combined**

- [ ] **Step 6: Add reports for tokens per successful task, p50/p95 latency, context reuse, cache hits, synthesis avoidance, observation share, coordination share, concurrency efficiency, and expansion rate**

- [ ] **Step 7: Run the experiment and all existing tests**

Run: `pnpm test`
Expected: PASS; the new suite must enforce the hard quality/success gates and report objective deltas.

- [ ] **Step 8: Commit**

```bash
git add src/efficiency tests/fixtures
 git commit -m "feat: add efficiency experiment harness"
```

---

### Task 15: Add provider-cache, warm-sandbox, and learned-compression extension points without enabling them by default

**Files:**
- Create: `src/efficiency/extensions.ts`
- Create: `src/efficiency/extensions.test.ts`
- Modify: `src/adapters/adapter.ts`
- Modify: `src/k8s/client.ts`
- Modify: `src/config/efficiency.ts`

**Interfaces:**
- Consumes: capability detection and feature flags.
- Produces: explicit optional extension hooks for prefix/KV cache, warm sandbox pools, and learned compression.

- [ ] **Step 1: Write failing tests proving extensions are disabled by default and capability-gated**

```ts
it("keeps phase-3 optimizations disabled by default", () => {
  const extensions = loadEfficiencyExtensions({ env: {} });
  expect(extensions.prefixCache.enabled).toBe(false);
  expect(extensions.warmSandbox.enabled).toBe(false);
  expect(extensions.learnedCompression.enabled).toBe(false);
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `pnpm test src/efficiency/extensions.test.ts`
Expected: FAIL because the extension contract does not yet exist.

- [ ] **Step 3: Define the extension capability interface**

```ts
export interface EfficiencyExtensions {
  prefixCache: { enabled: boolean; provider?: string };
  warmSandbox: { enabled: boolean; poolSize?: number };
  learnedCompression: { enabled: boolean; compressor?: string };
}
```

- [ ] **Step 4: Add adapter hooks for cache capability reporting without changing behavior when unsupported**

- [ ] **Step 5: Add K8s warm-pool capability detection without starting warm pools**

- [ ] **Step 6: Add a learned-compression interface that can accept a projection and return a smaller projection, but keep the implementation disabled and unused**

- [ ] **Step 7: Run focused tests**

Run: `pnpm test src/efficiency/extensions.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/efficiency/extensions.ts src/efficiency/extensions.test.ts src/adapters/adapter.ts src/k8s/client.ts src/config/efficiency.ts
git commit -m "chore: add efficiency extension points"
```

---

### Task 16: Documentation, rollout flags, and end-to-end regression gate

**Files:**
- Modify: `README.md`
- Modify: `USAGE.md`
- Modify: `src/config/efficiency.ts`
- Create: `src/config/efficiency-rollout.test.ts`
- Modify: existing integration suites under `src/execution`, `src/intelligence`, `src/events`, and `src/adapters`

**Interfaces:**
- Consumes: all MVP efficiency components.
- Produces: operator-facing flags and a controlled rollout path.

- [ ] **Step 1: Write failing rollout tests for disabled, shadow, and enabled modes**

```ts
it("supports disabled, shadow, and enabled efficiency modes", () => {
  expect(parseEfficiencyMode("disabled")).toBe("disabled");
  expect(parseEfficiencyMode("shadow")).toBe("shadow");
  expect(parseEfficiencyMode("enabled")).toBe("enabled");
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `pnpm test src/config/efficiency-rollout.test.ts`
Expected: FAIL because rollout mode parsing does not yet exist.

- [ ] **Step 3: Implement rollout modes**

```ts
export type EfficiencyMode = "disabled" | "shadow" | "enabled";

export function parseEfficiencyMode(value: string | undefined): EfficiencyMode {
  if (value === "enabled") return "enabled";
  if (value === "shadow") return "shadow";
  return "disabled";
}
```

- [ ] **Step 4: In `shadow` mode, compute projections/decisions and metrics but retain the existing execution behavior**

- [ ] **Step 5: In `enabled` mode, activate the MVP components while preserving all hard correctness fallbacks**

- [ ] **Step 6: Document architecture, configuration, failure behavior, metrics, and experiment commands in `README.md`/`USAGE.md`**

- [ ] **Step 7: Run the full regression suite and a representative end-to-end execution**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 8: Run the efficiency benchmark suite in shadow mode first, then enabled mode, and compare against the stored baseline using Task 14's acceptance gates**

- [ ] **Step 9: Commit**

```bash
git add README.md USAGE.md src/config/efficiency.ts src/config/efficiency-rollout.test.ts
git commit -m "feat: add controlled efficiency rollout"
```

---

## Implementation Order Summary

The execution order is intentionally dependency-driven:

`1 metrics -> 2 context model -> 3 broker -> 4 escalation -> 5 repo context -> 6 observations -> 7 structured results -> 8 receipts/versioning -> 9 task judge -> 10 conditional synthesis -> 11 scheduler -> 12 model router -> 13 delta context -> 14 experiments -> 15 phase-3 extension hooks -> 16 rollout/docs`.

The first shippable MVP checkpoint is after Task 11, with Tasks 12-16 progressively improving routing, reuse, evaluation, extensibility, and rollout safety.

## Spec Coverage Check

- Task Judge / planning fast path: Task 9.
- Context Broker pipeline: Tasks 2-4.
- Context scoring equation: Task 3.
- Lazy expansion operations: Task 4.
- Dynamic repo projection: Task 5.
- Observation reduction: Task 6.
- Structured result bus: Task 7.
- Conditional synthesis: Task 10.
- Adaptive scheduling / critical path: Task 11.
- Context versioning: Tasks 2 and 8.
- Context receipts: Task 8.
- Token/latency/quality observability: Tasks 1 and 14.
- Failure semantics: Tasks 3, 4, 8, 10, 11 and 16.
- Experimental matrix and hard gates: Task 14.
- Plan cache / existing efficiency controls retained: Task 9.
- Provider KV cache / warm sandboxes / learned compression: Task 15 as gated extension points only.

## Verification / Acceptance Gate

Before enabling the architecture by default:

1. `pnpm test` passes.
2. Baseline and optimized runs use the same representative task corpus and runtime settings.
3. Success rate does not regress beyond configured epsilon.
4. Quality does not regress.
5. The combined optimization has a lower objective `J` than baseline.
6. No correctness path depends on a lossy context projection being complete.
7. Every model call has a context receipt or an explicit legacy/disabled marker during rollout.
8. All raw tool/evidence artifacts remain retrievable through refs.

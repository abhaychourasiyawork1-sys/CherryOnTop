# Accountable Agent Organization Runtime — Phase 3+4: Accountability Engines & CLI/TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Before starting:** create an isolated workspace via superpowers:using-git-worktrees, branched from the Phase 2 branch (`worktree-phase2-execution-substrate`, commit `d84d5af`) **after it's merged to `main`** — don't branch Phase 3+4 off an unmerged branch.
>
> **Skills to invoke during execution:**
> - superpowers:test-driven-development governs every task's step rhythm.
> - superpowers:systematic-debugging — invoke when the state-machine wiring in Tasks 10–12 misbehaves; XState `invoke`/guard ordering bugs are easy to misdiagnose by guessing.
> - superpowers:requesting-code-review — invoke once Task 3 (last gap fix) is done, and again once Task 20 (Phase 4 exit) is done — two review points, not one, since this plan covers two phases.
> - superpowers:verification-before-completion — invoke before declaring either phase done.
> - superpowers:finishing-a-development-branch — invoke after each review point.

**Goal:** Make `org run "<goal>"` actually autonomous end-to-end — a node reaching `INTELLIGENCE_GATE` and `EXECUTION_DECISION` no longer waits for an external caller to send an event; it invokes the Intelligence Coordinator and Economics engine itself, decides SELF_EXECUTE vs. DELEGATE vs. ESCALATE, and (if delegating) spawns and awaits a real child node. Then give a human a way to see and act on all of it: `org commitment`, `org decision`, `org watch`, and `org approve`/`org reject` for authority-boundary escalations.

**Architecture:** Phase 2 proved `SELF_EXECUTE` as an XState invoked actor backed by real K8s dispatch. This plan applies the same pattern to `INTELLIGENCE_GATE`, `EXECUTION_DECISION`, `DELEGATE`, and a new `WAIT_APPROVAL` state — every lifecycle decision point becomes "invoke a pure-logic engine, transition on its result," keeping the engines themselves (`authority.ts`, `economics.ts`, `coordinator.ts`) unit-testable without touching a cluster or the actor system, exactly like `execute-step.ts` already is.

**Tech Stack additions:** `node-notifier` (desktop notifications), `ink` + `@inkjs/ui` (the `org watch` TUI) — both already decided in the spec, neither installed yet.

**Spec:** [docs/superpowers/specs/2026-09-05-accountable-agent-org-runtime-design.md](../specs/2026-09-05-accountable-agent-org-runtime-design.md) §7 (economics formula), and [accountable_agent_organization_runtime_handoff.html](../../../accountable_agent_organization_runtime_handoff.html) §8 (authority), §9 (commitments), §10 (economics), §6 (intelligence). Implements the Phase 3 and Phase 4 scope sections of [2026-09-05-accountable-agent-org-runtime-v0.1.md](2026-09-05-accountable-agent-org-runtime-v0.1.md).

---

## Phase 2 gaps and bugs found during verification (2026-09-05)

Phase 2 was independently re-verified against a live `kind` cluster before writing this plan: `npm run typecheck` clean, 20 test files / 53 tests passing with **zero skips** (confirmed against the real `org-local` cluster, not just CI), `org doctor` reporting 5/5 green, and all Job/Secret/NetworkPolicy resources confirmed cleaned up after the run. No outright bugs (nothing built is broken) — but five gaps, three fixed by this plan's Tasks 1–3 and two explicitly *not* fixed here with reasons why:

| # | Gap | Where | Fixed here? |
|---|---|---|---|
| **G1** | `applyDefaultDenyPolicy()` is built and unit-tested (Phase 2 Task 5) but never called from the real bootstrap path — `ensureLocalCluster()`/`ensureNamespace()` never invoke it, so the `org-exec` namespace has no baseline deny-all independent of a per-node policy. | `src/k8s/kind.ts` | **Yes — Task 1** |
| **G2** | The per-node egress allowlist is `0.0.0.0/0:443` (self-flagged with a `ponytail:` comment) — technically an allowlist, but wide enough that a compromised runner could reach cloud metadata endpoints (`169.254.169.254`) or internal RFC1918 services over HTTPS. | `src/execution/execute-step.ts` | **Yes — Task 2** |
| **G3** | Per-node egress `NetworkPolicy` objects (`org-egress-<nodeId>`) are created once and never deleted — every node that ever ran accumulates a policy object for the cluster's lifetime (also self-flagged). Phase 2 had no node ever reach `COMPLETE` autonomously, so there was no natural place to garbage-collect them yet. | `src/execution/execute-step.ts` | **Yes — Task 3** |
| **G4** | `executeStep` is always called with `credentials: {}` (self-flagged: "no credentials plumbed yet — the Secret is created empty until the credential-broker task lands"). A real Claude Code invocation inside a Job has no auth and will fail immediately; only the busybox stopgap actually completing proves the *dispatch* mechanics, not a real harness run. | `src/lifecycle/node-actor-manager.ts` | **No — see below** |
| **G5** | `hostPath` volumes resolve inside the `kind` control-plane container's filesystem, not the real host — a worktree path from the host machine is not actually visible to a Job unless the cluster is created with an `extraMounts` config declaring the bind mount (self-flagged, explicitly deferred to Phase 5's cluster-config task in the original Phase 2 plan). | `src/k8s/job-manifest.ts` | **No — see below** |

**Why G4 and G5 aren't fixed in this plan:** neither blocks what Phase 3+4 actually need to prove. The autonomous lifecycle (intelligence → economics → self-execute/delegate/escalate → verify → complete) and the CLI/TUI/approval surface are both fully demonstrable using the same busybox-stopgap pattern Phase 2's own integration test already established — real Claude Code credentials and real host-worktree mounting are prerequisites for a genuinely useful `org run` against your own repo, but not for proving this phase's actual scope. Pulling them in here would silently expand this plan's boundary the same way the original Phase 1 plan warned against. They remain tracked, explicitly, as the first two things to resolve before or during Phase 5 (which already owns the runner image and cluster-config work both gaps are entangled with).

---

### Task 1 (gap fix G1): Wire `applyDefaultDenyPolicy` into cluster bootstrap

**Files:**
- Modify: `src/k8s/kind.ts`
- Test: `src/k8s/kind.test.ts` (extend)

**Interfaces:**
- Consumes: `applyDefaultDenyPolicy` (Phase 2 Task 5, already exists and is tested — just unused).
- Produces: no new exports; `ensureLocalCluster()`'s behavior changes to always apply the baseline policy.

- [ ] **Step 1: Write the failing test**

```ts
// src/k8s/kind.test.ts — add this describe block
import { execa } from 'execa';
import { isClusterAvailable, ensureLocalCluster, NAMESPACE } from './kind.js';

describe.skipIf(!(await isClusterAvailable()))('ensureLocalCluster default-deny wiring', () => {
  it('applies a default-deny NetworkPolicy to the org-exec namespace', async () => {
    await ensureLocalCluster();
    const { stdout } = await execa('kubectl', ['get', 'networkpolicy', 'default-deny-all', '-n', NAMESPACE, '-o', 'name']);
    expect(stdout.trim()).toBe('networkpolicy.networking.k8s.io/default-deny-all');
  }, 60_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `sg docker -c "npm test -- kind.test"` (or plain `npm test -- kind.test` if your shell already has Docker group access — see the Phase 2 memory note about this environment's snap-Docker group timing)
Expected: FAIL — no `default-deny-all` policy exists in `org-exec` yet.

- [ ] **Step 3: Wire it in**

```ts
// src/k8s/kind.ts — add the import and one line in ensureLocalCluster
import { applyDefaultDenyPolicy } from './network-policy.js';

// ... (unchanged: isClusterReachable, commandSucceeds, isClusterAvailable, hasExistingKubeconfigContext, NAMESPACE)

export async function ensureLocalCluster(): Promise<void> {
  const alreadyUp = (await hasExistingKubeconfigContext()) && (await isClusterReachable());

  if (!alreadyUp) {
    const { stdout } = await execa('kind', ['get', 'clusters']).catch(() => ({ stdout: '' }));
    if (!stdout.split('\n').includes(CLUSTER_NAME)) {
      await execa('kind', ['create', 'cluster', '--name', CLUSTER_NAME], { timeout: 120_000 });
    }
  }

  await ensureNamespace(NAMESPACE);
  // G1 fix: this was built and tested in Phase 2 but never actually called.
  // A per-node egress policy (execute-step.ts) already implies deny-by-default
  // for pods it selects, but this is the namespace-wide backstop for anything
  // that ends up in org-exec without going through executeStep.
  await applyDefaultDenyPolicy(NAMESPACE);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `sg docker -c "npm test -- kind.test"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/k8s/kind.ts src/k8s/kind.test.ts
git commit -m "fix: wire applyDefaultDenyPolicy into cluster bootstrap (gap G1)"
```

---

### Task 2 (gap fix G2): Harden the default egress allowlist against metadata/private-range access

**Files:**
- Modify: `src/k8s/network-policy.ts`, `src/execution/execute-step.ts`
- Test: `src/k8s/network-policy.test.ts` (extend)

**Interfaces:**
- Consumes: `V1NetworkPolicy`'s `ipBlock.except` field (standard Kubernetes NetworkPolicy API — supported since the API's introduction, not new to this task).
- Produces: `buildEgressAllowlistPolicy` gains an `except` parameter; `DEFAULT_EGRESS_ALLOWLIST` in `execute-step.ts` now excludes the AWS/GCP/Azure metadata address and RFC1918 private ranges.

- [ ] **Step 1: Write the failing test**

```ts
// src/k8s/network-policy.test.ts — add this test to the existing describe block
it('excludes metadata and private-range addresses from a wide-open allowlist', () => {
  const policy = buildEgressAllowlistPolicy('n1', [
    { ip: '0.0.0.0/0', ports: [443], except: ['169.254.169.254/32', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'] },
  ]);
  expect(policy.spec?.egress?.[0].to?.[0].ipBlock?.except).toEqual([
    '169.254.169.254/32', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16',
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- network-policy.test`
Expected: FAIL — `buildEgressAllowlistPolicy`'s target type has no `except` field yet.

- [ ] **Step 3: Update `network-policy.ts`**

```ts
// src/k8s/network-policy.ts — change the function signature and body
export function buildEgressAllowlistPolicy(
  nodeId: string,
  allowedTargets: { ip: string; ports: number[]; except?: string[] }[],
): V1NetworkPolicy {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name: `org-egress-${nodeId}` },
    spec: {
      podSelector: { matchLabels: { 'org.nodeId': nodeId } },
      policyTypes: ['Ingress', 'Egress'],
      ingress: [],
      egress: allowedTargets.map((target) => ({
        to: [{ ipBlock: { cidr: target.ip, ...(target.except ? { except: target.except } : {}) } }],
        ports: target.ports.map((port) => ({ port, protocol: 'TCP' })),
      })),
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- network-policy.test`
Expected: PASS — including the pre-existing test from Phase 2, which passed no `except` and must still work (the field is optional).

- [ ] **Step 5: Update `execute-step.ts`'s default allowlist to use it**

```ts
// src/execution/execute-step.ts — replace DEFAULT_EGRESS_ALLOWLIST
// G2 fix: still wide on IP range (a real per-provider CIDR allowlist is a Phase 5
// config task — providers' actual ranges shift and need a maintained source), but
// now excludes the addresses a compromised runner could actually do damage with:
// cloud metadata (credential theft) and RFC1918 private ranges (lateral movement
// into whatever network the cluster's node happens to sit on).
const DEFAULT_EGRESS_ALLOWLIST = [
  {
    ip: '0.0.0.0/0',
    ports: [443],
    except: ['169.254.169.254/32', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
  },
];
```

- [ ] **Step 6: Run the full k8s test suite to confirm nothing else broke**

Run: `sg docker -c "npm test"`
Expected: PASS — all 53+ tests (this task added 1, Task 1 added 1) still green.

- [ ] **Step 7: Commit**

```bash
git add src/k8s/network-policy.ts src/k8s/network-policy.test.ts src/execution/execute-step.ts
git commit -m "fix: exclude metadata/private ranges from the default egress allowlist (gap G2)"
```

---

### Task 3 (gap fix G3): Garbage-collect per-node NetworkPolicy on COMPLETE

**Files:**
- Create: `src/k8s/cleanup.ts`
- Modify: `src/lifecycle/node-actor-manager.ts`
- Test: `src/k8s/cleanup.test.ts`

**Interfaces:**
- Consumes: nothing new (`@kubernetes/client-node`, already a dependency).
- Produces: `deleteNodeNetworkPolicy(nodeId: string, namespace: string): Promise<void>` — consumed by `node-actor-manager.ts`'s subscription callback, which is the one place that already observes every state transition including the terminal ones.

- [ ] **Step 1: Write the failing test**

```ts
// src/k8s/cleanup.test.ts
import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { buildEgressAllowlistPolicy, applyNetworkPolicy } from './network-policy.js';
import { deleteNodeNetworkPolicy } from './cleanup.js';
import { isClusterReachable, NAMESPACE } from './kind.js';

const CLUSTER_AVAILABLE = await isClusterReachable();
if (!CLUSTER_AVAILABLE) console.log('no reachable cluster — skipping NetworkPolicy cleanup test');

describe.skipIf(!CLUSTER_AVAILABLE)('deleteNodeNetworkPolicy', () => {
  it('deletes the per-node egress policy without throwing if it exists', async () => {
    const policy = buildEgressAllowlistPolicy('cleanup-test-node', [{ ip: '0.0.0.0/0', ports: [443] }]);
    await applyNetworkPolicy(policy, NAMESPACE);

    await deleteNodeNetworkPolicy('cleanup-test-node', NAMESPACE);

    const { stdout } = await execa('kubectl', ['get', 'networkpolicy', '-n', NAMESPACE, '-o', 'name']);
    expect(stdout).not.toContain('org-egress-cleanup-test-node');
  }, 30_000);

  it('does not throw when the policy does not exist', async () => {
    await expect(deleteNodeNetworkPolicy('never-existed', NAMESPACE)).resolves.not.toThrow();
  }, 15_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `sg docker -c "npm test -- cleanup.test"`
Expected: FAIL — `Cannot find module './cleanup'`.

- [ ] **Step 3: Write `k8s/cleanup.ts`**

```ts
// src/k8s/cleanup.ts
import * as k8s from '@kubernetes/client-node';

function loadNetworkingApi() {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  return kc.makeApiClient(k8s.NetworkingV1Api);
}

export async function deleteNodeNetworkPolicy(nodeId: string, namespace: string): Promise<void> {
  const api = loadNetworkingApi();
  await api
    .deleteNamespacedNetworkPolicy({ name: `org-egress-${nodeId}`, namespace })
    .catch((err) => {
      if (err instanceof k8s.ApiException && err.code === 404) return;
      throw err;
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `sg docker -c "npm test -- cleanup.test"`
Expected: PASS.

- [ ] **Step 5: Wire cleanup into the node's terminal-state transition**

```ts
// src/lifecycle/node-actor-manager.ts — add the import and the check inside actor.subscribe
import { deleteNodeNetworkPolicy } from '../k8s/cleanup.js';

// ... inside startNodeActor, replace the actor.subscribe callback body:
actor.subscribe((snapshot) => {
  const now = new Date().toISOString();
  updateNodeState(db, nodeId, String(snapshot.value), now);
  appendEvent(db, { nodeId, type: 'state.transition', payload: { state: snapshot.value }, createdAt: now });

  // G3 fix: the per-node egress policy outlives the node otherwise. COMPLETE and
  // FAILED (added in Task 16) are the two states a node never leaves, so both
  // are safe points to release cluster-side resources tied to its nodeId.
  if (snapshot.status === 'done') {
    deleteNodeNetworkPolicy(nodeId, NAMESPACE).catch((err) => {
      console.error(`Failed to clean up NetworkPolicy for node ${nodeId}:`, err);
    });
  }
});
```

- [ ] **Step 6: Run the full test suite**

Run: `sg docker -c "npm test"`
Expected: PASS — all tests including Phase 2's existing `node-actor-manager.test.ts` (which never sends `SELF_EXECUTE`, so `snapshot.status === 'done'` never fires there — confirm this by inspection, the same caution as Phase 2's Task 8).

- [ ] **Step 7: Commit**

```bash
git add src/k8s/cleanup.ts src/k8s/cleanup.test.ts src/lifecycle/node-actor-manager.ts
git commit -m "fix: garbage-collect per-node NetworkPolicy when a node reaches a terminal state (gap G3)"
```

---

# Phase 3: Accountability Engines

### Task 4: Commitment schema, table, and queries

**Files:**
- Create: `src/schemas/commitment.ts`, `src/db/queries/commitments.ts`
- Modify: `src/db/schema.ts`
- Test: `src/schemas/commitment.test.ts`, `src/db/queries/commitments.test.ts`

**Interfaces:**
- Produces: `CommitmentSchema`, `type Commitment`, `commitments` Drizzle table, `insertCommitment`, `updateCommitmentStatus`, `getCommitment`, `listCommitmentsForNode` — consumed by Task 12 (delegate-child creates a commitment per child) and Task 14 (`org commitment`).

- [ ] **Step 1: Write the failing schema test**

```ts
// src/schemas/commitment.test.ts
import { describe, it, expect } from 'vitest';
import { CommitmentSchema } from './commitment.js';

describe('CommitmentSchema', () => {
  it('accepts a minimal valid commitment', () => {
    const result = CommitmentSchema.safeParse({
      id: 'c1', owner: 'n1', goal: 'implement feature X',
      definition_of_done: ['tests pass'], status: 'pending',
      created_at: '2026-09-05T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid status', () => {
    const result = CommitmentSchema.safeParse({
      id: 'c1', owner: 'n1', goal: 'x', definition_of_done: ['x'],
      status: 'not-a-real-status', created_at: '2026-09-05T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('defaults array fields to empty when omitted', () => {
    const result = CommitmentSchema.parse({
      id: 'c1', owner: 'n1', goal: 'x', definition_of_done: ['x'],
      status: 'pending', created_at: '2026-09-05T00:00:00.000Z',
    });
    expect(result.dependencies).toEqual([]);
    expect(result.evidence).toEqual([]);
    expect(result.risks).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- commitment.test`
Expected: FAIL — `Cannot find module './commitment'`.

- [ ] **Step 3: Write `schemas/commitment.ts`**

```ts
// src/schemas/commitment.ts
import { z } from 'zod';

export const CommitmentStatusSchema = z.enum(['pending', 'active', 'blocked', 'at_risk', 'completed', 'failed']);

export const CommitmentSchema = z.object({
  id: z.string(),
  owner: z.string(),
  parent_commitment: z.string().optional(),
  goal: z.string().min(1),
  definition_of_done: z.array(z.string()).min(1),
  status: CommitmentStatusSchema,
  created_at: z.string().datetime(),
  started_at: z.string().datetime().optional(),
  expected_at: z.string().datetime().optional(),
  due_at: z.string().datetime().optional(),
  last_progress_at: z.string().datetime().optional(),
  next_check_at: z.string().datetime().optional(),
  completed_at: z.string().datetime().optional(),
  dependencies: z.array(z.string()).default([]),
  evidence: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  current_confidence: z.number().min(0).max(1).optional(),
  current_progress: z.number().min(0).max(1).optional(),
});

export type CommitmentStatus = z.infer<typeof CommitmentStatusSchema>;
export type Commitment = z.infer<typeof CommitmentSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- commitment.test`
Expected: PASS — 3 tests passed.

- [ ] **Step 5: Add the table to `db/schema.ts`**

```ts
// src/db/schema.ts — add below the existing `events` table
import type { Commitment } from '../schemas/commitment.js';

export const commitments = sqliteTable('commitments', {
  id: text('id').primaryKey(),
  owner: text('owner').notNull(),
  data: text('data', { mode: 'json' }).$type<Commitment>().notNull(),
  status: text('status').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
```

- [ ] **Step 6: Generate the migration**

```bash
npx drizzle-kit generate
```

Expected: a new migration file adding the `commitments` table, alongside (not replacing) the existing Phase 1 migration.

- [ ] **Step 7: Write the failing test for the query layer**

```ts
// src/db/queries/commitments.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../client.js';
import { insertCommitment, updateCommitmentStatus, getCommitment, listCommitmentsForNode } from './commitments.js';
import type { Commitment } from '../../schemas/commitment.js';

const TEST_DB = './test-commitments.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

const BASE: Commitment = {
  id: 'c1', owner: 'n1', goal: 'test', definition_of_done: ['x'],
  status: 'pending', created_at: 't0', dependencies: [], evidence: [], risks: [],
};

describe('commitment queries', () => {
  it('inserts and retrieves a commitment', () => {
    const db = createDb(TEST_DB);
    insertCommitment(db, BASE, 't0');
    expect(getCommitment(db, 'c1')?.status).toBe('pending');
  });

  it('updates status', () => {
    const db = createDb(TEST_DB);
    insertCommitment(db, BASE, 't0');
    updateCommitmentStatus(db, 'c1', 'active', 't1');
    expect(getCommitment(db, 'c1')?.status).toBe('active');
  });

  it('lists commitments for a node', () => {
    const db = createDb(TEST_DB);
    insertCommitment(db, BASE, 't0');
    insertCommitment(db, { ...BASE, id: 'c2' }, 't0');
    insertCommitment(db, { ...BASE, id: 'c3', owner: 'n2' }, 't0');
    expect(listCommitmentsForNode(db, 'n1')).toHaveLength(2);
  });
});
```

- [ ] **Step 8: Run test to verify it fails**

Run: `npm test -- commitments.test`
Expected: FAIL — `Cannot find module './commitments'`.

- [ ] **Step 9: Write `db/queries/commitments.ts`**

```ts
// src/db/queries/commitments.ts
import { eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { commitments } from '../schema.js';
import type { Commitment } from '../../schemas/commitment.js';

export function insertCommitment(db: Db, commitment: Commitment, now: string): void {
  db.insert(commitments).values({
    id: commitment.id, owner: commitment.owner, data: commitment,
    status: commitment.status, createdAt: now, updatedAt: now,
  }).run();
}

export function updateCommitmentStatus(db: Db, id: string, status: Commitment['status'], updatedAt: string): void {
  db.update(commitments).set({ status, updatedAt }).where(eq(commitments.id, id)).run();
}

export function getCommitment(db: Db, id: string): Commitment | undefined {
  const row = db.select().from(commitments).where(eq(commitments.id, id)).get();
  return row?.data;
}

export function listCommitmentsForNode(db: Db, owner: string): Commitment[] {
  return db.select().from(commitments).where(eq(commitments.owner, owner)).all().map((r) => r.data);
}
```

- [ ] **Step 10: Run test to verify it passes**

Run: `npm test -- commitments.test`
Expected: PASS — 3 tests passed.

- [ ] **Step 11: Commit**

```bash
git add src/schemas/commitment.ts src/schemas/commitment.test.ts src/db/schema.ts src/db/migrations src/db/queries/commitments.ts src/db/queries/commitments.test.ts
git commit -m "feat: add Commitment schema, table, and query layer"
```

---

### Task 5: Decisions schema, table, and queries

**Files:**
- Create: `src/schemas/decision.ts`, `src/db/queries/decisions.ts`
- Modify: `src/db/schema.ts`
- Test: `src/schemas/decision.test.ts`, `src/db/queries/decisions.test.ts`

**Interfaces:**
- Produces: `DecisionSchema`, `type Decision`, `decisions` table, `insertDecision`, `listDecisionsForNode` — consumed by Task 11 (persisting every EXECUTION_DECISION outcome) and Task 14 (`org decision`).

- [ ] **Step 1: Write the failing schema test**

```ts
// src/schemas/decision.test.ts
import { describe, it, expect } from 'vitest';
import { DecisionSchema } from './decision.js';

describe('DecisionSchema', () => {
  it('accepts a delegation decision with a full score breakdown', () => {
    const result = DecisionSchema.safeParse({
      id: 'd1', nodeId: 'n1', type: 'execution_decision',
      outcome: 'DELEGATE',
      breakdown: { estimatedValue: 1, modelCost: 0.1, latencyCost: 0.05, coordinationCost: 0.15, verificationCost: 0.1, riskPenalty: 0, threshold: 0.3, score: 0.6 },
      createdAt: '2026-09-05T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown outcome', () => {
    const result = DecisionSchema.safeParse({
      id: 'd1', nodeId: 'n1', type: 'execution_decision', outcome: 'MAYBE',
      breakdown: {}, createdAt: '2026-09-05T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- decision.test`
Expected: FAIL — `Cannot find module './decision'`.

- [ ] **Step 3: Write `schemas/decision.ts`**

```ts
// src/schemas/decision.ts
import { z } from 'zod';

export const DecisionOutcomeSchema = z.enum(['SELF_EXECUTE', 'DELEGATE', 'ESCALATE']);

export const DecisionSchema = z.object({
  id: z.string(),
  nodeId: z.string(),
  type: z.literal('execution_decision'),
  outcome: DecisionOutcomeSchema,
  breakdown: z.record(z.string(), z.number()),
  createdAt: z.string().datetime(),
});

export type DecisionOutcome = z.infer<typeof DecisionOutcomeSchema>;
export type Decision = z.infer<typeof DecisionSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- decision.test`
Expected: PASS — 2 tests passed.

- [ ] **Step 5: Add the table to `db/schema.ts`**

```ts
// src/db/schema.ts — add below `commitments`
import type { Decision } from '../schemas/decision.js';

export const decisions = sqliteTable('decisions', {
  id: text('id').primaryKey(),
  nodeId: text('node_id').notNull(),
  data: text('data', { mode: 'json' }).$type<Decision>().notNull(),
  createdAt: text('created_at').notNull(),
});
```

- [ ] **Step 6: Generate the migration**

```bash
npx drizzle-kit generate
```

- [ ] **Step 7: Write the failing test for the query layer**

```ts
// src/db/queries/decisions.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../client.js';
import { insertDecision, listDecisionsForNode } from './decisions.js';
import type { Decision } from '../../schemas/decision.js';

const TEST_DB = './test-decisions.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

const BASE: Decision = {
  id: 'd1', nodeId: 'n1', type: 'execution_decision', outcome: 'SELF_EXECUTE',
  breakdown: { score: 0.1 }, createdAt: 't0',
};

describe('decision queries', () => {
  it('inserts and lists decisions for a node', () => {
    const db = createDb(TEST_DB);
    insertDecision(db, BASE);
    insertDecision(db, { ...BASE, id: 'd2' });
    insertDecision(db, { ...BASE, id: 'd3', nodeId: 'n2' });
    const list = listDecisionsForNode(db, 'n1');
    expect(list).toHaveLength(2);
    expect(list[0].outcome).toBe('SELF_EXECUTE');
  });
});
```

- [ ] **Step 8: Run test to verify it fails**

Run: `npm test -- decisions.test`
Expected: FAIL — `Cannot find module './decisions'`.

- [ ] **Step 9: Write `db/queries/decisions.ts`**

```ts
// src/db/queries/decisions.ts
import { eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { decisions } from '../schema.js';
import type { Decision } from '../../schemas/decision.js';

export function insertDecision(db: Db, decision: Decision): void {
  db.insert(decisions).values({
    id: decision.id, nodeId: decision.nodeId, data: decision, createdAt: decision.createdAt,
  }).run();
}

export function listDecisionsForNode(db: Db, nodeId: string): Decision[] {
  return db.select().from(decisions).where(eq(decisions.nodeId, nodeId)).all().map((r) => r.data);
}
```

- [ ] **Step 10: Run test to verify it passes**

Run: `npm test -- decisions.test`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/schemas/decision.ts src/schemas/decision.test.ts src/db/schema.ts src/db/migrations src/db/queries/decisions.ts src/db/queries/decisions.test.ts
git commit -m "feat: add Decision schema, table, and query layer"
```

---

### Task 6: Authority engine

**Files:**
- Create: `src/engines/authority.ts`
- Test: `src/engines/authority.test.ts`

**Interfaces:**
- Consumes: `Authority` type (Phase 1, `src/schemas/node-contract.ts`).
- Produces: `effectiveAuthority(platformMax: Authority, parentGranted: Authority, childRequested: Authority): Authority` — consumed by Task 9's decision combinator.

- [ ] **Step 1: Write the failing test**

```ts
// src/engines/authority.test.ts
import { describe, it, expect } from 'vitest';
import { effectiveAuthority } from './authority.js';
import type { Authority } from '../schemas/node-contract.js';

const full: Authority = { tools: ['git', 'shell', 'web'], spawn_children: true, max_child_count: 5, budget_usd: 10 };

describe('effectiveAuthority', () => {
  it('intersects tools across all three levels', () => {
    const result = effectiveAuthority(
      full,
      { ...full, tools: ['git', 'shell'] },
      { ...full, tools: ['git', 'web'] },
    );
    expect(result.tools).toEqual(['git']);
  });

  it('spawn_children is true only if all three levels allow it', () => {
    expect(effectiveAuthority(full, { ...full, spawn_children: false }, full).spawn_children).toBe(false);
    expect(effectiveAuthority(full, full, full).spawn_children).toBe(true);
  });

  it('takes the minimum of max_child_count across all three levels', () => {
    const result = effectiveAuthority(
      { ...full, max_child_count: 3 },
      { ...full, max_child_count: 5 },
      { ...full, max_child_count: 10 },
    );
    expect(result.max_child_count).toBe(3);
  });

  it('takes the minimum of budget_usd across all three levels', () => {
    const result = effectiveAuthority(
      { ...full, budget_usd: 2 },
      { ...full, budget_usd: 10 },
      { ...full, budget_usd: 5 },
    );
    expect(result.budget_usd).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- authority.test`
Expected: FAIL — `Cannot find module './authority'`.

- [ ] **Step 3: Write `engines/authority.ts`**

```ts
// src/engines/authority.ts
import type { Authority } from '../schemas/node-contract.js';

// Doc §8's formula intersects capability/sandbox terms too — neither exists as a
// concrete signal anywhere in the codebase yet (no adapter reports capabilities,
// no sandbox-scope type exists), so this implements the three terms that are
// real today. Add the other two intersections here, not as a new function,
// once Phase 5's adapter capability-reporting lands.
export function effectiveAuthority(
  platformMax: Authority,
  parentGranted: Authority,
  childRequested: Authority,
): Authority {
  return {
    tools: childRequested.tools.filter(
      (tool) => platformMax.tools.includes(tool) && parentGranted.tools.includes(tool),
    ),
    spawn_children: platformMax.spawn_children && parentGranted.spawn_children && childRequested.spawn_children,
    max_child_count: Math.min(platformMax.max_child_count, parentGranted.max_child_count, childRequested.max_child_count),
    budget_usd: Math.min(platformMax.budget_usd, parentGranted.budget_usd, childRequested.budget_usd),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- authority.test`
Expected: PASS — 5 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/engines/authority.ts src/engines/authority.test.ts
git commit -m "feat: add authority engine (three-way intersection)"
```

---

### Task 7: Economics engine

**Files:**
- Create: `src/engines/economics.ts`
- Test: `src/engines/economics.test.ts`

**Interfaces:**
- Produces: `interface EconomicsInput`, `interface EconomicsResult`, `scoreDelegation(input: EconomicsInput): EconomicsResult` — consumed by Task 9's decision combinator.

- [ ] **Step 1: Write the failing test**

```ts
// src/engines/economics.test.ts
import { describe, it, expect } from 'vitest';
import { scoreDelegation } from './economics.js';

describe('scoreDelegation', () => {
  it('computes score as value minus total cost minus risk', () => {
    const result = scoreDelegation({
      estimatedValue: 1, modelCost: 0.1, latencyCost: 0.1,
      coordinationCost: 0.1, verificationCost: 0.1, riskPenalty: 0.1, threshold: 0.3,
    });
    expect(result.score).toBeCloseTo(0.5, 5); // 1 - 0.4 - 0.1
  });

  it('recommends delegation when score meets or exceeds the threshold', () => {
    const result = scoreDelegation({
      estimatedValue: 1, modelCost: 0, latencyCost: 0, coordinationCost: 0,
      verificationCost: 0, riskPenalty: 0, threshold: 0.5,
    });
    expect(result.score).toBe(1);
    expect(result.delegate).toBe(true);
  });

  it('recommends against delegation when score falls short of the threshold', () => {
    const result = scoreDelegation({
      estimatedValue: 0.2, modelCost: 0.1, latencyCost: 0.1, coordinationCost: 0.1,
      verificationCost: 0.1, riskPenalty: 0, threshold: 0.3,
    });
    expect(result.delegate).toBe(false);
  });

  it('returns the full input as the breakdown, for audit', () => {
    const input = { estimatedValue: 1, modelCost: 0.1, latencyCost: 0.1, coordinationCost: 0.1, verificationCost: 0.1, riskPenalty: 0, threshold: 0.3 };
    const result = scoreDelegation(input);
    expect(result.breakdown).toEqual(input);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- economics.test`
Expected: FAIL — `Cannot find module './economics'`.

- [ ] **Step 3: Write `engines/economics.ts`**

```ts
// src/engines/economics.ts

export interface EconomicsInput {
  estimatedValue: number;
  modelCost: number;
  latencyCost: number;
  coordinationCost: number;
  verificationCost: number;
  riskPenalty: number;
  threshold: number;
}

export interface EconomicsResult {
  score: number;
  delegate: boolean;
  breakdown: EconomicsInput;
}

// Doc §10's formula, verbatim:
//   score = estimated_value - (model + latency + coordination + verification) - risk
//   delegate if score >= threshold
// Every term is printable via `breakdown` — the point of this being a formula
// instead of an LLM judgment call (D28) is that `org decision` can show exactly
// why, not just what.
export function scoreDelegation(input: EconomicsInput): EconomicsResult {
  const totalCost = input.modelCost + input.latencyCost + input.coordinationCost + input.verificationCost;
  const score = input.estimatedValue - totalCost - input.riskPenalty;
  return { score, delegate: score >= input.threshold, breakdown: input };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- economics.test`
Expected: PASS — 4 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/engines/economics.ts src/engines/economics.test.ts
git commit -m "feat: add economics engine implementing the weighted-heuristic formula"
```

---

### Task 8: Intelligence coordinator (cheap-default path)

**Files:**
- Create: `src/intelligence/coordinator.ts`
- Test: `src/intelligence/coordinator.test.ts`

**Interfaces:**
- Produces: `interface IntelligenceBundle`, `assessUncertainty(input: { goal: string }): IntelligenceBundle` — consumed by Task 10's `INTELLIGENCE_GATE` wiring and Task 9's decision combinator (via `complexity`).

- [ ] **Step 1: Write the failing test**

```ts
// src/intelligence/coordinator.test.ts
import { describe, it, expect } from 'vitest';
import { assessUncertainty } from './coordinator.js';

describe('assessUncertainty', () => {
  it('classifies a short goal as low complexity', () => {
    expect(assessUncertainty({ goal: 'fix typo' }).complexity).toBe('low');
  });

  it('classifies a long, detailed goal as high complexity', () => {
    const goal = 'Implement a full OAuth2 login flow integrating Google and GitHub providers, add refresh-token rotation, migrate the existing session store, and write end-to-end tests covering token expiry.';
    expect(assessUncertainty({ goal }).complexity).toBe('high');
  });

  it('always reports sufficient context for v0.1 (no evidence workers exist yet)', () => {
    expect(assessUncertainty({ goal: 'anything' }).sufficientContext).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- coordinator.test`
Expected: FAIL — `Cannot find module './coordinator'`.

- [ ] **Step 3: Write `intelligence/coordinator.ts`**

```ts
// src/intelligence/coordinator.ts

export interface IntelligenceBundle {
  sufficientContext: boolean;
  complexity: 'low' | 'medium' | 'high';
}

// Doc §6: "intelligence proportional to uncertainty" — no Evidence/Capability/
// Runtime-Intelligence workers exist yet (that's the rest of the Intelligence
// Plane, later phases), so this is deliberately only the "low uncertainty ->
// cheap local default" leg. sufficientContext is always true for v0.1: there is
// no research step to wait on, so INTELLIGENCE_GATE never has a reason to loop
// back to PLAN yet. complexity is a real, if crude, signal — goal length as a
// proxy — that Task 9 uses to pick default economics inputs.
export function assessUncertainty(input: { goal: string }): IntelligenceBundle {
  const complexity = input.goal.length > 150 ? 'high' : input.goal.length > 50 ? 'medium' : 'low';
  return { sufficientContext: true, complexity };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- coordinator.test`
Expected: PASS — 3 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/intelligence/coordinator.ts src/intelligence/coordinator.test.ts
git commit -m "feat: add intelligence coordinator cheap-default path"
```

---

### Task 9: Decision combinator (authority + economics + escalation rule)

**Files:**
- Create: `src/engines/decide-execution.ts`
- Test: `src/engines/decide-execution.test.ts`

**Interfaces:**
- Consumes: `effectiveAuthority` (Task 6), `scoreDelegation` (Task 7), `Authority` type.
- Produces: `interface DecideExecutionInput`, `decideExecution(input: DecideExecutionInput): { outcome: DecisionOutcome; breakdown: Record<string, number> }` — consumed by Task 11's `EXECUTION_DECISION` wiring.

This is the piece that makes the three-way branch (SELF_EXECUTE / DELEGATE / ESCALATE) a single, pure, fully-tested decision — not logic buried inside the XState wiring where it would be hard to unit test in isolation.

- [ ] **Step 1: Write the failing test**

```ts
// src/engines/decide-execution.test.ts
import { describe, it, expect } from 'vitest';
import { decideExecution, CHILD_BUDGET_USD } from './decide-execution.js';
import type { Authority } from '../schemas/node-contract.js';

const cannotSpawn: Authority = { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 5 };
const canSpawnRichBudget: Authority = { tools: [], spawn_children: true, max_child_count: 3, budget_usd: 10 };
const canSpawnPoorBudget: Authority = { tools: [], spawn_children: true, max_child_count: 3, budget_usd: 0.01 };

describe('decideExecution', () => {
  it('self-executes unconditionally when the node cannot spawn children', () => {
    const result = decideExecution({ goal: 'a very very very long and complex goal '.repeat(10), authority: cannotSpawn, complexity: 'high' });
    expect(result.outcome).toBe('SELF_EXECUTE');
  });

  it('escalates when spawning is allowed but the budget cannot cover a child', () => {
    const result = decideExecution({ goal: 'anything', authority: canSpawnPoorBudget, complexity: 'high' });
    expect(result.outcome).toBe('ESCALATE');
    expect(canSpawnPoorBudget.budget_usd).toBeLessThan(CHILD_BUDGET_USD);
  });

  it('delegates a high-complexity goal when spawning and budget both allow it', () => {
    const result = decideExecution({ goal: 'x'.repeat(200), authority: canSpawnRichBudget, complexity: 'high' });
    expect(result.outcome).toBe('DELEGATE');
  });

  it('self-executes a low-complexity goal even when spawning is allowed', () => {
    const result = decideExecution({ goal: 'fix typo', authority: canSpawnRichBudget, complexity: 'low' });
    expect(result.outcome).toBe('SELF_EXECUTE');
  });

  it('always returns a printable breakdown, even for the cannot-spawn short-circuit', () => {
    const result = decideExecution({ goal: 'x', authority: cannotSpawn, complexity: 'low' });
    expect(typeof result.breakdown.score).toBe('number');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- decide-execution.test`
Expected: FAIL — `Cannot find module './decide-execution'`.

- [ ] **Step 3: Write `engines/decide-execution.ts`**

```ts
// src/engines/decide-execution.ts
import { scoreDelegation, type EconomicsInput } from './economics.js';
import type { Authority } from '../schemas/node-contract.js';
import type { DecisionOutcome } from '../schemas/decision.js';

export interface DecideExecutionInput {
  goal: string;
  authority: Authority;
  complexity: 'low' | 'medium' | 'high';
}

export interface DecideExecutionResult {
  outcome: DecisionOutcome;
  breakdown: Record<string, number>;
}

// v0.1 has no per-goal cost estimation or historical data (that's Phase 5's
// organizational memory closing the loop described in doc §10) — these are
// the documented conservative defaults the spec calls for until real signals
// exist. The constants exist so the formula has real numbers to run and
// persist today, not because they're calibrated; recalibrate from real
// outcomes once Phase 5 lands, not by guessing better constants now.
const COST_BY_COMPLEXITY: Record<DecideExecutionInput['complexity'], number> = { low: 0.05, medium: 0.3, high: 0.8 };
const THRESHOLD = 0.3;
export const CHILD_BUDGET_USD = 1;

function defaultEconomicsInput(complexity: DecideExecutionInput['complexity']): EconomicsInput {
  const modelCost = COST_BY_COMPLEXITY[complexity];
  return {
    estimatedValue: 1,
    modelCost,
    latencyCost: modelCost * 0.5,
    coordinationCost: 0.15,
    verificationCost: 0.1,
    riskPenalty: complexity === 'high' ? 0.3 : 0,
    threshold: THRESHOLD,
  };
}

export function decideExecution(input: DecideExecutionInput): DecideExecutionResult {
  if (!input.authority.spawn_children) {
    return { outcome: 'SELF_EXECUTE', breakdown: { score: 0, reason_no_spawn_authority: 1 } };
  }

  const economics = scoreDelegation(defaultEconomicsInput(input.complexity));
  if (!economics.delegate) {
    return { outcome: 'SELF_EXECUTE', breakdown: economics.breakdown as unknown as Record<string, number> };
  }

  if (input.authority.budget_usd < CHILD_BUDGET_USD) {
    return {
      outcome: 'ESCALATE',
      breakdown: { ...economics.breakdown, requiredBudget: CHILD_BUDGET_USD, availableBudget: input.authority.budget_usd } as unknown as Record<string, number>,
    };
  }

  return { outcome: 'DELEGATE', breakdown: economics.breakdown as unknown as Record<string, number> };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- decide-execution.test`
Expected: PASS — 5 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/engines/decide-execution.ts src/engines/decide-execution.test.ts
git commit -m "feat: add decide-execution combinator (authority + economics + escalation rule)"
```

---

### Task 10: Wire `INTELLIGENCE_GATE` as an invoked actor

**Files:**
- Modify: `src/lifecycle/node-machine.ts`, `src/lifecycle/node-machine.test.ts`, `src/lifecycle/node-actor-manager.ts`

**Interfaces:**
- Consumes: `assessUncertainty` (Task 8).
- Produces: `NodeMachineContext` gains `complexity?: 'low' | 'medium' | 'high'`; `INTELLIGENCE_GATE` no longer accepts `CONTEXT_SUFFICIENT`/`CONTEXT_INSUFFICIENT` events — it resolves itself.

- [ ] **Step 1: Update `node-machine.test.ts`'s existing tests to drop the now-removed manual events**

The `CONTEXT_SUFFICIENT`/`CONTEXT_INSUFFICIENT` events go away entirely — `INTELLIGENCE_GATE` always resolves via the invoked actor now. Rewrite every test that sends them.

```ts
// src/lifecycle/node-machine.test.ts — replace the whole file
import { describe, it, expect, vi } from 'vitest';
import { createActor, fromPromise } from 'xstate';
import { nodeMachine } from './node-machine.js';

function machineWithMocks(overrides: {
  assessUncertainty?: { sufficientContext: boolean; complexity: 'low' | 'medium' | 'high' };
  executeStep?: { succeeded: boolean };
} = {}) {
  return nodeMachine.provide({
    actors: {
      assessUncertainty: fromPromise(async () => overrides.assessUncertainty ?? { sufficientContext: true, complexity: 'low' }),
      executeStep: fromPromise(async () => overrides.executeStep ?? { succeeded: true, message: 'ok', events: [] }),
    },
  });
}

describe('nodeMachine', () => {
  it('starts in CREATED and auto-progresses through ORIENT/PLAN/INTELLIGENCE_GATE to EXECUTION_DECISION on START', async () => {
    const actor = createActor(machineWithMocks(), { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    expect(actor.getSnapshot().value).toBe('CREATED');
    actor.send({ type: 'START' });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('EXECUTION_DECISION'));
  });

  it('loops back to PLAN when the coordinator reports insufficient context', async () => {
    const actor = createActor(machineWithMocks({ assessUncertainty: { sufficientContext: false, complexity: 'low' } }), { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    actor.send({ type: 'START' });
    // PLAN -> INTELLIGENCE_GATE -> (insufficient) -> PLAN is a real loop; assert it
    // settles back into INTELLIGENCE_GATE rather than asserting the transient PLAN tick.
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('INTELLIGENCE_GATE'));
  });

  it('carries complexity into context from the coordinator', async () => {
    const actor = createActor(machineWithMocks({ assessUncertainty: { sufficientContext: true, complexity: 'high' } }), { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    actor.send({ type: 'START' });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('EXECUTION_DECISION'));
    expect(actor.getSnapshot().context.complexity).toBe('high');
  });

  it('reaches COMPLETE via SELF_EXECUTE -> VERIFY -> DOD_MET when execution succeeds', async () => {
    const actor = createActor(machineWithMocks({ executeStep: { succeeded: true } }), { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    actor.send({ type: 'START' });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('EXECUTION_DECISION'));
    actor.send({ type: 'SELF_EXECUTE' });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('VERIFY'));
    actor.send({ type: 'DOD_MET' });
    expect(actor.getSnapshot().value).toBe('COMPLETE');
  });

  it('re-plans when DoD is not met after verification', async () => {
    const actor = createActor(machineWithMocks(), { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    actor.send({ type: 'START' });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('EXECUTION_DECISION'));
    actor.send({ type: 'SELF_EXECUTE' });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('VERIFY'));
    actor.send({ type: 'DOD_NOT_MET' });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('EXECUTION_DECISION'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- node-machine.test`
Expected: FAIL — `assessUncertainty` isn't a declared actor yet; `INTELLIGENCE_GATE` still waits on the removed events.

- [ ] **Step 3: Update `node-machine.ts`**

```ts
// src/lifecycle/node-machine.ts
import { setup, fromPromise, assign } from 'xstate';
import type { ExecuteStepResult } from '../execution/execute-step.js';
import type { IntelligenceBundle } from '../intelligence/coordinator.js';

export interface NodeMachineContext {
  nodeId: string;
  goal: string;
  complexity?: 'low' | 'medium' | 'high';
  lastResult?: ExecuteStepResult;
}

export type NodeMachineEvent =
  | { type: 'START' }
  | { type: 'SELF_EXECUTE' }
  | { type: 'DELEGATE' }
  | { type: 'DOD_MET' }
  | { type: 'DOD_NOT_MET' };

export const nodeMachine = setup({
  types: {
    context: {} as NodeMachineContext,
    events: {} as NodeMachineEvent,
    input: {} as NodeMachineContext,
  },
  actors: {
    executeStep: fromPromise<ExecuteStepResult, { nodeId: string; goal: string }>(async () => {
      throw new Error('executeStep actor not provided');
    }),
    assessUncertainty: fromPromise<IntelligenceBundle, { goal: string }>(async () => {
      throw new Error('assessUncertainty actor not provided');
    }),
  },
}).createMachine({
  id: 'accountableNode',
  context: ({ input }) => input,
  initial: 'CREATED',
  states: {
    CREATED: { on: { START: 'ORIENT' } },
    ORIENT: { always: 'PLAN' },
    PLAN: { always: 'INTELLIGENCE_GATE' },
    INTELLIGENCE_GATE: {
      invoke: {
        src: 'assessUncertainty',
        input: ({ context }) => ({ goal: context.goal }),
        onDone: [
          {
            target: 'EXECUTION_DECISION',
            guard: ({ event }) => event.output.sufficientContext,
            actions: assign({ complexity: ({ event }) => event.output.complexity }),
          },
          { target: 'PLAN', actions: assign({ complexity: ({ event }) => event.output.complexity }) },
        ],
      },
    },
    EXECUTION_DECISION: {
      on: {
        SELF_EXECUTE: 'SELF_EXECUTE',
        DELEGATE: 'DELEGATE',
      },
    },
    SELF_EXECUTE: {
      invoke: {
        src: 'executeStep',
        input: ({ context }) => ({ nodeId: context.nodeId, goal: context.goal }),
        onDone: { target: 'VERIFY', actions: assign({ lastResult: ({ event }) => event.output }) },
        onError: {
          target: 'VERIFY',
          actions: assign({ lastResult: ({ event }) => ({ succeeded: false, message: String(event.error), events: [] }) }),
        },
      },
    },
    DELEGATE: { always: 'VERIFY' },
    VERIFY: {
      on: {
        DOD_MET: 'COMPLETE',
        DOD_NOT_MET: 'EXECUTION_DECISION',
      },
    },
    COMPLETE: { type: 'final' },
  },
});
```

Note: `EXECUTION_DECISION` is still externally-driven (`on: { SELF_EXECUTE, DELEGATE }`) in this task — Task 11 converts it to an invoked actor too, in its own commit, so this task's diff stays reviewable on its own. `DOD_NOT_MET` now re-plans back to `EXECUTION_DECISION` rather than `INTELLIGENCE_GATE`, since re-running the (currently free) intelligence gate on every retry is wasted work once it's a real invoked step.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- node-machine.test`
Expected: PASS — 5 tests passed.

- [ ] **Step 5: Update `node-actor-manager.ts` to provide the real `assessUncertainty` actor**

```ts
// src/lifecycle/node-actor-manager.ts — add the import and the actor entry
import { assessUncertainty } from '../intelligence/coordinator.js';

function productionMachine(db: Db, nodeId: string) {
  return nodeMachine.provide({
    actors: {
      assessUncertainty: fromPromise(async ({ input }) => assessUncertainty(input)),
      executeStep: fromPromise(async ({ input }) => {
        // ... unchanged from Phase 2/Task 3 ...
      }),
    },
  });
}
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS — including the existing `node-actor-manager.test.ts`, which drives the machine via `START` and now needs to wait for the async `assessUncertainty` invoke to settle before asserting state; if that test currently asserts synchronously right after `startNodeActor`, update it to `await vi.waitFor(...)` the same way Task 10's own tests do.

- [ ] **Step 7: Commit**

```bash
git add src/lifecycle
git commit -m "feat: wire INTELLIGENCE_GATE to the intelligence coordinator as an invoked actor"
```

---

### Task 11: Wire `EXECUTION_DECISION` as an invoked actor, add `ESCALATE`

**Files:**
- Modify: `src/lifecycle/node-machine.ts`, `src/lifecycle/node-machine.test.ts`, `src/lifecycle/node-actor-manager.ts`

**Interfaces:**
- Consumes: `decideExecution` (Task 9), `insertDecision` (Task 5).
- Produces: a new `ESCALATE` state (terminal for now — Task 16 in Phase 4 gives it a real `WAIT_APPROVAL` follow-up); `EXECUTION_DECISION` resolves itself instead of waiting for `SELF_EXECUTE`/`DELEGATE` events.

- [ ] **Step 1: Extend `node-machine.test.ts`**

```ts
// src/lifecycle/node-machine.test.ts — update machineWithMocks and add tests
function machineWithMocks(overrides: {
  assessUncertainty?: { sufficientContext: boolean; complexity: 'low' | 'medium' | 'high' };
  executeStep?: { succeeded: boolean };
  decideExecution?: { outcome: 'SELF_EXECUTE' | 'DELEGATE' | 'ESCALATE'; breakdown: Record<string, number> };
} = {}) {
  return nodeMachine.provide({
    actors: {
      assessUncertainty: fromPromise(async () => overrides.assessUncertainty ?? { sufficientContext: true, complexity: 'low' }),
      decideExecution: fromPromise(async () => overrides.decideExecution ?? { outcome: 'SELF_EXECUTE', breakdown: {} }),
      executeStep: fromPromise(async () => overrides.executeStep ?? { succeeded: true, message: 'ok', events: [] }),
      delegateToChild: fromPromise(async () => ({ succeeded: true, message: 'ok', events: [] })),
    },
  });
}

// Replace the two tests that used to send SELF_EXECUTE/DELEGATE manually:
it('reaches COMPLETE via an auto-decided SELF_EXECUTE -> VERIFY -> DOD_MET', async () => {
  const actor = createActor(machineWithMocks({ decideExecution: { outcome: 'SELF_EXECUTE', breakdown: {} }, executeStep: { succeeded: true } }), { input: { nodeId: 'n1', goal: 'test' } });
  actor.start();
  actor.send({ type: 'START' });
  await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('VERIFY'));
  actor.send({ type: 'DOD_MET' });
  expect(actor.getSnapshot().value).toBe('COMPLETE');
});

it('re-plans by re-running EXECUTION_DECISION when DoD is not met', async () => {
  const actor = createActor(machineWithMocks(), { input: { nodeId: 'n1', goal: 'test' } });
  actor.start();
  actor.send({ type: 'START' });
  await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('VERIFY'));
  actor.send({ type: 'DOD_NOT_MET' });
  await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('VERIFY')); // decided again, executed again, landed back in VERIFY
});

it('transitions to ESCALATE when the decision combinator says so', async () => {
  const actor = createActor(machineWithMocks({ decideExecution: { outcome: 'ESCALATE', breakdown: { requiredBudget: 1, availableBudget: 0.01 } } }), { input: { nodeId: 'n1', goal: 'test' } });
  actor.start();
  actor.send({ type: 'START' });
  await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('ESCALATE'));
});

it('transitions to DELEGATE and awaits the child, landing in VERIFY', async () => {
  const actor = createActor(machineWithMocks({ decideExecution: { outcome: 'DELEGATE', breakdown: {} } }), { input: { nodeId: 'n1', goal: 'test' } });
  actor.start();
  actor.send({ type: 'START' });
  await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('VERIFY'));
});
```

Remove the old tests that manually sent `SELF_EXECUTE`/`DELEGATE` — those events no longer exist on `NodeMachineEvent`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- node-machine.test`
Expected: FAIL — `decideExecution`/`delegateToChild` aren't declared actors; `ESCALATE` state doesn't exist.

- [ ] **Step 3: Update `node-machine.ts`**

```ts
// src/lifecycle/node-machine.ts
import { setup, fromPromise, assign } from 'xstate';
import type { ExecuteStepResult } from '../execution/execute-step.js';
import type { IntelligenceBundle } from '../intelligence/coordinator.js';
import type { DecideExecutionResult } from '../engines/decide-execution.js';

export interface NodeMachineContext {
  nodeId: string;
  goal: string;
  complexity?: 'low' | 'medium' | 'high';
  lastDecision?: DecideExecutionResult;
  lastResult?: ExecuteStepResult;
}

// SELF_EXECUTE/DELEGATE are gone from the event union — the machine decides
// these itself now via the invoked `decideExecution` actor.
export type NodeMachineEvent =
  | { type: 'START' }
  | { type: 'DOD_MET' }
  | { type: 'DOD_NOT_MET' };

export const nodeMachine = setup({
  types: {
    context: {} as NodeMachineContext,
    events: {} as NodeMachineEvent,
    input: {} as NodeMachineContext,
  },
  actors: {
    executeStep: fromPromise<ExecuteStepResult, { nodeId: string; goal: string }>(async () => {
      throw new Error('executeStep actor not provided');
    }),
    assessUncertainty: fromPromise<IntelligenceBundle, { goal: string }>(async () => {
      throw new Error('assessUncertainty actor not provided');
    }),
    decideExecution: fromPromise<DecideExecutionResult, { goal: string; complexity: NodeMachineContext['complexity'] }>(async () => {
      throw new Error('decideExecution actor not provided');
    }),
    delegateToChild: fromPromise<ExecuteStepResult, { nodeId: string; goal: string }>(async () => {
      throw new Error('delegateToChild actor not provided');
    }),
  },
}).createMachine({
  id: 'accountableNode',
  context: ({ input }) => input,
  initial: 'CREATED',
  states: {
    CREATED: { on: { START: 'ORIENT' } },
    ORIENT: { always: 'PLAN' },
    PLAN: { always: 'INTELLIGENCE_GATE' },
    INTELLIGENCE_GATE: {
      invoke: {
        src: 'assessUncertainty',
        input: ({ context }) => ({ goal: context.goal }),
        onDone: [
          {
            target: 'EXECUTION_DECISION',
            guard: ({ event }) => event.output.sufficientContext,
            actions: assign({ complexity: ({ event }) => event.output.complexity }),
          },
          { target: 'PLAN', actions: assign({ complexity: ({ event }) => event.output.complexity }) },
        ],
      },
    },
    EXECUTION_DECISION: {
      invoke: {
        src: 'decideExecution',
        input: ({ context }) => ({ goal: context.goal, complexity: context.complexity }),
        onDone: [
          { target: 'SELF_EXECUTE', guard: ({ event }) => event.output.outcome === 'SELF_EXECUTE', actions: assign({ lastDecision: ({ event }) => event.output }) },
          { target: 'DELEGATE', guard: ({ event }) => event.output.outcome === 'DELEGATE', actions: assign({ lastDecision: ({ event }) => event.output }) },
          { target: 'ESCALATE', actions: assign({ lastDecision: ({ event }) => event.output }) },
        ],
      },
    },
    SELF_EXECUTE: {
      invoke: {
        src: 'executeStep',
        input: ({ context }) => ({ nodeId: context.nodeId, goal: context.goal }),
        onDone: { target: 'VERIFY', actions: assign({ lastResult: ({ event }) => event.output }) },
        onError: {
          target: 'VERIFY',
          actions: assign({ lastResult: ({ event }) => ({ succeeded: false, message: String(event.error), events: [] }) }),
        },
      },
    },
    DELEGATE: {
      invoke: {
        src: 'delegateToChild',
        input: ({ context }) => ({ nodeId: context.nodeId, goal: context.goal }),
        onDone: { target: 'VERIFY', actions: assign({ lastResult: ({ event }) => event.output }) },
        onError: {
          target: 'VERIFY',
          actions: assign({ lastResult: ({ event }) => ({ succeeded: false, message: String(event.error), events: [] }) }),
        },
      },
    },
    // Phase 4 Task 16 replaces this with a real WAIT_APPROVAL follow-up.
    ESCALATE: { type: 'final' },
    VERIFY: {
      on: {
        DOD_MET: 'COMPLETE',
        DOD_NOT_MET: 'EXECUTION_DECISION',
      },
    },
    COMPLETE: { type: 'final' },
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- node-machine.test`
Expected: PASS.

- [ ] **Step 5: Update `node-actor-manager.ts` to provide `decideExecution`, persisting each decision**

```ts
// src/lifecycle/node-actor-manager.ts — add imports and the actor entry
import { randomUUID } from 'node:crypto';
import { decideExecution } from '../engines/decide-execution.js';
import { insertDecision } from '../db/queries/decisions.js';
import { getNode } from '../db/queries/nodes.js';

function productionMachine(db: Db, nodeId: string) {
  return nodeMachine.provide({
    actors: {
      assessUncertainty: fromPromise(async ({ input }) => assessUncertainty(input)),
      decideExecution: fromPromise(async ({ input }) => {
        const node = getNode(db, nodeId);
        if (!node) throw new Error(`Node ${nodeId} not found when deciding execution`);
        const result = decideExecution({
          goal: input.goal,
          authority: node.contract.authority,
          complexity: input.complexity ?? 'low',
        });
        insertDecision(db, {
          id: randomUUID(), nodeId, type: 'execution_decision',
          outcome: result.outcome, breakdown: result.breakdown,
          createdAt: new Date().toISOString(),
        });
        return result;
      }),
      // delegateToChild is wired in Task 12, once it exists.
      executeStep: fromPromise(async ({ input }) => {
        // ... unchanged ...
      }),
    },
  });
}
```

(`delegateToChild`'s production wiring is added in Task 12 — leaving it unprovided here would throw the placeholder's error if a test somehow reached `DELEGATE` before Task 12, which is intentional: it should fail loudly, not silently no-op.)

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lifecycle
git commit -m "feat: wire EXECUTION_DECISION to the decide-execution combinator, add ESCALATE"
```

---

### Task 12: Real `DELEGATE` — child node creation, wait, and handoff

**Files:**
- Create: `src/lifecycle/delegate-child.ts`
- Modify: `src/lifecycle/node-actor-manager.ts`
- Test: `src/lifecycle/delegate-child.test.ts`

**Interfaces:**
- Consumes: `insertNode`, `getNode` (Phase 1), `insertCommitment` (Task 4), `effectiveAuthority` (Task 6), `startNodeActor` (Phase 1/2, extended here to return a completion promise).
- Produces: `interface DelegateInput`, `delegateToChild(input: DelegateInput, deps?: Partial<DelegateDeps>): Promise<ExecuteStepResult>` — consumed by Task 11's `DELEGATE` wiring (now given its real implementation instead of the placeholder that throws).

- [ ] **Step 1: Add `waitForNodeCompletion` to `node-actor-manager.ts` first (delegate-child depends on it)**

```ts
// src/lifecycle/node-actor-manager.ts — add this export
import { waitFor } from 'xstate';

export async function waitForNodeCompletion(nodeId: string, timeoutMs = 300_000): Promise<{ succeeded: boolean }> {
  const actor = actors.get(nodeId);
  if (!actor) throw new Error(`No active actor for node ${nodeId}`);
  await waitFor(actor, (snapshot) => snapshot.status === 'done', { timeout: timeoutMs });
  const context = actor.getSnapshot().context;
  return { succeeded: context.lastResult?.succeeded ?? false };
}
```

- [ ] **Step 2: Write the failing test for `delegate-child.ts`, using injected fakes (same pattern as `execute-step.test.ts`)**

```ts
// src/lifecycle/delegate-child.test.ts
import { describe, it, expect, vi } from 'vitest';
import { delegateToChild } from './delegate-child.js';

describe('delegateToChild', () => {
  it('creates a child node with a budget carved from the parent, then awaits it', async () => {
    const calls: string[] = [];
    const deps = {
      createChildNode: vi.fn((parentId: string, goal: string, budgetUsd: number) => {
        calls.push(`create:${parentId}:${budgetUsd}`);
        return 'child-1';
      }),
      recordCommitment: vi.fn((childId: string, goal: string) => { calls.push(`commit:${childId}`); }),
      startChild: vi.fn((childId: string, goal: string) => { calls.push(`start:${childId}`); }),
      waitForChild: vi.fn(async (childId: string) => { calls.push(`wait:${childId}`); return { succeeded: true }; }),
    };

    const result = await delegateToChild({ parentId: 'n1', goal: 'delegated goal', childBudgetUsd: 1 }, deps);

    expect(result.succeeded).toBe(true);
    expect(calls).toEqual(['create:n1:1', 'commit:child-1', 'start:child-1', 'wait:child-1']);
  });

  it('reports failure when the child does not succeed', async () => {
    const deps = {
      createChildNode: vi.fn(() => 'child-1'),
      recordCommitment: vi.fn(() => {}),
      startChild: vi.fn(() => {}),
      waitForChild: vi.fn(async () => ({ succeeded: false })),
    };

    const result = await delegateToChild({ parentId: 'n1', goal: 'delegated goal', childBudgetUsd: 1 }, deps);
    expect(result.succeeded).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- delegate-child.test`
Expected: FAIL — `Cannot find module './delegate-child'`.

- [ ] **Step 4: Write `lifecycle/delegate-child.ts`**

```ts
// src/lifecycle/delegate-child.ts
import type { ExecuteStepResult } from '../execution/execute-step.js';

export interface DelegateInput {
  parentId: string;
  goal: string;
  childBudgetUsd: number;
}

export interface DelegateChildDeps {
  createChildNode: (parentId: string, goal: string, budgetUsd: number) => string;
  recordCommitment: (childId: string, goal: string) => void;
  startChild: (childId: string, goal: string) => void;
  waitForChild: (childId: string) => Promise<{ succeeded: boolean }>;
}

export async function delegateToChild(
  input: DelegateInput,
  deps: DelegateChildDeps,
): Promise<ExecuteStepResult> {
  const childId = deps.createChildNode(input.parentId, input.goal, input.childBudgetUsd);
  deps.recordCommitment(childId, input.goal);
  deps.startChild(childId, input.goal);
  const result = await deps.waitForChild(childId);
  return {
    succeeded: result.succeeded,
    message: result.succeeded ? `Child ${childId} completed` : `Child ${childId} did not succeed`,
    events: [],
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- delegate-child.test`
Expected: PASS — 2 tests passed.

- [ ] **Step 6: Wire the real dependencies into `node-actor-manager.ts`**

```ts
// src/lifecycle/node-actor-manager.ts — add imports and the delegateToChild actor
import { randomUUID } from 'node:crypto';
import { delegateToChild, type DelegateChildDeps } from './delegate-child.js';
import { insertNode, getNode } from '../db/queries/nodes.js';
import { insertCommitment } from '../db/queries/commitments.js';
import { effectiveAuthority } from '../engines/authority.js';
import { CHILD_BUDGET_USD } from '../engines/decide-execution.js';

function realDelegateDeps(db: Db): DelegateChildDeps {
  return {
    createChildNode: (parentId, goal, budgetUsd) => {
      const parent = getNode(db, parentId);
      if (!parent) throw new Error(`Parent node ${parentId} not found`);
      const id = randomUUID();
      const now = new Date().toISOString();
      const childAuthority = effectiveAuthority(
        parent.contract.authority, parent.contract.authority,
        { ...parent.contract.authority, budget_usd: budgetUsd },
      );
      insertNode(db, {
        id, parentId, goal,
        contract: { ...parent.contract, goal, authority: childAuthority },
        state: 'CREATED', createdAt: now, updatedAt: now,
      });
      return id;
    },
    recordCommitment: (childId, goal) => {
      insertCommitment(db, {
        id: randomUUID(), owner: childId, goal, definition_of_done: [goal],
        status: 'pending', created_at: new Date().toISOString(),
        dependencies: [], evidence: [], risks: [],
      }, new Date().toISOString());
    },
    startChild: (childId, goal) => startNodeActor(db, childId, goal),
    waitForChild: (childId) => waitForNodeCompletion(childId),
  };
}

function productionMachine(db: Db, nodeId: string) {
  return nodeMachine.provide({
    actors: {
      // ... assessUncertainty, decideExecution, executeStep unchanged ...
      delegateToChild: fromPromise(async ({ input }) =>
        delegateToChild({ parentId: nodeId, goal: input.goal, childBudgetUsd: CHILD_BUDGET_USD }, realDelegateDeps(db)),
      ),
    },
  });
}
```

Note the platform-max argument to `effectiveAuthority` here is the parent's own authority twice (as both platform-max and parent-granted) — there's no separate platform-policy concept yet in the codebase (doc §8 describes it, nothing implements it), so this is the same "implement the real terms, note the missing one" pattern as Task 6 itself.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lifecycle src/db/queries/nodes.ts
git commit -m "feat: real DELEGATE — child node creation, commitment, wait, and handoff"
```

---

### Task 13: Phase 3 exit — full autonomous-loop integration test

**Files:**
- Create: `src/lifecycle/autonomous-loop.integration.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–12, plus Phase 2's real K8s dispatch.
- Produces: no new exports — this is the proof this phase's own goal is met, run against the real cluster.

- [ ] **Step 1: Write the test**

```ts
// src/lifecycle/autonomous-loop.integration.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { waitFor } from 'xstate';
import { createDb } from '../db/client.js';
import { insertNode } from '../db/queries/nodes.js';
import { startNodeActor, getNodeActor, waitForNodeCompletion } from './node-actor-manager.js';
import { listDecisionsForNode } from '../db/queries/decisions.js';
import { isClusterAvailable } from '../k8s/kind.js';

const TEST_DB = './test-autonomous-loop.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

const CLUSTER_AVAILABLE = await isClusterAvailable();
if (!CLUSTER_AVAILABLE) console.log('no cluster — skipping autonomous-loop integration test');

// This is what Phase 2's own memory note flagged as blocked: "org run reaching
// SELF_EXECUTE end-to-end — the CLI stops at INTELLIGENCE_GATE because the
// decision events have no driver until Phase 3's engines land." This test is
// that proof, exercised directly against the real actor/DB/K8s stack rather
// than through the CLI (the CLI itself is Phase 4's concern).
describe.skipIf(!CLUSTER_AVAILABLE)('autonomous lifecycle, real cluster', () => {
  it('a low-complexity, non-spawning node self-executes through to COMPLETE without any manual event', async () => {
    const db = createDb(TEST_DB);
    const contract = {
      goal: 'fix typo',
      definition_of_done: ['fix typo'],
      authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 0 },
      constraints: [],
    };
    insertNode(db, { id: 'auto-1', parentId: null, goal: contract.goal, contract, state: 'CREATED', createdAt: 't0', updatedAt: 't0' });
    startNodeActor(db, 'auto-1', contract.goal);

    const actor = getNodeActor('auto-1');
    expect(actor).toBeDefined();

    // Sending DOD_MET before the actor has actually reached VERIFY would be
    // silently dropped — XState discards events with no matching transition in
    // the current state rather than queuing them. INTELLIGENCE_GATE/
    // EXECUTION_DECISION/SELF_EXECUTE are all real async invokes here (the last
    // one a genuine K8s Job round-trip), so this wait is load-bearing, not
    // cosmetic.
    await waitFor(actor!, (snapshot) => snapshot.matches('VERIFY'), { timeout: 120_000 });
    actor!.send({ type: 'DOD_MET' }); // the harness/DoD-check itself is a later phase's concern; drive VERIFY manually here.

    const result = await waitForNodeCompletion('auto-1', 120_000);
    expect(result.succeeded).toBe(true);

    const decisions = listDecisionsForNode(db, 'auto-1');
    expect(decisions).toHaveLength(1);
    expect(decisions[0].outcome).toBe('SELF_EXECUTE');
  }, 130_000);
});
```

- [ ] **Step 2: Run it**

Run: `sg docker -c "npm test -- autonomous-loop.integration"`
Expected: PASS — proving a node genuinely walks itself from `CREATED` through a real K8s-dispatched execution to `COMPLETE` with the only manual input being `DOD_MET` (verification logic itself is out of this phase's scope — it currently always trusts an external signal, same as Phase 1/2).

- [ ] **Step 3: Commit**

```bash
git add src/lifecycle/autonomous-loop.integration.test.ts
git commit -m "test: prove the autonomous lifecycle loop end-to-end against a real cluster"
```

---

# Phase 4: CLI/TUI & Approvals

### Task 14: `commitment`/`decision` tRPC routers and CLI commands

**Files:**
- Create: `src/server/routers/commitment.ts`, `src/server/routers/decision.ts`, `src/cli/commands/commitment.ts`, `src/cli/commands/decision.ts`
- Modify: `src/server/root-router.ts`, `src/cli/index.ts`
- Test: `src/server/routers/commitment.test.ts`, `src/server/routers/decision.test.ts`

**Interfaces:**
- Consumes: `listCommitmentsForNode` (Task 4), `listDecisionsForNode` (Task 5).
- Produces: `commitmentRouter`, `decisionRouter` merged into `AppRouter` — no other task depends on these; they're a leaf.

- [ ] **Step 1: Write the failing router tests**

```ts
// src/server/routers/commitment.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { buildServer } from '../app.js';

const TEST_DB = './test-commitment-router.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

describe('commitment router', () => {
  it('lists commitments for a node id', async () => {
    const app = buildServer(TEST_DB);
    const input = encodeURIComponent(JSON.stringify({ nodeId: 'does-not-exist' }));
    const response = await app.inject({ method: 'GET', url: `/trpc/commitment.listForNode?input=${input}` });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).result.data).toEqual([]);
  });
});
```

```ts
// src/server/routers/decision.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { buildServer } from '../app.js';

const TEST_DB = './test-decision-router.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

describe('decision router', () => {
  it('lists decisions for a node id', async () => {
    const app = buildServer(TEST_DB);
    const input = encodeURIComponent(JSON.stringify({ nodeId: 'does-not-exist' }));
    const response = await app.inject({ method: 'GET', url: `/trpc/decision.listForNode?input=${input}` });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).result.data).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- commitment.test decision.test` (from `src/server/routers/`)
Expected: FAIL — `commitment`/`decision` aren't registered on the router yet (404 from Fastify).

- [ ] **Step 3: Write the routers**

```ts
// src/server/routers/commitment.ts
import { z } from 'zod';
import { router, publicProcedure } from '../trpc.js';
import { listCommitmentsForNode } from '../../db/queries/commitments.js';

export const commitmentRouter = router({
  listForNode: publicProcedure
    .input(z.object({ nodeId: z.string() }))
    .query(({ input, ctx }) => listCommitmentsForNode(ctx.db, input.nodeId)),
});
```

```ts
// src/server/routers/decision.ts
import { z } from 'zod';
import { router, publicProcedure } from '../trpc.js';
import { listDecisionsForNode } from '../../db/queries/decisions.js';

export const decisionRouter = router({
  listForNode: publicProcedure
    .input(z.object({ nodeId: z.string() }))
    .query(({ input, ctx }) => listDecisionsForNode(ctx.db, input.nodeId)),
});
```

- [ ] **Step 4: Register them on the root router**

```ts
// src/server/root-router.ts
import { router } from './trpc.js';
import { nodeRouter } from './routers/node.js';
import { eventsRouter } from './routers/events.js';
import { daemonRouter } from './routers/daemon.js';
import { commitmentRouter } from './routers/commitment.js';
import { decisionRouter } from './routers/decision.js';

export const appRouter = router({
  node: nodeRouter,
  events: eventsRouter,
  daemon: daemonRouter,
  commitment: commitmentRouter,
  decision: decisionRouter,
});

export type AppRouter = typeof appRouter;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- commitment.test decision.test`
Expected: PASS.

- [ ] **Step 6: Write and register the CLI commands**

```ts
// src/cli/commands/commitment.ts
import type { Command } from 'commander';
import { createDaemonClient } from '../../daemon/client.js';

export function registerCommitmentCommand(program: Command): void {
  program
    .command('commitment <nodeId>')
    .description('List commitments for a node')
    .action(async (nodeId: string) => {
      const client = createDaemonClient();
      const commitments = await client.commitment.listForNode.query({ nodeId });
      if (commitments.length === 0) {
        console.log('No commitments for this node.');
        return;
      }
      for (const c of commitments) {
        console.log(`${c.id}  ${c.status.padEnd(10)} ${c.goal}`);
      }
    });
}
```

```ts
// src/cli/commands/decision.ts
import type { Command } from 'commander';
import { createDaemonClient } from '../../daemon/client.js';

export function registerDecisionCommand(program: Command): void {
  program
    .command('decision <nodeId>')
    .description('Show evidence-backed decisions for a node, with their full score breakdown')
    .action(async (nodeId: string) => {
      const client = createDaemonClient();
      const decisions = await client.decision.listForNode.query({ nodeId });
      if (decisions.length === 0) {
        console.log('No decisions recorded for this node.');
        return;
      }
      for (const d of decisions) {
        console.log(`${d.id}  ${d.outcome}`);
        for (const [key, value] of Object.entries(d.breakdown)) {
          console.log(`  ${key}: ${value}`);
        }
      }
    });
}
```

```ts
// src/cli/index.ts — add these imports and registrations
import { registerCommitmentCommand } from './commands/commitment.js';
import { registerDecisionCommand } from './commands/decision.js';
// ...
registerCommitmentCommand(program);
registerDecisionCommand(program);
```

- [ ] **Step 7: Rebuild and manually verify**

Run: `npm run build && node dist/cli/index.js commitment auto-1` (or any real node id from a prior manual `org run`)
Expected: prints commitments, or "No commitments for this node." for a node with none.

- [ ] **Step 8: Commit**

```bash
git add src/server src/cli
git commit -m "feat: add org commitment and org decision CLI commands"
```

---

### Task 15: Approvals table, escalation persistence, and desktop notification

**Files:**
- Create: `src/schemas/approval.ts`, `src/db/queries/approvals.ts`, `src/approvals/escalation.ts`
- Modify: `src/db/schema.ts`
- Test: `src/db/queries/approvals.test.ts`, `src/approvals/escalation.test.ts`

**Interfaces:**
- Produces: `ApprovalSchema`, `type Approval`, `approvals` table, `insertApproval`, `getPendingApproval`, `resolveApproval`, `escalate(nodeId: string, reason: string, deps?): Promise<string>` (returns approval id) — consumed by Task 16's `WAIT_APPROVAL` wiring and Task 16's `org approve`/`org reject`.

- [ ] **Step 1: Write the failing schema + query test**

```ts
// src/db/queries/approvals.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../client.js';
import { insertApproval, getPendingApproval, resolveApproval } from './approvals.js';

const TEST_DB = './test-approvals.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

describe('approval queries', () => {
  it('inserts a pending approval and retrieves it by node id', () => {
    const db = createDb(TEST_DB);
    insertApproval(db, { id: 'a1', nodeId: 'n1', reason: 'insufficient budget', status: 'pending', createdAt: 't0' });
    expect(getPendingApproval(db, 'n1')?.id).toBe('a1');
  });

  it('returns undefined once resolved', () => {
    const db = createDb(TEST_DB);
    insertApproval(db, { id: 'a1', nodeId: 'n1', reason: 'x', status: 'pending', createdAt: 't0' });
    resolveApproval(db, 'a1', 'approved', 't1');
    expect(getPendingApproval(db, 'n1')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- approvals.test`
Expected: FAIL — `Cannot find module './approvals'`.

- [ ] **Step 3: Write `schemas/approval.ts`, add the table, generate the migration**

```ts
// src/schemas/approval.ts
import { z } from 'zod';

export const ApprovalStatusSchema = z.enum(['pending', 'approved', 'rejected']);
export const ApprovalSchema = z.object({
  id: z.string(),
  nodeId: z.string(),
  reason: z.string(),
  status: ApprovalStatusSchema,
  createdAt: z.string().datetime(),
  resolvedAt: z.string().datetime().optional(),
});
export type Approval = z.infer<typeof ApprovalSchema>;
```

```ts
// src/db/schema.ts — add below `decisions`
export const approvals = sqliteTable('approvals', {
  id: text('id').primaryKey(),
  nodeId: text('node_id').notNull(),
  reason: text('reason').notNull(),
  status: text('status').notNull(),
  createdAt: text('created_at').notNull(),
  resolvedAt: text('resolved_at'),
});
```

```bash
npx drizzle-kit generate
```

- [ ] **Step 4: Write `db/queries/approvals.ts`**

```ts
// src/db/queries/approvals.ts
import { and, eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { approvals } from '../schema.js';

export interface ApprovalRecord {
  id: string; nodeId: string; reason: string; status: string; createdAt: string; resolvedAt?: string;
}

export function insertApproval(db: Db, record: ApprovalRecord): void {
  db.insert(approvals).values(record).run();
}

export function getPendingApproval(db: Db, nodeId: string): ApprovalRecord | undefined {
  return db.select().from(approvals)
    .where(and(eq(approvals.nodeId, nodeId), eq(approvals.status, 'pending')))
    .get() as ApprovalRecord | undefined;
}

export function resolveApproval(db: Db, id: string, status: 'approved' | 'rejected', resolvedAt: string): void {
  db.update(approvals).set({ status, resolvedAt }).where(eq(approvals.id, id)).run();
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- approvals.test`
Expected: PASS.

- [ ] **Step 6: Install node-notifier and write the failing test for `escalation.ts`**

```bash
npm install node-notifier
npm install --save-dev @types/node-notifier
```

```ts
// src/approvals/escalation.test.ts
import { describe, it, expect, vi } from 'vitest';
import { escalate } from './escalation.js';

describe('escalate', () => {
  it('persists a pending approval and fires a notification', async () => {
    const calls: string[] = [];
    const deps = {
      insertApproval: vi.fn(() => { calls.push('insert'); }),
      notify: vi.fn(() => { calls.push('notify'); }),
    };

    const id = await escalate('n1', 'insufficient budget', deps);

    expect(typeof id).toBe('string');
    expect(calls).toEqual(['insert', 'notify']);
    expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining('n1'));
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npm test -- escalation.test`
Expected: FAIL — `Cannot find module './escalation'`.

- [ ] **Step 8: Write `approvals/escalation.ts`**

```ts
// src/approvals/escalation.ts
import { randomUUID } from 'node:crypto';
import notifier from 'node-notifier';

export interface EscalationDeps {
  insertApproval: (record: { id: string; nodeId: string; reason: string; status: 'pending'; createdAt: string }) => void;
  notify: (message: string) => void;
}

function realNotify(message: string): void {
  notifier.notify({ title: 'Accountable Org — approval needed', message });
}

export async function escalate(
  nodeId: string,
  reason: string,
  deps: Partial<EscalationDeps> = {},
): Promise<string> {
  const id = randomUUID();
  const insertApproval = deps.insertApproval ?? (() => {
    throw new Error('escalate() called without an insertApproval dependency in production wiring');
  });
  const notify = deps.notify ?? realNotify;

  insertApproval({ id, nodeId, reason, status: 'pending', createdAt: new Date().toISOString() });
  notify(`Node ${nodeId} needs approval: ${reason} — run \`org approve ${id}\` or \`org reject ${id}\``);
  return id;
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npm test -- escalation.test`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json src/schemas/approval.ts src/db/schema.ts src/db/migrations src/db/queries/approvals.ts src/db/queries/approvals.test.ts src/approvals
git commit -m "feat: add approvals table, escalation persistence, and desktop notification"
```

---

### Task 16: Real `WAIT_APPROVAL`, `org approve`/`org reject`, `FAILED` state

**Files:**
- Modify: `src/lifecycle/node-machine.ts`, `src/lifecycle/node-machine.test.ts`, `src/lifecycle/node-actor-manager.ts`, `src/server/routers/node.ts`, `src/cli/index.ts`
- Create: `src/cli/commands/approve.ts`
- Test: extend `src/lifecycle/node-machine.test.ts`, `src/server/routers/node.test.ts` (new)

**Interfaces:**
- Consumes: `escalate` (Task 15), `resolveApproval` (Task 15).
- Produces: `NodeMachineEvent` gains `APPROVED`/`REJECTED`; a new `FAILED` final state; `node.resolveApproval` tRPC mutation; `org approve <id>`/`org reject <id>` CLI commands.

- [ ] **Step 1: Extend `node-machine.test.ts`**

```ts
// src/lifecycle/node-machine.test.ts — add to machineWithMocks' actors and add tests
escalate: fromPromise(async () => 'approval-1'),

// new tests:
it('ESCALATE invokes escalation and lands in WAIT_APPROVAL', async () => {
  const actor = createActor(machineWithMocks({ decideExecution: { outcome: 'ESCALATE', breakdown: {} } }), { input: { nodeId: 'n1', goal: 'test' } });
  actor.start();
  actor.send({ type: 'START' });
  await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('WAIT_APPROVAL'));
});

it('APPROVED sends the node back to PLAN', async () => {
  const actor = createActor(machineWithMocks({ decideExecution: { outcome: 'ESCALATE', breakdown: {} } }), { input: { nodeId: 'n1', goal: 'test' } });
  actor.start();
  actor.send({ type: 'START' });
  await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('WAIT_APPROVAL'));
  actor.send({ type: 'APPROVED' });
  await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('VERIFY')); // re-runs the full loop with mocks resolving quickly
});

it('REJECTED sends the node to FAILED', async () => {
  const actor = createActor(machineWithMocks({ decideExecution: { outcome: 'ESCALATE', breakdown: {} } }), { input: { nodeId: 'n1', goal: 'test' } });
  actor.start();
  actor.send({ type: 'START' });
  await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('WAIT_APPROVAL'));
  actor.send({ type: 'REJECTED' });
  expect(actor.getSnapshot().value).toBe('FAILED');
  expect(actor.getSnapshot().status).toBe('done');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- node-machine.test`
Expected: FAIL — `escalate` isn't a declared actor; `APPROVED`/`REJECTED` events and `WAIT_APPROVAL`/`FAILED` states don't exist.

- [ ] **Step 3: Update `node-machine.ts`**

```ts
// src/lifecycle/node-machine.ts — the diff from Task 11's version
export type NodeMachineEvent =
  | { type: 'START' }
  | { type: 'DOD_MET' }
  | { type: 'DOD_NOT_MET' }
  | { type: 'APPROVED' }
  | { type: 'REJECTED' };

// add to the actors map in setup():
escalate: fromPromise<string, { nodeId: string; reason: string }>(async () => {
  throw new Error('escalate actor not provided');
}),

// replace the ESCALATE state:
ESCALATE: {
  invoke: {
    src: 'escalate',
    input: ({ context }) => ({ nodeId: context.nodeId, reason: 'insufficient budget for delegation' }),
    onDone: 'WAIT_APPROVAL',
  },
},
WAIT_APPROVAL: {
  on: {
    APPROVED: 'PLAN',
    REJECTED: 'FAILED',
  },
},
FAILED: { type: 'final' },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- node-machine.test`
Expected: PASS.

- [ ] **Step 5: Wire the real `escalate` actor into `node-actor-manager.ts`**

```ts
// src/lifecycle/node-actor-manager.ts — add the import and actor entry
import { escalate } from '../approvals/escalation.js';
import { insertApproval } from '../db/queries/approvals.js';

function productionMachine(db: Db, nodeId: string) {
  return nodeMachine.provide({
    actors: {
      // ... existing actors ...
      escalate: fromPromise(async ({ input }) =>
        escalate(input.nodeId, input.reason, { insertApproval: (record) => insertApproval(db, record) }),
      ),
    },
  });
}
```

- [ ] **Step 6: Add the `node.resolveApproval` mutation**

```ts
// src/server/routers/node.ts — add this procedure to nodeRouter
import { resolveApproval, getPendingApproval } from '../../db/queries/approvals.js';
import { sendToNode } from '../../lifecycle/node-actor-manager.js';

// ... inside nodeRouter's object:
resolveApproval: publicProcedure
  .input(z.object({ approvalId: z.string(), decision: z.enum(['approved', 'rejected']) }))
  .mutation(({ input, ctx }) => {
    resolveApproval(ctx.db, input.approvalId, input.decision, new Date().toISOString());
    // The approval record knows its nodeId — look it up rather than requiring
    // the caller to pass both, since `org approve <id>` only has the approval id.
    const approval = ctx.db.select().from(approvalsTable).where(eq(approvalsTable.id, input.approvalId)).get();
    if (!approval) throw new Error(`Approval ${input.approvalId} not found`);
    sendToNode(approval.nodeId, { type: input.decision === 'approved' ? 'APPROVED' : 'REJECTED' });
    return { ok: true as const };
  }),
```

```ts
// src/server/routers/node.ts — add this import at the top
import { approvals as approvalsTable } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
```

- [ ] **Step 7: Write and register `org approve`/`org reject`**

```ts
// src/cli/commands/approve.ts
import type { Command } from 'commander';
import { createDaemonClient } from '../../daemon/client.js';

export function registerApproveCommand(program: Command): void {
  program
    .command('approve <approvalId>')
    .description('Approve a pending authority-boundary escalation')
    .action(async (approvalId: string) => {
      const client = createDaemonClient();
      await client.node.resolveApproval.mutate({ approvalId, decision: 'approved' });
      console.log(`Approved ${approvalId}.`);
    });

  program
    .command('reject <approvalId>')
    .description('Reject a pending authority-boundary escalation')
    .action(async (approvalId: string) => {
      const client = createDaemonClient();
      await client.node.resolveApproval.mutate({ approvalId, decision: 'rejected' });
      console.log(`Rejected ${approvalId}.`);
    });
}
```

```ts
// src/cli/index.ts
import { registerApproveCommand } from './commands/approve.js';
// ...
registerApproveCommand(program);
```

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lifecycle src/server src/cli
git commit -m "feat: real WAIT_APPROVAL/FAILED states, org approve/reject commands"
```

---

### Task 17: `org watch` — live Ink TUI

**Files:**
- Create: `src/cli/commands/watch.tsx`
- Modify: `src/cli/index.ts`, `tsconfig.json` (needs `jsx` support for Ink)

**Interfaces:**
- Consumes: `createDaemonClient` (Phase 1), `client.node.tree.query()`, `client.commitment.listForNode.query()`.
- Produces: `registerWatchCommand(program)` — a leaf; nothing else depends on this task.

- [ ] **Step 1: Install Ink and enable JSX**

```bash
npm install ink react @inkjs/ui
npm install --save-dev @types/react
```

```json
// tsconfig.json — add these two compilerOptions
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react"
  }
}
```

- [ ] **Step 2: Write `cli/commands/watch.tsx`**

There is no automated test for this task — Ink's rendering is genuinely a manual-verification surface (same precedent as `org doctor`'s CLI wiring in Phase 2, which also had no automated test). The component logic that *can* be tested (formatting a node's status line) is extracted into a plain function and tested; the live-polling `App` component itself is verified manually in Step 3.

```ts
// src/cli/commands/watch-format.ts
export function formatNodeLine(node: { id: string; state: string; goal: string }): string {
  const badge = node.state === 'COMPLETE' ? '✓' : node.state === 'FAILED' ? '✗' : '●';
  return `${badge} ${node.id.slice(0, 8)}  ${node.state.padEnd(20)} ${node.goal}`;
}
```

```ts
// src/cli/commands/watch-format.test.ts
import { describe, it, expect } from 'vitest';
import { formatNodeLine } from './watch-format.js';

describe('formatNodeLine', () => {
  it('marks COMPLETE with a checkmark', () => {
    expect(formatNodeLine({ id: '12345678-abcd', state: 'COMPLETE', goal: 'x' })).toContain('✓');
  });
  it('marks FAILED with an x', () => {
    expect(formatNodeLine({ id: '12345678-abcd', state: 'FAILED', goal: 'x' })).toContain('✗');
  });
  it('marks any other state with a bullet', () => {
    expect(formatNodeLine({ id: '12345678-abcd', state: 'EXECUTION_DECISION', goal: 'x' })).toContain('●');
  });
});
```

```tsx
// src/cli/commands/watch.tsx
import type { Command } from 'commander';
import React, { useEffect, useState } from 'react';
import { render, Box, Text } from 'ink';
import { Badge } from '@inkjs/ui';
import { createDaemonClient } from '../../daemon/client.js';
import { formatNodeLine } from './watch-format.js';

interface NodeRow { id: string; state: string; goal: string; }

function WatchApp() {
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const client = createDaemonClient();
    const poll = async () => {
      try {
        const tree = await client.node.tree.query();
        setNodes(tree);
        setError(null);
      } catch (err) {
        setError(String(err));
      }
    };
    poll();
    const interval = setInterval(poll, 1500);
    return () => clearInterval(interval);
  }, []);

  return (
    <Box flexDirection="column">
      <Text bold>Accountable Organization — live tree</Text>
      {error && <Badge color="red">daemon unreachable: {error}</Badge>}
      {nodes.length === 0 && !error && <Text dimColor>No nodes yet.</Text>}
      {nodes.map((node) => (
        <Text key={node.id}>{formatNodeLine(node)}</Text>
      ))}
    </Box>
  );
}

export function registerWatchCommand(program: Command): void {
  program
    .command('watch')
    .description('Live dashboard of the organization tree')
    .action(() => {
      render(<WatchApp />);
    });
}
```

```ts
// src/cli/index.ts
import { registerWatchCommand } from './commands/watch.js';
// ...
registerWatchCommand(program);
```

- [ ] **Step 3: Run the automated test, then verify manually**

Run: `npm test -- watch-format.test`
Expected: PASS — 3 tests passed.

Run: `npm run build && node dist/cli/index.js watch` in one terminal, `node dist/cli/index.js run "manual watch test"` in another
Expected: the watch view updates within ~1.5s showing the new node and its state changing over time; `Ctrl+C` exits cleanly.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json tsconfig.json src/cli/commands/watch.tsx src/cli/commands/watch-format.ts src/cli/commands/watch-format.test.ts src/cli/index.ts
git commit -m "feat: add org watch live Ink TUI"
```

---

### Task 18: `org doctor` guidance pass with `@clack/prompts`

**Files:**
- Modify: `src/cli/commands/doctor.ts`

**Interfaces:**
- Consumes: `@clack/prompts` (already a dependency since Phase 1 Task 9, unused until now).
- Produces: no new exports — behavioral polish only, on a failing check.

- [ ] **Step 1: Update `registerDoctorCommand` to offer guidance on failure**

```ts
// src/cli/commands/doctor.ts — replace registerDoctorCommand only; CHECKS/probe/nodeVersionCheck unchanged
import * as clack from '@clack/prompts';

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check that required dependencies are present')
    .action(async () => {
      const ok = await runChecks(CHECKS);
      if (!ok) {
        clack.log.warn('Some checks failed. Re-run `org doctor` after fixing them — each failing line above names the missing piece and, where applicable, an install link.');
      } else {
        clack.log.success('All checks passed — ready to run `org run`.');
      }
      process.exitCode = ok ? 0 : 1;
    });
}
```

- [ ] **Step 2: Manually verify both paths**

Run: `npm run build && node dist/cli/index.js doctor`
Expected: on this environment (Docker/kind/kubectl already set up per the Phase 2 verification), all 5 checks pass and the success message prints.

To see the failure path without uninstalling anything real, temporarily rename `kind` off `PATH` (e.g. `mv ~/.local/bin/kind ~/.local/bin/kind.bak`) and re-run, then restore it — confirm the warning message prints and the exit code is 1.

- [ ] **Step 3: Commit**

```bash
git add src/cli/commands/doctor.ts
git commit -m "feat: add @clack/prompts guidance messages to org doctor's pass/fail summary"
```

---

## Phase 3+4 exit checklist

Before either phase is considered done (invoke superpowers:verification-before-completion, not just this list from memory):

- [ ] `npm run typecheck` passes with zero errors.
- [ ] `npm test` passes — every unit test, plus the cluster-backed integration tests (Task 13's autonomous-loop test, Phase 2's execute-step integration test) actually run and pass against a real `kind` cluster, not silently skipped.
- [ ] Manually run `org run "fix a typo"` (low complexity, default authority) and confirm via `org tree`/`org decision <id>` that it reached `COMPLETE` via `SELF_EXECUTE` with a printed score breakdown.
- [ ] Manually run `org run` with a node contract whose `authority.spawn_children` is `true`, `budget_usd` at least `1`, and a long/complex goal string, and confirm via `org tree` it reached `DELEGATE`, spawned a real child node visible in `org tree`, and both parent and child reached `COMPLETE`.
- [ ] Manually construct a scenario that reaches `ESCALATE` (spawn-authorized but `budget_usd < 1`) and confirm: a desktop notification fires, `org tree` shows `WAIT_APPROVAL`, and `org approve <id>` unblocks it back through to `COMPLETE` (or `org reject <id>` sends it to `FAILED`).
- [ ] `org watch` shows live updates for at least one full run.
- [ ] `org doctor` shows the new guidance message on both the pass and fail path.
- [ ] CI is green (Phase 3+4's new tests run in the non-cluster CI job the same way Phase 1/2's did; the `kind`-backed CI integration job is still Phase 5's task).
- [ ] Invoke superpowers:requesting-code-review, then superpowers:finishing-a-development-branch.

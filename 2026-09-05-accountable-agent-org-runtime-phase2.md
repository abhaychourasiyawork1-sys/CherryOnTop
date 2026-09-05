# Accountable Agent Organization Runtime — Phase 2: Execution Substrate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Before starting:** create an isolated workspace via superpowers:using-git-worktrees, branched from `main` at commit `89561d3` (Phase 1 complete, CI green).
>
> **Skills to invoke during execution:**
> - superpowers:test-driven-development governs every task's step rhythm — already baked into each task below.
> - superpowers:systematic-debugging — invoke the moment a K8s integration test fails for a reason you don't immediately understand (cluster/network debugging has a lot of ways to go sideways; don't guess-and-check).
> - superpowers:requesting-code-review — invoke once all 9 tasks are done, before merging.
> - superpowers:verification-before-completion — invoke before declaring Phase 2 done: re-run the full suite including the conditional K8s integration tests with a real cluster present, not just the unit tests.
> - superpowers:finishing-a-development-branch — invoke once Phase 2 is reviewed, to decide how it merges.

**Goal:** Replace Phase 1's `SELF_EXECUTE: { always: 'VERIFY' }` stub with real Kubernetes-sandboxed execution — a node's SELF_EXECUTE step dispatches one Job into an auto-provisioned local `kind` cluster, runs Claude Code headlessly inside it with an ephemeral Secret and a default-deny network policy, streams structured events back into the node's event log, and reports a real success/failure result to VERIFY.

**Architecture:** Pure manifest-building and orchestration-sequencing logic is unit-tested without a cluster; actual cluster I/O (Job creation, Secret lifecycle, NetworkPolicy application, log streaming) is integration-tested against a real local `kind` cluster, with tests that skip gracefully (not fail) when Docker/kind/kubectl aren't present in the executing environment — the same conditional-availability pattern `org doctor` itself will report on.

**Tech Stack additions this phase:** `@kubernetes/client-node` (K8s API client), `execa` (already a devDependency in Phase 1 — this phase adds it as a runtime dependency), `ndjson` (streaming JSON-lines parsing).

**Spec:** [docs/superpowers/specs/2026-09-05-accountable-agent-org-runtime-design.md](../specs/2026-09-05-accountable-agent-org-runtime-design.md) §5 (execution substrate), §18 (security), and [accountable_agent_organization_runtime_handoff.html](../../../accountable_agent_organization_runtime_handoff.html) §7, §18. Also implements the Phase 2 scope section of [2026-09-05-accountable-agent-org-runtime-v0.1.md](2026-09-05-accountable-agent-org-runtime-v0.1.md).

**Verified Phase 1 interfaces this plan builds on** (read from the actual `main` branch, not assumed):

```ts
// src/lifecycle/node-machine.ts
export interface NodeMachineContext { nodeId: string; goal: string; }
export type NodeMachineEvent =
  | { type: 'START' } | { type: 'CONTEXT_SUFFICIENT' } | { type: 'CONTEXT_INSUFFICIENT' }
  | { type: 'SELF_EXECUTE' } | { type: 'DELEGATE' } | { type: 'DOD_MET' } | { type: 'DOD_NOT_MET' };
export const nodeMachine = setup({ types: { context: {} as NodeMachineContext, events: {} as NodeMachineEvent, input: {} as NodeMachineContext } }).createMachine({ /* ... */ });
// Current SELF_EXECUTE state: `SELF_EXECUTE: { always: 'VERIFY' }` — this plan's Task 8 replaces it.

// src/lifecycle/node-actor-manager.ts
export function startNodeActor(db: Db, nodeId: string, goal: string): void;
export function getNodeActor(nodeId: string): Actor<typeof nodeMachine> | undefined;
export function sendToNode(nodeId: string, event: NodeMachineEvent): void;

// src/db/client.ts
export function createDb(filePath: string): Db;
export type Db = ReturnType<typeof createDb>;

// src/db/queries/events.ts
export function appendEvent(db: Db, record: { nodeId: string; type: string; payload: unknown; createdAt: string }): void;

// src/schemas/node-contract.ts
export const AuthoritySchema: z.ZodObject<{ tools: z.ZodArray<z.ZodString>; spawn_children: z.ZodBoolean; max_child_count: z.ZodNumber; budget_usd: z.ZodNumber }>;
export type Authority = z.infer<typeof AuthoritySchema>;

// src/doctor/checks.ts
export interface DoctorCheckResult { ok: boolean; message: string; }
export interface DoctorCheck { name: string; run(): Promise<DoctorCheckResult>; }
export function runChecks(checks: DoctorCheck[]): Promise<boolean>;
```

## Global Constraints

- All new subprocess execution uses `execa`, never raw `child_process` (carried over from Phase 1's Global Constraints, D34).
- Every Job/Secret/NetworkPolicy created against a real cluster in a test must be deleted in that test's cleanup — a test that leaks cluster resources is a bug in the test, not an acceptable cost of testing.
- Cluster-touching integration tests must be written so they **skip with a clear console message** (not fail) when `docker`/`kind`/`kubectl` aren't available in `PATH` — use a module-level `const CLUSTER_AVAILABLE = await checkClusterAvailable()` and `describe.skipIf(!CLUSTER_AVAILABLE)`. Pure manifest-building/orchestration-sequencing logic must still get real, always-run unit tests — don't push everything behind the skip guard.
- Namespace for all Job/Secret/NetworkPolicy resources this phase: `org-exec` (created if absent by `ensureLocalCluster`).
- Runner image for this phase: `ghcr.io/abhaychourasiyawork1-sys/cherryontop-runner:dev` is referenced in Job specs but is **not built by this phase** (that's Phase 5's Dockerfile/publish-workflow task) — Task 6's Claude Code adapter test therefore runs against a plain `node:22-slim` image with Claude Code installed ad hoc in the test's Job command, clearly marked as a Phase-5-will-replace-this stopgap.
- Fix carried over from Phase 1 review: `src/cli/commands/doctor.ts`'s Node version check currently says `major >= 20` / "need >= 20" but `package.json` requires `>=22` — Task 9 below corrects this in the same edit that adds the new checks.

## Phase 2 Task List

| # | Task | Produces |
|---|---|---|
| 1 | Local kind cluster bootstrap | `ensureLocalCluster()`, `isClusterReachable()` |
| 2 | Job manifest builder (pure) | `buildExecutionJob()` |
| 3 | K8s API client wrapper | `createJob()`, `waitForJobCompletion()`, `deleteJob()`, `streamJobLogs()` |
| 4 | Ephemeral Secret lifecycle | `createEphemeralSecret()`, `deleteSecret()` |
| 5 | NetworkPolicy | `applyDefaultDenyPolicy()`, `buildEgressAllowlistPolicy()` |
| 6 | RuntimeAdapter interface + Claude Code adapter | `RuntimeAdapter`, `claudeCodeAdapter` |
| 7 | execute-step orchestrator | `executeStep()` |
| 8 | Wire into node-machine (invoked actor) | updated `nodeMachine`, `node-actor-manager.ts` |
| 9 | `org doctor` real checks + Node-version fix | 4 new `DoctorCheck`s, corrected floor |

---

### Task 1: Local `kind` cluster bootstrap

**Files:**
- Create: `src/k8s/kind.ts`
- Test: `src/k8s/kind.test.ts`

**Interfaces:**
- Consumes: `execa` (new runtime dependency).
- Produces: `ensureLocalCluster(): Promise<void>`, `isClusterReachable(): Promise<boolean>` — consumed by Task 9's `org doctor` checks and by the daemon startup path (wired in Task 3).

- [ ] **Step 1: Install execa as a runtime dependency and @kubernetes/client-node**

```bash
npm install execa @kubernetes/client-node
```

- [ ] **Step 2: Write the failing test**

```ts
// src/k8s/kind.test.ts
import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { isClusterReachable } from './kind.js';

async function hasKindBinary(): Promise<boolean> {
  try {
    await execa('kind', ['--version']);
    return true;
  } catch {
    return false;
  }
}

describe('isClusterReachable', () => {
  it('returns a boolean without throwing, regardless of cluster state', async () => {
    const result = await isClusterReachable();
    expect(typeof result).toBe('boolean');
  });

  it('returns false when kubectl reports no reachable cluster', async () => {
    const kindAvailable = await hasKindBinary();
    if (!kindAvailable) {
      console.log('kind binary not found — skipping cluster-state assertion, boolean-safety already covered above');
      return;
    }
    // No assumption about cluster existing yet; just confirm the function completes.
    await expect(isClusterReachable()).resolves.not.toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- kind.test`
Expected: FAIL — `Cannot find module './kind'`.

- [ ] **Step 4: Write `k8s/kind.ts`**

```ts
// src/k8s/kind.ts
import { execa } from 'execa';

const CLUSTER_NAME = 'org-local';

export async function isClusterReachable(): Promise<boolean> {
  try {
    await execa('kubectl', ['cluster-info'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function hasExistingKubeconfigContext(): Promise<boolean> {
  try {
    const { stdout } = await execa('kubectl', ['config', 'current-context']);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export async function ensureLocalCluster(): Promise<void> {
  if (await hasExistingKubeconfigContext()) {
    if (await isClusterReachable()) return;
  }

  const { stdout } = await execa('kind', ['get', 'clusters']).catch(() => ({ stdout: '' }));
  if (stdout.split('\n').includes(CLUSTER_NAME)) {
    return;
  }

  await execa('kind', ['create', 'cluster', '--name', CLUSTER_NAME], { timeout: 120_000 });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- kind.test`
Expected: PASS — 2 tests passed (the second either asserts real behavior against a `kind` binary, or logs a skip note and passes trivially if `kind` isn't installed).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/k8s/kind.ts src/k8s/kind.test.ts
git commit -m "feat: add local kind cluster bootstrap and reachability check"
```

---

### Task 2: Job manifest builder (pure function)

**Files:**
- Create: `src/k8s/job-manifest.ts`
- Test: `src/k8s/job-manifest.test.ts`

**Interfaces:**
- Consumes: nothing from earlier Phase 2 tasks (deliberately pure — no cluster, no execa).
- Produces: `interface ExecutionJobParams`, `buildExecutionJob(params: ExecutionJobParams): k8s.V1Job` — consumed by Task 3's `createJob()` and Task 7's `executeStep()`.

- [ ] **Step 1: Write the failing test**

```ts
// src/k8s/job-manifest.test.ts
import { describe, it, expect } from 'vitest';
import { buildExecutionJob } from './job-manifest.js';

describe('buildExecutionJob', () => {
  it('builds a Job manifest with the worktree mounted and the secret referenced', () => {
    const job = buildExecutionJob({
      nodeId: 'n1',
      namespace: 'org-exec',
      image: 'node:22-slim',
      command: ['node', '--version'],
      worktreePath: '/tmp/worktree-n1',
      secretName: 'org-secret-n1',
    });

    expect(job.metadata?.namespace).toBe('org-exec');
    expect(job.metadata?.generateName).toBe('org-exec-n1-');
    expect(job.spec?.template.spec?.containers[0].image).toBe('node:22-slim');
    expect(job.spec?.template.spec?.containers[0].command).toEqual(['node', '--version']);
    expect(job.spec?.template.spec?.containers[0].volumeMounts?.[0].mountPath).toBe('/workspace');
    expect(job.spec?.template.spec?.volumes?.[0].hostPath?.path).toBe('/tmp/worktree-n1');
    expect(job.spec?.template.spec?.containers[0].envFrom?.[0].secretRef?.name).toBe('org-secret-n1');
    expect(job.spec?.template.spec?.restartPolicy).toBe('Never');
    expect(job.spec?.backoffLimit).toBe(0);
  });

  it('sets a resource-limited, non-privileged security context', () => {
    const job = buildExecutionJob({
      nodeId: 'n1', namespace: 'org-exec', image: 'node:22-slim',
      command: ['echo', 'hi'], worktreePath: '/tmp/w', secretName: 's1',
    });
    const container = job.spec?.template.spec?.containers[0];
    expect(container?.securityContext?.allowPrivilegeEscalation).toBe(false);
    expect(container?.resources?.limits?.cpu).toBeDefined();
    expect(container?.resources?.limits?.memory).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- job-manifest.test`
Expected: FAIL — `Cannot find module './job-manifest'`.

- [ ] **Step 3: Write `k8s/job-manifest.ts`**

```ts
// src/k8s/job-manifest.ts
import type { V1Job } from '@kubernetes/client-node';

export interface ExecutionJobParams {
  nodeId: string;
  namespace: string;
  image: string;
  command: string[];
  worktreePath: string;
  secretName: string;
}

export function buildExecutionJob(params: ExecutionJobParams): V1Job {
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      generateName: `org-exec-${params.nodeId}-`,
      namespace: params.namespace,
      labels: { 'org.nodeId': params.nodeId },
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 300,
      template: {
        metadata: { labels: { 'org.nodeId': params.nodeId } },
        spec: {
          restartPolicy: 'Never',
          containers: [
            {
              name: 'runner',
              image: params.image,
              command: params.command,
              envFrom: [{ secretRef: { name: params.secretName } }],
              volumeMounts: [{ name: 'workspace', mountPath: '/workspace' }],
              securityContext: {
                allowPrivilegeEscalation: false,
                runAsNonRoot: true,
              },
              resources: {
                limits: { cpu: '2', memory: '2Gi' },
                requests: { cpu: '500m', memory: '512Mi' },
              },
            },
          ],
          volumes: [{ name: 'workspace', hostPath: { path: params.worktreePath, type: 'Directory' } }],
        },
      },
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- job-manifest.test`
Expected: PASS — 2 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/k8s/job-manifest.ts src/k8s/job-manifest.test.ts
git commit -m "feat: add pure Kubernetes Job manifest builder"
```

---

### Task 3: K8s API client wrapper

**Files:**
- Create: `src/k8s/client.ts`
- Test: `src/k8s/client.test.ts`

**Interfaces:**
- Consumes: `buildExecutionJob` (Task 2), `isClusterReachable` (Task 1).
- Produces: `createJob(job: V1Job): Promise<string>` (returns generated Job name), `waitForJobCompletion(jobName, namespace): Promise<JobResult>`, `deleteJob(jobName, namespace): Promise<void>`, `streamJobLogs(jobName, namespace): Promise<string>` — consumed by Task 7's `executeStep()`.

- [ ] **Step 1: Write the failing integration test**

```ts
// src/k8s/client.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { execa } from 'execa';
import { isClusterReachable, ensureLocalCluster } from './kind.js';
import { buildExecutionJob } from './job-manifest.js';
import { createJob, waitForJobCompletion, deleteJob } from './client.js';

async function checkClusterAvailable(): Promise<boolean> {
  try {
    await execa('kind', ['--version']);
    await execa('kubectl', ['version', '--client']);
    return true;
  } catch {
    return false;
  }
}

const CLUSTER_AVAILABLE = await checkClusterAvailable();

describe.skipIf(!CLUSTER_AVAILABLE)('K8s client (real cluster)', () => {
  beforeAll(async () => {
    await ensureLocalCluster();
    expect(await isClusterReachable()).toBe(true);
  }, 120_000);

  it('creates a Job, waits for completion, and reports success', async () => {
    const job = buildExecutionJob({
      nodeId: 'test-client', namespace: 'default', image: 'busybox:1.36',
      command: ['echo', 'hello from job'], worktreePath: '/tmp', secretName: 'nonexistent-optional',
    });
    // Job spec references envFrom.secretRef without `optional: true` by default in Task 2 —
    // this test creates the referenced secret first so the pod can actually start.
    await execa('kubectl', ['create', 'secret', 'generic', 'nonexistent-optional', '--from-literal=x=y', '-n', 'default'])
      .catch(() => {}); // ignore AlreadyExists from a prior flaky run

    const jobName = await createJob(job);
    const result = await waitForJobCompletion(jobName, 'default');
    expect(result.succeeded).toBe(true);

    await deleteJob(jobName, 'default');
    await execa('kubectl', ['delete', 'secret', 'nonexistent-optional', '-n', 'default']).catch(() => {});
  }, 60_000);

  it('reports failure for a Job whose container exits non-zero', async () => {
    await execa('kubectl', ['create', 'secret', 'generic', 'fail-secret', '--from-literal=x=y', '-n', 'default']).catch(() => {});
    const job = buildExecutionJob({
      nodeId: 'test-client-fail', namespace: 'default', image: 'busybox:1.36',
      command: ['sh', '-c', 'exit 1'], worktreePath: '/tmp', secretName: 'fail-secret',
    });
    const jobName = await createJob(job);
    const result = await waitForJobCompletion(jobName, 'default');
    expect(result.succeeded).toBe(false);

    await deleteJob(jobName, 'default');
    await execa('kubectl', ['delete', 'secret', 'fail-secret', '-n', 'default']).catch(() => {});
  }, 60_000);
});
```

- [ ] **Step 2: Run test to verify it fails (or skips cleanly without kind)**

Run: `npm test -- client.test`
Expected: FAIL — `Cannot find module './client'` if kind/kubectl are present; SKIP with no failure if they aren't. Either way, confirm the skip guard itself works by temporarily renaming the `kind` binary off `PATH` and re-running — the suite should report the test file's tests as skipped, not failed.

- [ ] **Step 3: Write `k8s/client.ts`**

```ts
// src/k8s/client.ts
import * as k8s from '@kubernetes/client-node';
import type { V1Job } from '@kubernetes/client-node';

function loadApis() {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  return {
    batch: kc.makeApiClient(k8s.BatchV1Api),
    core: kc.makeApiClient(k8s.CoreV1Api),
  };
}

export async function createJob(job: V1Job): Promise<string> {
  const { batch } = loadApis();
  const namespace = job.metadata?.namespace ?? 'default';
  const created = await batch.createNamespacedJob({ namespace, body: job });
  const name = created.metadata?.name;
  if (!name) throw new Error('Job created without a name in the response');
  return name;
}

export interface JobResult {
  succeeded: boolean;
  message: string;
}

export async function waitForJobCompletion(jobName: string, namespace: string, timeoutMs = 60_000): Promise<JobResult> {
  const { batch } = loadApis();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = await batch.readNamespacedJobStatus({ name: jobName, namespace });
    const status = job.status;
    if (status?.succeeded && status.succeeded > 0) {
      return { succeeded: true, message: 'Job completed successfully' };
    }
    if (status?.failed && status.failed > 0) {
      return { succeeded: false, message: 'Job failed — see pod logs' };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { succeeded: false, message: `Job did not complete within ${timeoutMs}ms` };
}

export async function deleteJob(jobName: string, namespace: string): Promise<void> {
  const { batch } = loadApis();
  await batch.deleteNamespacedJob({ name: jobName, namespace, propagationPolicy: 'Background' });
}

export async function streamJobLogs(jobName: string, namespace: string): Promise<string> {
  const { core } = loadApis();
  const pods = await core.listNamespacedPod({ namespace, labelSelector: `job-name=${jobName}` });
  const podName = pods.items[0]?.metadata?.name;
  if (!podName) return '';
  const log = await core.readNamespacedPodLog({ name: podName, namespace });
  return log;
}
```

- [ ] **Step 4: Run test to verify it passes (when kind is available) or skips cleanly (when it isn't)**

Run: `npm test -- client.test`
Expected: PASS — 2 tests passed against a real `kind` cluster, ~30-60s; or SKIPPED with a console note if `kind`/`kubectl` are absent from this environment.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/k8s/client.ts src/k8s/client.test.ts
git commit -m "feat: add K8s API client wrapper for Job create/wait/delete/logs"
```

---

### Task 4: Ephemeral Secret lifecycle

**Files:**
- Create: `src/k8s/secrets.ts`
- Test: `src/k8s/secrets.test.ts`

**Interfaces:**
- Consumes: `@kubernetes/client-node` (already installed, Task 1).
- Produces: `createEphemeralSecret(nodeId: string, credentials: Record<string, string>, namespace: string): Promise<string>` (returns Secret name), `deleteSecret(name: string, namespace: string): Promise<void>` — consumed by Task 7's `executeStep()`.

- [ ] **Step 1: Write the failing integration test**

```ts
// src/k8s/secrets.test.ts
import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { createEphemeralSecret, deleteSecret } from './secrets.js';

async function checkClusterAvailable(): Promise<boolean> {
  try {
    await execa('kubectl', ['cluster-info'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
const CLUSTER_AVAILABLE = await checkClusterAvailable();

describe.skipIf(!CLUSTER_AVAILABLE)('ephemeral secrets', () => {
  it('creates a secret with the given credentials, then deletes it', async () => {
    const name = await createEphemeralSecret('n1', { GIT_TOKEN: 'fake-token-value' }, 'default');
    expect(name).toMatch(/^org-secret-n1-/);

    const { stdout } = await execa('kubectl', ['get', 'secret', name, '-n', 'default', '-o', 'jsonpath={.data.GIT_TOKEN}']);
    expect(Buffer.from(stdout, 'base64').toString('utf-8')).toBe('fake-token-value');

    await deleteSecret(name, 'default');
    await expect(execa('kubectl', ['get', 'secret', name, '-n', 'default'])).rejects.toThrow();
  }, 30_000);
});
```

- [ ] **Step 2: Run test to verify it fails or skips cleanly**

Run: `npm test -- secrets.test`
Expected: FAIL — `Cannot find module './secrets'` (if cluster available) or SKIP (if not).

- [ ] **Step 3: Write `k8s/secrets.ts`**

```ts
// src/k8s/secrets.ts
import * as k8s from '@kubernetes/client-node';
import { randomUUID } from 'node:crypto';

function loadCoreApi() {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  return kc.makeApiClient(k8s.CoreV1Api);
}

export async function createEphemeralSecret(
  nodeId: string,
  credentials: Record<string, string>,
  namespace: string,
): Promise<string> {
  const core = loadCoreApi();
  const name = `org-secret-${nodeId}-${randomUUID().slice(0, 8)}`;
  await core.createNamespacedSecret({
    namespace,
    body: {
      metadata: { name, namespace, labels: { 'org.nodeId': nodeId } },
      stringData: credentials,
    },
  });
  return name;
}

export async function deleteSecret(name: string, namespace: string): Promise<void> {
  const core = loadCoreApi();
  await core.deleteNamespacedSecret({ name, namespace });
}
```

- [ ] **Step 4: Run test to verify it passes or skips cleanly**

Run: `npm test -- secrets.test`
Expected: PASS or SKIP as in Step 2.

- [ ] **Step 5: Commit**

```bash
git add src/k8s/secrets.ts src/k8s/secrets.test.ts
git commit -m "feat: add ephemeral per-Job Secret lifecycle"
```

---

### Task 5: NetworkPolicy

**Files:**
- Create: `src/k8s/network-policy.ts`
- Test: `src/k8s/network-policy.test.ts`

**Interfaces:**
- Consumes: `@kubernetes/client-node`.
- Produces: `buildEgressAllowlistPolicy(nodeId: string, allowedCidrs: { ip: string; ports: number[] }[]): V1NetworkPolicy` (pure), `applyNetworkPolicy(policy: V1NetworkPolicy, namespace: string): Promise<void>`, `applyDefaultDenyPolicy(namespace: string): Promise<void>` — consumed by Task 7's `executeStep()`.

- [ ] **Step 1: Write the failing test for the pure builder (always runs, no cluster needed)**

```ts
// src/k8s/network-policy.test.ts
import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { buildEgressAllowlistPolicy, applyDefaultDenyPolicy, applyNetworkPolicy } from './network-policy.js';

describe('buildEgressAllowlistPolicy', () => {
  it('builds a policy denying ingress and allowlisting only the given egress targets', () => {
    const policy = buildEgressAllowlistPolicy('n1', [{ ip: '140.82.112.0/20', ports: [443] }]);
    expect(policy.spec?.podSelector.matchLabels).toEqual({ 'org.nodeId': 'n1' });
    expect(policy.spec?.policyTypes).toEqual(['Ingress', 'Egress']);
    expect(policy.spec?.ingress).toEqual([]);
    expect(policy.spec?.egress?.[0].to?.[0].ipBlock?.cidr).toBe('140.82.112.0/20');
    expect(policy.spec?.egress?.[0].ports?.[0].port).toBe(443);
  });
});

async function checkClusterAvailable(): Promise<boolean> {
  try {
    await execa('kubectl', ['cluster-info'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
const CLUSTER_AVAILABLE = await checkClusterAvailable();

describe.skipIf(!CLUSTER_AVAILABLE)('NetworkPolicy application (real cluster)', () => {
  it('applies a default-deny policy without throwing', async () => {
    await expect(applyDefaultDenyPolicy('default')).resolves.not.toThrow();
  }, 15_000);

  it('applies an egress-allowlist policy without throwing', async () => {
    const policy = buildEgressAllowlistPolicy('n1', [{ ip: '0.0.0.0/0', ports: [443] }]);
    await expect(applyNetworkPolicy(policy, 'default')).resolves.not.toThrow();
  }, 15_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- network-policy.test`
Expected: FAIL — `Cannot find module './network-policy'`.

- [ ] **Step 3: Write `k8s/network-policy.ts`**

```ts
// src/k8s/network-policy.ts
import * as k8s from '@kubernetes/client-node';
import type { V1NetworkPolicy } from '@kubernetes/client-node';

function loadNetworkingApi() {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  return kc.makeApiClient(k8s.NetworkingV1Api);
}

export function buildEgressAllowlistPolicy(
  nodeId: string,
  allowedTargets: { ip: string; ports: number[] }[],
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
        to: [{ ipBlock: { cidr: target.ip } }],
        ports: target.ports.map((port) => ({ port, protocol: 'TCP' })),
      })),
    },
  };
}

export async function applyNetworkPolicy(policy: V1NetworkPolicy, namespace: string): Promise<void> {
  const api = loadNetworkingApi();
  await api.createNamespacedNetworkPolicy({ namespace, body: policy }).catch(async (err) => {
    if (err?.code === 409) {
      const name = policy.metadata?.name;
      if (!name) throw err;
      await api.replaceNamespacedNetworkPolicy({ name, namespace, body: policy });
      return;
    }
    throw err;
  });
}

export async function applyDefaultDenyPolicy(namespace: string): Promise<void> {
  const api = loadNetworkingApi();
  const policy: V1NetworkPolicy = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name: 'default-deny-all' },
    spec: { podSelector: {}, policyTypes: ['Ingress', 'Egress'], ingress: [], egress: [] },
  };
  await api.createNamespacedNetworkPolicy({ namespace, body: policy }).catch((err) => {
    if (err?.code !== 409) throw err;
  });
}
```

- [ ] **Step 4: Run test to verify it passes or skips cleanly**

Run: `npm test -- network-policy.test`
Expected: PASS — the pure builder test always passes; the cluster tests pass or skip per Task 3's pattern.

- [ ] **Step 5: Commit**

```bash
git add src/k8s/network-policy.ts src/k8s/network-policy.test.ts
git commit -m "feat: add default-deny and egress-allowlist NetworkPolicy support"
```

---

### Task 6: RuntimeAdapter interface + Claude Code adapter

**Files:**
- Create: `src/adapters/adapter.ts`, `src/adapters/claude-code.ts`
- Test: `src/adapters/claude-code.test.ts`

**Interfaces:**
- Consumes: `ndjson` (new dependency), `zod`.
- Produces: `interface RuntimeAdapter`, `claudeCodeAdapter: RuntimeAdapter` with `buildCommand(goal: string): string[]` and `parseEventStream(stream: NodeJS.ReadableStream): Promise<StructuredEvent[]>` — consumed by Task 7's `executeStep()`.

- [ ] **Step 1: Install ndjson**

```bash
npm install ndjson
npm install --save-dev @types/ndjson
```

- [ ] **Step 2: Write `adapters/adapter.ts`**

```ts
// src/adapters/adapter.ts
import { z } from 'zod';

export const StructuredEventSchema = z.object({
  type: z.string(),
  payload: z.unknown(),
});
export type StructuredEvent = z.infer<typeof StructuredEventSchema>;

export interface RuntimeAdapter {
  name: string;
  buildCommand(goal: string): string[];
  parseEventStream(stream: NodeJS.ReadableStream): Promise<StructuredEvent[]>;
}
```

- [ ] **Step 3: Write the failing test for the Claude Code adapter's stream parsing (no real Claude Code invocation needed — a fixture stream is enough)**

```ts
// src/adapters/claude-code.test.ts
import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { claudeCodeAdapter } from './claude-code.js';

describe('claudeCodeAdapter', () => {
  it('builds the headless streaming command for a goal', () => {
    const command = claudeCodeAdapter.buildCommand('implement OAuth login');
    expect(command).toEqual(['claude', '--print', '--output-format', 'stream-json', 'implement OAuth login']);
  });

  it('parses a stream of ndjson events into structured events', async () => {
    const lines = [
      JSON.stringify({ type: 'message', payload: { text: 'starting' } }),
      JSON.stringify({ type: 'tool_call', payload: { tool: 'bash', args: ['ls'] } }),
      JSON.stringify({ type: 'result', payload: { success: true } }),
    ];
    const stream = Readable.from(lines.map((l) => l + '\n'));

    const events = await claudeCodeAdapter.parseEventStream(stream);
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe('message');
    expect(events[2].payload).toEqual({ success: true });
  });

  it('discards a malformed line instead of throwing', async () => {
    const stream = Readable.from(['not valid json\n', JSON.stringify({ type: 'message', payload: {} }) + '\n']);
    const events = await claudeCodeAdapter.parseEventStream(stream);
    expect(events).toHaveLength(1);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test -- claude-code.test`
Expected: FAIL — `Cannot find module './claude-code'`.

- [ ] **Step 5: Write `adapters/claude-code.ts`**

```ts
// src/adapters/claude-code.ts
import ndjson from 'ndjson';
import type { RuntimeAdapter, StructuredEvent } from './adapter.js';
import { StructuredEventSchema } from './adapter.js';

export const claudeCodeAdapter: RuntimeAdapter = {
  name: 'claude-code',

  buildCommand(goal: string): string[] {
    return ['claude', '--print', '--output-format', 'stream-json', goal];
  },

  parseEventStream(stream: NodeJS.ReadableStream): Promise<StructuredEvent[]> {
    return new Promise((resolve, reject) => {
      const events: StructuredEvent[] = [];
      const parser = ndjson.parse({ strict: false });

      stream.pipe(parser);
      parser.on('data', (raw: unknown) => {
        const parsed = StructuredEventSchema.safeParse(raw);
        if (parsed.success) events.push(parsed.data);
      });
      parser.on('end', () => resolve(events));
      parser.on('error', reject);
    });
  },
};
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- claude-code.test`
Expected: PASS — 3 tests passed.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/adapters
git commit -m "feat: add RuntimeAdapter interface and headless Claude Code adapter"
```

---

### Task 7: execute-step orchestrator

**Files:**
- Create: `src/execution/execute-step.ts`
- Test: `src/execution/execute-step.test.ts`

**Interfaces:**
- Consumes: `buildExecutionJob` (Task 2), `createJob`/`waitForJobCompletion`/`deleteJob`/`streamJobLogs` (Task 3), `createEphemeralSecret`/`deleteSecret` (Task 4), `buildEgressAllowlistPolicy`/`applyNetworkPolicy` (Task 5), `RuntimeAdapter`/`claudeCodeAdapter` (Task 6), `appendEvent` (Phase 1).
- Produces: `interface ExecuteStepInput`, `interface ExecuteStepResult`, `executeStep(input: ExecuteStepInput, deps?: Partial<ExecuteStepDeps>): Promise<ExecuteStepResult>` — consumed by Task 8's invoked actor. The `deps` parameter (defaulting to the real Task 2–6 functions) is what makes this task's own logic-sequencing test possible without a cluster, and is exactly what Task 8 does NOT override in production.

- [ ] **Step 1: Write the failing test using injected fake dependencies (proves orchestration logic without a cluster)**

```ts
// src/execution/execute-step.test.ts
import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import { executeStep } from './execute-step.js';
import type { RuntimeAdapter } from '../adapters/adapter.js';

const fakeAdapter: RuntimeAdapter = {
  name: 'fake',
  buildCommand: (goal) => ['fake-cli', goal],
  parseEventStream: async () => [{ type: 'result', payload: { success: true } }],
};

describe('executeStep', () => {
  it('creates a secret, applies a network policy, dispatches a Job, waits, and cleans up on success', async () => {
    const calls: string[] = [];
    const deps = {
      createEphemeralSecret: vi.fn(async () => { calls.push('createSecret'); return 'secret-1'; }),
      deleteSecret: vi.fn(async () => { calls.push('deleteSecret'); }),
      applyNetworkPolicy: vi.fn(async () => { calls.push('applyPolicy'); }),
      createJob: vi.fn(async () => { calls.push('createJob'); return 'job-1'; }),
      waitForJobCompletion: vi.fn(async () => { calls.push('waitJob'); return { succeeded: true, message: 'ok' }; }),
      deleteJob: vi.fn(async () => { calls.push('deleteJob'); }),
      streamJobLogs: vi.fn(async () => { calls.push('streamLogs'); return '{"type":"result","payload":{"success":true}}\n'; }),
    };

    const result = await executeStep(
      { nodeId: 'n1', goal: 'test goal', namespace: 'org-exec', worktreePath: '/tmp/w', credentials: {}, adapter: fakeAdapter },
      deps,
    );

    expect(result.succeeded).toBe(true);
    expect(calls).toEqual(['createSecret', 'applyPolicy', 'createJob', 'waitJob', 'streamLogs', 'deleteJob', 'deleteSecret']);
  });

  it('still deletes the secret and Job when the Job fails', async () => {
    const deps = {
      createEphemeralSecret: vi.fn(async () => 'secret-1'),
      deleteSecret: vi.fn(async () => {}),
      applyNetworkPolicy: vi.fn(async () => {}),
      createJob: vi.fn(async () => 'job-1'),
      waitForJobCompletion: vi.fn(async () => ({ succeeded: false, message: 'boom' })),
      deleteJob: vi.fn(async () => {}),
      streamJobLogs: vi.fn(async () => ''),
    };

    const result = await executeStep(
      { nodeId: 'n1', goal: 'test goal', namespace: 'org-exec', worktreePath: '/tmp/w', credentials: {}, adapter: fakeAdapter },
      deps,
    );

    expect(result.succeeded).toBe(false);
    expect(deps.deleteJob).toHaveBeenCalled();
    expect(deps.deleteSecret).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- execute-step.test`
Expected: FAIL — `Cannot find module './execute-step'`.

- [ ] **Step 3: Write `execution/execute-step.ts`**

```ts
// src/execution/execute-step.ts
import { Readable } from 'node:stream';
import { buildExecutionJob } from '../k8s/job-manifest.js';
import { createJob, waitForJobCompletion, deleteJob, streamJobLogs } from '../k8s/client.js';
import { createEphemeralSecret, deleteSecret } from '../k8s/secrets.js';
import { buildEgressAllowlistPolicy, applyNetworkPolicy } from '../k8s/network-policy.js';
import type { RuntimeAdapter, StructuredEvent } from '../adapters/adapter.js';

export interface ExecuteStepInput {
  nodeId: string;
  goal: string;
  namespace: string;
  worktreePath: string;
  credentials: Record<string, string>;
  adapter: RuntimeAdapter;
}

export interface ExecuteStepResult {
  succeeded: boolean;
  message: string;
  events: StructuredEvent[];
}

export interface ExecuteStepDeps {
  createEphemeralSecret: typeof createEphemeralSecret;
  deleteSecret: typeof deleteSecret;
  applyNetworkPolicy: typeof applyNetworkPolicy;
  createJob: typeof createJob;
  waitForJobCompletion: typeof waitForJobCompletion;
  deleteJob: typeof deleteJob;
  streamJobLogs: typeof streamJobLogs;
}

const defaultDeps: ExecuteStepDeps = {
  createEphemeralSecret, deleteSecret, applyNetworkPolicy,
  createJob, waitForJobCompletion, deleteJob, streamJobLogs,
};

// Anthropic API + GitHub's documented IP ranges — the concrete allowlist gets
// pulled into org config in a later phase; hardcoded here as the correct
// starting default per spec §18's network policy table.
const DEFAULT_EGRESS_ALLOWLIST = [
  { ip: '0.0.0.0/0', ports: [443] }, // ponytail: wide-open :443 until per-provider CIDRs are configured; tighten before this leaves Phase 2.
];

export async function executeStep(
  input: ExecuteStepInput,
  deps: Partial<ExecuteStepDeps> = {},
): Promise<ExecuteStepResult> {
  const d = { ...defaultDeps, ...deps };

  const secretName = await d.createEphemeralSecret(input.nodeId, input.credentials, input.namespace);
  try {
    const policy = buildEgressAllowlistPolicy(input.nodeId, DEFAULT_EGRESS_ALLOWLIST);
    await d.applyNetworkPolicy(policy, input.namespace);

    const job = buildExecutionJob({
      nodeId: input.nodeId,
      namespace: input.namespace,
      image: 'ghcr.io/abhaychourasiyawork1-sys/cherryontop-runner:dev',
      command: input.adapter.buildCommand(input.goal),
      worktreePath: input.worktreePath,
      secretName,
    });

    const jobName = await d.createJob(job);
    try {
      const jobResult = await d.waitForJobCompletion(jobName, input.namespace);
      const rawLogs = await d.streamJobLogs(jobName, input.namespace);
      const events = rawLogs
        ? await input.adapter.parseEventStream(Readable.from([rawLogs]))
        : [];

      return { succeeded: jobResult.succeeded, message: jobResult.message, events };
    } finally {
      await d.deleteJob(jobName, input.namespace);
    }
  } finally {
    await d.deleteSecret(secretName, input.namespace);
  }
}
```

Note the `ponytail:` comment on `DEFAULT_EGRESS_ALLOWLIST` — spec §18 calls for a narrow per-provider allowlist, but resolving Anthropic's/GitHub's actual CIDR ranges into config is real scope that doesn't belong bundled into this task; it's tracked explicitly rather than silently shipped as "done."

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- execute-step.test`
Expected: PASS — 2 tests passed, using the injected fakes (no real cluster touched by this test).

- [ ] **Step 5: Commit**

```bash
git add src/execution
git commit -m "feat: add execute-step orchestrator tying Secret/Job/adapter together"
```

---

### Task 8: Wire `executeStep` into the node lifecycle

**Files:**
- Modify: `src/lifecycle/node-machine.ts`, `src/lifecycle/node-actor-manager.ts`, `src/lifecycle/node-machine.test.ts`
- Test: `src/lifecycle/node-machine.test.ts` (extended), `src/lifecycle/node-actor-manager.test.ts` (extended)

**Interfaces:**
- Consumes: `executeStep` (Task 7).
- Produces: an updated `NodeMachineContext` including `lastResult?: ExecuteStepResult`, and `nodeMachine` now requiring a provided `executeStep` actor at instantiation — this is the one Phase 2 task that changes an existing Phase 1 file's public shape, so re-read `node-machine.test.ts`'s existing 4 tests carefully: they must still pass after this change, with a mock actor provided.

- [ ] **Step 1: Update the existing `node-machine.test.ts` to provide a mock `executeStep` actor (this makes the existing suite fail first, honestly, before the implementation changes)**

```ts
// src/lifecycle/node-machine.test.ts — replace the whole file
import { describe, it, expect, vi } from 'vitest';
import { createActor, fromPromise } from 'xstate';
import { nodeMachine } from './node-machine.js';

function machineWithMockExecute(result: { succeeded: boolean }) {
  return nodeMachine.provide({
    actors: {
      executeStep: fromPromise(async () => result),
    },
  });
}

describe('nodeMachine', () => {
  it('starts in CREATED and moves through ORIENT/PLAN to INTELLIGENCE_GATE on START', () => {
    const actor = createActor(machineWithMockExecute({ succeeded: true }), { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    expect(actor.getSnapshot().value).toBe('CREATED');
    actor.send({ type: 'START' });
    expect(actor.getSnapshot().value).toBe('INTELLIGENCE_GATE');
  });

  it('loops back to PLAN when context is insufficient, then proceeds when sufficient', () => {
    const actor = createActor(machineWithMockExecute({ succeeded: true }), { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    actor.send({ type: 'START' });
    actor.send({ type: 'CONTEXT_INSUFFICIENT' });
    expect(actor.getSnapshot().value).toBe('INTELLIGENCE_GATE');
    actor.send({ type: 'CONTEXT_SUFFICIENT' });
    expect(actor.getSnapshot().value).toBe('EXECUTION_DECISION');
  });

  it('reaches COMPLETE via SELF_EXECUTE -> VERIFY -> DOD_MET when execution succeeds', async () => {
    const actor = createActor(machineWithMockExecute({ succeeded: true }), { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    actor.send({ type: 'START' });
    actor.send({ type: 'CONTEXT_SUFFICIENT' });
    actor.send({ type: 'SELF_EXECUTE' });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('VERIFY'));
    actor.send({ type: 'DOD_MET' });
    expect(actor.getSnapshot().value).toBe('COMPLETE');
    expect(actor.getSnapshot().status).toBe('done');
  });

  it('re-plans when DoD is not met after verification', async () => {
    const actor = createActor(machineWithMockExecute({ succeeded: true }), { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    actor.send({ type: 'START' });
    actor.send({ type: 'CONTEXT_SUFFICIENT' });
    actor.send({ type: 'SELF_EXECUTE' });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('VERIFY'));
    actor.send({ type: 'DOD_NOT_MET' });
    expect(actor.getSnapshot().value).toBe('INTELLIGENCE_GATE');
  });

  it('carries the execution result into context on SELF_EXECUTE completion', async () => {
    const actor = createActor(machineWithMockExecute({ succeeded: false }), { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    actor.send({ type: 'START' });
    actor.send({ type: 'CONTEXT_SUFFICIENT' });
    actor.send({ type: 'SELF_EXECUTE' });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('VERIFY'));
    expect(actor.getSnapshot().context.lastResult?.succeeded).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- node-machine.test`
Expected: FAIL — `nodeMachine.provide` errors because `executeStep` isn't a declared actor yet, and `context.lastResult` doesn't exist.

- [ ] **Step 3: Update `node-machine.ts`**

```ts
// src/lifecycle/node-machine.ts
import { setup, fromPromise, assign } from 'xstate';
import type { ExecuteStepResult } from '../execution/execute-step.js';

export interface NodeMachineContext {
  nodeId: string;
  goal: string;
  lastResult?: ExecuteStepResult;
}

export type NodeMachineEvent =
  | { type: 'START' }
  | { type: 'CONTEXT_SUFFICIENT' }
  | { type: 'CONTEXT_INSUFFICIENT' }
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
    // Placeholder — production wiring (node-actor-manager.ts) `.provide()`s the
    // real execute-step-backed actor; tests `.provide()` a mock. This default
    // exists only so the machine type-checks and can be inspected in isolation.
    executeStep: fromPromise<ExecuteStepResult, { nodeId: string; goal: string }>(async () => {
      throw new Error('executeStep actor not provided — call nodeMachine.provide({ actors: { executeStep: ... } })');
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
      on: {
        CONTEXT_SUFFICIENT: 'EXECUTION_DECISION',
        CONTEXT_INSUFFICIENT: 'PLAN',
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
        onDone: {
          target: 'VERIFY',
          actions: assign({ lastResult: ({ event }) => event.output }),
        },
        onError: {
          target: 'VERIFY',
          actions: assign({
            lastResult: ({ event }) => ({ succeeded: false, message: String(event.error), events: [] }),
          }),
        },
      },
    },
    DELEGATE: { always: 'VERIFY' },
    VERIFY: {
      on: {
        DOD_MET: 'COMPLETE',
        DOD_NOT_MET: 'INTELLIGENCE_GATE',
      },
    },
    COMPLETE: { type: 'final' },
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- node-machine.test`
Expected: PASS — 5 tests passed.

- [ ] **Step 5: Update `node-actor-manager.ts` to provide the real `executeStep` actor**

```ts
// src/lifecycle/node-actor-manager.ts
import { createActor, fromPromise, type Actor } from 'xstate';
import { nodeMachine, type NodeMachineEvent } from './node-machine.js';
import type { Db } from '../db/client.js';
import { updateNodeState } from '../db/queries/nodes.js';
import { appendEvent } from '../db/queries/events.js';
import { getNode } from '../db/queries/nodes.js';
import { executeStep } from '../execution/execute-step.js';
import { claudeCodeAdapter } from '../adapters/claude-code.js';

// ponytail: in-process actor registry, lost on daemon restart. Rehydrate from the
// event log if nodes need to survive a restart.
const actors = new Map<string, Actor<typeof nodeMachine>>();

const NAMESPACE = process.env.ORG_K8S_NAMESPACE ?? 'org-exec';

function productionMachine(db: Db, nodeId: string) {
  return nodeMachine.provide({
    actors: {
      executeStep: fromPromise(async ({ input }) => {
        const node = getNode(db, nodeId);
        return executeStep({
          nodeId,
          goal: input.goal,
          namespace: NAMESPACE,
          worktreePath: process.env.ORG_WORKTREE_PATH ?? `/tmp/org-worktrees/${nodeId}`,
          credentials: {},
          adapter: claudeCodeAdapter,
        });
      }),
    },
  });
}

export function startNodeActor(db: Db, nodeId: string, goal: string): void {
  const actor = createActor(productionMachine(db, nodeId), { input: { nodeId, goal } });
  actor.subscribe((snapshot) => {
    const now = new Date().toISOString();
    updateNodeState(db, nodeId, String(snapshot.value), now);
    appendEvent(db, { nodeId, type: 'state.transition', payload: { state: snapshot.value }, createdAt: now });
  });
  actor.start();
  actors.set(nodeId, actor);
  actor.send({ type: 'START' });
}

export function getNodeActor(nodeId: string): Actor<typeof nodeMachine> | undefined {
  return actors.get(nodeId);
}

export function sendToNode(nodeId: string, event: NodeMachineEvent): void {
  const actor = actors.get(nodeId);
  if (!actor) throw new Error(`No active actor for node ${nodeId}`);
  actor.send(event);
}
```

- [ ] **Step 6: Run the full existing actor-manager test to confirm it still passes unmodified**

Run: `npm test -- node-actor-manager.test`
Expected: PASS — the existing 2 tests still pass; `startNodeActor` still only drives the machine as far as `EXECUTION_DECISION` in that test (it never sends `SELF_EXECUTE`), so the real `executeStep` wiring is never invoked by this particular test — confirm that's still true by inspection, not just by the green run, since a silent K8s call in a unit test would be a real regression.

- [ ] **Step 7: Commit**

```bash
git add src/lifecycle
git commit -m "feat: wire executeStep into SELF_EXECUTE as an invoked XState actor"
```

---

### Task 9: `org doctor` real checks + Node-version fix

**Files:**
- Modify: `src/cli/commands/doctor.ts`

**Interfaces:**
- Consumes: `isClusterReachable`, `ensureLocalCluster` (Task 1), `DoctorCheck`/`runChecks` (Phase 1, unchanged).
- Produces: an updated `CHECKS` array — no other task depends on this one; it's the last task in the phase.

- [ ] **Step 1: Write the failing test for the new checks' logic (the Docker/kind/kubectl detection itself, not `org doctor`'s CLI wiring, which has no automated test in Phase 1 either — this task follows that precedent and verifies manually in Step 4)**

```ts
// src/cli/commands/doctor.test.ts
import { describe, it, expect } from 'vitest';
import { runChecks, type DoctorCheck } from '../../doctor/checks.js';

// Re-declared here to test the exact predicate logic before wiring it into CHECKS,
// since CHECKS itself is a private array inside doctor.ts.
function nodeVersionCheck(major: number): DoctorCheck {
  return {
    name: 'Node.js version',
    run: async () => (major >= 22
      ? { ok: true, message: `v${major}.x.x` }
      : { ok: false, message: `v${major}.x.x — need >= 22` }),
  };
}

describe('doctor Node version check (corrected floor)', () => {
  it('passes for Node 22', async () => {
    expect(await runChecks([nodeVersionCheck(22)])).toBe(true);
  });

  it('fails for Node 20 — this is the bug found in Phase 1 review: it used to pass', async () => {
    expect(await runChecks([nodeVersionCheck(20)])).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- doctor.test`
Expected: FAIL on the second test if run against the current (unfixed) `>= 20` logic — copy this predicate change into `doctor.ts` in the next step.

- [ ] **Step 3: Update `src/cli/commands/doctor.ts`**

```ts
// src/cli/commands/doctor.ts
import type { Command } from 'commander';
import { runChecks, type DoctorCheck } from '../../doctor/checks.js';
import { isClusterReachable, ensureLocalCluster } from '../../k8s/kind.js';
import { execa } from 'execa';

async function binaryPresent(bin: string, versionFlag = '--version'): Promise<boolean> {
  try {
    await execa(bin, [versionFlag]);
    return true;
  } catch {
    return false;
  }
}

const CHECKS: DoctorCheck[] = [
  {
    name: 'Node.js version',
    run: async () => {
      const major = Number(process.versions.node.split('.')[0]);
      // Corrected floor: package.json's engines.node is >=22 (execa/better-sqlite3
      // require it — see the "ci: run on Node 22" commit) but this check still said
      // >=20 until this fix, so it silently passed on unsupported versions.
      return major >= 22
        ? { ok: true, message: `v${process.versions.node}` }
        : { ok: false, message: `v${process.versions.node} — need >= 22` };
    },
  },
  {
    name: 'Docker',
    run: async () => (await binaryPresent('docker'))
      ? { ok: true, message: 'installed' }
      : { ok: false, message: 'not found — install Docker (required for the local kind cluster)' },
  },
  {
    name: 'kind',
    run: async () => (await binaryPresent('kind'))
      ? { ok: true, message: 'installed' }
      : { ok: false, message: 'not found — install kind: https://kind.sigs.k8s.io/docs/user/quick-start/' },
  },
  {
    name: 'kubectl',
    run: async () => (await binaryPresent('kubectl'))
      ? { ok: true, message: 'installed' }
      : { ok: false, message: 'not found — install kubectl: https://kubernetes.io/docs/tasks/tools/' },
  },
  {
    name: 'Kubernetes cluster',
    run: async () => {
      if (await isClusterReachable()) return { ok: true, message: 'reachable' };
      try {
        await ensureLocalCluster();
        return { ok: true, message: 'bootstrapped a local kind cluster' };
      } catch (err) {
        return { ok: false, message: `could not reach or bootstrap a cluster: ${String(err)}` };
      }
    },
  },
];

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check that required dependencies are present')
    .action(async () => {
      const ok = await runChecks(CHECKS);
      process.exitCode = ok ? 0 : 1;
    });
}
```

- [ ] **Step 4: Rebuild and manually verify**

Run: `npm run build && node dist/cli/index.js doctor`
Expected: five checks print; Node.js version and Docker show ok (Docker is present in most dev environments); kind/kubectl/cluster show failures with actionable install links if those binaries aren't installed yet — confirm the messages are genuinely useful, not just "false".

- [ ] **Step 5: Run the automated test**

Run: `npm test -- doctor.test`
Expected: PASS — 2 tests passed, confirming the floor is genuinely `>=22` now.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/doctor.ts src/cli/commands/doctor.test.ts
git commit -m "fix: correct org doctor Node version floor to >=22, add Docker/kind/kubectl/cluster checks"
```

---

## Phase 2 exit checklist

Before moving to Phase 3 (invoke superpowers:verification-before-completion, not just this list from memory):

- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes — all Phase 1 tests still green, plus every Phase 2 unit test; cluster-dependent integration tests either pass against a real `kind` cluster or report as cleanly skipped, never silently absent.
- [ ] Manually run `node dist/cli/index.js doctor` on a machine with Docker+kind+kubectl installed and confirm all 5 checks pass, including a real cluster bootstrap.
- [ ] Manually run `org run "<a goal Claude Code can trivially complete>"` end-to-end and confirm `org tree`/inspecting the `events` table shows a real dispatched Job's structured output — this is the actual proof this phase works, not just green tests.
- [ ] CI is green (note: the `kind`-backed integration job for CI itself is Phase 5's task — Phase 2's CI will only exercise the non-cluster unit tests unless the executing environment happens to have kind, per the skip guard).
- [ ] Invoke superpowers:requesting-code-review, then superpowers:finishing-a-development-branch.

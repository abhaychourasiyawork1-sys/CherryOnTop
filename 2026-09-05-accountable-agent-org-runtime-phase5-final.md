# Accountable Agent Organization Runtime — Phase 5 (Final): Real Execution & Ready-to-Use Product

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Before starting:** create an isolated workspace via superpowers:using-git-worktrees, branched from `main` at commit `55b073f` (Phase 3+4 merged).
>
> **Skills to invoke during execution:**
> - superpowers:test-driven-development governs every task's step rhythm.
> - superpowers:systematic-debugging — invoke if the real Claude Code dispatch (Task 7) fails in a way that isn't obviously the credential or network fix — this is the first task where a genuine third-party binary runs inside the sandbox, and failures can come from the image, the network policy, or Claude Code itself.
> - superpowers:requesting-code-review — invoke once Task 9 (full manual verification) passes, before merging.
> - superpowers:verification-before-completion — invoke before declaring this done: the acceptance test is a real `org run` against a real throwaway repo producing a real Claude Code result, not a green test suite alone.
> - superpowers:finishing-a-development-branch — invoke after the review.

**Goal:** Take the proven-but-stopgapped Phase 3+4 system and make it a real, usable product: a genuine Claude Code invocation running inside the sandbox, against your actual repository, with your actual API key, reachable as a normal `org` command on your machine — plus fix the three gaps Phase 3+4's own code review left explicitly open.

**Architecture:** No new architectural layer — this phase retires stopgaps. The `stopgapAdapter`/`ORG_RUNNER_IMAGE` escape hatch stays for tests but is no longer the default path; a real `cherryontop-runner` image (built locally, loaded into `kind` — no registry needed for local use) and a real `ANTHROPIC_API_KEY`-backed Secret take over. The kind cluster gains a host-directory mount so a Job can actually see your repository, and `org run` gains a `--repo` flag to say which one.

**Tech Stack additions:** none — everything needed (Docker, the K8s client, execa) already exists in the dependency tree.

**Spec:** [accountable_agent_organization_runtime_handoff.html](../../../accountable_agent_organization_runtime_handoff.html) §7 (adapters), §18 (security substrate); [2026-09-05-accountable-agent-org-runtime-v0.1.md](2026-09-05-accountable-agent-org-runtime-v0.1.md)'s original Phase 5 scope section, superseded by this plan where they conflict (this plan is the current source of truth for what "done" means).

---

## Phase 3+4 gaps and bugs found during verification (2026-09-05)

Phase 3+4 was independently re-verified on `main` (commit `55b073f`) before writing this plan: typecheck clean, **100/100 tests pass across 36 files with zero skips** against the live `kind` cluster, and every behavior was walked manually end-to-end — not just the automated suite:

- **Self-execute path**: `org run "fix a typo"` → real K8s Job dispatch → `COMPLETE` autonomously, decision breakdown printed via `org decision`, commitment closed via `org commitment`, zero leaked cluster resources.
- **Delegate path**: `org run "<long goal>" --spawn --budget 5 --max-children 2` → root delegates to a real child, which delegates to a real grandchild (depth-bounded correctly by `childAuthority`), grandchild self-executes when it runs out of spawn authority, all three reach `COMPLETE`, zero leaked resources.
- **Escalate/approve path**: `org run "<long goal>" --spawn --budget 0.1` → `ESCALATE` → `WAIT_APPROVAL` → `org approve <id>` → budget genuinely lifted → `DELEGATE` → `COMPLETE`.
- **Escalate/reject path**: same, but `org reject <id>` → `FAILED`, and re-resolving an already-resolved approval is correctly refused with a clear error.

Phase 3+4's own commit history already includes an exceptionally thorough self-review (`2465b87`) that found and fixed real issues before this verification even started: unit tests were dispatching real Jobs (fixed via a `startNode` dependency-injection seam), approval resolution could strand a node if resolved before checking the actor existed (fixed — notify-then-resolve, with an explicit actor-liveness check), finished actors leaked in the in-process registry forever (fixed — evicted on terminal state), delegation had no depth bound or unaffordable-spawn-authority gate (fixed — extracted as pure, unit-tested `childAuthority()`), and commitments were never actually closed out on completion (fixed). That same review documented one new gap it found but didn't fix. Combined with what my own manual walkthrough surfaced, three gaps carry into this plan:

| # | Gap | Where | Fixed here? |
|---|---|---|---|
| **G6** (found by Phase 3+4's own review) | The G2 fix (excluding RFC1918 ranges from the egress allowlist) also excludes `10.96.0.0/16` — kind's default service CIDR — so `kube-dns` is unreachable. A runner can only reach literal IPs over :443, not hostnames. Harmless while nothing real dispatches; blocking the moment a real Claude Code invocation needs to resolve `api.anthropic.com`. | `src/execution/execute-step.ts` | **Yes — Task 1** |
| **G7** (found during my manual verification) | There is no CLI-native way to discover a pending approval's id. The desktop notification includes it, but if it's missed, dismissed, or the daemon runs headless/remote, the only recovery is querying SQLite directly. | `src/cli` (missing command) | **Yes — Task 2** |
| **G4** (carried from Phase 2's verification, still open) | `executeStep` is always called with `credentials: {}`. A real Claude Code invocation has no auth and fails immediately. | `src/lifecycle/node-actor-manager.ts` | **Yes — Task 3** |

**G5** (hostPath only resolves inside the kind node's own filesystem, not the real host) is also fixed in this plan — Task 5 — since it's a hard blocker for operating on a real repository, which is this entire phase's point. It was tracked as Phase 5's job from the start; this is that task.

---

### Task 1 (gap fix G6): DNS egress for the sandbox

**Files:**
- Modify: `src/k8s/network-policy.ts`, `src/k8s/kind.ts`, `src/execution/execute-step.ts`
- Test: `src/k8s/network-policy.test.ts` (extend), `src/k8s/kind.test.ts` (extend)

**Interfaces:**
- Produces: `buildEgressAllowlistPolicy` gains an optional `extraEgressRules` parameter; `getKubeDnsClusterIp(): Promise<string>` in `kind.ts` — consumed by `execute-step.ts`.

- [ ] **Step 1: Write the failing test for the policy builder change**

```ts
// src/k8s/network-policy.test.ts — add this test
it('appends extra raw egress rules verbatim, for cases the simple ip/ports shape cannot express', () => {
  const policy = buildEgressAllowlistPolicy('n1', [{ ip: '0.0.0.0/0', ports: [443] }], [
    { to: [{ ipBlock: { cidr: '10.96.0.10/32' } }], ports: [{ port: 53, protocol: 'UDP' }, { port: 53, protocol: 'TCP' }] },
  ]);
  expect(policy.spec?.egress).toHaveLength(2);
  expect(policy.spec?.egress?.[1].ports?.[0].protocol).toBe('UDP');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- network-policy.test`
Expected: FAIL — `buildEgressAllowlistPolicy` doesn't accept a third argument yet.

- [ ] **Step 3: Update `network-policy.ts`**

```ts
// src/k8s/network-policy.ts — change the function signature only
import type { V1NetworkPolicy, V1NetworkPolicyEgressRule } from '@kubernetes/client-node';

export function buildEgressAllowlistPolicy(
  nodeId: string,
  allowedTargets: { ip: string; ports: number[]; except?: string[] }[],
  extraEgressRules: V1NetworkPolicyEgressRule[] = [],
): V1NetworkPolicy {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name: `org-egress-${nodeId}` },
    spec: {
      podSelector: { matchLabels: { 'org.nodeId': nodeId } },
      policyTypes: ['Ingress', 'Egress'],
      ingress: [],
      egress: [
        ...allowedTargets.map((target) => ({
          to: [{ ipBlock: { cidr: target.ip, ...(target.except ? { except: target.except } : {}) } }],
          ports: target.ports.map((port) => ({ port, protocol: 'TCP' as const })),
        })),
        ...extraEgressRules,
      ],
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- network-policy.test`
Expected: PASS — both the new test and every pre-existing one (the parameter is optional, defaulting to `[]`).

- [ ] **Step 5: Write the failing test for `getKubeDnsClusterIp`**

```ts
// src/k8s/kind.test.ts — add this describe block
import { getKubeDnsClusterIp } from './kind.js';

describe.skipIf(!(await isClusterAvailable()))('getKubeDnsClusterIp', () => {
  it('returns a real IP address from the running cluster', async () => {
    await ensureLocalCluster();
    const ip = await getKubeDnsClusterIp();
    expect(ip).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
  }, 60_000);
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `sg docker -c "npm test -- kind.test"`
Expected: FAIL — `getKubeDnsClusterIp` doesn't exist.

- [ ] **Step 7: Write `getKubeDnsClusterIp` in `kind.ts`**

```ts
// src/k8s/kind.ts — add this function
export async function getKubeDnsClusterIp(): Promise<string> {
  const { stdout } = await execa('kubectl', [
    'get', 'svc', 'kube-dns', '-n', 'kube-system', '-o', 'jsonpath={.spec.clusterIP}',
  ]);
  return stdout.trim();
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `sg docker -c "npm test -- kind.test"`
Expected: PASS.

- [ ] **Step 9: Wire the DNS rule into `execute-step.ts`**

```ts
// src/execution/execute-step.ts — replace the DEFAULT_EGRESS_ALLOWLIST comment/constant
// and add the DNS rule at call time (the cluster's DNS IP can't be a module-level
// constant — it's only known once a cluster exists).
import { getKubeDnsClusterIp } from '../k8s/kind.js';

// G6 fix: excluding RFC1918 ranges (G2) also excluded kind's service CIDR, so
// kube-dns was unreachable — a runner could only reach literal IPs, not
// hostnames. This is the narrow fix: allow DNS specifically, to the cluster's
// actual DNS service IP, not by widening the RFC1918 exclusion itself.
const DEFAULT_EGRESS_ALLOWLIST = [
  {
    ip: '0.0.0.0/0',
    ports: [443],
    except: ['169.254.169.254/32', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
  },
];

export async function executeStep(
  input: ExecuteStepInput,
  deps: Partial<ExecuteStepDeps> = {},
): Promise<ExecuteStepResult> {
  const d = { ...defaultDeps, ...deps };

  const secretName = await d.createEphemeralSecret(input.nodeId, input.credentials, input.namespace);
  try {
    const dnsIp = await getKubeDnsClusterIp();
    const policy = buildEgressAllowlistPolicy(input.nodeId, DEFAULT_EGRESS_ALLOWLIST, [
      { to: [{ ipBlock: { cidr: `${dnsIp}/32` } }], ports: [{ port: 53, protocol: 'UDP' }, { port: 53, protocol: 'TCP' }] },
    ]);
    await d.applyNetworkPolicy(policy, input.namespace);

    // ... rest of the function unchanged ...
```

- [ ] **Step 10: Run the full suite**

Run: `sg docker -c "npm test"`
Expected: PASS — 100+ tests.

- [ ] **Step 11: Commit**

```bash
git add src/k8s/network-policy.ts src/k8s/network-policy.test.ts src/k8s/kind.ts src/k8s/kind.test.ts src/execution/execute-step.ts
git commit -m "fix: allow DNS egress to the cluster's real kube-dns IP (gap G6)"
```

---

### Task 2 (gap fix G7): `org approvals` — list pending approvals

**Files:**
- Create: `src/cli/commands/approvals.ts`
- Modify: `src/db/queries/approvals.ts`, `src/server/routers/node.ts`, `src/cli/index.ts`
- Test: `src/db/queries/approvals.test.ts` (extend), `src/server/routers/node.test.ts` (new)

**Interfaces:**
- Produces: `listPendingApprovals(db: Db): ApprovalRecord[]`, `node.listPendingApprovals` tRPC query, `org approvals` CLI command.

- [ ] **Step 1: Write the failing query test**

```ts
// src/db/queries/approvals.test.ts — add this test
it('lists all pending approvals across every node', () => {
  const db = createDb(TEST_DB);
  insertApproval(db, { id: 'a1', nodeId: 'n1', reason: 'x', status: 'pending', createdAt: 't0' });
  insertApproval(db, { id: 'a2', nodeId: 'n2', reason: 'y', status: 'pending', createdAt: 't0' });
  insertApproval(db, { id: 'a3', nodeId: 'n3', reason: 'z', status: 'approved', createdAt: 't0', resolvedAt: 't1' });
  const pending = listPendingApprovals(db);
  expect(pending).toHaveLength(2);
  expect(pending.map((a) => a.id).sort()).toEqual(['a1', 'a2']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- approvals.test`
Expected: FAIL — `listPendingApprovals` doesn't exist.

- [ ] **Step 3: Add it to `db/queries/approvals.ts`**

```ts
// src/db/queries/approvals.ts — add this export
export function listPendingApprovals(db: Db): ApprovalRecord[] {
  return db.select().from(approvals).where(eq(approvals.status, 'pending')).all() as ApprovalRecord[];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- approvals.test`
Expected: PASS.

- [ ] **Step 5: Write the failing router test**

```ts
// src/server/routers/node.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { buildServer } from '../app.js';

const TEST_DB = './test-node-router.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

describe('node router — listPendingApprovals', () => {
  it('returns an empty array when nothing is pending', async () => {
    const app = buildServer(TEST_DB, () => {});
    const response = await app.inject({ method: 'GET', url: '/trpc/node.listPendingApprovals' });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).result.data).toEqual([]);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test -- node.test` (from `src/server/routers/`)
Expected: FAIL — 404, procedure doesn't exist.

- [ ] **Step 7: Add the procedure to `node.ts`**

```ts
// src/server/routers/node.ts — add the import and the procedure
import { resolveApproval, getApproval, listPendingApprovals } from '../../db/queries/approvals.js';

// ... inside nodeRouter's object, alongside `tree`:
listPendingApprovals: publicProcedure.query(({ ctx }) => listPendingApprovals(ctx.db)),
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npm test -- node.test`
Expected: PASS.

- [ ] **Step 9: Write and register `org approvals`**

```ts
// src/cli/commands/approvals.ts
import type { Command } from 'commander';
import { createDaemonClient } from '../../daemon/client.js';

export function registerApprovalsCommand(program: Command): void {
  program
    .command('approvals')
    .description('List pending authority-boundary escalations awaiting approval')
    .action(async () => {
      const client = createDaemonClient();
      const pending = await client.node.listPendingApprovals.query();
      if (pending.length === 0) {
        console.log('No pending approvals.');
        return;
      }
      for (const approval of pending) {
        console.log(`${approval.id}  node=${approval.nodeId}  ${approval.reason}`);
        console.log(`  org approve ${approval.id}   |   org reject ${approval.id}`);
      }
    });
}
```

```ts
// src/cli/index.ts
import { registerApprovalsCommand } from './commands/approvals.js';
// ...
registerApprovalsCommand(program);
```

- [ ] **Step 10: Rebuild and verify manually**

Run: `npm run build && node dist/cli/index.js approvals`
Expected: prints "No pending approvals." (or the real list, if any node is currently in `WAIT_APPROVAL`).

- [ ] **Step 11: Commit**

```bash
git add src/db/queries/approvals.ts src/db/queries/approvals.test.ts src/server/routers/node.ts src/server/routers/node.test.ts src/cli/commands/approvals.ts src/cli/index.ts
git commit -m "feat: add org approvals command to list pending escalations (gap G7)"
```

---

### Task 3 (gap fix G4): Real credentials — `ANTHROPIC_API_KEY`

**Files:**
- Modify: `src/lifecycle/node-actor-manager.ts`, `src/cli/commands/doctor.ts`
- Test: `src/cli/commands/doctor.test.ts` (extend)

**Interfaces:**
- Produces: an `Anthropic API key` doctor check; `executeStep` is called with a real `ANTHROPIC_API_KEY` credential when running the real (non-stopgap) adapter.

This is deliberately the simplest correct fix, not the spec's originally-envisioned OAuth-session relay: the spec's design (§18) is "relay the user's existing local credentials," aimed at reusing a Claude subscription; that requires understanding Claude Code's session/OAuth storage format, which is undocumented API surface and a real research task on its own. An explicit `ANTHROPIC_API_KEY` environment variable is what Claude Code itself already supports as a first-class non-interactive auth path, needs no reverse-engineering, and unblocks real usage today. The OAuth relay stays tracked as a stretch item (bottom of this document), not silently abandoned.

- [ ] **Step 1: Write the failing doctor check test**

```ts
// src/cli/commands/doctor.test.ts — add this describe block
describe('Anthropic API key check', () => {
  it('passes when ANTHROPIC_API_KEY is set', async () => {
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-value';
    try {
      const check = CHECKS.find((c) => c.name === 'Anthropic API key');
      expect(check).toBeDefined();
      expect((await check!.run()).ok).toBe(true);
    } finally {
      if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = original;
    }
  });

  it('fails when ANTHROPIC_API_KEY is unset', async () => {
    const original = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const check = CHECKS.find((c) => c.name === 'Anthropic API key');
      expect((await check!.run()).ok).toBe(false);
    } finally {
      if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- doctor.test`
Expected: FAIL — no check named `'Anthropic API key'` exists yet.

- [ ] **Step 3: Add the check to `doctor.ts`**

```ts
// src/cli/commands/doctor.ts — add to the CHECKS array
{
  name: 'Anthropic API key',
  run: async () => process.env.ANTHROPIC_API_KEY
    ? { ok: true, message: 'set' }
    : { ok: false, message: 'ANTHROPIC_API_KEY is not set — export it before `org run` (get one at https://console.anthropic.com/settings/keys)' },
},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- doctor.test`
Expected: PASS.

- [ ] **Step 5: Wire the real credential into `executeStep`'s call site**

```ts
// src/lifecycle/node-actor-manager.ts — replace the credentials line inside the executeStep actor
executeStep: fromPromise(async ({ input }) => {
  const result = await executeStep({
    nodeId,
    goal: input.goal,
    namespace: NAMESPACE,
    worktreePath: process.env.ORG_WORKTREE_PATH ?? `/tmp/org-worktrees/${nodeId}`,
    // G4 fix: was always {} (empty Secret, no real invocation could authenticate).
    // A real ANTHROPIC_API_KEY, when present, becomes the container's env var of
    // the same name via envFrom — Claude Code reads it natively, no extra wiring.
    credentials: process.env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : {},
    adapter: runnerImageOverride() ? stopgapAdapter : claudeCodeAdapter,
    image: runnerImageOverride(),
  });
  // ... rest unchanged ...
```

- [ ] **Step 6: Run the full suite**

Run: `sg docker -c "npm test"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/doctor.ts src/cli/commands/doctor.test.ts src/lifecycle/node-actor-manager.ts
git commit -m "fix: relay ANTHROPIC_API_KEY into the ephemeral Secret (gap G4)"
```

---

### Task 4: The real runner image

**Files:**
- Create: `Dockerfile`, `scripts/build-runner-image.sh`
- Modify: `src/execution/execute-step.ts` (bump `RUNNER_IMAGE`'s tag scheme), `src/cli/commands/doctor.ts`

**Interfaces:**
- Produces: a `cherryontop-runner:local` Docker image, built and loaded into the `org-local` kind cluster — no GHCR account or push needed for local use (that's the stretch item at the bottom of this document).

- [ ] **Step 1: Write the Dockerfile**

```dockerfile
# Dockerfile
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

# job-manifest.ts pins runAsUser: 1000; node:22-slim already ships a uid-1000
# "node" user, so nothing further is needed for the security context to work.
USER node
WORKDIR /workspace
```

- [ ] **Step 2: Write the build/load script**

```bash
#!/usr/bin/env bash
# scripts/build-runner-image.sh
set -euo pipefail

IMAGE_TAG="cherryontop-runner:local"
CLUSTER_NAME="org-local"

echo "Building $IMAGE_TAG..."
docker build -t "$IMAGE_TAG" .

echo "Loading $IMAGE_TAG into kind cluster $CLUSTER_NAME..."
kind load docker-image "$IMAGE_TAG" --name "$CLUSTER_NAME"

echo "Done. $IMAGE_TAG is available inside the cluster."
```

```bash
chmod +x scripts/build-runner-image.sh
```

- [ ] **Step 3: Run it manually and verify**

Run: `sg docker -c "./scripts/build-runner-image.sh"`
Expected: image builds, `kind load docker-image` reports success.

Verify: `sg docker -c "docker exec org-local-control-plane crictl images | grep cherryontop-runner"` shows the image present inside the cluster's node.

- [ ] **Step 4: Point `execute-step.ts` at the local tag by default**

```ts
// src/execution/execute-step.ts — replace the RUNNER_IMAGE constant
// Local tag, not a registry reference: no GHCR account is needed to use this
// tool on your own machine. Publishing a real ghcr.io image for others to pull
// is the stretch item at the bottom of the final plan, not required for this.
const RUNNER_IMAGE = 'cherryontop-runner:local';
```

- [ ] **Step 5: Add an `org doctor` check for the image's presence**

```ts
// src/cli/commands/doctor.ts — add to the CHECKS array, after the cluster check
{
  name: 'Runner image',
  run: async () => {
    try {
      const { stdout } = await execa('sh', [
        '-c',
        `docker exec org-local-control-plane crictl images -o json 2>/dev/null | grep -c cherryontop-runner || true`,
      ]);
      return stdout.trim() !== '0' && stdout.trim() !== ''
        ? { ok: true, message: 'loaded into the cluster' }
        : { ok: false, message: 'not loaded — run ./scripts/build-runner-image.sh' };
    } catch (err) {
      return { ok: false, message: `could not check — run ./scripts/build-runner-image.sh (${firstLine(err)})` };
    }
  },
},
```

- [ ] **Step 6: Rebuild and verify**

Run: `npm run build && sg docker -c "node dist/cli/index.js doctor"`
Expected: 7 checks now, all green (assuming Task 3's `ANTHROPIC_API_KEY` is exported and Step 3's image load succeeded).

- [ ] **Step 7: Commit**

```bash
git add Dockerfile scripts/build-runner-image.sh src/execution/execute-step.ts src/cli/commands/doctor.ts
git commit -m "feat: add the real cherryontop-runner image, built and loaded locally"
```

---

### Task 5 (gap fix G5): kind cluster host-directory mount

**Files:**
- Modify: `src/k8s/kind.ts`
- Test: `src/k8s/kind.test.ts` (extend)

**Interfaces:**
- Produces: `ensureLocalCluster()` now creates the cluster (or recreates it, if it exists without the mount) with `$HOME` bind-mounted at `/host` inside the kind node — consumed by Task 6's `--repo` flag.

**Why `$HOME` and not something narrower**: kind's `extraMounts` are declared once, at cluster-creation time, and can't be added to a running cluster. A fixed, single mount root is required so `org run --repo <any path under your home directory>` works without recreating the cluster per-repo. `$HOME` is broad, but this is a disposable local cluster on your own machine, not a shared or multi-tenant one — the sandboxing this project builds (per-Job Secrets, egress policy, non-root execution) protects against a compromised *runner*, which is a different threat than "can the tool see files you pointed it at." Documented here, not silently assumed.

- [ ] **Step 1: Write the failing test**

```ts
// src/k8s/kind.test.ts — add this describe block
describe.skipIf(!(await isClusterAvailable()))('ensureLocalCluster host mount', () => {
  it('mounts the home directory at /host inside the control-plane node', async () => {
    await ensureLocalCluster();
    const { stdout } = await execa('docker', [
      'inspect', 'org-local-control-plane', '--format', '{{json .Mounts}}',
    ]);
    const mounts = JSON.parse(stdout) as { Source: string; Destination: string }[];
    expect(mounts.some((m) => m.Destination === '/host')).toBe(true);
  }, 180_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `sg docker -c "npm test -- kind.test"`
Expected: FAIL — the currently-running `org-local` cluster predates this change and has no `/host` mount.

- [ ] **Step 3: Write the mount-detection and recreation logic**

```ts
// src/k8s/kind.ts — replace ensureLocalCluster and add the two helpers above it
import os from 'node:os';
import { writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const HOST_MOUNT_PATH = '/host';

async function hasHostMount(): Promise<boolean> {
  try {
    const { stdout } = await execa('docker', ['inspect', `${CLUSTER_NAME}-control-plane`, '--format', '{{json .Mounts}}']);
    const mounts = JSON.parse(stdout) as { Destination: string }[];
    return mounts.some((m) => m.Destination === HOST_MOUNT_PATH);
  } catch {
    return false;
  }
}

async function createClusterWithHostMount(): Promise<void> {
  const configPath = path.join(os.tmpdir(), `org-kind-config-${Date.now()}.yaml`);
  const config = [
    'kind: Cluster',
    'apiVersion: kind.x-k8s.io/v1alpha4',
    'nodes:',
    '- role: control-plane',
    '  extraMounts:',
    `  - hostPath: ${os.homedir()}`,
    `    containerPath: ${HOST_MOUNT_PATH}`,
  ].join('\n');
  writeFileSync(configPath, config);
  try {
    await execa('kind', ['create', 'cluster', '--name', CLUSTER_NAME, '--config', configPath], { timeout: 120_000 });
  } finally {
    unlinkSync(configPath);
  }
}

export async function ensureLocalCluster(): Promise<void> {
  const alreadyUp = (await hasExistingKubeconfigContext()) && (await isClusterReachable());

  if (alreadyUp && !(await hasHostMount())) {
    // A disposable local dev cluster — recreating it is the correct fix, not a
    // workaround. kind cannot add extraMounts to a cluster after creation.
    console.log('Existing kind cluster lacks the /host mount — recreating it...');
    await execa('kind', ['delete', 'cluster', '--name', CLUSTER_NAME]).catch(() => {});
    await createClusterWithHostMount();
  } else if (!alreadyUp) {
    const { stdout } = await execa('kind', ['get', 'clusters']).catch(() => ({ stdout: '' }));
    if (stdout.split('\n').includes(CLUSTER_NAME)) {
      await execa('kind', ['delete', 'cluster', '--name', CLUSTER_NAME]).catch(() => {});
    }
    await createClusterWithHostMount();
  }

  await ensureNamespace(NAMESPACE);
  await applyDefaultDenyPolicy(NAMESPACE);
}

export function toContainerPath(hostPath: string): string {
  const relative = path.relative(os.homedir(), hostPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${hostPath} is outside the home directory — it is not visible inside the cluster. Move your repository under ${os.homedir()}, or pass --repo with a path under it.`);
  }
  return path.posix.join(HOST_MOUNT_PATH, relative);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `sg docker -c "npm test -- kind.test"`
Expected: PASS — the existing cluster gets deleted and recreated with the mount (this takes ~60-90s, only once).

- [ ] **Step 5: Run the full suite to confirm nothing else broke**

Run: `sg docker -c "npm test"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/k8s/kind.ts src/k8s/kind.test.ts
git commit -m "fix: mount \$HOME at /host in the kind cluster so Jobs can see real repos (gap G5)"
```

---

### Task 6: `org run --repo <path>` — operate on a real repository

**Files:**
- Modify: `src/db/schema.ts`, `src/db/queries/nodes.ts`, `src/schemas/node-contract.ts` is untouched (repoPath is not part of the conceptual goal contract — it's operational plumbing), `src/server/routers/node.ts`, `src/cli/commands/run.ts`, `src/lifecycle/delegate-child.ts`, `src/lifecycle/node-actor-manager.ts`
- Test: `src/db/queries/nodes.test.ts` (extend), `src/k8s/kind.test.ts` (extend — `toContainerPath`)

**Interfaces:**
- Produces: `NodeRecord.repoPath: string | null`; `node.create` accepts an optional `repoPath` (already-validated, already-converted container path — validation happens in the CLI, closest to the user, per D30's "validate at the boundary" pattern); child nodes inherit their parent's `repoPath`.

- [ ] **Step 1: Write the failing test for `toContainerPath` (already written in Task 5's file — this step just adds the rejection case)**

```ts
// src/k8s/kind.test.ts — add this test
it('toContainerPath rejects a path outside the home directory', () => {
  expect(() => toContainerPath('/etc/passwd')).toThrow(/outside the home directory/);
});

it('toContainerPath maps a real subdirectory correctly', () => {
  const sub = `${os.homedir()}/Desktop/CherryOnTop`;
  expect(toContainerPath(sub)).toBe('/host/Desktop/CherryOnTop');
});
```

Run: `npm test -- kind.test`
Expected: FAIL initially (this is additive to Task 5's already-passing suite, but confirm both new assertions specifically before moving on) — then PASS once you confirm `toContainerPath` (already written in Task 5) covers them; if it doesn't, fix it here rather than re-deriving it.

- [ ] **Step 2: Write the failing test for the schema/query change**

```ts
// src/db/queries/nodes.test.ts — add this test
it('stores and retrieves an optional repoPath', () => {
  const db = createDb(TEST_DB);
  insertNode(db, { id: 'n1', parentId: null, goal: 'test', contract: CONTRACT, state: 'CREATED', createdAt: 't0', updatedAt: 't0', repoPath: '/host/my-repo' });
  expect(getNode(db, 'n1')?.repoPath).toBe('/host/my-repo');
});

it('defaults repoPath to null when not given', () => {
  const db = createDb(TEST_DB);
  insertNode(db, { id: 'n2', parentId: null, goal: 'test', contract: CONTRACT, state: 'CREATED', createdAt: 't0', updatedAt: 't0', repoPath: null });
  expect(getNode(db, 'n2')?.repoPath).toBeNull();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- nodes.test`
Expected: FAIL — `NodeRecord` has no `repoPath` field yet.

- [ ] **Step 4: Add the column, regenerate the migration, update the query layer**

```ts
// src/db/schema.ts — add to the `nodes` table definition
export const nodes = sqliteTable('nodes', {
  id: text('id').primaryKey(),
  parentId: text('parent_id'),
  goal: text('goal').notNull(),
  contract: text('contract', { mode: 'json' }).$type<NodeContract>().notNull(),
  state: text('state').notNull(),
  repoPath: text('repo_path'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
```

```bash
npx drizzle-kit generate
```

```ts
// src/db/queries/nodes.ts — update NodeRecord
export interface NodeRecord {
  id: string;
  parentId: string | null;
  goal: string;
  contract: NodeContract;
  state: string;
  repoPath: string | null;
  createdAt: string;
  updatedAt: string;
}
```

(`insertNode`/`getNode`/`listNodes` need no code changes — they already pass the whole record/row through; only the shape they carry changed.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- nodes.test`
Expected: PASS.

- [ ] **Step 6: Thread `repoPath` through `node.create`, `delegate-child.ts`, and execution**

```ts
// src/server/routers/node.ts — update the create procedure's input and insertNode call
create: publicProcedure
  .input(NodeContractSchema.extend({ repoPath: z.string().nullable().default(null) }))
  .mutation(({ input, ctx }) => {
    // Split repoPath back out: it's operational plumbing (Task 6's own note),
    // not part of the conceptual goal contract — persisting it inside the
    // contract JSON too would just be the same fact in two places to keep in
    // sync.
    const { repoPath, ...contract } = input;
    const id = randomUUID();
    const now = new Date().toISOString();
    insertNode(ctx.db, {
      id, parentId: null, goal: contract.goal, contract,
      state: 'CREATED', repoPath, createdAt: now, updatedAt: now,
    });
    // ... commitment insert unchanged ...
    ctx.startNode(ctx.db, id, input.goal);
    return { id };
  }),
```

```ts
// src/lifecycle/node-actor-manager.ts — createChildNode carries the parent's repoPath forward,
// and the executeStep actor uses the node's real repoPath instead of the /tmp fallback
createChildNode: (parentId, goal, budgetUsd, approvedBudgetUsd) => {
  const parent = getNode(db, parentId);
  if (!parent) throw new Error(`Parent node ${parentId} not found`);
  const id = randomUUID();
  const now = new Date().toISOString();
  insertNode(db, {
    id, parentId, goal,
    contract: { ...parent.contract, goal, authority: childAuthority(parent.contract.authority, budgetUsd, approvedBudgetUsd) },
    state: 'CREATED', repoPath: parent.repoPath, createdAt: now, updatedAt: now,
  });
  return id;
},

// ... and in the executeStep actor:
executeStep: fromPromise(async ({ input }) => {
  const node = getNode(db, nodeId);
  const result = await executeStep({
    nodeId,
    goal: input.goal,
    namespace: NAMESPACE,
    // Falls back to the old /tmp path only when no --repo was given (e.g. `org
    // run` without it, or any existing test that predates this task).
    worktreePath: node?.repoPath ?? process.env.ORG_WORKTREE_PATH ?? `/tmp/org-worktrees/${nodeId}`,
    credentials: process.env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : {},
    adapter: runnerImageOverride() ? stopgapAdapter : claudeCodeAdapter,
    image: runnerImageOverride(),
  });
  // ... rest unchanged ...
```

- [ ] **Step 7: Add `--repo` to the CLI**

```ts
// src/cli/commands/run.ts — add the option and validation
import { toContainerPath } from '../../k8s/kind.js';

// ... inside registerRunCommand's chain, add:
.option('--repo <path>', 'local repository the node should operate on (defaults to the current directory)')
.action(async (goal: string, options: { spawn: boolean; budget: number; maxChildren: number; repo?: string }) => {
  const repoPath = toContainerPath(path.resolve(options.repo ?? process.cwd()));
  // ... existing daemon-start/waitForDaemon logic unchanged ...
  const result = await client.node.create.mutate({
    goal,
    definition_of_done: [goal],
    authority: { tools: [], spawn_children: options.spawn, max_child_count: options.maxChildren, budget_usd: options.budget },
    constraints: [],
    repoPath,
  });
  console.log(`Root node created: ${result.id}`);
  console.log(`Operating on: ${options.repo ?? process.cwd()} (mounted at ${repoPath} inside the sandbox)`);
});
```

```ts
// src/cli/commands/run.ts — add this import at the top
import path from 'node:path';
```

- [ ] **Step 8: Rebuild and run the full suite**

Run: `npm run build && sg docker -c "npm test"`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/db/schema.ts src/db/migrations src/db/queries/nodes.ts src/db/queries/nodes.test.ts src/server/routers/node.ts src/lifecycle/node-actor-manager.ts src/cli/commands/run.ts src/k8s/kind.test.ts
git commit -m "feat: add org run --repo, threading a real host repository into the sandbox"
```

---

### Task 7: Manual end-to-end proof with a real Claude Code invocation

**Files:** none — this task is verification, not code. It is the acceptance test for the entire plan.

- [ ] **Step 1: Set up a real throwaway repository**

```bash
mkdir -p ~/org-test-repo && cd ~/org-test-repo
git init
echo "# Test Repo" > README.md
echo "TODO: fix the greeting below" >> README.md
cat > greet.js <<'EOF'
function greet(name) {
  console.log("Helo " + name); // typo: should be "Hello"
}
greet("World");
EOF
git add -A && git commit -m "initial commit"
```

- [ ] **Step 2: Export your real Anthropic API key**

```bash
export ANTHROPIC_API_KEY=sk-ant-your-real-key-here
```

- [ ] **Step 3: Run `org doctor` and confirm every check is green**

Run: `cd ~/org-test-repo && org doctor`
Expected: 7/7 checks pass (Node, Docker, kind, kubectl, cluster, runner image, Anthropic API key).

- [ ] **Step 4: Run a real goal against the real repo**

Run: `org run "fix the typo in greet.js"`
Expected: prints `Root node created: <id>` and `Operating on: /home/you/org-test-repo (mounted at /host/org-test-repo inside the sandbox)`.

- [ ] **Step 5: Watch it complete**

Run: `org watch` in one terminal (or poll `org tree`)
Expected: the node reaches `COMPLETE` within a couple of minutes — real Claude Code startup and one real API round-trip take longer than the busybox stopgap did in every prior test.

- [ ] **Step 6: Verify the actual file was changed**

Run: `cat ~/org-test-repo/greet.js`
Expected: `"Helo"` has become `"Hello"` — a real edit made by a real Claude Code invocation running inside the sandbox, on your real repository.

- [ ] **Step 7: Inspect the evidence trail**

Run: `org decision <id>` and `org commitment <id>`
Expected: a `SELF_EXECUTE` decision with a real score breakdown, and a `completed` commitment.

- [ ] **Step 8: Confirm cleanup**

Run: `sg docker -c "kubectl get jobs,secrets,networkpolicy -n org-exec"`
Expected: only `default-deny-all` remains — no leaked Job, Secret, or per-node policy from the real run.

If any step fails, this is the point to invoke superpowers:systematic-debugging — the most likely failure modes, in order of likelihood, are: `ANTHROPIC_API_KEY` not actually exported in the shell the daemon was started from (pm2 only forwards env vars present at `startDaemon()` time — restart the daemon after exporting it), the runner image not loaded into the *current* cluster (if Task 5 recreated the cluster, re-run `./scripts/build-runner-image.sh`), or the repo path resolving outside `$HOME` (move it, or pass `--repo` explicitly).

---

### Task 8: Global `org` command via `npm link`

**Files:** none — packaging only, no source changes.

- [ ] **Step 1: Link the package globally**

```bash
npm run build
npm link
```

- [ ] **Step 2: Verify `org` is callable from anywhere, not just `dist/cli/index.js`**

Run: `cd /tmp && org daemon status`
Expected: works identically to `node /path/to/CherryOnTop/dist/cli/index.js daemon status` — `npm link` creates a symlink from the global npm bin directory to this package's `bin` entry (already declared in `package.json` since Phase 1).

- [ ] **Step 3: Commit** — nothing to commit; this is a one-time local machine setup step, documented in Task 9's usage guide instead.

---

### Task 9: `USAGE.md` — the simple-steps guide

**Files:**
- Create: `USAGE.md`

- [ ] **Step 1: Write it**

```markdown
# Using the Accountable Agent Organization Runtime

## One-time setup

1. Install Docker, `kind`, and `kubectl` if you don't have them.
2. In this repo: `npm install && npm run build && npm link` — this makes the `org` command available anywhere on your machine.
3. `export ANTHROPIC_API_KEY=sk-ant-...` (add this to your shell profile so you don't retype it) — get a key at https://console.anthropic.com/settings/keys.
4. `org doctor` — this auto-bootstraps a local Kubernetes cluster (`kind`) and builds/loads the sandbox image the first time. Fix anything it reports red, then re-run it.

## Every time you want to use it

1. `cd` into the repository you want the organization to work on. It must live somewhere under your home directory.
2. `org run "<describe what you want done>"` — creates a root accountable node. Add `--spawn --budget <usd> --max-children <n>` if you want it able to delegate subtasks to child nodes (a child costs $1 of budget; below that, it asks you for approval instead of failing silently).
3. `org watch` (in another terminal) — live view of the organization tree as it works.
4. If something needs your approval: `org approvals` lists what's pending, `org approve <id>` or `org reject <id>` resolves it.
5. `org tree` — quick status check any time. `org commitment <id>` / `org decision <id>` — see what it decided and why, with the full score breakdown.
6. When you're done for the session: `org daemon stop`.

## What it actually does

Each node plans, decides for itself whether to do the work directly or delegate it to a child node (based on a transparent scoring formula you can inspect via `org decision`), and executes inside an isolated, network-restricted Kubernetes sandbox — not directly on your machine. Only the repository you point it at is visible inside that sandbox.
```

- [ ] **Step 2: Commit**

```bash
git add USAGE.md
git commit -m "docs: add USAGE.md — the simple-steps guide for running this locally"
```

---

## Phase 5 exit checklist

- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes — full suite, zero skips, against the live cluster.
- [ ] Task 7's manual walkthrough passes in full, with a real Claude Code invocation genuinely editing a real file in a real repository.
- [ ] `org doctor` reports 7/7 green on a freshly-configured machine (Node, Docker, kind, kubectl, cluster, runner image, API key).
- [ ] `USAGE.md` is accurate — follow it verbatim on a second terminal/shell as a final sanity check, don't just proofread it.
- [ ] Invoke superpowers:requesting-code-review, then superpowers:verification-before-completion, then superpowers:finishing-a-development-branch.

---

## Explicitly out of scope here (tracked, not forgotten)

These were in the original Phase 5 scope or emerged during this session, and none block "a complete product ready to use manually" — each is a real, separate follow-up:

- **OAuth-session credential relay** — reusing an existing Claude subscription instead of a separate `ANTHROPIC_API_KEY`. Real research task (undocumented session storage format); the API key path this plan ships is Claude Code's own supported non-interactive auth method, not a workaround.
- **Codex adapter** — a second `RuntimeAdapter` implementation, proving the interface generalizes. Mechanically similar to `claude-code.ts`; low risk, just not needed for a working product with one real harness.
- **GHCR image publishing + CI `kind`-integration job** — turns this from "usable on your machine" into "shareable/installable by others" and "regression-tested in CI against a real cluster." Valuable for open-sourcing; irrelevant to today's ask.
- **Per-node real git worktrees** — today, a root node and every child it delegates to share one mounted repository directory rather than each getting an isolated `git worktree`. Fine for one coherent `org run` toward one goal; would matter if unrelated concurrent runs against the same repo become common.
- **Organizational memory / evidence workers** — the rest of the Intelligence Plane (doc §6, §11) beyond the cheap-default path Phase 3 shipped. Improves delegation-economics calibration over time; not needed for a first real run.

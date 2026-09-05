import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { execa } from 'execa';
import { createDb } from '../db/client.js';
import { insertNode } from '../db/queries/nodes.js';
import { startNodeActor, getNodeActor, waitForNodeCompletion } from './node-actor-manager.js';
import { listDecisionsForNode } from '../db/queries/decisions.js';
import { isClusterReachable, ensureLocalCluster, NAMESPACE } from '../k8s/kind.js';

const TEST_DB = './test-autonomous-loop.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

const CLUSTER_AVAILABLE = await isClusterReachable();
if (!CLUSTER_AVAILABLE) console.log('no cluster — skipping autonomous-loop integration test');

// This is what Phase 2's own memory note flagged as blocked: "org run reaching
// SELF_EXECUTE end-to-end — the CLI stops at INTELLIGENCE_GATE because the
// decision events have no driver until Phase 3's engines land." This test is
// that proof, exercised directly against the real actor/DB/K8s stack rather
// than through the CLI (the CLI itself is Phase 4's concern).
describe.skipIf(!CLUSTER_AVAILABLE)('autonomous lifecycle, real cluster', () => {
  beforeAll(async () => {
    await ensureLocalCluster();
    // No runner image is published yet (Phase 5); busybox plus the stopgap
    // adapter dispatches a genuine Job that emits real structured output.
    process.env.ORG_RUNNER_IMAGE = 'busybox:1.36';
    process.env.ORG_WORKTREE_PATH = '/tmp';
  }, 180_000);

  afterEach(async () => {
    await execa('kubectl', ['delete', 'networkpolicy', 'org-egress-auto-1', '-n', NAMESPACE]).catch(() => {});
  }, 30_000);

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

    expect(getNodeActor('auto-1')).toBeDefined();

    // START is the only input. INTELLIGENCE_GATE, EXECUTION_DECISION, SELF_EXECUTE
    // (a genuine K8s Job round-trip) and VERIFY all resolve themselves.
    const result = await waitForNodeCompletion('auto-1', 240_000);
    expect(result.succeeded).toBe(true);
    expect(getNodeActor('auto-1')!.getSnapshot().value).toBe('COMPLETE');

    const decisions = listDecisionsForNode(db, 'auto-1');
    expect(decisions).toHaveLength(1);
    expect(decisions[0].outcome).toBe('SELF_EXECUTE');
  }, 260_000);
});

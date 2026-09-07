/** Fills a database with a plausible history so the window can be looked at
 *  without waiting for real runs. Development only — never wired into the app. */
import { randomUUID } from 'node:crypto';
import { createDb } from '../src/db/client.js';
import { insertNode } from '../src/db/queries/nodes.js';
import { appendEvent } from '../src/db/queries/events.js';
import { insertApproval } from '../src/db/queries/approvals.js';
import { insertCommitment } from '../src/db/queries/commitments.js';
import { insertDodItems, setDodState } from '../src/db/queries/dod.js';
import { insertDecision } from '../src/db/queries/decisions.js';
import { insertArtifact } from '../src/db/queries/artifacts.js';
import { recordRunOutcome } from '../src/db/queries/memory.js';
import { seedBuiltinMandates, getMandate } from '../src/db/queries/mandates.js';
import { createActor } from 'xstate';
import { nodeMachine } from '../src/lifecycle/node-machine.js';
import { setNodeSnapshot } from '../src/db/queries/nodes.js';

/** A node parked on an approval only survives a restart because it has a saved
 *  actor. Seeding one without a snapshot would be seeding the old bug. */
function park(nodeId: string, state: string, goal: string) {
  const resolved = nodeMachine.resolveState({
    value: state,
    context: { nodeId, goal, lastDecision: { outcome: 'ESCALATE', breakdown: { requiredBudget: 1 } } as never },
  });
  setNodeSnapshot(db, nodeId, createActor(nodeMachine, { input: { nodeId, goal }, snapshot: resolved }).getPersistedSnapshot());
}

const db = createDb(process.env.ORG_DB_PATH ?? './demo.db');
seedBuiltinMandates(db);

const t = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

function node(o: {
  id: string; parent?: string | null; goal: string; state: string; mandateId?: string;
  budget?: number; tools?: string[]; spawn?: boolean; children?: number;
  created: string; updated: string; runtime?: string;
}) {
  const mandate = o.mandateId ? getMandate(db, o.mandateId) : undefined;
  const contract = {
    goal: o.goal,
    definition_of_done: [o.goal],
    authority: mandate?.authority ?? {
      tools: o.tools ?? [], spawn_children: o.spawn ?? false,
      max_child_count: o.children ?? 0, budget_usd: o.budget ?? 5,
    },
    constraints: mandate?.constraints ?? [],
  };
  insertNode(db, {
    id: o.id, parentId: o.parent ?? null, goal: o.goal, contract, state: o.state,
    repoPath: '/workspace/CherryOnTop', runtime: o.runtime ?? 'claude-code',
    mandateId: o.mandateId ?? null, replayOf: null, snapshot: null,
    createdAt: o.created, updatedAt: o.updated,
  });
  insertCommitment(db, {
    id: randomUUID(), owner: o.id, goal: o.goal, definition_of_done: contract.definition_of_done,
    status: 'pending', created_at: o.created, dependencies: [], evidence: [], risks: [],
  }, o.created);
  insertDodItems(db, o.id, contract.definition_of_done, o.created, () => randomUUID());
  appendEvent(db, { nodeId: o.id, type: 'state.transition', payload: { state: 'CREATED' }, createdAt: o.created });
  appendEvent(db, { nodeId: o.id, type: 'state.transition', payload: { state: o.state }, createdAt: o.updated });
  return o.id;
}

function spend(id: string, usd: number, at: string) {
  appendEvent(db, { nodeId: id, type: 'exec.result', payload: { total_cost_usd: usd, result: 'done' }, createdAt: at });
}

function decide(id: string, outcome: string, breakdown: Record<string, number>, at: string) {
  insertDecision(db, { id: randomUUID(), nodeId: id, type: 'execution_decision', outcome: outcome as never, breakdown, createdAt: at });
  appendEvent(db, { nodeId: id, type: 'decision.made', payload: { outcome, breakdown }, createdAt: at });
}

const ECON = { estimatedValue: 0.7, modelCost: 0.1, latencyCost: 0.05, coordinationCost: 0.15, verificationCost: 0.1, riskPenalty: 0, threshold: 0.3 };

// 1 — a delegating case, finished, with evidence.
node({ id: 'c1', goal: 'Migrate the settings store to the new schema and update every caller', state: 'COMPLETE', mandateId: 'builtin-project', created: t(240), updated: t(180), children: 3, spawn: true });
decide('c1', 'DELEGATE', { ...ECON, score: 0.3 }, t(238));
for (const [i, goal] of ['Write the migration', 'Update the readers', 'Update the writers'].entries()) {
  const id = `c1-k${i}`;
  node({ id, parent: 'c1', goal, state: 'COMPLETE', created: t(236 - i), updated: t(190 - i * 3), budget: 1, tools: ['Read', 'Write', 'Edit', 'Bash'], runtime: i === 1 ? 'codex' : 'claude-code' });
  decide(id, 'SELF_EXECUTE', { ...ECON, score: 0.1 }, t(235 - i));
  spend(id, 0.4 + i * 0.3, t(200 - i * 3));
  insertArtifact(db, { id: randomUUID(), nodeId: id, kind: 'file_write', path: `src/settings/${goal.split(' ').pop()}.ts`, summary: 'Write', eventId: null, createdAt: t(199 - i * 3) });
  recordRunOutcome(db, { id: randomUUID(), nodeId: id, createdAt: t(190 - i * 3), outcome: { runtime: i === 1 ? 'codex' : 'claude-code', succeeded: true, costUsd: 0.4 + i * 0.3, latencyMs: 900_000, complexity: 'medium', delegated: false } });
}

// 2 — waiting on a person, right now.
node({ id: 'c2', goal: 'Audit every dependency for a known advisory and open one issue per finding', state: 'WAIT_APPROVAL', mandateId: 'builtin-project', created: t(22), updated: t(6) });
decide('c2', 'ESCALATE', { ...ECON, score: 0.42, requiredBudget: 1, availableBudget: 0.4 }, t(6));
park('c2', 'WAIT_APPROVAL', 'Audit every dependency for a known advisory and open one issue per finding');
insertApproval(db, { id: 'ap1', nodeId: 'c2', reason: 'Needs $1.00 to delegate this, authorized for $0.40', status: 'pending', createdAt: t(6) });
spend('c2', 0.62, t(9));

// 3 — read-only, refused a tool it was not granted.
node({ id: 'c3', goal: 'Explain why the delegation threshold is 0.3', state: 'COMPLETE', mandateId: 'builtin-investigate', created: t(90), updated: t(84) });
decide('c3', 'SELF_EXECUTE', { ...ECON, estimatedValue: 0.2, score: -0.2 }, t(89));
appendEvent(db, { nodeId: 'c3', type: 'authority.denied', payload: { tool: 'Write', granted: ['Read', 'Grep', 'Glob'] }, createdAt: t(86) });
spend('c3', 0.08, t(85));
recordRunOutcome(db, { id: randomUUID(), nodeId: 'c3', createdAt: t(84), outcome: { runtime: 'claude-code', succeeded: true, costUsd: 0.08, latencyMs: 340_000, complexity: 'low', delegated: false } });

// 4 — finished, but produced nothing, so its check is unverified.
const c4 = node({ id: 'c4', goal: 'Make the flaky socket test deterministic', state: 'COMPLETE', mandateId: 'builtin-focused-change', created: t(400), updated: t(380), runtime: 'codex' });
spend(c4, 1.9, t(385));
recordRunOutcome(db, { id: randomUUID(), nodeId: c4, createdAt: t(380), outcome: { runtime: 'codex', succeeded: true, costUsd: 1.9, latencyMs: 1_200_000, complexity: 'medium', delegated: false } });

// 5 — interrupted by a daemon restart.
node({ id: 'c5', goal: 'Port the CLI dashboard to the new stats query', state: 'INTERRUPTED', mandateId: 'builtin-focused-change', created: t(70), updated: t(55) });
park('c5', 'SELF_EXECUTE', 'Port the CLI dashboard to the new stats query');
appendEvent(db, { nodeId: 'c5', type: 'node.interrupted', payload: { message: 'The daemon stopped while this was working.', resumable: true }, createdAt: t(55) });
spend('c5', 0.44, t(60));

// 6 — failed, over its ceiling.
node({ id: 'c6', goal: 'Rewrite the k8s client to drop the vendored dependency', state: 'FAILED', mandateId: 'builtin-focused-change', created: t(900), updated: t(840) });
spend('c6', 7.2, t(850));
for (const item of ['x']) void item;
recordRunOutcome(db, { id: randomUUID(), nodeId: 'c6', createdAt: t(840), outcome: { runtime: 'claude-code', succeeded: false, costUsd: 7.2, latencyMs: 3_400_000, complexity: 'high', delegated: false } });

// Mark the finished cases' checks the way the runtime would have.
import { listDodForNode } from '../src/db/queries/dod.js';
for (const id of ['c1', 'c1-k0', 'c1-k1', 'c1-k2', 'c3']) {
  for (const item of listDodForNode(db, id)) setDodState(db, item.id, 'met', { note: 'Closed against what this agent produced.' }, t(180));
}
for (const item of listDodForNode(db, 'c4')) {
  setDodState(db, item.id, 'unverified', { note: 'The agent reported it finished, but produced nothing to show for it.' }, t(380));
}
for (const item of listDodForNode(db, 'c6')) {
  setDodState(db, item.id, 'unmet', { note: 'The agent did not finish.' }, t(840));
}

console.log('seeded');

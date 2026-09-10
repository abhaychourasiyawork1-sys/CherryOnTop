import { randomUUID } from 'node:crypto';
import { createActor, fromPromise, waitFor, type Actor } from 'xstate';
import { nodeMachine, type NodeMachineEvent } from './node-machine.js';
import type { Db } from '../db/client.js';
import { updateNodeState, getNode, insertNode, listNodes, setNodeRuntime } from '../db/queries/nodes.js';
import { appendEvent } from '../db/queries/events.js';
import { publish } from '../events/bus.js';
import { executeStep } from '../execution/execute-step.js';
import { ZERO_USAGE, type DispatchUsage } from '../execution/tokens.js';
import { claudeCodeAdapter } from '../adapters/claude-code.js';
import { stopgapAdapter } from '../adapters/stopgap.js';
import { assessUncertainty } from '../intelligence/coordinator.js';
import { decideExecution } from '../engines/decide-execution.js';
import { insertDecision } from '../db/queries/decisions.js';
import { escalate } from '../approvals/escalation.js';
import { insertApproval, getPendingApproval, resolveApproval } from '../db/queries/approvals.js';
import type { NodeMachineContext } from './node-machine.js';
import { delegateToChildren, childAuthority, type DelegateChildDeps } from './delegate-child.js';
import { insertCommitment, updateCommitmentStatus, setCommitmentEvidence, listCommitmentsForNode } from '../db/queries/commitments.js';
import { insertArtifact, listArtifactsForNode } from '../db/queries/artifacts.js';
import { artifactsFromEvent } from '../execution/artifacts.js';
import { codexAdapter } from '../adapters/codex.js';
import { selectRuntime } from '../intelligence/select-runtime.js';
import { buildPlanPrompt, parseSubgoals } from '../intelligence/plan.js';
import { buildSynthesisPrompt, type ChildReport } from '../intelligence/synthesize.js';
import { decideIntegration } from '../intelligence/integrate-results.js';
import { answerOf } from '../db/queries/answers.js';
import { recordRunOutcome, getRuntimeStats } from '../db/queries/memory.js';
import { getCostForNodes } from '../db/queries/stats.js';
import { resolveCredentials, checkCredentials } from '../execution/credentials.js';
import { sandboxLimiter, maxConcurrentFromEnv } from '../execution/dispatch-limit.js';
import { efficiencyLedger, type LedgerRole } from '../efficiency/ledger.js';
import type { EfficiencyOutcome } from '../efficiency/metrics.js';
import type { DispatchReceipt } from '../context/dispatch-context.js';
import { buildRolePrompt } from '../prompts/roles.js';
import os from 'node:os';
import { deleteNodeNetworkPolicy, deleteNodeJobs } from '../k8s/cleanup.js';
import { subtreeNodeIds } from '../db/queries/nodes.js';
import { allowedTools, isReadOnly } from '../engines/enforce-tools.js';
import type { Authority } from '../schemas/node-contract.js';
import type { ToolGrant, RuntimeAdapter } from '../adapters/adapter.js';
import { setNodeSnapshot, clearNodeSnapshot } from '../db/queries/nodes.js';
import { insertDodItems, listDodForNode, setDodState } from '../db/queries/dod.js';
import { dispatchOptionsFor, planCacheTtlHours, repoMapTokenBudget, rolePromptsEnabled, efficiencyMode, type DispatchRole } from '../config/efficiency.js';
import { routeModel } from '../intelligence/model-router.js';
import { assessDecomposition } from '../intelligence/decompose.js';
import { repoHead, repoDirty } from '../execution/git-state.js';
import { planCacheKey, getCachedPlan, putCachedPlan } from '../db/queries/plan-cache.js';
import { withRepoContext } from '../intelligence/repo-map.js';
import { dispatchContextFor, warmRepoInventory } from '../context/dispatch-context-cache.js';
import { recordDispatchUsage } from '../db/queries/tokens.js';
import { shouldRetryWithoutModel } from '../execution/tokens.js';
import { readOnlyPlanningGrant } from './dispatch-helpers.js';
import { memory } from '../db/schema.js';

// In-process actor registry. It is lost on a daemon restart, which is why every
// transition persists the actor to `nodes.snapshot` — see rehydrate.ts, which
// puts them back.
const actors = new Map<string, Actor<typeof nodeMachine>>();

/** States that are waiting on something outside the machine rather than running
 *  a promise. Restoring one of these costs nothing and resumes exactly where it
 *  stopped — this is the case that matters, because a human parked on an
 *  approval must not lose their decision to a restart.
 *
 *  Every other non-terminal state is mid-invoke: restoring it re-runs the
 *  promise, which means a fresh sandbox and fresh money. That is a choice a
 *  person makes, not one a daemon boot makes for them, so those are marked
 *  INTERRUPTED and wait for an explicit resume. */
const RESUMES_FREELY = new Set(['WAIT_APPROVAL', 'CREATED']);

/** Already over: nothing to stop, and INTERRUPTED is deliberately not here —
 *  a parked agent is still outstanding work a person may want to call off. */
const TERMINAL_STATES = new Set(['COMPLETE', 'FAILED', 'CANCELLED']);

export function resumesFreely(state: string): boolean {
  return RESUMES_FREELY.has(state);
}

const NAMESPACE = process.env.ORG_K8S_NAMESPACE ?? 'org-exec';

// ponytail: the default runner image (execute-step.ts) is not published yet, so
// there is no image a real dispatch can actually pull. Setting ORG_RUNNER_IMAGE
// swaps in a stand-in image and the matching stopgap adapter — the escape hatch
// integration tests use, and the one to delete once Phase 5 ships the image.
// Read per dispatch, not at import: tests set it after this module is loaded.
function runnerImageOverride(): string | undefined {
  return process.env.ORG_RUNNER_IMAGE;
}

function realDelegateDeps(db: Db): DelegateChildDeps {
  return {
    createChildNode: (parentId, goal, siblingCount, approvedBudgetUsd) => {
      const parent = getNode(db, parentId);
      if (!parent) throw new Error(`Parent node ${parentId} not found`);
      const id = randomUUID();
      const now = new Date().toISOString();
      insertNode(db, {
        id, parentId, goal,
        contract: {
          ...parent.contract, goal,
          authority: childAuthority(parent.contract.authority, siblingCount, approvedBudgetUsd),
        },
        state: 'CREATED', repoPath: parent.repoPath, createdAt: now, updatedAt: now,
      });
      return id;
    },
    recordCommitment: (childId, goal) => {
      const now = new Date().toISOString();
      insertCommitment(db, {
        id: randomUUID(), owner: childId, goal, definition_of_done: [goal],
        status: 'pending', created_at: now,
        dependencies: [], evidence: [], risks: [],
      }, now);
      // A child's promise is checkable on the same terms as the root's. Without
      // this a delegating case reports a definition of done covering only the
      // work the root did itself, which is usually none of it.
      insertDodItems(db, childId, [goal], now, () => randomUUID());
    },
    startChild: (childId, goal) => startNodeActor(db, childId, goal),
    waitForChild: (childId) => waitForNodeCompletion(childId),
  };
}

const ADAPTERS = { 'claude-code': claudeCodeAdapter, codex: codexAdapter };

/** Which runtime runs this node, decided from what the organization has learned
 *  rather than from a constant. The choice is persisted as a Decision and
 *  published as an event, so it is inspectable in the same place delegation is.
 *
 *  ORG_RUNNER_IMAGE still short-circuits the whole thing: it means "dispatch a
 *  stand-in image", and no real harness runs inside it to choose between. */
function chooseAdapter(db: Db, nodeId: string) {
  if (runnerImageOverride()) return stopgapAdapter;

  const selection = selectRuntime({
    available: Object.keys(ADAPTERS),
    stats: getRuntimeStats(db),
  });
  const adapter = ADAPTERS[selection.runtime as keyof typeof ADAPTERS] ?? claudeCodeAdapter;
  const now = new Date().toISOString();

  setNodeRuntime(db, nodeId, adapter.name, now);
  insertDecision(db, {
    id: randomUUID(), nodeId, type: 'runtime_selection',
    outcome: adapter.name, breakdown: selection.breakdown, createdAt: now,
  });
  const payload = { outcome: adapter.name, breakdown: selection.breakdown, type: 'runtime_selection' };
  const eventId = appendEvent(db, { nodeId, type: 'decision.made', payload, createdAt: now });
  publish({ id: eventId, nodeId, type: 'decision.made', payload, createdAt: now });

  return adapter;
}

/** What the node's contract permits, in the shape an adapter and the stream
 *  check both read. One function, so the two enforcement points can never
 *  disagree about what was granted. */
function grantOf(authority: Authority): ToolGrant {
  return { allowedTools: allowedTools(authority), readOnly: isReadOnly(authority) };
}

/** Whether this runtime actually delivers a system prompt. Codex exec has no
 *  `--append-system-prompt` flag and drops it on the floor, so a role stanza
 *  sent there reaches nobody — and the standing constraints it carries have to
 *  go inline on the goal instead. Asked of the adapter rather than hardcoded by
 *  name, so a new runtime answers for itself. Total: called from inside the
 *  executeStep actor, which has no try of its own. */
export function honoursSystemPrompt(adapter: RuntimeAdapter): boolean {
  const probe = '__system_prompt_probe__';
  try {
    return adapter.buildCommand('goal', undefined, { systemPrompt: probe }).includes(probe);
  } catch {
    return false;
  }
}

/** The model to actually send this runtime, which is `undefined` — the
 *  runtime's own default — whenever it cannot serve the one the role asked for.
 *
 *  Two ways it cannot: the runtime has no model flag at all (the sentinel does
 *  not survive into argv, the same probe shape honoursSystemPrompt uses), or it
 *  has one and rejects this name (adapter.servesModel). Both are asked of the
 *  adapter rather than hardcoded by runtime name. Sending a model a runtime
 *  cannot serve fails the whole dispatch — which for `plan` means no delegation
 *  and for `synthesize` means no answer.
 *
 *  Total, and failing towards "no model": called from inside the executeStep
 *  actor, which has no try of its own. */
export function modelFor(adapter: RuntimeAdapter, model: string | undefined): string | undefined {
  if (!model) return undefined;
  try {
    if (adapter.servesModel?.(model) === false) return undefined;
    return adapter.buildCommand('goal', undefined, { model }).includes(model) ? model : undefined;
  } catch {
    return undefined;
  }
}

/** What a dispatch cost, off the runtime's own final result event — the same
 *  number the cost views already read, recorded alongside the token counts. */
function costFromEvents(events: { type: string; payload: unknown }[]): number {
  return events
    .filter((e) => e.type === 'result')
    .reduce((s, e) => s + Number((e.payload as { total_cost_usd?: number } | null)?.total_cost_usd ?? 0), 0);
}

/** One fact the organization learned, written straight to memory. Total, for the
 *  same reason recordUsage is: it is called from inside the executeStep actor,
 *  which has no try of its own, and a busy database must not be able to fail a
 *  run — least of all here, where it would also discard the fallback dispatch
 *  this row is only a note about. */
function insertMemoryRow(db: Db, kind: string, key: string, value: unknown, nodeId: string): void {
  try {
    db.insert(memory).values({
      id: randomUUID(), kind, key, value, confidence: null, nodeId,
      createdAt: new Date().toISOString(),
    }).run();
  } catch (err) {
    console.error(`Failed to record ${kind} for node ${nodeId}:`, err);
  }
}

/** Publishes what context this dispatch was given and what it left out.
 *
 *  The receipt is the answer to "why did the agent not know about that file?".
 *  Selection is lossy by design, so it has to be inspectable, and in this
 *  runtime the only channel to a dispatch is its argv — there is nowhere to
 *  attach metadata to the request itself. The event log is that channel. */
function publishContextReceipt(db: Db, nodeId: string, receipt: DispatchReceipt): void {
  const now = new Date().toISOString();
  const payload = {
    budget: receipt.budget,
    tokens: receipt.selectedTokens,
    selected: receipt.selected.length,
    dropped: receipt.dropped.length,
    truncated: receipt.truncated,
    degraded: receipt.degraded ?? false,
  };
  const id = appendEvent(db, { nodeId, type: 'context.receipt', payload, createdAt: now });
  publish({ id, nodeId, type: 'context.receipt', payload, createdAt: now });
}

/** Accounting, and only accounting. A dispatch that ran and produced an answer
 *  must not be thrown away because writing down what it cost failed — every
 *  caller here is inside a try that would turn that into "no plan" or "no
 *  answer", which is a far worse outcome than a missing row in `org tokens`. */
function recordUsage(
  db: Db,
  r: { nodeId: string; role: string; model: string | null; usage: DispatchUsage; costUsd: number },
): void {
  try {
    recordDispatchUsage(db, { ...r, createdAt: new Date().toISOString() });
  } catch (err) {
    console.error(`Failed to record ${r.role} token usage for node ${r.nodeId}:`, err);
  }
  // The same fact, told to the in-memory ledger that rolls a whole task up into
  // one record. Separate from the row above on purpose: the row is per dispatch
  // and outlives the daemon, the ledger is per task and does not.
  // 'plan:cache-hit' is not a dispatch — it is the dispatch that did not happen,
  // which is the number this whole phase exists to move.
  if (r.role === 'plan:cache-hit') { ledger.recordAvoided(r.nodeId, 'plan'); return; }
  const timing = drainTiming(r.nodeId);
  ledger.recordDispatch(r.nodeId, {
    role: r.role as LedgerRole,
    usage: r.usage,
    costUsd: r.costUsd,
    ms: timing.dispatchMs,
    queuedMs: timing.queuedMs,
  });
}

/** The model this dispatch should run on.
 *
 *  `disabled` is the fixed per-role choice this branch shipped with. `shadow`
 *  decides and records but dispatches as `disabled` would, so a deployment can
 *  see what routing *would* have done before letting it. `enabled` acts on it.
 *
 *  Total, like every other decision made from inside the executeStep actor:
 *  anything going wrong here falls back to the fixed choice, never to no
 *  dispatch. */
function modelChoiceFor(db: Db, nodeId: string, role: DispatchRole, goal: string): string | undefined {
  const configured = dispatchOptionsFor(role).model;
  const mode = efficiencyMode();
  if (mode === 'disabled') return configured;
  try {
    const node = getNode(db, nodeId);
    const route = routeModel({
      role,
      complexity: assessDecomposition(goal).complexity,
      budgetUsd: node?.contract.authority.budget_usd ?? 0,
      spentUsd: getCostForNodes(db, [nodeId]),
    });
    insertMemoryRow(db, 'model_route', role, { ...route, mode }, nodeId);
    return mode === 'shadow' ? configured : route.model;
  } catch (err) {
    console.error(`Failed to route a model for node ${nodeId}:`, err);
    return configured;
  }
}

/** The tokens of an attempt that was thrown away — the one the model-fallback
 *  retry replaced. Nothing else records these: `recordUsage` deliberately writes
 *  one row per *logical* dispatch, naming the model that actually ran, so
 *  without this the cost of a wrong model tier is invisible. */
function recordSupersededAttempt(
  nodeId: string,
  role: LedgerRole,
  result: { usage: DispatchUsage; events: { type: string; payload: unknown }[] },
): void {
  const timing = drainTiming(nodeId);
  ledger.recordDispatch(nodeId, {
    role, usage: result.usage, costUsd: costFromEvents(result.events),
    ms: timing.dispatchMs, queuedMs: timing.queuedMs, superseded: true,
  });
}

/** Records a tool used outside the node's grant. This is the event the Proof
 *  view and the Receipt render, and the reason the authority boundary is a fact
 *  about the run rather than a claim on a form. */
function publishDenial(db: Db, nodeId: string, tool: string, authority: Authority): void {
  const now = new Date().toISOString();
  const payload = { tool, granted: authority.tools };
  const id = appendEvent(db, { nodeId, type: 'authority.denied', payload, createdAt: now });
  publish({ id, nodeId, type: 'authority.denied', payload, createdAt: now });
}

/** Publishes a step's outcome. Before this, a dispatch that failed produced no
 *  events whatsoever — no error, no explanation — so a node that could never run
 *  looked identical to one working quietly, for ten minutes at a time. */
function publishStepOutcome(db: Db, nodeId: string, result: { succeeded: boolean; message: string }): void {
  const now = new Date().toISOString();
  const payload = { succeeded: result.succeeded, message: result.message };
  const id = appendEvent(db, { nodeId, type: 'step.outcome', payload, createdAt: now });
  publish({ id, nodeId, type: 'step.outcome', payload, createdAt: now });
}

/** Narrates what the node is about to do, as it does it. The state machine's own
 *  transitions say which state it is in; these say what that means in practice —
 *  which repository, which runtime, what it is waiting on. */
function publishProgress(db: Db, nodeId: string, message: string): void {
  const now = new Date().toISOString();
  const payload = { message };
  const id = appendEvent(db, { nodeId, type: 'step.progress', payload, createdAt: now });
  publish({ id, nodeId, type: 'step.progress', payload, createdAt: now });
}

/** Publishes an answer that exists nowhere else — the combined one a delegating
 *  node writes from its children's reports. A node that did the work itself has
 *  already said its answer in the transcript, so it does not get one of these;
 *  readers of `node.detail` fall back to its final report. */
function publishAnswer(db: Db, nodeId: string, text: string): void {
  if (!text.trim()) return;
  const now = new Date().toISOString();
  const payload = { text };
  const id = appendEvent(db, { nodeId, type: 'node.answer', payload, createdAt: now });
  publish({ id, nodeId, type: 'node.answer', payload, createdAt: now });
}

/** Combines what the children reported into the one answer the root owes.
 *
 *  A delegating node used to finish with "All 3 delegated pieces completed" — a
 *  status line, not an answer — leaving whoever asked to open each child and do
 *  the reading themselves. Costs one sandbox, and only for a node that actually
 *  delegated and actually got reports back. */
async function synthesizeChildren(db: Db, nodeId: string, goal: string): Promise<string> {
  const node = getNode(db, nodeId);
  const worktreePath = node?.repoPath ?? process.env.ORG_WORKTREE_PATH;
  if (!worktreePath) return '';

  const children: ChildReport[] = listNodes(db)
    .filter((child) => child.parentId === nodeId)
    .map((child) => ({
      goal: child.goal,
      succeeded: child.state === 'COMPLETE',
      report: answerOf(db, child.id),
    }));

  // Most of combining reports is mechanical, and mechanical work does not need
  // a sandbox. Only a judgement call — overlapping edits, a child that half
  // finished, prose nothing can parse — is worth one.
  const decision = decideIntegration(children);
  if (decision.kind === 'nothing') return '';
  if (decision.kind === 'return_child' || decision.kind === 'merge') {
    ledger.recordAvoided(nodeId, 'synthesize');
    publishProgress(db, nodeId, decision.kind === 'merge'
      ? `Combined ${children.length} agents' results directly — no extra model call was needed`
      : "One agent answered this; returning its answer rather than paying to reword it");
    return decision.text;
  }

  const credentials = checkCredentials(os.homedir(), process.env.ANTHROPIC_API_KEY);
  if (!credentials.ok) return '';

  publishProgress(db, nodeId, `Combining what ${children.length} agents reported into one answer (${decision.reason})`);
  try {
    // Inside the try, like everything else here: chooseAdapter writes a decision
    // row and publishes an event, and a database that refuses that must cost the
    // combined answer, not the whole delegating node.
    const adapter = chooseAdapter(db, nodeId);
    const opts = dispatchOptionsFor('synthesize');
    // Same shape as the execute dispatch: the stanza only carries the role when
    // the runtime will actually deliver it. buildSynthesisPrompt no longer states
    // the lead's job — merge overlaps, keep file:line detail, order by importance,
    // no preamble — so when there is no stanza it has to go inline on the goal, or
    // it reaches nobody at all.
    const roleSystemPrompt = rolePromptsEnabled() && honoursSystemPrompt(adapter)
      ? buildRolePrompt('synthesize')
      : undefined;
    const synthesisGoal = roleSystemPrompt
      ? buildSynthesisPrompt(goal, decision.children)
      : `${buildSynthesisPrompt(goal, decision.children)}\n\n${buildRolePrompt('synthesize')}`;

    const runOnce = (model: string | undefined) => dispatch(db, nodeId, () => executeStep({
      nodeId,
      goal: synthesisGoal,
      systemPrompt: roleSystemPrompt,
      namespace: NAMESPACE,
      worktreePath,
      credentials: resolveCredentials(os.homedir(), process.env.ANTHROPIC_API_KEY),
      adapter,
      image: runnerImageOverride(),
      timeoutMs: PLAN_TIMEOUT_MS,
      model,
      maxTurns: opts.maxTurns,
      onEvent: (event) => {
        // `synth.` keeps the combining run out of the work transcript — it is a
        // third kind of run, and reading it as more work is confusing.
        const now = new Date().toISOString();
        const type = `synth.${event.type}`;
        const id = appendEvent(db, { nodeId, type, payload: event.payload, createdAt: now });
        publish({ id, nodeId, type, payload: event.payload, createdAt: now });
      },
    }));

    // One shot at the tiered model, exactly as the execute dispatch does it:
    // a role that defaults to Haiku must not lose the whole answer on a plan
    // that cannot call Haiku.
    let usedModel = modelFor(adapter, modelChoiceFor(db, nodeId, 'synthesize', goal));
    let result = await runOnce(usedModel);
    if (usedModel && shouldRetryWithoutModel(result.events)) {
      publishProgress(db, nodeId, `Model "${usedModel}" is unavailable on this plan — retrying on the default model`);
      insertMemoryRow(db, 'model_tier_unavailable', 'synthesize', { model: usedModel }, nodeId);
      recordSupersededAttempt(nodeId, 'synthesize', result);
      usedModel = undefined;
      result = await runOnce(undefined);
    }
    // Exactly one row per logical dispatch, naming the model that actually ran.
    recordUsage(db, {
      nodeId, role: 'synthesize', model: usedModel ?? null,
      usage: result.usage, costUsd: costFromEvents(result.events),
    });

    // An errored `result` is the runtime's complaint, not an answer — and the
    // caller publishes whatever comes back here as the node's answer. With
    // ORG_MAX_TURNS_SYNTHESIZE at 1, one verifying tool call is enough to turn
    // the whole synthesis into "error: max turns exceeded", which would then be
    // published as what the organization concluded.
    const text = result.events
      .filter((event) => event.type === 'result')
      .filter((event) => (event.payload as { is_error?: unknown } | null)?.is_error !== true)
      .map((event) => String((event.payload as { result?: unknown } | null)?.result ?? ''))
      .join('\n')
      .trim();
    // Nothing usable came back. Saying so beats a silent fall-through to the
    // "all 3 pieces completed" tally, which is what the caller does with ''.
    if (!text) publishProgress(db, nodeId, "Could not combine the agents' reports — their individual reports stand");
    return text;
  } catch (err) {
    publishProgress(db, nodeId, `Could not combine the agents' reports (${err instanceof Error ? err.message : String(err)})`);
    return '';
  }
}

/** Asks the runtime how to split the goal, in its own short sandbox run with the
 *  repository mounted so it can look before it splits. One extra dispatch per
 *  delegating node, and only when delegation was already chosen — a node doing
 *  the work itself never pays for it.
 *
 *  Any failure here means "do not delegate", never "delegate the goal as-is":
 *  the clone case is worse than not delegating at all. */
const PLAN_TIMEOUT_MS = 240_000;

// One limiter for the whole daemon: the quota it protects is per-account, not
// per-node, so every sandbox in every task queues through the same gate.
const sandboxes = sandboxLimiter();

// One ledger for the whole daemon, for the same reason: what it measures is the
// organization's spend, not any single node's.
const ledger = efficiencyLedger();

/** Runs a sandbox when a slot is free, and says so while it waits. A node
 *  sitting in a queue looks identical to one that has hung unless it tells you. */
async function dispatch<T>(db: Db, nodeId: string, task: () => Promise<T>): Promise<T> {
  if (sandboxes.active() >= maxConcurrentFromEnv()) {
    publishProgress(db, nodeId, `Waiting for a free sandbox — ${sandboxes.queued() + 1} ahead in the queue`);
  }
  // This is the only place that can tell waiting from working — two halves of
  // latency with entirely different fixes. Stashed rather than returned because
  // the caller's return type is the dispatch result, and threading a second
  // value through three call sites to reach `recordUsage` — which runs
  // immediately after — buys nothing.
  const queuedAt = Date.now();
  let startedAt = queuedAt;
  try {
    return await sandboxes.run(() => { startedAt = Date.now(); return task(); });
  } finally {
    pendingTiming.set(nodeId, { queuedMs: startedAt - queuedAt, dispatchMs: Date.now() - startedAt });
  }
}

/** How long the last dispatch for a node waited and ran, between `dispatch`
 *  measuring it and `recordUsage` claiming it. Cleared on read, so a dispatch
 *  that threw before recording cannot lend its timing to the next one. */
const pendingTiming = new Map<string, { queuedMs: number; dispatchMs: number }>();

function drainTiming(nodeId: string): { queuedMs: number; dispatchMs: number } {
  const timing = pendingTiming.get(nodeId) ?? { queuedMs: 0, dispatchMs: 0 };
  pendingTiming.delete(nodeId);
  return timing;
}

async function planSubgoals(db: Db, nodeId: string, goal: string, maxChildren: number): Promise<string[]> {
  const node = getNode(db, nodeId);
  const worktreePath = node?.repoPath ?? process.env.ORG_WORKTREE_PATH;
  // Fewer than two children is not a fan-out, and parseSubgoals rejects a
  // single subgoal as "no split" anyway — so planning here would spend a whole
  // sandbox run to be told what we already know.
  if (!worktreePath || maxChildren < 2) return [];

  // The same goal against the same committed tree splits the same way. Only a
  // clean tree with a readable HEAD is keyable — repoDirty says true when it
  // cannot tell, so an unknowable tree plans afresh rather than reusing a plan
  // that may no longer describe the code.
  // A TTL of 0 turns the cache off. Then there is nothing to read and no point
  // writing, so do not fork two git subprocesses per plan to key a cache nobody
  // will look at.
  const ttl = planCacheTtlHours();
  const head = ttl > 0 ? repoHead(worktreePath) : null;
  const cacheKey = head && !repoDirty(worktreePath) ? planCacheKey(goal, head) : null;
  if (cacheKey) {
    try {
      const cached = getCachedPlan(db, cacheKey, ttl);
      if (cached) {
        publishProgress(db, nodeId, cached.length === 0
          ? 'This goal was already found not to split on this repo state — doing it directly'
          : 'Reusing a plan computed earlier for this goal and repo state');
        recordUsage(db, {
          nodeId, role: 'plan:cache-hit', model: null, usage: { ...ZERO_USAGE }, costUsd: 0,
        });
        // The key is goal + HEAD, not the contract — so a plan cached under a
        // wider max_child_count would otherwise spawn more children than this
        // node's authority allows. On the cold path parseSubgoals is what
        // clamps; nothing downstream re-checks. This is that clamp.
        return cached.slice(0, maxChildren);
      }
    } catch {
      // A cache that misbehaves costs a sandbox, not a run.
    }
  }

  const credentials = checkCredentials(os.homedir(), process.env.ANTHROPIC_API_KEY);
  if (!credentials.ok) return [];

  publishProgress(db, nodeId, 'Working out how to split this across agents');
  try {
    // Inside the try, like everything else here: chooseAdapter writes a decision
    // row and publishes an event, and any failure in planning has to mean "do
    // not delegate" rather than taking the node down with it.
    const adapter = chooseAdapter(db, nodeId);
    const opts = dispatchOptionsFor('plan');
    // Same shape as the execute dispatch: the stanza only carries the role when
    // the runtime will actually deliver it. buildPlanPrompt no longer states the
    // planner's job or its output contract, so when there is no stanza it has to
    // go inline on the goal.
    const roleSystemPrompt = rolePromptsEnabled() && honoursSystemPrompt(adapter)
      ? buildRolePrompt('plan')
      : undefined;
    const planPrompt = roleSystemPrompt
      ? buildPlanPrompt(goal, maxChildren)
      : `${buildPlanPrompt(goal, maxChildren)}\n\n${buildRolePrompt('plan')}`;
    // The planner used to start from nothing and spend its turns discovering
    // the repository — the single most expensive coordination dispatch there
    // is, and it re-derives what the scan already knows. It splits the goal, so
    // it gets the same goal-selected context a child would.
    const planContext = dispatchContextFor(db, worktreePath, goal);
    if (planContext) publishContextReceipt(db, nodeId, planContext.receipt);
    const planGoal = planContext ? withRepoContext(planPrompt, planContext.content) : planPrompt;

    const runOnce = (model: string | undefined) => dispatch(db, nodeId, () => executeStep({
      nodeId,
      goal: planGoal,
      systemPrompt: roleSystemPrompt,
      namespace: NAMESPACE,
      worktreePath,
      credentials: resolveCredentials(os.homedir(), process.env.ANTHROPIC_API_KEY),
      adapter,
      image: runnerImageOverride(),
      timeoutMs: PLAN_TIMEOUT_MS,
      model,
      maxTurns: opts.maxTurns,
      // Planning looks, it does not work. A node whose row we cannot read gets
      // the plain read-only set, which is narrower than anything it could hold.
      grant: readOnlyPlanningGrant(node ? grantOf(node.contract.authority) : undefined),
      onEvent: (event) => {
        // `plan.` rather than `exec.`, so a reader can tell "deciding how to
        // split this" from the work itself — they are two different sandbox
        // runs and reading them as one conversation is baffling.
        const now = new Date().toISOString();
        const type = `plan.${event.type}`;
        const id = appendEvent(db, { nodeId, type, payload: event.payload, createdAt: now });
        publish({ id, nodeId, type, payload: event.payload, createdAt: now });
      },
    }));

    // One shot at the tiered model, exactly as the execute dispatch does it.
    // `plan` is the role that actually defaults to a tiered model, so without
    // this a plan that cannot call Haiku loses delegation entirely.
    let usedModel = modelFor(adapter, modelChoiceFor(db, nodeId, 'plan', goal));
    let result = await runOnce(usedModel);
    if (usedModel && shouldRetryWithoutModel(result.events)) {
      publishProgress(db, nodeId, `Model "${usedModel}" is unavailable on this plan — retrying on the default model`);
      insertMemoryRow(db, 'model_tier_unavailable', 'plan', { model: usedModel }, nodeId);
      recordSupersededAttempt(nodeId, 'plan', result);
      usedModel = undefined;
      result = await runOnce(undefined);
    }

    // Claude Code's final `result` event carries the answer text.
    const text = result.events
      .filter((event) => event.type === 'result')
      .map((event) => String((event.payload as { result?: unknown } | null)?.result ?? ''))
      .join('\n');
    const subgoals = parseSubgoals(text, maxChildren);
    // Exactly one row per logical dispatch, naming the model that actually ran.
    recordUsage(db, {
      nodeId, role: 'plan', model: usedModel ?? null,
      usage: result.usage, costUsd: costFromEvents(result.events),
    });
    // Both answers are worth pinning, including "does not split". That one used
    // to be dropped as "cheap to recompute", which it is not: recomputing it
    // buys another whole planning sandbox to be told the same thing, and it is
    // exactly as stable as a split under the same goal and HEAD.
    // Guarded for the same reason recordUsage is, and more sharply: a busy
    // database throwing here lands in the catch below, which returns "no
    // plan" — so a write-behind cache would have thrown away a plan that was
    // already computed and paid for, and the node would self-execute instead.
    if (cacheKey) {
      try {
        putCachedPlan(db, cacheKey, subgoals, head!, new Date().toISOString());
      } catch (err) {
        console.error(`Failed to cache the plan for node ${nodeId}:`, err);
      }
    }
    if (subgoals.length === 0) {
      publishProgress(db, nodeId, 'This goal does not split into independent pieces — doing it directly');
    }
    return subgoals;
  } catch (err) {
    publishProgress(db, nodeId, `Could not plan a split (${err instanceof Error ? err.message : String(err)}) — doing it directly`);
    return [];
  }
}

function productionMachine(db: Db, nodeId: string) {
  return nodeMachine.provide({
    actors: {
      assessUncertainty: fromPromise(async ({ input }: { input: { goal: string } }) => assessUncertainty(input)),
      decideExecution: fromPromise(async ({ input }: { input: { goal: string; complexity: NodeMachineContext['complexity']; worthSplitting?: boolean; signals?: Record<string, number> } }) => {
        const node = getNode(db, nodeId);
        if (!node) throw new Error(`Node ${nodeId} not found when deciding execution`);
        const result = decideExecution({
          goal: input.goal,
          authority: node.contract.authority,
          complexity: input.complexity ?? 'low',
          worthSplitting: input.worthSplitting,
          signals: input.signals,
        });
        const decidedAt = new Date().toISOString();
        insertDecision(db, {
          id: randomUUID(), nodeId, type: 'execution_decision',
          outcome: result.outcome, breakdown: result.breakdown,
          createdAt: decidedAt,
        });
        // Also an event, so a watching transcript can narrate *why* a node did
        // what it did as it happens. The decisions table stays the durable
        // record; this is the live notification of the same fact.
        const decisionPayload = { outcome: result.outcome, breakdown: result.breakdown };
        const decisionEventId = appendEvent(db, {
          nodeId, type: 'decision.made', payload: decisionPayload, createdAt: decidedAt,
        });
        publish({ id: decisionEventId, nodeId, type: 'decision.made', payload: decisionPayload, createdAt: decidedAt });
        return result;
      }),
      escalate: fromPromise(async ({ input }: { input: { nodeId: string; reason: string } }) =>
        escalate(input.nodeId, input.reason, { insertApproval: (record) => insertApproval(db, record) }),
      ),
      delegateToChild: fromPromise(async ({ input }: { input: { nodeId: string; goal: string; approvedBudgetUsd?: number } }) =>
        (async () => {
          const node = getNode(db, nodeId);
          const existingChildren = listNodes(db).filter((child) => child.parentId === nodeId).length;
          // Planning costs a sandbox. Do not pay for one only to refuse the
          // result because this node has already delegated.
          const subgoals = existingChildren > 0
            ? []
            : await planSubgoals(db, nodeId, input.goal, node?.contract.authority.max_child_count ?? 0);
          if (subgoals.length > 0) {
            // How many ways, not what each piece is. Every subgoal is a whole
            // instruction, so joining four of them produced a 1,500-character
            // "progress" line that buried the transcript it was meant to
            // narrate — and each one appears immediately below as a named agent
            // anyway.
            publishProgress(db, nodeId, `Splitting the work ${subgoals.length} ways`);
            // Warm the map here, once, before the children start: they all sit
            // on this same commit, so otherwise N children starting together
            // each build an identical map and store an identical row.
            const mapPath = node?.repoPath ?? process.env.ORG_WORKTREE_PATH;
            if (mapPath) warmRepoInventory(db, mapPath);
          }
          const result = await delegateToChildren({
            parentId: nodeId, goal: input.goal, subgoals,
            existingChildren,
            approvedBudgetUsd: input.approvedBudgetUsd,
          }, realDelegateDeps(db));

          // The root owes an answer, not a tally of its children.
          if (!result.notDelegatable) {
            const combined = await synthesizeChildren(db, nodeId, input.goal);
            if (combined) {
              publishAnswer(db, nodeId, combined);
              return { ...result, message: combined };
            }
          }
          return result;
        })(),
      ),
      executeStep: fromPromise(async ({ input }) => {
        const node = getNode(db, nodeId);

        // No invented fallback path. It used to default to
        // `/tmp/org-worktrees/<id>`, a directory that does not exist, so the
        // Job mounted a missing hostPath, never scheduled, and timed out ten
        // minutes later with nothing to show for it. A run with no repository
        // attached cannot do useful work; say so immediately.
        const worktreePath = node?.repoPath ?? process.env.ORG_WORKTREE_PATH;
        if (!worktreePath) {
          const result = {
            succeeded: false,
            message: 'No repository is attached to this run, so there is nothing for the agent to work on. Start it from the repository you want worked on.',
            events: [],
            usage: { ...ZERO_USAGE },
          };
          publishStepOutcome(db, nodeId, result);
          return result;
        }

        // Checked here rather than left to the sandbox: it receives a copy of
        // the credentials and sits behind a default-deny egress policy, so it
        // cannot refresh an expired token — it just spends a whole run failing
        // on a 401 minutes later.
        const credentials = checkCredentials(os.homedir(), process.env.ANTHROPIC_API_KEY);
        if (!credentials.ok) {
          const result = { succeeded: false, message: credentials.reason ?? 'Claude credentials are unusable.', events: [], usage: { ...ZERO_USAGE } };
          publishStepOutcome(db, nodeId, result);
          return result;
        }

        const adapter = chooseAdapter(db, nodeId);
        publishProgress(db, nodeId, `Starting a sandbox on ${adapter.name} against ${worktreePath}`);
        const execOpts = dispatchOptionsFor('execute');
        // Built once, out here rather than inside runOnce: the fallback retry
        // below calls runOnce a second time with the same goal, and a goal
        // carrying two copies of the context is the thing this is meant to
        // avoid. No context (disabled, not a repo, scan failed) → the bare goal.
        const repoContext = dispatchContextFor(db, worktreePath, input.goal);
        if (repoContext) publishContextReceipt(db, nodeId, repoContext.receipt);

        // Constraints are instructions, not boundaries — the interface says so
        // wherever it shows them — so they must reach the agent either way.
        // With role prompts on and a runtime that delivers them they ride the
        // cached `execute` system stanza; otherwise there is no stanza to ride,
        // so they go inline on the goal instead. Computed out here, like the
        // repo map, so the fallback retry below cannot prepend them twice.
        // Trimmed here, the same way roles.ts's list() trims, so a contract
        // carrying a blank constraint cannot produce a header with an empty
        // bullet under it — what the retired withConstraints also did.
        const constraints = (node?.contract.constraints ?? []).map((c) => c.trim()).filter(Boolean);
        const roleSystemPrompt = rolePromptsEnabled() && honoursSystemPrompt(adapter)
          ? buildRolePrompt('execute', {
              allowedTools: node ? grantOf(node.contract.authority).allowedTools : undefined,
              constraints,
              definitionOfDone: node?.contract.definition_of_done ?? [],
            })
          : undefined;
        const goalWithConstraints = (!roleSystemPrompt && constraints.length > 0)
          ? `Standing instructions (follow even where they conflict with the most direct path, and say so if one blocks you):\n${constraints.map((c) => `  - ${c}`).join('\n')}\n\n${input.goal}`
          : input.goal;
        // The context goes on last, so it wraps the whole instruction block
        // instead of landing between the standing instructions and the goal they
        // govern — a file listing separating an instruction from its task is a
        // worse prompt than either change intended on its own.
        const goalForDispatch = repoContext
          ? withRepoContext(goalWithConstraints, repoContext.content)
          : goalWithConstraints;

        const runOnce = (model: string | undefined) => dispatch(db, nodeId, () => executeStep({
          nodeId,
          goal: goalForDispatch,
          systemPrompt: roleSystemPrompt,
          namespace: NAMESPACE,
          worktreePath,
          // Subscription (via `claude login`) is preferred over an API key —
          // see credentials.ts. Read fresh on every dispatch, so unlike the
          // ANTHROPIC_API_KEY env var this path has no daemon-restart staleness.
          credentials: resolveCredentials(os.homedir(), process.env.ANTHROPIC_API_KEY),
          adapter,
          image: runnerImageOverride(),
          grant: grantOf(node!.contract.authority),
          model,
          maxTurns: execOpts.maxTurns,
          onViolation: (tool) => publishDenial(db, nodeId, tool, node!.contract.authority),
          // The runner's structured output is the point of the whole dispatch.
          // Was: a loop over result.events run once, after the whole Job
          // finished. Now: called per-event, live, as executeStep's follow-mode
          // stream delivers them — this is what makes the TUI's live output real.
          onEvent: (event) => {
            const now = new Date().toISOString();
            const type = `exec.${event.type}`;
            const id = appendEvent(db, { nodeId, type, payload: event.payload, createdAt: now });
            publish({ id, nodeId, type, payload: event.payload, createdAt: now });
            // Artifacts are derived from the same stream, at the same moment —
            // no second capture pass over the event log afterwards.
            for (const artifact of artifactsFromEvent(event)) {
              insertArtifact(db, { id: randomUUID(), nodeId, eventId: id, createdAt: now, ...artifact });
            }
          },
        }));

        // One shot at the tiered model — and only a model this runtime can
        // actually serve. If the runtime then says it cannot have it, the run
        // continues on the default rather than failing over a knob.
        let usedModel = modelFor(adapter, modelChoiceFor(db, nodeId, 'execute', input.goal));
        let result = await runOnce(usedModel);
        if (usedModel && shouldRetryWithoutModel(result.events)) {
          publishProgress(db, nodeId, `Model "${usedModel}" is unavailable on this plan — retrying on the default model`);
          insertMemoryRow(db, 'model_tier_unavailable', 'execute', { model: usedModel }, nodeId);
          recordSupersededAttempt(nodeId, 'execute', result);
          usedModel = undefined;
          result = await runOnce(undefined);
        }
        // Exactly one row per logical dispatch, naming the model whose tokens
        // and cost this row actually carries — see the retry above.
        recordUsage(db, {
          nodeId, role: 'execute', model: usedModel ?? null,
          usage: result.usage, costUsd: costFromEvents(result.events),
        });
        publishStepOutcome(db, nodeId, result);
        // No answer event here: a node that did the work itself already said its
        // answer, and it is in the transcript. Publishing it again rendered the
        // whole report twice, once as speech and once as "the answer".
        return result;
      }),
    },
  });
}

/** Closes a node's definition of done against what it actually produced.
 *
 *  The rule is deliberately conservative, because a checklist that goes green on
 *  a status flag is worse than no checklist: it launders "the process exited 0"
 *  into "the work was done". So a check is only `met` when there is something to
 *  point at. A node that reported success and produced nothing stays
 *  `unverified` and says so — which is precisely the failure worth catching.
 *  A person can always overrule either way; that is what node.setDod is for. */
function closeDefinitionOfDone(db: Db, nodeId: string, state: string, now: string): void {
  const artifacts = listArtifactsForNode(db, nodeId).filter((a) => a.kind !== 'result');
  for (const item of listDodForNode(db, nodeId)) {
    if (item.state !== 'unverified' || item.checkedAt) continue; // a person already ruled
    if (state === 'FAILED') {
      setDodState(db, item.id, 'unmet', { note: 'The agent did not finish.' }, now);
    } else if (state === 'COMPLETE' && artifacts.length > 0) {
      setDodState(db, item.id, 'met', {
        artifactId: artifacts[0].id,
        note: `Closed against ${artifacts.length} thing${artifacts.length === 1 ? '' : 's'} this agent produced.`,
      }, now);
    } else if (state === 'COMPLETE') {
      setDodState(db, item.id, 'unverified', {
        note: 'The agent reported it finished, but produced nothing to show for it.',
      }, now);
    }
  }
}

/** One run, remembered. This is the only writer of node memory: everything the
 *  organization later believes about a runtime is an aggregate of these rows,
 *  so a run that ended in any way at all has to produce exactly one. */
function recordOutcomeInMemory(db: Db, nodeId: string, succeeded: boolean, now: string): void {
  const node = getNode(db, nodeId);
  // A node that never dispatched has no runtime, and no outcome to attribute to
  // one — recording it under a guessed runtime would poison the statistics that
  // the next selection is made from.
  if (!node?.runtime) return;
  recordRunOutcome(db, {
    id: randomUUID(), nodeId, createdAt: now,
    outcome: {
      runtime: node.runtime,
      succeeded,
      costUsd: getCostForNodes(db, [nodeId]),
      latencyMs: Date.parse(now) - Date.parse(node.createdAt),
      complexity: node.goal.length > 150 ? 'high' : node.goal.length > 50 ? 'medium' : 'low',
      delegated: listNodes(db).some((n) => n.parentId === nodeId),
    },
  });
}

/** Closes the task's ledger entry and pins the result where a later comparison
 *  can read it. The ledger only lives as long as the daemon, and a benchmark
 *  that has to keep the daemon alive to read its own results is not one anybody
 *  will run — so the record goes to `memory` alongside the per-dispatch rows.
 *
 *  Total, like every other recorder here: this runs on the terminal transition,
 *  and a node must not be left un-finalized because measuring it failed. */
function recordEfficiency(db: Db, nodeId: string, outcome: EfficiencyOutcome): void {
  try {
    const record = ledger.finishTask(nodeId, outcome);
    insertMemoryRow(db, 'efficiency_record', nodeId, record, nodeId);
  } catch (err) {
    console.error(`Failed to record the efficiency of node ${nodeId}:`, err);
  }
}

export function startNodeActor(db: Db, nodeId: string, goal: string): void {
  createAndRun(db, nodeId, goal, undefined);
}

/** Puts a node back from its persisted snapshot. `restored` skips the START
 *  event — the machine is already past CREATED and sending it again would throw
 *  it back to the beginning of a run that is half done. */
export function restoreNodeActor(db: Db, nodeId: string, goal: string, snapshot: unknown): void {
  createAndRun(db, nodeId, goal, snapshot);
}

function createAndRun(db: Db, nodeId: string, goal: string, persisted: unknown): void {
  const actor = persisted === undefined || persisted === null
    ? createActor(productionMachine(db, nodeId), { input: { nodeId, goal } })
    // `input` is still required by the type even when a snapshot supersedes it;
    // xstate uses the snapshot's own context, so this value is never read.
    : createActor(productionMachine(db, nodeId), { input: { nodeId, goal }, snapshot: persisted as never });
  // A restored node's earlier dispatches are gone with the daemon that made
  // them; the ledger picks it up from here rather than reporting nothing.
  ledger.startTask(nodeId);
  actor.subscribe((snapshot) => {
    const now = new Date().toISOString();
    updateNodeState(db, nodeId, String(snapshot.value), now);
    // Persisted before the transition event is published, so a reader that sees
    // the state has a snapshot that matches it.
    if (snapshot.status === 'done') clearNodeSnapshot(db, nodeId);
    else setNodeSnapshot(db, nodeId, actor.getPersistedSnapshot());
    const transitionId = appendEvent(db, { nodeId, type: 'state.transition', payload: { state: snapshot.value }, createdAt: now });
    publish({ id: transitionId, nodeId, type: 'state.transition', payload: { state: snapshot.value }, createdAt: now });

    // G3 fix: the per-node egress policy outlives the node otherwise. A done
    // actor is one that reached a final state (COMPLETE/FAILED), which it never
    // leaves, so it is a safe point to release cluster-side resources.
    if (snapshot.status === 'done') {
      // A node's commitment is only accountable if it is closed out; the
      // terminal transition is the one place that knows the verdict.
      const outcome = snapshot.value === 'COMPLETE' ? 'completed'
        : snapshot.value === 'CANCELLED' ? 'cancelled'
        : 'failed';
      // What the node actually produced is the evidence its commitment closes
      // on. Recording it here, at the one point that knows the verdict, is what
      // makes `evidence` more than a field that was always empty.
      recordOutcomeInMemory(db, nodeId, snapshot.value === 'COMPLETE', now);
      // One efficiency record per task, at the one point that knows the verdict.
      // CANCELLED is 'partial', not a failure: the work stopped because someone
      // stopped it, and counting that against the success rate would make every
      // change look worse the more often people intervened.
      recordEfficiency(db, nodeId, snapshot.value === 'COMPLETE' ? 'success'
        : snapshot.value === 'CANCELLED' ? 'partial' : 'failure');
      closeDefinitionOfDone(db, nodeId, String(snapshot.value), now);
      const evidence = listArtifactsForNode(db, nodeId).map((a) => a.id);
      for (const commitment of listCommitmentsForNode(db, nodeId)) {
        updateCommitmentStatus(db, commitment.id, outcome, now);
        if (evidence.length > 0) setCommitmentEvidence(db, commitment.id, evidence, now);
      }
      deleteNodeNetworkPolicy(nodeId, NAMESPACE).catch((err) => {
        console.error(`Failed to clean up NetworkPolicy for node ${nodeId}:`, err);
      });
      // Drop the actor: otherwise every node ever run stays resident in a
      // long-lived daemon. Deferred a tick so anything awaiting this same
      // transition (waitForNodeCompletion, a delegating parent) still resolves.
      setTimeout(() => actors.delete(nodeId), 0);
    }
  });
  actor.start();
  actors.set(nodeId, actor);
  if (persisted === undefined || persisted === null) actor.send({ type: 'START' });
}

/** Stops a node and tears down its cluster-side work. Order matters: CANCEL
 *  first, so the actor reaches CANCELLED and its terminal handler releases the
 *  NetworkPolicy and closes commitments; then delete the Jobs, so an in-flight
 *  executeStep sees its Job disappear and returns the cancelled result rather
 *  than running on against a node that has already stopped. */
export async function cancelNode(db: Db, nodeId: string): Promise<void> {
  actors.get(nodeId)?.send({ type: 'CANCEL' });
  // A node cancelled while parked on approval would otherwise leave its
  // approval row pending forever — reported as "waiting on you" for a node
  // that no longer exists, and offered by /approve's completion.
  const pending = getPendingApproval(db, nodeId);
  if (pending) resolveApproval(db, pending.id, 'cancelled', new Date().toISOString());
  await deleteNodeJobs(nodeId, NAMESPACE);
}

/**
 * Stops a whole task: every agent under a root, at once.
 *
 * Cancelling agents one at a time does not work on an organization. A parent
 * whose child is cancelled sees its delegation fail, re-plans, and dispatches a
 * fresh sandbox — so stopping the tree from the bottom fights itself, and
 * stopping it from the top leaves the children running with nobody waiting on
 * them. The fix is to make the whole thing one act: every CANCEL is delivered
 * before anything is awaited, so no agent is still alive to react to a sibling
 * stopping.
 *
 * Cluster teardown then happens for all of them together, because 57 sequential
 * round-trips to Kubernetes is a minute of a person watching a button spin.
 */
export async function cancelSubtree(db: Db, rootId: string): Promise<{ stopped: string[] }> {
  const ids = subtreeNodeIds(db, rootId);
  const now = new Date().toISOString();
  const stopped: string[] = [];

  // Every CANCEL first, synchronously. No awaits in this loop.
  for (const id of ids) {
    const node = getNode(db, id);
    if (!node || TERMINAL_STATES.has(node.state)) continue;
    stopped.push(id);

    const actor = actors.get(id);
    if (actor) {
      actor.send({ type: 'CANCEL' });
    } else {
      // Interrupted by a restart, or otherwise actorless: there is nothing to
      // send to, so the record is closed directly. Without this, stopping a
      // task left its interrupted agents sitting on the Desk offering a Resume
      // for work the person had just stopped.
      updateNodeState(db, id, 'CANCELLED', now);
      clearNodeSnapshot(db, id);
      const payload = { state: 'CANCELLED' };
      const eventId = appendEvent(db, { nodeId: id, type: 'state.transition', payload, createdAt: now });
      publish({ id: eventId, nodeId: id, type: 'state.transition', payload, createdAt: now });
      for (const commitment of listCommitmentsForNode(db, id)) {
        updateCommitmentStatus(db, commitment.id, 'cancelled', now);
      }
    }

    const pending = getPendingApproval(db, id);
    if (pending) resolveApproval(db, pending.id, 'cancelled', now);
  }

  // Then the cluster, all at once. A teardown that fails must not stop the
  // others: the run is already over as far as the record is concerned.
  await Promise.allSettled(stopped.flatMap((id) => [
    deleteNodeJobs(id, NAMESPACE),
    deleteNodeNetworkPolicy(id, NAMESPACE),
  ]));

  return { stopped };
}

export function getNodeActor(nodeId: string): Actor<typeof nodeMachine> | undefined {
  return actors.get(nodeId);
}

export function sendToNode(nodeId: string, event: NodeMachineEvent): void {
  const actor = actors.get(nodeId);
  if (!actor) throw new Error(`No active actor for node ${nodeId}`);
  actor.send(event);
}

/** How long a parent waits for one child.
 *
 *  This is a safety net, not a schedule: a child always reaches a terminal state
 *  on its own, because every step it takes is already bounded. It has to be
 *  larger than everything a child can legitimately spend, or the parent gives up
 *  on a child that is merely slow — which is what happened at the old five
 *  minutes. A child plans for up to PLAN_TIMEOUT_MS, executes for up to ten
 *  minutes, may retry that three times, and queues behind the sandbox limiter
 *  throughout. Giving up early is expensive twice over: the parent then does the
 *  work itself while the child is still doing it. */
const CHILD_WAIT_TIMEOUT_MS = 45 * 60_000;

export async function waitForNodeCompletion(
  nodeId: string,
  timeoutMs = CHILD_WAIT_TIMEOUT_MS,
): Promise<{ succeeded: boolean }> {
  const actor = actors.get(nodeId);
  if (!actor) throw new Error(`No active actor for node ${nodeId}`);
  const snapshot = await waitFor(actor, (s) => s.status === 'done', { timeout: timeoutMs })
    .catch(() => {
      throw new Error(
        `Gave up waiting for agent ${nodeId} after ${Math.round(timeoutMs / 60_000)} minutes. It is still running; its work is not included here.`,
      );
    });
  // COMPLETE is the only terminal state that means the goal was met — FAILED and
  // ESCALATE are both terminal too, and neither is a success.
  return { succeeded: snapshot.value === 'COMPLETE' };
}

import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createActor, fromPromise, waitFor, type Actor } from 'xstate';
import { nodeMachine, type NodeMachineEvent, type ValidationVerdict } from './node-machine.js';
import type { Db } from '../db/client.js';
import { updateNodeState, getNode, insertNode, listNodes, setNodeRuntime } from '../db/queries/nodes.js';
import { appendEvent, listEventsForNode } from '../db/queries/events.js';
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
import { routeProvider, type ProviderCapability } from '../intelligence/provider-router.js';
import { buildPlanPrompt, parseSubgoals } from '../intelligence/plan.js';
import { buildSynthesisPrompt, type ChildReport } from '../intelligence/synthesize.js';
import { decideIntegration } from '../intelligence/integrate-results.js';
import { answerOf } from '../db/queries/answers.js';
import { recordRunOutcome, getRuntimeStats, recordStrategyOutcome, listMemory } from '../db/queries/memory.js';
import { getCostForNodes } from '../db/queries/stats.js';
import { resolveCredentials, checkCredentials } from '../execution/credentials.js';
import { sandboxLimiter, maxConcurrentFromEnv, CRITICAL_PATH } from '../execution/dispatch-limit.js';
import { efficiencyLedger, type LedgerRole } from '../efficiency/ledger.js';
import type { EfficiencyOutcome } from '../efficiency/metrics.js';
import type { DispatchReceipt } from '../context/dispatch-context.js';
import { buildRolePrompt } from '../prompts/roles.js';
import os from 'node:os';
import { deleteNodeNetworkPolicy, deleteNodeJobs } from '../k8s/cleanup.js';
import { subtreeNodeIds } from '../db/queries/nodes.js';
import { allowedTools, isReadOnly } from '../engines/enforce-tools.js';
import type { Authority } from '../schemas/node-contract.js';
import { forkWorkspace, type WorkspaceFork } from '../execution/workspace-fork.js';
import type { ToolGrant, RuntimeAdapter, StructuredEvent } from '../adapters/adapter.js';
import { setNodeSnapshot, clearNodeSnapshot } from '../db/queries/nodes.js';
import { insertDodItems, listDodForNode, setDodState } from '../db/queries/dod.js';
import { dispatchOptionsFor, planCacheTtlHours, repoMapTokenBudget, rolePromptsEnabled, runtimeMode, resultCacheTtlHours, type DispatchRole } from '../config/efficiency.js';
import { routeModel } from '../intelligence/model-router.js';
import { assessDecomposition } from '../intelligence/decompose.js';
import { repoHead, repoDirty, repoIdentity } from '../execution/git-state.js';
import { putKnowledge } from '../evidence/store.js';
import { extractAnchors } from '../efficiency/task-economics.js';
import { planCacheKey, getCachedPlan, putCachedPlan } from '../db/queries/plan-cache.js';
import { resultCacheKey, getCachedResult, putCachedResult } from '../db/queries/result-cache.js';
import { dependenciesFromEvents, buildDependencyFingerprint, dependenciesValid } from '../context/dependencies.js';
import { indexRunObservations, scoreProjection } from './run-index.js';
import { buildAgentEnvelope, renderEnvelope, EnvelopeError } from '../intelligence/agent-envelope.js';
import { putAgentEnvelope, getAgentEnvelope } from '../db/queries/envelopes.js';
import { scopeOf } from '../context/types.js';
import { judgeTask } from '../intelligence/task-judge.js';
import { prepareDispatch, type DispatchPreparation } from '../decision/dispatch-preparation.js';
import { decideStrategy } from '../decision/strategy-gate.js';
import { strategyPriorFor } from '../decision/strategy-memory.js';
import { observationFrom } from '../learning/hierarchical.js';
import { buildCounterfactualObservation } from '../learning/counterfactual.js';
import type { ExecutionStrategy } from '../decision/strategy-gate.js';
import { policyVersion } from '../efficiency/policy-version.js';
import { evaluateSpendGuard, type SpendGuardState } from '../efficiency/spend-guard.js';
import { summarizeExecutionTrajectory, executionSnapshot, UNKNOWN_PROGRESS } from '../efficiency/progress-signals.js';
import { executionPolicyForGoal, calibrate, effectiveTurnCap, currentPolicyVersions, EXECUTION_POLICY_VERSION } from '../efficiency/policy.js';
import { activePolicyChanges } from '../learning/policy-experiments.js';
import { templateFor, pruneTemplate } from '../intelligence/execution-templates.js';
import type { TaskClass } from '../intelligence/task-judge.js';
import { decideExecutionPath, authorizeExecution, type DecisionReceipt } from '../decision/engine.js';
import { withRepoContext } from '../intelligence/repo-map.js';
import { dispatchContextFor, warmRepoInventory } from '../context/dispatch-context-cache.js';
import { recordDispatchUsage, turnsForNode } from '../db/queries/tokens.js';
import { shouldRetryWithoutModel } from '../execution/tokens.js';
import { readOnlyPlanningGrant, investigativeExecuteGrant } from './dispatch-helpers.js';
import {
  evaluateBoundary, economicStateFor, forgetNode, isIntervention, registerEvidenceSources,
  markRecovered, consumeRecoveryFlag, recordRecoveryAttempt,
} from './economic-runtime.js';
import { tombstoneFor } from '../recovery/engine.js';
import { evaluateFallback, mustBlockAction, detectFaults } from '../decision/fallback.js';
import { validate, type ValidationEvidence, type ValidationResult } from '../validation/engine.js';
import { contractFor } from '../validation/contract.js';
import { validationProfileFor, contractForProfile, meetsMinimumLevel } from '../validation/profile.js';
import { taskEconomicsFor } from '../efficiency/task-economics.js';
import { requestEvidenceAtBoundary, renderAcquiredEvidence } from '../context/evidence-actions.js';
import type { ActionDecision } from '../decision/actions.js';
import type { EconomicState } from '../decision/state.js';
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

/** Applies what a forked child wrote back onto the tree it was forked from.
 *
 *  `git apply --3way`, not a filesystem copy: siblings that both forked from
 *  the same revision and both wrote can still integrate cleanly one after the
 *  other, and a real overlapping edit fails loudly here instead of silently
 *  clobbering whichever sibling's write landed second. `false` means the merge
 *  did not go through — the caller must not report that child a success, since
 *  its writes never reached the tree the rest of the run sees. */
export function integrateFork(fork: WorkspaceFork): boolean {
  try {
    execFileSync('git', ['add', '-A'], { cwd: fork.path, stdio: 'ignore' });
    const diff = execFileSync('git', ['diff', '--cached', '--binary'], { cwd: fork.path, encoding: 'utf8' });
    if (!diff.trim()) return true;
    execFileSync('git', ['apply', '--3way', '--binary'], { cwd: fork.basePath, input: diff, stdio: ['pipe', 'ignore', 'ignore'] });
    return true;
  } catch (err) {
    console.error(`Failed to integrate the fork at ${fork.path} back onto ${fork.basePath}:`, err);
    return false;
  }
}

export function realDelegateDeps(db: Db, parentId?: string): DelegateChildDeps {
  // Scoped to one delegation call, which is exactly the lifetime a fork needs:
  // created when its child is, released once that child has finished and its
  // writes have been integrated (or discarded, on failure).
  const forks = new Map<string, WorkspaceFork>();
  return {
    // What the work graph decided, as a durable row rather than a log line.
    // A fan-out that serialized two siblings, or refused to start a third, is
    // the kind of thing a comparison needs to be able to attribute afterwards.
    recordSchedule: (schedule) => {
      if (!parentId) return;
      try {
        const payload = {
          topology: schedule.topology,
          groups: schedule.plan.parallelGroups,
          sharedEvidenceIds: schedule.plan.sharedEvidenceIds,
          informationDuplication: schedule.plan.informationDuplication,
          serializationReasons: schedule.plan.serializationReasons,
          cancelled: schedule.cancelled,
        };
        appendEvent(db, {
          nodeId: parentId, type: 'delegation.scheduled', payload,
          createdAt: new Date().toISOString(),
        });
        for (const entry of schedule.cancelled) {
          publishProgress(db, parentId, `Not starting "${entry.goal}" — ${entry.reason}`);
        }
      } catch (err) {
        // Telemetry must never cost a delegation.
        console.error(`Failed to record the delegation schedule for node ${parentId}:`, err);
      }
    },
    // Why a fan-out was funded or refused, in the durable record. A plan
    // rejected silently is a delegation capability that looks like it
    // disappeared.
    recordPlanValidation: (validation) => {
      if (!parentId) return;
      try {
        insertMemoryRow(db, 'delegation_plan_validation', validation.valid ? 'valid' : 'rejected', validation, parentId);
      } catch (err) {
        console.error(`Failed to record the delegation plan verdict for node ${parentId}:`, err);
      }
    },
    createChildNode: (parentId, goal, siblingCount, approvedBudgetUsd) => {
      const parent = getNode(db, parentId);
      if (!parent) throw new Error(`Parent node ${parentId} not found`);
      const id = randomUUID();
      const now = new Date().toISOString();
      const authority = childAuthority(parent.contract.authority, siblingCount, approvedBudgetUsd);
      // Parallel children that can write must not share the parent's mutable
      // working tree — two siblings writing the same checkout race, and the
      // last one to finish wins silently. A read-only child cannot corrupt
      // anything and shares the parent's tree for free; forkWorkspace's own
      // failure path (not a git repo, no git available) falls back to sharing
      // it too, which only gives up isolation, not correctness beyond what the
      // runtime already had.
      let repoPath = parent.repoPath;
      if (siblingCount > 1 && !isReadOnly(authority) && parent.repoPath) {
        const fork = forkWorkspace(parent.repoPath, 'HEAD', id);
        if (fork) {
          repoPath = fork.path;
          forks.set(id, fork);
        }
      }
      insertNode(db, {
        id, parentId, goal,
        contract: { ...parent.contract, goal, authority },
        state: 'CREATED', repoPath, createdAt: now, updatedAt: now,
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
    recordEnvelope: (childId, goal, approvedBudgetUsd) => {
      const child = getNode(db, childId);
      if (!child) return;
      try {
        const grant = grantOf(child.contract.authority);
        putAgentEnvelope(db, childId, buildAgentEnvelope({
          goal,
          // The parent's standing constraints are the child's too: a mandate
          // does not stop applying because the work was handed on.
          constraints: child.contract.constraints ?? [],
          budget: {
            usd: approvedBudgetUsd || child.contract.authority.budget_usd,
            maxTurns: dispatchOptionsFor('execute').maxTurns,
          },
          capabilities: grant.allowedTools ?? [],
          scope: scopeOf(grant.allowedTools, grant.readOnly),
        }));
      } catch (err) {
        // An envelope that cannot be built costs the child its handoff, never
        // its dispatch — including EnvelopeError, which is a refusal to hand
        // over something unsafe and must not become a failed delegation.
        console.error(
          `Failed to build the envelope for node ${childId}:`,
          err instanceof EnvelopeError ? err.message : err,
        );
      }
    },
    startChild: (childId, goal) => startNodeActor(db, childId, goal),
    waitForChild: async (childId) => {
      const result = await waitForNodeCompletion(db, childId);
      const fork = forks.get(childId);
      if (!fork) return result;
      forks.delete(childId);
      try {
        if (result.succeeded && !integrateFork(fork)) {
          // The child did its work; the tree the rest of the run sees never got
          // it. Reporting success here would be reporting a change that does
          // not exist outside a directory about to be deleted.
          return { succeeded: false };
        }
        return result;
      } finally {
        fork.release();
      }
    },
  };
}

const ADAPTERS = { 'claude-code': claudeCodeAdapter, codex: codexAdapter };

/** Which provider serves this node, decided from what the organization has
 *  learned rather than from a constant. The choice is persisted as a Decision
 *  and published as an event, so it is inspectable in the same place delegation
 *  is.
 *
 *  Asked *after* the model is chosen and never allowed to revise it: a provider
 *  that cannot serve the model is ruled out rather than substituted, because an
 *  outage silently becoming a weaker model is a quality decision nobody took.
 *
 *  ORG_RUNNER_IMAGE still short-circuits the whole thing: it means "dispatch a
 *  stand-in image", and no real harness runs inside it to choose between. */
function chooseAdapter(db: Db, nodeId: string, model?: string) {
  if (runnerImageOverride()) return stopgapAdapter;

  // Capability is asked of the adapter rather than hardcoded by name, the same
  // way `modelFor` does — a new runtime answers for itself. Health is optimistic
  // until this runtime learns to observe it; the interface exists so that
  // learning does not require a rewrite.
  const candidates: ProviderCapability[] = Object.entries(ADAPTERS).map(([name, adapter]) => ({
    provider: name,
    models: model !== undefined && adapter.servesModel?.(model) === false ? [] : null,
    health: 'healthy',
  }));

  const route = routeProvider({ model, candidates, stats: getRuntimeStats(db) });
  const adapter = ADAPTERS[(route.provider ?? '') as keyof typeof ADAPTERS] ?? claudeCodeAdapter;
  const now = new Date().toISOString();

  const breakdown = route.breakdown ?? { score: 0, reason_fast_path: 1 };
  setNodeRuntime(db, nodeId, adapter.name, now);
  insertDecision(db, {
    id: randomUUID(), nodeId, type: 'runtime_selection',
    outcome: adapter.name, breakdown, createdAt: now,
  });
  const payload = {
    outcome: adapter.name, breakdown, type: 'runtime_selection',
    reason: route.reason, rejected: route.rejected,
  };
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
 *  number the cost views already read, recorded alongside the token counts.
 *
 *  The *last* `result` event only, matching `usageFromEvents`'s convention
 *  (execution/tokens.ts). `total_cost_usd` is the session's running total, not
 *  a per-event delta: a dispatch that spawns background subagents gets one
 *  `result` event per subagent completion in addition to the main turn's, each
 *  carrying that same cumulative figure. Summing them (the old behaviour)
 *  multiplied the true cost by however many of those notifications arrived —
 *  a run with 5 subagents reported roughly 6x its real spend. */
function costFromEvents(events: { type: string; payload: unknown }[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type !== 'result') continue;
    return Number((events[i].payload as { total_cost_usd?: number } | null)?.total_cost_usd ?? 0);
  }
  return 0;
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

/** Publishes the receipt for a decision the engine took.
 *
 *  The decisions table holds the delegation score and nothing else; this is the
 *  channel for every other choice — reuse over a fresh run, a tool over a model,
 *  stopping rather than gathering. Same reasoning as `context.receipt`: a
 *  dispatch's only channel is its argv, so the event log is where the
 *  explanation has to live. */
function publishDecisionReceipt(db: Db, nodeId: string, decision: DecisionReceipt): void {
  const now = new Date().toISOString();
  const payload = {
    chosen: decision.chosen,
    reason: decision.reason,
    confidence: decision.confidence,
    estimate: decision.estimate,
    alternatives: decision.alternatives,
    gate: decision.gate ?? null,
    fastPath: decision.fastPath,
  };
  try {
    const id = appendEvent(db, { nodeId, type: 'decision.receipt', payload, createdAt: now });
    publish({ id, nodeId, type: 'decision.receipt', payload, createdAt: now });
  } catch (err) {
    // Explaining a decision must never cost the decision.
    console.error(`Failed to publish a decision receipt for node ${nodeId}:`, err);
  }
}

/** What the runtime already holds the product of, for pruning a template.
 *
 *  Deliberately coarse: a repository projection was built, so `repo_structure`
 *  is known. Anything finer would be claiming knowledge of a step's product
 *  from the fact that something adjacent to it happened. */
function indexedKnowledge(db: Db, nodeId: string): Set<string> {
  const known = new Set<string>();
  try {
    for (const event of listEventsForNode(db, nodeId)) {
      if (event.type === 'context.receipt') known.add('repo_structure');
      if (event.type === 'exec.result') known.add('edit');
    }
  } catch {
    // A template that cannot be pruned is the full template, which is correct
    // and merely less efficient.
  }
  return known;
}

/** Publishes the execution template for this task class and what was pruned
 *  from it. Instrumentation, not instruction — the agent is never handed a step
 *  list, because that would cost tokens on every dispatch to say something the
 *  runtime is already deciding. */
function publishExecutionPlan(db: Db, nodeId: string, taskClass: TaskClass, known: Set<string>): void {
  try {
    const pruned = pruneTemplate(templateFor(taskClass), known);
    const payload = {
      taskClass,
      steps: pruned.steps.map((step) => ({ name: step.name, intent: step.intent, optional: step.optional })),
      removed: pruned.removed.map((entry) => ({ name: entry.step.name, reason: entry.reason })),
    };
    const id = appendEvent(db, { nodeId, type: 'execution.plan', payload, createdAt: new Date().toISOString() });
    publish({ id, nodeId, type: 'execution.plan', payload, createdAt: new Date().toISOString() });
  } catch (err) {
    console.error(`Failed to publish an execution plan for node ${nodeId}:`, err);
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
    applied: receipt.applied ?? false,
  };
  const id = appendEvent(db, { nodeId, type: 'context.receipt', payload, createdAt: now });
  publish({ id, nodeId, type: 'context.receipt', payload, createdAt: now });
  // The same fact, told to the task-level ledger. Without it a before/after
  // comparison can say spend moved and cannot say what moved it — which is the
  // difference between a measurement and an anecdote.
  try {
    ledger.recordContextPlan(nodeId, {
      candidates: receipt.candidates ?? receipt.selected.length + receipt.dropped.length,
      selected: receipt.selected.length,
      estimatedTokens: receipt.selectedTokens,
      contextPolicyVersion: receipt.policyVersion ?? null,
      executionPolicyVersion: EXECUTION_POLICY_VERSION,
      // The composite: architecture, policy generation and decision engine
      // together. Without it two runs of different engine generations average
      // into a number describing neither.
      policyVersion: currentPolicyVersions().policy,
    });
  } catch (err) {
    console.error(`Failed to record the context plan for node ${nodeId}:`, err);
  }
}

/** The economic control plane, asked once, at the moment before a dispatch is
 *  built.
 *
 *  This is the *existing* execution boundary — the point where the goal, the
 *  context and the grant are assembled — not a new one. That matters: the plan
 *  this implements forbids a live context channel into a running sandbox, and
 *  the reason is that a boundary which already exists costs nothing to reuse
 *  while a new one has to be kept alive between turns.
 *
 *  Returns the text to prepend to the next dispatch, or empty. Empty is the
 *  overwhelmingly common answer and is a genuine no-op: the dispatch that
 *  follows is byte-identical to the one that would have happened without any of
 *  this.
 *
 *  Total. Every failure path returns empty rather than throwing, because this
 *  sits on the path to a dispatch and an optimizer that can fail a dispatch by
 *  failing to optimize is worse than no optimizer. */
async function economicBoundary(
  db: Db,
  input: {
    nodeId: string; goal: string; worktreePath: string;
    fullArtifactRequests?: DispatchReceipt['fullArtifactRequests'];
  },
): Promise<string> {
  if (runtimeMode() !== 'full') return '';
  try {
    const revision = repoHead(input.worktreePath) ?? undefined;
    // Registered here rather than at import: the source needs a database, and
    // this is the first point that has one. Idempotent by name.
    registerEvidenceSources(db);
    const { decision, state, cycle } = evaluateBoundary(db, {
      nodeId: input.nodeId, goal: input.goal, repositoryRevision: revision,
      repository: repoIdentity(input.worktreePath) ?? undefined,
      fullArtifactRequests: input.fullArtifactRequests,
    });

    // Recorded whether or not anything was decided: what the orchestrator cost
    // is the number that decides whether it was worth building, and a cost only
    // recorded when it acted would make it look free exactly when it is not.
    if (cycle.cost.tokens > 0) publishOrchestrationCost(db, input.nodeId, cycle.cost, decision);
    // Recorded at the moment it was made, before anything is known about how it
    // went — the only point at which a prediction is a prediction rather than a
    // description of what happened.
    if (decision) {
      try {
        ledger.recordDecision(input.nodeId, {
          decisionId: decision.decisionId,
          stateVersion: decision.stateVersion,
          action: decision.action.kind,
          predicted: {
            tokenDelta: decision.action.expectedTokenBenefit - decision.action.tokenCost,
            qualityDelta: decision.action.expectedQualityBenefit - decision.action.qualityRisk,
            latencyDelta: decision.action.expectedLatencyBenefit - decision.action.latencyCost,
            successProbability: 1 - decision.action.failureRisk,
          },
          orchestrationCost: cycle.cost.tokens,
        });
      } catch (err) {
        console.error(`Failed to record the decision for node ${input.nodeId}:`, err);
      }
    }
    if (!isIntervention(decision)) return '';

    // The last gate before anything is acted on. A decision that is not
    // confident enough for what it would spend, or that rests on signals that
    // were not there, does what Baseline would have done — which is nothing —
    // rather than getting its own reduced-aggression path.
    const fallback = evaluateFallback({
      state,
      decision,
      faults: [
        ...detectFaults(state),
        ...(cycle.cost.reason === 'decision_engine_error' ? ['decision_engine_error' as const] : []),
      ],
    });
    if (fallback.mode === 'baseline') {
      publishFallback(db, input.nodeId, fallback.reason, mustBlockAction(fallback));
      return '';
    }

    return await carryOut(db, decision!, state, input);
  } catch (err) {
    console.error(`The economic boundary failed for node ${input.nodeId}; the dispatch proceeds unchanged:`, err);
    return '';
  }
}

/** What survives a strategy the engine just ruled out, read back into the
 *  words a dispatch can act on. Ruled-out beliefs first — the one thing a
 *  blind retry gets wrong is walking straight back into them — then what is
 *  already established and safe to build on without re-deriving it. */
function renderPivotGuidance(invalidatedIds: string[], retainedIds: string[]): string {
  const strip = (id: string) => id.replace(/^observed:/, '');
  const lines = [
    'A previous attempt at this failed and its approach has been ruled out — do not repeat it; try a genuinely different approach.',
  ];
  if (invalidatedIds.length > 0) {
    lines.push(`Ruled out, do not retry as-is: ${invalidatedIds.map(strip).join(', ')}`);
  }
  if (retainedIds.length > 0) {
    lines.push(`Already established from the previous attempt and safe to reuse: ${retainedIds.map(strip).join(', ')}`);
  }
  return lines.join('\n');
}

/** Carries out a justified `recover`: tombstones the failed strategy so the
 *  next attempt does not walk into beliefs this one already disproved, and
 *  flags the node so the spend guard's stall check — which would otherwise
 *  read the exact same stuck state and stop the node in the same breath —
 *  gives this one pivot the turn it was just priced for.
 *
 *  Without this the recovery ladder in `recovery/engine.ts` is priced, ranked
 *  and recorded, and never once changes what happens: `evaluateRecovery` can
 *  judge a retry justified and the run stops anyway, on the same turn, for the
 *  same reason recovery just answered. That mismatch is the mechanism behind
 *  a documented regression — the guard stopping a task the baseline
 *  completed — not a coincidence of two modules disagreeing in the abstract. */
function carryOutRecovery(db: Db, decision: ActionDecision, state: EconomicState, nodeId: string): string {
  const { action } = decision;
  const retainedIds = Array.isArray(action.metadata.retainedEvidenceIds)
    ? (action.metadata.retainedEvidenceIds as string[]) : [];
  const invalidatedIds = Array.isArray(action.metadata.invalidatedEvidenceIds)
    ? (action.metadata.invalidatedEvidenceIds as string[]) : [];
  const failureSignature = typeof action.metadata.failureSignature === 'string'
    ? action.metadata.failureSignature : 'unknown';
  const reasonCodes = Array.isArray(action.metadata.reasonCodes) ? (action.metadata.reasonCodes as string[]) : [];

  recordRecoveryAttempt(nodeId, tombstoneFor({
    id: `${nodeId}:${decision.stateVersion}`,
    evaluation: {
      justified: true,
      expectedSuccessProbability: action.expectedProgress,
      expectedCost: action.tokenCost,
      retainedEvidenceIds: retainedIds,
      invalidatedEvidenceIds: invalidatedIds,
      reasonCodes,
    },
    failureSignature,
    tokensSpent: state.resources.consumedTokens,
  }));
  markRecovered(nodeId);
  publishProgress(db, nodeId, 'A prior approach did not work — pivoting rather than repeating it.');

  if (invalidatedIds.length === 0 && retainedIds.length === 0) return '';
  return renderPivotGuidance(invalidatedIds, retainedIds);
}

/** What changes about a dispatch when the decision layer intervenes.
 *
 *  Two capabilities are carried out today: acquiring evidence, and recovering
 *  from a failed strategy. Everything else the decision layer can choose —
 *  validating, narrowing, scheduling — is carried out by machinery that lands
 *  in later tasks. Until then those decisions are *recorded* and not acted on,
 *  which is the honest behaviour: a decision nobody can carry out must not be
 *  quietly reported as carried out, and must certainly not stop the run. */
async function carryOut(
  db: Db,
  decision: ActionDecision,
  state: EconomicState,
  input: { nodeId: string; goal: string; worktreePath: string },
): Promise<string> {
  const { action } = decision;

  if (action.kind === 'recover') return carryOutRecovery(db, decision, state, input.nodeId);

  const path = typeof action.metadata.path === 'string' ? action.metadata.path : null;
  if (action.kind !== 'acquire_evidence' || !path) return '';

  const result = await requestEvidenceAtBoundary({
    state,
    worktreePath: input.worktreePath,
    repositoryRevision: state.repositoryRevision,
    request: {
      candidateId: path,
      evidenceLevel: 'L3',
      expectedBenefit: action.expectedTokenBenefit,
      acquisitionCost: action.tokenCost,
      qualityRisk: action.qualityRisk,
      reasonCodes: decision.reasonCodes,
    },
  });

  publishEvidenceOutcome(db, input.nodeId, path, result.acquired, result.tokens, result.reasonCodes);
  if (!result.acquired || !result.content) return '';
  publishProgress(db, input.nodeId, `Sending ${path} rather than letting the agent go and find it`);
  return renderAcquiredEvidence(path, result.content);
}

function publishOrchestrationCost(
  db: Db,
  nodeId: string,
  cost: { tokens: number; latencyMs: number; reason: string },
  decision: ActionDecision | undefined,
): void {
  try {
    const now = new Date().toISOString();
    const payload = {
      ...cost,
      decisionId: decision?.decisionId ?? null,
      stateVersion: decision?.stateVersion ?? null,
      action: decision?.action.kind ?? null,
      reasonCodes: decision?.reasonCodes ?? [],
    };
    const id = appendEvent(db, { nodeId, type: 'economic.decision', payload, createdAt: now });
    publish({ id, nodeId, type: 'economic.decision', payload, createdAt: now });
  } catch (err) {
    console.error(`Failed to record the orchestration cost for node ${nodeId}:`, err);
  }
}

/** Why the control plane stood down.
 *
 *  Recorded rather than silent: "Full Architecture fell back on 30% of tasks"
 *  and "on which" is the difference between a benchmark result that can be
 *  acted on and one that can only be reported. */
function publishFallback(db: Db, nodeId: string, reason: string, blocked: boolean): void {
  try {
    const now = new Date().toISOString();
    const payload = { reason, blocked };
    const id = appendEvent(db, { nodeId, type: 'economic.fallback', payload, createdAt: now });
    publish({ id, nodeId, type: 'economic.fallback', payload, createdAt: now });
  } catch (err) {
    console.error(`Failed to record the fallback for node ${nodeId}:`, err);
  }
}

function publishEvidenceOutcome(
  db: Db, nodeId: string, path: string, acquired: boolean, tokens: number, reasonCodes: string[],
): void {
  try {
    const now = new Date().toISOString();
    const payload = { path, acquired, tokens, reasonCodes };
    const id = appendEvent(db, { nodeId, type: 'economic.evidence', payload, createdAt: now });
    publish({ id, nodeId, type: 'economic.evidence', payload, createdAt: now });
  } catch (err) {
    console.error(`Failed to record the evidence outcome for node ${nodeId}:`, err);
  }
}

/** Accounting, and only accounting. A dispatch that ran and produced an answer
 *  must not be thrown away because writing down what it cost failed — every
 *  caller here is inside a try that would turn that into "no plan" or "no
 *  answer", which is a far worse outcome than a missing row in `org tokens`. */
function recordUsage(
  db: Db,
  r: {
    nodeId: string; role: string; model: string | null; usage: DispatchUsage;
    costUsd: number; tokensAvoided?: number;
    /** Time inside the dispatch spent before the runtime said anything. */
    startupMs?: number;
  },
): void {
  try {
    recordDispatchUsage(db, {
      ...r,
      createdAt: new Date().toISOString(),
      policy: currentPolicyVersions(),
    });
  } catch (err) {
    console.error(`Failed to record ${r.role} token usage for node ${r.nodeId}:`, err);
  }
  // The same fact, told to the in-memory ledger that rolls a whole task up into
  // one record. Separate from the row above on purpose: the row is per dispatch
  // and outlives the daemon, the ledger is per task and does not.
  // 'plan:cache-hit' is not a dispatch — it is the dispatch that did not happen,
  // which is the number this whole phase exists to move.
  if (r.role === 'plan:cache-hit') { ledger.recordAvoided(r.nodeId, 'plan'); return; }
  // The expensive one. `tokensAvoided` is what the reused dispatch cost the
  // last time it was actually paid for, so a hit reports a measurement rather
  // than an estimate of what it saved.
  if (r.role === 'execute:cache-hit') { ledger.recordAvoided(r.nodeId, 'execute', r.tokensAvoided ?? 0); return; }
  const timing = drainTiming(r.nodeId);
  ledger.recordDispatch(r.nodeId, {
    role: r.role as LedgerRole,
    usage: r.usage,
    costUsd: r.costUsd,
    ms: timing.dispatchMs,
    queuedMs: timing.queuedMs,
    startupMs: r.startupMs,
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
  const mode = runtimeMode();
  try {
    const node = getNode(db, nodeId);
    const assessment = assessDecomposition(goal);
    const route = routeModel({
      role,
      complexity: assessment.complexity,
      investigative: assessment.investigative,
      budgetUsd: node?.contract.authority.budget_usd ?? 0,
      spentUsd: getCostForNodes(db, [nodeId]),
    });
    // Recorded in *both* modes, and applied in only one. This is what the
    // retired `shadow` mode was actually for — knowing what routing would have
    // chosen on a Baseline run — and it turns out to need a memory row rather
    // than a third product mode.
    insertMemoryRow(db, 'model_route', role, { ...route, mode }, nodeId);
    return mode === 'baseline' ? configured : route.model;
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
  result: { usage: DispatchUsage; events: { type: string; payload: unknown }[]; startupMs?: number },
): void {
  const timing = drainTiming(nodeId);
  ledger.recordDispatch(nodeId, {
    role, usage: result.usage, costUsd: costFromEvents(result.events),
    ms: timing.dispatchMs, queuedMs: timing.queuedMs, startupMs: result.startupMs, superseded: true,
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
  rememberAnswer(db, nodeId, text, now);
}

/** The shortest answer worth storing. Below this it is an acknowledgement, and
 *  a store full of "Done." teaches nothing while still costing every future
 *  query a row to rank. */
const MIN_REMEMBERABLE_ANSWER = 80;

/** Writes what a node concluded into the cross-run knowledge store.
 *
 *  The read side of this store has been wired since the economic boundary
 *  landed (`queryKnowledge`, via the registered evidence sources) — but nothing
 *  ever wrote to it, so every lookup missed and the whole "reading beats
 *  re-deriving" claim was untested in production. This is the write side, and
 *  `publishAnswer` is the only place a node states a conclusion, so it is the
 *  only place that needs it.
 *
 *  Stored as an `observation` and *not* validated: this is what an agent said,
 *  which `reuse.ts` already prices far below something a check confirmed. A
 *  node whose validation passes is upgraded separately; recording a self-report
 *  as validated here would be exactly the false-success failure the
 *  architecture exists to stop.
 *
 *  Total: a knowledge write must never cost a node its answer. */
function rememberAnswer(db: Db, nodeId: string, text: string, at: string): void {
  if (text.trim().length < MIN_REMEMBERABLE_ANSWER) return;
  try {
    const node = getNode(db, nodeId);
    const worktreePath = node?.repoPath ?? process.env.ORG_WORKTREE_PATH;
    if (!worktreePath) return;
    const repository = repoIdentity(worktreePath);
    const revision = repoHead(worktreePath);
    // Knowledge that cannot say which repository or which revision it is about
    // is knowledge nothing can safely reuse.
    if (!repository || !revision) return;
    putKnowledge(db, {
      kind: 'observation',
      content: text,
      repository,
      revision,
      sourcePaths: extractAnchors(node?.goal ?? ''),
      // Mid-scale on purpose. An unvalidated self-report is worth something —
      // it is why the run happened — and nowhere near a checked fact.
      confidence: 0.5,
      validated: false,
      createdAt: at,
    });
  } catch (err) {
    console.error(`Failed to remember the answer for node ${nodeId}:`, err);
  }
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

  // Recorded in both modes and acted on in one. Baseline synthesizes
  // unconditionally, as this branch always did, and still writes down what the
  // decision would have been — which is what makes a matched comparison
  // readable afterwards.
  const mode = runtimeMode();
  insertMemoryRow(db, 'integration_decision', decision.kind, {
    kind: decision.kind,
    reason: decision.kind === 'synthesize' ? decision.reason : null,
    applied: mode === 'full',
  }, nodeId);
  if (mode === 'full' && (decision.kind === 'return_child' || decision.kind === 'merge')) {
    ledger.recordAvoided(nodeId, 'synthesize');
    publishProgress(db, nodeId, decision.kind === 'merge'
      ? `Combined ${children.length} agents' results directly — no extra model call was needed`
      : "One agent answered this; returning its answer rather than paying to reword it");
    return decision.text;
  }
  // Stripping the envelopes is part of the change, so only a Full run does it.
  // A Baseline run sends the reports exactly as it always did.
  const synthesisChildren = mode === 'full' && decision.kind === 'synthesize' ? decision.children : children;

  const credentials = checkCredentials(os.homedir(), process.env.ANTHROPIC_API_KEY);
  if (!credentials.ok) return '';

  publishProgress(db, nodeId, `Combining what ${children.length} agents reported into one answer${decision.kind === 'synthesize' ? ` (${decision.reason})` : ''}`);
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
      ? buildSynthesisPrompt(goal, synthesisChildren)
      : `${buildSynthesisPrompt(goal, synthesisChildren)}\n\n${buildRolePrompt('synthesize')}`;

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
    }), CRITICAL_PATH);

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
      startupMs: result.startupMs,
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

/** The runtime's own final answer text, off its `result` events. The same
 *  extraction the planning and synthesis paths do, and the same thing
 *  `answerOf` reads back out of the event log. */
function finalResultText(events: { type: string; payload: unknown }[]): string {
  return events
    .filter((event) => event.type === 'result')
    .filter((event) => (event.payload as { is_error?: unknown } | null)?.is_error !== true)
    .map((event) => String((event.payload as { result?: unknown } | null)?.result ?? ''))
    .join('\n')
    .trim();
}

/** The key this dispatch's answer may be stored under and served from, or null
 *  when it may not be reused at all.
 *
 *  Two conditions, each of which is the whole argument on its own:
 *
 *   - **read-only.** Reusing the answer of a run that changed something would
 *     skip the change and report it done. Read-only is what makes "we did not
 *     re-run it" equivalent to "we re-ran it": there were no side effects to
 *     lose.
 *   - **same model and same grant.** A cheaper model's answer must not be
 *     served to a request routed to a stronger one, and an answer produced
 *     under a wider grant saw more of the repository than this node may.
 *
 *  The commit is deliberately not part of the key. What makes an answer still
 *  true is whether the files it read still say what they said, which is checked
 *  on read (context/dependencies.ts) — keying on HEAD instead would invalidate
 *  every cached answer about every module on one commit to a README. */
function resultReuseKey(goal: string, grant: ToolGrant, model: string | undefined): string | null {
  if (!grant.readOnly || resultCacheTtlHours() <= 0) return null;
  return resultCacheKey(goal, model ?? '(default)', grant.allowedTools);
}

/** What the run so far looks like: mostly searching, or mostly working.
 *
 *  Read off the node's own recorded tool stream — the `exec.*` rows the live
 *  event handler already writes — rather than from a second capture pass or a
 *  model judge. Every attempt this node has made is included, deliberately: a
 *  retry that repeats the previous attempt's failing search is exactly the
 *  trajectory worth catching, and scoping to the latest attempt would hide it.
 *
 *  Unreadable stream, unreadable database, anything at all: the neutral middle.
 *  That is not a placeholder that happens to work — the guard's stall branch
 *  needs observed *absence* of progress, so unknown signals can only make it
 *  more reluctant to stop, never less. */
function trajectorySignals(db: Db, nodeId: string): {
  explorationSignal: number; progressSignal: number; repeatedFailureSignal: number;
} {
  try {
    const events = listEventsForNode(db, nodeId)
      .filter((row) => row.type.startsWith('exec.'))
      .map((row) => ({ type: row.type.slice('exec.'.length), payload: row.payload } as StructuredEvent));
    const signals = summarizeExecutionTrajectory(events);
    return {
      explorationSignal: signals.exploration,
      progressSignal: signals.progress,
      repeatedFailureSignal: signals.repeatedFailure,
    };
  } catch (err) {
    console.error(`Failed to read the trajectory for node ${nodeId}:`, err);
    return {
      explorationSignal: UNKNOWN_PROGRESS.exploration,
      progressSignal: UNKNOWN_PROGRESS.progress,
      repeatedFailureSignal: UNKNOWN_PROGRESS.repeatedFailure,
    };
  }
}

/** The economic verdict on a task, at the moment before it spends again.
 *
 *  Total, like everything else on this path: telemetry that cannot be read must
 *  not stop a task that is otherwise entitled to run, so any failure here
 *  answers GREEN. A guard that fires on its own bugs is worse than no guard —
 *  it fails runs for reasons nobody can see.
 *
 *  The node's own `budget_usd` outranks the deployment-wide cap: it is an
 *  amount someone explicitly funded this work with. Zero means "nobody costed
 *  this node", not "out of money" — the convention model-router.ts already
 *  uses — and that is when the deployment backstop applies instead. */
function evaluateTaskSpend(db: Db, nodeId: string, node: ReturnType<typeof getNode>): SpendGuardState {
  try {
    const budgetUsd = node?.contract.authority.budget_usd ?? 0;
    const policy = executionPolicyForGoal(node?.contract.goal ?? '', undefined, activePolicyChanges(db));
    const trajectory = trajectorySignals(db, nodeId);
    const guard = evaluateSpendGuard({
      spentUsd: getCostForNodes(db, [nodeId]),
      spendCapUsd: budgetUsd > 0 ? budgetUsd : policy.spendCapUsd,
      turns: turnsForNode(db, nodeId),
      softTurnTarget: policy.softTurnTarget,
      hardTurnCap: policy.hardTurnCap,
      explorationSignal: trajectory.explorationSignal,
      progressSignal: trajectory.progressSignal,
      repeatedFailureSignal: trajectory.repeatedFailureSignal,
    });
    ledger.recordTrajectory(nodeId, {
      exploration: trajectory.explorationSignal,
      progress: trajectory.progressSignal,
    });
    if (guard.state !== 'GREEN') {
      insertMemoryRow(db, 'spend_guard', guard.state, { ...guard, nodeId }, nodeId);
    }
    // Recorded on the task, not just in the transcript: "this run was stopped,
    // and this is what stopped it" is the one fact a cost comparison cannot be
    // read without — a cheap arm full of stopped tasks is not a cheaper arm.
    if (guard.state === 'STOP' && guard.reason) ledger.recordStop(nodeId, guard.reason);
    return guard;
  } catch (err) {
    console.error(`Failed to evaluate the spend guard for node ${nodeId}:`, err);
    return { state: 'GREEN', spentUsd: 0, spendCapUsd: 0, reason: null, hard: false };
  }
}

/** Runs a sandbox when a slot is free, and says so while it waits. A node
 *  sitting in a queue looks identical to one that has hung unless it tells you.
 *
 *  `priority` orders the queue, never the ceiling: planning blocks the creation
 *  of every child and synthesis is the last thing between a person and their
 *  answer, while a work dispatch blocks only itself and may run sixty turns. */
async function dispatch<T>(db: Db, nodeId: string, task: () => Promise<T>, priority = 0): Promise<T> {
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
    return await sandboxes.run(() => {
      startedAt = Date.now();
      // Checked here, after the slot is granted rather than before it is asked
      // for: a queued dispatch can wait minutes, and the node it belongs to can
      // be cancelled in that time. `deleteNodeJobs` cannot help — there is no
      // Job to delete yet — so without this the limiter hands a freed slot to a
      // dead node and opens a sandbox nobody is waiting for. One measured run
      // spent 9 of its 26 percentage points of the five-hour window exactly
      // this way, on a child that started two seconds *after* being cancelled
      // and ran 42 turns past the answer the user had already been given.
      const node = getNode(db, nodeId);
      const state = node?.state;
      if (state !== undefined && TERMINAL_STATES.has(state)) {
        throw new Error(`Agent ${nodeId} was ${state.toLowerCase()} while waiting for a sandbox, so no sandbox was opened for it.`);
      }
      // The same moment, for the same reason: it is the last point before money
      // is spent, and every role's sandbox passes through it. Until now
      // `budget_usd` bounded what the organization would agree to *start* — the
      // escalation floor in decide-execution.ts, the pressure threshold in
      // model-router.ts — and nothing re-checked it once work was under way, so
      // a task could run arbitrarily far past its own authority.
      //
      // It is also the only place that sees *everything* a task has spent so
      // far, which is what makes it the right place for the guard rather than
      // one more caller of it.
      const guard = evaluateTaskSpend(db, nodeId, node);
      // A hard STOP (money or turns genuinely exhausted) is unconditional —
      // there is nothing left for a recovery attempt to spend either. A stall
      // STOP describes a run that is stuck, not out of resources, and if the
      // economic boundary already looked at this exact stuck state this turn
      // and judged a pivot worth the cost — tombstoning the failed strategy,
      // see `carryOutRecovery` — then stopping here would discard the very
      // recovery attempt it was just priced and authorized for. One pass only:
      // `consumeRecoveryFlag` clears itself, so a pivot buys the next attempt
      // one turn, not blanket immunity from the guard.
      if (guard.state === 'STOP' && !(!guard.hard && consumeRecoveryFlag(nodeId))) {
        const message = `${guard.reason} No further sandbox was opened for this agent.`;
        // Said out loud as well as thrown: the throw reaches VERIFY as a failed
        // result, which is the machine's business, while a person watching the
        // transcript needs to see that the run stopped on money rather than on
        // an error.
        publishProgress(db, nodeId, message);
        throw new Error(message);
      }
      if (guard.state === 'STOP') {
        publishProgress(db, nodeId, `${guard.reason} Continuing on the pivot just decided rather than stopping.`);
      }
      if (guard.state === 'RED') {
        publishProgress(db, nodeId, `Running hot: ${guard.reason}`);
      }
      return task();
    }, priority);
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

  // Asked before a sandbox is opened, not after: planning's only possible
  // product is a split, so on a goal with no seam it buys a dispatch to be told
  // what the classification already knows.
  const verdict = judgeTask(goal);
  if (!verdict.worthPlanning) {
    publishProgress(db, nodeId, `${verdict.reason} — doing it directly`);
    return [];
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
    }), CRITICAL_PATH);

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
      startupMs: result.startupMs,
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

/** One dispatch, as a unit of account for the delegate-vs-self comparison.
 *
 *  Not a forecast, and deliberately not presented as one. The two candidates
 *  are multiples of this number, so what the comparison needs is for it to be
 *  the *same* for both and proportional to what this node may actually spend —
 *  not for it to predict a bill nothing has yet produced. The node has not
 *  dispatched anything at this point, so there is no measurement to use.
 *
 *  Derived by dividing the task's own token budget by the widest plan it could
 *  fund (k children plus the planning and synthesis runs). A node that can
 *  afford four children therefore prices one dispatch at a sixth of its budget,
 *  which is what it would actually get if it used all of them.
 *
 *  Total: a unit that cannot be derived falls back to zero, and two candidates
 *  both costing nothing rank on their non-token terms rather than failing. */
function unitDispatchFor(db: Db, nodeId: string, goal: string, maxChildren: number) {
  try {
    const budget = economicStateFor(db, { nodeId, goal }).resources.totalTokenBudget;
    const dispatches = Math.max(1, Math.floor(maxChildren)) + 2;
    const tokens = Math.max(0, Math.round(budget / dispatches));
    return {
      tokens,
      // The measured startup-to-answer time of a dispatch in this repository's
      // recorded runs, rounded. Latency is a tie-break term here rather than a
      // headline, so a stand-in is honest as long as it is named as one.
      latencyMs: ASSUMED_DISPATCH_LATENCY_MS,
      costUsd: 0,
    };
  } catch (err) {
    console.error(`Could not price a dispatch for node ${nodeId}:`, err);
    return { tokens: 0, latencyMs: ASSUMED_DISPATCH_LATENCY_MS, costUsd: 0 };
  }
}

/** ponytail: a constant standing in for a measurement. Replace with the median
 *  wall clock of this role's recorded dispatches once the ledger is queried for
 *  it; the delegate-vs-self comparison is the only caller, and latency is its
 *  weakest term. */
const ASSUMED_DISPATCH_LATENCY_MS = 120_000;

function productionMachine(db: Db, nodeId: string) {
  return nodeMachine.provide({
    actors: {
      assessUncertainty: fromPromise(async ({ input }: { input: { goal: string } }) => assessUncertainty(input)),
      decideExecution: fromPromise(async ({ input }: { input: { goal: string; complexity: NodeMachineContext['complexity']; worthSplitting?: boolean; signals?: Record<string, number> } }) => {
        const node = getNode(db, nodeId);
        if (!node) throw new Error(`Node ${nodeId} not found when deciding execution`);
        const economics = decideExecution({
          goal: input.goal,
          authority: node.contract.authority,
          complexity: input.complexity ?? 'low',
          worthSplitting: input.worthSplitting,
          signals: input.signals,
        });
        // Delegation is the most expensive action the runtime has and was the
        // last one still authorized outside the Action Market. It now passes
        // through the same ranking as everything else — so a fan-out cannot be
        // started on a run the economic state already knows is out of budget,
        // under a hard stop, or holding a recovery reserve it would consume.
        //
        // Full mode only, deliberately. The baseline arm of a comparison must
        // keep the behaviour it was measured with, or the A/B is measuring the
        // harness. `authorizeExecution` honours `decideExecution`'s verdict
        // either way; what the market adds is the veto.
        const authorized = authorizeExecution({
          state: economicStateFor(db, { nodeId, goal: input.goal }),
          economics,
          plannedChildCount: node.contract.authority.max_child_count,
          // A unit of account, not a forecast. Both candidates are multiples of
          // it, so the comparison depends on it being the *same* for both
          // rather than on it being right — and dividing the task's own budget
          // by the widest plan it could fund keeps it proportional to what this
          // node may actually spend.
          dispatch: unitDispatchFor(db, nodeId, input.goal, node.contract.authority.max_child_count),
        });
        const result = runtimeMode() === 'full'
          ? { ...economics, outcome: authorized.outcome }
          : economics;

        // The named strategy for this dispatch, from the same snapshot and the
        // same economics. Recorded rather than authoritative: the outcome above
        // is still what routes the machine, and this names *which* of the three
        // strategies that outcome is so learning can measure the real thing
        // instead of a `delegated` boolean. Serial and parallel delegation are
        // different strategies with different costs and different failure
        // modes, and a boolean cannot tell them apart.
        // Wrapped, and the wrapping is the point: everything from here to the
        // memory row is *optimizer*, and an optimizer that can fail a task by
        // failing to optimize is worse than no optimizer. A throw here leaves
        // the decision above exactly as it was.
        try {
          const strategyPreparation = prepareDispatch({
            goal: input.goal,
            authority: node.contract.authority,
            toolGrant: grantOf(node.contract.authority),
            ...(node.repoPath ? { repository: node.repoPath } : {}),
            requiredChecks: node.contract.definition_of_done ?? [],
          });
          const strategy = decideStrategy({
            preparation: strategyPreparation,
            // What history says, shrunk toward broader evidence. Carried rather
            // than obeyed: the economics still decide, and a prior built on two
            // runs of this exact shape must not outvote thirty of the class.
            prior: strategyPriorFor(db, {
              preparation: strategyPreparation, policyVersion: policyVersion(),
            }),
            spentUsd: getCostForNodes(db, [nodeId]),
            dispatch: unitDispatchFor(db, nodeId, input.goal, node.contract.authority.max_child_count),
            plannedChildCount: node.contract.authority.max_child_count,
          });
          insertMemoryRow(db, 'strategy_decision', strategy.strategy, {
            strategy: strategy.strategy,
            evidence: strategy.evidence,
            outcome: result.outcome,
            // What this decision *predicted*, so the terminal transition can put
            // the measurement beside it. Absent for a hard gate, which is the
            // signal that there is no counterfactual to record.
            ...(strategy.receipt.gate ? {} : {
              predicted: {
                costUsd: strategy.receipt.estimate.costUsd,
                latencyMs: strategy.receipt.estimate.latencyMs,
                successProbability: strategy.evidence.historicalPrior?.expectedSuccess ?? strategy.receipt.confidence,
              },
            }),
          }, nodeId);
        } catch (err) {
          console.error(`Failed to name the execution strategy for node ${nodeId}:`, err);
        }


        const decidedAt = new Date().toISOString();
        insertDecision(db, {
          id: randomUUID(), nodeId, type: 'execution_decision',
          outcome: result.outcome, breakdown: {
            ...result.breakdown,
            // What the market did with it, in the durable record rather than
            // only in a log line: a benchmark attributing a delegation
            // regression needs to see whether the market vetoed, a gate fired,
            // or the economics simply declined.
            ...(runtimeMode() === 'full' ? {
              market_authorized: authorized.outcome === 'DELEGATE' ? 1 : 0,
              market_vetoed: economics.outcome === 'DELEGATE' && authorized.outcome !== 'DELEGATE' ? 1 : 0,
              market_utility: authorized.decision?.utility ?? 0,
            } : {}),
          },
          createdAt: decidedAt,
        });
        if (authorized.gate) {
          insertMemoryRow(db, 'execution_gate', authorized.gate, { outcome: authorized.outcome }, nodeId);
        }
        if (runtimeMode() === 'full' && economics.outcome === 'DELEGATE' && authorized.outcome !== 'DELEGATE') {
          publishProgress(db, nodeId, 'Splitting this would cost more than doing it directly — doing it directly');
        }
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
      validate: fromPromise(async ({ input }: { input: { nodeId: string; goal: string; succeeded: boolean } }) =>
        runValidation(db, input.nodeId, input.succeeded)),
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
            // So the plan is checked against what this node may actually
            // authorize, before a single child node exists.
            ...(node ? { authority: node.contract.authority } : {}),
          }, realDelegateDeps(db, nodeId));

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

        // Asked before anything is built and before anything is said about
        // starting a sandbox, because on a hit none of that happens. The model
        // is resolved first only because it is part of what makes two runs the
        // same run — a haiku answer must not be served to a sonnet request.
        // `judgeTask` is the cheap, dispatch-free classification the template,
        // the utility record and the grant below all key on — computed once,
        // up front, so nothing here can disagree about what kind of goal this is.
        // One snapshot, built here at the safe execution boundary, and read
        // everywhere below. Before this, the goal was judged here, judged again
        // inside `executionPolicyForGoal`, and judged a third time inside the
        // context selector — three derivations that could disagree about what
        // kind of task this is.
        const prep: DispatchPreparation = prepareDispatch({
          goal: input.goal,
          authority: node!.contract.authority,
          toolGrant: grantOf(node!.contract.authority),
          ...(node?.repoPath ? { repository: node.repoPath } : {}),
          requiredChecks: node?.contract.definition_of_done ?? [],
        });
        const verdict = prep.verdict;
        // Investigating is reading, not editing — and an unrestricted grant
        // does not just permit editing, it also keeps the Task tool, which is
        // how a single dispatch spawns its own background subagents. Narrowed
        // to read-only only when nobody configured a grant of their own; see
        // dispatch-helpers.ts for the measured run this closes off.
        const grant = investigativeExecuteGrant(grantOf(node!.contract.authority), verdict.decomposition.investigative);
        let usedModel = modelFor(adapter, modelChoiceFor(db, nodeId, 'execute', input.goal));
        const reuseKey = resultReuseKey(input.goal, grant, usedModel);
        // Validity is asked of each candidate answer in turn, newest first:
        // does the code it actually read still say what it said?
        const cached = reuseKey
          ? getCachedResult(db, reuseKey, resultCacheTtlHours(),
              (value) => dependenciesValid(worktreePath, value.deps))
          : null;

        // Routed through the one decision contract rather than decided inline,
        // so reusing and running fresh are explained the same way and by the
        // same rules — the budget gate included.
        const pathDecision = decideExecutionPath({
          goal: input.goal,
          authority: node!.contract.authority,
          spentUsd: getCostForNodes(db, [nodeId]),
          complexity: verdict.decomposition.complexity,
          worthSplitting: verdict.decomposition.worthSplitting,
          signals: verdict.decomposition.signals,
          reusable: cached ? { tokens: cached.tokens, costUsd: cached.costUsd } : undefined,
          // Priced from what this exact run cost the last time it was paid for.
          // With no such measurement the estimate is honestly zero rather than
          // an invented one — and the only branch that reads it is the one that
          // has a measurement.
          dispatch: { tokens: cached?.tokens ?? 0, latencyMs: 0, costUsd: cached?.costUsd ?? 0 },
        });
        publishDecisionReceipt(db, nodeId, pathDecision);
        // The shape this kind of task usually takes, and the steps the runtime
        // already holds the product of. Published rather than prompted: a step
        // list in the argv would cost tokens on every dispatch to tell the agent
        // something the runtime is deciding for it.
        publishExecutionPlan(db, nodeId, verdict.taskClass, indexedKnowledge(db, nodeId));

        if (cached && pathDecision.chosen === 'REUSE_COMPUTATION') {
          publishProgress(db, nodeId, 'This exact question was already answered against this commit — reusing that answer instead of running again');
          // The reused run left no transcript here, so the answer has to be
          // published as one: `answerOf` reads `node.answer` before it looks
          // for a report, and without this the node would finish having said
          // nothing.
          publishAnswer(db, nodeId, cached.text);
          // The reused answer is a durable outcome of *this* node, and has to
          // be recorded as one: validation reads artifacts, and a run that
          // produced nothing on disk because it produced nothing at all and a
          // run that skipped the work because the answer was already in hand
          // must not look identical to it.
          insertArtifact(db, {
            id: randomUUID(), nodeId, eventId: null, createdAt: new Date().toISOString(),
            kind: 'result', path: null, summary: `reused a prior answer to this exact question ($0.0000)`,
          });
          // Counted as work avoided, not work done.
          recordUsage(db, {
            nodeId, role: 'execute:cache-hit', model: usedModel ?? null,
            usage: { ...ZERO_USAGE }, costUsd: 0, tokensAvoided: cached.tokens,
          });
          const result = { succeeded: true, message: cached.text, events: [], usage: { ...ZERO_USAGE } };
          publishStepOutcome(db, nodeId, result);
          scoreProjection(db, {
            nodeId, taskClass: verdict.taskClass, read: [], outcome: 'success',
            tokensAvoided: cached.tokens, executionAvoided: true,
          });
          return result;
        }

        publishProgress(db, nodeId, `Starting a sandbox on ${adapter.name} against ${worktreePath}`);
        const execOpts = dispatchOptionsFor('execute');
        // What this particular task was judged to need, rather than what every
        // task gets. The configured cap is a deployment-wide circuit breaker
        // and stays the outer bound — an operator who sets one means it, and
        // `undefined` is the documented "uncapped", which this must not
        // quietly re-impose a cap on top of.
        // The snapshot's policy, recalibrated by whatever the learning loop has
        // promoted. `calibrate` is the only step that cannot live in the
        // snapshot, because a promotion can land between snapshot and dispatch.
        const execPolicy = calibrate(prep.executionPolicy, activePolicyChanges(db));
        const hardTurnCap = effectiveTurnCap(execOpts.maxTurns, execPolicy);
        // Built once, out here rather than inside runOnce: the fallback retry
        // below calls runOnce a second time with the same goal, and a goal
        // carrying two copies of the context is the thing this is meant to
        // avoid. No context (disabled, not a repo, scan failed) → the bare goal.
        const repoContext = dispatchContextFor(db, worktreePath, input.goal, {
          signals: prep.economics, policy: prep.contextPolicy,
        });
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
              allowedTools: grant.allowedTools,
              constraints,
              definitionOfDone: node?.contract.definition_of_done ?? [],
              // The same cap that goes into argv below. A run told its budget
              // summarises at the limit; one that is merely cut off at it
              // reports "max turns exceeded" and loses what it found.
              maxTurns: hardTurnCap,
              // Advice rather than a wall: the cap stops a run, this is what
              // stops it wandering. Only worth saying when it is actually
              // below the cap — "about 45 turns, at most 45 turns" is noise.
              softTurnTarget: hardTurnCap !== undefined && execPolicy.softTurnTarget < hardTurnCap
                ? execPolicy.softTurnTarget
                : undefined,
            })
          : undefined;
        const goalWithConstraints = (!roleSystemPrompt && constraints.length > 0)
          ? `Standing instructions (follow even where they conflict with the most direct path, and say so if one blocks you):\n${constraints.map((c) => `  - ${c}`).join('\n')}\n\n${input.goal}`
          : input.goal;
        // The context goes on last, so it wraps the whole instruction block
        // instead of landing between the standing instructions and the goal they
        // govern — a file listing separating an instruction from its task is a
        // worse prompt than either change intended on its own.
        // What the parent addressed to this child, if anything. Rendered into
        // the argv rather than into the node's goal, because the goal is what a
        // person reads in the tree — an envelope folded into it would turn a
        // sentence into a paragraph of machine instructions wearing the goal's
        // name.
        const envelope = getAgentEnvelope(db, nodeId);
        const envelopeText = envelope ? renderEnvelope(envelope) : '';
        const goalWithHandoff = envelopeText
          ? `${envelopeText}\n\n${goalWithConstraints}`
          : goalWithConstraints;
        // The economic boundary. Asked once, here, at the point the dispatch is
        // assembled — and answering "nothing to do" leaves `goalForDispatch`
        // byte-identical to what it would have been, which is what makes
        // CONTINUE a true no-op rather than a no-op with a comment.
        const acquired = await economicBoundary(db, {
          nodeId, goal: input.goal, worktreePath,
          fullArtifactRequests: repoContext?.receipt.fullArtifactRequests,
        });
        const goalWithEvidence = acquired ? `${goalWithHandoff}\n\n${acquired}` : goalWithHandoff;
        const goalForDispatch = repoContext
          ? withRepoContext(goalWithEvidence, repoContext.content)
          : goalWithEvidence;

        // Reset per attempt: the fallback retry below re-runs the dispatch, and
        // its stream is the one whose rows the observations belong to.
        let eventIds: number[] = [];
        const runOnce = (model: string | undefined) => {
          eventIds = [];
          return dispatch(db, nodeId, () => executeStep({
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
          grant,
          model,
          maxTurns: hardTurnCap,
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
            // Recorded in arrival order, which is the order `result.events`
            // comes back in — so an observation can point at the row that
            // already holds its output instead of the context store keeping a
            // second copy of it.
            eventIds.push(id);
            // Artifacts are derived from the same stream, at the same moment —
            // no second capture pass over the event log afterwards.
            for (const artifact of artifactsFromEvent(event)) {
              insertArtifact(db, { id: randomUUID(), nodeId, eventId: id, createdAt: now, ...artifact });
            }
          },
        }));
        };

        // One shot at the tiered model — and only a model this runtime can
        // actually serve. If the runtime then says it cannot have it, the run
        // continues on the default rather than failing over a knob.
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
          startupMs: result.startupMs,
        });
        publishStepOutcome(db, nodeId, result);

        // The run's own account of what it touched, indexed into the context
        // graph. Built from what actually ran rather than from a scan of what
        // might matter, and pointing at the event rows that already hold the
        // output rather than copying it.
        const indexed = indexRunObservations(db, { nodeId, events: result.events, eventIds, grant });
        // What the projection predicted, against what the run actually read.
        // Free, because the run already told us both.
        scoreProjection(db, {
          nodeId,
          taskClass: verdict.taskClass,
          receipt: repoContext?.receipt,
          read: indexed.read,
          outcome: result.succeeded ? 'success' : 'failure',
        });

        // Stored only on success. The fingerprint is built from the run's own
        // stream — the files it actually read — against the commit it was given,
        // not the tree as it now stands: a read-only run should not have moved
        // the tree, and if something else did, what the answer describes is
        // still the commit it saw. Guarded for the same reason `recordUsage` is:
        // an answer that was produced and paid for must not be thrown away
        // because writing it down failed. The retry above can change which model
        // ran, so the key is recomputed against the one that did.
        const storeKey = usedModel === undefined ? resultReuseKey(input.goal, grant, undefined) : reuseKey;
        if (storeKey && result.succeeded) {
          const text = finalResultText(result.events);
          if (text) {
            try {
              const observed = dependenciesFromEvents(result.events);
              const head = repoHead(worktreePath);
              const deps = head && !repoDirty(worktreePath)
                ? buildDependencyFingerprint(worktreePath, observed.paths, observed.opaque, head)
                : null;
              // No fingerprint, no reuse. An answer we cannot say the validity
              // of is not one we may serve again.
              if (deps) {
                putCachedResult(db, storeKey, {
                  text,
                  tokens: result.usage.inputTokens + result.usage.outputTokens,
                  costUsd: costFromEvents(result.events),
                  deps,
                }, new Date().toISOString());
              }
            } catch (err) {
              console.error(`Failed to cache the result for node ${nodeId}:`, err);
            }
          }
        }
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

/** One run, remembered as strategy evidence.
 *
 *  Keyed at every level it is evidence for — global, task class, task shape,
 *  repository, exact pattern — so a later decision can ask the narrowest
 *  question that still has enough evidence behind it, instead of averaging a
 *  typo fix and a cross-module bug hunt because they shared a complexity band.
 *
 *  Only *validated* outcomes count as successes. A run that finished without
 *  proving anything is evidence about the run, not about the strategy, and
 *  recording it as a strategy success is the same laundering the validation
 *  ladder exists to refuse — one layer further out. */
function recordStrategyLearning(db: Db, nodeId: string, completed: boolean, now: string): void {
  try {
    const node = getNode(db, nodeId);
    if (!node?.runtime) return;
    const goal = node.contract.goal ?? '';
    const prep = prepareDispatch({
      goal, authority: node.contract.authority,
      toolGrant: grantOf(node.contract.authority),
      ...(node.repoPath ? { repository: node.repoPath } : {}),
    });
    const verdicts = listEventsForNode(db, nodeId).filter((row) => row.type === 'validation.result');
    const last = verdicts.at(-1)?.payload as { passed?: boolean; level?: string } | undefined;
    const delegated = listNodes(db).some((child) => child.parentId === nodeId);

    const costUsd = getCostForNodes(db, [nodeId]);
    const latencyMs = Date.parse(now) - Date.parse(node.createdAt);
    const validated = completed && last?.passed === true;

    // What the decision predicted, beside what it cost. Recorded only for a
    // decision a *score* made: a hard gate predicted nothing, and a prediction
    // error for it would manufacture evidence that arithmetic went wrong when
    // none ran. The actual side is telemetry, never the estimate that produced
    // the prediction — comparing an estimate to itself always reports perfect
    // accuracy.
    const decided = listMemory(db, 'strategy_decision').filter((row) => row.nodeId === nodeId).at(-1);
    const decision = decided?.value as { strategy?: string; predicted?: Record<string, number> } | undefined;
    if (decision?.strategy) {
      const observation = buildCounterfactualObservation({
        chosen: decision.strategy as ExecutionStrategy,
        alternative: decision.strategy === 'MANAGED' ? 'SERIAL_DELEGATED' : 'MANAGED',
        predictedCostUsd: decision.predicted?.costUsd ?? 0,
        predictedLatencyMs: decision.predicted?.latencyMs ?? 0,
        predictedSuccessProbability: decision.predicted?.successProbability ?? 0.5,
        actualCostUsd: costUsd,
        actualLatencyMs: latencyMs,
        actualSucceeded: validated,
        validationLevel: (last?.level as 'V0' | 'V1' | 'V2' | 'V3') ?? 'V0',
        recoveryCount: Math.max(0, verdicts.length - 1),
        scored: decision.predicted !== undefined,
      });
      if (observation) insertMemoryRow(db, 'strategy_counterfactual', decision.strategy, observation, nodeId);
    }

    recordStrategyOutcome(db, {
      id: randomUUID(), nodeId, createdAt: now,
      observation: observationFrom({
        strategy: delegated ? 'SERIAL_DELEGATED' : 'MANAGED',
        taskClass: prep.taskClass,
        taskShape: prep.taskShape,
        ...(node.repoPath ? { repository: node.repoPath } : {}),
        ...(node.repoPath ? { exactPattern: `${node.repoPath}@${prep.taskShape}` } : {}),
        validated,
        // Quality against the run's own contract rather than against a baseline
        // this process cannot see. A paired benchmark supplies the real delta;
        // this is the honest zero until it does.
        qualityDelta: 0,
        costUsd,
        latencyMs,
        // Each extra verdict is an attempt that had to be recovered from.
        recoveryCount: Math.max(0, verdicts.length - 1),
        validationLevel: (last?.level as 'V0' | 'V1' | 'V2' | 'V3') ?? 'V0',
        policyVersion: policyVersion(),
      }),
    });
  } catch (err) {
    // Learning must never cost a run. A missing observation is a smaller
    // problem than a node that could not finish because recording one failed.
    console.error(`Failed to record strategy learning for node ${nodeId}:`, err);
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
/** What the runtime already knows about how well a finished run went.
 *
 *  Every field is read off something that already happened — the artifacts
 *  table, the run's own tool stream, the definition of done. No new telemetry,
 *  which is what makes validation at V0-V2 cost nothing. */
function validationEvidenceFor(db: Db, nodeId: string, succeeded: boolean): ValidationEvidence {
  const all = listArtifactsForNode(db, nodeId);
  const artifacts = all.filter((a) => a.kind !== 'result');
  // An investigation's deliverable *is* its report: there is no file to point
  // at, and treating "a file changed" as the only durable outcome made every
  // read-only task permanently unverifiable — a task family whose floor can
  // never be cleared is a task family whose floor stops meaning anything.
  //
  // Read-only only, deliberately. For work that was supposed to change
  // something, "the agent wrote a summary" is the claim, not evidence for it,
  // and accepting it there is the empty-patch success this whole ladder exists
  // to refuse.
  const readOnly = taskEconomicsFor(getNode(db, nodeId)?.contract.goal ?? '').readOnly;
  const durableOutcomeIds = readOnly ? all.filter((a) => a.kind === 'result').map((a) => a.id) : [];
  const snapshot = executionSnapshot({
    events: listEventsForNode(db, nodeId)
      .filter((row) => row.type.startsWith('exec.'))
      .map((row) => ({ type: row.type.slice('exec.'.length), payload: row.payload } as StructuredEvent)),
    sequence: 0,
    tokensConsumed: 0,
  });
  // A verifying command that ran green is the strongest evidence the trace can
  // offer, and the fingerprint already separated those out as active targets.
  const failures = new Set(snapshot.failureSignatures);
  const observedChecks = snapshot.activeTargets
    .filter((target) => VERIFYING_COMMAND.test(target))
    .map((target) => ({
      id: `observed:${target}`,
      command: target,
      passed: ![...failures].some((signature) => signature.includes(target)),
    }));

  return {
    claimedSuccess: succeeded,
    artifactIds: artifacts.map((a) => a.id),
    durableOutcomeIds,
    observedChecks,
    requiredChecks: listDodForNode(db, nodeId).map((item) => ({
      id: item.id, text: item.text, met: item.state === 'met',
    })),
  };
}

/** The same shapes `efficiency/progress-signals.ts` treats as proof. Duplicated
 *  deliberately narrow rather than exported: what counts as *a verifying
 *  command* and what counts as *an active target that is one* are the same
 *  question, and if they ever diverge this is the line that should have to
 *  change. */
const VERIFYING_COMMAND = /\b(?:test|tests|vitest|jest|pytest|build|tsc|typecheck|lint|eslint|check|cargo|go\s+test|make)\b/i;

function recordEfficiency(db: Db, nodeId: string, outcome: EfficiencyOutcome): void {
  // Said explicitly rather than left to a timeout: the control plane keeps a
  // little working memory per node, and a daemon that runs for weeks must not
  // accumulate one entry for every node it has ever seen.
  forgetNode(nodeId);
  try {
    // `EXECUTION_FINISHED` is a fact about a process; `TASK_SUCCESS` is a claim
    // about the world. The primary KPI is tokens per *successful* task, so a
    // success count that includes runs which did not work scores an optimizer
    // that makes runs cheaper and wronger as an improvement. This is the gate.
    //
    // Downgraded to `partial`, never to `failure`: the run did finish and did
    // produce something, and calling that a failure would be as dishonest in
    // the other direction.
    const validated = outcome !== 'success'
      ? outcome
      : recordValidation(db, nodeId) ? 'success' : 'partial';
    const record = ledger.finishTask(nodeId, validated);
    insertMemoryRow(db, 'efficiency_record', nodeId, record, nodeId);
  } catch (err) {
    console.error(`Failed to record the efficiency of node ${nodeId}:`, err);
  }
}

/** Whether this run may be counted as a successful task, and the receipt for
 *  the answer either way.
 *
 *  No fresh verifier is passed: re-running a repository's test suite from
 *  inside the daemon is a capability this runtime does not have, so the ladder
 *  stops at V2 — a green check in the run's own trace. Recorded as
 *  `V3:no_verifier` rather than silently, so the ceiling is visible in the
 *  telemetry rather than inferred from its absence. */
function runValidation(db: Db, nodeId: string, succeeded: boolean): ValidationVerdict {
  const node = getNode(db, nodeId);
  const goal = node?.contract.goal ?? '';
  // Closed *here*, not at the terminal transition, and the ordering is
  // load-bearing: validation reads the definition of done, so a definition
  // still sitting at `unverified` makes every named check look unmet and every
  // run fail. Reversed, it launders "the process exited 0" into "the work was
  // done". Neither is acceptable, so the checklist is ruled against what the
  // run actually produced, immediately before the evidence is read.
  closeDefinitionOfDone(db, nodeId, succeeded ? 'COMPLETE' : 'FAILED', new Date().toISOString());

  // What this particular task needs proving, and to what level. The profile
  // may raise the floor — delegated work, a wide change, a task already on its
  // second attempt — and human-named checks raise it independently.
  const delegated = listNodes(db).some((child) => child.parentId === nodeId);
  const profile = validationProfileFor({
    strategy: delegated ? 'SERIAL_DELEGATED' : 'MANAGED',
    economics: taskEconomicsFor(goal),
    requiredChecks: node?.contract.definition_of_done ?? [],
    // No fresh verifier: re-running a repository's suite from inside the daemon
    // is a capability this runtime does not have. Recorded as `V3:no_verifier`
    // rather than silently, so the ceiling is visible in the telemetry rather
    // than inferred from its absence.
    freshVerifierAvailable: false,
  });

  const result = validate({
    evidence: validationEvidenceFor(db, nodeId, succeeded),
    contract: contractForProfile(profile),
  });

  // The level floor and the confidence floor can disagree, and when they do the
  // level wins: a task that demanded an observed check and got an artifact has
  // not been verified, however confident the arithmetic became.
  const levelOk = meetsMinimumLevel(profile, result.level);
  const gated: ValidationResult = levelOk ? result : {
    ...result, passed: false,
    reasonCodes: [...result.reasonCodes, `below_minimum_level:${profile.minimumLevel}`],
  };

  const now = new Date().toISOString();
  const payload = {
    level: gated.level, passed: gated.passed, confidence: gated.confidence,
    tokens: gated.tokens, latencyMs: gated.latencyMs,
    evidenceIds: gated.evidenceIds, reasonCodes: gated.reasonCodes,
    minimumLevel: profile.minimumLevel, riskReasons: profile.riskReasons,
  };
  const id = appendEvent(db, { nodeId, type: 'validation.result', payload, createdAt: now });
  publish({ id, nodeId, type: 'validation.result', payload, createdAt: now });

  // The strategy identity of this attempt, so the lifecycle can tell a recovery
  // from a repeat. Without it the attempt cap bounds how many identical retries
  // happen and nothing stops the first one being pointless.
  const signals = trajectorySignals(db, nodeId);
  return {
    ...gated,
    strategy: delegated ? 'SERIAL_DELEGATED' : 'MANAGED',
    // What failed, in the stable form the trajectory fingerprint uses, so two
    // attempts that died the same way are recognisable as such.
    failureSignature: gated.passed
      ? 'none'
      : `validation:${gated.level}:${gated.reasonCodes.filter((code) => !code.startsWith('V')).join('|') || 'insufficient_evidence'}`,
    progress: signals.progressSignal,
  };
}

/** The stored verdict for this node, or a fresh one if the machine never
 *  reached VALIDATE (a cancelled or crashed run).
 *
 *  Total: unreadable evidence must not manufacture a success. It also must not
 *  manufacture a failure of the *run* — the caller downgrades to partial, which
 *  is the honest reading of "it finished and we cannot say whether it worked". */
function recordValidation(db: Db, nodeId: string): boolean {
  try {
    const stored = listEventsForNode(db, nodeId)
      .filter((row) => row.type === 'validation.result')
      .at(-1);
    if (stored) return (stored.payload as { passed?: boolean }).passed === true;
    return runValidation(db, nodeId, true).passed;
  } catch (err) {
    console.error(`Failed to validate node ${nodeId}:`, err);
    return false;
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
      recordStrategyLearning(db, nodeId, snapshot.value === 'COMPLETE', now);
      // One efficiency record per task, at the one point that knows the verdict.
      // CANCELLED is 'partial', not a failure: the work stopped because someone
      // stopped it, and counting that against the success rate would make every
      // change look worse the more often people intervened.
      // Order matters, and getting it wrong is invisible until a benchmark
      // reports a success rate of zero: `recordEfficiency` validates the run
      // against its definition of done, so the definition of done has to be
      // *closed* first. Reversed, validation reads every item as `unverified`,
      // every run is downgraded to `partial`, and the primary metric — tokens
      // per *successful* task — can never be computed at all.
      closeDefinitionOfDone(db, nodeId, String(snapshot.value), now);
      recordEfficiency(db, nodeId, snapshot.value === 'COMPLETE' ? 'success'
        : snapshot.value === 'CANCELLED' ? 'partial' : 'failure');
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
  db: Db,
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
  // COMPLETE is the only terminal state that means the goal was *attempted to
  // completion* — FAILED and CANCELLED are both terminal too, and neither is a
  // success. But COMPLETE alone is EXECUTION_FINISHED, not TASK_SUCCESS: the
  // subscriber that ran validation and appended `validation.result` was
  // registered when this actor started, before this call's own `waitFor`
  // subscription, so it has already run by the time `snapshot.status` reads
  // 'done' here. A caller that trusted the bare state machine value would
  // treat an unverified completion the same as a confirmed one — exactly the
  // confusion `validation/engine.ts` exists to prevent everywhere else.
  // ponytail: reads the last validation.result event rather than threading the
  // validate() result through the state machine itself; revisit if a second
  // caller needs more than pass/fail.
  if (snapshot.value !== 'COMPLETE') return { succeeded: false };
  const lastValidation = listEventsForNode(db, nodeId)
    .filter((e) => e.type === 'validation.result')
    .sort((a, b) => b.id - a.id)[0];
  // Absent means validation did not run or could not be read — the same
  // "must not manufacture a success" rule recordValidation itself applies.
  const passed = (lastValidation?.payload as { passed?: boolean } | undefined)?.passed === true;
  return { succeeded: passed };
}

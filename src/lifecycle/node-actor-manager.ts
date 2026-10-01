import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createActor, fromPromise, waitFor, type Actor } from 'xstate';
import { nodeMachine, type NodeMachineEvent, type ValidationVerdict } from './node-machine.js';
import type { Db } from '../db/client.js';
import { updateNodeState, getNode, insertNode, listNodes, setNodeRuntime, markNodeSuperseded } from '../db/queries/nodes.js';
import { appendEvent, listEventsForNode } from '../db/queries/events.js';
import { publish } from '../events/bus.js';
import { executeStep } from '../execution/execute-step.js';
import { ZERO_USAGE, type DispatchUsage } from '../execution/tokens.js';
import { claudeCodeAdapter } from '../adapters/claude-code.js';
import { stopgapAdapter } from '../adapters/stopgap.js';
import { assessUncertainty } from '../intelligence/coordinator.js';
import { decideExecution, MIN_AGENT_BUDGET_USD } from '../engines/decide-execution.js';
import { insertDecision, listDecisionsForNode } from '../db/queries/decisions.js';
import { escalate } from '../approvals/escalation.js';
import { insertApproval, getPendingApproval, resolveApproval } from '../db/queries/approvals.js';
import type { NodeMachineContext } from './node-machine.js';
import { delegateToChildren, childAuthority, needsResume, type DelegateChildDeps, type DelegationLedger, type RecoveryContext, type RecoveryDecision } from './delegate-child.js';
import { decideAssignmentRecovery } from './assignment-market.js';
import { normalizeEconomicState } from '../decision/state.js';
import { saveDelegationPlan, loadDelegationPlan } from '../db/queries/delegation-plans.js';
import type { ExecuteStepResult } from '../execution/execute-step.js';
import { getDelegation, listDelegationsForParent, listDelegationsForChild } from '../db/queries/delegations.js';
import { openDelegation, transitionDelegation } from './delegation-events.js';
import type { WorkspaceRef } from '../schemas/delegation.js';
import type { ChildRunResult, CheckVerifier } from './delegation-review.js';
import { PROTECTED_PATHS } from './delegation-scope.js';
import { insertCommitment, updateCommitmentStatus, setCommitmentEvidence, listCommitmentsForNode } from '../db/queries/commitments.js';
import { insertArtifact, listArtifactsForNode } from '../db/queries/artifacts.js';
import { artifactsFromEvent } from '../execution/artifacts.js';
import { treeState, treeChanges } from '../execution/tree-changes.js';
import { codexAdapter } from '../adapters/codex.js';
import { buildPlanPrompt, parsePlan, isEvidenceableCheck, type ParsedPlan } from '../intelligence/plan.js';
import type { ChildReport } from '../intelligence/synthesize.js';
import { decideIntegration } from '../intelligence/integrate-results.js';
import { answerOf } from '../db/queries/answers.js';
import { sessionMemoryLadder } from '../db/queries/sessions.js';
import { recordRunOutcome, recordStrategyOutcome, listMemory } from '../db/queries/memory.js';
import { getCostForNodes } from '../db/queries/stats.js';
import { resolveCredentials, checkCredentials, gitIdentity, githubCredentials, grantsGitHub } from '../execution/credentials.js';
import { sandboxLimiter, maxConcurrentFromEnv, CRITICAL_PATH } from '../execution/dispatch-limit.js';
import { efficiencyLedger, type LedgerRole } from '../efficiency/ledger.js';
import type { EfficiencyOutcome } from '../efficiency/metrics.js';
import type { DispatchReceipt } from '../context/dispatch-context.js';
import { buildRolePrompt, buildRolePromptParts } from '../prompts/roles.js';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { deleteNodeNetworkPolicy, deleteNodeJobs } from '../k8s/cleanup.js';
import { subtreeNodeIds } from '../db/queries/nodes.js';
import { allowedTools, isReadOnly } from '../engines/enforce-tools.js';
import type { Authority } from '../schemas/node-contract.js';
import {
  forkWorkspace, releaseFork, integrateFork, integrateForkDetailed, rebaseForkOntoBase, isForkIntegrated,
  candidateChangedFiles, filesWithConflictMarkers, type WorkspaceFork, type IntegrationResult,
} from '../execution/workspace-fork.js';

// The mechanical merge primitive lives beside the fork it merges; re-exported so
// callers that already import it from here keep working. Whether a child's work
// may be merged at all is decided in `mergeAcceptedDelegation`, not there.
export { integrateFork };
import { toContainerPath, fromContainerPath } from '../k8s/kind.js';
import { sandboxNotes } from '../k8s/sandbox-env.js';
import type { ToolGrant, RuntimeAdapter, StructuredEvent } from '../adapters/adapter.js';
import { setNodeSnapshot, clearNodeSnapshot } from '../db/queries/nodes.js';
import { insertDodItems, listDodForNode, setDodState } from '../db/queries/dod.js';
import { executeTimeoutMs, dispatchOptionsFor, planCacheTtlHours, repoMapTokenBudget, rolePromptsEnabled, resultCacheTtlHours, type DispatchRole } from '../config/efficiency.js';
import { repoHead, repoDirty, repoIdentity } from '../execution/git-state.js';
import { openSession as openInfoControl, settleFinish } from '../infocontrol/endpoint.js';
import { autoCommitAndPush, autoCommitEnabled, hostRepoPath, isDisposableFork } from './auto-commit.js';
import { putKnowledge } from '../evidence/store.js';
import { extractAnchors } from '../efficiency/task-economics.js';
import { planCacheKey, getCachedPlan, putCachedPlan } from '../db/queries/plan-cache.js';
import { resultCacheKey, getCachedResult, putCachedResult, type CachedResult } from '../db/queries/result-cache.js';
import { dependenciesFromEvents, buildDependencyFingerprint, dependenciesValid } from '../context/dependencies.js';
import { indexRunObservations, scoreProjection, recordRunInManifest, recordChildFinding } from './run-index.js';
import { createDispatchLedger, type DispatchLedger } from '../observability/context-ledger.js';
import { assembleExecutePrompt, assemblePlanPrompt, assembleSynthesisPrompt, promptBudgetFromConfig } from '../prompt/prompt-runtime.js';
import { buildAgentEnvelope, renderEnvelope, EnvelopeError } from '../intelligence/agent-envelope.js';
import { putAgentEnvelope, getAgentEnvelope } from '../db/queries/envelopes.js';
import { scopeOf } from '../context/types.js';
import { prepareDispatch, type DispatchPreparation } from '../decision/dispatch-preparation.js';
import { decideStrategy } from '../decision/strategy-gate.js';
import { strategyPriorFor } from '../decision/strategy-memory.js';
import { observationFrom } from '../learning/hierarchical.js';
import { buildCounterfactualObservation } from '../learning/counterfactual.js';
import type { ExecutionStrategy } from '../decision/strategy-gate.js';
import { policyVersion } from '../efficiency/policy-version.js';
import { evaluateSpendGuard, SpendGuardStop, type SpendGuardState } from '../efficiency/spend-guard.js';
import { summarizeExecutionTrajectory, executionSnapshot, UNKNOWN_PROGRESS } from '../efficiency/progress-signals.js';
import { executionPolicyForGoal, calibrate, effectiveTurnCap, currentPolicyVersions, EXECUTION_POLICY_VERSION } from '../efficiency/policy.js';
import { activePolicyChanges } from '../learning/policy-experiments.js';
import { templateFor, pruneTemplate } from '../intelligence/execution-templates.js';
import type { TaskMode } from '../intelligence/task-understanding.js';
import { authorizeExecution, receipt, type DecisionReceipt } from '../decision/engine.js';
import { MIN_SPLIT, requiredBudgetUsd, type DelegationPricing } from '../engines/decide-execution.js';
import { decompositionBoundary } from '../system1/economic-mapping.js';
import { candidateFingerprint } from '../decision/transition.js';
import { modelCapabilities, currentAccount, classifyRuntimeFailure, ALL_MODELS } from '../execution/model-capability.js';
import {
  selectExecution, settleExecution, cancelExecution, refuseModel, forgetExecutionNode, recordCandidateOutcomes,
  observeHarnessHealth, measuredDispatchTokens, marketViewOf, commitDecision, settleDecision, refineDifficulty,
  beliefFor, priceDelegation, qualityFloorFor, type ExecutionSelection,
} from './execution-market.js';
import { usdPerToken, isConstraintCode } from '../decision/utility.js';
import { uninformedDifficulty, withSemanticEstimate, type Difficulty } from '../intelligence/difficulty.js';
import { understandingFor, READ_ONLY_GRANT, WRITABLE_GRANT, modeOf } from '../intelligence/task-understanding.js';
import { rateLimitFromEvents } from '../execution/rate-limit.js';
import { dispatchContextFor, warmRepoInventory } from '../context/dispatch-context-cache.js';
import { recordDispatchUsage, turnsForNode } from '../db/queries/tokens.js';
import { shouldRetryWithoutModel, recoveredUsage, visibleContextProfile } from '../execution/tokens.js';
import { estimateCostUsd } from '../execution/pricing.js';
import { readOnlyPlanningGrant, investigativeExecuteGrant, needsProofOnly, unprovableWithoutChanges, PROOF_PASS_INSTRUCTION, PROOF_PASS_TURNS } from './dispatch-helpers.js';
import {
  evaluateBoundary, currentBoundaryState, economicStateFor, forgetNode, isIntervention, registerEvidenceSources, observedStateVersion,
  markRecovered, consumeRecoveryFlag, recordRecoveryAttempt,
} from './economic-runtime.js';
import { tombstoneFor } from '../recovery/engine.js';
import { validate, failureSignatureFor, type ValidationEvidence, type ValidationResult } from '../validation/engine.js';
import { contractFor } from '../validation/contract.js';
import { validationProfileFor, contractForProfile, meetsMinimumLevel } from '../validation/profile.js';
import { taskEconomicsFor } from '../efficiency/task-economics.js';
import { requestEvidenceAtBoundary, renderAcquiredEvidence } from '../context/evidence-actions.js';
import { actionCandidate, type ActionDecision } from '../decision/actions.js';
import type { EconomicState } from '../decision/state.js';
import { memory } from '../db/schema.js';
import { assessDecomposability } from '../system1/decomposability.js';
import { assessChangeRequest, EXPLAIN_THRESHOLD } from '../system1/change-request.js';
import { verifiedChangeAtTurnCap, isVerifyingCommand, externalActionChecks } from '../execution/observation.js';
import { refineWithSystem1 } from '../decision/system1-decision.js';
import { createModelGateway } from '../system1/model-gateway.js';
import { stateFacts } from '../system1/compiler.js';
import { system1Config } from '../config/system1.js';
import type { ExecuteStepInput } from '../execution/execute-step.js';
import { buildReceipt, epochOf, SYSTEM1_EVENT, type ReceiptContext } from '../system1/receipts.js';
import { system1, type JudgeOutcome } from '../system1/guard.js';

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

function workspaceFork(workspace: WorkspaceRef): WorkspaceFork {
  return {
    path: workspace.path, basePath: workspace.basePath, revision: workspace.revision,
    release: () => releaseFork(workspace.basePath, workspace.path),
  };
}

/** Merges an *accepted* child's candidate into the parent's tree — the only
 *  production path from a child's workspace to the tree the rest of the run sees.
 *
 *  Being ACCEPTED is not a convention this function checks and could be talked
 *  out of: the move into MERGING is a transition the delegation table refuses
 *  from anything else. A child whose node is COMPLETE, whose report is ready, or
 *  whose review is still open cannot get through, and nothing here lets a caller
 *  say otherwise.
 *
 *  Previously a finished child's fork was integrated the moment it finished,
 *  whether or not it passed — so unreviewed work reached the parent's tree. The
 *  fork is now released only on a successful merge (or an explicit terminal
 *  cleanup elsewhere). A merge that conflicts is INTEGRATION_BLOCKED: the base
 *  is left exactly as it was, the candidate stays, and nothing is reopened —
 *  the work was accepted, and a conflict is not evidence it was wrong.
 *
 *  `integrate` is injectable so the gate is testable without a repository. */
export function mergeAcceptedDelegation(
  db: Db,
  assignmentId: string,
  integrate: (fork: WorkspaceFork) => boolean | IntegrationResult = integrateForkDetailed,
): 'MERGED' | 'INTEGRATION_BLOCKED' {
  const record = getDelegation(db, assignmentId);
  if (!record) throw new Error(`Delegation ${assignmentId} does not exist`);
  // Already MERGING is a merge a restart cut off: it is finished, not begun
  // again. Anything else has to go through the table, which is what refuses a
  // child that was never accepted.
  const resuming = record.status === 'MERGING';
  if (!resuming) transitionDelegation(db, assignmentId, 'MERGING', {}, new Date().toISOString());

  const workspace = record.workspace;
  // No workspace means the child worked in the parent's own tree; there is no
  // separate candidate to integrate, only the acceptance that already happened.
  // A resumed merge first asks whether the apply already landed before the
  // daemon died, rather than applying twice.
  const attempt = !workspace ? true
    : resuming && isForkIntegrated(workspaceFork(workspace)) ? true
    : integrate(workspaceFork(workspace));
  const result: IntegrationResult = typeof attempt === 'boolean'
    ? { merged: attempt, conflicts: [], unionResolved: [] }
    : attempt;
  if (!result.merged) {
    transitionDelegation(db, assignmentId, 'INTEGRATION_BLOCKED', {}, new Date().toISOString(), {
      reason: result.conflicts.length > 0
        ? `the accepted candidate conflicts with work already merged, in: ${result.conflicts.slice(0, 10).join(', ')}`
        : 'the accepted candidate did not apply cleanly onto the parent tree',
    });
    return 'INTEGRATION_BLOCKED';
  }
  transitionDelegation(db, assignmentId, 'MERGED', {}, new Date().toISOString(), result.unionResolved.length > 0
    ? { reason: `merged; kept both sides of append-only files: ${result.unionResolved.join(', ')}` }
    : {});
  if (workspace) releaseFork(workspace.basePath, workspace.path);
  recordAcceptedFinding(db, record.childId);
  return 'MERGED';
}

/** What an accepted, merged piece of work established, recorded against its task
 *  so the manifest can point at it. Only at acceptance: a finding nobody has
 *  accepted is a claim, not a fact. The child's report itself is untouched. */
function recordAcceptedFinding(db: Db, childId: string): void {
  try {
    const child = getNode(db, childId);
    if (!child) return;
    const grant = grantOf(child.contract.authority);
    recordChildFinding(db, {
      taskId: taskRootId(db, childId), childId, goal: child.goal, report: answerOf(db, childId),
      succeeded: true, scope: scopeOf(grant.allowedTools, grant.readOnly),
    });
  } catch (err) {
    console.error(`Failed to record the accepted finding of child ${childId}:`, err);
  }
}

/** The assignment ledger the delegation loop writes to: the durable table, with
 *  every status change also an event. */
export function dbDelegationLedger(db: Db): DelegationLedger {
  return {
    open: (input) => openDelegation(db, { ...input, id: randomUUID() }, new Date().toISOString()),
    transition: (id, to, patch, detail, options) =>
      transitionDelegation(db, id, to, patch ?? {}, new Date().toISOString(), detail, options),
    get: (id) => getDelegation(db, id),
    listForParent: (parentId) => listDelegationsForParent(db, parentId),
    merge: async (id) => mergeAcceptedDelegation(db, id),
  };
}

/** What the child's own worktree says about its work, laid over what the
 *  runtime recorded.
 *
 *  The tree is the ground truth: a tool-event tracker misses a `sed -i` or a
 *  generated file, and the write-scope check has to be about what is actually
 *  in the candidate. Also reports any conflict markers left in it, since a
 *  candidate that still has them is not finished. A child with no workspace of
 *  its own (it shares its parent's tree, or the tree cannot be read) keeps what
 *  the runtime recorded. */
export function observeCandidate(run: ChildRunResult, workspace: WorkspaceRef | undefined): ChildRunResult {
  if (!workspace || run.cancelled) return run;
  const changed = candidateChangedFiles(workspace.path);
  if (!changed) return run;
  return { ...run, changedFiles: changed, conflictMarkers: filesWithConflictMarkers(workspace.path, changed) };
}

/** The event id at which the child's current revision began: its last rework, or
 *  0 for a child on its first run. Assignment events are on the parent, and ids
 *  are monotonic across the whole log, so anything the child did after this id
 *  belongs to the revision now being reviewed. */
function currentRevisionStart(db: Db, childId: string): number {
  const parent = getNode(db, childId)?.parentId;
  if (!parent) return 0;
  return listEventsForNode(db, parent)
    .filter((row) => row.type === 'delegation.reworking' && (row.payload as { childId?: string }).childId === childId)
    .at(-1)?.id ?? 0;
}

/** What a finished child left behind, read back from the records — never from
 *  what the child says about itself. The child's verdict is its own validation;
 *  the parent's review, not this, decides what that is worth. */
export function childRunResult(
  db: Db, childId: string, completion: { succeeded: boolean; cancelled?: boolean },
): ChildRunResult {
  if (completion.cancelled) return { succeeded: false, cancelled: true };
  const artifacts = subtreeArtifacts(db, childId);
  const written = artifacts.filter((a) => (a.kind === 'file_edit' || a.kind === 'file_write') && a.path);
  const validationEvent = listEventsForNode(db, childId)
    .filter((row) => row.type === 'validation.result').sort((a, b) => b.id - a.id)[0];
  const evidence = validationEvidenceFor(db, childId, completion.succeeded, currentRevisionStart(db, childId));
  const stored = validationEvent?.payload as Partial<ValidationResult> | undefined;
  return {
    succeeded: completion.succeeded,
    answer: answerOf(db, childId),
    changedFiles: [...new Set(written.map((a) => a.path as string))].sort(),
    observedChecks: evidence.observedChecks,
    evidenceRefs: [
      ...(validationEvent ? [`validation:${validationEvent.id}`] : []),
      ...artifacts.filter((a) => a.kind !== 'result').slice(0, 20).map((a) => `artifact:${a.id}`),
    ],
    ...(stored && typeof stored.passed === 'boolean' ? {
      validation: {
        level: stored.level ?? 'V0', passed: stored.passed, confidence: stored.confidence ?? 0,
        tokens: stored.tokens ?? 0, latencyMs: stored.latencyMs ?? 0,
        evidenceIds: stored.evidenceIds ?? [], reasonCodes: stored.reasonCodes ?? [],
      } satisfies ValidationResult,
    } : {}),
  };
}

/** A check the trace cannot answer but the candidate tree can: `file:<path>`
 *  exists in the child's workspace. Deterministic, read-only, and confined to
 *  that workspace. Anything else is `null` — "cannot say", never "failed". */
function fileCheckVerifier(workspace: WorkspaceRef | undefined): CheckVerifier {
  return (check) => {
    const match = /^file:\s*(.+)$/i.exec(check.trim());
    if (!match || !workspace) return null;
    const relative = match[1].trim();
    if (relative.startsWith('/') || relative.split(/[\\/]/).includes('..')) {
      return { passed: false, evidenceId: `fs:${relative}`, observed: 'the path is outside the workspace' };
    }
    const present = existsSync(joinPath(workspace.path, relative));
    return { passed: present, evidenceId: `fs:${relative}`, observed: present ? 'exists' : 'does not exist in the candidate' };
  };
}

export function realDelegateDeps(db: Db, parentId?: string): DelegateChildDeps {
  // Scoped to one delegation call. The *isolated workspaces* are not held here
  // as live objects: each assignment records its own (`DelegationRecord.workspace`),
  // so a workspace outlives this call for as long as its assignment is
  // unresolved — retained through a failed review, released on merge or on an
  // explicit terminal cleanup.
  const workspaces = new Map<string, WorkspaceRef>();
  const ledger = dbDelegationLedger(db);
  return {
    ledger,
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
    createChildNode: (parentId, goal, siblingCount, approvedBudgetUsd, budgetCapUsd) => {
      const parent = getNode(db, parentId);
      if (!parent) throw new Error(`Parent node ${parentId} not found`);
      const id = randomUUID();
      const now = new Date().toISOString();
      // What a child needs to afford splitting its own piece, priced by the same
      // market as everything else: a piece is a narrower job than the whole.
      const belief = beliefFor(db, parentId, parent.contract.goal);
      const pieceBelief = { ...belief, value: belief.value / MIN_SPLIT };
      const piecePricing = priceDelegationSafely(db, parentId, parent.contract.goal, pieceBelief, parent.repoPath ?? undefined);
      const authority = childAuthority(
        parent.contract.authority, siblingCount, approvedBudgetUsd, budgetCapUsd,
        piecePricing ? requiredBudgetUsd(piecePricing) : undefined,
      );
      // A child that can write must not work in the parent's own tree, whether it
      // has siblings or not. Two siblings sharing a checkout race, and the last
      // to finish wins silently — that was the original reason. The stronger one
      // is acceptance: the parent reviews a child's *candidate* before taking
      // responsibility for it, and a lone child editing the parent's tree
      // directly has already merged before anyone looked. A read-only child
      // cannot corrupt anything and shares the parent's tree for free;
      // forkWorkspace's own failure path (not a git repo, no git available) falls
      // back to sharing it too, which only gives up isolation, not correctness
      // beyond what the runtime already had.
      let repoPath = parent.repoPath;
      if (!isReadOnly(authority) && parent.repoPath) {
        // A parent that is itself a delegated child works in a fork, and its
        // stored path is the container form of it. Forking that string would find
        // nothing on the host and silently give *its* children no isolation, so
        // the hierarchy would be isolated one level deep and shared below it.
        const fork = forkWorkspace(fromContainerPath(parent.repoPath) ?? parent.repoPath, 'HEAD', id);
        if (fork) {
          // fork.path is a real host path (workspace-fork.ts anchors forks
          // under $HOME, outside any repo). node.repoPath must be the
          // container-relative form -- the same invariant run.ts establishes
          // for the root node's --repo -- or the child's own Job hostPath
          // resolves to a path the kind node's filesystem cannot see and its
          // pod hangs in ContainerCreating forever (confirmed empirically:
          // repeated FailedMount events). Merging is unaffected: it reads the
          // host path from the assignment's `workspace`, not from repoPath.
          repoPath = toContainerPath(fork.path);
          workspaces.set(id, { path: fork.path, basePath: fork.basePath, revision: fork.revision });
        }
      }
      insertNode(db, {
        id, parentId, goal,
        contract: { ...parent.contract, goal, authority },
        state: 'CREATED', repoPath, createdAt: now, updatedAt: now,
      });
      return id;
    },
    // The snapshot the assignment records: what this child was actually granted
    // and where it works — read from the row it was created with, never
    // recomputed later.
    describeChild: (childId) => {
      const authority = getNode(db, childId)?.contract.authority;
      const workspace = workspaces.get(childId);
      return {
        ...(authority ? { budgetUsd: authority.budget_usd, authority } : {}),
        ...(workspace ? { workspace } : {}),
      };
    },
    recordCommitment: (childId, goal, definitionOfDone) => {
      const now = new Date().toISOString();
      // The child's own definition of done when the plan gave one, else the
      // goal itself as before.
      const dod = definitionOfDone?.length ? definitionOfDone : [goal];
      insertCommitment(db, {
        id: randomUUID(), owner: childId, goal, definition_of_done: dod,
        status: 'pending', created_at: now,
        dependencies: [], evidence: [], risks: [],
      }, now);
      // A child's promise is checkable on the same terms as the root's. Without
      // this a delegating case reports a definition of done covering only the
      // work the root did itself, which is usually none of it.
      insertDodItems(db, childId, dod, now, () => randomUUID());
    },
    recordEnvelope: (childId, goal, approvedBudgetUsd, contract) => {
      const child = getNode(db, childId);
      if (!child) return;
      try {
        const grant = grantOf(child.contract.authority);
        putAgentEnvelope(db, childId, buildAgentEnvelope({
          goal,
          // The parent's standing constraints are the child's too: a mandate
          // does not stop applying because the work was handed on. The
          // assignment's own contract rides beside them, compactly: what to
          // produce, and what the parent will require before accepting it.
          constraints: [
            ...(child.contract.constraints ?? []),
            ...(contract?.definitionOfDone.length ? [`Definition of done: ${contract.definitionOfDone.join(' | ').slice(0, 1_500)}`] : []),
            ...(contract?.acceptanceChecks.length ? [`The parent will accept this work only if: ${contract.acceptanceChecks.join(' | ').slice(0, 1_500)}`] : []),
            // What the child may touch, stated up front: a rework spent on a write
            // it was never allowed to make costs more than the sentence does.
            ...(contract?.writeScope?.length ? [`You may modify only: ${contract.writeScope.join(', ').slice(0, 1_500)}`] : []),
            `Do not edit CI config, env files, package manifests or lockfiles (${PROTECTED_PATHS.join(', ')}) unless your assignment names them — report the need instead.`,
          ],
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
    // A finished child's terminal handler closed its commitments; the same child
    // is about to work again, so they are open again.
    reopenChild: (childId) => {
      const now = new Date().toISOString();
      for (const commitment of listCommitmentsForNode(db, childId)) {
        updateCommitmentStatus(db, commitment.id, 'pending', now);
      }
    },
    // A conflicted merge is settled by the child that wrote one side of it: its
    // workspace is moved onto the parent's current state with its work re-applied,
    // and the overlap is left as markers in *its* tree. The parent's is untouched.
    prepareConflictRework: (assignment) => {
      const workspace = assignment.workspace ?? workspaces.get(assignment.childId);
      if (!workspace) return null;
      const rebased = rebaseForkOntoBase(workspaceFork(workspace));
      return rebased ? { conflicts: rebased.conflicts } : null;
    },
    discardWorkspace: (assignment) => {
      const workspace = assignment.workspace ?? workspaces.get(assignment.childId);
      if (workspace) releaseFork(workspace.basePath, workspace.path);
    },
    // What the child has left of what it was given. A reassigned child is capped
    // at this, so changing owner cannot create budget.
    remainingBudget: (childId) => {
      const granted = getNode(db, childId)?.contract.authority.budget_usd;
      return granted === undefined ? undefined : Math.max(0, granted - getCostForNodes(db, [childId]));
    },
    // The governor after a failed review: the Action Market's own recovery
    // pricing (see `decideRecoveryFor`), behind a hard budget floor. It can only
    // choose among ways of continuing or stopping; the verdict on the work is
    // the review's, not its.
    decideRecovery: (context) => decideRecoveryFor(db, context),
    // The candidate being checked is this assignment's own workspace.
    verifyCheck: (check, assignment) =>
      fileCheckVerifier(assignment.workspace ?? workspaces.get(assignment.childId))(check),
    parentStopped: () => {
      const state = parentId ? getNode(db, parentId)?.state : undefined;
      return state === 'CANCELLED' || state === 'FAILED' || state === 'INTERRUPTED';
    },
    // Execution over, and nothing more. Not "integrated", not "accepted": the
    // parent's review decides what a finished child is worth, and only an
    // accepted one merges (`mergeAcceptedDelegation`).
    waitForChild: async (childId) => {
      const completion = await childCompletion(db, childId);
      // The workspace is on the assignment, so a parent that restarted (and so
      // has an empty map here) still finds its child's.
      const workspace = workspaces.get(childId)
        ?? listDelegationsForChild(db, childId).map((record) => record.workspace).filter(Boolean).at(-1);
      return observeCandidate(childRunResult(db, childId, completion), workspace);
    },
    getFindings: (childId) => answerOf(db, childId),
    markSuperseded: (failedId, replacementId) => {
      try {
        markNodeSuperseded(db, failedId, replacementId, new Date().toISOString());
        publishProgress(db, failedId, `Reassigned to a different agent (${replacementId}) by an explicit decision.`);
      } catch (err) {
        // Recording the link must never cost the replacement its dispatch.
        console.error(`Failed to mark node ${failedId} as superseded by ${replacementId}:`, err);
      }
    },
  };
}

/** The child's own economic state, from what the runtime already recorded about
 *  it, with its dollar authority laid over the token accounting.
 *
 *  `economicStateFor` prices in tokens and knows nothing of a child's dollar
 *  grant; the market ranks in dollars and refuses what the money cannot fund. So
 *  the grant, the spend and the price per token this child actually paid are
 *  added when there is a measurement of them. Reading the state must not leave a
 *  trace: it is a question, not a boundary, so it does not advance the node's
 *  trajectory memory and does not leave an entry behind for a finished node. */
export function assignmentEconomicState(db: Db, childId: string, goal: string): EconomicState {
  try {
    const base = economicStateFor(db, { nodeId: childId, goal }, { commit: false });
    const authority = getNode(db, childId)?.contract.authority;
    const spentUsd = getCostForNodes(db, [childId]);
    const consumed = base.resources.consumedTokens;
    return normalizeEconomicState({
      ...base,
      resources: {
        ...base.resources,
        ...(authority && spentUsd > 0 && consumed > 0
          ? { budgetUsd: authority.budget_usd, spentUsd, usdPerToken: spentUsd / consumed }
          : {}),
      },
    });
  } finally {
    forgetNode(childId);
  }
}

/** What to do about a refused assignment, in production.
 *
 *  Two layers, in this order. A hard floor first: a child that cannot fund
 *  another dispatch is not sent back, whatever the market would say. Then the
 *  market (`assignment-market.ts`), which prices keeping the child against
 *  handing the work on against stopping, from this child's own measured state.
 *  The decision and what it considered are written to the log, so "why was this
 *  reworked / reassigned / escalated" has an answer beyond the status. */
export function decideRecoveryFor(db: Db, context: RecoveryContext): RecoveryDecision {
  const { assignment } = context;
  const granted = getNode(db, assignment.childId)?.contract.authority.budget_usd;
  const remaining = granted === undefined
    ? undefined : Math.max(0, granted - getCostForNodes(db, [assignment.childId]));
  if (remaining !== undefined && remaining < MIN_AGENT_BUDGET_USD) {
    return {
      action: 'escalate',
      reason: `the child has $${remaining.toFixed(2)} left, less than the $${MIN_AGENT_BUDGET_USD.toFixed(2)} another revision needs`,
    };
  }

  const { decision, receipt } = decideAssignmentRecovery({
    context,
    state: assignmentEconomicState(db, assignment.childId, assignment.goal),
    // A different owner has to be fundable: the successor is capped at what this
    // child has left, and `requestReassignment` refuses below the same floor.
    canReassign: remaining === undefined || remaining >= MIN_AGENT_BUDGET_USD,
  });
  try {
    const now = new Date().toISOString();
    const payload = { assignmentId: assignment.id, parentId: assignment.parentId, childId: assignment.childId, ...receipt };
    // Not under `delegation.`: those are the assignment's own status changes,
    // and this is a decision about one.
    const id = appendEvent(db, { nodeId: assignment.parentId, type: 'recovery.assignment_decided', payload, createdAt: now });
    publish({ id, nodeId: assignment.parentId, type: 'recovery.assignment_decided', payload, createdAt: now });
  } catch (err) {
    // The decision stands without its receipt; a log that cannot be written must
    // not cost the assignment its recovery.
    console.error(`Failed to record the recovery decision for assignment ${assignment.id}:`, err);
  }
  return decision;
}

/** One node's delegation: plan the split, hand it out, and combine the answers —
 *  or, for a node restarted mid-delegation, pick the work up where it stopped.
 *
 *  Restarting used to lose the whole organisation. Assignments were durable, but
 *  the loop that drove them was not, and a resumed parent found children already
 *  existed, refused to split a second time, and did the work itself — leaving a
 *  child that had finished at REPORT_READY unreviewed and unmerged, its workspace
 *  orphaned. The plan is now kept beside the assignments, so a parent that comes
 *  back with work in flight (or a piece that never got its turn) reattaches to
 *  it. With nothing in flight the old rule stands: a node that already delegated
 *  does not split a second time. */
export async function delegateNode(
  db: Db,
  nodeId: string,
  input: { goal: string; approvedBudgetUsd?: number },
  makeDeps: (db: Db, parentId: string) => DelegateChildDeps = realDelegateDeps,
): Promise<ExecuteStepResult> {
  const node = getNode(db, nodeId);
  const existingChildren = listNodes(db).filter((child) => child.parentId === nodeId).length;

  const saved = existingChildren > 0 ? loadDelegationPlan(db, nodeId) : undefined;
  const resuming = saved !== undefined
    && needsResume(listDelegationsForParent(db, nodeId), saved.after, saved.subgoals.length);

  // Planning costs a sandbox. Do not pay for one only to refuse the
  // result because this node has already delegated.
  // Nor to be told again what this node was already told: a validation
  // retry comes back through DELEGATE, and on a dirty tree (no plan
  // cache) every retry used to buy the same refusal again.
  const alreadyDeclined = delegationDeclinedReason(db, nodeId) !== undefined;
  const plan: ParsedPlan = resuming ? saved! : existingChildren > 0 || alreadyDeclined
    ? NO_PLAN
    : await planSubgoals(db, nodeId, input.goal, node?.contract.authority.max_child_count ?? 0);

  if (resuming) {
    publishProgress(db, nodeId, 'Picking the delegated work back up where it stopped');
  } else if (plan.subgoals.length > 0) {
    // Kept beside the assignments it is about to produce: a restart can only
    // find the pieces that had not been handed out yet if it can find the plan.
    try {
      saveDelegationPlan(db, nodeId, plan, new Date().toISOString());
    } catch (err) {
      console.error(`Failed to keep the delegation plan for node ${nodeId}:`, err);
    }
    // How many ways, not what each piece is. Every subgoal is a whole
    // instruction, so joining four of them produced a 1,500-character
    // "progress" line that buried the transcript it was meant to
    // narrate — and each one appears immediately below as a named agent
    // anyway.
    publishProgress(db, nodeId, `Splitting the work ${plan.subgoals.length} ways`);
    // Warm the map here, once, before the children start: they all sit
    // on this same commit, so otherwise N children starting together
    // each build an identical map and store an identical row.
    const mapPath = node?.repoPath ?? process.env.ORG_WORKTREE_PATH;
    if (mapPath) warmRepoInventory(db, mapPath);
  }

  const result = await delegateToChildren({
    parentId: nodeId, goal: input.goal, subgoals: plan.subgoals, after: plan.after,
    // What the parent will hold each piece to, from the plan: each piece's own
    // definition of done and the checks that prove it. Only what evidence can
    // meet was admitted (see `isEvidenceableCheck`).
    definitionOfDoneBySubgoal: plan.definitionOfDone,
    acceptanceChecksBySubgoal: plan.acceptanceChecks,
    existingChildren,
    resume: resuming,
    approvedBudgetUsd: input.approvedBudgetUsd,
    // So the plan is checked against what this node may actually
    // authorize, before a single child node exists.
    ...(node ? { authority: node.contract.authority } : {}),
  }, makeDeps(db, nodeId));

  if (result.notDelegatable) recordDelegationDeclined(db, nodeId, result.message);
  // The root owes an answer, not a tally of its children.
  if (!result.notDelegatable) {
    const combined = await synthesizeChildren(db, nodeId, input.goal);
    if (combined) {
      publishAnswer(db, nodeId, combined);
      return { ...result, message: combined };
    }
  }
  return result;
}

const ADAPTERS: RuntimeAdapter[] = [claudeCodeAdapter, codexAdapter];

/** The harnesses this deployment can dispatch to right now — capability
 *  discovery's input. Which of them runs a given dispatch is the Action
 *  Market's decision (`execution-market.ts`), never this function's.
 *
 *  ORG_RUNNER_IMAGE means "dispatch a stand-in image": no real harness runs
 *  inside it, so the stand-in is the only capability there is. */
function availableAdapters(): RuntimeAdapter[] {
  return runnerImageOverride() ? [stopgapAdapter] : ADAPTERS;
}

/** Runs one dispatch on the candidate the market committed to, and — if the
 *  harness refuses the model — re-enters the market rather than retrying on a
 *  hardcoded default. The refused candidate becomes infeasible for this node;
 *  the dispatch was assembled for this harness, so the new choice stays on it.
 *  Every attempt's commitment is settled against what it actually spent. */
async function runOnMarket(
  db: Db,
  nodeId: string,
  role: DispatchRole,
  goal: string,
  first: ExecutionSelection,
  run: (model: string | undefined, effort?: string) => Promise<StepResult>,
): Promise<{ result: StepResult; selection: ExecutionSelection }> {
  let selection = first;
  const attempt = async (current: ExecutionSelection) => {
    const started = Date.now();
    const result = await run(current.model, current.effort);
    // Health is observed, and expires. A rejection that says when its window
    // resets makes the harness infeasible until then; one that does not is
    // priced as riskier rather than ruled out; a run that got through clears it.
    const limited = rateLimitFromEvents(result.events as StructuredEvent[]);
    if (current.adapter) {
      if (limited?.resetsAtSeconds !== undefined) {
        observeHarnessHealth(current.adapter.name, 'rate_limited', limited.resetsAtSeconds * 1000);
      } else if (limited) {
        observeHarnessHealth(current.adapter.name, 'degraded');
      } else if (result.succeeded) {
        observeHarnessHealth(current.adapter.name, 'healthy');
      }
    }
    // What this run says about the account, remembered for every node. A
    // success clears a block; a refusal the runtime itself worded as one starts
    // a cooldown, so the next node does not pay a sandbox to be told again.
    if (current.adapter) {
      const account = currentAccount();
      const model = current.model ?? 'default';
      if (result.succeeded) {
        modelCapabilities.observeSuccess({ provider: current.adapter.name, model, account });
      } else {
        const failure = classifyRuntimeFailure(result.events as StructuredEvent[]);
        if (failure === 'model_unavailable') {
          modelCapabilities.observeFailure({ provider: current.adapter.name, model, account }, 'model_unavailable');
        } else if (failure === 'auth') {
          modelCapabilities.observeFailure({ provider: current.adapter.name, model: ALL_MODELS, account }, 'auth');
        }
      }
    }
    settleExecution(db, nodeId, current, {
      tokens: result.usage.inputTokens + result.usage.outputTokens,
      usd: costFromEvents(result.events),
      latencyMs: Date.now() - started,
      succeeded: result.succeeded,
    });
    return result;
  };

  let result = await attempt(selection);
  if (selection.model && selection.adapter && shouldRetryWithoutModel(result.events)) {
    publishProgress(db, nodeId, `Model "${selection.model}" is unavailable on this plan — asking the market for another candidate`);
    insertMemoryRow(db, 'model_tier_unavailable', role, { model: selection.model, candidate: selection.candidate.id }, nodeId);
    recordSupersededAttempt(nodeId, role, result);
    refuseModel(nodeId, selection.adapter.name, selection.model, 'model_unavailable_on_plan');
    const next = selectExecution(db, {
      nodeId, role, goal, adapters: availableAdapters(), harness: selection.adapter.name,
    });
    if (!next.blocked && next.adapter) {
      selection = next;
      result = await attempt(next);
    }
  }
  return { result, selection };
}

type StepResult = Awaited<ReturnType<typeof executeStep>>;

/** A dispatch the market could not fund or run, reported as the step outcome
 *  rather than silently substituted: every candidate's refusal is on the
 *  `market.decision` event. */
function blockedStep(selection: ExecutionSelection) {
  const reasons = (selection.decision.rejected ?? [])
    .map((r) => `${r.id}: ${r.reasonCodes.filter(isConstraintCode).join(', ')}`)
    .join('; ');
  return {
    succeeded: false,
    message: `No execution candidate is feasible${reasons ? ` — ${reasons}` : ''}.`,
    events: [] as StructuredEvent[],
    usage: { ...ZERO_USAGE },
  };
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
  // No final result: the run was killed or crashed after spending. Estimated
  // from the per-step usage it did report, so neither the ledger nor the
  // spend cap reads a paid-for run as free.
  const recovered = recoveredUsage(events as StructuredEvent[]);
  return estimateCostUsd(recovered.usage, recovered.model);
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

/** The market's execution decision in the receipt shape the transcript and
 *  the Why view already read: what was chosen, what it beat, and what it was
 *  expected to cost. */
function receiptFromSelection(selection: ExecutionSelection, declined: string | undefined): DecisionReceipt {
  const { decision } = selection;
  const alternatives = (decision.ranked ?? []).filter((r) => r.id !== decision.action.id).map((r) => ({
    type: r.id.startsWith('reuse:') ? 'REUSE_COMPUTATION' as const : 'RUN_MODEL' as const,
    reason: `${r.id}: expected $${r.expectedCostUsd.toFixed(4)} to finish`,
    estimate: { tokens: 0, latencyMs: 0, costUsd: r.expectedCostUsd },
  }));
  const estimate = {
    tokens: Math.round(decision.estimate?.immediateCost.tokens ?? 0),
    latencyMs: Math.round(decision.estimate?.immediateCost.latencyMs ?? 0),
    costUsd: decision.expectedCostUsd ?? 0,
  };
  if (selection.reuse) {
    return receipt({
      chosen: 'REUSE_COMPUTATION', fastPath: true, alternatives,
      reason: `this exact question already has a valid answer from ${selection.reuse.candidateId}, saving ~${selection.reuse.tokensSaved} tokens`,
      estimate,
    });
  }
  if (selection.blocked) {
    return receipt({ chosen: 'STOP', gate: 'no-feasible-candidate', fastPath: true, reason: 'no execution candidate is feasible', alternatives });
  }
  const chosen = `${selection.adapter?.name ?? '?'} / ${selection.model ?? 'runtime default'}`;
  return receipt({
    chosen: 'RUN_MODEL', alternatives, estimate,
    confidence: decision.confidence,
    reason: declined
      ? `delegation was chosen but not carried out — ${declined}; running ${chosen}`
      : `${chosen} is the cheapest feasible way to finish ($${(decision.expectedCostUsd ?? 0).toFixed(4)} expected)`,
  });
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
function publishExecutionPlan(db: Db, nodeId: string, taskClass: TaskMode, known: Set<string>, declined?: string): void {
  try {
    const pruned = pruneTemplate(templateFor(taskClass), known);
    // A multi_workstream template names delegation steps; after a declined
    // delegation they did not run, and listing them would say they did.
    if (declined) {
      const delegating = pruned.steps.filter((step) => step.intent === 'SPAWN_AGENT' || step.intent === 'SYNTHESIZE');
      pruned.steps = pruned.steps.filter((step) => !delegating.includes(step));
      pruned.removed.push(...delegating.map((step) => ({ step, reason: `delegation declined: ${declined}` })));
    }
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

/** The task a node belongs to: the root of its tree. */
function taskRootId(db: Db, nodeId: string): string {
  let current = nodeId;
  for (let depth = 0; depth < 32; depth++) {
    const parent = getNode(db, current)?.parentId;
    if (!parent) return current;
    current = parent;
  }
  return current;
}

/** One trace per logical dispatch: the prompt it was compiled from, what the
 *  boundary bought for it, what the runtime then spent. Total — measuring must
 *  never cost the run. */
function newDispatchLedger(db: Db, nodeId: string, role: DispatchRole): DispatchLedger {
  let taskId = nodeId;
  try { taskId = taskRootId(db, nodeId); } catch { /* the node id is the best key left */ }
  return createDispatchLedger({ taskId, nodeId, dispatchId: `${nodeId}/${role}/${randomUUID().slice(0, 8)}` });
}

function flushDispatchLedger(db: Db, nodeId: string, dispatchLedger: DispatchLedger): void {
  dispatchLedger.flush((type, payload) => {
    const now = new Date().toISOString();
    const id = appendEvent(db, { nodeId, type, payload, createdAt: now });
    publish({ id, nodeId, type, payload, createdAt: now });
  });
}

/** What the run's context looked like from the model's side: the busiest turn,
 *  and any point where the runtime cleared or compacted its own history. The
 *  conversation is the agent CLI's, not ours; this is how it is measured
 *  anyway, from the usage every turn already reports. */
function recordVisibleContext(trace: DispatchLedger, events: StructuredEvent[]): void {
  try {
    const profile = visibleContextProfile(events);
    if (profile.turns === 0) return;
    trace.record('visible', {
      tokens: profile.peak,
      reason: `turns=${profile.turns} first=${profile.first} last=${profile.last} avg=${Math.round(profile.average)}`,
    });
    for (const cut of profile.reductions) {
      trace.record('compact', { tokens: cut.tokens, reason: `runtime reduced its own context ${cut.from}->${cut.to}` });
    }
  } catch { /* observability only */ }
}

/** A prompt the compiler refused is a dispatch that must not happen: a required
 *  piece did not fit the argument limit, and sending it would fail in the kernel
 *  with a cryptic E2BIG instead of saying so. */
function refusedStep(reason: string) {
  return {
    succeeded: false,
    message: `This dispatch's prompt cannot fit the runtime's input limit: ${reason}`,
    events: [] as StructuredEvent[],
    usage: { ...ZERO_USAGE },
  };
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
    /** Told what was actually bought, so the dispatch's trace can say so. */
    onAcquired?: (a: { path: string; tokens: number; representation: 'full' | 'symbol' }) => void;
  },
): Promise<string> {
  try {
    const revision = repoHead(input.worktreePath) ?? undefined;
    // Registered here rather than at import: the source needs a database, and
    // this is the first point that has one. Idempotent by name.
    registerEvidenceSources(db);
    const boundaryInput = {
      nodeId: input.nodeId, goal: input.goal, repositoryRevision: revision,
      repository: repoIdentity(input.worktreePath) ?? undefined,
      fullArtifactRequests: input.fullArtifactRequests,
    };
    const view = (current: EconomicState) => marketViewOf(input.nodeId, current);
    const boundary = evaluateBoundary(db, boundaryInput, { view });
    const { state, cycle } = boundary;
    let decision = boundary.decision;

    // System-1 is an estimate the market may buy: only when its expected
    // decision value exceeds its own cost (meta-VOI), and only about the
    // current winner. The deep path not running means the screen saw nothing
    // to decide, and nothing is asked.
    if (decision && !cycle.skippedDeepEvaluation && cycle.candidates.length > 0) {
      // No stale check is needed here: this awaits on the dispatch path before
      // the Job exists, so nothing can move this node's state meanwhile.
      const refined = await refineWithSystem1({
        s1: system1(), scope: input.nodeId, state, candidates: cycle.candidates, decision,
      });
      recordSystem1(db, input.nodeId, refined.outcomes, refined.contexts);
      publishRefinement(db, input.nodeId, decision.decisionId, refined.refinement);
      decision = refined.decision;
    }

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
    // Faults (missing telemetry, a stale graph) already made every
    // intervention infeasible inside the market, so a decision that reaches
    // here is one the market chose with them priced in.
    if (!isIntervention(decision)) return '';

    // Committed against the state as it is *now*: System-1 may have been
    // awaited since the decision, and a decision about a state that has moved
    // is refused rather than acted on — the next boundary decides afresh.
    const committed = commitDecision(input.nodeId, view(currentBoundaryState(db, boundaryInput)), decision!);
    if (!committed.ok) {
      publishStaleDecision(db, input.nodeId, decision!, committed.reason);
      return '';
    }
    const started = Date.now();
    const text = await carryOut(db, decision!, state, input);
    settleDecision(input.nodeId, committed.commitment.commitmentId, {
      // What the intervention actually added to the dispatch, in tokens.
      tokens: Math.ceil(text.length / 4), usd: Math.ceil(text.length / 4) * usdPerToken(state),
      latencyMs: Date.now() - started, succeeded: text.length > 0,
    });
    return text;
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
  input: {
    nodeId: string; goal: string; worktreePath: string;
    onAcquired?: (a: { path: string; tokens: number; representation: 'full' | 'symbol' }) => void;
  },
): Promise<string> {
  const { action } = decision;

  if (action.kind === 'recover') return carryOutRecovery(db, decision, state, input.nodeId);

  const path = typeof action.metadata.path === 'string' ? action.metadata.path : null;
  if (action.kind !== 'acquire_evidence' || !path) return '';

  const symbol = action.metadata.representation === 'symbol' && typeof action.metadata.symbol === 'string'
    ? action.metadata.symbol : null;
  const fullTokens = typeof action.metadata.fullTokens === 'number' ? action.metadata.fullTokens : action.tokenCost;
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
      // The named declaration first; the file only if that cannot be delimited
      // and the file still pays at its own price.
      ...(symbol ? { target: { symbol, fullAcquisitionCost: fullTokens } } : {}),
    },
  });

  publishEvidenceOutcome(db, input.nodeId, path, result.acquired, result.tokens, result.reasonCodes);
  if (!result.acquired || !result.content) return '';
  input.onAcquired?.({ path, tokens: result.tokens, representation: result.representation ?? 'full' });
  publishProgress(db, input.nodeId, result.representation === 'symbol'
    ? `Sending just \`${symbol}\` from ${path} rather than letting the agent go and find it`
    : `Sending ${path} rather than letting the agent go and find it`);
  return renderAcquiredEvidence(path, result.content, result.excerpt);
}

/** A decision the market made and then could not commit — the state moved,
 *  or the resources it needed were reserved by something else first. */
function publishStaleDecision(db: Db, nodeId: string, decision: ActionDecision, reason: string): void {
  try {
    const now = new Date().toISOString();
    const payload = { decisionId: decision.decisionId, stateVersion: decision.stateVersion, action: decision.action.id, reason };
    const id = appendEvent(db, { nodeId, type: 'market.commit_refused', payload, createdAt: now });
    publish({ id, nodeId, type: 'market.commit_refused', payload, createdAt: now });
  } catch (err) {
    console.error(`Failed to record a refused commitment for node ${nodeId}:`, err);
  }
}

/** The optimization-of-the-optimizer record for one routing epoch: what a
 *  semantic answer was expected to be worth, what it cost, and whether it
 *  changed the decision. A call that changed nothing is avoidable optimizer
 *  cost, and this is where it becomes measurable. */
function publishRefinement(
  db: Db,
  nodeId: string,
  decisionId: string,
  refinement: Awaited<ReturnType<typeof refineWithSystem1>>['refinement'],
): void {
  try {
    const now = new Date().toISOString();
    const payload = { decisionId, ...refinement, avoidable: refinement.invoked && !refinement.decisionChanged };
    const id = appendEvent(db, { nodeId, type: 'market.system1', payload, createdAt: now });
    publish({ id, nodeId, type: 'market.system1', payload, createdAt: now });
  } catch (err) {
    console.error(`Failed to record the System-1 refinement for node ${nodeId}:`, err);
  }
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
    /** What the cost model conditions on beyond role and model. */
    effort?: string; taskClass?: string;
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
/** Receipts and overhead for one System-1 epoch, harness or model initiated.
 *
 *  Receipts go on the event chain (see `system1/receipts.ts` for why not the
 *  decisions table) and the overhead goes to the ledger exactly once, here.
 *  Total, like every other piece of bookkeeping on the path to a dispatch. */
function recordSystem1(
  db: Db, nodeId: string, outcomes: readonly JudgeOutcome[], contexts: readonly ReceiptContext[], modelRequests?: number,
): void {
  try {
    outcomes.forEach((outcome, i) => {
      const payload = buildReceipt(outcome, contexts[i]);
      const now = new Date().toISOString();
      const id = appendEvent(db, { nodeId, type: SYSTEM1_EVENT, payload, createdAt: now });
      publish({ id, nodeId, type: SYSTEM1_EVENT, payload, createdAt: now });
    });
    if (outcomes.length > 0) ledger.recordSystem1(nodeId, epochOf(outcomes, modelRequests));
  } catch (err) {
    console.error(`Failed to record a System-1 receipt for node ${nodeId}:`, err);
  }
}

/** The model-facing side of System-1 for one execute dispatch: a gateway
 *  bound to this node's budget and state, and what to record when the model
 *  asks. Per dispatch, so the allowance of new questions is per run. */
function modelDecisionSession(db: Db, nodeId: string, goal: string): NonNullable<ExecuteStepInput['session']> {
  const cfg = system1Config();
  const gateway = createModelGateway({
    system1: system1(), scope: nodeId, goal, maxRequests: cfg.maxModelRequestsPerDispatch,
    observe: () => {
      // Peek, never commit: this runs mid-dispatch, and committing would move
      // the trajectory baseline the next boundary compares against.
      const state = economicStateFor(db, { nodeId, goal }, { commit: false });
      return {
        facts: stateFacts(state),
        stateVersion: observedStateVersion(db, nodeId),
        orchestration: state.trajectory.orchestrationConfidence,
      };
    },
    currentStateVersion: () => observedStateVersion(db, nodeId),
  });
  return {
    gateway,
    maxDecisionTurns: cfg.maxModelRequestsPerDispatch,
    onDecision: (reply) => {
      const answered = reply.records.filter((r) => r.outcome);
      recordSystem1(db, nodeId, answered.map((r) => r.outcome!), answered.map((r) => ({
        provider: system1().provider,
        finalRuntimeAction: 'advice-returned-to-model',
        ...(r.outcome!.judgment ? {} : { fallbackReason: 'the model was told to use its own judgment' }),
      })), reply.records.length);
      // A rejected frame never reaches System-1, so it has no receipt; without
      // this the only record of *why* was the reply the model saw, which is
      // not persisted (found live: a child's scoping question was rejected
      // and nothing said why).
      for (const r of reply.records.filter((record) => record.rejected)) {
        const now = new Date().toISOString();
        const payload = { reason: r.rejected, frame: r.body.slice(0, 600) };
        const id = appendEvent(db, { nodeId, type: 'system1.rejected', payload, createdAt: now });
        publish({ id, nodeId, type: 'system1.rejected', payload, createdAt: now });
      }
      const n = reply.records.length;
      const ok = answered.filter((r) => r.outcome!.judgment).length;
      const why = reply.records.filter((record) => record.rejected).map((record) => record.rejected).join('; ');
      // One short line, no provider detail: the receipts hold the rest.
      publishProgress(db, nodeId, `Asked for a quick outside judgment on ${n} question${n === 1 ? '' : 's'} (${ok} answered${why ? `; rejected: ${why}` : ''})`);
    },
  };
}

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
/** A DELEGATE that ended in doing the work directly, and why. The one fact
 *  the receipt, the execution plan and strategy learning all need, and none of
 *  them could see: each read the original DELEGATE decision and reported a
 *  delegation that never happened. */
function recordDelegationDeclined(db: Db, nodeId: string, reason: string): void {
  try {
    const now = new Date().toISOString();
    const payload = { reason };
    const id = appendEvent(db, { nodeId, type: 'delegation.declined', payload, createdAt: now });
    publish({ id, nodeId, type: 'delegation.declined', payload, createdAt: now });
  } catch (err) {
    console.error(`Failed to record the declined delegation for node ${nodeId}:`, err);
  }
}

function delegationDeclinedReason(db: Db, nodeId: string): string | undefined {
  try {
    const row = listEventsForNode(db, nodeId).filter((event) => event.type === 'delegation.declined').at(-1);
    return (row?.payload as { reason?: string } | undefined)?.reason;
  } catch {
    return undefined;
  }
}

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

/** Writes the command that just verified this run's change into the cross-run
 *  knowledge store, so a later run against the same repository can read how
 *  to run its tests instead of rediscovering it by trial and error.
 *
 *  Measured cost of not having this: on requests-1142, whose suite needs a
 *  separate Python 2.7 environment, the agent burned several turns per run
 *  trying different unittest-loader invocations before it found the one that
 *  produced an observed pass. `historicalEvidenceSource` already surfaces
 *  matching `knowledge` rows at execution boundaries (`economic-runtime.ts`) —
 *  this is the write side, same store `rememberAnswer` uses, just keyed on the
 *  command instead of the answer. */
function rememberVerifiedCommands(
  db: Db, nodeId: string, observedChecks: ValidationEvidence['observedChecks'], at: string,
): void {
  const passing = observedChecks.filter((check) => check.passed);
  if (passing.length === 0) return;
  try {
    const node = getNode(db, nodeId);
    const worktreePath = node?.repoPath ?? process.env.ORG_WORKTREE_PATH;
    if (!worktreePath) return;
    const repository = repoIdentity(worktreePath);
    const revision = repoHead(worktreePath);
    // Same rule as `rememberAnswer`: knowledge that cannot say which
    // repository or revision it is about is knowledge nothing can reuse.
    if (!repository || !revision) return;
    for (const check of passing) {
      putKnowledge(db, {
        kind: 'fact',
        content: `A command that runs this repository's tests and passed: \`${check.command}\``,
        repository,
        revision,
        confidence: 1,
        // An observed pass, not a self-report: the strongest thing this store
        // records, so it outranks an asserted item at the same overlap.
        validated: true,
        createdAt: at,
      });
    }
  } catch (err) {
    console.error(`Failed to remember the verified command for node ${nodeId}:`, err);
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

  insertMemoryRow(db, 'integration_decision', decision.kind, {
    kind: decision.kind,
    reason: decision.kind === 'synthesize' ? decision.reason : null,
    applied: true,
  }, nodeId);
  const synthesisChildren = decision.kind === 'synthesize' ? decision.children : children;
  // Merging mechanically is a candidate like any other: free, deterministic,
  // and — when the reports are compatible — the cheapest way to an answer.
  // Offered to the market alongside every synthesis dispatch rather than
  // taken on a rule.
  const mechanical = decision.kind === 'return_child' || decision.kind === 'merge'
    ? actionCandidate({
        id: `integrate:${decision.kind}`, kind: 'reuse_evidence', capability: 'integration.mechanical', confidence: 1,
      })
    : null;

  try {
    // Inside the try, like everything else here: the market writes a decision
    // row and publishes an event, and a database that refuses that must cost the
    // combined answer, not the whole delegating node.
    const selection = selectExecution(db, {
      nodeId, role: 'synthesize', goal, adapters: availableAdapters(),
      ...(mechanical ? { alternatives: [mechanical] } : {}),
    });
    if (selection.alternative && (decision.kind === 'return_child' || decision.kind === 'merge')) {
      ledger.recordAvoided(nodeId, 'synthesize');
      publishProgress(db, nodeId, decision.kind === 'merge'
        ? `Combined ${children.length} agents' results directly — no extra model call was needed`
        : "One agent answered this; returning its answer rather than paying to reword it");
      return decision.text;
    }
    const adapter = selection.adapter;
    if (!adapter) {
      publishProgress(db, nodeId, "No execution candidate could combine the agents' reports — their individual reports stand");
      return '';
    }
    const credentials = checkCredentials(os.homedir(), process.env.ANTHROPIC_API_KEY);
    if (!credentials.ok) return '';

    publishProgress(db, nodeId, `Combining what ${children.length} agents reported into one answer${decision.kind === 'synthesize' ? ` (${decision.reason})` : ''}`);
    const opts = dispatchOptionsFor('synthesize');
    // Same shape as the execute dispatch: the stanza only carries the role when
    // the runtime will actually deliver it. buildSynthesisPrompt no longer states
    // the lead's job — merge overlaps, keep file:line detail, order by importance,
    // no preamble — so when there is no stanza it has to go inline on the goal, or
    // it reaches nobody at all.
    const synthRoleParts = rolePromptsEnabled() && honoursSystemPrompt(adapter)
      ? buildRolePromptParts('synthesize')
      : undefined;
    // Every report was clipped on its own and then all of them concatenated, so
    // eleven long ones overflowed the runtime's single-argument limit while each
    // stayed inside its own ceiling. Compiled together they share one.
    const synthLedger = newDispatchLedger(db, nodeId, 'synthesize');
    const synthAssembled = assembleSynthesisPrompt({
      ...(synthRoleParts ? { role: synthRoleParts } : { inlineRole: buildRolePrompt('synthesize') }),
      goal,
      children: synthesisChildren,
    }, promptBudgetFromConfig());
    if (synthAssembled.receipt) synthLedger.recordCompile(synthAssembled.receipt);
    if (synthAssembled.refused) {
      synthLedger.record('compile', { reason: `refused: ${synthAssembled.refused}` });
      flushDispatchLedger(db, nodeId, synthLedger);
      cancelExecution(nodeId, selection);
      publishProgress(db, nodeId, `Could not combine the agents' reports — too much to fit in one prompt (${synthAssembled.refused}); their individual reports stand`);
      return '';
    }
    const roleSystemPrompt = synthAssembled.system;
    const synthesisGoal = synthAssembled.goal;

    const runOnce = (model: string | undefined, effort?: string) => dispatch(db, nodeId, () => executeStep({
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
      ...(effort ? { effort } : {}),
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

    // A role that defaults to Haiku must not lose the whole answer on a plan
    // that cannot call Haiku: a refusal re-enters the market.
    const ran = await runOnMarket(db, nodeId, 'synthesize', goal, selection, runOnce);
    const result = ran.result;
    const usedModel = ran.selection.model;
    // Exactly one row per logical dispatch, naming the model that actually ran.
    recordUsage(db, {
      nodeId, role: 'synthesize', model: usedModel ?? null,
      usage: result.usage, costUsd: costFromEvents(result.events),
      startupMs: result.startupMs,
      ...(ran.selection.effort ? { effort: ran.selection.effort } : {}),
    });
    synthLedger.record('model', {
      tokens: result.usage.inputTokens + result.usage.outputTokens,
      reason: `in=${result.usage.inputTokens} out=${result.usage.outputTokens} cacheRead=${result.usage.cacheReadTokens} turns=${result.usage.numTurns}`,
    });
    recordVisibleContext(synthLedger, result.events as StructuredEvent[]);
    flushDispatchLedger(db, nodeId, synthLedger);

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

/** Answers waiting for their node's validation verdict before they may be
 *  cached. In-process only: a daemon that restarts mid-run loses the saving,
 *  never correctness. */
const pendingResults = new Map<string, { key: string; value: CachedResult }>();

/** The receipt action that marks an execute dispatch as having run read-only. */

/** The key this dispatch's answer may be stored under and served from, or null
 *  when it may not be reused at all.
 *
 *  Two conditions, each of which is the whole argument on its own:
 *
 *   - **read-only.** Reusing the answer of a run that changed something would
 *     skip the change and report it done. Read-only is what makes "we did not
 *     re-run it" equivalent to "we re-ran it": there were no side effects to
 *     lose.
 *   - **same execution candidate and same grant.** The key carries the
 *     candidate fingerprint — harness × model × effort × capability — so an
 *     answer is never reused under materially different execution semantics
 *     (a Haiku answer served to a Sonnet request, or a Codex answer served as
 *     Claude Code's). An answer produced under a wider grant saw more of the
 *     repository than this node may.
 *
 *  The commit is deliberately not part of the key. What makes an answer still
 *  true is whether the files it read still say what they said, which is checked
 *  on read (context/dependencies.ts) — keying on HEAD instead would invalidate
 *  every cached answer about every module on one commit to a README. */
function resultReuseKey(goal: string, grant: ToolGrant, candidateFingerprint: string): string | null {
  if (!grant.readOnly || resultCacheTtlHours() <= 0) return null;
  return resultCacheKey(goal, candidateFingerprint, grant.allowedTools);
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
export function evaluateTaskSpend(db: Db, nodeId: string, node: ReturnType<typeof getNode>): SpendGuardState {
  try {
    const budgetUsd = node?.contract.authority.budget_usd ?? 0;
    const policy = executionPolicyForGoal(
      node?.contract.goal ?? '', understandingFor(db, nodeId, node?.contract.goal ?? ''), activePolicyChanges(db));
    const trajectory = trajectorySignals(db, nodeId);
    // Spend is counted over the *tree*, not the node. A child's budget is
    // carved out of its parent's, so a node's own budget covers everything
    // it and its children spend; the deployment cap covers the whole task.
    // Counting only the node itself let a delegating task spend its cap once
    // per agent (measured: $7.46 against a $5 cap on Terminal-Bench
    // vba-userform-port). Whichever of the two leaves less room applies.
    const own = { cap: budgetUsd, spent: getCostForNodes(db, subtreeNodeIds(db, nodeId)) };
    let rootId = nodeId;
    for (let parent = node?.parentId; parent; parent = getNode(db, parent)?.parentId) rootId = parent;
    const root = rootId === nodeId ? node : getNode(db, rootId);
    const rootBudget = root?.contract.authority.budget_usd ?? 0;
    const task = {
      cap: rootBudget > 0 ? rootBudget : policy.spendCapUsd,
      spent: rootId === nodeId ? own.spent : getCostForNodes(db, subtreeNodeIds(db, rootId)),
    };
    const binding = own.cap > 0 && (task.cap <= 0 || own.cap - own.spent <= task.cap - task.spent) ? own : task;
    const guard = evaluateSpendGuard({
      spentUsd: binding.spent,
      spendCapUsd: binding.cap,
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
/** The hard spend constraint — money or turns genuinely exhausted — checked
 *  *before* the Action Market is asked anything. Hard constraints run before
 *  economics: a node that may not spend must not have candidates priced for
 *  it, and must say it stopped on money rather than read as "no feasible
 *  candidate". `dispatch` re-checks at the chokepoint for everything a queue
 *  wait can change in between. */
function refuseIfSpent(db: Db, nodeId: string): void {
  const guard = evaluateTaskSpend(db, nodeId, getNode(db, nodeId));
  if (guard.state !== 'STOP' || !guard.hard) return;
  const message = `${guard.reason} No further sandbox was opened for this agent.`;
  publishProgress(db, nodeId, message);
  throw new SpendGuardStop(message, true);
}

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
        throw new SpendGuardStop(message, guard.hard);
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

/** What a root run in a chat session is told about the session's earlier
 *  turns, recorded as an event so the receipt shows what the run was given.
 *  Empty for children (they get their parent's handoff instead) and for runs
 *  outside a session. */
function sessionPrefaceRungs(db: Db, nodeId: string): string[] {
  const node = getNode(db, nodeId);
  if (!node?.sessionId || node.parentId) return [];
  return sessionMemoryLadder(db, node.sessionId, nodeId);
}

const NO_PLAN: ParsedPlan = { subgoals: [], after: [], definitionOfDone: [], acceptanceChecks: [] };

async function planSubgoals(db: Db, nodeId: string, goal: string, maxChildren: number): Promise<ParsedPlan> {
  const node = getNode(db, nodeId);
  const worktreePath = node?.repoPath ?? process.env.ORG_WORKTREE_PATH;
  // Fewer than two children is not a fan-out, and parsePlan rejects a
  // single subgoal as "no split" anyway — so planning here would spend a whole
  // sandbox run to be told what we already know.
  if (!worktreePath || maxChildren < 2) return NO_PLAN;

  // The planner keeps its veto. It is the one judge that has looked at the
  // repository, and System-1's probability that a goal splits is a judgment about
  // the words: a single seaborn bug report once scored 0.91, above the redesign
  // that really did split. What the market already accounts for is the price of
  // being told "no" — the planner's dispatch is paid either way.

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
        publishProgress(db, nodeId, cached.subgoals.length === 0
          ? 'This goal was already found not to split on this repo state — doing it directly'
          : 'Reusing a plan computed earlier for this goal and repo state');
        recordUsage(db, {
          nodeId, role: 'plan:cache-hit', model: null, usage: { ...ZERO_USAGE }, costUsd: 0,
        });
        // The key is goal + HEAD, not the contract — so a plan cached under a
        // wider max_child_count would otherwise spawn more children than this
        // node's authority allows. On the cold path parseSubgoals is what
        // clamps; nothing downstream re-checks. This is that clamp.
        const subgoals = cached.subgoals.slice(0, maxChildren);
        return {
          subgoals,
          after: subgoals.map((_, i) => (cached.after[i] ?? []).filter((ref) => ref < i)),
          definitionOfDone: subgoals.map((_, i) => cached.definitionOfDone[i] ?? []),
          // Re-filtered on the way out: a cached row is only as trustworthy as the
          // rule that admitted its checks then, and the rule may have tightened.
          acceptanceChecks: subgoals.map((_, i) => (cached.acceptanceChecks[i] ?? []).filter(isEvidenceableCheck)),
        };
      }
    } catch {
      // A cache that misbehaves costs a sandbox, not a run.
    }
  }

  const credentials = checkCredentials(os.homedir(), process.env.ANTHROPIC_API_KEY);
  if (!credentials.ok) return NO_PLAN;

  publishProgress(db, nodeId, 'Working out how to split this across agents');
  try {
    // Inside the try, like everything else here: the market writes a decision
    // row and publishes an event, and any failure in planning has to mean "do
    // not delegate" rather than taking the node down with it.
    refuseIfSpent(db, nodeId);
    const selection = selectExecution(db, {
      nodeId, role: 'plan', goal, adapters: availableAdapters(),
    });
    const adapter = selection.adapter;
    if (!adapter) return NO_PLAN;
    const opts = dispatchOptionsFor('plan');
    // Same shape as the execute dispatch: the stanza only carries the role when
    // the runtime will actually deliver it. buildPlanPrompt no longer states the
    // planner's job or its output contract, so when there is no stanza it has to
    // go inline on the goal.
    const planRoleParts = rolePromptsEnabled() && honoursSystemPrompt(adapter)
      ? buildRolePromptParts('plan')
      : undefined;
    const prefaceRungs = sessionPrefaceRungs(db, nodeId);
    const planPrompt0 = buildPlanPrompt(goal, maxChildren);
    // The planner used to start from nothing and spend its turns discovering
    // the repository — the single most expensive coordination dispatch there
    // is, and it re-derives what the scan already knows. It splits the goal, so
    // it gets the same goal-selected context a child would.
    const planGrant = readOnlyPlanningGrant(node ? grantOf(node.contract.authority) : undefined);
    const planContext = dispatchContextFor(db, worktreePath, goal, {
      working: { taskId: taskRootId(db, nodeId), scope: scopeOf(planGrant.allowedTools, planGrant.readOnly) },
    });
    if (planContext) publishContextReceipt(db, nodeId, planContext.receipt);
    const planLedger = newDispatchLedger(db, nodeId, 'plan');
    const planAssembled = assemblePlanPrompt({
      ...(planRoleParts ? { role: planRoleParts } : { inlineRole: buildRolePrompt('plan') }),
      goal: planPrompt0,
      repoContext: planContext?.content,
      ...(prefaceRungs.length > 0 ? { preface: { text: prefaceRungs[0], fallbacks: prefaceRungs.slice(1) } } : {}),
    }, promptBudgetFromConfig());
    if (planContext) planLedger.record('select', { tokens: planContext.receipt.selectedTokens, reason: `selected=${planContext.receipt.selected.length}` });
    if (planAssembled.receipt) planLedger.recordCompile(planAssembled.receipt);
    if (planAssembled.refused) {
      planLedger.record('compile', { reason: `refused: ${planAssembled.refused}` });
      flushDispatchLedger(db, nodeId, planLedger);
      cancelExecution(nodeId, selection);
      publishProgress(db, nodeId, `Skipping the planning pass — its prompt cannot fit the runtime's input limit (${planAssembled.refused})`);
      return NO_PLAN;
    }
    const roleSystemPrompt = planAssembled.system;
    const planGoal = planAssembled.goal;

    const runOnce = (model: string | undefined, effort?: string) => dispatch(db, nodeId, () => executeStep({
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
      ...(effort ? { effort } : {}),
      maxTurns: opts.maxTurns,
      // Planning looks, it does not work. A node whose row we cannot read gets
      // the plain read-only set, which is narrower than anything it could hold.
      grant: planGrant,
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

    // `plan` is the role that actually defaults to a tiered model, so a plan
    // that cannot call Haiku must not lose delegation entirely: a refusal
    // re-enters the market.
    const ran = await runOnMarket(db, nodeId, 'plan', goal, selection, runOnce);
    const result = ran.result;
    const usedModel = ran.selection.model;

    // Claude Code's final `result` event carries the answer text.
    const text = result.events
      .filter((event) => event.type === 'result')
      .map((event) => String((event.payload as { result?: unknown } | null)?.result ?? ''))
      .join('\n');
    const plan = parsePlan(text, maxChildren);
    const { subgoals } = plan;
    // Exactly one row per logical dispatch, naming the model that actually ran.
    recordUsage(db, {
      nodeId, role: 'plan', model: usedModel ?? null,
      usage: result.usage, costUsd: costFromEvents(result.events),
      startupMs: result.startupMs,
      ...(ran.selection.effort ? { effort: ran.selection.effort } : {}),
    });
    planLedger.record('model', {
      tokens: result.usage.inputTokens + result.usage.outputTokens,
      reason: `in=${result.usage.inputTokens} out=${result.usage.outputTokens} cacheRead=${result.usage.cacheReadTokens} turns=${result.usage.numTurns}`,
    });
    recordVisibleContext(planLedger, result.events as StructuredEvent[]);
    flushDispatchLedger(db, nodeId, planLedger);
    // A planner that errored (turn cap, rate limit, timeout) gave no answer,
    // and an empty result from it is not "does not split". It used to be
    // cached as that verdict, so one planner cut off at its turn cap made
    // every later run of the same goal and HEAD skip planning and never split
    // (found on Terminal-Bench vba-userform-port).
    const plannerFailed = result.events.some((event) => event.type === 'result'
      && (event.payload as { is_error?: unknown } | null)?.is_error === true);
    if (plannerFailed && subgoals.length === 0) {
      const why = result.events.filter((event) => event.type === 'result')
        .map((event) => String((event.payload as { subtype?: unknown } | null)?.subtype ?? 'error')).pop();
      publishProgress(db, nodeId, `Could not plan a split (the planner stopped: ${why}) — doing it directly`);
      return NO_PLAN;
    }
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
        putCachedPlan(db, cacheKey, subgoals, head!, new Date().toISOString(), plan.after, {
          definitionOfDone: plan.definitionOfDone, acceptanceChecks: plan.acceptanceChecks,
        });
      } catch (err) {
        console.error(`Failed to cache the plan for node ${nodeId}:`, err);
      }
    }
    if (subgoals.length === 0) {
      publishProgress(db, nodeId, 'This goal does not split into independent pieces — doing it directly');
    }
    return plan;
  } catch (err) {
    publishProgress(db, nodeId, `Could not plan a split (${err instanceof Error ? err.message : String(err)}) — doing it directly`);
    return NO_PLAN;
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

/** Prices delegation, or says it could not. Total: a market that cannot be
 *  asked is a delegation nobody can price, which is a node that does the work
 *  itself — never a crash. */
function priceDelegationSafely(
  db: Db, nodeId: string, goal: string, belief: Difficulty, repository?: string,
): DelegationPricing | undefined {
  try {
    return priceDelegation(db, { nodeId, goal, adapters: availableAdapters(), belief, ...(repository ? { repository } : {}) });
  } catch (err) {
    console.error(`Could not price delegation for node ${nodeId}:`, err);
    return undefined;
  }
}

function productionMachine(db: Db, nodeId: string) {
  return nodeMachine.provide({
    actors: {
      // Whether the goal comes apart is System-1's judgment; whether splitting
      // is legal and worth it stays with `decideExecution` below. See
      // `system1/decomposability.ts` for the ownership split.
      assessUncertainty: fromPromise(async ({ input }: { input: { goal: string } }) => {
        const node = getNode(db, nodeId);
        if (!node) return assessUncertainty(input);
        // What delegating would cost, from the same market that prices every
        // execution: it sets the probability at which asking System-1 could
        // change anything. Unpriceable means nothing to ask.
        const belief = beliefFor(db, nodeId, input.goal);
        const pricing = priceDelegationSafely(db, nodeId, input.goal, belief, node.repoPath ?? undefined);
        const result = await assessDecomposability({
          scope: nodeId,
          goal: input.goal,
          authority: node.contract.authority,
          existingChildren: listNodes(db).filter((child) => child.parentId === nodeId).length,
          boundary: pricing ? decompositionBoundary(pricing) : null,
          difficulty: belief.value,
        });
        if (result.outcome) {
          const worthSplitting = result.bundle.signals.system1_worth_splitting === 1;
          recordSystem1(db, nodeId, [result.outcome], [{
            provider: system1().provider,
            economicResult: {
              worthSplitting,
              threshold: result.bundle.signals.system1_threshold ?? 0,
              difficulty: result.bundle.difficulty,
            },
            finalRuntimeAction: worthSplitting ? 'offer-delegation-to-economics' : 'single-unit-of-work',
            ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
          }]);
          if (result.fallbackReason) {
            publishProgress(db, nodeId, 'No decomposability judgment was available, so this runs as one piece of work');
          }
        }
        return result.bundle;
      }),
      decideExecution: fromPromise(async ({ input }: { input: { goal: string; difficulty?: number; splitProbability?: number; signals?: Record<string, number> } }) => {
        const node = getNode(db, nodeId);
        if (!node) throw new Error(`Node ${nodeId} not found when deciding execution`);
        // Priced fresh at every decision: a failure moves the belief about how
        // hard the work is, and with it what doing it whole and splitting it
        // each cost. A recovery attempt is decided against what has been
        // learned, not against what was believed before the first try.
        const belief = beliefFor(db, nodeId, input.goal);
        const pricing = priceDelegationSafely(db, nodeId, input.goal, belief, node.repoPath ?? undefined);
        const economics = decideExecution({
          goal: input.goal,
          authority: node.contract.authority,
          ...(input.splitProbability === undefined ? {} : { splitProbability: input.splitProbability }),
          ...(pricing ? { pricing } : {}),
          signals: input.signals,
        });
        // Delegation is decided by the Action Market. `decideExecution` is the
        // estimate source (and its authority gates stay hard); self vs delegate
        // is a cost comparison, so a fan-out cannot start on a run the
        // economic state already knows is out of budget, under a hard stop, or
        // holding a recovery reserve it would consume.
        const authorized = pricing && input.splitProbability !== undefined
          ? authorizeExecution({
            state: economicStateFor(db, { nodeId, goal: input.goal }),
            economics, pricing, splitProbability: input.splitProbability,
          })
          : { outcome: economics.outcome, decision: null, gate: 'single-unit-of-work' };
        const result = { ...economics, outcome: authorized.outcome };

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
            outcome: result.outcome,
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
            market_authorized: authorized.outcome === 'DELEGATE' ? 1 : 0,
            market_overrode_economics: (economics.outcome === 'DELEGATE') !== (authorized.outcome === 'DELEGATE') ? 1 : 0,
            market_saving_usd: authorized.decision?.utility ?? 0,
            market_margin_usd: authorized.decision?.margin?.absoluteUsd ?? 0,
          },
          createdAt: decidedAt,
        });
        if (authorized.gate) {
          insertMemoryRow(db, 'execution_gate', authorized.gate, { outcome: authorized.outcome }, nodeId);
        }
        if (economics.outcome === 'DELEGATE' && authorized.outcome !== 'DELEGATE') {
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
      validate: fromPromise(async ({ input }: { input: { nodeId: string; goal: string; succeeded: boolean; guardStopped: boolean } }) =>
        runValidation(db, input.nodeId, input.succeeded, input.guardStopped)),
      escalate: fromPromise(async ({ input }: { input: { nodeId: string; reason: string } }) =>
        escalate(input.nodeId, input.reason, { insertApproval: (record) => insertApproval(db, record) }),
      ),
      delegateToChild: fromPromise(async ({ input }: { input: { nodeId: string; goal: string; approvedBudgetUsd?: number } }) =>
        delegateNode(db, nodeId, { goal: input.goal, ...(input.approvedBudgetUsd === undefined ? {} : { approvedBudgetUsd: input.approvedBudgetUsd }) }),
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

        // Explaining is reading, not editing — and an unrestricted grant
        // does not just permit editing, it also keeps the Task tool, which is
        // how a single dispatch spawns its own background subagents. Narrowed
        // to read-only only when nobody configured a grant of their own; see
        // dispatch-helpers.ts for the measured run this closes off. Whether the
        // goal asks for a change is System-1's question (change-request.ts) and
        // only System-1's: a keyword used to decide it and took a bug fix's edit
        // tools away. Asked first, because everything below is built from it.
        const change = await assessChangeRequest(nodeId, input.goal);
        const grant = investigativeExecuteGrant(grantOf(node!.contract.authority), change.readOnly);
        // Once per node: a retry replays the same judgment from the guard's
        // cache, and recording it again would count a call that never happened.
        // The action is the grant actually applied, which an explicitly
        // configured tool list can differ from.
        if (change.outcome && !change.outcome.cached) {
          recordSystem1(db, nodeId, [change.outcome], [{
            provider: system1().provider,
            ...(change.pExplain === undefined ? {} : { economicResult: { threshold: EXPLAIN_THRESHOLD } }),
            finalRuntimeAction: grant.readOnly ? READ_ONLY_GRANT : WRITABLE_GRANT,
            ...(change.fallbackReason ? { fallbackReason: change.fallbackReason } : {}),
          }]);
        }
        // One snapshot, built here at the safe execution boundary from what is
        // known — System-1's answers on this node's own chain and what the goal
        // literally names — and read everywhere below. Before this, the goal was
        // interpreted here, again inside `executionPolicyForGoal`, and a third
        // time inside the context selector: three derivations that could
        // disagree about what kind of task this is.
        const prep: DispatchPreparation = prepareDispatch({
          goal: input.goal,
          authority: node!.contract.authority,
          toolGrant: grantOf(node!.contract.authority),
          understanding: { ...understandingFor(db, nodeId, input.goal), readOnly: change.readOnly },
          ...(node?.repoPath ? { repository: node.repoPath } : {}),
          requiredChecks: node?.contract.definition_of_done ?? [],
        });
        // A follow-up in a chat means something only against the turns before
        // it — "what did you change?" — so the conversation is part of the key.
        const conversationRungs = sessionPrefaceRungs(db, nodeId);
        const conversation = conversationRungs[0] ?? '';
        const cacheGoal = conversation ? `${conversation}\n\n${input.goal}` : input.goal;
        // Validity is asked of each candidate answer in turn, newest first:
        // does the code it actually read still say what it said?
        // Never on a retry after this node failed validation: the answer that
        // failed is exactly the kind a cache would hand straight back.
        const failedBefore = listEventsForNode(db, nodeId).some((row) =>
          row.type === 'validation.result' && (row.payload as { passed?: boolean }).passed === false);
        // Cached answers are candidate-aware: an answer produced by one
        // harness × model × effort is only reusable as that candidate's answer,
        // and the market prices reusing it against running any candidate fresh.
        const cachedByCandidate = new Map<string, CachedResult>();
        refuseIfSpent(db, nodeId);
        // How demanding the task is decides which model and effort can finish
        // it correctly. The estimate comes from the task's signals and what
        // this node has already seen fail; System-1 is asked only when its
        // answer could change the choice and is worth more than the question.
        const refined = await refineDifficulty(db, {
          nodeId, role: 'execute', goal: input.goal, adapters: availableAdapters(),
          ...(node?.repoPath ? { repository: node.repoPath } : {}),
        }, system1());
        if (refined.outcome && !refined.outcome.cached) {
          recordSystem1(db, nodeId, [refined.outcome], [{
            provider: system1().provider,
            economicResult: { difficulty: refined.difficulty.value, valueUsd: refined.valueUsd },
            finalRuntimeAction: 'difficulty-estimate',
            ...(refined.outcome.judgment ? {} : { fallbackReason: 'difficulty estimated from task signals' }),
          }]);
        }
        const selection = selectExecution(db, {
          nodeId, role: 'execute', goal: input.goal, adapters: availableAdapters(),
          difficulty: refined.difficulty, taskClass: prep.mode,
          ...(node?.repoPath ? { repository: node.repoPath } : {}),
          reusable: (candidate) => {
            if (failedBefore) return null;
            const valid = (value: CachedResult) => dependenciesValid(worktreePath, value.deps);
            const key = resultReuseKey(cacheGoal, grant, candidateFingerprint(candidate));
            // Answers stored before keys named the whole candidate were keyed by
            // model alone. They were validated when stored and are still checked
            // against what they read, so they are honoured for the same model
            // until they age out rather than paid for again.
            const legacy = resultReuseKey(cacheGoal, grant, (candidate.metadata.model as string | undefined) ?? '(default)');
            const hit = key ? getCachedResult(db, key, resultCacheTtlHours(), valid)
              ?? (legacy ? getCachedResult(db, legacy, resultCacheTtlHours(), valid) : null) : null;
            if (!hit) return null;
            cachedByCandidate.set(candidate.id, hit);
            return { candidateId: candidate.id, tokensSaved: hit.tokens };
          },
        });
        const cached = selection.reuse ? cachedByCandidate.get(selection.reuse.candidateId) ?? null : null;

        // This dispatch is the node doing the work itself. After a declined
        // DELEGATE the goal still "comes apart", and the receipt used to say
        // SPAWN_AGENT for a run that spawned nothing.
        const declined = delegationDeclinedReason(db, nodeId);
        publishDecisionReceipt(db, nodeId, receiptFromSelection(selection, declined));
        // The shape this kind of task usually takes, and the steps the runtime
        // already holds the product of. Published rather than prompted: a step
        // list in the argv would cost tokens on every dispatch to tell the agent
        // something the runtime is deciding for it.
        publishExecutionPlan(db, nodeId, prep.mode, indexedKnowledge(db, nodeId), declined);

        if (selection.blocked && !cached) {
          const result = blockedStep(selection);
          publishStepOutcome(db, nodeId, result);
          return result;
        }

        if (cached) {
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
            nodeId, role: 'execute:cache-hit', model: (selection.candidate.metadata.source as string | undefined) ?? null,
            usage: { ...ZERO_USAGE }, costUsd: 0, tokensAvoided: cached.tokens,
          });
          const result = { succeeded: true, message: cached.text, events: [], usage: { ...ZERO_USAGE } };
          publishStepOutcome(db, nodeId, result);
          scoreProjection(db, {
            nodeId, taskClass: prep.mode, read: [], outcome: 'success',
            tokensAvoided: cached.tokens, executionAvoided: true,
          });
          return result;
        }

        const adapter = selection.adapter!;
        publishProgress(db, nodeId, `Starting a sandbox on ${adapter.name}${selection.model ? ` (${selection.model})` : ''} against ${worktreePath}`);
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
        // The previous attempt made its change and was rejected only for want of
        // an observed check: this attempt is a short verification pass on the
        // same tree, not a fresh run of the whole task (see dispatch-helpers.ts).
        const proofOnly = needsProofOnly(listEventsForNode(db, nodeId)
          .filter((row) => row.type === 'validation.result').at(-1)?.payload);
        const configuredCap = effectiveTurnCap(execOpts.maxTurns, execPolicy);
        const hardTurnCap = proofOnly ? Math.min(configuredCap ?? PROOF_PASS_TURNS, PROOF_PASS_TURNS) : configuredCap;
        // Built once, out here rather than inside runOnce: the fallback retry
        // below calls runOnce a second time with the same goal, and a goal
        // carrying two copies of the context is the thing this is meant to
        // avoid. No context (disabled, not a repo, scan failed) → the bare goal.
        const repoContext = proofOnly ? null : dispatchContextFor(db, worktreePath, input.goal, {
          signals: prep.economics, policy: prep.contextPolicy,
          working: { taskId: taskRootId(db, nodeId), scope: scopeOf(grant.allowedTools, grant.readOnly) },
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
        // The private decision capability needs three things at once: a runtime
        // that can hold a session, a system prompt to tell the model about it
        // (a capability the model does not know exists will not be used), and a
        // System-1 to answer. Missing any one, the run is an ordinary dispatch
        // and nothing is advertised.
        const decisionSession = adapter.supportsSession === true
          && rolePromptsEnabled() && honoursSystemPrompt(adapter)
          && system1().ready();
        const rolePromptParts = rolePromptsEnabled() && honoursSystemPrompt(adapter)
          ? buildRolePromptParts('execute', {
              decisionCapability: decisionSession,
              allowedTools: grant.allowedTools,
              constraints,
              environment: sandboxNotes(fromContainerPath(worktreePath)),
              reportsToParent: Boolean(node?.parentId),
              // An item that *is* the goal is already the user message; repeating
              // it here re-bills the whole issue text on every turn.
              definitionOfDone: (node?.contract.definition_of_done ?? []).filter((item) => item.trim() !== input.goal.trim()),
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
        const goalWithConstraints = (!rolePromptParts && constraints.length > 0)
          ? `Standing instructions (follow even where they conflict with the most direct path, and say so if one blocks you):\n${constraints.map((c) => `  - ${c}`).join('\n')}\n\n${input.goal}`
          : input.goal;
        // What the parent addressed to this child, if anything. Rendered into
        // the argv rather than into the node's goal, because the goal is what a
        // person reads in the tree — an envelope folded into it would turn a
        // sentence into a paragraph of machine instructions wearing the goal's
        // name.
        const envelope = getAgentEnvelope(db, nodeId);
        const envelopeText = envelope ? renderEnvelope(envelope) : '';
        // A root run in a chat session is told the session so far, the same way a
        // child is told its parent's handoff; a child never is (it has one).
        const continuing = !envelopeText && !proofOnly && conversation !== '';
        if (continuing) publishProgress(db, nodeId, 'Continuing the conversation with what earlier turns in this session asked and found');
        // The economic boundary. Asked once, here, at the point the dispatch is
        // assembled — and answering "nothing to do" adds nothing to the prompt,
        // which is what makes CONTINUE a true no-op rather than a no-op with a
        // comment.
        const promptLedger = newDispatchLedger(db, nodeId, 'execute');
        const acquired = await economicBoundary(db, {
          nodeId, goal: input.goal, worktreePath,
          fullArtifactRequests: repoContext?.receipt.fullArtifactRequests,
          onAcquired: (a) => promptLedger.record('materialize', {
            tokens: a.tokens, sourceRef: a.path, representation: a.representation, reason: 'economic boundary',
          }),
        });
        // One compile, under one budget, for everything the agent is handed:
        // the role prompt, the repository context, the handoff or conversation,
        // the goal and whatever the boundary bought. Built once out here, like
        // the pieces themselves, so the fallback retry below cannot assemble a
        // second copy. Under budget it is byte-for-byte the concatenation this
        // used to be; over budget it shrinks the optional pieces in a fixed
        // order, and refuses rather than truncate the goal.
        const assembled = assembleExecutePrompt({
          ...(rolePromptParts ? { role: rolePromptParts } : {}),
          goal: goalWithConstraints,
          ...(proofOnly ? { proofInstruction: PROOF_PASS_INSTRUCTION } : {}),
          repoContext: repoContext?.content,
          ...(envelopeText ? { envelope: envelopeText } : {}),
          ...(continuing ? { preface: { text: conversation, fallbacks: conversationRungs.slice(1) } } : {}),
          ...(acquired ? { evidence: acquired } : {}),
        }, promptBudgetFromConfig());
        if (repoContext) promptLedger.record('select', { tokens: repoContext.receipt.selectedTokens, reason: `selected=${repoContext.receipt.selected.length}` });
        if (assembled.receipt) promptLedger.recordCompile(assembled.receipt);
        if (assembled.refused) {
          promptLedger.record('compile', { reason: `refused: ${assembled.refused}` });
          flushDispatchLedger(db, nodeId, promptLedger);
          // Nothing will run, so nothing is spent: release what the market held.
          cancelExecution(nodeId, selection);
          const result = refusedStep(assembled.refused);
          publishStepOutcome(db, nodeId, result);
          return result;
        }
        const roleSystemPrompt = assembled.system;
        const goalForDispatch = assembled.goal;

        // Reset per attempt: the fallback retry below re-runs the dispatch, and
        // its stream is the one whose rows the observations belong to.
        let eventIds: number[] = [];
        const runOnce = (model: string | undefined, effort?: string) => {
          eventIds = [];
          // What is left of the task's budget, re-read per attempt. The spend
          // guard only runs between dispatches; this is what stops one inside.
          const spend = evaluateTaskSpend(db, nodeId, getNode(db, nodeId));
          const spendLimitUsd = spend.spendCapUsd > 0 ? Math.max(0, spend.spendCapUsd - spend.spentUsd) : undefined;
          // Information control for this attempt: null when it is off or has no
          // listener, and the dispatch then runs exactly as baseline.
          const infoControl = openInfoControl({
            db, nodeId, taskRootId: taskRootId(db, nodeId), role: 'execute', goal: input.goal, model,
            confidence: qualityFloorFor(db, nodeId, input.goal),
            taskValueUsd: node?.contract.authority.budget_usd ?? 0,
            revision: repoHead(worktreePath),
          });
          return dispatch(db, nodeId, () => executeStep({
          ...(infoControl ? { infoControl } : {}),
          nodeId,
          goal: goalForDispatch,
          timeoutMs: executeTimeoutMs(),
          ...(spendLimitUsd === undefined ? {} : { spendLimitUsd }),
          systemPrompt: roleSystemPrompt,
          namespace: NAMESPACE,
          worktreePath,
          // Subscription (via `claude login`) is preferred over an API key —
          // see credentials.ts. Read fresh on every dispatch, so unlike the
          // ANTHROPIC_API_KEY env var this path has no daemon-restart staleness.
          // Your git identity always travels, so the agent can commit; your
          // GitHub login only when the mandate grants GitHub.
          credentials: {
            ...resolveCredentials(os.homedir(), process.env.ANTHROPIC_API_KEY),
            ...gitIdentity(),
            ...(grantsGitHub(grant.allowedTools) ? githubCredentials() : {}),
          },
          adapter,
          image: runnerImageOverride(),
          grant,
          model,
          ...(effort ? { effort } : {}),
          maxTurns: hardTurnCap,
          onViolation: (tool) => publishDenial(db, nodeId, tool, node!.contract.authority),
          // The runner's structured output is the point of the whole dispatch.
          // Was: a loop over result.events run once, after the whole Job
          // finished. Now: called per-event, live, as executeStep's follow-mode
          // stream delivers them — this is what makes the TUI's live output real.
          ...(decisionSession ? { session: modelDecisionSession(db, nodeId, input.goal) } : {}),
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
        })).finally(() => infoControl?.close());
        };

        // The committed candidate — and if the runtime then refuses its model,
        // the market is asked again from that fact rather than retrying on a
        // hardcoded default.
        const treeBefore = treeState(worktreePath);
        const ran = await runOnMarket(db, nodeId, 'execute', input.goal, selection, runOnce);
        let result = ran.result;
        const usedModel = ran.selection.model;
        // Cut off at the turn cap *after* making a change and watching its check
        // pass is a finished fix that ran out of room to say so. Counted as a
        // claim and handed to validation, which still needs the green check in
        // the trace; failing it outright threw correct patches away (seaborn,
        // sklearn on SWE-bench) and the retry guard then refused a second try.
        if (!result.succeeded && verifiedChangeAtTurnCap(result.events)) {
          result = { ...result, succeeded: true, message: `Stopped at the turn cap after a change whose check passed.\n\n${result.message}` };
          publishProgress(db, nodeId, 'Hit the turn cap after a verified change — handing it to validation instead of failing it');
        }
        // Exactly one row per logical dispatch, naming the model whose tokens
        // and cost this row actually carries — see the retry above.
        recordUsage(db, {
          nodeId, role: 'execute', model: usedModel ?? null,
          usage: result.usage, costUsd: costFromEvents(result.events),
          startupMs: result.startupMs,
          ...(ran.selection.effort ? { effort: ran.selection.effort } : {}),
          taskClass: prep.mode,
        });
        promptLedger.record('model', {
          tokens: result.usage.inputTokens + result.usage.outputTokens,
          reason: `in=${result.usage.inputTokens} out=${result.usage.outputTokens} cacheRead=${result.usage.cacheReadTokens} cacheWrite=${result.usage.cacheCreationTokens} turns=${result.usage.numTurns}`,
        });
        recordVisibleContext(promptLedger, result.events as StructuredEvent[]);
        publishStepOutcome(db, nodeId, result);
        // What the run changed on disk that its Write/Edit calls did not say —
        // edits made through Bash, or by a runtime whose stream has no such
        // calls — recorded with both sides so Files can show the diff.
        // ponytail: a second run writing the same tree at the same time would
        // have its changes attributed here too.
        const treeAfter = treeBefore && treeState(worktreePath);
        if (treeBefore && treeAfter) {
          const told = listArtifactsForNode(db, nodeId).map((a) => a.path ?? '');
          for (const change of treeChanges(worktreePath, treeBefore, treeAfter)) {
            if (told.some((p) => p === change.path || p.endsWith(`/${change.path}`))) continue;
            const now = new Date().toISOString();
            const id = appendEvent(db, { nodeId, type: 'exec.file_change', payload: change, createdAt: now });
            insertArtifact(db, { id: randomUUID(), nodeId, eventId: id, createdAt: now, kind: 'file_edit', path: change.path, summary: 'Changed on disk' });
          }
        }

        // The run's own account of what it touched, indexed into the context
        // graph. Built from what actually ran rather than from a scan of what
        // might matter, and pointing at the event rows that already hold the
        // output rather than copying it.
        const indexed = indexRunObservations(db, { nodeId, events: result.events, eventIds, grant });
        // The manifest delta: what this dispatch established for the task as a
        // whole, recorded once as a single revision. The trace says which
        // revision it produced, so a benchmark can follow the task's context
        // from one dispatch to the next.
        recordRunInManifest(db, taskRootId(db, nodeId), indexed, promptLedger);
        flushDispatchLedger(db, nodeId, promptLedger);
        // What the projection predicted, against what the run actually read.
        // Free, because the run already told us both.
        scoreProjection(db, {
          nodeId,
          taskClass: prep.mode,
          receipt: repoContext?.receipt,
          read: indexed.read,
          outcome: result.succeeded ? 'success' : 'failure',
        });

        // Stored only on a validated success. The fingerprint is built from the run's own
        // stream — the files it actually read — against the commit it was given,
        // not the tree as it now stands: a read-only run should not have moved
        // the tree, and if something else did, what the answer describes is
        // still the commit it saw. Guarded for the same reason `recordUsage` is:
        // an answer that was produced and paid for must not be thrown away
        // because writing it down failed. The retry above can change which model
        // ran, so the key is recomputed against the one that did.
        const storeKey = resultReuseKey(cacheGoal, grant, candidateFingerprint(ran.selection.candidate));
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
              // Held until validation passes (runValidation). A finished Job is
              // not a correct answer: a read-only reply to a change request was
              // cached this way and replayed to every later rep for $0.
              if (deps) {
                pendingResults.set(nodeId, { key: storeKey, value: {
                  text,
                  tokens: result.usage.inputTokens + result.usage.outputTokens,
                  costUsd: costFromEvents(result.events),
                  deps,
                } });
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
function closeDefinitionOfDone(db: Db, nodeId: string, state: string, _now: string): void {
  const artifacts = subtreeArtifacts(db, nodeId).filter((a) => a.kind !== 'result');
  for (const item of listDodForNode(db, nodeId)) {
    // Only a person's ruling (node.setDod, which records when) is final. The
    // runtime's own ruling is recomputed on every attempt: it used to record a
    // check time too, which this line then read as "a person ruled", so the
    // first attempt's verdict froze and no later attempt could satisfy it
    // (a correct seaborn fix ran 91 turns and was marked FAILED).
    if (item.checkedAt) continue;
    if (state === 'FAILED') {
      setDodState(db, item.id, 'unmet', { note: 'The agent did not finish.' }, null);
    } else if (state === 'COMPLETE' && artifacts.length > 0) {
      setDodState(db, item.id, 'met', {
        artifactId: artifacts[0].id,
        note: `Closed against ${artifacts.length} thing${artifacts.length === 1 ? '' : 's'} this agent produced.`,
      }, null);
    } else if (state === 'COMPLETE') {
      setDodState(db, item.id, 'unverified', {
        note: 'The agent reported it finished, but produced nothing to show for it.',
      }, null);
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
    // A delegating strategy that was declined before any child existed never
    // ran. Scoring it against the direct run that replaced it would credit
    // SERIAL_DELEGATED with an outcome it had no part in.
    const neverRan = !delegated && decision?.strategy !== 'MANAGED' && delegationDeclinedReason(db, nodeId) !== undefined;
    if (decision?.strategy && !neverRan) {
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
        taskClass: prep.mode,
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

/** Every dispatch this node settled, remembered as candidate × task × state
 *  evidence now that validation has ruled on the result. A cancelled run is
 *  recorded as ABORTED — visible, and excluded from learning. Total. */
function recordCandidateLearning(db: Db, nodeId: string, terminal: string): void {
  try {
    const node = getNode(db, nodeId);
    if (!node) return;
    const verdicts = listEventsForNode(db, nodeId).filter((row) => row.type === 'validation.result');
    const last = verdicts.at(-1)?.payload as { passed?: boolean; level?: string } | undefined;
    recordCandidateOutcomes(db, {
      nodeId,
      goal: node.contract.goal ?? '',
      ...(node.repoPath ? { repository: node.repoPath } : {}),
      validated: terminal === 'COMPLETE' && last?.passed === true,
      recoveryCount: Math.max(0, verdicts.length - 1),
      validationLevel: (last?.level as 'V0' | 'V1' | 'V2' | 'V3') ?? 'V0',
      validity: terminal === 'CANCELLED' ? 'ABORTED' : 'VALID',
    });
  } catch (err) {
    console.error(`Failed to record candidate learning for node ${nodeId}:`, err);
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
/** What a node and everything it delegated produced. A parent's children
 *  edit forks that are merged back into the parent's tree, and they run the
 *  tests; judging the parent on its own rows alone failed every delegated
 *  parent for "no durable outcome" and sent it to redo the work itself. */
function subtreeArtifacts(db: Db, nodeId: string) {
  return subtreeNodeIds(db, nodeId).flatMap((id) => listArtifactsForNode(db, id));
}

function subtreeExecEvents(db: Db, nodeId: string) {
  return subtreeNodeIds(db, nodeId).flatMap((id) => listEventsForNode(db, id))
    .filter((row) => row.type.startsWith('exec.'));
}

/** `sinceEventId`, when set, reads only the run's own trace from that event on —
 *  the parent's review of a reworked child, which must judge the revision in
 *  front of it. Without it a check that failed once stays failed for ever
 *  (failure signatures never clear), and no rework could converge. */
function validationEvidenceFor(db: Db, nodeId: string, succeeded: boolean, sinceEventId = 0): ValidationEvidence {
  const all = subtreeArtifacts(db, nodeId);
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
  // The grant this node actually ran under, when System-1 decided it; the rule
  // otherwise. The two must agree, or a report is accepted for a node that
  // was given edit tools to make a change.
  const events = listEventsForNode(db, nodeId);
  const grantReceipt = events.filter((row) => row.type === SYSTEM1_EVENT
    && (row.payload as { surface?: string }).surface === 'execution.change_requested').at(-1);
  const readOnly = grantReceipt
    ? (grantReceipt.payload as { finalRuntimeAction?: string }).finalRuntimeAction === READ_ONLY_GRANT
    : taskEconomicsFor(getNode(db, nodeId)?.contract.goal ?? '').readOnly;
  const durableOutcomeIds = readOnly ? all.filter((a) => a.kind === 'result').map((a) => a.id) : [];
  const execEvents = subtreeExecEvents(db, nodeId)
    .filter((row) => row.id > sinceEventId)
    .map((row) => ({ type: row.type.slice('exec.'.length), payload: row.payload } as StructuredEvent));
  const snapshot = executionSnapshot({
    events: execEvents,
    sequence: 0,
    tokensConsumed: 0,
  });
  // A verifying command that ran green is the strongest evidence the trace can
  // offer, and the fingerprint already separated those out as active targets.
  const failures = new Set(snapshot.failureSignatures);
  const observedChecks = snapshot.activeTargets
    .filter((target) => isVerifyingCommand(target))
    .map((target) => ({
      id: `observed:${target}`,
      command: target,
      passed: ![...failures].some((signature) => signature.includes(target)),
    }));
  // Work whose deliverable is an action outside the tree — close a PR, open
  // one, push — changes no file and has no test to run, so it could never
  // clear an implementation floor and was failed however well it went. The
  // remote accepting the action is the observed check. Only when nothing in
  // the tree changed: a code change still has to prove itself with a test,
  // and pushing it proves nothing about whether it is right.
  const changedTree = artifacts.some((a) => a.kind === 'file_edit' || a.kind === 'file_write');
  if (!changedTree) observedChecks.push(...externalActionChecks(execEvents));

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


function recordEfficiency(db: Db, nodeId: string, outcome: EfficiencyOutcome): void {
  // Said explicitly rather than left to a timeout: the control plane keeps a
  // little working memory per node, and a daemon that runs for weeks must not
  // accumulate one entry for every node it has ever seen.
  forgetNode(nodeId);
  forgetExecutionNode(nodeId);
  system1().forget(nodeId);
  pendingResults.delete(nodeId);
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
function runValidation(db: Db, nodeId: string, succeeded: boolean, guardStopped = false): ValidationVerdict {
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
    // What is *known* about the task — the grant it actually ran under, on its
    // own event chain — not the bare goal, which since the wording rules went
    // says nothing and would hold every read-only answer to a change's rung.
    economics: taskEconomicsFor(goal, understandingFor(db, nodeId, goal)),
    requiredChecks: node?.contract.definition_of_done ?? [],
    // No fresh verifier: re-running a repository's suite from inside the daemon
    // is a capability this runtime does not have. Recorded as `V3:no_verifier`
    // rather than silently, so the ceiling is visible in the telemetry rather
    // than inferred from its absence.
    freshVerifierAvailable: false,
  });

  const evidence = validationEvidenceFor(db, nodeId, succeeded);
  const result = validate({
    evidence,
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
  settleFinish(db, nodeId, !gated.passed);
  if (gated.passed) rememberVerifiedCommands(db, nodeId, evidence.observedChecks, now);

  const pending = pendingResults.get(nodeId);
  pendingResults.delete(nodeId);
  if (pending && gated.passed) {
    try {
      putCachedResult(db, pending.key, pending.value, now);
    } catch (err) {
      console.error(`Failed to cache the result for node ${nodeId}:`, err);
    }
  }

  // The strategy identity of this attempt, so the lifecycle can tell a recovery
  // from a repeat. Without it the attempt cap bounds how many identical retries
  // happen and nothing stops the first one being pointless.
  const signals = trajectorySignals(db, nodeId);
  const changedFiles = listArtifactsForNode(db, nodeId).some((a) => a.kind === 'file_edit' || a.kind === 'file_write');
  return {
    ...gated,
    retriable: !unprovableWithoutChanges(gated, changedFiles),
    strategy: delegated ? 'SERIAL_DELEGATED' : 'MANAGED',
    // What failed, in the stable form the trajectory fingerprint uses, so two
    // attempts that died the same way are recognisable as such.
    failureSignature: failureSignatureFor({
      passed: gated.passed, underlyingPassed: result.passed, level: gated.level,
      reasonCodes: gated.reasonCodes, guardStopped,
    }),
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
      recordCandidateLearning(db, nodeId, String(snapshot.value));
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
      // Opt-in (`ORG_AUTO_COMMIT=1`): a sandbox can never commit its own work
      // (`.git` is read-only in there by design), so nothing ever turned a
      // verified COMPLETE into a commit without a human doing it by hand. Only
      // a node's own repoPath, never a child's disposable fork — see
      // `auto-commit.ts`'s doc comment for why. Best-effort: a failure here is
      // narrated, not thrown, so it can never take the node's own outcome with it.
      if (snapshot.value === 'COMPLETE' && autoCommitEnabled()) {
        const stored = getNode(db, nodeId)?.repoPath;
        // git runs here, on the host, not in the sandbox the stored path is for.
        const repoPath = stored ? hostRepoPath(stored) : undefined;
        if (repoPath && !isDisposableFork(repoPath)) {
          try {
            const written = subtreeArtifacts(db, nodeId)
              .filter((a) => (a.kind === 'file_write' || a.kind === 'file_edit') && a.path)
              .map((a) => a.path as string);
            const result = autoCommitAndPush(repoPath, goal, nodeId, written);
            if (result.committed) {
              publishProgress(db, nodeId, result.pushed
                ? `Auto-committed and pushed verified changes (${result.sha?.slice(0, 7)})`
                : `Auto-committed verified changes (${result.sha?.slice(0, 7)}) — ${result.reason}`);
            } else if (result.attempted) {
              publishProgress(db, nodeId, `Auto-commit did not run: ${result.reason}`);
            }
          } catch (err) {
            console.error(`Auto-commit failed for node ${nodeId}:`, err);
          }
        }
      }
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
      // Only its own entry: the same node can be re-entered for another revision
      // of its work (see `requestRework`), and a finished run's cleanup must not
      // delete the actor that replaced it.
      setTimeout(() => { if (actors.get(nodeId) === actor) actors.delete(nodeId); }, 0);
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
// Follows the execute limit: with no wall clock on a child's dispatches, a
// parent that gave up after 45 minutes would abandon children that are still
// legitimately working (and still spending).
const CHILD_WAIT_TIMEOUT_MS = Number.isFinite(executeTimeoutMs()) ? 45 * 60_000 : Number.POSITIVE_INFINITY;

export async function waitForNodeCompletion(
  db: Db,
  nodeId: string,
  timeoutMs = CHILD_WAIT_TIMEOUT_MS,
): Promise<{ succeeded: boolean; cancelled?: boolean }> {
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
  // Stopped on purpose is not a failure: a parent that "replaced" it would
  // undo the stop (found live — cancelling a task spawned two replacements).
  return completionOfState(db, nodeId, String(snapshot.value));
}

/** What a node's terminal state means as an outcome. Split out so a node that
 *  finished before this process started — no actor, only its record — reads the
 *  same way as one that finished while it was being watched. */
export function completionOfState(
  db: Db, nodeId: string, state: string,
): { succeeded: boolean; cancelled?: boolean } {
  if (state === 'CANCELLED') return { succeeded: false, cancelled: true };
  if (state !== 'COMPLETE') return { succeeded: false };
  const lastValidation = listEventsForNode(db, nodeId)
    .filter((e) => e.type === 'validation.result')
    .sort((a, b) => b.id - a.id)[0];
  // Absent means validation did not run or could not be read — the same
  // "must not manufacture a success" rule recordValidation itself applies.
  const passed = (lastValidation?.payload as { passed?: boolean } | undefined)?.passed === true;
  return { succeeded: passed };
}

/** Where a delegated child stands, whether or not this process has been
 *  watching it.
 *
 *  A restarted parent meets children it has no actor for. One that already
 *  finished is read from its record. One the restart parked as INTERRUPTED is
 *  started again from its snapshot — the person who resumed the parent chose to
 *  carry the delegation on, and that includes the children it was waiting for.
 *  One that is neither running nor recoverable is reported as not having
 *  succeeded, which is the honest reading. */
export async function childCompletion(
  db: Db, nodeId: string,
): Promise<{ succeeded: boolean; cancelled?: boolean }> {
  if (!actors.has(nodeId)) {
    const node = getNode(db, nodeId);
    if (node && TERMINAL_STATES.has(node.state)) return completionOfState(db, nodeId, node.state);
    if (node?.state === 'INTERRUPTED' && node.snapshot) {
      restoreNodeActor(db, nodeId, node.goal, node.snapshot);
    } else {
      return { succeeded: false };
    }
  }
  return waitForNodeCompletion(db, nodeId);
}

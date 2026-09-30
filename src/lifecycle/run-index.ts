/** Turning a finished dispatch into indexed, queryable context.
 *
 *  This is where the context system meets the runtime. Everything upstream of
 *  it is pure; everything here touches a database and therefore must be total —
 *  a run that produced an answer must never be failed by the act of writing
 *  down what it learned.
 *
 *  Two things happen per dispatch, both cheap and both from evidence the run
 *  already produced:
 *
 *   1. **Observations become context objects.** Each tool call is indexed
 *      against the event that already holds its output, so the graph is built
 *      from what actually ran rather than from a scan of what might matter. No
 *      payload is copied.
 *   2. **The projection is scored against reality.** Selection predicted which
 *      files the run would need; the run then told us which it read. Comparing
 *      them is free, and it is the only signal that a projection was wrong.
 */
import type { Db } from '../db/client.js';
import type { StructuredEvent } from '../adapters/adapter.js';
import type { ToolGrant } from '../adapters/adapter.js';
import { observationsFromEvents, isVerifyingCommand, type Observation } from '../execution/observation.js';
import { projectObservation } from '../execution/tool-projections/registry.js';
import { putContextObject } from '../context/store.js';
import { publishContextVersion } from '../context/rpc.js';
import { scopeOf, type ContextRef } from '../context/types.js';
import { dependenciesFromEvents } from '../context/dependencies.js';
import { recordContextUtility } from '../learning/context-utility.js';
import type { TaskClass } from '../intelligence/task-judge.js';
import type { DispatchReceipt } from '../context/dispatch-context.js';
import { applyManifestDelta, getManifest } from '../context/runtime/task-context-manifest.js';
import type { DispatchLedger } from '../observability/context-ledger.js';
import { parseResultEnvelope } from '../intelligence/result-envelope.js';
import type { SecurityScope } from '../context/types.js';
import type { ManifestUpdate } from '../context/runtime/manifest-types.js';

/** Raw output larger than this is left in the event log and referenced rather
 *  than inlined. The threshold is generous: the cost of inlining a small
 *  observation is a few hundred bytes, and the cost of a dangling reference is
 *  an expansion that cannot be served. */
const INLINE_LIMIT = 8_000;

export interface IndexedRun {
  observations: number;
  refs: ContextRef[];
  /** The refs that matter to the task as a whole, by the role they play in its
   *  manifest. Everything else the run did stays reachable through the event
   *  log and the graph, and is not the manifest's business. */
  sections: { validation: ContextRef[]; artifacts: ContextRef[] };
  /** Repo-relative paths the run read, from its own tool calls. */
  read: string[];
}

/** Indexes one dispatch's observations. Total: every failure is logged and
 *  swallowed, because none of this is the run. */
export function indexRunObservations(
  db: Db,
  input: {
    nodeId: string;
    events: StructuredEvent[];
    /** Event-log row ids, in the order the events arrived. Lets an observation
     *  point at the row that already holds its output instead of copying it. */
    eventIds: number[];
    grant: ToolGrant;
  },
): IndexedRun {
  const scope = scopeOf(input.grant.allowedTools, input.grant.readOnly);
  const refs: ContextRef[] = [];
  const sections: IndexedRun['sections'] = { validation: [], artifacts: [] };
  let observations: Observation[] = [];

  try {
    observations = observationsFromEvents(input.events, input.nodeId);
  } catch (err) {
    console.error(`Failed to read observations for node ${input.nodeId}:`, err);
  }

  for (const observation of observations) {
    try {
      // The event that holds the *output*, not the one that holds the call: a
      // reference to the raw text has to lead to the raw text. (It used to point
      // at the call, so a large output that was left in the log and referenced
      // could not be fetched back through its own reference.)
      const eventId = input.eventIds[observation.execution.resultSequence ?? observation.execution.sequence];
      const small = observation.raw.length <= INLINE_LIMIT;
      // Small output is inlined so an expansion can always be served; large
      // output stays where it already is and is pointed at.
      const source = small || eventId === undefined
        ? { kind: 'inline' as const, locator: observation.semanticId }
        : { kind: 'event' as const, locator: String(eventId) };

      const object = putContextObject(db, {
        semanticId: observation.semanticId,
        kind: 'observation',
        content: observation.raw,
        source,
        scope,
        // An observation is a fact about a moment. It is reusable only where the
        // inputs that produced it are unchanged, which is the dependency
        // question the result cache already answers.
        reusePolicy: 'SAFE_IF_DEPENDENCIES_MATCH',
      });
      refs.push(object.ref);
      publishContextVersion(object);
      const role = manifestRoleOf(observation);
      if (role) sections[role].push(object.ref);

      // The reduced view, as a derived object. Stored rather than recomputed so
      // a consumer choosing a representation does not re-run every reducer.
      const projected = projectObservation(observation, 'reduced');
      if (projected.reduction.reduced) {
        const summary = putContextObject(db, {
          semanticId: `${observation.semanticId}:reduced`,
          kind: 'summary',
          content: projected.text,
          source: { kind: 'inline', locator: `${observation.semanticId}:reduced` },
          scope,
          reusePolicy: 'SAFE_IF_DEPENDENCIES_MATCH',
          dependencies: [{ kind: 'SUMMARIZES', ref: object.ref }],
        });
        refs.push(summary.ref);
      }
    } catch (err) {
      console.error(`Failed to index an observation for node ${input.nodeId}:`, err);
    }
  }

  let read: string[] = [];
  try {
    read = dependenciesFromEvents(input.events).paths;
  } catch {
    read = [];
  }

  return { observations: observations.length, refs, sections, read };
}

const EDITING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Which manifest section, if any, one observation belongs in. Deterministic
 *  and cheap: a check is a command that *is* a test runner, build or type
 *  check (the same predicate validation uses), and something produced is a
 *  file the run wrote. */
function manifestRoleOf(observation: Observation): 'validation' | 'artifacts' | null {
  // A check that failed is still the task's validation evidence — often the
  // most important kind — so success is only asked of what the run produced.
  if (EDITING_TOOLS.has(observation.tool.name)) return observation.execution.succeeded ? 'artifacts' : null;
  if (observation.tool.name === 'Bash' && isVerifyingCommand(String(observation.invocation.input.command ?? ''))) return 'validation';
  return null;
}

/** Records a dispatch's checks and products against its task, as one manifest
 *  revision, and notes the resulting revision on the dispatch's trace. Total,
 *  for the reason the rest of this file is: a run that produced an answer must
 *  not be failed by writing down what it did. */
export function recordRunInManifest(
  db: Db,
  taskId: string,
  indexed: IndexedRun,
  trace?: DispatchLedger,
): ManifestUpdate | null {
  let update: ManifestUpdate | null = null;
  if (indexed.sections.validation.length > 0 || indexed.sections.artifacts.length > 0) {
    try {
      update = applyManifestDelta(db, taskId, { add: indexed.sections });
    } catch (err) {
      console.error(`Failed to record a run in the manifest of task ${taskId}:`, err);
    }
  }
  try {
    const manifest = update?.manifest ?? getManifest(db, taskId);
    if (manifest) {
      trace?.record('retain', {
        reason: `manifest r${manifest.revision} workingSet=${manifest.workingSet.length} facts=${manifest.facts.length} artifacts=${manifest.artifacts.length} validation=${manifest.validation.length}`,
      });
    }
  } catch { /* observability only */ }
  return update;
}

/** Scores what the projection predicted against what the run read. Total, for
 *  the same reason. */
export function scoreProjection(
  db: Db,
  input: {
    nodeId: string;
    taskClass: TaskClass;
    receipt?: DispatchReceipt;
    read: string[];
    outcome: 'success' | 'failure' | 'partial';
    tokensAvoided?: number;
    executionAvoided?: boolean;
  },
): void {
  // Nothing to score: a dispatch that was given no projection made no
  // prediction, and inventing one would put a zero in a mean that means
  // something.
  if (!input.receipt) return;
  recordContextUtility(db, {
    taskClass: input.taskClass,
    nodeId: input.nodeId,
    selected: input.receipt.selected,
    excluded: input.receipt.dropped,
    read: input.read,
    outcome: input.outcome,
    tokensSelected: input.receipt.selectedTokens,
    tokensAvoided: input.tokensAvoided ?? 0,
    executionAvoided: input.executionAvoided ?? false,
  });
}

/** A finished piece of work, as a fact the task can point at.
 *
 *  The child's complete answer stays where it is (`nodes.answer` and the event
 *  log). What is stored is its own structured account of itself — summary,
 *  findings, files changed, what it could not verify — which is what a parent or
 *  a dependent actually reads, bounded to a few hundred tokens. Falls back to the
 *  opening of the prose for a child that did not report structurally.
 *
 *  Total, like everything here. */
export function recordChildFinding(
  db: Db,
  input: { taskId: string; childId: string; goal: string; report: string; succeeded: boolean; scope: SecurityScope },
): ContextRef | null {
  try {
    if (!input.report.trim()) return null;
    const parsed = parseResultEnvelope(input.report, input.succeeded ? 'success' : 'failed');
    const { envelope } = parsed;
    const digest = parsed.structured
      ? [
          `${envelope.status}: ${envelope.summary}`,
          ...envelope.findings.map((f) => `- ${f}`),
          envelope.changedFiles.length ? `changed: ${envelope.changedFiles.join(', ')}` : '',
          envelope.uncertainties.length ? `not verified: ${envelope.uncertainties.join('; ')}` : '',
        ].filter(Boolean).join('\n')
      : parsed.prose.slice(0, 1_200);
    const object = putContextObject(db, {
      semanticId: `finding:${input.childId}`,
      kind: 'finding',
      content: digest.slice(0, 4_000),
      source: { kind: 'inline', locator: input.childId },
      scope: input.scope,
      reusePolicy: 'SUGGESTION_ONLY',
    });
    const update = applyManifestDelta(db, input.taskId, { add: { facts: [object.ref] } });
    return update.rejected.length === 0 ? object.ref : null;
  } catch (err) {
    console.error(`Failed to record the finding of child ${input.childId}:`, err);
    return null;
  }
}

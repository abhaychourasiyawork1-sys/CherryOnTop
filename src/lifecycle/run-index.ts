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
import { observationsFromEvents, type Observation } from '../execution/observation.js';
import { projectObservation } from '../execution/tool-projections/registry.js';
import { putContextObject } from '../context/store.js';
import { publishContextVersion } from '../context/rpc.js';
import { scopeOf, type ContextRef } from '../context/types.js';
import { dependenciesFromEvents } from '../context/dependencies.js';
import { recordContextUtility } from '../learning/context-utility.js';
import type { TaskClass } from '../intelligence/task-judge.js';
import type { DispatchReceipt } from '../context/dispatch-context.js';

/** Raw output larger than this is left in the event log and referenced rather
 *  than inlined. The threshold is generous: the cost of inlining a small
 *  observation is a few hundred bytes, and the cost of a dangling reference is
 *  an expansion that cannot be served. */
const INLINE_LIMIT = 8_000;

export interface IndexedRun {
  observations: number;
  refs: ContextRef[];
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
  let observations: Observation[] = [];

  try {
    observations = observationsFromEvents(input.events, input.nodeId);
  } catch (err) {
    console.error(`Failed to read observations for node ${input.nodeId}:`, err);
  }

  for (const observation of observations) {
    try {
      const eventId = input.eventIds[observation.execution.sequence];
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

  return { observations: observations.length, refs, read };
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

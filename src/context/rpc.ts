/** The one interface anything outside `src/context` uses to reach context.
 *
 *  Every method is scope-checked. That is the point of putting them behind one
 *  object rather than exporting the store and graph directly: a caller cannot
 *  forget to pass a scope, because there is nowhere to call without one.
 *
 *  Nothing here dispatches, decides, or costs a model call. It answers
 *  questions about what is known, at whatever resolution the asker can afford.
 */
import type { Db } from '../db/client.js';
import { publish, subscribeAll, type BusEvent } from '../events/bus.js';
import { getContextObject, listVersions } from './store.js';
import { search as graphSearch, inspect as graphInspect, type SearchQuery, type ContextInspection } from './graph.js';
import { expand as expandOp, type ExpansionRequest } from './expansion.js';
import { cheapestSufficient, type MaterializeResult, type Representation } from './representations.js';
import { diffProjections, type ContextDelta } from './delta.js';
import { type ContextObject, type ContextRef, type SecurityScope, scopePermits } from './types.js';

/** Published when a semantic identity gains a version. The channel a long-lived
 *  consumer watches instead of polling. */
export const CONTEXT_EVENT = 'context.version';

export interface ContextEvent {
  semanticId: string;
  ref: ContextRef;
  createdAt: string;
}

export interface ContextRpc {
  resolve(ref: ContextRef): ContextObject | undefined;
  resolveMany(refs: ContextRef[]): ContextObject[];
  /** The cheapest representation of `ref` that fits `budget` and is at least
   *  `atLeast`. Refuses rather than truncating. */
  expandTo(ref: ContextRef, atLeast: Representation, budget: number, worktreePath?: string): MaterializeResult;
  /** A narrow, named expansion — one symbol, one range, one failure. */
  expand(request: ExpansionRequest): MaterializeResult;
  /** What changed between two versions of one identity, or between two
   *  projections. */
  diff(semanticId: string, fromVersion: number, toVersion: number): ContextDelta;
  diffProjections(before: ContextRef[], after: ContextRef[]): ContextDelta;
  search(query: SearchQuery): ContextRef[];
  inspect(ref: ContextRef): ContextInspection | undefined;
  /** Versions of `semanticId` as they appear, starting from now.
   *
   *  An async iterable rather than a callback so a consumer can `for await` and
   *  stop by breaking — a callback subscription leaks until someone remembers
   *  to unsubscribe, and in a daemon that runs for weeks, nobody does. */
  subscribe(semanticId: string, signal?: AbortSignal): AsyncIterable<ContextEvent>;
}

/** Announces a new version. Called by whatever writes to the store; kept here
 *  so the event shape lives next to the subscription that reads it. */
export function publishContextVersion(object: ContextObject): void {
  publish({
    nodeId: object.ref.semanticId,
    type: CONTEXT_EVENT,
    payload: { semanticId: object.ref.semanticId, ref: object.ref, createdAt: object.createdAt } satisfies ContextEvent,
    createdAt: object.createdAt,
  });
}

async function* versionStream(semanticId: string, signal?: AbortSignal): AsyncIterable<ContextEvent> {
  const queue: ContextEvent[] = [];
  let wake: (() => void) | null = null;

  const unsubscribe = subscribeAll((event: BusEvent) => {
    if (event.type !== CONTEXT_EVENT) return;
    const payload = event.payload as ContextEvent | undefined;
    if (payload?.semanticId !== semanticId) return;
    queue.push(payload);
    wake?.();
  });

  const onAbort = () => wake?.();
  signal?.addEventListener('abort', onAbort);

  try {
    while (!signal?.aborted) {
      while (queue.length > 0) {
        const next = queue.shift()!;
        yield next;
      }
      if (signal?.aborted) break;
      await new Promise<void>((resolve) => { wake = resolve; });
      wake = null;
    }
  } finally {
    // Both directions, always: the leak this exists to prevent is a listener
    // outliving the loop that wanted it.
    signal?.removeEventListener('abort', onAbort);
    unsubscribe();
  }
}

export function createContextRpc(db: Db, scope: SecurityScope): ContextRpc {
  const permitted = (object: ContextObject | undefined): ContextObject | undefined =>
    object && scopePermits(object.scope, scope) ? object : undefined;

  return {
    resolve: (ref) => permitted(getContextObject(db, ref)),

    resolveMany: (refs) => refs
      .map((ref) => permitted(getContextObject(db, ref)))
      .filter((object): object is ContextObject => object !== undefined),

    expandTo(ref, atLeast, budget, worktreePath) {
      const object = permitted(getContextObject(db, ref));
      if (!object) {
        return { refused: true, reason: `${ref.semanticId} is not resolvable in this scope`, available: [] };
      }
      return cheapestSufficient(db, object, { atLeast, tokenBudget: budget, worktreePath });
    },

    expand: (request) => expandOp(db, request, scope),

    diff(semanticId, fromVersion, toVersion) {
      const versions = listVersions(db, semanticId).filter((object) => scopePermits(object.scope, scope));
      const from = versions.find((object) => object.ref.version === fromVersion);
      const to = versions.find((object) => object.ref.version === toVersion);
      // A diff against a version that does not exist is an empty diff, not a
      // throw: a caller holding an old ref is the normal case, not an error.
      return diffProjections(from ? [from.ref] : [], to ? [to.ref] : []);
    },

    diffProjections,
    search: (query) => graphSearch(db, query, scope),
    inspect: (ref) => graphInspect(db, ref, scope),
    subscribe: (semanticId, signal) => versionStream(semanticId, signal),
  };
}

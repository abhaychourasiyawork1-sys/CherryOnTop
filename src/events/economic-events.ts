/** The economic events as they travel, as opposed to as they are applied.
 *
 *  `decision/state.ts` owns the *payloads* — they are the reducer's input
 *  contract, and defining them twice would let the wire and the reducer drift
 *  apart in exactly the way that makes a replay disagree with the run it is
 *  replaying. What lives here is everything delivery adds and the reducer has
 *  no business knowing: an identity, which node it is about, and when.
 *
 *  The identity is the whole point. A bus that can deliver twice — a retry, a
 *  reconnected subscriber, a replay overlapping a live run — must not be able
 *  to charge twice, and "the reducer happens to be idempotent for this payload"
 *  is a property that holds until someone adds an event where it does not.
 *  `EconomicEventLog` makes it structural: an envelope already seen is dropped
 *  before it reaches the reducer at all. */
import { randomUUID } from 'node:crypto';
import { publish, type BusEvent } from './bus.js';
import { applyEconomicEvent, type EconomicEvent, type EconomicState } from '../decision/state.js';

/** Every event kind, as a value. The union in `state.ts` is the type; this is
 *  what a test iterates and a subscriber matches on. */
export const ECONOMIC_EVENT_KINDS = [
  'TASK_STARTED',
  'EVIDENCE_ACQUIRED',
  'EXECUTION_STEP_COMPLETED',
  'PROGRESS_UPDATED',
  'FAILURE_DETECTED',
  'TRAJECTORY_STATE_CHANGED',
  'BUDGET_UPDATED',
  'INTERVENTION_DECIDED',
  'VALIDATION_RESULT',
  'TASK_COMPLETED',
  'TASK_FAILED',
] as const;

export type EconomicEventKind = (typeof ECONOMIC_EVENT_KINDS)[number];

const KINDS: ReadonlySet<string> = new Set(ECONOMIC_EVENT_KINDS);

export function isEconomicEventKind(value: string): value is EconomicEventKind {
  return KINDS.has(value);
}

/** The prefix every economic event carries on the bus.
 *
 *  Namespaced so a subscriber can take all of them without enumerating, and so
 *  they cannot collide with the `exec.*` stream the runtime already publishes. */
export const ECONOMIC_EVENT_PREFIX = 'economic.';

export function busTypeFor(kind: EconomicEventKind): string {
  return `${ECONOMIC_EVENT_PREFIX}${kind}`;
}

export interface EconomicEventEnvelope {
  /** Unique per *emission*. Two envelopes carrying the same payload are two
   *  events; the same envelope delivered twice is one. */
  eventId: string;
  nodeId: string;
  /** The state version this was emitted against. What lets a late arrival be
   *  recognised as late rather than applied as current. */
  stateVersion: number;
  event: EconomicEvent;
  createdAt: string;
}

export function envelope(input: {
  nodeId: string;
  stateVersion: number;
  event: EconomicEvent;
  eventId?: string;
  createdAt?: string;
}): EconomicEventEnvelope {
  return {
    eventId: input.eventId ?? `ev-${randomUUID()}`,
    nodeId: input.nodeId,
    stateVersion: Math.max(0, Math.floor(input.stateVersion)),
    event: input.event,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export function toBusEvent(item: EconomicEventEnvelope): BusEvent {
  return {
    nodeId: item.nodeId,
    type: busTypeFor(item.event.kind as EconomicEventKind),
    payload: { eventId: item.eventId, stateVersion: item.stateVersion, event: item.event },
    createdAt: item.createdAt,
  };
}

/** The envelope a bus event carries, or null when it is not one of ours.
 *
 *  Defensive rather than trusting: a subscriber reads whatever the bus hands
 *  it, and a malformed payload from some other publisher must produce `null`
 *  rather than a state update built from `undefined`. */
export function fromBusEvent(event: BusEvent): EconomicEventEnvelope | null {
  if (!event.type.startsWith(ECONOMIC_EVENT_PREFIX)) return null;
  const kind = event.type.slice(ECONOMIC_EVENT_PREFIX.length);
  if (!isEconomicEventKind(kind)) return null;

  const payload = event.payload as {
    eventId?: unknown; stateVersion?: unknown; event?: EconomicEvent;
  } | null;
  if (!payload?.event || payload.event.kind !== kind) return null;
  if (typeof payload.eventId !== 'string') return null;

  return {
    eventId: payload.eventId,
    nodeId: event.nodeId,
    stateVersion: typeof payload.stateVersion === 'number' ? payload.stateVersion : 0,
    event: payload.event,
    createdAt: event.createdAt,
  };
}

/** Publishes, and never lets publishing fail the thing it is describing.
 *
 *  The same contract `recordUsage` holds: a run that did the work must not be
 *  taken down because writing down what it did failed. */
export function publishEconomicEvent(item: EconomicEventEnvelope, emit = publish): void {
  try {
    emit(toBusEvent(item));
  } catch (err) {
    console.error(`Failed to publish ${item.event.kind} for ${item.nodeId}:`, err);
  }
}

/** An ordered, exactly-once application of envelopes to a state.
 *
 *  Holds the set of event ids already applied, which is what makes duplicate
 *  delivery structurally impossible rather than a property each payload has to
 *  provide for itself. Bounded: a task has a bounded number of events, and the
 *  log is discarded with the task. */
export interface EconomicEventLog {
  apply(item: EconomicEventEnvelope): EconomicState;
  state(): EconomicState;
  /** How many envelopes were applied, and how many were dropped as duplicates.
   *  Exposed because "the bus delivered 40% of events twice" is a fact worth
   *  being able to see rather than one that silently costs nothing. */
  stats(): { applied: number; duplicates: number };
}

export function createEconomicEventLog(initial: EconomicState): EconomicEventLog {
  const seen = new Set<string>();
  let current = initial;
  let applied = 0;
  let duplicates = 0;

  return {
    apply(item) {
      if (seen.has(item.eventId)) {
        duplicates += 1;
        return current;
      }
      seen.add(item.eventId);
      applied += 1;
      current = applyEconomicEvent(current, item.event);
      return current;
    },
    state: () => current,
    stats: () => ({ applied, duplicates }),
  };
}

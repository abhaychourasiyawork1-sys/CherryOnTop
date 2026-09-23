import { describe, it, expect, vi } from 'vitest';
import {
  envelope, toBusEvent, fromBusEvent, publishEconomicEvent, createEconomicEventLog,
  busTypeFor, isEconomicEventKind, ECONOMIC_EVENT_KINDS, ECONOMIC_EVENT_PREFIX,
  type EconomicEventKind,
} from './economic-events.js';
import { subscribeToPrefix, type BusEvent } from './bus.js';
import { initialEconomicState, type EconomicEvent } from '../decision/state.js';

const STARTED: EconomicEvent = {
  kind: 'TASK_STARTED', goal: 'g', totalTokenBudget: 100_000, qualityFloor: 0.7,
};

const wrap = (event: EconomicEvent, over = {}) =>
  envelope({ nodeId: 'n1', stateVersion: 3, event, createdAt: 't0', ...over });

describe('the event vocabulary', () => {
  it('names every kind the reducer handles', () => {
    expect([...ECONOMIC_EVENT_KINDS].sort()).toEqual([
      'BUDGET_UPDATED', 'EVIDENCE_ACQUIRED', 'EXECUTION_STEP_COMPLETED',
      'FAILURE_DETECTED', 'INTERVENTION_DECIDED', 'PROGRESS_UPDATED',
      'TASK_COMPLETED', 'TASK_FAILED', 'TASK_STARTED', 'TRAJECTORY_STATE_CHANGED',
      'VALIDATION_RESULT',
    ]);
  });

  it('namespaces every kind so a subscriber can take the family', () => {
    for (const kind of ECONOMIC_EVENT_KINDS) {
      expect(busTypeFor(kind)).toBe(`${ECONOMIC_EVENT_PREFIX}${kind}`);
    }
  });

  it('recognises its own kinds and nothing else', () => {
    expect(isEconomicEventKind('VALIDATION_RESULT')).toBe(true);
    expect(isEconomicEventKind('exec.assistant')).toBe(false);
  });
});

describe('the envelope', () => {
  it('gives every emission a distinct id', () => {
    expect(wrap(STARTED).eventId).not.toBe(wrap(STARTED).eventId);
  });

  it('records the state version it was emitted against', () => {
    expect(wrap(STARTED).stateVersion).toBe(3);
  });

  it('never carries a negative or fractional version', () => {
    expect(envelope({ nodeId: 'n', stateVersion: -4, event: STARTED }).stateVersion).toBe(0);
    expect(envelope({ nodeId: 'n', stateVersion: 2.7, event: STARTED }).stateVersion).toBe(2);
  });

  it('round-trips through the bus shape without losing anything', () => {
    const original = wrap(STARTED);
    expect(fromBusEvent(toBusEvent(original))).toEqual(original);
  });

  it('reaches a subscriber that took the whole family', () => {
    const seen: BusEvent[] = [];
    const stop = subscribeToPrefix(ECONOMIC_EVENT_PREFIX, (event) => seen.push(event));
    publishEconomicEvent(wrap(STARTED));
    stop();
    expect(seen.map((e) => e.type)).toEqual(['economic.TASK_STARTED']);
  });

  it('never lets publishing fail the thing it describes', () => {
    expect(() => publishEconomicEvent(wrap(STARTED), () => { throw new Error('bus down'); })).not.toThrow();
  });
});

describe('reading an envelope off the bus is defensive', () => {
  const busEvent = (over: Partial<BusEvent>): BusEvent =>
    ({ nodeId: 'n1', type: 'economic.TASK_STARTED', payload: {}, createdAt: 't0', ...over });

  it('ignores an event from another publisher', () => {
    expect(fromBusEvent(busEvent({ type: 'exec.assistant' }))).toBeNull();
  });

  it('ignores an unrecognised kind under our own prefix', () => {
    expect(fromBusEvent(busEvent({ type: 'economic.SOMETHING_NEW' }))).toBeNull();
  });

  it('ignores a payload with no event in it', () => {
    expect(fromBusEvent(busEvent({ payload: { eventId: 'e1', stateVersion: 1 } }))).toBeNull();
  });

  it('ignores a payload whose event disagrees with its type', () => {
    expect(fromBusEvent(busEvent({
      type: 'economic.TASK_COMPLETED',
      payload: { eventId: 'e1', stateVersion: 1, event: STARTED },
    }))).toBeNull();
  });

  it('ignores a payload with no identity, because an event that cannot be deduplicated is not one', () => {
    expect(fromBusEvent(busEvent({ payload: { stateVersion: 1, event: STARTED } }))).toBeNull();
  });
});

describe('duplicate delivery cannot spend twice', () => {
  const log = () => createEconomicEventLog(initialEconomicState({ goal: 'g', totalTokenBudget: 100_000 }));

  const spend: EconomicEvent = { kind: 'EXECUTION_STEP_COMPLETED', tokenCost: 5_000, latencyMs: 100, succeeded: true };

  it('applies an envelope once', () => {
    const l = log();
    const item = wrap(spend);
    l.apply(item);
    l.apply(item);
    expect(l.state().resources.consumedTokens).toBe(5_000);
    expect(l.stats()).toEqual({ applied: 1, duplicates: 1 });
  });

  it('applies two distinct envelopes carrying the same payload twice', () => {
    // Two emissions of the same fact are two facts; the same emission delivered
    // twice is one. The identity is what tells them apart.
    const l = log();
    l.apply(wrap(spend));
    l.apply(wrap(spend));
    expect(l.state().resources.consumedTokens).toBe(10_000);
    expect(l.stats().duplicates).toBe(0);
  });

  it('makes it structural rather than a property each payload has to provide', () => {
    // FAILURE_DETECTED has no natural idempotency of its own — the reducer will
    // happily raise pressure twice — so this is the only thing stopping it.
    const l = log();
    const item = wrap({ kind: 'FAILURE_DETECTED', signature: 'tsc:TS2345', tokenCost: 10 });
    const first = l.apply(item);
    const second = l.apply(item);
    expect(second.trajectory.failurePressure).toBe(first.trajectory.failurePressure);
  });

  it('returns the unchanged state for a duplicate rather than throwing', () => {
    const l = log();
    const item = wrap(spend);
    expect(l.apply(item)).toEqual(l.apply(item));
  });

  it('counts duplicates, because a bus delivering everything twice should be visible', () => {
    const l = log();
    const item = wrap(spend);
    for (let i = 0; i < 5; i++) l.apply(item);
    expect(l.stats()).toEqual({ applied: 1, duplicates: 4 });
  });

  it('advances the version once per applied envelope', () => {
    const l = log();
    const before = l.state().version;
    l.apply(wrap(spend));
    l.apply(wrap(spend));
    expect(l.state().version).toBe(before + 2);
  });
});

describe('every kind survives a round trip and an application', () => {
  const samples: Record<EconomicEventKind, EconomicEvent> = {
    TASK_STARTED: STARTED,
    EVIDENCE_ACQUIRED: {
      kind: 'EVIDENCE_ACQUIRED',
      evidence: [{ id: 'e1', kind: 'fact', source: 's', confidence: 0.9 }],
      tokenCost: 10,
    },
    EXECUTION_STEP_COMPLETED: { kind: 'EXECUTION_STEP_COMPLETED', tokenCost: 1, latencyMs: 1, succeeded: true },
    PROGRESS_UPDATED: { kind: 'PROGRESS_UPDATED', progress: 0.5 },
    FAILURE_DETECTED: { kind: 'FAILURE_DETECTED', signature: 'x' },
    TRAJECTORY_STATE_CHANGED: { kind: 'TRAJECTORY_STATE_CHANGED', trajectory: { progress: 0.2 } },
    BUDGET_UPDATED: { kind: 'BUDGET_UPDATED', totalTokenBudget: 5 },
    INTERVENTION_DECIDED: { kind: 'INTERVENTION_DECIDED', decisionId: 'd', action: 'continue', orchestrationCost: 1 },
    VALIDATION_RESULT: { kind: 'VALIDATION_RESULT', passed: true, confidence: 0.9, tokenCost: 1, evidenceIds: [] },
    TASK_COMPLETED: { kind: 'TASK_COMPLETED', succeeded: true },
    TASK_FAILED: { kind: 'TASK_FAILED', reason: 'r' },
  };

  it('covers every kind with a sample', () => {
    expect(Object.keys(samples).sort()).toEqual([...ECONOMIC_EVENT_KINDS].sort());
  });

  it('round-trips and applies each one', () => {
    const l = createEconomicEventLog(initialEconomicState({ goal: 'g', totalTokenBudget: 100_000 }));
    for (const event of Object.values(samples)) {
      const item = wrap(event);
      expect(fromBusEvent(toBusEvent(item))).toEqual(item);
      expect(() => l.apply(item)).not.toThrow();
    }
    expect(l.stats().applied).toBe(ECONOMIC_EVENT_KINDS.length);
  });
});
